// SPDX-License-Identifier: Apache-2.0
//! What the node reports to Cloudflare over HTTP and keeps until Cloudflare answered it: usage rows
//! and events. Rows are persisted before they are sent and kept unchanged until acknowledged, so
//! that a retried post counts once (the API keeps the row it already holds). The file drops the
//! rows a pass answered once per pass, not per batch: draining a full queue would otherwise
//! rewrite and fsync it hundreds of times on the disk the databases share. Bodies are cut by the
//! arithmetic of `batches`. A metric the node cannot know stays `null` in its row, never a
//! manufactured zero.
use super::{file, request::Api};
use crate::{
    Error,
    api::Refusal,
    node_link::{constant, schema_valid},
};
use serde_json::{Value, json};
use std::{
    collections::{HashSet, VecDeque},
    io::ErrorKind,
    path::PathBuf,
    sync::{Arc, LazyLock, Mutex, MutexGuard, PoisonError},
    time::{Duration, Instant},
};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use tokio::sync::{Mutex as Gate, Notify};

/// Usage rows held while Cloudflare does not answer: about 5 MB, hours of a full node's rows.
const USAGE_MAX_ROWS: usize = 20_000;
/// Events are timing facts; beyond this many unanswered ones the oldest are dropped.
const EVENTS_MAX: usize = 10_000;

/// The rows or events one batch is cut from. `batches` puts at most one cohort in a body and
/// needs to see no more than that.
const BATCH_WINDOW: usize = 100;

/// The bounds of a body: how many records one holds and how many bytes.
static BOUNDS: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!(
        "../../../../packages/contracts/native/measurements.generated.json"
    ))
    .expect("generated measurement contract")
});
fn bound(name: &str) -> usize {
    BOUNDS["constants"][name]
        .as_u64()
        .and_then(|bound| usize::try_from(bound).ok())
        .expect("generated measurement bound")
}
/// `values` cut into bodies of the field `field`, each within the cohort and the byte bound.
fn batches(field: &str, values: Vec<Value>) -> Result<Vec<Vec<Value>>, Error> {
    let (cohort, bytes) = (bound("MEASUREMENT_COHORT"), bound("MEASUREMENT_BODY_BYTES"));
    let mut result = Vec::new();
    let mut current: Vec<Value> = Vec::new();
    for value in values {
        let mut candidate = current.clone();
        candidate.push(value.clone());
        if current.len() == cohort || serde_json::to_vec(&json!({field: candidate}))?.len() > bytes
        {
            if current.is_empty() {
                return Err("record exceeds body bound".into());
            }
            result.push(std::mem::take(&mut current));
        }
        if serde_json::to_vec(&json!({field: [&value]}))?.len() > bytes {
            return Err("record exceeds body bound".into());
        }
        current.push(value);
    }
    if !current.is_empty() {
        result.push(current);
    }
    Ok(result)
}
/// `USAGE_HOUR_MS` of the usage contract.
const HOUR_MS: i128 = 3_600_000;

fn millis(timestamp: &Value) -> Option<i128> {
    let at = OffsetDateTime::parse(timestamp.as_str()?, &Rfc3339).ok()?;
    Some(at.unix_timestamp_nanos() / 1_000_000)
}
/// A usage row (`NodeUsageRow`), with the rules a JSON Schema cannot state: its interval is
/// positive and stays within one UTC hour, and a database is not awake longer than the interval.
/// One invalid row would make Cloudflare refuse the whole batch it sits in.
fn usage_row_valid(row: &Value) -> bool {
    let (Some(start), Some(end)) = (millis(&row["interval_start"]), millis(&row["interval_end"]))
    else {
        return false;
    };
    schema_valid("NodeUsageReport", &json!({"rows": [row]}))
        && end > start
        && start.div_euclid(HOUR_MS) == (end - 1).div_euclid(HOUR_MS)
        && row["awake_ms"]
            .as_i64()
            .is_none_or(|awake| i128::from(awake) <= end - start)
}
/// An event (`NodeEvent`) with the rules a JSON Schema cannot state: exactly a refusal names its
/// reason, and exactly the refusal of awake capacity (`no_headroom`) carries the retry hint.
fn event_valid(event: &Value) -> bool {
    schema_valid("NodeEventReport", &json!({"events": [event]}))
        && match event["type"].as_str() {
            Some("admission") => {
                (event["decision"] == "refused") == event.get("reason").is_some()
                    && (event["reason"] == "no_headroom")
                        == event.get("retry_after_seconds").is_some()
            }
            Some("wake") => (event["outcome"] == "refused") == event.get("reason").is_some(),
            _ => true,
        }
}

