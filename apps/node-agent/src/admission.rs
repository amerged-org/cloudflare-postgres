// SPDX-License-Identifier: Apache-2.0
//! Wake admission on the node (plan 4.6 and 4.7): the one admitter for every PostgreSQL start.
//!
//! `Admitter` is the decision, a state machine without a clock or a thread of its own: time and the
//! node's facts come in as arguments, so every boundary can be tested. `Admission` runs it as the
//! single serialized loop of the plan: every start, finish and stop goes through one task, which
//! reads the facts when it decides.
//!
//! For a start of a database of `m` MiB three rules apply, in the order the plan gives them:
//! 1. The room rule: the pool sample is fresh and the pool has room (`StoragePolicy::room`).
//!    Otherwise the start is refused at once (`Refusal::NoRoom`); waiting does not make room.
//! 2. The memory rule of policy: `measured` (decision D3 (a), the plan default) needs `MemAvailable`
//!    minus the full size of every start still in flight minus the floor to be at least `m`;
//!    `reserved` (D3 (b)) needs the reservations of the awake and starting databases plus `m` and
//!    the overhead to stay within the budget.
//! 3. The start cap: fewer than `start_concurrency` starts are in flight.
//!
//! A start counts as in flight from its admission until `Admitter::finish` reports it ready or
//! failed. A start that meets all three rules begins; otherwise it waits in a FIFO queue for up to
//! `queue_wait_ms` and is then refused (`Refusal::NoHeadroom`, with the policy's retry hint). The
//! queue is strict: a start behind a larger one waits, even when it would fit.
//!
//! While a start waits, and only if policy enables it (decision D2), the node puts one idle but
//! awake database to sleep early for each waiting start (`Admitter::early_sleep`).
use serde::Deserialize;
use std::{
    collections::{HashMap, VecDeque},
    time::Duration,
};
use tokio::{
    sync::{mpsc, oneshot},
    time::Instant,
};

const MIB: u128 = 1024 * 1024;
/// While starts wait, the loop decides again at least this often: available memory frees up
/// without anyone telling the loop.
const RECHECK: Duration = Duration::from_millis(50);

/// D3: what the memory rule compares with.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryRule {
    Measured,
    Reserved,
}

/// The contract's `policy.admission`.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AdmissionPolicy {
    pub memory_rule: MemoryRule,
    pub memory_floor_mib: u64,
    pub awake_budget_mib: u64,
    pub reservation_overhead_mib: u64,
    pub start_concurrency: usize,
    pub queue_wait_ms: u64,
    pub retry_after_seconds: u32,
}

/// The contract's `policy.early_sleep` (D2).
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EarlySleepPolicy {
    pub enabled: bool,
    pub min_idle_seconds: u64,
}

/// The contract's `policy.storage`.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StoragePolicy {
    pub reserve_bytes: u64,
    pub metadata_no_room_percent: u64,
    pub sample_max_age_seconds: u64,
}

/// The parts of the contract's `NodePolicy` that admission reads. Other parts are ignored.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct Policy {
    pub admission: AdmissionPolicy,
    pub early_sleep: EarlySleepPolicy,
    pub storage: StoragePolicy,
}

/// The thin pool as the storage side last sampled it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PoolSample {
    /// How long ago the sample was taken.
    pub age: Duration,
    pub data_total_bytes: u64,
    pub data_used_bytes: u64,
    pub metadata_total_bytes: u64,
    pub metadata_used_bytes: u64,
}

impl StoragePolicy {
    /// The room rule (plan 4.3 and 4.6): a pool sample that is not too old, free data at least the
    /// reserve and metadata below the "no room" percentage. A pool that was not sampled has no
    /// room that anyone can prove.
    pub fn room(&self, pool: Option<&PoolSample>) -> bool {
        let Some(pool) = pool else {
            return false;
        };
        let free = pool.data_total_bytes.saturating_sub(pool.data_used_bytes);
        pool.age <= Duration::from_secs(self.sample_max_age_seconds)
            && free >= self.reserve_bytes
            && u128::from(pool.metadata_used_bytes) * 100
                < u128::from(pool.metadata_total_bytes) * u128::from(self.metadata_no_room_percent)
    }
}

/// What the node knows when it decides.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Facts {
    /// `MemAvailable` of `/proc/meminfo`, read now.
    pub mem_available_bytes: u64,
    pub pool: Option<PoolSample>,
}

/// `MemAvailable` in bytes from the text of `/proc/meminfo`.
pub fn mem_available_bytes(meminfo: &str) -> Option<u64> {
    meminfo.lines().find_map(|line| {
        let kib: u64 = line
            .strip_prefix("MemAvailable:")?
            .trim()
            .strip_suffix("kB")?
            .trim()
            .parse()
            .ok()?;
        kib.checked_mul(1024)
    })
}

/// A start that asks for admission.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Request {
    pub database: String,
    /// The database's memory size.
    pub memory_mib: u64,
    /// Its class has no idle time: early sleep never picks it.
    pub always_warm: bool,
}

/// Why a start was refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refusal {
    /// The pool has no room: 57P03 "storage".
    NoRoom,
    /// The node is at awake capacity and the wait is over: 57P03 "node at awake capacity".
    NoHeadroom,
}
impl Refusal {
    /// The reason the contract names (`ADMISSION_REFUSALS`).
    pub fn reason(self) -> &'static str {
        match self {
            Self::NoRoom => "no_room",
            Self::NoHeadroom => "no_headroom",
        }
    }
    /// The DETAIL of the 57P03 that answers it (`ADMISSION_REFUSAL_DETAILS`).
    pub fn detail(self) -> &'static str {
        match self {
            Self::NoRoom => "storage",
            Self::NoHeadroom => "node at awake capacity",
        }
    }
}

/// A start the admitter let begin.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Admitted {
    /// How long it waited in the queue.
    pub waited: Duration,
}

/// A start the admitter refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Refused {
    pub reason: Refusal,
    /// Only a refusal for awake capacity carries a retry hint, since waiting makes room for it.
    pub retry_after_seconds: Option<u32>,
    pub waited: Duration,
}

pub type Outcome = Result<Admitted, Refused>;

/// A queued start.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Ticket(u64);

/// What `Admitter::request` decided at once.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Decision {
    Done(Outcome),
    /// The start waits; `poll` delivers its outcome.
    Queued(Ticket),
    /// The database is awake, starting or already waiting: it asks once.
    Duplicate,
}

/// A running or starting database, as the units say at the agent's start.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Running {
    pub database: String,
    pub memory_mib: u64,
    /// Its unit is activating: the start is in flight.
    pub starting: bool,
    pub always_warm: bool,
}

/// An awake database as the admitter keeps it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Awake {
    pub memory_mib: u64,
    /// Its start is in flight.
    pub starting: bool,
    pub always_warm: bool,
    /// The last time a client used it.
    pub last_activity: Instant,
    /// It was chosen for an early sleep and has not stopped yet.
    pub early_sleeping: bool,
}

/// The database that sleeps early for a waiting start (plan 4.7 step 2): of the awake databases
/// that are not always warm, not starting, not already sleeping early and unused by clients for at
/// least `min_idle`, the one that was used longest ago; the lower ID on a tie.
pub fn early_sleep_candidate<'a>(
    awake: impl IntoIterator<Item = (&'a str, &'a Awake)>,
    now: Instant,
    min_idle: Duration,
) -> Option<&'a str> {
    awake
        .into_iter()
        .filter(|(_, awake)| {
            !awake.always_warm
                && !awake.starting
                && !awake.early_sleeping
                && now.saturating_duration_since(awake.last_activity) >= min_idle
        })
        .min_by(|(id_a, a), (id_b, b)| {
            a.last_activity
                .cmp(&b.last_activity)
                .then_with(|| id_a.cmp(id_b))
        })
        .map(|(id, _)| id)
}

/// What the node reports of its awake set.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Snapshot {
    /// The awake databases, sorted.
    pub awake: Vec<String>,
    /// Their memory sizes added up.
    pub awake_memory_mib: u64,
    /// How many of them are not ready yet.
    pub starting: usize,
    /// Starts waiting for room.
    pub queued: usize,
}

struct Waiter {
    ticket: Ticket,
    request: Request,
    enqueued: Instant,
    deadline: Instant,
    /// The database put to sleep early for this start.
    sleeper: Option<String>,
}

/// The admission decision. All state is here; nothing in it reads a clock or the system.
pub struct Admitter {
    policy: Policy,
    awake: HashMap<String, Awake>,
    queue: VecDeque<Waiter>,
    next_ticket: u64,
}
impl Admitter {
    pub fn new(policy: Policy) -> Self {
        Self {
            policy,
            awake: HashMap::new(),
            queue: VecDeque::new(),
            next_ticket: 0,
        }
    }

