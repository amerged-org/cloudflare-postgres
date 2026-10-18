// SPDX-License-Identifier: Apache-2.0
//! The wake queue: connections of a sleeping database that arrived with a wake ticket (route v5)
//! are held here, one ticket per database, until the node agent's table releases them. The agent
//! takes the tickets over its channel and answers each with a result; the release itself is the
//! table entry that shows the woken unit.
use pgcf_native_protocol::wake::{
    MAX_HELD_PER_DATABASE, MAX_HELD_TOTAL, MAX_WAKES_PER_POLL, REDELIVER_MS, TICKET_LEASE_MS,
    WakeClaims, WakeRequest, WakeResult,
};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::sync::{Notify, watch};

/// The result the agent sent for a ticket, once it sent one.
type Answer = Option<WakeResult>;
struct Ticket {
    request: WakeRequest,
    /// When a long-poll last took it.
    delivered_at: Option<Instant>,
    /// A result arrived: the ticket is not delivered again.
    answered: bool,
    /// Held connections attached to it.
    waiters: usize,
    /// When its last waiter left; it is kept only for a late result.
    orphaned_at: Option<Instant>,
    answer: watch::Sender<Answer>,
}
impl Ticket {
    fn deliverable(&self, now: Instant) -> bool {
        self.waiters > 0
            && !self.answered
            && self.delivered_at.is_none_or(|at| {
                now.saturating_duration_since(at) >= Duration::from_millis(REDELIVER_MS)
            })
    }
}
#[derive(Default)]
struct Inner {
    tickets: HashMap<String, Ticket>,
    held: HashMap<String, usize>,
    total: usize,
}
impl Inner {
    /// Drops the orphaned tickets whose late result can no longer arrive in time to matter.
    fn sweep(&mut self, now: Instant) {
        self.tickets.retain(|_, ticket| {
            ticket.orphaned_at.is_none_or(|at| {
                now.saturating_duration_since(at) < Duration::from_millis(TICKET_LEASE_MS)
            })
        });
    }
}
#[derive(Default)]
pub struct WakeQueue {
    inner: Mutex<Inner>,
    /// Signalled when a ticket becomes deliverable.
    deliverable: Notify,
}
impl WakeQueue {
    pub fn new() -> Arc<Self> {
        Arc::default()
    }
    /// Holds one connection of a wake ticket. A ticket of a higher generation, or of another
    /// operation at the same generation, replaces the database's ticket; one of a lower
    /// generation is held without one. Beyond the bounds the answer is the HTTP status to refuse
    /// the upgrade with.
    pub fn hold(
        self: &Arc<Self>,
        claims: &WakeClaims,
        queued_at_ms: u64,
        now: Instant,
    ) -> Result<Held, u16> {
        let mut inner = self.inner.lock().unwrap();
        inner.sweep(now);
        if inner.held.get(&claims.db).copied().unwrap_or(0) >= MAX_HELD_PER_DATABASE {
            return Err(429);
        }
        if inner.total >= MAX_HELD_TOTAL {
            return Err(503);
        }
        let current = inner.tickets.get(&claims.db).map(|ticket| {
            (
                ticket.request.generation,
                ticket.request.operation == claims.op,
            )
        });
        let attached = match current {
            Some((generation, _)) if generation > claims.generation => false,
            Some((generation, true)) if generation == claims.generation => true,
            _ => {
                inner.tickets.insert(
                    claims.db.clone(),
                    Ticket {
                        request: WakeRequest::of(claims, queued_at_ms),
                        delivered_at: None,
                        answered: false,
                        waiters: 0,
                        orphaned_at: None,
                        answer: watch::Sender::new(None),
                    },
                );
                true
            }
        };
        let answer = if attached {
            let ticket = inner.tickets.get_mut(&claims.db).expect("attached ticket");
            ticket.waiters += 1;
            ticket.orphaned_at = None;
            Some(ticket.answer.subscribe())
        } else {
            None
        };
        *inner.held.entry(claims.db.clone()).or_default() += 1;
        inner.total += 1;
        drop(inner);
        self.deliverable.notify_waiters();
        Ok(Held {
            queue: self.clone(),
            database: claims.db.clone(),
            ticket: attached.then(|| (claims.op.clone(), claims.generation)),
            answer,
            replaced: false,
        })
    }
    /// The deliverable tickets, marked delivered at `now`: never delivered, or delivered
    /// `REDELIVER_MS` ago without a result since.
    pub fn take(&self, now: Instant) -> Vec<WakeRequest> {
        let mut inner = self.inner.lock().unwrap();
        inner.sweep(now);
        let mut wakes = Vec::new();
        for ticket in inner.tickets.values_mut() {
            if wakes.len() == MAX_WAKES_PER_POLL {
                break;
            }
            if ticket.deliverable(now) {
                ticket.delivered_at = Some(now);
                wakes.push(ticket.request.clone());
            }
        }
        wakes
    }
    /// When the next delivered ticket without a result becomes deliverable again.
    fn redelivery(&self) -> Option<Instant> {
        let inner = self.inner.lock().unwrap();
        inner
            .tickets
            .values()
            .filter(|ticket| ticket.waiters > 0 && !ticket.answered)
            .filter_map(|ticket| ticket.delivered_at)
            .min()
            .map(|at| at + Duration::from_millis(REDELIVER_MS))
    }
    /// The agent channel's wait: the deliverable tickets as soon as there are any, or none
    /// after `hold`.
    pub async fn poll(&self, hold: Duration) -> Vec<WakeRequest> {
        let deadline = Instant::now() + hold;
        loop {
            let notified = self.deliverable.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            let now = Instant::now();
            let wakes = self.take(now);
            if !wakes.is_empty() || now >= deadline {
                return wakes;
            }
            let until = self.redelivery().map_or(deadline, |at| at.min(deadline));
            tokio::select! {
                _ = notified => {},
                _ = tokio::time::sleep_until(tokio::time::Instant::from_std(until)) => {},
            }
        }
    }
    /// Records the agent's result for the ticket it names. False when no such ticket is held.
    pub fn result(&self, result: &WakeResult) -> bool {
        let mut inner = self.inner.lock().unwrap();
        let Some(ticket) = inner.tickets.get_mut(&result.database).filter(|ticket| {
            ticket.request.operation == result.operation
                && ticket.request.generation == result.generation
        }) else {
            return false;
        };
        ticket.answered = true;
        ticket.answer.send_replace(Some(result.clone()));
        if ticket.waiters == 0 {
            inner.tickets.remove(&result.database);
        }
        true
    }
    /// Connections held for the database.
    pub fn held(&self, database: &str) -> usize {
        self.inner
            .lock()
            .unwrap()
            .held
            .get(database)
            .copied()
            .unwrap_or(0)
    }
    /// The database's ticket, as it is delivered.
    pub fn ticket(&self, database: &str) -> Option<WakeRequest> {
        self.inner
            .lock()
            .unwrap()
            .tickets
            .get(database)
            .map(|ticket| ticket.request.clone())
    }
    fn leave(&self, database: &str, ticket: Option<&(String, u64)>) {
        let mut inner = self.inner.lock().unwrap();
        inner.total -= 1;
        let count = inner.held.get_mut(database).expect("held database");
        *count -= 1;
        if *count == 0 {
            inner.held.remove(database);
        }
        let Some(current) = inner.tickets.get_mut(database).filter(|current| {
            ticket.is_some_and(|(operation, generation)| {
                current.request.operation == *operation && current.request.generation == *generation
            })
        }) else {
            return;
        };
        current.waiters -= 1;
        if current.waiters == 0 {
            // A ticket never delivered, or already answered, is done; a delivered one waits for
            // its result, which labels the connections it released.
            if current.delivered_at.is_none() || current.answered {
                inner.tickets.remove(database);
            } else {
                current.orphaned_at = Some(Instant::now());
            }
        }
    }
}
/// One held connection. Dropping it leaves the queue.
pub struct Held {
    queue: Arc<WakeQueue>,
    database: String,
    /// The ticket (operation, generation) it is attached to; none for a lower generation.
    ticket: Option<(String, u64)>,
    answer: Option<watch::Receiver<Answer>>,
    /// Its ticket was replaced or forgotten: no result comes any more.
    replaced: bool,
}
impl Held {
    /// The agent's result for the ticket, once it arrived.
    pub fn verdict(&self) -> Option<WakeResult> {
        self.answer
            .as_ref()
            .and_then(|answer| answer.borrow().clone())
    }
    /// Resolves when a result arrives; never for a connection without a ticket, or once its
    /// ticket was replaced.
    pub async fn answered(&mut self) {
        if !self.replaced
            && let Some(answer) = &mut self.answer
        {
            if answer.changed().await.is_ok() {
                return;
            }
            self.replaced = true;
        }
        std::future::pending().await
    }
    /// Leaves the queue on release, keeping the result as it arrives.
    pub fn release(mut self) -> Verdict {
        Verdict(self.answer.take())
    }
}
impl Drop for Held {
    fn drop(&mut self) {
        self.queue.leave(&self.database, self.ticket.as_ref());
    }
}
/// The result of a released connection's ticket, as it arrives.
pub struct Verdict(Option<watch::Receiver<Answer>>);
impl Verdict {
    pub fn get(&self) -> Option<WakeResult> {
        self.0.as_ref().and_then(|answer| answer.borrow().clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pgcf_native_protocol::wake::{
        MAX_HELD_PER_DATABASE, MAX_HELD_TOTAL, Outcome, REDELIVER_MS, TICKET_LEASE_MS, WakeClaims,
        WakeResult,
    };
    use std::time::{Duration, Instant};
    const DATABASE: &str = "aaaaaaaaaaaaaaaaaaaa";
    fn operation(letter: char) -> String {
        format!("op_{}", letter.to_string().repeat(20))
    }
    fn claims(database: &str, id: usize, generation: u64, operation: &str) -> WakeClaims {
        WakeClaims {
            v: 5,
            db: database.into(),
            user: "app".into(),
            cid: format!("01234567-89ab-4def-8123-{id:012x}"),
            rg: "eu-test".into(),
            kid: "test".into(),
            iat: 1,
            exp: 31,
            op: operation.into(),
            generation,
            route_revision: 19,
            rh: "c".repeat(64),
        }
    }
    fn result(generation: u64, operation: &str, outcome: Outcome) -> WakeResult {
        WakeResult {
            database: DATABASE.into(),
            operation: operation.into(),
            generation,
            outcome,
            reason: (outcome == Outcome::Refused).then(|| "no_headroom".into()),
            retry_after_seconds: (outcome == Outcome::Refused).then_some(5),
            steps_ms: Default::default(),
        }
    }
    #[test]
    fn bounds_coalescing_replacement_by_higher_generation_and_cleanup_on_last_waiter() {
        let queue = WakeQueue::new();
        let start = Instant::now();
        let redeliver = Duration::from_millis(REDELIVER_MS);
        let (a, b) = (operation('a'), operation('b'));
        // Two connections of one wake are one ticket, queued at the first.
        let first = queue.hold(&claims(DATABASE, 1, 2, &a), 100, start).unwrap();
        let second = queue.hold(&claims(DATABASE, 2, 2, &a), 200, start).unwrap();
        assert_eq!(queue.held(DATABASE), 2);
        let ticket = queue.ticket(DATABASE).unwrap();
        assert_eq!((ticket.generation, ticket.queued_at_ms), (2, 100));
        // Delivered once, and again only after REDELIVER_MS without a result.
        assert_eq!(queue.take(start), vec![ticket.clone()]);
        assert!(queue.take(start).is_empty());
        assert!(
            queue
                .take(start + redeliver - Duration::from_millis(1))
                .is_empty()
        );
        assert_eq!(queue.take(start + redeliver), vec![ticket]);
        // A result reaches the held connections and ends redelivery.
        assert!(queue.result(&result(2, &a, Outcome::Started)));
        assert_eq!(first.verdict().unwrap().outcome, Outcome::Started);
        assert!(queue.take(start + 10 * redeliver).is_empty());
        // A higher generation replaces the ticket and is deliverable at once; the replaced
        // ticket is no longer known.
        let third = queue.hold(&claims(DATABASE, 3, 4, &b), 300, start).unwrap();
        let ticket = queue.ticket(DATABASE).unwrap();
        assert_eq!(
            (ticket.generation, ticket.operation.as_str()),
            (4, b.as_str())
        );
        assert_eq!(queue.take(start), vec![ticket.clone()]);
        assert!(!queue.result(&result(2, &a, Outcome::Started)));
        assert!(third.verdict().is_none());
        // A lower generation is held but never replaces the ticket.
        let fourth = queue.hold(&claims(DATABASE, 4, 2, &a), 400, start).unwrap();
        assert_eq!(queue.ticket(DATABASE).unwrap(), ticket);
        assert_eq!(queue.held(DATABASE), 4);
        // Per database at most MAX_HELD_PER_DATABASE, then 429.
        let mut more = Vec::new();
        for id in queue.held(DATABASE)..MAX_HELD_PER_DATABASE {
            more.push(
                queue
                    .hold(&claims(DATABASE, 100 + id, 4, &b), 500, start)
                    .unwrap(),
            );
        }
        assert_eq!(
            queue.hold(&claims(DATABASE, 99, 4, &b), 600, start).err(),
            Some(429)
        );
        // In total at most MAX_HELD_TOTAL, then 503.
        let mut others = Vec::new();
        let mut database = 0;
        while MAX_HELD_PER_DATABASE + others.len() < MAX_HELD_TOTAL {
            let name = format!("b{:019}", database / MAX_HELD_PER_DATABASE);
            others.push(
                queue
                    .hold(&claims(&name, database, 2, &a), 1, start)
                    .unwrap(),
            );
            database += 1;
        }
        assert_eq!(
            queue
                .hold(&claims(&format!("c{:019}", 0), 1, 2, &a), 1, start)
                .err(),
            Some(503)
        );
        drop(others);
        // The last waiter leaves: a delivered ticket without a result is delivered no more, and
        // its late result still labels the connections it released.
        let verdict = first.release();
        drop((second, third, fourth, more));
        assert_eq!(queue.held(DATABASE), 0);
        assert!(queue.take(start + redeliver).is_empty());
        assert!(queue.result(&result(4, &b, Outcome::Started)));
        assert!(queue.ticket(DATABASE).is_none());
        assert_eq!(verdict.get().unwrap().outcome, Outcome::Started);
        // A ticket never delivered goes with its last waiter.
        let held = queue.hold(&claims(DATABASE, 5, 6, &a), 700, start).unwrap();
        drop(held);
        assert!(queue.ticket(DATABASE).is_none());
        // A delivered ticket nobody answers is forgotten after the ticket lease.
        let held = queue.hold(&claims(DATABASE, 6, 7, &a), 800, start).unwrap();
        assert_eq!(queue.take(start).len(), 1);
        drop(held);
        assert!(queue.ticket(DATABASE).is_some());
        assert!(
            queue
                .take(Instant::now() + Duration::from_millis(TICKET_LEASE_MS))
                .is_empty()
        );
        assert!(queue.ticket(DATABASE).is_none());
    }
}