/// The usage rows not yet acknowledged, oldest first, and the file that keeps them.
struct UsageQueue {
    path: PathBuf,
    rows: Vec<Value>,
    /// Rows left the queue since the file was written: it still holds rows that were answered.
    unsaved: bool,
}
fn identity(row: &Value) -> (&str, &str, &str) {
    let text = |key: &str| row[key].as_str().unwrap_or_default();
    (
        text("database"),
        text("interval_start"),
        text("interval_end"),
    )
}
impl UsageQueue {
    /// The queue a previous run left. A file that is no valid queue is no loss worth stopping
    /// the agent for: usage is a metric, and the file is replaced by the next write.
    fn load(path: PathBuf) -> Self {
        let rows = match std::fs::read(&path) {
            Ok(bytes) => serde_json::from_slice::<Value>(&bytes)
                .ok()
                .filter(|stored| {
                    stored["v"] == 1 && stored.as_object().is_some_and(|o| o.len() == 2)
                })
                .and_then(|stored| stored["rows"].as_array().cloned())
                .filter(|rows| rows.len() <= USAGE_MAX_ROWS && rows.iter().all(usage_row_valid)),
            Err(error) if error.kind() == ErrorKind::NotFound => Some(vec![]),
            Err(_) => None,
        };
        Self {
            rows: rows.unwrap_or_else(|| {
                super::log("usage_outbox_discarded", &"usage outbox invalid".into());
                vec![]
            }),
            path,
            unsaved: false,
        }
    }
    fn persist(&self, rows: &[Value]) -> Result<(), Error> {
        file::create_private_directory(self.path.parent().ok_or("outbox has no directory")?)?;
        file::write_private(
            &self.path,
            &serde_json::to_vec(&json!({"v":1,"rows":rows}))?,
        )?;
        Ok(())
    }
    /// Takes the rows in, or none of them: each must be a valid row, within the bound. A row of
    /// an interval already queued is the same row again (a restart computes it twice) and is
    /// skipped.
    fn queue(&mut self, rows: &[Value]) -> Result<(), Error> {
        if !rows.iter().all(usage_row_valid) {
            return Err("native usage rows invalid".into());
        }
        let mut seen: HashSet<_> = self.rows.iter().map(identity).collect();
        let fresh: Vec<&Value> = rows
            .iter()
            .filter(|row| seen.insert(identity(row)))
            .collect();
        if self.rows.len() + fresh.len() > USAGE_MAX_ROWS {
            return Err("usage outbox full".into());
        }
        if fresh.is_empty() {
            return Ok(());
        }
        let mut queued = self.rows.clone();
        queued.extend(fresh.into_iter().cloned());
        self.persist(&queued)?;
        self.rows = queued;
        self.unsaved = false;
        Ok(())
    }
    /// The next rows to post: a bounded prefix of the queue.
    fn batch(&self) -> Result<Option<Vec<Value>>, Error> {
        let prefix = self.rows.iter().take(BATCH_WINDOW).cloned().collect();
        Ok(batches("rows", prefix)?.into_iter().next())
    }
    /// Cloudflare answered the first `count` rows, or refused them for good. The file keeps them
    /// until `save`: a restart before it posts them again, and the API ignores a repeat.
    fn done(&mut self, count: usize) {
        self.rows.drain(..count);
        self.unsaved = true;
    }
    /// Writes the queue as it is now, if rows left it since the file was written.
    fn save(&mut self) -> Result<(), Error> {
        if self.unsaved {
            self.persist(&self.rows)?;
            self.unsaved = false;
        }
        Ok(())
    }
}