    /// The admitter of an agent that starts while databases run: a unit that is activating is a
    /// start in flight, an active one is awake. Their last client activity is unknown; it counts
    /// as `now`.
    pub fn rebuild(
        policy: Policy,
        running: impl IntoIterator<Item = Running>,
        now: Instant,
    ) -> Self {
        let mut admitter = Self::new(policy);
        for unit in running {
            admitter.awake.insert(
                unit.database,
                Awake {
                    memory_mib: unit.memory_mib,
                    starting: unit.starting,
                    always_warm: unit.always_warm,
                    last_activity: now,
                    early_sleeping: false,
                },
            );
        }
        admitter
    }

    /// New rules for the decisions to come. Waiting starts keep the deadline they have.
    pub fn set_policy(&mut self, policy: Policy) {
        self.policy = policy;
    }

    fn starting(&self) -> impl Iterator<Item = &Awake> {
        self.awake.values().filter(|awake| awake.starting)
    }

    /// Whether the memory rule and the start cap let a start of `memory_mib` begin now.
    fn fits(&self, facts: &Facts, memory_mib: u64) -> bool {
        let rules = &self.policy.admission;
        if self.starting().count() >= rules.start_concurrency {
            return false;
        }
        match rules.memory_rule {
            MemoryRule::Measured => {
                let needed_mib = self
                    .starting()
                    .map(|awake| u128::from(awake.memory_mib))
                    .sum::<u128>()
                    + u128::from(rules.memory_floor_mib)
                    + u128::from(memory_mib);
                u128::from(facts.mem_available_bytes) >= needed_mib * MIB
            }
            MemoryRule::Reserved => {
                let overhead = u128::from(rules.reservation_overhead_mib);
                let reserved: u128 = self
                    .awake
                    .values()
                    .map(|awake| u128::from(awake.memory_mib) + overhead)
                    .sum();
                reserved + u128::from(memory_mib) + overhead <= u128::from(rules.awake_budget_mib)
            }
        }
    }

    fn begin(&mut self, request: Request, now: Instant) {
        self.awake.insert(
            request.database,
            Awake {
                memory_mib: request.memory_mib,
                starting: true,
                always_warm: request.always_warm,
                last_activity: now,
                early_sleeping: false,
            },
        );
    }

    fn refusal(&self, reason: Refusal, waited: Duration) -> Refused {
        Refused {
            reason,
            retry_after_seconds: (reason == Refusal::NoHeadroom)
                .then_some(self.policy.admission.retry_after_seconds),
            waited,
        }
    }

    /// Asks for a start. `facts` are the node's facts now.
    pub fn request(&mut self, now: Instant, facts: &Facts, request: Request) -> Decision {
        if self.awake.contains_key(&request.database)
            || self
                .queue
                .iter()
                .any(|waiter| waiter.request.database == request.database)
        {
            return Decision::Duplicate;
        }
        if !self.policy.storage.room(facts.pool.as_ref()) {
            return Decision::Done(Err(self.refusal(Refusal::NoRoom, Duration::ZERO)));
        }
        if self.queue.is_empty() && self.fits(facts, request.memory_mib) {
            self.begin(request, now);
            return Decision::Done(Ok(Admitted {
                waited: Duration::ZERO,
            }));
        }
        let wait = Duration::from_millis(self.policy.admission.queue_wait_ms);
        if wait.is_zero() {
            return Decision::Done(Err(self.refusal(Refusal::NoHeadroom, Duration::ZERO)));
        }
        let ticket = Ticket(self.next_ticket);
        self.next_ticket += 1;
        self.queue.push_back(Waiter {
            ticket,
            request,
            enqueued: now,
            deadline: now + wait,
            sleeper: None,
        });
        Decision::Queued(ticket)
    }

    /// Decides the waiting starts again: after anything that may have made room (a finish, a stop,
    /// a new sample, time passing) and when a deadline arrives. Returns the outcomes in the order
    /// the starts asked.
    pub fn poll(&mut self, now: Instant, facts: &Facts) -> Vec<(Ticket, Outcome)> {
        let mut outcomes = Vec::new();
        if !self.policy.storage.room(facts.pool.as_ref()) {
            // Waiting does not make room: nobody who waits can begin.
            for waiter in std::mem::take(&mut self.queue) {
                let waited = now.saturating_duration_since(waiter.enqueued);
                outcomes.push((waiter.ticket, Err(self.refusal(Refusal::NoRoom, waited))));
            }
            return outcomes;
        }
        // From the head: begin what fits, refuse what has waited its time, stop at the first start
        // that must keep waiting. A start never overtakes the one before it.
        while let Some(head) = self.queue.front() {
            let fits = self.fits(facts, head.request.memory_mib);
            if !fits && now < head.deadline {
                break;
            }
            let Some(waiter) = self.queue.pop_front() else {
                break;
            };
            let waited = now.saturating_duration_since(waiter.enqueued);
            if fits {
                self.begin(waiter.request, now);
                outcomes.push((waiter.ticket, Ok(Admitted { waited })));
            } else {
                let refused = self.refusal(Refusal::NoHeadroom, waited);
                outcomes.push((waiter.ticket, Err(refused)));
            }
        }
        // A policy with a shorter wait can make a later start expire before the head.
        for waiter in std::mem::take(&mut self.queue) {
            if now >= waiter.deadline {
                let waited = now.saturating_duration_since(waiter.enqueued);
                let refused = self.refusal(Refusal::NoHeadroom, waited);
                outcomes.push((waiter.ticket, Err(refused)));
            } else {
                self.queue.push_back(waiter);
            }
        }
        outcomes
    }

    /// The earliest deadline of a waiting start.
    pub fn next_deadline(&self) -> Option<Instant> {
        self.queue.iter().map(|waiter| waiter.deadline).min()
    }

    /// A waiting start gave up. Whether it was waiting.
    pub fn cancel(&mut self, ticket: Ticket) -> bool {
        match self.queue.iter().position(|waiter| waiter.ticket == ticket) {
            Some(index) => self.queue.remove(index).is_some(),
            None => false,
        }
    }

    /// A start that was in flight is over: ready (the database is awake and used now) or failed
    /// (it is not awake).
    pub fn finish(&mut self, database: &str, ready: bool, now: Instant) {
        let Some(awake) = self.awake.get_mut(database).filter(|awake| awake.starting) else {
            return;
        };
        if ready {
            awake.starting = false;
            awake.last_activity = now;
        } else {
            self.awake.remove(database);
        }
    }

    /// A database's unit stopped, for any reason.
    pub fn stopped(&mut self, database: &str) {
        self.awake.remove(database);
    }

    /// A client used the database at `at`.
    pub fn activity(&mut self, database: &str, at: Instant) {
        if let Some(awake) = self.awake.get_mut(database) {
            awake.last_activity = awake.last_activity.max(at);
        }
    }

    /// The database's class gained or lost its idle time.
    pub fn set_always_warm(&mut self, database: &str, always_warm: bool) {
        if let Some(awake) = self.awake.get_mut(database) {
            awake.always_warm = always_warm;
        }
    }

    /// The database to put to sleep early for a waiting start that has none yet (D2), if policy
    /// enables it and a database qualifies. Each waiting start gets at most one, whenever it is
    /// asked; the database counts as sleeping early until `stopped`.
    pub fn early_sleep(&mut self, now: Instant) -> Option<String> {
        if !self.policy.early_sleep.enabled {
            return None;
        }
        let waiter = self
            .queue
            .iter()
            .position(|waiter| waiter.sleeper.is_none())?;
        let min_idle = Duration::from_secs(self.policy.early_sleep.min_idle_seconds);
        let database = early_sleep_candidate(
            self.awake.iter().map(|(id, awake)| (id.as_str(), awake)),
            now,
            min_idle,
        )?
        .to_string();
        if let Some(awake) = self.awake.get_mut(&database) {
            awake.early_sleeping = true;
        }
        self.queue[waiter].sleeper = Some(database.clone());
        Some(database)
    }

    /// The sleep proof of an early sleep was refused (the database is busy, or its archive does not
    /// drain): the database stays awake and wakeable (plan 3.3). It counts as used now, so the node
    /// does not ask it again at once, and the start it was chosen for may have another.
    pub fn early_sleep_refused(&mut self, database: &str, now: Instant) {
        if let Some(awake) = self.awake.get_mut(database) {
            awake.early_sleeping = false;
            awake.last_activity = awake.last_activity.max(now);
        }
        for waiter in &mut self.queue {
            if waiter.sleeper.as_deref() == Some(database) {
                waiter.sleeper = None;
            }
        }
    }

