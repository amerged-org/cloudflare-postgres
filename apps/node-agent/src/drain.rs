// SPDX-License-Identifier: Apache-2.0
//! The outbox drain (plan database-events-and-schedules 4.5, D13): the task that moves the data
//! events of a database from its `pgcf.outbox` to Cloudflare. A row leaves the outbox only after
//! Cloudflare stored the request that carries it; a row the agent cannot send at all is deleted
//! with a class-only log line, so it never blocks the rows behind it.
use crate::{
    Error,
    archive::facts,
    diagnostics,
    node_link::{constant, contract_valid},
    pgcf,
    postgres::Session,
    timing,
};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    future::Future,
    path::{Path, PathBuf},
    pin::Pin,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio::{sync::Notify, time::Instant};

/// What Cloudflare's answer to a posted request means to the drain.
#[derive(Debug, PartialEq, Eq)]
pub enum SendError {
    /// The node is fenced: the drain ends.
    Fenced,
    /// The request was not stored and posting it again unchanged cannot store it. The class names
    /// why (`http_400`); the drain halves the batch and deletes a single event it refuses.
    Rejected(String),
    /// The request was not stored. The class names why (`http_503`, `transport`); the drain
    /// posts the same events again.
    Failed(String),
}

/// The answer of a non-success status: a 400, 413 or 422 refuses the content of the request,
/// which repeats unchanged, and every other status is a failure that a retry may cure.
pub fn refused(status: u16) -> SendError {
    let class = format!("http_{status}");
    match status {
        400 | 413 | 422 => SendError::Rejected(class),
        _ => SendError::Failed(class),
    }
}

/// Posts one `NodeDataEventReport` body and answers once Cloudflare has.
pub type Post =
    Arc<dyn Fn(Value) -> Pin<Box<dyn Future<Output = Result<(), SendError>> + Send>> + Send + Sync>;

/// The pacing and the batch size, which the node's policy sets and the hub updates.
pub struct Tuning {
    /// Events per second the drain may post: a pause of `n / rate` after `n` events.
    pub rate: AtomicU32,
    /// The payload limit of the database, which sizes a batch to fit one request.
    pub max_payload_bytes: AtomicU64,
}

/// Whether the last read of the outbox returned rows.
pub struct State {
    pub pending: AtomicBool,
}

/// The timing of the drain.
pub struct Settings {
    /// The longest wait for a notification before the outbox is read anyway.
    pub poll: Duration,
    /// The least time between the starts of two cycles.
    pub gap: Duration,
    /// The first backoff after a failure; it doubles up to `retry_maximum`.
    pub retry: Duration,
    pub retry_maximum: Duration,
}

/// One event of a batch, as the contract carries it.
#[derive(Clone, Debug, PartialEq)]
pub struct Event {
    pub seq: i64,
    pub epoch: i64,
    pub at: String,
    pub topic: String,
    pub payload: Value,
}

/// Why the drain does not send an outbox row. `class` is the token the log names.
#[derive(Debug, PartialEq, Eq)]
pub enum Reject {
    Topic,
    NotObject,
    TooLarge,
    Unparsable,
    /// The sequence number or the epoch is outside the contract's integers.
    Seq,
}
impl Reject {
    pub fn class(&self) -> &'static str {
        match self {
            Self::Topic => "topic",
            Self::NotObject => "not_object",
            Self::TooLarge => "too_large",
            Self::Unparsable => "unparsable",
            Self::Seq => "seq",
        }
    }
}

/// Runs the drain of `database` until Cloudflare answers `Fenced`. It keeps its own session with
/// `LISTEN`, reconnects with backoff when the session ends, and holds no lock in the database.
pub async fn run(
    socket_directory: PathBuf,
    database: String,
    post: Post,
    tuning: Arc<Tuning>,
    settings: Settings,
    state: Arc<State>,
) {
    let notify = Arc::new(Notify::new());
    let mut drain = Drain {
        wait: settings.retry,
        socket_directory,
        database,
        post,
        tuning,
        settings,
        state,
        not_before: None,
        rejected_at: None,
        refusing: false,
    };
    loop {
        let stop = match listen(&drain.socket_directory, &drain.database, notify.clone()).await {
            Ok(session) => drain.serve(&session, &notify).await,
            Err(error) => Stop::Lost(diagnostics::error_code(&error)),
        };
        match stop {
            Stop::Fenced => return,
            Stop::Lost(class) => {
                drain.state.pending.store(false, Ordering::Relaxed);
                timing::log_line(json!({
                    "event": "data_events_session_lost", "database_id": drain.database, "class": class,
                }));
            }
        }
        tokio::time::sleep(drain.backoff()).await;
    }
}

/// The drain's state across sessions: what the pacing, the episode of refusals and the backoff
/// need to outlive one session.
struct Drain {
    socket_directory: PathBuf,
    database: String,
    post: Post,
    tuning: Arc<Tuning>,
    settings: Settings,
    state: Arc<State>,
    /// The earliest time of the next post, set by the pace of the last batch.
    not_before: Option<Instant>,
    /// When the rejected rows were last announced as an event. A tenant can write rows the drain
    /// refuses at will, so the announcements wait for `retry_maximum`; the others are log lines.
    rejected_at: Option<Instant>,
    /// Whether the last post failed: the episode's first failure is an event, the others lines.
    refusing: bool,
    /// The wait before the next reconnect.
    wait: Duration,
}

/// Why a session of the drain ended.
enum Stop {
    Fenced,
    /// The session failed; the class names why.
    Lost(String),
}

/// How Cloudflare answered a batch that did not end the session.
enum Sent {
    Stored,
    /// Cloudflare refused the content; the class names the status.
    Refused(String),
}

fn lost(error: Error) -> Stop {
    Stop::Lost(diagnostics::error_code(&error))
}

/// Removes the rows with these sequence numbers. A row that stays would be sent again, so a
/// shortfall ends the session rather than letting the drain repeat the same rows unpaced.
async fn remove(session: &Session, seqs: &[i64]) -> Result<(), Stop> {
    let removed = pgcf::delete(session, seqs).await.map_err(lost)?;
    if removed == u64::try_from(seqs.len()).unwrap_or(u64::MAX) {
        Ok(())
    } else {
        Err(Stop::Lost("outbox_delete_incomplete".into()))
    }
}

/// A session of the drain: the events session of `database`, listening on the outbox channel.
async fn listen(
    socket_directory: &Path,
    database: &str,
    notify: Arc<Notify>,
) -> Result<Session, Error> {
    let session = pgcf::connect(socket_directory, database, Some(notify)).await?;
    session.batch(&format!("LISTEN {}", pgcf::CHANNEL)).await?;
    Ok(session)
}

impl Drain {
    /// Drains with one session until it fails or Cloudflare fences the node. A cycle starts at
    /// most `gap` after the previous one, and runs after a notification or the poll.
    async fn serve(&mut self, session: &Session, notify: &Notify) -> Stop {
        // A database without the platform's outbox waits on this session: the schema may be
        // installed later, and a reconnect would only find it absent again.
        let mut absent = false;
        loop {
            match pgcf::owned(session).await {
                Ok(true) => break,
                Ok(false) => {
                    self.state.pending.store(false, Ordering::Relaxed);
                    if !absent {
                        absent = true;
                        timing::log_line(json!({
                            "event": "data_events_schema_absent", "database_id": self.database,
                        }));
                    }
                    tokio::time::sleep(self.settings.poll).await;
                    if session.client.is_closed() {
                        return Stop::Lost("connection_closed".into());
                    }
                }
                Err(error) => return lost(error),
            }
        }
        let mut started: Option<Instant> = None;
        loop {
            if let Some(previous) = started {
                tokio::time::sleep_until(previous + self.settings.gap).await;
            }
            started = Some(Instant::now());
            if let Err(stop) = self.cycle(session).await {
                return stop;
            }
            self.wait = self.settings.retry;
            tokio::select! {
                () = notify.notified() => {}
                () = tokio::time::sleep(self.settings.poll) => {}
            }
            if session.client.is_closed() {
                return Stop::Lost("connection_closed".into());
            }
        }
    }