/// The events not yet acknowledged. A batch is re-posted unchanged for `NODE_EVENT_RETRY_SECONDS`
/// after its first attempt, because Cloudflare remembers the ids of a batch for that long and
/// counts a retried event once; after that it is dropped, and a repeat could count twice.
struct EventQueue {
    waiting: VecDeque<Value>,
    posted: Option<(Vec<Value>, Instant)>,
}
impl EventQueue {
    /// Takes valid events in; beyond the bound the oldest waiting ones go. Returns how many.
    fn queue(&mut self, events: &[Value]) -> Result<usize, Error> {
        if !events.iter().all(event_valid) {
            return Err("native events invalid".into());
        }
        // An event of an id queued before is the same event again.
        let id = |event: &Value| event["id"].as_str().unwrap_or_default().to_string();
        let mut seen: HashSet<String> = self
            .waiting
            .iter()
            .chain(self.posted.iter().flat_map(|(batch, _)| batch))
            .map(id)
            .collect();
        let fresh: Vec<&Value> = events
            .iter()
            .filter(|event| seen.insert(id(event)))
            .collect();
        self.waiting.extend(fresh.into_iter().cloned());
        let excess = self.waiting.len().saturating_sub(EVENTS_MAX);
        self.waiting.drain(..excess);
        Ok(excess)
    }
    /// The batch to post: the one still being retried, or a new one from the waiting events.
    fn batch(&mut self, now: Instant) -> Result<Option<Vec<Value>>, Error> {
        let retry = Duration::from_secs(
            constant("NODE_EVENT_RETRY_SECONDS")
                .as_u64()
                .expect("generated retry window"),
        );
        if let Some((batch, first)) = &self.posted {
            if now.duration_since(*first) < retry {
                return Ok(Some(batch.clone()));
            }
            self.posted = None;
        }
        let prefix = self.waiting.iter().take(BATCH_WINDOW).cloned().collect();
        let Some(batch) = batches("events", prefix)?.into_iter().next() else {
            return Ok(None);
        };
        self.waiting.drain(..batch.len());
        self.posted = Some((batch.clone(), now));
        Ok(Some(batch))
    }
    /// Cloudflare answered the batch, or refused it for good.
    fn done(&mut self) {
        self.posted = None;
    }
}

/// What one flush delivered.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Flushed {
    pub usage_rows: usize,
    pub events: usize,
    /// Rows and events Cloudflare refused as invalid; they are dropped, so that they do not block
    /// what is behind them.
    pub refused: usize,
}