    pub fn snapshot(&self) -> Snapshot {
        let mut awake: Vec<String> = self.awake.keys().cloned().collect();
        awake.sort_unstable();
        Snapshot {
            awake,
            awake_memory_mib: self.awake.values().map(|awake| awake.memory_mib).sum(),
            starting: self.starting().count(),
            queued: self.queue.len(),
        }
    }
}

/// What `Admission::admit` can fail with.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AdmitError {
    Refused(Refused),
    /// The database is awake, starting or already waiting.
    Duplicate,
    /// The admission loop is gone.
    Stopped,
}

enum Event {
    Ask {
        request: Request,
        reply: oneshot::Sender<Result<Permit, AdmitError>>,
    },
    Finish {
        database: String,
        ready: bool,
    },
    Stopped(String),
    Activity(String, Instant),
    AlwaysWarm(String, bool),
    SleepRefused(String),
    Policy(Policy),
    Snapshot(oneshot::Sender<Snapshot>),
}

/// The right to start one database. The start is in flight until the permit reports it ready;
/// a permit dropped otherwise reports it failed, so no start is ever left counted, whatever
/// happens to the caller that held it.
#[derive(Debug)]
pub struct Permit {
    database: String,
    /// How long the start waited in the queue.
    pub waited: Duration,
    events: Option<mpsc::UnboundedSender<Event>>,
}
impl Permit {
    fn finish(&mut self, ready: bool) {
        if let Some(events) = self.events.take() {
            let database = std::mem::take(&mut self.database);
            let _ = events.send(Event::Finish { database, ready });
        }
    }
    /// PostgreSQL accepts connections.
    pub fn ready(mut self) {
        self.finish(true);
    }
}
impl Drop for Permit {
    fn drop(&mut self) {
        self.finish(false);
    }
}

/// The handle on the admission loop; clones share the loop.
#[derive(Clone)]
pub struct Admission {
    events: mpsc::UnboundedSender<Event>,
}
impl Admission {
    /// Runs the loop on the current tokio runtime. `facts` is called whenever the loop decides.
    /// The second value delivers the databases to put to sleep early. The loop ends when the last
    /// handle and the last permit are gone.
    pub fn spawn(
        admitter: Admitter,
        facts: impl FnMut() -> Facts + Send + 'static,
    ) -> (Self, mpsc::UnboundedReceiver<String>) {
        let (events, inbox) = mpsc::unbounded_channel();
        let (early, sleepers) = mpsc::unbounded_channel();
        tokio::spawn(run(admitter, facts, events.downgrade(), inbox, early));
        (Self { events }, sleepers)
    }

    /// Asks for a start; returns when it may begin or is refused. A caller that drops the future
    /// leaves the queue.
    pub async fn admit(&self, request: Request) -> Result<Permit, AdmitError> {
        let (reply, answer) = oneshot::channel();
        self.events
            .send(Event::Ask { request, reply })
            .map_err(|_| AdmitError::Stopped)?;
        answer.await.map_err(|_| AdmitError::Stopped)?
    }

    /// A database's unit stopped.
    pub fn stopped(&self, database: &str) {
        let _ = self.events.send(Event::Stopped(database.to_string()));
    }

    /// A client used the database at `at`.
    pub fn activity(&self, database: &str, at: Instant) {
        let _ = self.events.send(Event::Activity(database.to_string(), at));
    }

    pub fn set_always_warm(&self, database: &str, always_warm: bool) {
        let _ = self
            .events
            .send(Event::AlwaysWarm(database.to_string(), always_warm));
    }

    /// An early sleep was refused; see `Admitter::early_sleep_refused`.
    pub fn early_sleep_refused(&self, database: &str) {
        let _ = self.events.send(Event::SleepRefused(database.to_string()));
    }

    pub fn set_policy(&self, policy: Policy) {
        let _ = self.events.send(Event::Policy(policy));
    }

    /// The awake set, or `None` when the loop is gone.
    pub async fn snapshot(&self) -> Option<Snapshot> {
        let (reply, answer) = oneshot::channel();
        self.events.send(Event::Snapshot(reply)).ok()?;
        answer.await.ok()
    }
}

/// What the loop woke for.
enum Wake {
    Event(Event),
    Recheck,
    Closed,
}

fn permit(
    handle: &mpsc::WeakUnboundedSender<Event>,
    database: String,
    waited: Duration,
) -> Result<Permit, AdmitError> {
    Ok(Permit {
        database,
        waited,
        events: Some(handle.upgrade().ok_or(AdmitError::Stopped)?),
    })
}