    /// Drains the outbox until a read finds it empty.
    async fn cycle(&mut self, session: &Session) -> Result<(), Stop> {
        // A schema `pgcf` that the platform role does not own is a tenant's: it is never read.
        if pgcf::conflict(session).await.map_err(lost)? {
            self.state.pending.store(false, Ordering::Relaxed);
            return Ok(());
        }
        let ceiling = bound_size("NODE_DATA_EVENT_PAYLOAD_MAX_BYTES");
        let max_events = bound_size("NODE_DATA_EVENT_BATCH_MAX");
        let max_bytes = bound_size("NODE_DATA_EVENT_BODY_MAX_BYTES");
        loop {
            let limit = batch_rows(self.tuning.max_payload_bytes.load(Ordering::Relaxed));
            let rows = pgcf::read_batch(session, limit, i64::try_from(ceiling).unwrap_or(i64::MAX))
                .await
                .map_err(lost)?;
            self.state
                .pending
                .store(!rows.is_empty(), Ordering::Relaxed);
            if rows.is_empty() {
                return Ok(());
            }
            let mut events = Vec::with_capacity(rows.len());
            let mut rejected = Vec::new();
            let mut classes: BTreeMap<String, u64> = BTreeMap::new();
            // The rows past the budget stay in the outbox, and the next read returns them.
            for row in &rows[..parse_budget(&rows, max_bytes)] {
                match validate(row, ceiling) {
                    Ok(event) => events.push(event),
                    Err(reject) => {
                        *classes.entry(reject.class().into()).or_default() += 1;
                        rejected.push(row.seq);
                    }
                }
            }
            let mut posted = fit(&self.database, &events, max_events, max_bytes);
            while posted == 0 && !events.is_empty() {
                // The contract refuses this event even alone, whatever its batch: it is too large.
                let event = events.remove(0);
                *classes.entry(Reject::TooLarge.class().into()).or_default() += 1;
                rejected.push(event.seq);
                posted = fit(&self.database, &events, max_events, max_bytes);
            }
            if !rejected.is_empty() {
                remove(session, &rejected).await?;
                self.announce(classes);
            }
            if events.is_empty() {
                continue;
            }
            self.deliver(session, &events, posted).await?;
        }
    }

    /// Posts the first `count` events, and removes the rows Cloudflare stores. A batch Cloudflare
    /// refuses is halved and posted again; a single event it refuses is removed and announced.
    /// Every answer paces the next post by the events it carried, refused ones included.
    async fn deliver(
        &mut self,
        session: &Session,
        events: &[Event],
        mut count: usize,
    ) -> Result<(), Stop> {
        loop {
            let batch = &events[..count];
            match self.send(report(&self.database, batch)).await? {
                Sent::Stored => {
                    let seqs: Vec<i64> = batch.iter().map(|event| event.seq).collect();
                    remove(session, &seqs).await?;
                    self.pace_after(count);
                    return Ok(());
                }
                Sent::Refused(_) if count > 1 => {
                    self.pace_after(count);
                    count /= 2;
                }
                Sent::Refused(class) => {
                    remove(session, &[events[0].seq]).await?;
                    self.pace_after(1);
                    let status = class.strip_prefix("http_").unwrap_or(&class);
                    self.announce(BTreeMap::from([(format!("api_{status}"), 1)]));
                    return Ok(());
                }
            }
        }
    }

    /// Holds the next post back by the pace of `count` events at the tuned rate.
    fn pace_after(&mut self, count: usize) {
        let rate = self.tuning.rate.load(Ordering::Relaxed);
        self.not_before = Some(Instant::now() + pace(count, rate));
    }

    /// Announces refused rows by class: an event once per `retry_maximum`, a log line otherwise.
    fn announce(&mut self, classes: BTreeMap<String, u64>) {
        let announce = self
            .rejected_at
            .is_none_or(|at| at.elapsed() >= self.settings.retry_maximum);
        for (class, count) in classes {
            let line = json!({
                "event": "data_event_rejected", "database_id": self.database,
                "class": class, "count": count,
            });
            if announce {
                timing::emit_event(line);
            } else {
                timing::log_line(line);
            }
        }
        if announce {
            self.rejected_at = Some(Instant::now());
        }
    }

    /// Posts `body` until Cloudflare stores it or refuses it. A failure waits and posts the same
    /// body again, so every attempt carries the same events.
    async fn send(&mut self, body: Value) -> Result<Sent, Stop> {
        let mut wait = self.settings.retry;
        loop {
            if let Some(deadline) = self.not_before {
                tokio::time::sleep_until(deadline).await;
            }
            match (self.post)(body.clone()).await {
                Ok(()) => {
                    self.refusing = false;
                    return Ok(Sent::Stored);
                }
                Err(SendError::Fenced) => return Err(Stop::Fenced),
                Err(SendError::Rejected(class)) => return Ok(Sent::Refused(class)),
                Err(SendError::Failed(class)) => {
                    let line = json!({
                        "event": "data_events_refused", "database_id": self.database, "class": class,
                    });
                    if self.refusing {
                        timing::log_line(line);
                    } else {
                        timing::emit_event(line);
                    }
                    self.refusing = true;
                    tokio::time::sleep(wait).await;
                    wait = (wait * 2).min(self.settings.retry_maximum);
                }
            }
        }
    }

    /// The wait before a reconnect: the current backoff, which then doubles up to its maximum.
    fn backoff(&mut self) -> Duration {
        let wait = self.wait;
        self.wait = (wait * 2).min(self.settings.retry_maximum);
        wait
    }
}

/// A bound of the contract (`packages/contracts`), as an integer of the generated constants.
fn bound(name: &str) -> u64 {
    constant(name).as_u64().expect("generated bound")
}

/// A bound of the contract, as a size.
fn bound_size(name: &str) -> usize {
    usize::try_from(bound(name)).unwrap_or(usize::MAX)
}

/// Whether `topic` matches the contract's grammar `^[a-z][a-z0-9_]{0,47}$`.
pub fn topic_valid(topic: &str) -> bool {
    let mut bytes = topic.bytes();
    bytes.next().is_some_and(|first| first.is_ascii_lowercase())
        && topic.len() <= 48
        && bytes.all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
}

/// The latest time the contract writes, 9999-12-31T23:59:59.999Z, in milliseconds.
const LATEST_MS: i64 = 253_402_300_799_999;

/// The event of an outbox row, or the reason the drain does not send it. `ceiling` is the
/// largest payload text in bytes. A time outside the contract's range is clamped into it.
pub fn validate(row: &pgcf::Row, ceiling: usize) -> Result<Event, Reject> {
    const SAFE_INTEGER: i64 = 9_007_199_254_740_991;
    if !topic_valid(&row.topic) {
        return Err(Reject::Topic);
    }
    if !(1..=SAFE_INTEGER).contains(&row.seq) || !(1..=SAFE_INTEGER).contains(&row.epoch) {
        return Err(Reject::Seq);
    }
    let Some(text) = row.payload.as_deref() else {
        return Err(Reject::TooLarge);
    };
    if text.len() > ceiling {
        return Err(Reject::TooLarge);
    }
    let payload: Value = serde_json::from_str(text).map_err(|_| Reject::Unparsable)?;
    if !payload.is_object() {
        return Err(Reject::NotObject);
    }
    Ok(Event {
        seq: row.seq,
        epoch: row.epoch,
        at: facts::timestamp(row.at_ms.clamp(0, LATEST_MS)),
        topic: row.topic.clone(),
        payload,
    })
}

/// The bytes of a report without its events, for the contract's 20-character database ID:
/// `{"database":"<id>","events":[]}`.
const FRAME_BYTES: usize = 47;

/// How many leading events of `events` fit one request: at most `max_events`, and a report whose
/// body stays within `max_bytes`. The first event is always taken, so a non-empty slice gives at
/// least one.
pub fn cut(events: &[Event], max_events: usize, max_bytes: usize) -> usize {
    let mut bytes = FRAME_BYTES;
    let mut count = 0;
    for event in events.iter().take(max_events.max(1)) {
        let separator = usize::from(count > 0);
        let size = separator.saturating_add(
            serde_json::to_vec(&event_json(event)).map_or(usize::MAX, |json| json.len()),
        );
        if count > 0 && bytes.saturating_add(size) > max_bytes {
            break;
        }
        bytes = bytes.saturating_add(size);
        count += 1;
    }
    count
}

/// How many leading events of `events` one report takes: the `cut` of the serde measure, shrunk
/// until the contract's own measure of the report holds. It is 0 when the first event alone is
/// refused.
pub fn fit(database: &str, events: &[Event], max_events: usize, max_bytes: usize) -> usize {
    let mut count = cut(events, max_events, max_bytes);
    while count > 0 && !contract_valid("NodeDataEventReport", &report(database, &events[..count])) {
        count /= 2;
    }
    count
}

/// One event of a report, as the contract carries it.
fn event_json(event: &Event) -> Value {
    json!({
        "epoch": event.epoch, "seq": event.seq, "at": event.at,
        "topic": event.topic, "payload": event.payload,
    })
}

/// The `NodeDataEventReport` body of `events` from `database`.
pub fn report(database: &str, events: &[Event]) -> Value {
    let events: Vec<Value> = events.iter().map(event_json).collect();
    json!({"database": database, "events": events})
}

/// The pause after `sent` events at `rate` per second, rounded up to the millisecond. A rate of
/// zero counts as one.
pub fn pace(sent: usize, rate: u32) -> Duration {
    let sent = u64::try_from(sent).unwrap_or(u64::MAX);
    Duration::from_millis(sent.saturating_mul(1000).div_ceil(u64::from(rate.max(1))))
}