/// The usage rows and events of one node, on their way to Cloudflare. The usage queue is written
/// to its file under its own lock, which the events never wait for.
pub(super) struct Outbox {
    api: Arc<Api>,
    usage: Arc<Mutex<UsageQueue>>,
    events: Mutex<EventQueue>,
    /// One flush at a time, so that the front of a queue is what the answer is for.
    gate: Gate<()>,
    work: Notify,
}
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}
/// A body Cloudflare refuses as it is will be refused again: drop it. Anything else, a fence, a
/// credential, a limit, an outage, is retried.
fn refused(error: &Error) -> bool {
    error
        .downcast_ref::<Refusal>()
        .is_some_and(|refusal| matches!(refusal.status, 400 | 413 | 422))
}
impl Outbox {
    pub fn new(api: Arc<Api>, usage_file: PathBuf) -> Self {
        Self {
            api,
            usage: Arc::new(Mutex::new(UsageQueue::load(usage_file))),
            events: Mutex::new(EventQueue {
                waiting: VecDeque::new(),
                posted: None,
            }),
            gate: Gate::new(()),
            work: Notify::new(),
        }
    }
    /// Persists `rows` (`NodeUsageRow`) to be sent; none of them are taken when this fails.
    pub fn queue_usage(&self, rows: &[Value]) -> Result<(), Error> {
        lock(&self.usage).queue(rows)?;
        self.work.notify_one();
        Ok(())
    }
    /// Queues `events` (`NodeEvent`) to be sent.
    pub fn queue_events(&self, events: &[Value]) -> Result<(), Error> {
        let dropped = lock(&self.events).queue(events)?;
        if dropped > 0 {
            super::log("events_dropped", &"event queue full".into());
        }
        self.work.notify_one();
        Ok(())
    }
    /// Resolves when something was queued since the last time it resolved.
    pub async fn queued(&self) {
        self.work.notified().await;
    }
    /// Posts everything queued, in bounded batches, oldest first. A batch that fails stays and is
    /// the first of the next flush. Both queues are tried; the first failure is returned.
    pub async fn flush(&self) -> Result<Flushed, Error> {
        let _flush = self.gate.lock().await;
        let mut flushed = Flushed::default();
        let usage = self.flush_usage(&mut flushed).await;
        let events = self.flush_events(&mut flushed).await;
        usage.and(events).map(|()| flushed)
    }
    async fn flush_usage(&self, flushed: &mut Flushed) -> Result<(), Error> {
        let posted = self.post_usage(flushed).await;
        // The file is written once for the pass, however it ended, and not on a worker of the
        // runtime: an fsync on the shared disk can take long, and admission and wakes need the
        // workers.
        let saved = self.save_usage().await;
        posted.and(saved)
    }
    async fn post_usage(&self, flushed: &mut Flushed) -> Result<(), Error> {
        loop {
            // The lock is not held while the batch is posted.
            let batch = lock(&self.usage).batch()?;
            let Some(batch) = batch else {
                return Ok(());
            };
            match self
                .api
                .post("/node/v1/usage", &json!({"rows": batch}))
                .await
            {
                Ok(()) => flushed.usage_rows += batch.len(),
                Err(error) if refused(&error) => {
                    flushed.refused += batch.len();
                    super::log("usage_rows_refused", &error);
                }
                Err(error) => return Err(error),
            }
            lock(&self.usage).done(batch.len());
        }
    }
    async fn save_usage(&self) -> Result<(), Error> {
        if !lock(&self.usage).unsaved {
            return Ok(());
        }
        let usage = self.usage.clone();
        tokio::task::spawn_blocking(move || lock(&usage).save()).await?
    }
    async fn flush_events(&self, flushed: &mut Flushed) -> Result<(), Error> {
        loop {
            let batch = lock(&self.events).batch(Instant::now())?;
            let Some(batch) = batch else {
                return Ok(());
            };
            match self
                .api
                .post("/node/v1/events", &json!({"events": batch}))
                .await
            {
                Ok(()) => flushed.events += batch.len(),
                Err(error) if refused(&error) => {
                    flushed.refused += batch.len();
                    super::log("events_refused", &error);
                }
                Err(error) => return Err(error),
            }
            lock(&self.events).done();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::link::{
        request::{Fenced, tests::enrolled},
        test_server::{Cloud, Failure, TempDir, database_id, tempdir, vector, vectors},
    };
    use std::os::unix::fs::PermissionsExt;

    /// The `index`th row: ten seconds of one database, 300 rows to a database.
    fn row(index: usize) -> Value {
        let at =
            |seconds: usize| format!("2026-10-17T11:{:02}:{:02}.000Z", seconds / 60, seconds % 60);
        let start = (index % 300) * 10;
        json!({"database":database_id(index / 300),"interval_start":at(start),"interval_end":at(start + 10),
            "awake_ms":10_000,"ingress_bytes":null,"egress_bytes":null,"connections":null,"connection_ms":null})
    }
    fn rows(range: std::ops::Range<usize>) -> Vec<Value> {
        range.map(row).collect()
    }
    fn events() -> Vec<Value> {
        vector("NodeEventReport", "events")["events"]
            .as_array()
            .unwrap()
            .clone()
    }

    #[test]
    fn the_rules_decide_as_the_contract_does_for_every_usage_and_event_vector() {
        for vector in vectors("NodeUsageReport") {
            let (value, rows) = (
                &vector["value"],
                vector["value"]["rows"].as_array().unwrap(),
            );
            let identities: HashSet<_> = rows.iter().map(identity).collect();
            let accepted = schema_valid("NodeUsageReport", value)
                && rows.iter().all(usage_row_valid)
                && identities.len() == rows.len();
            assert_eq!(accepted, vector["valid"], "{}", vector["name"]);
        }
        for vector in vectors("NodeEventReport") {
            let (value, events) = (
                &vector["value"],
                vector["value"]["events"].as_array().unwrap(),
            );
            let ids: HashSet<_> = events
                .iter()
                .map(|e| e["id"].as_str().unwrap_or_default())
                .collect();
            let accepted = schema_valid("NodeEventReport", value)
                && events.iter().all(event_valid)
                && ids.len() == events.len();
            assert_eq!(accepted, vector["valid"], "{}", vector["name"]);
        }
    }

    #[test]
    fn usage_rows_wait_in_a_private_file_until_the_pass_that_answered_them_is_saved() {
        let base = tempdir();
        let path = base.join("link/usage-outbox.json");
        let mut queue = UsageQueue::load(path.clone());
        queue.queue(&rows(0..5)).unwrap();
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        // The same intervals again are the same rows: a restart computes them twice.
        queue.queue(&rows(3..8)).unwrap();
        assert_eq!(queue.rows, rows(0..8));
        assert_eq!(UsageQueue::load(path.clone()).rows, rows(0..8));
        // Answered rows leave the queue at once and the file with the save of the pass, not with
        // every batch: a restart before it posts rows again that the API holds and ignores.
        queue.done(3);
        assert_eq!(queue.rows, rows(3..8));
        assert_eq!(UsageQueue::load(path.clone()).rows, rows(0..8));
        queue.save().unwrap();
        assert_eq!(UsageQueue::load(path.clone()).rows, rows(3..8));
        queue.done(5);
        queue.save().unwrap();
        assert!(UsageQueue::load(path).rows.is_empty());
    }

    #[test]
    fn rows_against_the_contract_or_beyond_the_bound_are_refused_whole() {
        let base = tempdir();
        let path = base.join("usage-outbox.json");
        let mut queue = UsageQueue::load(path.clone());
        queue.queue(&rows(0..2)).unwrap();
        let mut late = row(5);
        late["interval_end"] = "2026-10-17T12:00:10.000Z".into();
        assert!(
            queue.queue(&[row(4), late]).is_err(),
            "an interval over the hour"
        );
        assert!(queue.queue(&[row(4), json!({"database":"x"})]).is_err());
        assert!(
            queue.queue(&rows(10..USAGE_MAX_ROWS + 10)).is_err(),
            "beyond the bound"
        );
        assert_eq!(queue.rows, rows(0..2));
        assert_eq!(UsageQueue::load(path).rows, rows(0..2));
    }

    #[test]
    fn a_damaged_usage_file_is_an_empty_queue() {
        let base = tempdir();
        let path = base.join("usage-outbox.json");
        for damaged in [
            "{",
            r#"{"v":2,"rows":[]}"#,
            r#"{"v":1,"rows":[{"database":"x"}]}"#,
        ] {
            std::fs::write(&path, damaged).unwrap();
            assert!(UsageQueue::load(path.clone()).rows.is_empty(), "{damaged}");
        }
    }

    #[test]
    fn an_event_batch_is_retried_unchanged_for_ten_minutes_and_then_dropped() {
        let mut queue = EventQueue {
            waiting: VecDeque::new(),
            posted: None,
        };
        let all = events();
        queue.queue(&all[..2]).unwrap();
        let start = Instant::now();
        assert_eq!(queue.batch(start).unwrap(), Some(all[..2].to_vec()));
        // Events that come later wait: a retry carries the ids of the first attempt only.
        queue.queue(&all[2..3]).unwrap();
        assert_eq!(
            queue.batch(start + Duration::from_secs(599)).unwrap(),
            Some(all[..2].to_vec())
        );
        // Cloudflare forgot those ids after 600 s: a repeat could count twice.
        assert_eq!(
            queue.batch(start + Duration::from_secs(600)).unwrap(),
            Some(all[2..3].to_vec())
        );
        queue.done();
        assert_eq!(queue.batch(start + Duration::from_secs(601)).unwrap(), None);
        // An event that breaks the contract is refused whole.
        assert!(
            queue
                .queue(&[all[0].clone(), json!({"type":"reboot"})])
                .is_err()
        );
        assert_eq!(queue.batch(start).unwrap(), None);
    }

    #[test]
    fn beyond_the_bound_the_oldest_events_are_dropped() {
        let mut queue = EventQueue {
            waiting: VecDeque::new(),
            posted: None,
        };
        let event = |i: usize| {
            let mut event = events()[0].clone();
            event["id"] = format!("{i:08x}-1111-4111-8111-111111111111").into();
            event
        };
        let many: Vec<Value> = (0..EVENTS_MAX + 3).map(event).collect();
        assert_eq!(queue.queue(&many[..EVENTS_MAX]).unwrap(), 0);
        assert_eq!(queue.queue(&many[EVENTS_MAX..]).unwrap(), 3);
        assert_eq!(queue.waiting.len(), EVENTS_MAX);
        assert_eq!(queue.waiting[0], many[3], "the oldest went");
        // An event of an id that is queued already is the same event.
        assert_eq!(queue.queue(&many[10..20]).unwrap(), 0);
        assert_eq!(queue.waiting.len(), EVENTS_MAX);
    }

    /// An outbox of an enrolled node, and the directory that holds its file.
    async fn outbox(cloud: &Cloud) -> (Outbox, TempDir) {
        let (api, _) = enrolled(cloud).await;
        let directory = tempdir();
        (
            Outbox::new(Arc::new(api), directory.join("usage-outbox.json")),
            directory,
        )
    }

    #[tokio::test]
    async fn usage_is_posted_in_bounded_batches_oldest_first_and_forgotten_once_answered() {
        let cloud = Cloud::start().await;
        let (outbox, directory) = outbox(&cloud).await;
        let path = directory.join("usage-outbox.json");
        outbox.queue_usage(&rows(0..60)).unwrap();
        let flushed = outbox.flush().await.unwrap();
        assert_eq!(
            flushed,
            Flushed {
                usage_rows: 60,
                events: 0,
                refused: 0
            }
        );
        let bodies = cloud.acknowledged("/node/v1/usage");
        assert!(
            bodies.len() >= 3
                && bodies
                    .iter()
                    .all(|b| b["rows"].as_array().unwrap().len() <= 25)
        );
        let sent: Vec<Value> = bodies
            .iter()
            .flat_map(|b| b["rows"].as_array().unwrap().clone())
            .collect();
        assert_eq!(sent, rows(0..60));
        assert!(UsageQueue::load(path).rows.is_empty());
        // Nothing queued, nothing posted.
        assert_eq!(outbox.flush().await.unwrap(), Flushed::default());
        assert_eq!(cloud.posted("/node/v1/usage").len(), bodies.len());
    }

    #[tokio::test]
    async fn a_post_that_fails_or_whose_answer_is_lost_is_repeated_with_the_same_rows() {
        let cloud = Cloud::start().await;
        let (outbox, directory) = outbox(&cloud).await;
        let path = directory.join("usage-outbox.json");
        outbox.queue_usage(&rows(0..30)).unwrap();
        // The API is unavailable; then it applies a batch and the answer is lost.
        cloud.fail_next([Failure::Status(503)]);
        assert!(outbox.flush().await.is_err());
        assert_eq!(
            UsageQueue::load(path.clone()).rows,
            rows(0..30),
            "kept for the next flush"
        );
        cloud.fail_next([Failure::Drop]);
        assert!(outbox.flush().await.is_err());
        let posted = cloud.posted("/node/v1/usage");
        assert_eq!(posted[0], posted[1], "the retry is the same batch");
        assert_eq!(outbox.flush().await.unwrap().usage_rows, 30);
        assert_eq!(cloud.posted("/node/v1/usage")[2], posted[0]);
        assert!(UsageQueue::load(path).rows.is_empty());
    }

    #[tokio::test]
    async fn rows_answered_before_a_failure_are_not_posted_again_after_a_restart() {
        let cloud = Cloud::start().await;
        let (outbox, directory) = outbox(&cloud).await;
        outbox.queue_usage(&rows(0..60)).unwrap();
        // Two batches are answered, then the API is unavailable.
        cloud.fail_next([Failure::Pass, Failure::Pass, Failure::Status(503)]);
        assert!(outbox.flush().await.is_err());
        assert_eq!(
            UsageQueue::load(directory.join("usage-outbox.json")).rows,
            rows(50..60)
        );
    }

    #[tokio::test]
    async fn a_batch_cloudflare_refuses_is_dropped_so_the_queue_drains_past_it() {
        let cloud = Cloud::start().await;
        let (outbox, _directory) = outbox(&cloud).await;
        outbox.queue_usage(&rows(0..30)).unwrap();
        cloud.fail_next([Failure::Status(400)]);
        let flushed = outbox.flush().await.unwrap();
        assert_eq!((flushed.usage_rows, flushed.refused), (5, 25));
        let sent: Vec<Value> = cloud
            .acknowledged("/node/v1/usage")
            .iter()
            .flat_map(|b| b["rows"].as_array().unwrap().clone())
            .collect();
        assert_eq!(sent, rows(25..30));
    }

    #[tokio::test]
    async fn a_fenced_node_keeps_what_it_could_not_report() {
        let cloud = Cloud::start().await;
        let (outbox, directory) = outbox(&cloud).await;
        let path = directory.join("usage-outbox.json");
        outbox.queue_usage(&rows(0..3)).unwrap();
        outbox.queue_events(&events()).unwrap();
        cloud.with(|inner| inner.fenced = true);
        assert!(outbox.flush().await.unwrap_err().is::<Fenced>());
        assert_eq!(UsageQueue::load(path).rows, rows(0..3));
        let held = lock(&outbox.events);
        let posted = held.posted.as_ref().map_or(0, |(batch, _)| batch.len());
        assert_eq!(held.waiting.len() + posted, events().len());
    }

    #[tokio::test]
    async fn events_are_posted_and_a_lost_answer_repeats_the_same_batch() {
        let cloud = Cloud::start().await;
        let (outbox, _directory) = outbox(&cloud).await;
        outbox.queue_events(&events()).unwrap();
        cloud.fail_next([Failure::Drop]);
        // The usage queue is empty: the failure is the events'.
        assert!(outbox.flush().await.is_err());
        let mut later = events()[0].clone();
        later["id"] = "99999999-1111-4111-8111-111111111111".into();
        outbox.queue_events(&[later.clone()]).unwrap();
        let flushed = outbox.flush().await.unwrap();
        assert_eq!(flushed.events, events().len() + 1);
        let posted = cloud.posted("/node/v1/events");
        assert_eq!(posted[0], posted[1], "the repeat carries the same ids");
        assert_eq!(posted[0]["events"], json!(events()));
        // The event queued after the failure follows in a batch of its own.
        assert_eq!(posted[2]["events"], json!([later]));
        assert_eq!(posted.len(), 3);
    }
}