/// The loop: one task owns the admitter, so every decision is serialized.
async fn run(
    mut admitter: Admitter,
    mut facts: impl FnMut() -> Facts,
    handle: mpsc::WeakUnboundedSender<Event>,
    mut inbox: mpsc::UnboundedReceiver<Event>,
    sleepers: mpsc::UnboundedSender<String>,
) {
    type Reply = oneshot::Sender<Result<Permit, AdmitError>>;
    let mut waiting: HashMap<Ticket, (String, Reply)> = HashMap::new();
    loop {
        let woke = if admitter.queue.is_empty() {
            match inbox.recv().await {
                Some(event) => Wake::Event(event),
                None => Wake::Closed,
            }
        } else {
            let recheck = Instant::now() + RECHECK;
            let until = admitter.next_deadline().map_or(recheck, |d| d.min(recheck));
            tokio::select! {
                event = inbox.recv() => match event {
                    Some(event) => Wake::Event(event),
                    None => Wake::Closed,
                },
                () = tokio::time::sleep_until(until) => Wake::Recheck,
            }
        };
        let now = Instant::now();
        // The facts are read while starts wait, and for a start that asks; an event that only
        // records something (activity, a stop with nobody waiting) costs no read.
        let current = (!admitter.queue.is_empty()).then(&mut facts);
        match woke {
            Wake::Closed => break,
            Wake::Recheck => {}
            Wake::Event(Event::Ask { request, reply }) => {
                let database = request.database.clone();
                let current = current.unwrap_or_else(&mut facts);
                match admitter.request(now, &current, request) {
                    Decision::Done(Ok(admitted)) => {
                        let _ = reply.send(permit(&handle, database, admitted.waited));
                    }
                    Decision::Done(Err(refused)) => {
                        let _ = reply.send(Err(AdmitError::Refused(refused)));
                    }
                    Decision::Queued(ticket) => {
                        waiting.insert(ticket, (database, reply));
                    }
                    Decision::Duplicate => {
                        let _ = reply.send(Err(AdmitError::Duplicate));
                    }
                }
            }
            Wake::Event(Event::Finish { database, ready }) => {
                admitter.finish(&database, ready, now);
            }
            Wake::Event(Event::Stopped(database)) => admitter.stopped(&database),
            Wake::Event(Event::Activity(database, at)) => admitter.activity(&database, at),
            Wake::Event(Event::AlwaysWarm(database, always_warm)) => {
                admitter.set_always_warm(&database, always_warm);
            }
            Wake::Event(Event::SleepRefused(database)) => {
                admitter.early_sleep_refused(&database, now);
            }
            Wake::Event(Event::Policy(policy)) => admitter.set_policy(policy),
            Wake::Event(Event::Snapshot(reply)) => {
                let _ = reply.send(admitter.snapshot());
            }
        }
        // A caller that dropped its future no longer waits.
        waiting.retain(|ticket, (_, reply)| {
            let waits = !reply.is_closed();
            if !waits {
                admitter.cancel(*ticket);
            }
            waits
        });
        // Nobody waited before this event: whatever it queued was just decided.
        let outcomes = current.map_or_else(Vec::new, |current| admitter.poll(now, &current));
        for (ticket, outcome) in outcomes {
            if let Some((database, reply)) = waiting.remove(&ticket) {
                // A permit nobody receives is dropped, and reports its start failed.
                let _ = reply.send(match outcome {
                    Ok(admitted) => permit(&handle, database, admitted.waited),
                    Err(refused) => Err(AdmitError::Refused(refused)),
                });
            }
        }
        while !sleepers.is_closed() {
            let Some(database) = admitter.early_sleep(now) else {
                break;
            };
            let _ = sleepers.send(database);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIB_U64: u64 = 1 << 20;

    /// The plan's defaults (4.5, 4.6, 4.7, D2, D3 (a)), as the contract's example carries them.
    fn policy() -> Policy {
        Policy {
            admission: AdmissionPolicy {
                memory_rule: MemoryRule::Measured,
                memory_floor_mib: 600,
                awake_budget_mib: 9913,
                reservation_overhead_mib: 8,
                start_concurrency: 4,
                queue_wait_ms: 10_000,
                retry_after_seconds: 5,
            },
            early_sleep: EarlySleepPolicy {
                enabled: true,
                min_idle_seconds: 30,
            },
            storage: StoragePolicy {
                reserve_bytes: 6 * 1024 * MIB_U64,
                metadata_no_room_percent: 75,
                sample_max_age_seconds: 10,
            },
        }
    }
    fn reserved() -> Policy {
        let mut policy = policy();
        policy.admission.memory_rule = MemoryRule::Reserved;
        policy
    }
    fn pool() -> PoolSample {
        PoolSample {
            age: Duration::from_secs(1),
            data_total_bytes: 100 * 1024 * MIB_U64,
            data_used_bytes: 10 * 1024 * MIB_U64,
            metadata_total_bytes: 1024 * MIB_U64,
            metadata_used_bytes: 20 * MIB_U64,
        }
    }
    /// Facts with `mib` of memory available and a roomy pool.
    fn facts(mib: u64) -> Facts {
        Facts {
            mem_available_bytes: mib * MIB_U64,
            pool: Some(pool()),
        }
    }
    fn request(database: &str, memory_mib: u64) -> Request {
        Request {
            database: database.into(),
            memory_mib,
            always_warm: false,
        }
    }
    /// Asks for a start that must have to wait.
    fn queue(admitter: &mut Admitter, now: Instant, facts: &Facts, request: Request) -> Ticket {
        match admitter.request(now, facts, request) {
            Decision::Queued(ticket) => ticket,
            other => panic!("expected a queued start, got {other:?}"),
        }
    }
    fn ok(waited: Duration) -> Outcome {
        Ok(Admitted { waited })
    }
    fn admitted(waited: Duration) -> Decision {
        Decision::Done(ok(waited))
    }
    fn secs(n: u64) -> Duration {
        Duration::from_secs(n)
    }

    // ---------- the room rule ----------

    #[test]
    fn the_room_rule_needs_a_fresh_sample_free_data_and_metadata_below_the_percentage() {
        let storage = policy().storage;
        let reserve = storage.reserve_bytes;
        assert!(storage.room(Some(&pool())));
        assert!(
            !storage.room(None),
            "an unsampled pool has no provable room"
        );
        // The sample may be exactly as old as the policy allows, not older.
        let aged = |age| PoolSample { age, ..pool() };
        assert!(storage.room(Some(&aged(secs(10)))));
        assert!(!storage.room(Some(&aged(secs(10) + Duration::from_nanos(1)))));
        // Free data at least the reserve: equal is room, one byte less is not.
        let data = |free: u64| PoolSample {
            data_total_bytes: 100 * 1024 * MIB_U64,
            data_used_bytes: 100 * 1024 * MIB_U64 - free,
            ..pool()
        };
        assert!(storage.room(Some(&data(reserve))));
        assert!(!storage.room(Some(&data(reserve - 1))));
        // Metadata below 75 %: "at 75 %" is no room (plan 4.3 "≥ 75 %").
        let metadata = |used: u64| PoolSample {
            metadata_total_bytes: 1000,
            metadata_used_bytes: used,
            ..pool()
        };
        assert!(storage.room(Some(&metadata(749))));
        assert!(!storage.room(Some(&metadata(750))));
        assert!(!storage.room(Some(&metadata(1000))));
        let empty_metadata = PoolSample {
            metadata_total_bytes: 0,
            metadata_used_bytes: 0,
            ..pool()
        };
        assert!(
            !storage.room(Some(&empty_metadata)),
            "a pool without metadata size is unknown"
        );
        // Sizes near the top of u64 do not overflow.
        let huge = PoolSample {
            age: Duration::ZERO,
            data_total_bytes: u64::MAX,
            data_used_bytes: 0,
            metadata_total_bytes: u64::MAX,
            metadata_used_bytes: u64::MAX / 2,
        };
        assert!(storage.room(Some(&huge)));
        let used_up = PoolSample {
            data_used_bytes: u64::MAX,
            ..huge
        };
        assert!(!storage.room(Some(&used_up)));
        // A used count above the total reads as no free data, not as a wrap.
        let over = PoolSample {
            data_used_bytes: u64::MAX,
            data_total_bytes: 1,
            ..pool()
        };
        assert!(!storage.room(Some(&over)));
    }

    #[test]
    fn a_start_without_room_is_refused_at_once_and_never_queued() {
        let t0 = Instant::now();
        let no_pool = Facts {
            pool: None,
            ..facts(10_000)
        };
        let mut admitter = Admitter::new(policy());
        assert_eq!(
            admitter.request(t0, &no_pool, request("a", 256)),
            Decision::Done(Err(Refused {
                reason: Refusal::NoRoom,
                retry_after_seconds: None,
                waited: Duration::ZERO,
            }))
        );
        assert_eq!(admitter.snapshot().queued, 0);
        assert_eq!(admitter.snapshot().awake, Vec::<String>::new());
        // Also when other starts already wait: the room rule is no queue position.
        assert!(matches!(
            admitter.request(t0, &facts(100), request("b", 256)),
            Decision::Queued(_)
        ));
        assert!(matches!(
            admitter.request(t0, &no_pool, request("c", 256)),
            Decision::Done(Err(Refused {
                reason: Refusal::NoRoom,
                ..
            }))
        ));
        assert_eq!(admitter.snapshot().queued, 1);
    }

    #[test]
    fn waiting_starts_are_refused_for_room_when_the_room_is_lost() {
        let t0 = Instant::now();
        let mut admitter = Admitter::new(policy());
        let a = queue(&mut admitter, t0, &facts(100), request("a", 256));
        let b = queue(&mut admitter, t0 + secs(1), &facts(100), request("b", 256));
        let lost = Facts {
            pool: None,
            ..facts(10_000)
        };
        let refusal = |waited| {
            Err(Refused {
                reason: Refusal::NoRoom,
                retry_after_seconds: None,
                waited,
            })
        };
        assert_eq!(
            admitter.poll(t0 + secs(3), &lost),
            vec![(a, refusal(secs(3))), (b, refusal(secs(2)))]
        );
        assert_eq!(admitter.snapshot().queued, 0);
        assert_eq!(admitter.next_deadline(), None);
    }

    // ---------- the memory rule (a): measured ----------

    #[test]
    fn measured_memory_must_cover_the_floor_and_the_size_exactly() {
        let t0 = Instant::now();
        // 600 MiB floor + 256 MiB.
        let at = |bytes: u64| Facts {
            mem_available_bytes: bytes,
            ..facts(0)
        };
        let mut admitter = Admitter::new(policy());
        assert!(matches!(
            admitter.request(t0, &at(856 * MIB_U64 - 1), request("a", 256)),
            Decision::Queued(_)
        ));
        let mut admitter = Admitter::new(policy());
        assert_eq!(
            admitter.request(t0, &at(856 * MIB_U64), request("a", 256)),
            admitted(Duration::ZERO)
        );
        // The size counts in MiB: a 4 GiB database needs 4696 MiB.
        let mut admitter = Admitter::new(policy());
        assert!(matches!(
            admitter.request(t0, &at(4696 * MIB_U64 - 1), request("big", 4096)),
            Decision::Queued(_)
        ));
        // A floor of zero is a legal policy.
        let mut no_floor = policy();
        no_floor.admission.memory_floor_mib = 0;
        let mut admitter = Admitter::new(no_floor);
        assert_eq!(
            admitter.request(t0, &facts(256), request("a", 256)),
            admitted(Duration::ZERO)
        );
    }

    #[test]
    fn every_start_in_flight_counts_at_its_full_size_until_it_is_ready() {
        let t0 = Instant::now();
        let mut admitter = Admitter::new(policy());
        assert_eq!(
            admitter.request(t0, &facts(856), request("a", 256)),
            admitted(Duration::ZERO)
        );
        // a is starting: its 256 MiB are still in the available memory the node reports.
        let b = queue(&mut admitter, t0, &facts(1111), request("b", 256));
        assert_eq!(admitter.poll(t0, &facts(1111)), vec![]);
        assert_eq!(
            admitter.poll(t0, &facts(1112)),
            vec![(b, ok(Duration::ZERO))]
        );
        // a and b both in flight: c needs 600 + 256 + 256 + 512.
        let c = queue(&mut admitter, t0, &facts(1623), request("c", 512));
        assert_eq!(admitter.poll(t0, &facts(1623)), vec![]);
        // Once a is ready its memory is no longer a promise: the available memory shows it.
        admitter.finish("a", true, t0);
        // Now only b is in flight: 600 + 256 + 512.
        assert_eq!(admitter.poll(t0, &facts(1367)), vec![]);
        assert_eq!(
            admitter.poll(t0, &facts(1368)),
            vec![(c, ok(Duration::ZERO))]
        );
    }

    #[test]
    fn a_failed_start_leaves_the_flight_and_the_awake_set() {
        let t0 = Instant::now();
        let mut admitter = Admitter::new(policy());
        admitter.request(t0, &facts(856), request("a", 256));
        assert_eq!(admitter.snapshot().awake, ["a"]);
        admitter.finish("a", false, t0);
        assert_eq!(admitter.snapshot().awake, Vec::<String>::new());
        assert_eq!(admitter.snapshot().starting, 0);
        // It may ask again, and nothing of the failed start is counted.
        assert_eq!(
            admitter.request(t0, &facts(856), request("a", 256)),
            admitted(Duration::ZERO)
        );
        // Finishing a start that is not in flight changes nothing.
        admitter.finish("a", true, t0);
        admitter.finish("a", false, t0);
        admitter.finish("never", false, t0);
        assert_eq!(admitter.snapshot().awake, ["a"]);
    }

    // ---------- the start cap ----------

    #[test]
    fn at_most_the_start_concurrency_starts_are_in_flight() {
        let t0 = Instant::now();
        let mut admitter = Admitter::new(policy());
        let plenty = facts(100_000);
        for n in 0..4 {
            assert_eq!(
                admitter.request(t0, &plenty, request(&format!("db{n}"), 256)),
                admitted(Duration::ZERO)
            );
        }
        let fifth = queue(&mut admitter, t0, &plenty, request("db4", 256));
        assert_eq!(admitter.poll(t0, &plenty), vec![]);
        assert_eq!(admitter.snapshot().starting, 4);
        // A ready start leaves the flight, which lets the next one begin.
        admitter.finish("db0", true, t0 + secs(2));
        assert_eq!(
            admitter.poll(t0 + secs(2), &plenty),
            vec![(fifth, ok(secs(2)))]
        );
        assert_eq!(admitter.snapshot().starting, 4);
    }

    #[test]
    fn a_cap_of_one_serializes_the_starts() {
        let t0 = Instant::now();
        let mut one = policy();
        one.admission.start_concurrency = 1;
        let mut admitter = Admitter::new(one);
        let plenty = facts(100_000);
        assert_eq!(
            admitter.request(t0, &plenty, request("a", 256)),
            admitted(Duration::ZERO)
        );
        assert!(matches!(
            admitter.request(t0, &plenty, request("b", 256)),
            Decision::Queued(_)
        ));
        assert!(matches!(
            admitter.request(t0, &plenty, request("c", 256)),
            Decision::Queued(_)
        ));
        admitter.finish("a", false, t0);
        let outcomes = admitter.poll(t0, &plenty);
        assert_eq!(outcomes.len(), 1, "the cap lets one of the two begin");
        assert_eq!(admitter.snapshot().awake, ["b"]);
    }

    // ---------- the memory rule (b): reserved ----------

    #[test]
    fn reserved_memory_admits_what_the_plan_says_fits_in_the_budget() {
        let t0 = Instant::now();
        // Plan 4.5: 37 awake databases of 256 MiB, 19 of 512 MiB, 9 of 1 GiB or 4 of 2 GiB.
        for (size, count) in [(256, 37), (512, 19), (1024, 9), (2048, 4)] {
            let mut admitter = Admitter::new(reserved());
            let mut admitted_count = 0;
            for n in 0..100 {
                let database = format!("db{n}");
                match admitter.request(t0, &facts(0), request(&database, size)) {
                    Decision::Done(Ok(_)) => {
                        admitter.finish(&database, true, t0);
                        admitted_count += 1;
                    }
                    Decision::Queued(ticket) => {
                        assert!(admitter.cancel(ticket));
                        break;
                    }
                    other => panic!("{other:?}"),
                }
            }
            assert_eq!(admitted_count, count, "databases of {size} MiB");
        }
    }

    #[test]
    fn reserved_memory_stays_within_the_budget_to_the_mib_and_ignores_available_memory() {
        let t0 = Instant::now();
        let with_budget = |mib| {
            let mut policy = reserved();
            policy.admission.awake_budget_mib = mib;
            Admitter::new(policy)
        };
        // Two databases of 256 MiB reserve 2 x (256 + 8).
        let mut admitter = with_budget(528);
        for database in ["a", "b"] {
            assert_eq!(
                admitter.request(t0, &facts(0), request(database, 256)),
                admitted(Duration::ZERO)
            );
        }
        let mut admitter = with_budget(527);
        assert_eq!(
            admitter.request(t0, &facts(0), request("a", 256)),
            admitted(Duration::ZERO)
        );
        assert!(matches!(
            admitter.request(t0, &facts(0), request("b", 256)),
            Decision::Queued(_)
        ));
        // A reservation is counted from the start on, ready or not, and ends with the stop.
        let mut admitter = with_budget(528);
        admitter.request(t0, &facts(0), request("a", 256));
        admitter.request(t0, &facts(0), request("b", 256));
        let c = queue(&mut admitter, t0, &facts(0), request("c", 256));
        admitter.finish("a", true, t0);
        assert_eq!(admitter.poll(t0, &facts(0)), vec![]);
        admitter.stopped("a");
        assert_eq!(admitter.poll(t0, &facts(0)), vec![(c, ok(Duration::ZERO))]);
    }

    // ---------- the queue ----------

    #[test]
    fn the_queue_is_strictly_first_in_first_out() {
        let t0 = Instant::now();
        let mut admitter = Admitter::new(policy());
        // 1000 MiB available: 256 MiB would fit (856), 1024 MiB does not (1624).
        let a = queue(&mut admitter, t0, &facts(1000), request("a", 1024));
        let b = queue(&mut admitter, t0, &facts(1000), request("b", 256));
        assert_eq!(admitter.poll(t0 + secs(1), &facts(1000)), vec![]);
        // a begins, and b after it: with a in flight b needs 600 + 1024 + 256.
        assert_eq!(
            admitter.poll(t0 + secs(2), &facts(1880)),
            vec![(a, ok(secs(2))), (b, ok(secs(2)))]
        );
    }

    #[test]
    fn a_start_waits_exactly_the_queue_wait_and_is_then_refused_with_the_retry_hint() {
        let t0 = Instant::now();
        let mut admitter = Admitter::new(policy());
        let a = queue(&mut admitter, t0, &facts(100), request("a", 256));
        assert_eq!(admitter.next_deadline(), Some(t0 + secs(10)));
        assert_eq!(
            admitter.poll(t0 + Duration::from_millis(9_999), &facts(100)),
            vec![]
        );
        assert_eq!(
            admitter.poll(t0 + secs(10), &facts(100)),
            vec![(
                a,
                Err(Refused {
                    reason: Refusal::NoHeadroom,
                    retry_after_seconds: Some(5),
                    waited: secs(10),
                })
            )]
        );
        assert_eq!(admitter.next_deadline(), None);
        assert_eq!(admitter.snapshot().queued, 0);
    }

    #[test]
    fn a_start_that_fits_at_its_deadline_is_admitted_not_refused() {
        let t0 = Instant::now();
        let mut admitter = Admitter::new(policy());
        let a = queue(&mut admitter, t0, &facts(100), request("a", 256));
        assert_eq!(
            admitter.poll(t0 + secs(10), &facts(856)),
            vec![(a, ok(secs(10)))]
        );
    }

    #[test]
    fn a_refused_head_lets_the_start_behind_it_begin_in_the_same_poll() {
        let t0 = Instant::now();
        let mut admitter = Admitter::new(policy());
        let a = queue(&mut admitter, t0, &facts(1000), request("a", 1024));
        let b = queue(&mut admitter, t0 + secs(1), &facts(1000), request("b", 256));
        let outcomes = admitter.poll(t0 + secs(10), &facts(1000));
        assert_eq!(outcomes.len(), 2);
        assert_eq!(outcomes[0].0, a);
        assert!(matches!(
            outcomes[0].1,
            Err(Refused { reason: Refusal::NoHeadroom, waited, .. }) if waited == secs(10)
        ));
        assert_eq!(outcomes[1], (b, ok(secs(9))));
    }

    #[test]
    fn a_queue_wait_of_zero_refuses_without_queueing() {
        let t0 = Instant::now();
        let mut policy = policy();
        policy.admission.queue_wait_ms = 0;
        let mut admitter = Admitter::new(policy);
        assert_eq!(
            admitter.request(t0, &facts(100), request("a", 256)),
            Decision::Done(Err(Refused {
                reason: Refusal::NoHeadroom,
                retry_after_seconds: Some(5),
                waited: Duration::ZERO,
            }))
        );
        assert_eq!(admitter.snapshot().queued, 0);
    }

    #[test]
    fn the_retry_hint_is_the_policys() {
        let t0 = Instant::now();
        let mut seven = policy();
        seven.admission.retry_after_seconds = 7;
        let mut admitter = Admitter::new(seven);
        let a = queue(&mut admitter, t0, &facts(100), request("a", 256));
        // A late poll reports the time the start really waited.
        let outcomes = admitter.poll(t0 + secs(12), &facts(100));
        assert_eq!(
            outcomes,
            vec![(
                a,
                Err(Refused {
                    reason: Refusal::NoHeadroom,
                    retry_after_seconds: Some(7),
                    waited: secs(12),
                })
            )]
        );
    }

    #[test]
    fn sizes_at_the_top_of_the_range_wait_instead_of_overflowing() {
        let t0 = Instant::now();
        let huge = u64::MAX;
        let mut measured = Admitter::new(policy());
        queue(&mut measured, t0, &facts(100_000), request("a", huge));
        let mut reserved = Admitter::new(reserved());
        queue(&mut reserved, t0, &facts(0), request("a", huge));
        let mut huge_policy = policy();
        huge_policy.admission.memory_floor_mib = huge;
        let mut floor = Admitter::new(huge_policy);
        queue(&mut floor, t0, &facts(100_000), request("a", huge));
    }

    #[test]
    fn a_shortened_queue_wait_refuses_a_later_start_before_the_head() {
        let t0 = Instant::now();
        let mut admitter = Admitter::new(policy());
        queue(&mut admitter, t0, &facts(100), request("a", 256));
        let mut shorter = policy();
        shorter.admission.queue_wait_ms = 1000;
        admitter.set_policy(shorter);
        let b = queue(&mut admitter, t0 + secs(2), &facts(100), request("b", 256));
        assert_eq!(admitter.next_deadline(), Some(t0 + secs(3)));
        let outcomes = admitter.poll(t0 + secs(3), &facts(100));
        assert_eq!(outcomes.len(), 1, "a still has seven seconds");
        assert_eq!(outcomes[0].0, b);
        assert!(matches!(
            outcomes[0].1,
            Err(Refused {
                reason: Refusal::NoHeadroom,
                ..
            })
        ));
        assert_eq!(admitter.next_deadline(), Some(t0 + secs(10)));
    }

    #[test]
    fn a_database_asks_once() {
        let t0 = Instant::now();
        let mut admitter = Admitter::new(policy());
        assert_eq!(
            admitter.request(t0, &facts(100_000), request("a", 256)),
            admitted(Duration::ZERO)
        );
        assert_eq!(
            admitter.request(t0, &facts(100_000), request("a", 256)),
            Decision::Duplicate
        );
        let low = facts(100);
        let mut waiting = Admitter::new(policy());
        assert!(matches!(
            waiting.request(t0, &low, request("b", 256)),
            Decision::Queued(_)
        ));
        assert_eq!(
            waiting.request(t0, &low, request("b", 256)),
            Decision::Duplicate
        );
        // After the unit stopped it may ask again.
        admitter.stopped("a");
        assert_eq!(
            admitter.request(t0, &facts(100_000), request("a", 256)),
            admitted(Duration::ZERO)
        );
    }

    #[test]
    fn a_start_that_gave_up_leaves_the_queue() {
        let t0 = Instant::now();
        let mut admitter = Admitter::new(policy());
        let a = queue(&mut admitter, t0, &facts(100), request("a", 256));
        let b = queue(&mut admitter, t0, &facts(100), request("b", 256));
        assert!(admitter.cancel(a));
        assert!(!admitter.cancel(a), "it is gone");
        assert_eq!(
            admitter.poll(t0, &facts(100_000)),
            vec![(b, ok(Duration::ZERO))]
        );
        assert_eq!(admitter.snapshot().awake, ["b"]);
    }

    // ---------- the agent's start ----------

    #[test]
    fn the_admitter_is_rebuilt_from_the_running_units() {
        let t0 = Instant::now();
        let running = |database: &str, memory_mib, starting, always_warm| Running {
            database: database.into(),
            memory_mib,
            starting,
            always_warm,
        };
        let mut admitter = Admitter::rebuild(
            policy(),
            [
                running("a", 256, true, false),
                running("b", 512, false, true),
            ],
            t0,
        );
        assert_eq!(
            admitter.snapshot(),
            Snapshot {
                awake: vec!["a".into(), "b".into()],
                awake_memory_mib: 768,
                starting: 1,
                queued: 0,
            }
        );
        // a's start is in flight: c needs 600 + 256 + 256, and not b's memory.
        let c = queue(&mut admitter, t0, &facts(1111), request("c", 256));
        assert_eq!(
            admitter.poll(t0, &facts(1112)),
            vec![(c, ok(Duration::ZERO))]
        );
        // Starts in flight count against the cap: four activating units leave no start.
        let mut busy = Admitter::rebuild(
            policy(),
            (0..4).map(|n| running(&format!("s{n}"), 256, true, false)),
            t0,
        );
        assert!(matches!(
            busy.request(t0, &facts(100_000), request("x", 256)),
            Decision::Queued(_)
        ));
        // Under the reserved rule every running unit holds its reservation.
        let mut full = reserved();
        full.admission.awake_budget_mib = 264 * 2 + 263;
        let mut admitter = Admitter::rebuild(
            full,
            [
                running("a", 256, false, false),
                running("b", 256, false, false),
            ],
            t0,
        );
        assert!(matches!(
            admitter.request(t0, &facts(0), request("c", 256)),
            Decision::Queued(_)
        ));
    }

    #[test]
    fn a_rebuilt_database_counts_as_used_when_the_agent_started() {
        let t0 = Instant::now();
        let admitter = Admitter::rebuild(
            policy(),
            [Running {
                database: "a".into(),
                memory_mib: 256,
                starting: false,
                always_warm: false,
            }],
            t0,
        );
        let a = &admitter.awake["a"];
        assert_eq!(a.last_activity, t0);
        assert!(!a.starting && !a.early_sleeping && !a.always_warm);
    }

    #[test]
    fn the_snapshot_reports_the_awake_set_for_the_node_sample() {
        let t0 = Instant::now();
        let mut admitter = Admitter::new(policy());
        admitter.request(t0, &facts(100_000), request("b", 512));
        admitter.request(t0, &facts(100_000), request("a", 256));
        admitter.finish("b", true, t0);
        admitter.request(t0, &facts(100), request("c", 256));
        assert_eq!(
            admitter.snapshot(),
            Snapshot {
                awake: vec!["a".into(), "b".into()],
                awake_memory_mib: 768,
                starting: 1,
                queued: 1,
            }
        );
    }

    // ---------- early sleep ----------

    fn idle_since(at: Instant) -> Awake {
        Awake {
            memory_mib: 256,
            starting: false,
            always_warm: false,
            last_activity: at,
            early_sleeping: false,
        }
    }
    fn candidate(
        awake: &HashMap<String, Awake>,
        now: Instant,
        min_idle: Duration,
    ) -> Option<String> {
        early_sleep_candidate(awake.iter().map(|(k, v)| (k.as_str(), v)), now, min_idle)
            .map(str::to_string)
    }

    #[test]
    fn the_early_sleeper_is_the_least_recently_active_database_that_qualifies() {
        let base = Instant::now();
        let now = base + secs(100);
        let mut awake = HashMap::from([
            ("a".to_string(), idle_since(base + secs(40))),
            ("b".to_string(), idle_since(base + secs(10))),
            ("c".to_string(), idle_since(base + secs(20))),
        ]);
        assert_eq!(candidate(&awake, now, secs(30)).as_deref(), Some("b"));
        // The three that must not sleep early, each the longest idle.
        awake.get_mut("b").unwrap().always_warm = true;
        assert_eq!(candidate(&awake, now, secs(30)).as_deref(), Some("c"));
        awake.get_mut("c").unwrap().starting = true;
        assert_eq!(candidate(&awake, now, secs(30)).as_deref(), Some("a"));
        awake.get_mut("a").unwrap().early_sleeping = true;
        assert_eq!(candidate(&awake, now, secs(30)), None);
        assert_eq!(candidate(&HashMap::new(), now, secs(30)), None);
    }

    #[test]
    fn a_database_qualifies_after_exactly_the_idle_time_and_a_tie_goes_to_the_lower_id() {
        let base = Instant::now();
        let awake = HashMap::from([
            ("z".to_string(), idle_since(base + secs(70))),
            ("y".to_string(), idle_since(base + secs(70))),
        ]);
        // 30 s without client activity qualifies; 29.999 s does not.
        assert_eq!(
            candidate(&awake, base + secs(100), secs(30)).as_deref(),
            Some("y")
        );
        assert_eq!(
            candidate(&awake, base + Duration::from_millis(99_999), secs(30)),
            None
        );
        // A policy without idle time lets any non-starting database qualify at once.
        assert_eq!(
            candidate(&awake, base + secs(70), Duration::ZERO).as_deref(),
            Some("y")
        );
    }

    /// A node with a, b and c awake and idle since `t0`, `now` a minute later, and room only for
    /// waiting.
    fn idle_node(t0: Instant) -> Admitter {
        Admitter::rebuild(
            policy(),
            ["a", "b", "c"].map(|database| Running {
                database: database.into(),
                memory_mib: 256,
                starting: false,
                always_warm: false,
            }),
            t0,
        )
    }

    #[test]
    fn one_database_sleeps_early_for_each_waiting_start_and_never_more() {
        let t0 = Instant::now();
        let now = t0 + secs(60);
        let mut admitter = idle_node(t0);
        assert_eq!(admitter.early_sleep(now), None, "no start waits");
        let w1 = queue(&mut admitter, now, &facts(100), request("w1", 256));
        assert_eq!(admitter.early_sleep(now).as_deref(), Some("a"));
        assert_eq!(admitter.early_sleep(now), None, "w1 has its sleeper");
        let w2 = queue(&mut admitter, now, &facts(100), request("w2", 256));
        assert_eq!(
            admitter.early_sleep(now).as_deref(),
            Some("b"),
            "a already sleeps"
        );
        // The sleeper stopped, and w1 still waits (the memory did not suffice): no second one.
        admitter.stopped("a");
        assert_eq!(admitter.early_sleep(now), None);
        // A third waiting start gets the last one.
        admitter.request(now, &facts(100), request("w3", 256));
        assert_eq!(admitter.early_sleep(now).as_deref(), Some("c"));
        admitter.request(now, &facts(100), request("w4", 256));
        assert_eq!(
            admitter.early_sleep(now),
            None,
            "nobody left to put to sleep"
        );
        // A start that gave up does not hand its sleeper to another.
        assert!(admitter.cancel(w1) && admitter.cancel(w2));
        assert_eq!(admitter.early_sleep(now), None);
    }

    #[test]
    fn a_refused_early_sleep_leaves_the_database_awake_and_the_start_gets_another() {
        let t0 = Instant::now();
        let now = t0 + secs(60);
        let mut admitter = idle_node(t0);
        queue(&mut admitter, now, &facts(100), request("w", 256));
        assert_eq!(admitter.early_sleep(now).as_deref(), Some("a"));
        assert_eq!(admitter.early_sleep(now), None, "w has its sleeper");
        // a was busy: it counts as used now, and w may have another.
        admitter.early_sleep_refused("a", now);
        assert_eq!(admitter.early_sleep(now).as_deref(), Some("b"));
        admitter.early_sleep_refused("b", now);
        assert_eq!(admitter.early_sleep(now).as_deref(), Some("c"));
        admitter.early_sleep_refused("c", now);
        assert_eq!(
            admitter.early_sleep(now),
            None,
            "all three were used just now"
        );
        assert_eq!(admitter.early_sleep(now + secs(29)), None);
        // Thirty seconds later the one refused first is idle long enough again.
        assert_eq!(admitter.early_sleep(now + secs(30)).as_deref(), Some("a"));
        // A database that is not asleep early, or not awake, is left alone.
        admitter.early_sleep_refused("nobody", now);
        assert_eq!(admitter.snapshot().awake, ["a", "b", "c"]);
    }

    #[test]
    fn early_sleep_is_off_when_policy_says_so_and_waits_for_a_database_to_qualify() {
        let t0 = Instant::now();
        let mut off = policy();
        off.early_sleep.enabled = false;
        let mut admitter = idle_node(t0);
        admitter.set_policy(off);
        admitter.request(t0 + secs(60), &facts(100), request("w", 256));
        assert_eq!(admitter.early_sleep(t0 + secs(60)), None);
        // On, but every database was used within the last 30 s: none qualifies yet.
        let mut admitter = idle_node(t0);
        admitter.request(t0, &facts(100), request("w", 256));
        assert_eq!(admitter.early_sleep(t0 + secs(29)), None);
        assert_eq!(admitter.early_sleep(t0 + secs(30)).as_deref(), Some("a"));
    }

    #[test]
    fn client_activity_and_always_warm_change_who_qualifies() {
        let t0 = Instant::now();
        let now = t0 + secs(60);
        let mut admitter = idle_node(t0);
        admitter.activity("a", t0 + secs(50));
        admitter.activity("b", t0 + secs(10));
        admitter.activity("b", t0 + secs(5));
        admitter.set_always_warm("c", true);
        admitter.request(now, &facts(100), request("w", 256));
        // a was used 10 s ago, c is always warm, b was last used at 10 s (the older report lost).
        assert_eq!(admitter.early_sleep(now).as_deref(), Some("b"));
        // Unknown databases are ignored.
        admitter.activity("nobody", now);
        admitter.set_always_warm("nobody", true);
        admitter.stopped("nobody");
    }

    // ---------- inputs and the contract ----------

    #[test]
    fn mem_available_is_read_from_meminfo_in_bytes() {
        let meminfo = "MemTotal:       12228220 kB\nMemFree:         8123412 kB\n\
                       MemAvailable:   10934912 kB\nBuffers:          102404 kB\n";
        assert_eq!(mem_available_bytes(meminfo), Some(10_934_912 * 1024));
        assert_eq!(mem_available_bytes("MemTotal: 1 kB\n"), None);
        assert_eq!(mem_available_bytes("MemAvailable: 12 MB\n"), None);
        assert_eq!(mem_available_bytes("MemAvailable: lots kB\n"), None);
        assert_eq!(mem_available_bytes("MemAvailableX: 12 kB\n"), None);
        assert_eq!(mem_available_bytes(""), None);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn the_running_kernels_meminfo_parses() {
        let meminfo = std::fs::read_to_string("/proc/meminfo").unwrap();
        let available = mem_available_bytes(&meminfo).expect("MemAvailable");
        assert!(available > 0);
        let total = meminfo
            .lines()
            .find_map(|line| line.strip_prefix("MemTotal:"))
            .and_then(|rest| rest.trim().strip_suffix("kB"))
            .and_then(|kb| kb.trim().parse::<u64>().ok())
            .unwrap()
            * 1024;
        assert!(available <= total);
    }

    #[test]
    fn the_contracts_example_policy_is_this_policy() {
        let vectors: serde_json::Value = serde_json::from_str(include_str!(
            "../../../packages/contracts/native/node-vectors.generated.json"
        ))
        .unwrap();
        let page = vectors["schemas"]
            .as_array()
            .unwrap()
            .iter()
            .find(|v| {
                v["schema"] == "NodeDesiredPage" && v["name"] == "full-page" && v["valid"] == true
            })
            .expect("the valid full desired page");
        let from_contract: Policy =
            serde_json::from_value(page["value"]["policy"].clone()).unwrap();
        assert_eq!(from_contract, policy());
        // The reserved rule is the contract's other value.
        let mut changed = page["value"]["policy"].clone();
        changed["admission"]["memory_rule"] = "reserved".into();
        let reserved_policy: Policy = serde_json::from_value(changed).unwrap();
        assert_eq!(reserved_policy.admission.memory_rule, MemoryRule::Reserved);
        // A field the agent does not know is not ignored.
        let mut unknown = page["value"]["policy"].clone();
        unknown["admission"]["surprise"] = 1.into();
        assert!(serde_json::from_value::<Policy>(unknown).is_err());
    }

    #[test]
    fn the_refusals_are_the_contracts_with_its_details() {
        let local: serde_json::Value = serde_json::from_str(include_str!(
            "../../../packages/contracts/native/node-local.generated.json"
        ))
        .unwrap();
        let constants = &local["constants"];
        let reasons: Vec<&str> = constants["ADMISSION_REFUSALS"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect();
        let ours = [Refusal::NoRoom, Refusal::NoHeadroom];
        assert_eq!(ours.map(Refusal::reason), reasons[..]);
        for refusal in ours {
            assert_eq!(
                constants["ADMISSION_REFUSAL_DETAILS"][refusal.reason()],
                refusal.detail()
            );
        }
    }

    // ---------- the serialized loop ----------

    use std::sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
    };

    /// The node as the loop reads it: how much memory is available and whether the pool has room.
    #[derive(Clone)]
    struct Node {
        memory_mib: Arc<AtomicU64>,
        room: Arc<AtomicBool>,
    }
    impl Node {
        fn new(memory_mib: u64) -> Self {
            Self {
                memory_mib: Arc::new(AtomicU64::new(memory_mib)),
                room: Arc::new(AtomicBool::new(true)),
            }
        }
        fn run(&self, policy: Policy) -> (Admission, mpsc::UnboundedReceiver<String>) {
            let node = self.clone();
            Admission::spawn(Admitter::new(policy), move || Facts {
                mem_available_bytes: node.memory_mib.load(Ordering::SeqCst) * MIB_U64,
                pool: node.room.load(Ordering::SeqCst).then(pool),
            })
        }
    }

    fn snapshot_of(awake: &[&str], memory_mib: u64, starting: usize, queued: usize) -> Snapshot {
        Snapshot {
            awake: awake.iter().map(|s| s.to_string()).collect(),
            awake_memory_mib: memory_mib,
            starting,
            queued,
        }
    }

    #[tokio::test(start_paused = true)]
    async fn the_loop_admits_at_once_and_counts_a_start_until_its_permit_is_ready() {
        let (admission, _early) = Node::new(10_000).run(policy());
        let permit = admission.admit(request("a", 256)).await.unwrap();
        assert_eq!(permit.waited, Duration::ZERO);
        assert_eq!(
            admission.snapshot().await,
            Some(snapshot_of(&["a"], 256, 1, 0))
        );
        permit.ready();
        assert_eq!(
            admission.snapshot().await,
            Some(snapshot_of(&["a"], 256, 0, 0))
        );
        assert_eq!(
            admission.admit(request("a", 256)).await.err(),
            Some(AdmitError::Duplicate)
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_permit_that_is_dropped_reports_its_start_failed() {
        let mut one = policy();
        one.admission.start_concurrency = 1;
        let (admission, _early) = Node::new(10_000).run(one);
        let first = admission.admit(request("a", 256)).await.unwrap();
        let second = tokio::spawn({
            let admission = admission.clone();
            async move { admission.admit(request("b", 256)).await }
        });
        tokio::time::sleep(Duration::from_secs(1)).await;
        assert!(!second.is_finished(), "the cap holds b back");
        drop(first);
        let permit = second.await.unwrap().unwrap();
        assert_eq!(permit.waited, secs(1));
        assert_eq!(
            admission.snapshot().await,
            Some(snapshot_of(&["b"], 256, 1, 0))
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_waiting_start_is_refused_after_the_queue_wait_with_the_retry_hint() {
        let (admission, _early) = Node::new(100).run(policy());
        let waiting = tokio::spawn({
            let admission = admission.clone();
            async move { admission.admit(request("a", 256)).await }
        });
        tokio::time::sleep(Duration::from_secs(9)).await;
        assert!(!waiting.is_finished());
        tokio::time::sleep(Duration::from_secs(2)).await;
        assert_eq!(
            waiting.await.unwrap().err(),
            Some(AdmitError::Refused(Refused {
                reason: Refusal::NoHeadroom,
                retry_after_seconds: Some(5),
                waited: secs(10),
            }))
        );
        assert_eq!(admission.snapshot().await, Some(snapshot_of(&[], 0, 0, 0)));
    }

    #[tokio::test(start_paused = true)]
    async fn memory_that_frees_up_without_an_event_is_noticed_within_the_recheck() {
        let node = Node::new(100);
        let (admission, _early) = node.run(policy());
        let waiting = tokio::spawn({
            let admission = admission.clone();
            async move { admission.admit(request("a", 256)).await }
        });
        tokio::time::sleep(Duration::from_secs(3)).await;
        node.memory_mib.store(856, Ordering::SeqCst);
        let permit = waiting.await.unwrap().unwrap();
        assert!(permit.waited >= secs(3) && permit.waited < secs(3) + Duration::from_millis(100));
        // Room that goes away refuses the next waiting start at once.
        node.room.store(false, Ordering::SeqCst);
        permit.ready();
        assert_eq!(
            admission.admit(request("b", 256)).await.err(),
            Some(AdmitError::Refused(Refused {
                reason: Refusal::NoRoom,
                retry_after_seconds: None,
                waited: Duration::ZERO,
            }))
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_stop_makes_room_under_the_reserved_rule_immediately() {
        let mut policy = reserved();
        policy.admission.awake_budget_mib = 528;
        let (admission, _early) = Node::new(0).run(policy);
        for database in ["a", "b"] {
            admission
                .admit(request(database, 256))
                .await
                .unwrap()
                .ready();
        }
        let waiting = tokio::spawn({
            let admission = admission.clone();
            async move { admission.admit(request("c", 256)).await }
        });
        tokio::time::sleep(Duration::from_secs(2)).await;
        assert!(!waiting.is_finished());
        admission.stopped("a");
        let permit = waiting.await.unwrap().unwrap();
        assert_eq!(permit.waited, secs(2));
    }

    #[tokio::test(start_paused = true)]
    async fn a_caller_that_gives_up_leaves_the_queue_and_the_next_in_line_is_served() {
        let node = Node::new(100);
        let (admission, _early) = node.run(policy());
        let first = tokio::spawn({
            let admission = admission.clone();
            async move { admission.admit(request("a", 256)).await }
        });
        tokio::time::sleep(Duration::from_millis(10)).await;
        let second = tokio::spawn({
            let admission = admission.clone();
            async move { admission.admit(request("b", 256)).await }
        });
        tokio::time::sleep(Duration::from_secs(1)).await;
        first.abort();
        let _ = first.await;
        node.memory_mib.store(856, Ordering::SeqCst);
        let permit = second.await.unwrap().unwrap();
        assert_eq!(
            admission.snapshot().await,
            Some(snapshot_of(&["b"], 256, 1, 0))
        );
        drop(permit);
        assert_eq!(admission.snapshot().await, Some(snapshot_of(&[], 0, 0, 0)));
    }

    #[tokio::test(start_paused = true)]
    async fn a_waiting_start_asks_for_one_early_sleep_of_an_idle_database() {
        let node = Node::new(10_000);
        let (admission, mut early) = node.run(policy());
        admission.admit(request("x", 256)).await.unwrap().ready();
        node.memory_mib.store(100, Ordering::SeqCst);
        tokio::time::sleep(Duration::from_secs(31)).await;
        let waiting = tokio::spawn({
            let admission = admission.clone();
            async move { admission.admit(request("w", 256)).await }
        });
        assert_eq!(early.recv().await.as_deref(), Some("x"));
        // The sleeper stops and the memory comes back: the waiting start begins.
        admission.stopped("x");
        node.memory_mib.store(10_000, Ordering::SeqCst);
        let permit = waiting.await.unwrap().unwrap();
        assert!(
            permit.waited < secs(1),
            "it began when the memory came back"
        );
        assert!(
            early.try_recv().is_err(),
            "one early sleep for one waiting start"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_refused_early_sleep_is_not_asked_again_for_thirty_seconds() {
        let node = Node::new(10_000);
        let mut longer = policy();
        longer.admission.queue_wait_ms = 20_000;
        let (admission, mut early) = node.run(longer);
        admission.admit(request("x", 256)).await.unwrap().ready();
        node.memory_mib.store(100, Ordering::SeqCst);
        tokio::time::sleep(Duration::from_secs(31)).await;
        let wait_for = |database: &'static str| {
            let admission = admission.clone();
            tokio::spawn(async move { admission.admit(request(database, 256)).await })
        };
        // The first start waits, x is chosen and refuses; that start gives up after 20 s.
        let _first = wait_for("w1");
        assert_eq!(early.recv().await.as_deref(), Some("x"));
        admission.early_sleep_refused("x");
        tokio::time::sleep(Duration::from_secs(15)).await;
        let _second = wait_for("w2");
        tokio::time::sleep(Duration::from_secs(14)).await;
        assert!(early.try_recv().is_err(), "x counts as used for 30 s");
        tokio::time::sleep(Duration::from_secs(2)).await;
        assert_eq!(early.try_recv().ok().as_deref(), Some("x"));
    }

    #[tokio::test(start_paused = true)]
    async fn a_loop_without_handles_ends() {
        let (admission, mut early) = Node::new(10_000).run(policy());
        drop(admission);
        assert_eq!(
            early.recv().await,
            None,
            "the loop ended and closed its channel"
        );
    }
}