/// The rows of one read: a megabyte of payloads at most, and the contract's batch of events.
pub fn batch_rows(max_payload_bytes: u64) -> i64 {
    let rows = (1_000_000 / max_payload_bytes.max(1)).clamp(1, bound("NODE_DATA_EVENT_BATCH_MAX"));
    i64::try_from(rows).unwrap_or(i64::MAX)
}

/// How many leading rows of a read the drain parses: their payload texts stay within `max_bytes`,
/// and the first row is always parsed. A parsed payload takes far more memory than its text, so
/// the rest of a read waits for the next one.
pub fn parse_budget(rows: &[pgcf::Row], max_bytes: usize) -> usize {
    let mut bytes = 0_usize;
    let mut count = 0;
    for row in rows {
        let size = row.payload.as_deref().map_or(0, str::len);
        if count > 0 && bytes.saturating_add(size) > max_bytes {
            break;
        }
        bytes = bytes.saturating_add(size);
        count += 1;
    }
    count
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        events::Capture,
        layout::PORT,
        node_link::schema_valid,
        postgres,
        settings::AGENT_ROLE,
        testpg::{Cluster, password},
    };
    use std::sync::Mutex;

    /// A database ID of the contract's 20 characters.
    const DATABASE: &str = "d0000000000000000001";
    const AT: &str = "1970-01-01T00:00:01.000Z";

    fn event(seq: i64) -> Event {
        Event {
            seq,
            epoch: 1,
            at: AT.into(),
            topic: "orders".into(),
            payload: json!({"id": seq}),
        }
    }
    fn row(seq: i64, topic: &str, payload: &str) -> pgcf::Row {
        pgcf::Row {
            seq,
            epoch: 1,
            topic: topic.into(),
            payload: Some(payload.into()),
            at_ms: 1000,
        }
    }
    fn body_len(events: &[Event]) -> usize {
        serde_json::to_vec(&report(DATABASE, events)).unwrap().len()
    }

    #[test]
    fn the_database_id_of_the_tests_has_the_contracts_length() {
        assert_eq!(DATABASE.len(), 20);
    }

    #[test]
    fn topics_follow_the_contracts_grammar() {
        let long = "a".repeat(48);
        let too_long = "a".repeat(49);
        assert!(topic_valid("orders"));
        assert!(topic_valid(&long));
        assert!(!topic_valid(&too_long));
        let samples = [
            "a", "orders", "a_1", "z9_", &long, &too_long, "A", "1a", "_a", "a-b", "a.b", "",
            "orders\n", "é", "a b",
        ];
        for topic in samples {
            let report = json!({"database": DATABASE, "events": [
                {"epoch": 1, "seq": 1, "at": AT, "topic": topic, "payload": {}}
            ]});
            assert_eq!(
                topic_valid(topic),
                schema_valid("NodeDataEventReport", &report),
                "{topic:?}"
            );
        }
    }

    #[test]
    fn validate_accepts_a_row_and_names_the_class_of_each_row_it_refuses() {
        let ceiling = 40;
        let accepted = validate(&row(1, "orders", r#"{"id": 1}"#), ceiling).unwrap();
        assert_eq!(
            accepted,
            Event {
                seq: 1,
                epoch: 1,
                at: AT.into(),
                topic: "orders".into(),
                payload: json!({"id": 1}),
            }
        );
        let class = |row: pgcf::Row| validate(&row, ceiling).unwrap_err().class();
        assert_eq!(class(row(1, "Orders", "{}")), "topic");
        assert_eq!(class(row(0, "orders", "{}")), "seq");
        assert_eq!(class(row(1, "orders", "[1]")), "not_object");
        assert_eq!(class(row(1, "orders", r#"{"a":"#)), "unparsable");
        let too_big = format!(r#"{{"a":"{}"}}"#, "x".repeat(ceiling));
        assert_eq!(class(row(1, "orders", &too_big)), "too_large");
        let exact = format!(r#"{{"a":"{}"}}"#, "x".repeat(ceiling - 8));
        assert!(validate(&row(1, "orders", &exact), ceiling).is_ok());
    }

    #[test]
    fn validate_refuses_the_sequence_and_epoch_outside_the_safe_integers() {
        const SAFE: i64 = 9_007_199_254_740_991;
        let class = |seq: i64, epoch: i64| {
            validate(
                &pgcf::Row {
                    epoch,
                    ..row(seq, "orders", "{}")
                },
                40,
            )
            .map(|_| ())
            .map_err(|reject| reject.class())
        };
        assert_eq!(class(1, 0), Err("seq"));
        assert_eq!(class(1, SAFE + 1), Err("seq"));
        assert_eq!(class(SAFE + 1, 1), Err("seq"));
        assert_eq!(class(SAFE, SAFE), Ok(()));
        assert_eq!(class(1, 1), Ok(()));
    }

    #[test]
    fn validate_clamps_a_time_outside_the_contract_into_its_range() {
        let at = |at_ms: i64| {
            validate(
                &pgcf::Row {
                    at_ms,
                    ..row(1, "orders", "{}")
                },
                40,
            )
            .unwrap()
            .at
        };
        assert_eq!(at(1000), AT);
        assert_eq!(at(-62_167_219_200_000), "1970-01-01T00:00:00.000Z");
        assert_eq!(at(i64::MIN), "1970-01-01T00:00:00.000Z");
        assert_eq!(at(i64::MAX), "9999-12-31T23:59:59.999Z");
    }

    /// A payload of `count` integers of 21 digits. A double reads each as `1e20`, which
    /// `serde_json` writes in four bytes, while `JSON.stringify` writes all 21 digits.
    fn wide_payload(count: usize) -> String {
        format!(
            r#"{{"n": [{}]}}"#,
            vec!["100000000000000000000"; count].join(", ")
        )
    }

    #[test]
    fn fit_posts_only_what_the_contract_takes_in_one_report() {
        let ceiling = bound_size("NODE_DATA_EVENT_PAYLOAD_MAX_BYTES");
        let max_events = bound_size("NODE_DATA_EVENT_BATCH_MAX");
        let max_bytes = bound_size("NODE_DATA_EVENT_BODY_MAX_BYTES");
        let text = wide_payload(4_500);
        let events: Vec<Event> = (1..=100)
            .map(|seq| validate(&row(seq, "orders", &text), ceiling).unwrap())
            .collect();
        let sized = cut(&events, max_events, max_bytes);
        assert!(
            !contract_valid("NodeDataEventReport", &report(DATABASE, &events[..sized])),
            "the cut of the serde measure is refused by the contract"
        );
        let posted = fit(DATABASE, &events, max_events, max_bytes);
        assert!(posted >= 1 && posted < sized, "{posted} of {sized}");
        assert!(contract_valid(
            "NodeDataEventReport",
            &report(DATABASE, &events[..posted])
        ));
    }

    #[test]
    fn fit_is_zero_for_an_event_the_contract_refuses_alone() {
        let wide = Event {
            payload: json!({"n": vec![1e20_f64; 12_000]}),
            ..event(1)
        };
        assert_eq!(fit(DATABASE, &[wide], 100, 1_048_576), 0);
        assert_eq!(fit(DATABASE, &[event(1)], 100, 1_048_576), 1);
    }

    #[test]
    fn cut_takes_the_longest_leading_run_within_both_bounds() {
        let events: Vec<Event> = (1..=5)
            .map(|seq| Event {
                payload: json!({"text": "x".repeat(10)}),
                ..event(seq)
            })
            .collect();
        assert_eq!(cut(&[], 10, 1000), 0);
        assert_eq!(cut(&events, 2, usize::MAX), 2);
        assert_eq!(cut(&events, 100, usize::MAX), 5);
        assert_eq!(cut(&events, 100, 1), 1, "the first event is always taken");
        for n in 1..=5 {
            let fits = body_len(&events[..n]);
            assert_eq!(cut(&events, 100, fits), n, "{n} events in {fits} bytes");
            assert_eq!(cut(&events, 100, fits - 1), (n - 1).max(1), "{n} events");
        }
    }

    #[test]
    fn pace_rounds_up_and_counts_a_rate_of_zero_as_one() {
        assert_eq!(pace(3, 10), Duration::from_millis(300));
        assert_eq!(pace(1, 3), Duration::from_millis(334));
        assert_eq!(pace(0, 20), Duration::ZERO);
        assert_eq!(pace(5, 0), Duration::from_millis(5000));
    }

    #[test]
    fn batch_rows_fit_a_megabyte_and_the_contracts_batch() {
        assert_eq!(batch_rows(16_384), 61);
        assert_eq!(batch_rows(1), 100);
        assert_eq!(batch_rows(0), 100);
        assert_eq!(batch_rows(1_000_000_000), 1);
    }

    #[test]
    fn a_read_parses_only_the_rows_whose_text_fits_the_body_bound() {
        let text = "x".repeat(250_000);
        let rows: Vec<pgcf::Row> = (1..=61).map(|seq| row(seq, "orders", &text)).collect();
        assert_eq!(parse_budget(&rows, 1_048_576), 4);
        assert_eq!(
            parse_budget(&rows[..1], 1),
            1,
            "the first row is always parsed"
        );
        assert_eq!(parse_budget(&rows[..0], 1_048_576), 0);
    }

    #[test]
    fn backoff_doubles_up_to_the_retry_maximum() {
        let mut drain = Drain {
            socket_directory: PathBuf::new(),
            database: DATABASE.into(),
            post: post(&Arc::new(Recorder::default())),
            tuning: tuning(),
            settings: Settings {
                poll: Duration::from_secs(60),
                gap: Duration::from_millis(10),
                retry: Duration::from_millis(10),
                retry_maximum: Duration::from_millis(40),
            },
            state: idle(),
            not_before: None,
            rejected_at: None,
            refusing: false,
            wait: Duration::from_millis(10),
        };
        let waits: Vec<Duration> = (0..4).map(|_| drain.backoff()).collect();
        assert_eq!(waits, [10, 20, 40, 40].map(Duration::from_millis));
    }

    #[test]
    fn a_report_is_a_contract_report() {
        let body = report(DATABASE, &[event(7), event(9)]);
        assert_eq!(body["events"][0]["seq"], 7);
        assert_eq!(body["events"][0]["payload"], json!({"id": 7}));
        assert!(contract_valid("NodeDataEventReport", &body));
    }

    const SETTINGS: pgcf::Settings = pgcf::Settings {
        epoch: 1,
        max_payload_bytes: 54_000,
        max_outbox_rows: 1_000,
    };

    /// The timing of a test drain: a 60 s poll, so only a notification or the first cycle runs.
    fn timing_with(retry: Duration) -> Settings {
        Settings {
            poll: Duration::from_secs(60),
            gap: Duration::from_millis(10),
            retry,
            retry_maximum: retry,
        }
    }

    /// A started cluster with the platform schema in `tenant`, owned by the application role `app`.
    async fn tenant_cluster(label: &str) -> Option<Cluster> {
        let cluster = Cluster::create(label)?;
        cluster.start();
        cluster
            .agent()
            .await
            .batch(&format!("CREATE ROLE app LOGIN PASSWORD '{}'", password(1)))
            .await
            .unwrap();
        cluster
            .agent()
            .await
            .batch_long(&format!("CREATE DATABASE \"{DATABASE}\" OWNER app"))
            .await
            .unwrap();
        let session = pgcf::connect(&cluster.socket_directory(), DATABASE, None)
            .await
            .unwrap();
        pgcf::install(&session, &SETTINGS, false).await.unwrap();
        Some(cluster)
    }

    /// A session as the tenant's application role, which may emit.
    async fn app(cluster: &Cluster) -> tokio_postgres::Client {
        let mut config = tokio_postgres::Config::new();
        config
            .host_path(cluster.socket_directory())
            .port(PORT)
            .user("app")
            .password(password(1))
            .dbname(DATABASE);
        let (client, connection) = config.connect(tokio_postgres::NoTls).await.unwrap();
        tokio::spawn(connection);
        client
    }
    /// A session as the cluster's superuser on the tenant database.
    async fn superuser(cluster: &Cluster) -> Session {
        postgres::connect(&cluster.socket_directory(), AGENT_ROLE, DATABASE)
            .await
            .unwrap()
    }
    async fn outbox_rows(cluster: &Cluster) -> i64 {
        let session = superuser(cluster).await;
        let rows = session
            .query("SELECT count(*) FROM pgcf.outbox", &[])
            .await
            .unwrap();
        rows[0].get(0)
    }
    /// How many reads of the outbox the cluster's log holds, with `log_statement = 'all'`.
    fn outbox_reads(cluster: &Cluster) -> usize {
        cluster
            .log()
            .matches("FROM ONLY pgcf.outbox ORDER BY seq")
            .count()
    }

    /// The posts a drain made in a test: each attempt's body and when it was made. The first
    /// `failures` attempts answer a failure, and `fenced` makes every attempt answer `Fenced`. A
    /// body with an event of the `poison` topic is refused with a 400.
    #[derive(Default)]
    struct Recorder {
        attempts: Mutex<Vec<(Instant, Value)>>,
        failures: AtomicU32,
        fenced: AtomicBool,
        poison: Option<&'static str>,
    }
    impl Recorder {
        fn count(&self) -> usize {
            self.attempts.lock().unwrap().len()
        }
        fn seqs(&self) -> Vec<Vec<i64>> {
            self.attempts
                .lock()
                .unwrap()
                .iter()
                .map(|(_, body)| {
                    body["events"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|event| event["seq"].as_i64().unwrap())
                        .collect()
                })
                .collect()
        }
        fn times(&self) -> Vec<Instant> {
            self.attempts
                .lock()
                .unwrap()
                .iter()
                .map(|(at, _)| *at)
                .collect()
        }
        fn answer(&self, body: Value) -> Result<(), SendError> {
            let poisoned = self.poison.is_some_and(|topic| {
                body["events"]
                    .as_array()
                    .is_some_and(|events| events.iter().any(|event| event["topic"] == topic))
            });
            self.attempts.lock().unwrap().push((Instant::now(), body));
            if self.fenced.load(Ordering::SeqCst) {
                return Err(SendError::Fenced);
            }
            if poisoned {
                return Err(refused(400));
            }
            let failing = self
                .failures
                .try_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_sub(1));
            if failing.is_ok() {
                return Err(SendError::Failed("http_503".into()));
            }
            Ok(())
        }
    }
    fn post(recorder: &Arc<Recorder>) -> Post {
        let recorder = recorder.clone();
        Arc::new(
            move |body: Value| -> Pin<Box<dyn Future<Output = Result<(), SendError>> + Send>> {
                Box::pin(std::future::ready(recorder.answer(body)))
            },
        )
    }
    fn tuning() -> Arc<Tuning> {
        Arc::new(Tuning {
            rate: AtomicU32::new(20),
            max_payload_bytes: AtomicU64::new(16_384),
        })
    }
    fn idle() -> Arc<State> {
        Arc::new(State {
            pending: AtomicBool::new(false),
        })
    }
    /// Spawns a drain of the tenant, and returns it with the events its log lines emitted.
    fn spawn(
        cluster: &Cluster,
        post: Post,
        tuning: Arc<Tuning>,
        state: Arc<State>,
        settings: Settings,
    ) -> (tokio::task::JoinHandle<()>, Capture) {
        let capture = Capture::default();
        let scoped = capture.clone();
        let socket_directory = cluster.socket_directory();
        let task = tokio::spawn(async move {
            scoped
                .scope(run(
                    socket_directory,
                    DATABASE.into(),
                    post,
                    tuning,
                    settings,
                    state,
                ))
                .await;
        });
        (task, capture)
    }
    /// The events of `capture` with the name `event`.
    fn named(capture: &Capture, event: &str) -> Vec<Value> {
        capture
            .seen()
            .into_iter()
            .filter(|line| line["event"] == event)
            .collect()
    }
    /// Waits until `condition` holds, for at most `limit`.
    async fn within(limit: Duration, mut condition: impl FnMut() -> bool) {
        tokio::time::timeout(limit, async {
            while !condition() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("the condition held in time");
    }

    #[tokio::test]
    async fn a_batch_is_deleted_only_after_the_post_answered() {
        let Some(cluster) = tenant_cluster("drain-retry").await else {
            return;
        };
        let app = app(&cluster).await;
        app.batch_execute("SELECT pgcf.emit('orders', '{}'); SELECT pgcf.emit('orders', '{}')")
            .await
            .unwrap();
        let recorder = Arc::new(Recorder::default());
        recorder.failures.store(2, Ordering::SeqCst);
        let (task, _) = spawn(
            &cluster,
            post(&recorder),
            tuning(),
            idle(),
            timing_with(Duration::from_millis(300)),
        );
        within(Duration::from_secs(5), || recorder.count() >= 1).await;
        assert_eq!(
            outbox_rows(&cluster).await,
            2,
            "a failed post removes nothing"
        );
        within(Duration::from_secs(5), || recorder.count() >= 2).await;
        assert_eq!(
            outbox_rows(&cluster).await,
            2,
            "the retry still has the rows"
        );
        within(Duration::from_secs(5), || recorder.count() >= 3).await;
        assert_eq!(recorder.seqs(), vec![vec![1, 2]; 3]);
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(outbox_rows(&cluster).await, 0);
        assert_eq!(recorder.count(), 3, "nothing is posted twice after success");
        task.abort();
    }

    #[tokio::test]
    async fn a_commit_wakes_the_drain_within_a_second_with_a_60_second_poll() {
        let Some(cluster) = tenant_cluster("drain-wake").await else {
            return;
        };
        let recorder = Arc::new(Recorder::default());
        let (task, _) = spawn(
            &cluster,
            post(&recorder),
            tuning(),
            idle(),
            timing_with(Duration::from_millis(20)),
        );
        tokio::time::sleep(Duration::from_millis(200)).await;
        app(&cluster)
            .await
            .batch_execute("SELECT pgcf.emit('orders', '{}')")
            .await
            .unwrap();
        within(Duration::from_secs(1), || recorder.count() >= 1).await;
        assert_eq!(recorder.seqs(), vec![vec![1]]);
        task.abort();
    }

    #[tokio::test]
    async fn a_rolled_back_event_is_never_delivered() {
        let Some(cluster) = tenant_cluster("drain-rollback").await else {
            return;
        };
        app(&cluster)
            .await
            .batch_execute("BEGIN; SELECT pgcf.emit('orders', '{}'); ROLLBACK")
            .await
            .unwrap();
        let recorder = Arc::new(Recorder::default());
        let (task, _) = spawn(
            &cluster,
            post(&recorder),
            tuning(),
            idle(),
            timing_with(Duration::from_millis(20)),
        );
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(recorder.count(), 0);
        app(&cluster)
            .await
            .batch_execute("SELECT pgcf.emit('orders', '{}')")
            .await
            .unwrap();
        within(Duration::from_secs(5), || recorder.count() >= 1).await;
        assert_eq!(recorder.seqs(), vec![vec![2]]);
        task.abort();
    }

    #[tokio::test]
    async fn rows_that_commit_out_of_seq_order_are_deleted_by_their_own_seqs() {
        let Some(cluster) = tenant_cluster("drain-order").await else {
            return;
        };
        let slow = app(&cluster).await;
        let fast = app(&cluster).await;
        slow.batch_execute("BEGIN; SELECT pgcf.emit('orders', '{}')")
            .await
            .unwrap();
        fast.batch_execute("SELECT pgcf.emit('orders', '{}')")
            .await
            .unwrap();
        let recorder = Arc::new(Recorder::default());
        let (task, _) = spawn(
            &cluster,
            post(&recorder),
            tuning(),
            idle(),
            timing_with(Duration::from_millis(20)),
        );
        within(Duration::from_secs(5), || recorder.count() >= 1).await;
        assert_eq!(recorder.seqs(), vec![vec![2]]);
        slow.batch_execute("COMMIT").await.unwrap();
        within(Duration::from_secs(5), || recorder.count() >= 2).await;
        assert_eq!(recorder.seqs(), vec![vec![2], vec![1]]);
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(outbox_rows(&cluster).await, 0);
        task.abort();
    }

    #[tokio::test]
    async fn an_oversize_row_inserted_by_the_superuser_is_deleted_and_does_not_block_later_rows() {
        let Some(cluster) = tenant_cluster("drain-oversize").await else {
            return;
        };
        let oversize = format!(r#"{{"text": "{}"}}"#, "x".repeat(20 * 1024 * 1024));
        let owner = superuser(&cluster).await;
        // The schema's size CHECK refuses this row, so it is lifted: the drain must refuse a row
        // of any size on its own, even when a CHECK is gone or bypassed.
        owner
            .batch(
                "DO $$ DECLARE size_check pg_catalog.name; BEGIN \
                 SELECT conname INTO STRICT size_check FROM pg_catalog.pg_constraint \
                 WHERE conrelid = 'pgcf.outbox'::regclass \
                 AND pg_catalog.pg_get_constraintdef(oid) LIKE '%octet_length%'; \
                 EXECUTE pg_catalog.format('ALTER TABLE pgcf.outbox DROP CONSTRAINT %I', size_check); \
                 END $$",
            )
            .await
            .unwrap();
        owner
            .query(
                "INSERT INTO pgcf.outbox (epoch, topic, payload) VALUES (1, 'orders', $1::pg_catalog.text::pg_catalog.jsonb)",
                &[&oversize],
            )
            .await
            .unwrap();
        app(&cluster)
            .await
            .batch_execute("SELECT pgcf.emit('orders', '{}')")
            .await
            .unwrap();
        let recorder = Arc::new(Recorder::default());
        let (task, capture) = spawn(
            &cluster,
            post(&recorder),
            tuning(),
            idle(),
            timing_with(Duration::from_millis(20)),
        );
        within(Duration::from_secs(5), || recorder.count() >= 1).await;
        assert_eq!(recorder.seqs(), vec![vec![2]]);
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(outbox_rows(&cluster).await, 0);
        let rejected = named(&capture, "data_event_rejected");
        assert_eq!(rejected.len(), 1);
        assert_eq!(
            rejected[0]["fields"],
            json!({"class": "too_large", "count": 1})
        );
        let lines = serde_json::to_string(&capture.seen()).unwrap();
        assert!(
            !lines.contains("orders") && !lines.contains("xxxx"),
            "an event names neither the topic nor the payload: {lines}"
        );
        task.abort();
    }

    #[tokio::test]
    async fn a_failed_post_waits_a_doubling_backoff_up_to_the_retry_maximum() {
        let Some(cluster) = tenant_cluster("drain-backoff").await else {
            return;
        };
        app(&cluster)
            .await
            .batch_execute("SELECT pgcf.emit('orders', '{}')")
            .await
            .unwrap();
        let recorder = Arc::new(Recorder::default());
        recorder.failures.store(4, Ordering::SeqCst);
        let (task, _) = spawn(
            &cluster,
            post(&recorder),
            tuning(),
            idle(),
            Settings {
                poll: Duration::from_secs(60),
                gap: Duration::from_millis(10),
                retry: Duration::from_millis(40),
                retry_maximum: Duration::from_millis(160),
            },
        );
        within(Duration::from_secs(5), || recorder.count() >= 5).await;
        let times = recorder.times();
        let waits: Vec<Duration> = times.windows(2).map(|pair| pair[1] - pair[0]).collect();
        // Each failure waits twice as long as the one before, and the wait stops at the maximum.
        // Every gap is bounded by its own expected wait, so a backoff that starts at the maximum
        // or doubles past it fails.
        for (wait, expected) in waits.iter().zip([40, 80, 160, 160]) {
            let expected = Duration::from_millis(expected);
            assert!(*wait >= expected, "{wait:?} below {expected:?}");
            assert!(
                *wait < expected + Duration::from_millis(50),
                "{wait:?} above {expected:?} plus slack"
            );
        }
        task.abort();
    }

    #[tokio::test]
    async fn a_refusal_is_an_event_once_per_episode_and_its_repeats_are_log_lines() {
        let Some(cluster) = tenant_cluster("drain-episode").await else {
            return;
        };
        let app = app(&cluster).await;
        app.batch_execute("SELECT pgcf.emit('orders', '{}')")
            .await
            .unwrap();
        let recorder = Arc::new(Recorder::default());
        recorder.failures.store(5, Ordering::SeqCst);
        let (task, capture) = spawn(
            &cluster,
            post(&recorder),
            tuning(),
            idle(),
            timing_with(Duration::from_millis(20)),
        );
        within(Duration::from_secs(5), || recorder.count() >= 6).await;
        assert_eq!(named(&capture, "data_events_refused").len(), 1);
        recorder.failures.store(1, Ordering::SeqCst);
        app.batch_execute("SELECT pgcf.emit('orders', '{}')")
            .await
            .unwrap();
        within(Duration::from_secs(5), || recorder.count() >= 8).await;
        let refused = named(&capture, "data_events_refused");
        assert_eq!(refused.len(), 2, "a success ends the episode");
        assert!(
            refused
                .iter()
                .all(|line| line["fields"]["class"] == "http_503")
        );
        task.abort();
    }

    #[tokio::test]
    async fn a_rejected_row_is_announced_once_per_retry_maximum() {
        let Some(cluster) = tenant_cluster("drain-rejects").await else {
            return;
        };
        let app = app(&cluster).await;
        let recorder = Arc::new(Recorder::default());
        let (task, capture) = spawn(
            &cluster,
            post(&recorder),
            tuning(),
            idle(),
            Settings {
                poll: Duration::from_secs(60),
                gap: Duration::from_millis(10),
                retry: Duration::from_millis(20),
                retry_maximum: Duration::from_secs(60),
            },
        );
        for _ in 0..5 {
            // A number JSON cannot hold: the row is stored and the drain refuses it.
            app.batch_execute("SELECT pgcf.emit('orders', '{\"a\": 1e400}')")
                .await
                .unwrap();
            tokio::time::timeout(Duration::from_secs(5), async {
                while outbox_rows(&cluster).await > 0 {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .expect("the refused row left the outbox");
        }
        assert_eq!(recorder.count(), 0, "a refused row is never posted");
        let rejected = named(&capture, "data_event_rejected");
        assert_eq!(rejected.len(), 1, "the repeats are log lines, not events");
        assert_eq!(
            rejected[0]["fields"],
            json!({"class": "unparsable", "count": 1})
        );
        task.abort();
    }

    #[tokio::test]
    async fn a_batch_the_post_cannot_hold_is_split_and_only_its_posted_events_are_deleted() {
        let Some(cluster) = tenant_cluster("drain-split").await else {
            return;
        };
        app(&cluster)
            .await
            .batch_execute(
                "SELECT pgcf.emit('orders', jsonb_build_object('t', repeat('x', 12000))) FROM generate_series(1, 100)",
            )
            .await
            .unwrap();
        let recorder = Arc::new(Recorder::default());
        let tuning = tuning();
        tuning.max_payload_bytes.store(10_000, Ordering::SeqCst);
        tuning.rate.store(1000, Ordering::SeqCst);
        let (task, _) = spawn(
            &cluster,
            post(&recorder),
            tuning,
            idle(),
            timing_with(Duration::from_millis(20)),
        );
        within(Duration::from_secs(5), || recorder.count() >= 2).await;
        let posted = recorder.seqs();
        assert!(posted[0].len() < 100, "the first request holds a part");
        assert!(
            recorder.attempts.lock().unwrap()[0].1.to_string().len() <= 1_048_576,
            "the request stays within the body bound"
        );
        assert_eq!(posted.concat(), (1..=100).collect::<Vec<i64>>());
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(outbox_rows(&cluster).await, 0);
        task.abort();
    }

    #[tokio::test]
    async fn two_cycles_never_start_closer_than_the_gap() {
        let Some(cluster) = tenant_cluster("drain-gap").await else {
            return;
        };
        let app = app(&cluster).await;
        app.batch_execute("SELECT pgcf.emit('orders', '{}')")
            .await
            .unwrap();
        let recorder = Arc::new(Recorder::default());
        let tuning = tuning();
        tuning.rate.store(1000, Ordering::SeqCst);
        let state = idle();
        let (task, _) = spawn(
            &cluster,
            post(&recorder),
            tuning,
            state.clone(),
            Settings {
                poll: Duration::from_secs(60),
                gap: Duration::from_millis(300),
                retry: Duration::from_millis(20),
                retry_maximum: Duration::from_millis(20),
            },
        );
        // The first cycle ends when its read finds the outbox empty; a row emitted before that
        // is part of the same cycle, so the second row waits for the end of the first.
        within(Duration::from_secs(5), || {
            recorder.count() >= 1 && !state.pending.load(Ordering::SeqCst)
        })
        .await;
        app.batch_execute("SELECT pgcf.emit('orders', '{}')")
            .await
            .unwrap();
        within(Duration::from_secs(5), || recorder.count() >= 2).await;
        let times = recorder.times();
        // The notification arrives at once, but the second cycle starts `gap` after the first.
        assert!(
            times[1] - times[0] >= Duration::from_millis(250),
            "the cycles were {:?} apart",
            times[1] - times[0]
        );
        task.abort();
    }

    #[tokio::test]
    async fn a_notify_storm_cannot_start_cycles_closer_than_the_gap() {
        let Some(cluster) = tenant_cluster("drain-storm").await else {
            return;
        };
        superuser(&cluster)
            .await
            .batch("ALTER SYSTEM SET log_statement = 'all'")
            .await
            .unwrap();
        superuser(&cluster)
            .await
            .batch("SELECT pg_catalog.pg_reload_conf()")
            .await
            .unwrap();
        let recorder = Arc::new(Recorder::default());
        let (task, _) = spawn(
            &cluster,
            post(&recorder),
            tuning(),
            idle(),
            Settings {
                poll: Duration::from_secs(60),
                gap: Duration::from_millis(200),
                retry: Duration::from_millis(20),
                retry_maximum: Duration::from_millis(20),
            },
        );
        tokio::time::sleep(Duration::from_millis(500)).await;
        let before = outbox_reads(&cluster);
        let app = app(&cluster).await;
        let storm_end = Instant::now() + Duration::from_secs(1);
        while Instant::now() < storm_end {
            app.batch_execute("NOTIFY pgcf_outbox").await.unwrap();
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
        let reads = outbox_reads(&cluster) - before;
        // A window of 1.3 s holds at most one cycle per 200 ms, plus the cycle at its edge.
        let bound = 1 + 1300 / 200 + 1;
        assert!(
            reads <= bound,
            "{reads} reads of the outbox, at most {bound}"
        );
        task.abort();
    }

    #[tokio::test]
    async fn a_drain_whose_session_is_ended_reconnects_and_delivers_the_same_seqs_again() {
        let Some(cluster) = tenant_cluster("drain-terminate").await else {
            return;
        };
        app(&cluster)
            .await
            .batch_execute("SELECT pgcf.emit('orders', '{}')")
            .await
            .unwrap();
        let recorder = Arc::new(Recorder::default());
        recorder.failures.store(1, Ordering::SeqCst);
        let (task, _) = spawn(
            &cluster,
            post(&recorder),
            tuning(),
            idle(),
            timing_with(Duration::from_millis(500)),
        );
        within(Duration::from_secs(5), || recorder.count() >= 1).await;
        superuser(&cluster)
            .await
            .batch(
                "SELECT pg_catalog.pg_terminate_backend(pid) FROM pg_catalog.pg_stat_activity WHERE application_name = 'pgcf-agent-events'",
            )
            .await
            .unwrap();
        within(Duration::from_secs(5), || recorder.count() >= 3).await;
        assert_eq!(recorder.seqs(), vec![vec![1]; 3]);
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(outbox_rows(&cluster).await, 0);
        task.abort();
    }

    #[tokio::test]
    async fn a_fenced_answer_ends_the_drain() {
        let Some(cluster) = tenant_cluster("drain-fenced").await else {
            return;
        };
        app(&cluster)
            .await
            .batch_execute("SELECT pgcf.emit('orders', '{}')")
            .await
            .unwrap();
        let recorder = Arc::new(Recorder::default());
        recorder.fenced.store(true, Ordering::SeqCst);
        let (task, _) = spawn(
            &cluster,
            post(&recorder),
            tuning(),
            idle(),
            timing_with(Duration::from_millis(20)),
        );
        tokio::time::timeout(Duration::from_secs(5), task)
            .await
            .expect("the drain ended")
            .unwrap();
        assert_eq!(recorder.count(), 1);
        assert_eq!(outbox_rows(&cluster).await, 1, "a fenced row stays");
    }

    #[tokio::test]
    async fn two_batches_are_separated_by_the_pace_of_the_first() {
        let Some(cluster) = tenant_cluster("drain-pace").await else {
            return;
        };
        let app = app(&cluster).await;
        app.batch_execute(
            "SELECT pgcf.emit('orders', '{}'); SELECT pgcf.emit('orders', '{}'); SELECT pgcf.emit('orders', '{}')",
        )
        .await
        .unwrap();
        let recorder = Arc::new(Recorder::default());
        let tuning = tuning();
        tuning.rate.store(10, Ordering::SeqCst);
        let (task, _) = spawn(
            &cluster,
            post(&recorder),
            tuning,
            idle(),
            timing_with(Duration::from_millis(20)),
        );
        within(Duration::from_secs(5), || recorder.count() >= 1).await;
        app.batch_execute("SELECT pgcf.emit('orders', '{}')")
            .await
            .unwrap();
        within(Duration::from_secs(5), || recorder.count() >= 2).await;
        assert_eq!(recorder.seqs(), vec![vec![1, 2, 3], vec![4]]);
        let times = recorder.times();
        assert!(
            times[1] - times[0] >= Duration::from_millis(300),
            "the second batch waited for the pace of three events at ten a second"
        );
        task.abort();
    }

    #[tokio::test]
    async fn refused_attempts_are_paced_like_posted_ones() {
        let Some(cluster) = tenant_cluster("drain-refused-pace").await else {
            return;
        };
        app(&cluster)
            .await
            .batch_execute(
                "SELECT pgcf.emit('orders', '{}'); SELECT pgcf.emit('orders', '{}'); \
                 SELECT pgcf.emit('poison', '{}'); SELECT pgcf.emit('orders', '{}'); \
                 SELECT pgcf.emit('orders', '{}')",
            )
            .await
            .unwrap();
        let recorder = Arc::new(Recorder {
            poison: Some("poison"),
            ..Recorder::default()
        });
        let tuning = tuning();
        tuning.rate.store(20, Ordering::SeqCst);
        let (task, _) = spawn(
            &cluster,
            post(&recorder),
            tuning,
            idle(),
            timing_with(Duration::from_millis(20)),
        );
        within(Duration::from_secs(5), || recorder.count() >= 5).await;
        let seqs = recorder.seqs();
        assert_eq!(
            seqs,
            vec![
                vec![1, 2, 3, 4, 5],
                vec![1, 2],
                vec![3, 4, 5],
                vec![3],
                vec![4, 5]
            ]
        );
        let times = recorder.times();
        for (index, pair) in times.windows(2).enumerate() {
            let previous = seqs[index].len();
            assert!(
                pair[1] - pair[0] >= pace(previous, 20),
                "attempt {} waited for the pace of its {previous} events at twenty a second",
                index + 1
            );
        }
        task.abort();
    }

    #[tokio::test]
    async fn state_is_pending_while_rows_remain_and_clear_after_they_leave() {
        let Some(cluster) = tenant_cluster("drain-pending").await else {
            return;
        };
        app(&cluster)
            .await
            .batch_execute("SELECT pgcf.emit('orders', '{}')")
            .await
            .unwrap();
        let recorder = Arc::new(Recorder::default());
        recorder.failures.store(1, Ordering::SeqCst);
        let state = idle();
        let (task, _) = spawn(
            &cluster,
            post(&recorder),
            tuning(),
            state.clone(),
            timing_with(Duration::from_millis(500)),
        );
        within(Duration::from_secs(5), || recorder.count() >= 1).await;
        assert!(
            state.pending.load(Ordering::SeqCst),
            "the row is still there"
        );
        within(Duration::from_secs(5), || recorder.count() >= 2).await;
        within(Duration::from_secs(5), || {
            !state.pending.load(Ordering::SeqCst)
        })
        .await;
        task.abort();
    }

    #[tokio::test]
    async fn a_delete_that_removes_fewer_rows_than_asked_ends_the_session_and_paces_the_retries() {
        let Some(cluster) = tenant_cluster("drain-noop-delete").await else {
            return;
        };
        superuser(&cluster)
            .await
            .batch_long(
                "CREATE FUNCTION pgcf.keep() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$; \
                 CREATE TRIGGER keep BEFORE DELETE ON pgcf.outbox FOR EACH ROW EXECUTE FUNCTION pgcf.keep()",
            )
            .await
            .unwrap();
        app(&cluster)
            .await
            .batch_execute("SELECT pgcf.emit('orders', '{}')")
            .await
            .unwrap();
        superuser(&cluster)
            .await
            .batch("INSERT INTO pgcf.outbox (epoch, topic, payload) VALUES (1, 'orders', '{\"a\": 1e400}')")
            .await
            .unwrap();
        superuser(&cluster)
            .await
            .batch("ALTER SYSTEM SET log_statement = 'all'")
            .await
            .unwrap();
        superuser(&cluster)
            .await
            .batch("SELECT pg_catalog.pg_reload_conf()")
            .await
            .unwrap();
        let recorder = Arc::new(Recorder::default());
        let (task, _) = spawn(
            &cluster,
            post(&recorder),
            tuning(),
            idle(),
            Settings {
                poll: Duration::from_secs(60),
                gap: Duration::from_millis(10),
                retry: Duration::from_millis(50),
                retry_maximum: Duration::from_millis(200),
            },
        );
        tokio::time::sleep(Duration::from_millis(1500)).await;
        let reads = outbox_reads(&cluster);
        // The rows stay, so each session reads them again after a backoff of at most 200 ms.
        assert!(
            (2..=20).contains(&reads),
            "{reads} reads of the outbox in 1.5 s"
        );
        assert!(recorder.count() <= 20, "{} posts", recorder.count());
        superuser(&cluster)
            .await
            .batch("DROP TRIGGER keep ON pgcf.outbox")
            .await
            .unwrap();
        within(Duration::from_secs(5), || recorder.count() >= 1).await;
        assert_eq!(
            recorder.seqs(),
            vec![vec![1]],
            "the valid row is posted once"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(outbox_rows(&cluster).await, 0, "both rows are deleted");
        task.abort();
    }

    #[tokio::test]
    async fn a_posted_delete_that_removes_nothing_ends_the_session_and_paces_the_retries() {
        let Some(cluster) = tenant_cluster("drain-noop-posted").await else {
            return;
        };
        superuser(&cluster)
            .await
            .batch_long(
                "CREATE FUNCTION pgcf.keep() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$; \
                 CREATE TRIGGER keep BEFORE DELETE ON pgcf.outbox FOR EACH ROW EXECUTE FUNCTION pgcf.keep()",
            )
            .await
            .unwrap();
        app(&cluster)
            .await
            .batch_execute("SELECT pgcf.emit('orders', '{}')")
            .await
            .unwrap();
        superuser(&cluster)
            .await
            .batch("ALTER SYSTEM SET log_statement = 'all'")
            .await
            .unwrap();
        superuser(&cluster)
            .await
            .batch("SELECT pg_catalog.pg_reload_conf()")
            .await
            .unwrap();
        let recorder = Arc::new(Recorder::default());
        let (task, _) = spawn(
            &cluster,
            post(&recorder),
            tuning(),
            idle(),
            Settings {
                poll: Duration::from_secs(60),
                gap: Duration::from_millis(10),
                retry: Duration::from_millis(50),
                retry_maximum: Duration::from_millis(200),
            },
        );
        tokio::time::sleep(Duration::from_millis(1500)).await;
        let reads = outbox_reads(&cluster);
        // The posted row stays, so each session posts and reads it again after a backoff.
        assert!(
            (2..=20).contains(&reads),
            "{reads} reads of the outbox in 1.5 s"
        );
        assert!(recorder.count() <= 20, "{} posts", recorder.count());
        superuser(&cluster)
            .await
            .batch("DROP TRIGGER keep ON pgcf.outbox")
            .await
            .unwrap();
        // The next session starts after a backoff of up to `retry_maximum`, so the wait is open-ended.
        tokio::time::timeout(Duration::from_secs(5), async {
            while outbox_rows(&cluster).await != 0 {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("the posted row is deleted");
        assert!(
            recorder.seqs().iter().all(|seqs| seqs == &[1]),
            "every post carries the one row"
        );
        task.abort();
    }

    #[tokio::test]
    async fn a_schema_pgcf_that_the_platform_role_does_not_own_is_never_read() {
        let Some(cluster) = Cluster::create("drain-foreign") else {
            return;
        };
        cluster.start();
        cluster
            .agent()
            .await
            .batch(&format!("CREATE ROLE app LOGIN PASSWORD '{}'", password(1)))
            .await
            .unwrap();
        cluster
            .agent()
            .await
            .batch_long("CREATE DATABASE elsewhere OWNER app")
            .await
            .unwrap();
        let foreign = postgres::connect(&cluster.socket_directory(), AGENT_ROLE, "elsewhere")
            .await
            .unwrap();
        foreign
            .batch(
                "CREATE SCHEMA pgcf AUTHORIZATION app; \
                 CREATE TABLE pgcf.outbox (seq bigserial PRIMARY KEY, epoch bigint NOT NULL, topic text NOT NULL, payload jsonb NOT NULL, emitted_at timestamptz NOT NULL DEFAULT now()); \
                 INSERT INTO pgcf.outbox (epoch, topic, payload) VALUES (1, 'orders', '{}')",
            )
            .await
            .unwrap();
        let agent = cluster.agent().await;
        agent
            .batch("ALTER SYSTEM SET log_statement = 'all'")
            .await
            .unwrap();
        agent
            .batch("SELECT pg_catalog.pg_reload_conf()")
            .await
            .unwrap();
        let recorder = Arc::new(Recorder::default());
        let task = tokio::spawn(run(
            cluster.socket_directory(),
            "elsewhere".into(),
            post(&recorder),
            tuning(),
            timing_with(Duration::from_millis(20)),
            idle(),
        ));
        tokio::time::sleep(Duration::from_millis(500)).await;
        assert_eq!(
            outbox_reads(&cluster),
            0,
            "the drain reads no foreign outbox"
        );
        assert_eq!(recorder.count(), 0);
        let rows = foreign
            .query("SELECT count(*) FROM pgcf.outbox", &[])
            .await
            .unwrap();
        assert_eq!(rows[0].get::<_, i64>(0), 1, "the foreign row stays");
        task.abort();
    }

    #[tokio::test]
    async fn an_outbox_a_tenant_owns_is_never_read_under_a_superuser_schema() {
        let Some(cluster) = tenant_cluster("drain-owned").await else {
            return;
        };
        superuser(&cluster)
            .await
            .batch("INSERT INTO pgcf.outbox (epoch, topic, payload) VALUES (1, 'orders', '{}')")
            .await
            .unwrap();
        superuser(&cluster)
            .await
            .batch("ALTER TABLE pgcf.outbox OWNER TO app")
            .await
            .unwrap();
        let recorder = Arc::new(Recorder::default());
        let (task, _) = spawn(
            &cluster,
            post(&recorder),
            tuning(),
            idle(),
            timing_with(Duration::from_millis(20)),
        );
        tokio::time::sleep(Duration::from_millis(500)).await;
        assert_eq!(recorder.count(), 0, "the drain posts no tenant-owned row");
        assert_eq!(outbox_rows(&cluster).await, 1, "the row stays");
        task.abort();
    }

    #[tokio::test]
    async fn infinity_and_a_time_before_1970_are_posted_as_contract_times() {
        let Some(cluster) = tenant_cluster("drain-times").await else {
            return;
        };
        superuser(&cluster)
            .await
            .batch(
                "INSERT INTO pgcf.outbox (epoch, emitted_at, topic, payload) VALUES \
                 (1, 'infinity', 'orders', '{}'), (1, '4712-01-01 00:00:00 BC', 'orders', '{}')",
            )
            .await
            .unwrap();
        app(&cluster)
            .await
            .batch_execute("SELECT pgcf.emit('orders', '{}')")
            .await
            .unwrap();
        let recorder = Arc::new(Recorder::default());
        let (task, _) = spawn(
            &cluster,
            post(&recorder),
            tuning(),
            idle(),
            timing_with(Duration::from_millis(20)),
        );
        within(Duration::from_secs(5), || recorder.count() >= 1).await;
        assert_eq!(recorder.seqs(), vec![vec![1, 2, 3]]);
        let body = recorder.attempts.lock().unwrap()[0].1.clone();
        assert!(contract_valid("NodeDataEventReport", &body), "{body}");
        assert_eq!(body["events"][0]["at"], "9999-12-31T23:59:59.999Z");
        assert_eq!(body["events"][1]["at"], "1970-01-01T00:00:00.000Z");
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(outbox_rows(&cluster).await, 0);
        task.abort();
    }

    #[tokio::test]
    async fn a_time_before_1970_is_posted_as_a_contract_time() {
        let Some(cluster) = tenant_cluster("drain-bc").await else {
            return;
        };
        superuser(&cluster)
            .await
            .query(
                "INSERT INTO pgcf.outbox (epoch, emitted_at, topic, payload) VALUES (1, '4712-01-01 00:00:00 BC', 'orders', '{}')",
                &[],
            )
            .await
            .unwrap();
        let recorder = Arc::new(Recorder::default());
        let (task, _) = spawn(
            &cluster,
            post(&recorder),
            tuning(),
            idle(),
            timing_with(Duration::from_millis(20)),
        );
        within(Duration::from_secs(5), || recorder.count() >= 1).await;
        let body = recorder.attempts.lock().unwrap()[0].1.clone();
        assert!(contract_valid("NodeDataEventReport", &body), "{body}");
        assert_eq!(body["events"][0]["at"], "1970-01-01T00:00:00.000Z");
        task.abort();
    }

    #[tokio::test]
    async fn a_refused_batch_is_halved_until_the_poison_event_stands_alone_and_is_deleted() {
        let Some(cluster) = tenant_cluster("drain-poison").await else {
            return;
        };
        app(&cluster)
            .await
            .batch_execute(
                "SELECT pgcf.emit('orders', '{}'); SELECT pgcf.emit('orders', '{}'); \
                 SELECT pgcf.emit('orders', '{}'); SELECT pgcf.emit('poison', '{}'); \
                 SELECT pgcf.emit('orders', '{}')",
            )
            .await
            .unwrap();
        let recorder = Arc::new(Recorder {
            poison: Some("poison"),
            ..Recorder::default()
        });
        let (task, capture) = spawn(
            &cluster,
            post(&recorder),
            tuning(),
            idle(),
            timing_with(Duration::from_millis(20)),
        );
        within(Duration::from_secs(5), || recorder.count() >= 7).await;
        assert_eq!(recorder.seqs()[0], vec![1, 2, 3, 4, 5]);
        // A body that holds the poison row is never accepted, so every accepted body is clean.
        let accepted: Vec<i64> = recorder
            .seqs()
            .into_iter()
            .filter(|seqs| !seqs.contains(&4))
            .flatten()
            .collect();
        assert_eq!(
            accepted,
            vec![1, 2, 3, 5],
            "the good events are delivered in order"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(outbox_rows(&cluster).await, 0, "the poison row is deleted");
        let rejected = named(&capture, "data_event_rejected");
        assert_eq!(rejected.len(), 1);
        assert_eq!(
            rejected[0]["fields"],
            json!({"class": "api_400", "count": 1})
        );
        task.abort();
    }

    #[tokio::test]
    async fn a_lost_session_clears_pending_before_the_reconnect() {
        let Some(cluster) = tenant_cluster("drain-lost-pending").await else {
            return;
        };
        app(&cluster)
            .await
            .batch_execute("SELECT pgcf.emit('orders', '{}')")
            .await
            .unwrap();
        let recorder = Arc::new(Recorder::default());
        let socket_directory = cluster.socket_directory();
        // The post ends the drain's session, so its delete fails while the row is pending.
        let post: Post = {
            let recorder = recorder.clone();
            Arc::new(
                move |body: Value| -> Pin<Box<dyn Future<Output = Result<(), SendError>> + Send>> {
                    let socket_directory = socket_directory.clone();
                    let recorder = recorder.clone();
                    Box::pin(async move {
                        postgres::connect(&socket_directory, AGENT_ROLE, DATABASE)
                        .await
                        .unwrap()
                        .batch("SELECT pg_catalog.pg_terminate_backend(pid) FROM pg_catalog.pg_stat_activity WHERE application_name = 'pgcf-agent-events'")
                        .await
                        .unwrap();
                        recorder.answer(body)
                    })
                },
            )
        };
        let state = idle();
        let (task, _) = spawn(
            &cluster,
            post,
            tuning(),
            state.clone(),
            Settings {
                poll: Duration::from_secs(60),
                gap: Duration::from_millis(10),
                retry: Duration::from_secs(2),
                retry_maximum: Duration::from_secs(2),
            },
        );
        within(Duration::from_secs(5), || recorder.count() >= 1).await;
        within(Duration::from_secs(1), || {
            !state.pending.load(Ordering::SeqCst)
        })
        .await;
        assert_eq!(
            recorder.count(),
            1,
            "the backoff holds the next session back"
        );
        task.abort();
    }

    #[tokio::test]
    async fn a_schema_installed_after_the_drain_attached_is_drained_on_the_same_session() {
        let Some(cluster) = Cluster::create("drain-late-schema") else {
            return;
        };
        cluster.start();
        cluster
            .agent()
            .await
            .batch(&format!("CREATE ROLE app LOGIN PASSWORD '{}'", password(1)))
            .await
            .unwrap();
        cluster
            .agent()
            .await
            .batch_long(&format!("CREATE DATABASE \"{DATABASE}\" OWNER app"))
            .await
            .unwrap();
        let recorder = Arc::new(Recorder::default());
        let (task, _) = spawn(
            &cluster,
            post(&recorder),
            tuning(),
            idle(),
            Settings {
                poll: Duration::from_millis(100),
                gap: Duration::from_millis(10),
                retry: Duration::from_millis(20),
                retry_maximum: Duration::from_millis(20),
            },
        );
        let attached = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let pids = drain_sessions(&cluster).await;
                if !pids.is_empty() {
                    return pids;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("the drain attached to the database without a schema");
        pgcf::install(&superuser(&cluster).await, &SETTINGS, false)
            .await
            .unwrap();
        app(&cluster)
            .await
            .batch_execute("SELECT pgcf.emit('orders', '{}')")
            .await
            .unwrap();
        within(Duration::from_secs(1), || recorder.count() >= 1).await;
        assert_eq!(recorder.seqs(), vec![vec![1]]);
        assert!(
            drain_sessions(&cluster).await.contains(&attached[0]),
            "the drain drained on the session it attached with"
        );
        task.abort();
    }

    /// The process IDs of the drains' sessions on the tenant database.
    async fn drain_sessions(cluster: &Cluster) -> Vec<i32> {
        let rows = superuser(cluster)
            .await
            .query(
                "SELECT pid FROM pg_catalog.pg_stat_activity WHERE application_name = 'pgcf-agent-events' AND datname = $1",
                &[&DATABASE],
            )
            .await
            .unwrap();
        rows.iter().map(|row| row.get(0)).collect()
    }

    #[test]
    fn refused_is_terminal_only_for_a_status_that_repeats_unchanged() {
        let table = [
            (400, SendError::Rejected("http_400".into())),
            (413, SendError::Rejected("http_413".into())),
            (422, SendError::Rejected("http_422".into())),
            (401, SendError::Failed("http_401".into())),
            (404, SendError::Failed("http_404".into())),
            (429, SendError::Failed("http_429".into())),
            (500, SendError::Failed("http_500".into())),
            (503, SendError::Failed("http_503".into())),
        ];
        for (status, expected) in table {
            assert_eq!(refused(status), expected, "status {status}");
        }
    }
}
