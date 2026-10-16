// SPDX-License-Identifier: Apache-2.0
use futures_util::{SinkExt, StreamExt};
use pgcf_native_controller::{
    Error,
    api::{ControlApi, DesiredSnapshot},
    contracts::{constant, integer, number, removal_roles, schema_valid, text},
    diagnostics::error_code,
    kubernetes::Kubernetes,
    measurements::Measurements,
    node_storage::{Renewal, Sampler, driver_image, sample_node},
    reconcile::{Reconciler, newer_token, storage_claims, storage_snapshot_expired},
    timing,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
    time::Duration,
};
use tokio::{
    sync::mpsc,
    task::{AbortHandle, JoinSet},
    time::Instant,
};
use tokio_tungstenite::{
    connect_async_with_config,
    tungstenite::{Message, client::IntoClientRequest, protocol::WebSocketConfig},
};

enum Hint {
    Pull(Option<Vec<String>>),
    /// A watched database object changed: its database ID, the object kind and the object's name.
    Kube(String, &'static str, String),
}
struct Cell {
    db: Value,
    snapshot: Arc<DesiredSnapshot>,
    fingerprint: Vec<u8>,
    due: Instant,
    hints: u64,
    ready: bool,
    renew: bool,
    attempt: u32,
    authority_at: Instant,
    /// The power operation this controller last observed ready.
    woke: Option<String>,
    /// Consecutive not-ready results of the pending wake.
    stalled: u32,
    /// A Pod change of the ready database awaits a fresh runtime attestation.
    reattest: bool,
    /// Actual V2 proof expiry is independent of token-only ledger deliveries.
    verification_due: Option<Instant>,
    /// When the latest pass of the database began: a change of its objects makes the next one due
    /// no sooner than `HINT_SPACING` after it.
    started: Option<Instant>,
    /// When the log last named what hinted the database.
    hint_logged: Option<Instant>,
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum JobKind {
    Reconcile,
    Renew,
    Protect,
}
type PullResult = (Option<Vec<String>>, Instant, Result<DesiredSnapshot, Error>);
type JobResult = (
    String,
    u64,
    u64,
    Instant,
    JobKind,
    Result<Option<Value>, Error>,
);
struct Active {
    task: tokio::task::Id,
    abort: AbortHandle,
    kind: JobKind,
    class: Class,
}
fn fingerprint(db: &Value, snapshot: &DesiredSnapshot) -> Result<Vec<u8>, Error> {
    let mut db = db.clone();
    db.as_object_mut()
        .ok_or("desired item invalid")?
        .remove("storage_authority");
    // The same CF startup hold may be renewed while a bounded reconcile is running.
    // Its scope remains in the fingerprint; a shortened/invalid expiry is fenced below.
    if let Some(startup) = db["storage_startup"].as_object_mut() {
        startup.remove("expires_at");
    }
    Ok(Sha256::digest(serde_json::to_vec(&json!({"database":db,"backup":snapshot.region["backup"],"recovery_sources":snapshot.region["recovery_sources"],"fleet":snapshot.fleet_release,"compute_pool":snapshot.region["compute_pool"]}))?).to_vec())
}
fn apply_snapshot(
    cells: &mut HashMap<String, Cell>,
    active: &HashMap<String, Active>,
    renewals: &Renewals,
    snapshot: DesiredSnapshot,
    requested: Option<&[String]>,
    pulled_at: Instant,
) -> Result<(), Error> {
    let snapshot = Arc::new(snapshot);
    let ids: HashSet<_> = snapshot
        .databases
        .iter()
        .map(|db| text(db, "id").to_string())
        .collect();
    let absent: Vec<_> = cells
        .iter()
        .filter(|(id, cell)| {
            cell.authority_at <= pulled_at
                && !ids.contains(*id)
                && requested.is_none_or(|requested| requested.contains(*id))
        })
        .map(|(id, _)| id.clone())
        .collect();
    for id in absent {
        if let Some(job) = active.get(&id) {
            job.abort.abort();
        }
        cells.remove(&id);
    }
    for db in &snapshot.databases {
        let id = text(db, "id").to_string();
        let hash = fingerprint(db, &snapshot)?;
        let due = Instant::now();
        if let Some(cell) = cells.get_mut(&id) {
            if number(db, "generation") < number(&cell.db, "generation")
                || pulled_at < cell.authority_at
            {
                continue;
            }
            cell.authority_at = pulled_at;
            let changed = cell.fingerprint != hash || startup_retracted(&cell.db, db);
            let host_changed = host_write_state(&cell.db, &cell.snapshot, renewals)
                != host_write_state(db, &snapshot, renewals);
            if changed || host_changed {
                if let Some(job) = active.get(&id) {
                    job.abort.abort();
                }
                cell.ready = false;
                cell.verification_due = None;
                cell.renew = false;
                cell.attempt = 0;
                cell.stalled = 0;
                cell.due = due;
                cell.hints = cell.hints.wrapping_add(1);
            } else if cell.ready && db["storage_authority"] != cell.db["storage_authority"] {
                cell.renew = true;
                cell.due = due;
                cell.hints = cell.hints.wrapping_add(1);
            }
            cell.db = db.clone();
            cell.snapshot = snapshot.clone();
            cell.fingerprint = hash;
        } else {
            cells.insert(
                id,
                Cell {
                    db: db.clone(),
                    snapshot: snapshot.clone(),
                    fingerprint: hash,
                    due,
                    hints: 0,
                    ready: false,
                    renew: false,
                    attempt: 0,
                    authority_at: pulled_at,
                    woke: None,
                    stalled: 0,
                    reattest: false,
                    verification_due: None,
                    started: None,
                    hint_logged: None,
                },
            );
        }
    }
    Ok(())
}
/// Fast renewals (thin-authority-renewal.md, 4.5 and 4.6): per node UID the newest accepted
/// authority, and per database the newest token delivered with any of them. Each stands in for
/// the snapshot's entry or token wherever it is newer; a token counts until it expires.
#[derive(Default)]
struct Renewals {
    nodes: HashMap<String, (u64, Value)>,
    tokens: HashMap<String, String>,
    /// The newest regional snapshot fences even cells retained from an earlier hinted pull.
    targets: Option<HashMap<String, Value>>,
    listed: HashMap<String, Value>,
}
impl Renewals {
    fn sync_targets(&mut self, snapshot: &DesiredSnapshot, wanted: &HashMap<String, Value>) {
        let targets: HashMap<_, _> = wanted
            .values()
            .filter(|source| source["target"]["qualification_run"].is_null())
            .map(|source| {
                (
                    text(&source["target"], "node_uid").to_string(),
                    source.clone(),
                )
            })
            .collect();
        let unchanged = |uid: &str| {
            targets.get(uid).is_some_and(|source| {
                self.targets
                    .as_ref()
                    .is_none_or(|held| held.get(uid) == Some(source))
            })
        };
        self.nodes.retain(|uid, _| unchanged(uid));
        self.tokens.retain(|_, token| {
            storage_claims(token).is_some_and(|claims| unchanged(text(&claims, "node_uid")))
        });
        self.targets = Some(targets);
        self.listed = snapshot.region["storage_nodes"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|row| (text(row, "node_uid").to_string(), row.clone()))
            .collect();
    }
    fn sampled(&self, db: &Value) -> bool {
        self.targets
            .as_ref()
            .is_none_or(|targets| targets.contains_key(text(&db["storage"], "node_uid")))
    }
    /// Keeps a renewal only over an older one of its node and each of its tokens only over an
    /// older one of its database; tokens that expired by `clock` (ms) are dropped.
    fn accept(&mut self, renewal: Renewal, clock: i128) -> bool {
        if self
            .targets
            .as_ref()
            .is_some_and(|targets| !targets.contains_key(&renewal.node_uid))
        {
            return false;
        }
        if self
            .nodes
            .get(&renewal.node_uid)
            .is_some_and(|(held, _)| *held >= renewal.revision)
        {
            return false;
        }
        self.nodes
            .insert(renewal.node_uid, (renewal.revision, renewal.authority));
        for (database, token) in renewal.tokens {
            let held = self.tokens.get(&database).map(String::as_str);
            if newer_token(held, Some(&token)) == Some(token.as_str()) {
                self.tokens.insert(database, token);
            }
        }
        self.tokens.retain(|_, token| {
            storage_claims(token)
                .and_then(|claims| integer(&claims, "exp").ok())
                .is_some_and(|expiry| i128::from(expiry) > clock)
        });
        true
    }
    fn snapshot_listed<'a>(db: &Value, snapshot: &'a DesiredSnapshot) -> Option<&'a Value> {
        snapshot.region["storage_nodes"]
            .as_array()?
            .iter()
            .find(|row| row["node_uid"] == db["storage"]["node_uid"])
    }
    fn listed<'a>(&'a self, db: &Value, snapshot: &'a DesiredSnapshot) -> Option<&'a Value> {
        if self.targets.is_some() {
            self.listed.get(text(&db["storage"], "node_uid"))
        } else {
            Self::snapshot_listed(db, snapshot)
        }
    }
    /// The renewed authority of the database's thin node when it is newer than the snapshot's.
    fn renewed(&self, db: &Value, snapshot: &DesiredSnapshot) -> Option<&Value> {
        if !self.sampled(db) {
            return None;
        }
        let (revision, authority) = self.nodes.get(db["storage"]["node_uid"].as_str()?)?;
        let listed = self
            .listed(db, snapshot)
            .and_then(|listed| integer(listed, "revision").ok())
            .is_some_and(|listed| listed >= *revision);
        (!listed).then_some(authority)
    }
    /// The authority the database's thin node currently holds.
    fn authority<'a>(&'a self, db: &Value, snapshot: &'a DesiredSnapshot) -> Option<&'a Value> {
        if !self.sampled(db) {
            return None;
        }
        self.renewed(db, snapshot)
            .or_else(|| self.listed(db, snapshot))
    }
    /// The newest write token of the database's current generation on its node.
    fn token<'a>(&'a self, db: &'a Value) -> Option<&'a str> {
        let delivered = self
            .tokens
            .get(text(db, "id"))
            .map(String::as_str)
            .filter(|token| {
                storage_claims(token).is_some_and(|claims| {
                    claims["generation"] == db["generation"]
                        && claims["node_uid"] == db["storage"]["node_uid"]
                })
            });
        newer_token(db["storage_authority"].as_str(), delivered)
    }
    /// The database and snapshot a job runs on: the newest token and node authority.
    fn effective(
        &self,
        db: &Value,
        snapshot: &Arc<DesiredSnapshot>,
    ) -> (Value, Arc<DesiredSnapshot>) {
        let mut view = db.clone();
        if let Some(token) = self.token(db) {
            view["storage_authority"] = token.into();
        }
        let authority = self.authority(db, snapshot);
        if authority == Self::snapshot_listed(db, snapshot) {
            return (view, snapshot.clone());
        }
        let mut region = snapshot.region.clone();
        let mut nodes = region["storage_nodes"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        nodes.retain(|row| row["node_uid"] != db["storage"]["node_uid"]);
        if let Some(authority) = authority {
            nodes.push(authority.clone());
        }
        region["storage_nodes"] = nodes.into();
        let snapshot = DesiredSnapshot {
            region,
            fleet_release: snapshot.fleet_release.clone(),
            databases: snapshot.databases.clone(),
        };
        (view, Arc::new(snapshot))
    }
}
fn host_write_state(db: &Value, snapshot: &DesiredSnapshot, renewals: &Renewals) -> Value {
    if db["storage"].is_null() {
        return Value::Null;
    }
    renewals.authority(db, snapshot).map_or(Value::Null,|a|json!({"node_uid":a["node_uid"],"profile_sha256":a["profile_sha256"],"volume_group_uuid":a["volume_group_uuid"],"pool_uuid":a["pool_uuid"],"write_allowed":a["write_allowed"]}))
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum StorageProtectionReason {
    AuthorityMissing,
    AuthorityRevoked,
    AuthorityExpiryInvalid,
    AuthorityExpired,
    StartupMissing,
    StartupScopeChanged,
    StartupExpiryInvalid,
    StartupExpired,
    TokenInvalid,
    TokenScopeChanged,
    TokenRevoked,
    TokenExpired,
}
impl StorageProtectionReason {
    fn code(self) -> &'static str {
        match self {
            Self::AuthorityMissing => "authority_missing",
            Self::AuthorityRevoked => "authority_revoked",
            Self::AuthorityExpiryInvalid => "authority_expiry_invalid",
            Self::AuthorityExpired => "authority_expired",
            Self::StartupMissing => "startup_missing",
            Self::StartupScopeChanged => "startup_scope_changed",
            Self::StartupExpiryInvalid => "startup_expiry_invalid",
            Self::StartupExpired => "startup_expired",
            Self::TokenInvalid => "token_invalid",
            Self::TokenScopeChanged => "token_scope_changed",
            Self::TokenRevoked => "token_revoked",
            Self::TokenExpired => "token_expired",
        }
    }
}
fn storage_protection_reason(
    db: &Value,
    snapshot: &DesiredSnapshot,
    renewals: &Renewals,
    clock: i128,
) -> Option<StorageProtectionReason> {
    if db["storage"].is_null() || text(db, "desired_state") != "running" {
        return None;
    }
    let Some(authority) = renewals.authority(db, snapshot) else {
        return Some(StorageProtectionReason::AuthorityMissing);
    };
    if authority["write_allowed"] != true {
        return Some(StorageProtectionReason::AuthorityRevoked);
    }
    let Some(expiry) = timestamp_millis(&authority["expires_at"]) else {
        return Some(StorageProtectionReason::AuthorityExpiryInvalid);
    };
    if expiry <= clock {
        return Some(StorageProtectionReason::AuthorityExpired);
    }
    let Some(token) = renewals.token(db) else {
        let startup = &db["storage_startup"];
        if startup.is_null() {
            return Some(StorageProtectionReason::StartupMissing);
        }
        if startup["generation"] != db["generation"]
            || startup["node_uid"] != db["storage"]["node_uid"]
        {
            return Some(StorageProtectionReason::StartupScopeChanged);
        }
        let Some(expiry) = timestamp_millis(&startup["expires_at"]) else {
            return Some(StorageProtectionReason::StartupExpiryInvalid);
        };
        return (expiry <= clock).then_some(StorageProtectionReason::StartupExpired);
    };
    // This only chooses an earlier protective stop. It never authorizes a write:
    // the gateway independently verifies the deployment-pinned CF signature.
    let Some(claims) = storage_claims(token) else {
        return Some(StorageProtectionReason::TokenInvalid);
    };
    if claims["database_id"] != db["id"]
        || claims["generation"] != db["generation"]
        || claims["node_uid"] != db["storage"]["node_uid"]
    {
        return Some(StorageProtectionReason::TokenScopeChanged);
    }
    if claims["write_allowed"] != true {
        return Some(StorageProtectionReason::TokenRevoked);
    }
    match integer(&claims, "exp") {
        Err(_) => Some(StorageProtectionReason::TokenInvalid),
        Ok(expiry) if i128::from(expiry) <= clock => Some(StorageProtectionReason::TokenExpired),
        Ok(_) => None,
    }
}
fn storage_protection_due(
    db: &Value,
    snapshot: &DesiredSnapshot,
    renewals: &Renewals,
    clock: i128,
) -> bool {
    storage_protection_reason(db, snapshot, renewals, clock).is_some()
}
fn timestamp_millis(value: &Value) -> Option<i128> {
    time::OffsetDateTime::parse(
        value.as_str()?,
        &time::format_description::well_known::Rfc3339,
    )
    .ok()
    .map(|value| value.unix_timestamp_nanos() / 1_000_000)
}
fn startup_retracted(previous: &Value, current: &Value) -> bool {
    timestamp_millis(&previous["storage_startup"]["expires_at"]).is_some_and(|held| {
        timestamp_millis(&current["storage_startup"]["expires_at"])
            .is_none_or(|current| current < held)
    })
}
/// Before the first writer token, only CF can renew this generation's startup hold.
/// Fast node headroom is not permission to extend its cached expiry locally.
fn startup_refresh_due(db: &Value, renewals: &Renewals, clock: i128) -> bool {
    let hold = &db["storage_startup"];
    if db["storage"].is_null()
        || text(db, "desired_state") != "running"
        || hold["generation"] != db["generation"]
        || hold["node_uid"] != db["storage"]["node_uid"]
    {
        return false;
    }
    if renewals
        .token(db)
        .and_then(storage_claims)
        .is_some_and(|claims| {
            claims["database_id"] == db["id"]
                && claims["generation"] == db["generation"]
                && claims["node_uid"] == db["storage"]["node_uid"]
                && claims["write_allowed"] == true
                && integer(&claims, "exp").is_ok_and(|expiry| i128::from(expiry) > clock)
        })
    {
        return false;
    }
    timestamp_millis(&hold["expires_at"]).is_some_and(|expiry| {
        expiry - clock <= i128::from(number(&db["storage"], "guard_seconds")) * 500
    })
}
fn preempt_storage(
    db: &Value,
    snapshot: &DesiredSnapshot,
    renewals: &Renewals,
    clock: i128,
    kind: JobKind,
) -> bool {
    kind != JobKind::Protect && storage_protection_due(db, snapshot, renewals, clock)
}
/// Bounded reconciliation slots shared by every database.
const SLOTS: usize = 4;
const RECONCILE_BUDGET: Duration = Duration::from_secs(30);
/// Scheduling classes in priority order.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum Class {
    /// A protective stop or a storage-authority renewal: a lapsed authority stops writes.
    Storage,
    /// A wake or resume whose power operation is not yet observed ready, or the
    /// re-attestation of a ready database whose Pod changed.
    Wake,
    Routine,
}
/// Readiness that routes wait for: a running power operation this controller has not yet
/// observed ready, or a re-attestation after a Pod change of the ready database.
fn waking(cell: &Cell) -> bool {
    cell.reattest
        || (!cell.ready
            && cell.db["power"]["mode"] == "running"
            && cell.db["power"]["operation"].as_str() != cell.woke.as_deref())
}
fn class(cell: &Cell, renewals: &Renewals, clock: i128) -> Class {
    if storage_protection_due(&cell.db, &cell.snapshot, renewals, clock)
        || (cell.renew && cell.ready)
    {
        Class::Storage
    } else if waking(cell) {
        Class::Wake
    } else {
        Class::Routine
    }
}
/// The first not-ready results of a pending wake retry each second; later ones back off to
/// 30 s, so stuck wakes cannot hold the slots. A Kubernetes hint still retries at once.
fn not_ready_delay(stalled: u32) -> Duration {
    Duration::from_secs(if stalled <= 5 {
        1
    } else {
        (1_u64 << (stalled - 5).min(5)).min(30)
    })
}
/// A Kubernetes change of the database's objects makes it due at once. A Pod change of a
/// ready database may replace its attested primary within the revision; v3 routes to it are
/// refused until the next ready result re-attests it, so that check is urgent.
fn hinted(cell: &mut Cell, kind: &str, now: Instant) {
    cell.due = cell.due.min(after_change(cell.started, now));
    cell.hints = cell.hints.wrapping_add(1);
    cell.reattest |= kind == "Pod" && cell.ready;
}
/// How soon after a pass of a database began another begins because something it looks at
/// changed. CNPG creating an instance changes the objects of a database a few times a second,
/// every pass takes some tens of milliseconds, and a pass that follows each change finds nothing
/// the one before it did not: live that was twenty full passes a second, 800 requests, for ten
/// seconds. A change after a quiet time is still looked at at once.
const HINT_SPACING: Duration = Duration::from_millis(500);
/// The earliest time a change seen at `now` makes the database due, given when its latest pass
/// `started`.
fn after_change(started: Option<Instant>, now: Instant) -> Instant {
    started.map_or(now, |started| (started + HINT_SPACING).max(now))
}
/// A pass that began at `started` ran while its database's objects changed, which `marker` was
/// not yet aware of: it is looked at again, as soon as the spacing allows.
fn rehint(cell: &mut Cell, started: Instant, marker: u64, now: Instant) {
    if cell.hints != marker {
        cell.due = cell.due.min(after_change(Some(started), now));
    }
}
/// The log line of a change of an object of a database that made it due: what changed, by kind
/// and name, and nothing of it. A database that is looked at again and again for no reason it
/// shows is named by what keeps changing.
fn hint_line(database: &str, kind: &str, name: &str) -> Value {
    json!({"event":"database_hinted","database_id":database,"kind":kind,"name":name})
}
/// Whether this change is the one to name in the log: at most one a second of a database, so that
/// a burst of changes is one line and a change every two seconds is each of them.
fn hint_to_log(cell: &mut Cell, now: Instant) -> bool {
    if cell
        .hint_logged
        .is_some_and(|at| now.saturating_duration_since(at) < Duration::from_secs(1))
    {
        return false;
    }
    cell.hint_logged = Some(now);
    true
}
/// The log line of a failed reconcile: the database, its generation and the failure's class. The
/// failure's text is never logged (see `error_code`).
fn reconcile_failed(database_id: &str, generation: u64, error: &Error) -> Value {
    json!({"event":"database_reconcile_failed","database_id":database_id,"generation":generation,"error":error_code(error)})
}
/// How long a watch of a kind is left alone after it ended for the `failures`-th time in a row:
/// one second, then more, up to half a minute. Each end lists the kind again and has every
/// database pulled, so a watch that cannot be established must not be asked for every second.
fn watch_delay(failures: u32) -> Duration {
    Duration::from_secs((1_u64 << failures.saturating_sub(1).min(5)).min(30))
}
/// The log line of a watch that ended: its kind and the class of the failure, never its text.
fn watch_ended_line(kind: &str, error: &Error) -> Value {
    json!({"event":"watch_ended","kind":kind,"error":error_code(error)})
}
/// The backoff after the `attempt`-th consecutive failed reconcile or renewal.
fn failure_delay(attempt: u32) -> Duration {
    Duration::from_secs((1_u64 << attempt.min(8)).min(300))
}
/// The delay after the `attempt`-th consecutive failed reconcile. The first retry is quick: a pass
/// that met a Pod not yet reachable or a write conflict usually succeeds at once, and a wake waits
/// for it; the failures after it keep the backoff a failed renewal has.
fn reconcile_failure_delay(attempt: u32) -> Duration {
    if attempt <= 1 {
        Duration::from_millis(250)
    } else {
        failure_delay(attempt - 1)
    }
}
fn stale_snapshot_retry(cell: &mut Cell, now: Instant) {
    cell.attempt = 0;
    cell.stalled = 0;
    cell.due = now + Duration::from_secs(1);
}
/// Records a finished storage-authority renewal that started at hint `marker`. A failed one
/// backs off like a failed reconcile, so failing renewals cannot hold every slot; an authority
/// that lapses meanwhile still makes the protective stop due.
fn verification_due(cell: &Cell, now: Instant) -> bool {
    cell.verification_due.is_some_and(|due| due <= now)
}
fn proof_verification_deadline(observed: &Value, now: Instant, clock: i128) -> Option<Instant> {
    let proof = &observed["runtime_attestation"];
    if proof["v"] != 2 {
        return None;
    }
    let expiry = i128::from(proof["observation"]["expires_at"].as_u64()?);
    let remaining = u64::try_from((expiry - clock).max(0)).ok()?;
    // Reserve the existing reconcile budget inside the actual emitted proof lifetime.
    Some(
        now + Duration::from_millis(
            remaining.saturating_sub(RECONCILE_BUDGET.as_millis().try_into().ok()?),
        ),
    )
}
fn next_kind(cell: &Cell, renewals: &Renewals, clock: i128, now: Instant) -> JobKind {
    if storage_protection_due(&cell.db, &cell.snapshot, renewals, clock) {
        JobKind::Protect
    } else if cell.renew && cell.ready && !verification_due(cell, now) {
        JobKind::Renew
    } else {
        JobKind::Reconcile
    }
}
fn renewed(cell: &mut Cell, started: Instant, ok: bool, marker: u64, now: Instant) {
    if !ok {
        cell.attempt = cell.attempt.saturating_add(1);
        cell.due = now + failure_delay(cell.attempt);
        return;
    }
    cell.attempt = 0;
    if cell.hints == marker {
        cell.renew = false;
        // A pending re-attestation does not wait for the next check.
        cell.due = if cell.reattest {
            now
        } else {
            started + Duration::from_secs(60)
        };
    } else {
        cell.due = now + Duration::from_secs(1);
    }
}
/// Whether a role the record awaits the removal of is neither removed nor blocked in `observed`:
/// each pass advances such a role one step, so the database is looked at again at once. Without
/// the maintenance credential no pass can advance a removal, and looking again changes nothing.
fn removal_pending(db: &Value, observed: &Value) -> bool {
    if db["maintenance"].is_null() {
        return false;
    }
    let reported = |key: &str, name: &str| {
        observed["roles"][key]
            .as_array()
            .is_some_and(|names| names.iter().any(|reported| reported == name))
    };
    removal_roles(db).any(|role| {
        let name = text(role, "name");
        !reported("removed", name) && !reported("blocked", name)
    })
}
/// Records a finished reconcile of `cell`'s current generation that started at hint `marker`.
fn settle(cell: &mut Cell, started: Instant, observed: Option<&Value>, marker: u64) {
    if let Some(observed) = observed {
        let state = text(observed, "state");
        cell.ready = matches!(state, "ready" | "deleted" | "hibernated");
        cell.verification_due = if state == "ready" {
            proof_verification_deadline(observed, Instant::now(), clock_ms())
        } else {
            None
        };
        cell.attempt = 0;
        if state == "ready" {
            cell.woke = cell.db["power"]["operation"].as_str().map(str::to_string);
        }
        if cell.ready {
            cell.stalled = 0;
            if cell.hints == marker {
                cell.renew = false;
            }
            // A result from before the latest hint may still name a replaced Pod.
            cell.reattest &= cell.hints != marker;
            cell.due = started
                + Duration::from_secs(if removal_pending(&cell.db, observed) {
                    1
                } else {
                    60
                });
            return;
        }
    }
    cell.due = started
        + if waking(cell) {
            cell.stalled = cell.stalled.saturating_add(1);
            not_ready_delay(cell.stalled)
        } else {
            Duration::from_secs(1)
        };
}
/// How soon after a wake that was published on the barrier alone the pass that makes the checks
/// it left to that pass is made.
const FOLLOWUP: Duration = Duration::from_secs(1);
/// Makes the pass over `cell` that follows a wake published on the barrier due.
fn followed_up(cell: &mut Cell, now: Instant) {
    cell.due = cell.due.min(now + FOLLOWUP);
}
/// Selects due work for the free slots; `busy` maps each running job to its class.
/// Storage work comes first, then wakes, then routine reconciliation. Routine work never
/// takes the last slot, so a wake does not wait behind unrelated database work, and wakes
/// leave one slot to due routine work while none runs, so stuck wakes cannot starve it.
fn schedule(
    cells: &HashMap<String, Cell>,
    renewals: &Renewals,
    busy: &HashMap<String, Class>,
    now: Instant,
    clock: i128,
    control_healthy: bool,
) -> Vec<(String, Class)> {
    let mut free = SLOTS.saturating_sub(busy.len());
    let mut routine = busy
        .values()
        .filter(|class| **class == Class::Routine)
        .count();
    let mut candidates: Vec<_> = cells
        .iter()
        .filter(|(id, cell)| {
            let protect = storage_protection_due(&cell.db, &cell.snapshot, renewals, clock);
            (cell.due <= now || verification_due(cell, now) || (cell.ready && protect))
                && (protect
                    || (control_healthy
                        && now.duration_since(cell.authority_at) <= Duration::from_secs(90)))
                && !busy.contains_key(*id)
        })
        .map(|(id, cell)| {
            let protect = storage_protection_due(&cell.db, &cell.snapshot, renewals, clock);
            let priority = if !protect && verification_due(cell, now) {
                Class::Routine
            } else {
                class(cell, renewals, clock)
            };
            (
                priority,
                cell.verification_due
                    .map_or(cell.due, |due| due.min(cell.due)),
                id.clone(),
            )
        })
        .collect();
    // Within each class, pending databases rotate by oldest due time; a slow first cohort
    // cannot monopolize the bounded reconciliation slots.
    candidates.sort();
    let mut reserved = usize::from(
        routine == 0
            && candidates
                .iter()
                .any(|(class, _, _)| *class == Class::Routine),
    );
    let mut selected = Vec::new();
    for (class, _, id) in candidates {
        if free == 0
            || (class == Class::Wake && free <= reserved)
            || (class == Class::Routine && routine + 1 >= SLOTS)
        {
            continue;
        }
        free -= 1;
        if class == Class::Routine {
            routine += 1;
            reserved = 0;
        }
        selected.push((id, class));
    }
    selected
}
fn clock_ms() -> i128 {
    time::OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000
}
/// One running node sampler and what it was started for.
struct Sampling {
    started_for: Value,
    task: tokio::task::Id,
    abort: AbortHandle,
    /// Dropping a removed or replaced sampler also drops every reply it already queued.
    replies: mpsc::Receiver<Renewal>,
}
/// What each sampled node's sampler is started for: its `storage_samples` target and the
/// release's driver. Any change starts a new sampler, which asks Cloudflare for a fresh nonce.
fn sampler_targets(snapshot: &DesiredSnapshot) -> HashMap<String, Value> {
    let driver = driver_image(&snapshot.fleet_release);
    snapshot.region["storage_samples"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|target| {
            (
                text(target, "node_id").to_string(),
                json!({"target":target,"driver":driver}),
            )
        })
        .collect()
}
/// Runs exactly one sampler per sampled node of the newest snapshot, each as its own task.
fn sync_samplers(
    samplers: &mut HashMap<String, Sampling>,
    tasks: &mut JoinSet<()>,
    snapshot: &DesiredSnapshot,
    (kube, api, renewals): (&Kubernetes, &ControlApi, &mut Renewals),
) {
    let wanted = sampler_targets(snapshot);
    renewals.sync_targets(snapshot, &wanted);
    retain_samplers(samplers, &wanted);
    for (node, started_for) in wanted {
        if samplers.contains_key(&node) {
            continue;
        }
        let Some(sampler) = Sampler::new(&started_for["target"], text(&started_for, "driver"))
        else {
            continue;
        };
        let (sender, replies) = mpsc::channel(1);
        let abort = tasks.spawn_local(sample_node(kube.clone(), api.clone(), sampler, sender));
        samplers.insert(
            node,
            Sampling {
                started_for,
                task: abort.id(),
                abort,
                replies,
            },
        );
    }
}
fn retain_samplers(samplers: &mut HashMap<String, Sampling>, wanted: &HashMap<String, Value>) {
    samplers.retain(|node, running| {
        let keep = wanted.get(node) == Some(&running.started_for);
        if !keep {
            running.abort.abort();
        }
        keep
    });
}
fn poll_renewals(samplers: &mut HashMap<String, Sampling>, renewals: &mut Renewals, clock: i128) {
    for sampling in samplers.values_mut() {
        while let Ok(renewal) = sampling.replies.try_recv() {
            if renewal.node_uid == text(&sampling.started_for["target"], "node_uid") {
                renewals.accept(renewal, clock);
            }
        }
    }
}
fn manifest() -> Result<Value, Error> {
    let source = option_env!("PGCF_SOURCE_REVISION").ok_or("unqualified controller build")?;
    let rust = option_env!("PGCF_RUST_VERSION").ok_or("unqualified compiler")?;
    let versions = option_env!("PGCF_VERSIONS_LOCK_SHA256").ok_or("unqualified release lock")?;
    let cargo = option_env!("PGCF_CARGO_LOCK_SHA256").ok_or("unqualified dependency lock")?;
    if source.len() != 40
        || !source
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err("unqualified controller source".into());
    }
    Ok(
        json!({"program":"pgcf-native-controller","version":env!("CARGO_PKG_VERSION"),"sourceRevision":source,"rustVersion":rust,"versionsLockSha256":versions,"cargoLockSha256":cargo,"protocolSha256":option_env!("PGCF_PROTOCOL_SHA256").ok_or("unqualified protocol contract")?,"controllerContractSha256":option_env!("PGCF_CONTROLLER_CONTRACT_SHA256").ok_or("unqualified controller contract")?,"configurationSchemaRevision":constant("CONFIGURATION_SCHEMA_REVISION")}),
    )
}
async fn link(api: ControlApi, hints: mpsc::Sender<Hint>) {
    loop {
        let result = async {
            let mut url = api.origin.join("/agent/v1/link")?;
            url.set_scheme("wss").map_err(|_| "invalid regional link scheme")?;
            let mut request = url.as_str().into_client_request()?;
            request.headers_mut().insert("Authorization",format!("Bearer {}",api.key().await?).parse()?);
            let config=WebSocketConfig::default().max_message_size(Some(64*1024)).max_frame_size(Some(64*1024));
            let (socket,_) = tokio::time::timeout(Duration::from_secs(20),connect_async_with_config(request,Some(config),false)).await??;
            let (mut send,mut receive)=socket.split();
            let instance=format!("{}-{}",std::process::id(),time::OffsetDateTime::now_utc().unix_timestamp_nanos());
            send.send(Message::Text(json!({"type":"hello","protocol":constant("AGENT_PROTOCOL_VERSION"),"agent_version":"native-0.1.0","instance_id":instance}).to_string().into())).await?;
            let mut welcome=false;
            let welcome_deadline=Instant::now()+Duration::from_secs(20);
            let mut pong=true;
            let mut heartbeat=tokio::time::interval_at(Instant::now()+Duration::from_secs(30),Duration::from_secs(30));
            loop {
                tokio::select! {
                    _ = tokio::time::sleep_until(welcome_deadline), if !welcome => return Err::<(),Error>("regional link welcome deadline exceeded".into()),
                    event = receive.next() => {
                        match event.ok_or("regional link closed")?? {
                            Message::Text(bytes) => {
                                let value:Value=serde_json::from_str(&bytes)?;
                                if !schema_valid("ServerLinkMessage",&value){return Err("regional link message invalid".into());}
                                match text(&value,"type") {
                                    "welcome" if !welcome => { welcome=true;hints.send(Hint::Pull(None)).await.map_err(|_|"controller queue closed")?; },
                                    "desired" if welcome => { let ids=value["ids"].as_array().map(|ids|ids.iter().filter_map(Value::as_str).map(str::to_string).collect());hints.send(Hint::Pull(ids)).await.map_err(|_|"controller queue closed")?; },
                                    _ => return Err("regional link message order invalid".into())
                                }
                            },
                            Message::Ping(bytes) => send.send(Message::Pong(bytes)).await?,
                            Message::Pong(_) => pong=true,
                            Message::Close(_) => return Ok(()),
                            _ => return Err("regional link frame invalid".into())
                        }
                    },
                    _ = heartbeat.tick() => {
                        if !pong{return Err("regional link heartbeat lost".into());}
                        pong=false;send.send(Message::Ping(Vec::new().into())).await?;
                    }
                }
            }
        }.await;
        if result.is_err() {
            eprintln!("{{\"event\":\"regional_link_reconnecting\"}}");
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
}
async fn shutdown() {
    #[cfg(unix)]
    {
        if let Ok(mut term) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            tokio::select! {_=tokio::signal::ctrl_c()=>{},_=term.recv()=>{}};
            return;
        }
    }
    let _ = tokio::signal::ctrl_c().await;
}
async fn run() -> Result<(), Error> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    if std::env::args().any(|a| a == "--help") {
        println!(
            "PGCF native controller: PGCF_REGION_ID PGCF_API_URL PGCF_AGENT_KEY_FILE PGCF_CLUSTER_UID PGCF_POSTGRES_IMAGE PGCF_GATEWAY_REPLICAS"
        );
        return Ok(());
    }
    let qualified = manifest()?;
    if std::env::args().any(|a| a == "--inspect-manifest" || a == "--version") {
        println!("{qualified}");
        return Ok(());
    }
    let api = ControlApi::from_env().await?;
    let kube = Kubernetes::in_cluster().await?;
    let cluster = std::env::var("PGCF_CLUSTER_UID")?;
    let image = std::env::var("PGCF_POSTGRES_IMAGE")?;
    let replicas: usize = std::env::var("PGCF_GATEWAY_REPLICAS")?.parse()?;
    let controller = Arc::new(Reconciler::new(
        kube.clone(),
        cluster,
        image,
        api.region.clone(),
        replicas,
    )?);
    let measurements = Arc::new(Measurements::new(
        kube.clone(),
        api.clone(),
        controller.clone(),
    )?);
    let (hints, mut incoming) = mpsc::channel(512);
    tokio::task::spawn_local(link(api.clone(), hints.clone()));
    for kind in pgcf_native_controller::kubernetes::RUNTIME_WATCH_KINDS
        .into_iter()
        .chain(pgcf_native_controller::kubernetes::PLAN_WATCH_KINDS)
    {
        let kube = kube.clone();
        let hints = hints.clone();
        tokio::task::spawn_local(async move {
            let mut failures = 0_u32;
            loop {
                let began = Instant::now();
                let (events, mut receive) = mpsc::channel(512);
                let task = tokio::task::spawn_local({
                    let kube = kube.clone();
                    async move { kube.watch_database_ids(kind, events).await }
                });
                while let Some(trigger) = receive.recv().await {
                    if hints
                        .send(Hint::Kube(trigger.database, kind, trigger.name))
                        .await
                        .is_err()
                    {
                        task.abort();
                        return;
                    }
                }
                let ended = match task.await {
                    Ok(Err(error)) => error,
                    _ => "watch task ended".into(),
                };
                eprintln!("{}", watch_ended_line(kind, &ended));
                // A watch that held for a while was a good one; one that ends at once is not.
                failures = if began.elapsed() >= Duration::from_secs(30) {
                    1
                } else {
                    failures.saturating_add(1)
                };
                // The pull asks for the desired state of every database again, as a watch that
                // hinted them may have missed something. The kinds that only keep versions hint
                // nothing, and miss nothing a pull would find.
                if pgcf_native_controller::kubernetes::RUNTIME_WATCH_KINDS.contains(&kind) {
                    let _ = hints.send(Hint::Pull(None)).await;
                }
                tokio::time::sleep(watch_delay(failures)).await;
            }
        });
    }
    let mut cells: HashMap<String, Cell> = HashMap::new();
    let mut active: HashMap<String, Active> = HashMap::new();
    let mut jobs: JoinSet<JobResult> = JoinSet::new();
    let mut pulls: JoinSet<PullResult> = JoinSet::new();
    let mut pull_full = false;
    let mut targeted_pulls: HashSet<String> = HashSet::new();
    let mut startup_reads: HashMap<String, Instant> = HashMap::new();
    let mut control_healthy = false;
    let mut have_full_snapshot = false;
    let mut latest_snapshot: Option<(Instant, Arc<DesiredSnapshot>)> = None;
    let mut inventories: JoinSet<Result<(), Error>> = JoinSet::new();
    let mut metering: JoinSet<Result<(), Error>> = JoinSet::new();
    let mut storage: HashMap<String, Value> = HashMap::new();
    let mut storage_sampling: JoinSet<Result<HashMap<String, Value>, Error>> = JoinSet::new();
    let mut renewals = Renewals::default();
    let mut samplers: HashMap<String, Sampling> = HashMap::new();
    let mut sampling: JoinSet<()> = JoinSet::new();
    let mut meter_interval = tokio::time::interval(Duration::from_millis(250));
    let mut node_interval = tokio::time::interval(Duration::from_secs(60));
    let mut storage_interval = tokio::time::interval(Duration::from_secs(60));
    let mut pull_ids = HashSet::new();
    let mut full = tokio::time::interval(Duration::from_secs(60));
    let mut cadence = tokio::time::interval(Duration::from_millis(50));
    loop {
        tokio::select! {
            _ = shutdown() => break,
            scheduled = meter_interval.tick() => {
                // The runtime is one thread: a late tick is the lag every task of it suffers.
                let lag = Instant::now().saturating_duration_since(scheduled);
                if lag >= Duration::from_millis(50) {
                    eprintln!("{}", json!({"event":"loop_lag_ms","lag_ms":lag.as_millis() as u64}));
                }
                if control_healthy && have_full_snapshot && metering.is_empty() {
                    let measurements=measurements.clone();
                    let databases:Vec<_>=cells.values().filter(|cell|Instant::now().duration_since(cell.authority_at)<=Duration::from_secs(90)).map(|cell|cell.db.clone()).collect();
                    metering.spawn_local(async move {measurements.cycle(&databases).await});
                }
            },
            result=metering.join_next(), if !metering.is_empty() => {
                if !matches!(result,Some(Ok(Ok(())))) {eprintln!("{{\"event\":\"measurement_cycle_unknown\"}}");}
            },
            _ = node_interval.tick() => {
                if control_healthy && have_full_snapshot && inventories.is_empty() {
                    let kube = kube.clone();
                    let api = api.clone();
                    let ids = cells.keys().cloned().collect();
                    let controller = controller.clone();
                    let fleet=latest_snapshot.as_ref().map(|(_,snapshot)|snapshot.fleet_release.clone()).unwrap_or(Value::Null);
                    let databases: Vec<_> = cells.values()
                        .filter(|cell| text(&cell.db, "desired_state") != "deleted")
                        .map(|cell| cell.db.clone()).collect();
                    let storage = storage.clone();
                    inventories.spawn_local(async move {
                        kube.assert_cluster(&controller.cluster_uid).await?;
                        tokio::time::timeout(Duration::from_secs(45), async {
                            pgcf_native_controller::inventory::collect(&kube, &api, &ids, &storage).await?;
                            let mut work = futures_util::stream::iter(databases.iter()
                                .map(|db| controller.health.refresh(&kube, db))).buffer_unordered(4);
                            while let Some(result) = work.next().await { result?; }
                            pgcf_native_controller::fleet::collect(&kube,&api,&fleet).await?;
                            Ok::<(), Error>(())
                        }).await.map_err(|_| "node collection deadline exceeded")?
                    });
                }
            },
            result = inventories.join_next(), if !inventories.is_empty() => {
                if !matches!(result, Some(Ok(Ok(())))) {
                    eprintln!("{{\"event\":\"node_inventory_unknown\"}}");
                }
            },
            _ = storage_interval.tick() => {
                // The exporter runs vgs/lvs per scrape; keep this slow read off reconcile and wake.
                if control_healthy && have_full_snapshot && storage_sampling.is_empty() {
                    let kube = kube.clone();
                    let fleet=latest_snapshot.as_ref().map(|(_,snapshot)|snapshot.fleet_release.clone()).unwrap_or(Value::Null);
                    storage_sampling.spawn_local(async move {
                        tokio::time::timeout(Duration::from_secs(45), pgcf_native_controller::node_storage::samples(&kube, &fleet))
                            .await
                            .map_err(|_| "node storage sampling deadline exceeded")?
                    });
                }
            },
            result = storage_sampling.join_next(), if !storage_sampling.is_empty() => {
                match result {
                    Some(Ok(Ok(samples))) => storage = samples,
                    _ => eprintln!("{{\"event\":\"node_storage_sample_failed\"}}"),
                }
            },
            result = sampling.join_next_with_id(), if !sampling.is_empty() => {
                // A sampler ends only when replaced or by failing; a failed one starts again.
                let ended = match result {
                    Some(Ok((task, ()))) => Some(task),
                    Some(Err(error)) => Some(error.id()),
                    None => None,
                };
                samplers.retain(|_, running| Some(running.task) != ended);
                if let Some((_, snapshot)) = &latest_snapshot {
                    sync_samplers(&mut samplers, &mut sampling, snapshot, (&kube, &api, &mut renewals));
                }
            },
            _ = full.tick() => {
                if !pull_full {
                    pull_full = true;
                    let api = api.clone();
                    pulls.spawn_local(async move { (None, Instant::now(), api.desired(None).await) });
                }
            },
            hint = incoming.recv() => {
                match hint {
                    Some(Hint::Pull(None)) => {
                        if !pull_full {
                            pull_full = true;
                            let api = api.clone();
                            pulls.spawn_local(async move { (None, Instant::now(), api.desired(None).await) });
                        }
                    },
                    Some(Hint::Pull(Some(ids))) => {
                        // A hint for a sleeping database is the start of a wake.
                        for id in &ids {
                            if cells.get(id).is_some_and(|cell| cell.db["desired_state"] == "suspended") {
                                timing::point("wake_hint_received", id);
                            }
                        }
                        pull_ids.extend(ids);
                    },
                    Some(Hint::Kube(id, kind, name)) => {
                        if let Some(cell) = cells.get_mut(&id) {
                            let now = Instant::now();
                            hinted(cell, kind, now);
                            if hint_to_log(cell, now) {
                                eprintln!("{}", hint_line(&id, kind, &name));
                            }
                        } else { pull_ids.insert(id); }
                    },
                    None => break
                }
            },
            result = pulls.join_next(), if !pulls.is_empty() => {
                if let Some(Ok((requested, pulled_at, result))) = result {
                    if let Some(ids) = &requested {
                        for id in ids { targeted_pulls.remove(id); }
                        timing::pulled(ids, pulled_at.into_std(), result.is_ok());
                    }
                    let is_full = requested.is_none();
                    if is_full { pull_full = false; }
                    match result {
                        Ok(snapshot) => {
                            if is_full { control_healthy = true; have_full_snapshot = true; }
                            if latest_snapshot.as_ref().is_none_or(|(at,_)|pulled_at>=*at) {
                                let latest = Arc::new(snapshot.clone());
                                sync_samplers(&mut samplers, &mut sampling, &latest, (&kube, &api, &mut renewals));
                                latest_snapshot=Some((pulled_at,latest));
                            }
                            apply_snapshot(&mut cells, &active, &renewals, snapshot, requested.as_deref(), pulled_at)?;
                        },
                        Err(_) => {
                            control_healthy = false;
                            eprintln!("{{\"event\":\"desired_pull_failed\"}}");
                        }
                    }
                } else {
                    targeted_pulls.clear();
                    pull_full = false;
                    control_healthy = false;
                }
            },
            result = jobs.join_next_with_id(), if !jobs.is_empty() => {
                match result {
                    Some(Ok((task, (id, generation, marker, started, kind, result)))) => {
                        if active.get(&id).is_some_and(|job| job.task == task) { active.remove(&id); }
                        if let Some(cell) = cells.get_mut(&id) {
                            if number(&cell.db, "generation") != generation {
                                cell.due = Instant::now();
                                continue;
                            }
                            if kind == JobKind::Renew {
                                renewed(cell, started, result.is_ok(), marker, Instant::now());
                                continue;
                            }
                            match result {
                                Ok(observed) => {
                                    settle(cell, started, observed.as_ref(), marker);
                                    if controller.take_followup(&id) {
                                        followed_up(cell, Instant::now());
                                    }
                                }
                                Err(error) if storage_snapshot_expired(&error) => {
                                    pull_ids.insert(id.clone());
                                    stale_snapshot_retry(cell,Instant::now());
                                }
                                Err(error) => {
                                    pull_ids.insert(id.clone());
                                    cell.attempt = cell.attempt.saturating_add(1);
                                    cell.due = Instant::now() + reconcile_failure_delay(cell.attempt);
                                    eprintln!("{}", reconcile_failed(&id, generation, &error));
                                }
                            }
                            rehint(cell, started, marker, Instant::now());
                        }
                    },
                    Some(Err(error)) => {
                        if let Some(id) = active.iter().find(|(_, job)| job.task == error.id()).map(|(id, _)| id.clone()) {
                            active.remove(&id);
                            if let Some(cell) = cells.get_mut(&id) { cell.due = Instant::now(); }
                        }
                    },
                    None => {}
                }
            },
            _ = cadence.tick() => {}
        }
        poll_renewals(&mut samplers, &mut renewals, clock_ms());

        let read_at = Instant::now();
        startup_reads.retain(|id, _| cells.contains_key(id));
        for (id, cell) in &cells {
            if !targeted_pulls.contains(id)
                && startup_reads.get(id).is_none_or(|after| *after <= read_at)
                && startup_refresh_due(&cell.db, &renewals, clock_ms())
            {
                pull_ids.insert(id.clone());
                // Failed reads still stop at the original expiry; retries are bounded.
                startup_reads.insert(id.clone(), read_at + Duration::from_secs(1));
            }
        }

        if !pull_ids.is_empty() && pulls.len() < 4 {
            let ids: Vec<_> = pull_ids
                .iter()
                .filter(|id| !targeted_pulls.contains(*id))
                .take(200)
                .cloned()
                .collect();
            for id in &ids {
                pull_ids.remove(id);
                targeted_pulls.insert(id.clone());
            }
            if !ids.is_empty() {
                let api = api.clone();
                pulls.spawn_local(async move {
                    let started = Instant::now();
                    let result = api.desired(Some(&ids)).await;
                    (Some(ids), started, result)
                });
            }
        }
        for (id, job) in &active {
            if cells.get(id).is_some_and(|cell| {
                preempt_storage(&cell.db, &cell.snapshot, &renewals, clock_ms(), job.kind)
            }) {
                job.abort.abort();
            }
        }
        if active.len() < SLOTS {
            let busy: HashMap<String, Class> = active
                .iter()
                .map(|(id, job)| (id.clone(), job.class))
                .collect();
            for (id, class) in schedule(
                &cells,
                &renewals,
                &busy,
                Instant::now(),
                clock_ms(),
                control_healthy,
            ) {
                let cell = &cells[&id];
                // Jobs see the newest token and node authority, from a renewal or the snapshot.
                let (db, snapshot) = renewals.effective(&cell.db, &cell.snapshot);
                let decided = renewals
                    .authority(&cell.db, &cell.snapshot)
                    .and_then(|authority| integer(authority, "revision").ok());
                let generation = number(&db, "generation");
                let marker = cell.hints;
                let controller = controller.clone();
                let api = api.clone();
                let protection =
                    storage_protection_reason(&cell.db, &cell.snapshot, &renewals, clock_ms());
                let kind = next_kind(cell, &renewals, clock_ms(), Instant::now());
                let started = Instant::now();
                let begun = cells.get_mut(&id).unwrap();
                begun.started = Some(started);
                if kind == JobKind::Reconcile {
                    begun.verification_due = None;
                }
                let job_id = id.clone();
                let abort = jobs.spawn_local(async move {
                    let result = async {
                        if kind == JobKind::Protect {
                            eprintln!("{}", json!({"event":"storage_protection_dispatched","database_id":job_id,"generation":generation,"protection_reason":protection.map(StorageProtectionReason::code)}));
                            return controller.power.protect_storage(&db).await;
                        }
                        if kind == JobKind::Renew {
                            tokio::time::timeout(
                                Duration::from_secs(30),
                                controller.renew_storage_authority(&db, decided),
                            )
                            .await
                            .map_err(|_| "storage authority renewal deadline exceeded")??;
                            return Ok::<_, Error>(None);
                        }
                        let observed = tokio::time::timeout(
                            RECONCILE_BUDGET,
                            timing::summarized(&db, controller.reconcile(&db, &snapshot)),
                        )
                        .await
                        .map_err(|_| "database reconcile deadline exceeded")??;
                        if let Some(observation) = &observed
                            && (db["power"].is_null()
                                || !observation["power"].is_null()
                                || matches!(
                                    text(observation, "state"),
                                    "ready" | "deleted" | "hibernated"
                                ))
                        {
                            let post = timing::Phase::begin(&db, "observation_post");
                            api.observation(observation.clone()).await?;
                            post.completed();
                        }
                        Ok(observed)
                    }
                    .await;
                    (job_id, generation, marker, started, kind, result)
                });
                active.insert(
                    id,
                    Active {
                        task: abort.id(),
                        abort,
                        kind,
                        class,
                    },
                );
            }
        }
    }
    inventories.abort_all();
    storage_sampling.abort_all();
    sampling.abort_all();
    metering.abort_all();
    pulls.abort_all();
    jobs.abort_all();
    while jobs.join_next().await.is_some() {}
    Ok(())
}
#[tokio::main(flavor = "current_thread")]
async fn main() {
    let local = tokio::task::LocalSet::new();
    if local.run_until(run()).await.is_err() {
        eprintln!("{{\"event\":\"native_controller_failed\"}}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn snapshot(rows: Vec<Value>) -> DesiredSnapshot {
        DesiredSnapshot {
            region: json!({"backup":{}}),
            fleet_release: Value::Null,
            databases: rows,
        }
    }
    fn cell(db: Value, due: Instant, ready: bool) -> Cell {
        Cell {
            db,
            snapshot: Arc::new(snapshot(vec![])),
            fingerprint: vec![],
            due,
            hints: 0,
            ready,
            renew: false,
            attempt: 0,
            authority_at: due,
            woke: None,
            stalled: 0,
            reattest: false,
            verification_due: None,
            started: None,
            hint_logged: None,
        }
    }
    fn wake(id: &str, operation: &str) -> Value {
        json!({"id":id,"generation":3,"desired_state":"running","power":{"operation":operation,"revision":3,"mode":"running","reason":null}})
    }
    fn operation(index: usize) -> String {
        format!("op_{index:0>20}")
    }
    /// Settles a job that started at the cell's current hint marker.
    fn finish(cell: &mut Cell, now: Instant, observed: Option<&Value>) {
        let marker = cell.hints;
        settle(cell, now, observed, marker);
    }
    #[test]
    fn a_scoped_startup_expiry_renewal_preserves_the_work_fingerprint() {
        let db = json!({"id":"db","generation":2,"desired_state":"running","storage":{"node_uid":"same","startup_reserve_bytes":5368709120_u64},"storage_startup":{"operation_id":operation(2),"generation":2,"node_uid":"same","budget_bytes":5368709120_u64,"expires_at":"1970-01-01T00:00:10.000Z"}});
        let state = snapshot(vec![]);
        let initial = fingerprint(&db, &state).unwrap();
        let mut renewed = db.clone();
        renewed["storage_startup"]["expires_at"] = "1970-01-01T00:00:20.000Z".into();
        assert_eq!(initial, fingerprint(&renewed, &state).unwrap());
        renewed["storage_startup"]["operation_id"] = operation(3).into();
        assert_ne!(initial, fingerprint(&renewed, &state).unwrap());
        renewed = db.clone();
        renewed["storage_startup"]["budget_bytes"] = 1073741824_u64.into();
        assert_ne!(initial, fingerprint(&renewed, &state).unwrap());
        renewed = db.clone();
        renewed["storage_startup"]["node_uid"] = "replaced".into();
        assert_ne!(initial, fingerprint(&renewed, &state).unwrap());
        renewed = db.clone();
        renewed["storage_startup"] = Value::Null;
        assert_ne!(initial, fingerprint(&renewed, &state).unwrap());
    }
    #[test]
    fn a_failed_reconcile_logs_the_failures_class_and_not_its_text() {
        let error: Error = "connect to 10.0.0.7:5432 as app with hunter2Hunter2 failed".into();
        let line = reconcile_failed("dbbbbbbbbbbbbbbbbbbb", 7, &error);
        assert_eq!(
            line,
            json!({"event":"database_reconcile_failed","database_id":"dbbbbbbbbbbbbbbbbbbb","generation":7,"error":"other"})
        );
        let status: Error =
            Box::new(pgcf_native_controller::kubernetes::KubernetesError { status: 409 });
        assert_eq!(
            reconcile_failed("dbbbbbbbbbbbbbbbbbbb", 7, &status)["error"],
            "kubernetes_http_409"
        );
        let phrase: Error = "Cluster UID changed".into();
        assert_eq!(
            reconcile_failed("dbbbbbbbbbbbbbbbbbbb", 7, &phrase)["error"],
            "cluster_uid_changed"
        );
        let text = line.to_string();
        assert!(!text.contains("10.0.0.7") && !text.contains("hunter2"));
    }
    #[test]
    fn tokenless_startup_refreshes_before_expiry_and_shortened_grants_revoke() {
        let db = json!({"id":"db","generation":2,"desired_state":"running","storage":{"node_uid":"same","guard_seconds":10},"storage_startup":{"operation_id":operation(2),"generation":2,"node_uid":"same","budget_bytes":5368709120_u64,"expires_at":"1970-01-01T00:00:10.000Z"}});
        assert!(!startup_refresh_due(&db, &Renewals::default(), 4000));
        assert!(startup_refresh_due(&db, &Renewals::default(), 5000));
        assert!(startup_refresh_due(&db, &Renewals::default(), 10000));
        let mut newer = db.clone();
        newer["storage_startup"]["expires_at"] = "1970-01-01T00:00:20.000Z".into();
        assert!(!startup_retracted(&db, &newer));
        newer["storage_startup"]["expires_at"] = "1970-01-01T00:00:09.000Z".into();
        assert!(startup_retracted(&db, &newer));
        newer["storage_startup"]["expires_at"] = "invalid".into();
        assert!(startup_retracted(&db, &newer));
        newer["storage_startup"] = Value::Null;
        assert!(startup_retracted(&db, &newer));
    }
    #[tokio::test]
    async fn latest_cell_expiry_or_revocation_still_preempts_and_schedules_protection() {
        let db = json!({"id":"db","generation":2,"desired_state":"running","storage":{"node_uid":"same"},"storage_startup":{"generation":2,"node_uid":"same","expires_at":"1970-01-01T00:00:03.000Z"}});
        let mut state = snapshot(vec![]);
        state.region = json!({"storage_nodes":[{"node_uid":"same","write_allowed":true,"expires_at":"1970-01-01T00:00:03.000Z"}]});
        let renewals = Renewals::default();
        let job = tokio::spawn(std::future::pending::<()>());
        assert!(!preempt_storage(
            &db,
            &state,
            &renewals,
            2000,
            JobKind::Reconcile
        ));
        state.region["storage_nodes"][0]["write_allowed"] = false.into();
        assert!(preempt_storage(
            &db,
            &state,
            &renewals,
            2000,
            JobKind::Reconcile
        ));
        if preempt_storage(&db, &state, &renewals, 2000, JobKind::Reconcile) {
            job.abort();
        }
        assert!(job.await.unwrap_err().is_cancelled());
        let now = Instant::now();
        let mut c = cell(db.clone(), now, false);
        c.snapshot = Arc::new(state.clone());
        let mut cells = HashMap::new();
        cells.insert("db".into(), c);
        assert_eq!(
            schedule(&cells, &renewals, &HashMap::new(), now, 2000, true),
            vec![("db".into(), Class::Storage)]
        );
        state.region["storage_nodes"][0]["write_allowed"] = true.into();
        state.region["storage_nodes"][0]["expires_at"] = "1970-01-01T00:00:02.000Z".into();
        assert!(preempt_storage(
            &db,
            &state,
            &renewals,
            2000,
            JobKind::Reconcile
        ));
        assert!(!preempt_storage(
            &db,
            &state,
            &renewals,
            2000,
            JobKind::Protect
        ));
    }
    #[test]
    fn repeated_stale_snapshots_never_accumulate_failed_job_backoff() {
        let db = json!({"id":"db","generation":2,"desired_state":"running","storage":{"node_uid":"same","guard_seconds":10},"storage_startup":{"operation_id":operation(2),"generation":2,"node_uid":"same","budget_bytes":5368709120_u64,"expires_at":"1970-01-01T00:00:10.000Z"}});
        let now = Instant::now();
        let mut cells = HashMap::new();
        let renewals = Renewals::default();
        apply_snapshot(
            &mut cells,
            &HashMap::new(),
            &renewals,
            snapshot(vec![db.clone()]),
            None,
            now,
        )
        .unwrap();
        cells.get_mut("db").unwrap().attempt = 8;
        for index in 0..3 {
            let instant = now + Duration::from_secs(index);
            stale_snapshot_retry(cells.get_mut("db").unwrap(), instant);
            let mut fresh = db.clone();
            fresh["storage_startup"]["expires_at"] =
                format!("1970-01-01T00:00:{:02}.000Z", 20 + index).into();
            apply_snapshot(
                &mut cells,
                &HashMap::new(),
                &renewals,
                snapshot(vec![fresh]),
                Some(&["db".into()]),
                instant,
            )
            .unwrap();
            assert_eq!(cells["db"].attempt, 0);
            assert_eq!(cells["db"].stalled, 0);
            assert_eq!(cells["db"].due, instant + Duration::from_secs(1));
        }
    }
    #[test]
    fn delayed_target_pulls_never_downgrade_or_remove_newer_rows() {
        let mut cells = HashMap::new();
        let active = HashMap::new();
        let none = Renewals::default();
        let started = Instant::now();
        apply_snapshot(
            &mut cells,
            &active,
            &none,
            snapshot(vec![
                json!({"id":"a","generation":2}),
                json!({"id":"b","generation":1}),
            ]),
            None,
            started + Duration::from_secs(1),
        )
        .unwrap();
        apply_snapshot(
            &mut cells,
            &active,
            &none,
            snapshot(vec![json!({"id":"a","generation":1})]),
            Some(&["a".into()]),
            started,
        )
        .unwrap();
        assert_eq!(cells["a"].db["generation"], 2);
        apply_snapshot(&mut cells, &active, &none, snapshot(vec![]), None, started).unwrap();
        assert_eq!(cells.len(), 2);
        apply_snapshot(
            &mut cells,
            &active,
            &none,
            snapshot(vec![]),
            Some(&["a".into()]),
            started + Duration::from_secs(2),
        )
        .unwrap();
        assert!(!cells.contains_key("a"));
        assert!(cells.contains_key("b"));
    }
    #[test]
    fn expired_cached_storage_authority_requires_local_stop_without_cf_pull() {
        let db = json!({"id":"a","generation":1,"desired_state":"running","storage":{"node_uid":"same"},"storage_startup":{"generation":1,"node_uid":"same","expires_at":"1970-01-01T00:00:02.000Z"}});
        let mut state = snapshot(vec![]);
        state.region = json!({"storage_nodes":[{"node_uid":"same","write_allowed":true,"expires_at":"1970-01-01T00:00:03.000Z"}]});
        assert!(!storage_protection_due(
            &db,
            &state,
            &Renewals::default(),
            1000
        ));
        assert!(storage_protection_due(
            &db,
            &state,
            &Renewals::default(),
            2000
        ));
        assert!(storage_protection_due(
            &db,
            &state,
            &Renewals::default(),
            3000
        ));
        state.region["storage_nodes"][0]["write_allowed"] = false.into();
        assert!(storage_protection_due(
            &db,
            &state,
            &Renewals::default(),
            1000
        ));
    }
    #[test]
    fn protection_diagnostics_name_the_existing_stop_without_claims_or_payloads() {
        let mut db = json!({"id":"db000000000000000001","generation":3,"desired_state":"running","storage":{"node_uid":NODE},"storage_startup":{"generation":3,"node_uid":NODE,"expires_at":"1970-01-01T00:00:02.000Z"}});
        let mut state = snapshot(vec![]);
        state.region = json!({"storage_nodes":[{"node_uid":NODE,"write_allowed":true,"expires_at":"1970-01-01T00:00:03.000Z"}]});
        let renewals = Renewals::default();
        assert_eq!(
            storage_protection_reason(&db, &state, &renewals, 1000),
            None
        );
        assert_eq!(
            storage_protection_reason(&db, &state, &renewals, 2000)
                .unwrap()
                .code(),
            "startup_expired"
        );
        assert_eq!(
            storage_protection_reason(&db, &state, &renewals, 3000)
                .unwrap()
                .code(),
            "authority_expired"
        );
        state.region["storage_nodes"][0]["write_allowed"] = false.into();
        assert_eq!(
            storage_protection_reason(&db, &state, &renewals, 1000)
                .unwrap()
                .code(),
            "authority_revoked"
        );
        state.region["storage_nodes"][0]["write_allowed"] = true.into();
        db["storage_authority"] = "private_payload_not_a_token".into();
        assert_eq!(
            storage_protection_reason(&db, &state, &renewals, 1000)
                .unwrap()
                .code(),
            "token_invalid"
        );
        db["storage_authority"] = token(2, 1, 2500).into();
        assert_eq!(
            storage_protection_reason(&db, &state, &renewals, 1000)
                .unwrap()
                .code(),
            "token_scope_changed"
        );
        db["storage_authority"] = token(3, 1, 1500).into();
        assert_eq!(
            storage_protection_reason(&db, &state, &renewals, 2000)
                .unwrap()
                .code(),
            "token_expired"
        );
    }
    #[test]
    fn a_pending_wake_never_waits_behind_unrelated_reconciliation() {
        let started = Instant::now();
        let mut cells = HashMap::new();
        for index in 0..6 {
            let id = format!("routine{index}");
            cells.insert(
                id.clone(),
                cell(json!({"id":id,"generation":1}), started, true),
            );
        }
        cells.insert(
            "wake".into(),
            cell(
                wake("wake", &operation(9)),
                started + Duration::from_millis(5),
                false,
            ),
        );
        let now = started + Duration::from_millis(10);
        let routine: HashMap<String, Class> = (0..3)
            .map(|index| (format!("busy{index}"), Class::Routine))
            .collect();
        assert_eq!(
            schedule(&cells, &Renewals::default(), &routine, now, 0, true),
            vec![("wake".to_string(), Class::Wake)]
        );
        cells.remove("wake");
        assert!(schedule(&cells, &Renewals::default(), &routine, now, 0, true).is_empty());
        assert_eq!(
            schedule(&cells, &Renewals::default(), &HashMap::new(), now, 0, true).len(),
            3
        );
        for index in 0..SLOTS {
            let id = format!("wake{index}");
            cells.insert(id.clone(), cell(wake(&id, &operation(index)), now, false));
        }
        cells.retain(|id, _| id.starts_with("wake"));
        let selected = schedule(&cells, &Renewals::default(), &HashMap::new(), now, 0, true);
        assert_eq!(selected.len(), SLOTS);
        assert!(
            selected
                .iter()
                .all(|(id, class)| *class == Class::Wake && id.starts_with("wake"))
        );
    }
    #[test]
    fn four_stuck_wakes_never_starve_a_due_renewal_or_routine_work() {
        let started = Instant::now();
        let mut cells = HashMap::new();
        for index in 0..4 {
            let id = format!("wake{index}");
            cells.insert(
                id.clone(),
                cell(wake(&id, &operation(index)), started, false),
            );
        }
        let mut renew = cell(json!({"id":"renew","generation":1}), started, true);
        renew.renew = true;
        cells.insert("renew".into(), renew);
        cells.insert(
            "routine".into(),
            cell(json!({"id":"routine","generation":1}), started, true),
        );
        let now = started + Duration::from_millis(10);
        // The renewal goes first like a protective stop; one slot stays with routine work.
        assert_eq!(
            schedule(&cells, &Renewals::default(), &HashMap::new(), now, 0, true),
            vec![
                ("renew".to_string(), Class::Storage),
                ("wake0".to_string(), Class::Wake),
                ("wake1".to_string(), Class::Wake),
                ("routine".to_string(), Class::Routine),
            ]
        );
        // Three wakes still running: the free slot goes to the due routine job, not the fourth.
        cells.remove("renew");
        let wakes: HashMap<String, Class> = (0..3)
            .map(|index| (format!("wake{index}"), Class::Wake))
            .collect();
        assert_eq!(
            schedule(&cells, &Renewals::default(), &wakes, now, 0, true),
            vec![("routine".to_string(), Class::Routine)]
        );
        // Each stuck wake backs off after its first not-ready results.
        let stuck = cells.get_mut("wake3").unwrap();
        let delays: Vec<_> = (0..11)
            .map(|_| {
                finish(stuck, now, None);
                stuck.due.duration_since(now).as_secs()
            })
            .collect();
        assert_eq!(delays, [1, 1, 1, 1, 1, 2, 4, 8, 16, 30, 30]);
        assert_eq!(class(stuck, &Renewals::default(), 0), Class::Wake);
    }
    #[test]
    fn only_a_power_operation_not_yet_observed_ready_is_a_wake() {
        let now = Instant::now();
        let mut database = cell(wake("db", &operation(1)), now, false);
        assert_eq!(class(&database, &Renewals::default(), 0), Class::Wake);
        finish(&mut database, now, Some(&json!({"state":"provisioning"})));
        assert_eq!(database.stalled, 1);
        finish(&mut database, now, Some(&json!({"state":"ready"})));
        assert!(database.ready);
        assert_eq!(database.stalled, 0);
        assert_eq!(database.due, now + Duration::from_secs(60));
        // A later configuration change or failed check of the woken database is routine work.
        database.ready = false;
        assert_eq!(class(&database, &Renewals::default(), 0), Class::Routine);
        finish(&mut database, now, None);
        assert_eq!(database.stalled, 0);
        assert_eq!(database.due, now + Duration::from_secs(1));
        // The next wake of the same database is a new power operation.
        database.db = wake("db", &operation(2));
        assert_eq!(class(&database, &Renewals::default(), 0), Class::Wake);
    }
    /// A deleted role is advanced one step per pass, so a ready database that still awaits a
    /// removal is looked at again within a second; one whose removals are confirmed or blocked
    /// keeps the steady cadence of a ready database.
    #[test]
    fn a_ready_database_with_a_removal_in_progress_is_due_again_in_a_second() {
        let now = Instant::now();
        let roles = json!([
            {"name":"app","owner":true,"password":"p".repeat(43),"revision":1},
            {"name":"gone_job","state":"absent"},
            {"name":"stuck_job","state":"absent"}
        ]);
        let maintenance = json!({"role":"pgcf_maintenance","password":"m".repeat(43),"revision":1});
        let mut database = cell(
            json!({"id":"db","generation":3,"roles":roles,"maintenance":maintenance}),
            now,
            false,
        );
        let ready = |roles: Value| json!({"state":"ready","roles":roles});
        // Neither removed nor blocked: pending.
        finish(
            &mut database,
            now,
            Some(&ready(json!({"removed":["gone_job"],"blocked":[]}))),
        );
        assert!(database.ready);
        assert_eq!(database.due, now + Duration::from_secs(1));
        finish(
            &mut database,
            now,
            Some(&ready(json!({"removed":[],"blocked":[]}))),
        );
        assert_eq!(database.due, now + Duration::from_secs(1));
        // Every removal settled: removed or blocked.
        finish(
            &mut database,
            now,
            Some(&ready(
                json!({"removed":["gone_job"],"blocked":["stuck_job"]}),
            )),
        );
        assert_eq!(database.due, now + Duration::from_secs(60));
        // A ready result that says nothing of the roles it still awaits leaves them pending.
        finish(&mut database, now, Some(&json!({"state":"ready"})));
        assert_eq!(database.due, now + Duration::from_secs(1));
        // A database that awaits no removal keeps the steady cadence.
        let mut plain = cell(
            json!({"id":"db","generation":3,"roles":[roles[0].clone()]}),
            now,
            false,
        );
        finish(&mut plain, now, Some(&json!({"state":"ready"})));
        assert_eq!(plain.due, now + Duration::from_secs(60));
        // Without the maintenance credential nothing can advance a removal: looking again each
        // second would change nothing, so the database keeps the steady cadence.
        let mut keyless = cell(json!({"id":"db","generation":3,"roles":roles}), now, false);
        finish(&mut keyless, now, Some(&json!({"state":"ready"})));
        assert_eq!(keyless.due, now + Duration::from_secs(60));
    }
    #[test]
    fn a_pod_change_of_a_ready_database_is_urgent_re_attestation() {
        let now = Instant::now();
        let mut cells = HashMap::from([(
            "db".to_string(),
            cell(json!({"id":"db","generation":1}), now, true),
        )]);
        let routine: HashMap<String, Class> = (0..3)
            .map(|index| (format!("busy{index}"), Class::Routine))
            .collect();
        // A Cluster or volume change of a ready database stays routine work.
        hinted(cells.get_mut("db").unwrap(), "Cluster", now);
        assert_eq!(class(&cells["db"], &Renewals::default(), 0), Class::Routine);
        assert!(schedule(&cells, &Renewals::default(), &routine, now, 0, true).is_empty());
        // A Pod change may have replaced the attested primary within the same revision: v3
        // routes to it are refused until re-attestation, which takes the last slot at once.
        hinted(cells.get_mut("db").unwrap(), "Pod", now);
        assert_eq!(class(&cells["db"], &Renewals::default(), 0), Class::Wake);
        assert_eq!(
            schedule(&cells, &Renewals::default(), &routine, now, 0, true),
            vec![("db".to_string(), Class::Wake)]
        );
        // It stays urgent, backing off like a wake, until a ready result re-attests it.
        let db = cells.get_mut("db").unwrap();
        finish(db, now, None);
        assert_eq!(class(db, &Renewals::default(), 0), Class::Wake);
        finish(db, now, Some(&json!({"state":"provisioning"})));
        assert_eq!(
            (class(db, &Renewals::default(), 0), db.stalled),
            (Class::Wake, 2)
        );
        finish(db, now, Some(&json!({"state":"ready"})));
        assert_eq!(class(db, &Renewals::default(), 0), Class::Routine);
        // A Pod change of a database that is not ready is already reconciled as due work.
        db.ready = false;
        hinted(db, "Pod", now);
        assert_eq!(class(db, &Renewals::default(), 0), Class::Routine);
    }
    /// How many passes of a database that does not come ready begin in `seconds` while one of its
    /// objects changes every `every` milliseconds (`kind` of them) and a pass takes `pass`.
    fn passes_while_objects_change(seconds: u64, every: u64, pass: u64, kind: &str) -> usize {
        let start = Instant::now();
        let mut entry = cell(wake("db", &operation(1)), start, false);
        // (millisecond the running pass ends, hint marker it began at, when it began)
        let mut running: Option<(u64, u64, Instant)> = None;
        let mut passes = 0;
        for ms in 0..seconds * 1000 {
            let now = start + Duration::from_millis(ms);
            if ms % every == 0 {
                hinted(&mut entry, kind, now);
            }
            if let Some((ends, marker, began)) = running
                && ms >= ends
            {
                settle(
                    &mut entry,
                    began,
                    Some(&json!({"state":"provisioning"})),
                    marker,
                );
                rehint(&mut entry, began, marker, now);
                running = None;
            }
            if running.is_none() && entry.due <= now {
                passes += 1;
                entry.started = Some(now);
                running = Some((ms + pass, entry.hints, now));
            }
        }
        passes
    }
    #[test]
    fn objects_that_change_all_the_time_do_not_make_a_database_pass_all_the_time() {
        // CNPG creating the Pod of a hibernated database changes objects of it twenty times a
        // second, and a pass takes a twentieth of one. Live, that was twenty full passes a second
        // (800 requests) for ten seconds, none of them with anything new to find.
        let passes = passes_while_objects_change(10, 50, 50, "Pod");
        assert!(
            passes <= 21,
            "{passes} passes in ten seconds: at most one in each half second"
        );
        // A change is still looked at at once when the database was left alone before it, and
        // the spacing counts from the pass that began last, not from the change.
        let now = Instant::now();
        let mut left_alone = cell(json!({"id":"db","generation":1}), now, true);
        left_alone.due = now + Duration::from_secs(60);
        left_alone.started = Some(now - Duration::from_secs(5));
        hinted(&mut left_alone, "Cluster", now);
        assert_eq!(left_alone.due, now);
        let mut looked_at = cell(json!({"id":"db","generation":1}), now, true);
        looked_at.due = now + Duration::from_secs(60);
        looked_at.started = Some(now - Duration::from_millis(100));
        hinted(&mut looked_at, "Cluster", now);
        assert_eq!(looked_at.due, now + Duration::from_millis(400));
        // A retry that is due sooner than the spacing is never put off by a change.
        looked_at.due = now + Duration::from_millis(100);
        hinted(&mut looked_at, "Cluster", now);
        assert_eq!(looked_at.due, now + Duration::from_millis(100));
        // And one that ran while the objects changed is due when the spacing ends, not at once.
        let marker = looked_at.hints;
        hinted(&mut looked_at, "Cluster", now);
        looked_at.due = now + Duration::from_secs(60);
        rehint(
            &mut looked_at,
            now - Duration::from_millis(100),
            marker,
            now,
        );
        assert_eq!(looked_at.due, now + Duration::from_millis(400));
    }
    #[test]
    fn the_log_names_what_hinted_a_database_once_a_second_and_nothing_of_it() {
        let line = hint_line(
            "dbbbbbbbbbbbbbbbbbbb",
            "ConfigMap",
            "storage-dbbbbbbbbbbbbbbbbbbb",
        );
        assert_eq!(
            line,
            json!({"event":"database_hinted","database_id":"dbbbbbbbbbbbbbbbbbbb","kind":"ConfigMap","name":"storage-dbbbbbbbbbbbbbbbbbbb"})
        );
        let now = Instant::now();
        let mut entry = cell(json!({"id":"db","generation":1}), now, true);
        assert!(hint_to_log(&mut entry, now));
        assert!(!hint_to_log(&mut entry, now + Duration::from_millis(900)));
        assert!(hint_to_log(&mut entry, now + Duration::from_millis(2000)));
    }
    #[test]
    fn a_watch_that_keeps_ending_is_asked_for_again_less_and_less_often_and_says_why() {
        // A baseline that cannot be completed ended the watch of a kind every second, silently,
        // and each end asked the API server to list the kind again and every database to be
        // pulled.
        let waits: Vec<_> = (1..=8)
            .map(|failures| watch_delay(failures).as_secs())
            .collect();
        assert_eq!(waits, [1, 2, 4, 8, 16, 30, 30, 30]);
        let line = watch_ended_line("Secret", &"watch baseline incomplete".into());
        assert_eq!(line["event"], "watch_ended");
        assert_eq!(line["kind"], "Secret");
        assert!(line["error"].is_string());
        assert_eq!(line.as_object().unwrap().len(), 3, "{line}");
    }
    #[test]
    fn a_wake_published_on_the_barrier_is_followed_by_a_full_pass_a_moment_later() {
        // The wake did not prove the roles, the archive or stamp the manifests: the pass that
        // does is due a second after the wake, not a minute.
        let now = Instant::now();
        let mut woken = cell(json!({"id":"db","generation":3}), now, true);
        settle(&mut woken, now, Some(&json!({"state":"ready"})), 0);
        assert_eq!(woken.due, now + Duration::from_secs(60));
        followed_up(&mut woken, now);
        assert_eq!(woken.due, now + Duration::from_secs(1));
        // A pass that is due sooner than that stays so.
        woken.due = now;
        followed_up(&mut woken, now);
        assert_eq!(woken.due, now);
    }
    #[test]
    fn a_wake_that_waits_for_a_proof_polls_with_backoff_and_not_busily() {
        // The cold wake of a thin database waited 37 s for the node's next identity proof: no
        // object changes, only the timer brings the next pass, and each is later than the one
        // before it.
        let start = Instant::now();
        let mut entry = cell(wake("db", &operation(1)), start, false);
        let mut began: Vec<Duration> = vec![];
        let mut now = start;
        while now < start + Duration::from_secs(37) {
            if entry.due <= now {
                began.push(now - start);
                entry.started = Some(now);
                let marker = entry.hints;
                settle(
                    &mut entry,
                    now,
                    Some(&json!({"state":"provisioning"})),
                    marker,
                );
                rehint(&mut entry, now, marker, now);
            }
            now += Duration::from_millis(10);
        }
        assert!(began.len() <= 11, "{} passes: {began:?}", began.len());
        let gaps: Vec<_> = began.windows(2).map(|pair| pair[1] - pair[0]).collect();
        assert!(
            gaps.windows(2)
                .all(|pair| pair[1] + Duration::from_millis(20) >= pair[0]),
            "{gaps:?}"
        );
    }
    #[test]
    fn a_pod_change_during_an_in_flight_check_keeps_re_attestation_urgent() {
        let now = Instant::now();
        let mut db = cell(json!({"id":"db","generation":1}), now, true);
        let started = db.hints;
        // The Pod changes while a check that began earlier runs; its ready result may still
        // name the replaced Pod, so it cannot complete the re-attestation.
        hinted(&mut db, "Pod", now);
        settle(&mut db, now, Some(&json!({"state":"ready"})), started);
        assert_eq!(class(&db, &Renewals::default(), 0), Class::Wake);
        finish(&mut db, now, Some(&json!({"state":"ready"})));
        assert_eq!(class(&db, &Renewals::default(), 0), Class::Routine);
    }
    #[test]
    fn a_first_failed_reconcile_retries_at_once_and_later_ones_back_off() {
        // A wake whose first pass met a Pod that was not yet reachable (host unreachable, a write
        // conflict) lost the full 2 s timer before the pass that finishes it.
        let delays: Vec<_> = (1..=6)
            .map(|attempt| reconcile_failure_delay(attempt).as_millis())
            .collect();
        assert_eq!(delays, [250, 2000, 4000, 8000, 16000, 32000]);
    }
    #[test]
    fn failing_renewals_back_off_instead_of_holding_every_slot() {
        let now = Instant::now();
        let mut cells = HashMap::new();
        for index in 0..SLOTS {
            let id = format!("renew{index}");
            let mut renewal = cell(json!({"id":id,"generation":1}), now, true);
            renewal.renew = true;
            let marker = renewal.hints;
            renewed(&mut renewal, now, false, marker, now);
            cells.insert(id, renewal);
        }
        cells.insert("wake".into(), cell(wake("wake", &operation(9)), now, false));
        // Shortly after every renewal failed, none is due again and the wake gets a slot.
        assert_eq!(
            schedule(
                &cells,
                &Renewals::default(),
                &HashMap::new(),
                now + Duration::from_millis(1500),
                0,
                true
            ),
            vec![("wake".to_string(), Class::Wake)]
        );
        // Repeated failures back off like a failed reconcile; a success resets the backoff.
        let renewal = cells.get_mut("renew0").unwrap();
        let delays: Vec<_> = (0..8)
            .map(|_| {
                let marker = renewal.hints;
                renewed(renewal, now, false, marker, now);
                renewal.due.duration_since(now).as_secs()
            })
            .collect();
        assert_eq!(delays, [4, 8, 16, 32, 64, 128, 256, 256]);
        let marker = renewal.hints;
        renewed(renewal, now, true, marker, now);
        assert!(!renewal.renew);
        assert_eq!(renewal.attempt, 0);
    }
    const NODE: &str = "01234567-89ab-4def-8123-000000000001";
    /// An `sa1` token of NODE with schema-valid claims; the controller never reads its signature.
    fn token(generation: u64, revision: u64, exp: u64) -> String {
        let claims = json!({"v":1,"kid":"cf","database_id":"db000000000000000001","generation":generation,"authority_revision":revision,"storage_uid":NODE,"node_uid":NODE,"volume_group_uuid":"abcdef-abcd-abcd-abcd-abcd-abcd-abcdef","pool_uuid":"bcdefg-bcde-bcde-bcde-bcde-bcde-bcdefg","profile_sha256":"f".repeat(64),"volume_handle":format!("pvc-{NODE}"),"lv_uuid":"cdefgh-cdef-cdef-cdef-cdef-cdef-cdefgh","pvc_uid":NODE,"pv_uid":NODE,"pod_uid":NODE,"observed_at":0,"iat":0,"exp":exp,"guard_seconds":10,"drain_seconds":10,"write_allowed":true});
        use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
        format!(
            "sa1.{}.c2ln",
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims).unwrap())
        )
    }
    fn renewal(revision: u64, write_allowed: bool, expires: &str, tokens: &[String]) -> Renewal {
        Renewal {
            node_uid: NODE.into(),
            revision,
            authority: json!({"node_uid":NODE,"revision":revision,"write_allowed":write_allowed,"expires_at":expires}),
            tokens: tokens
                .iter()
                .map(|token| ("db000000000000000001".to_string(), token.clone()))
                .collect(),
        }
    }
    #[test]
    fn a_fast_renewal_keeps_writes_between_pulls_and_an_older_one_never_wins() {
        let db = json!({"id":"db000000000000000001","generation":3,"desired_state":"running","storage":{"node_uid":NODE},"storage_authority":token(3,2,2000)});
        let mut state = snapshot(vec![]);
        state.region = json!({"storage_nodes":[{"node_uid":NODE,"revision":2,"write_allowed":true,"expires_at":"1970-01-01T00:00:02.000Z"}]});
        let mut renewals = Renewals::default();
        // The 60 s snapshot's authority and token lapse long before the next pull.
        assert!(storage_protection_due(&db, &state, &renewals, 5000));
        assert!(renewals.accept(
            renewal(4, true, "1970-01-01T00:00:10.000Z", &[token(3, 4, 10_000)]),
            0
        ));
        assert!(!storage_protection_due(&db, &state, &renewals, 5000));
        assert!(storage_protection_due(&db, &state, &renewals, 10_000));
        // An older renewal never replaces a newer one.
        assert!(!renewals.accept(renewal(3, false, "1970-01-01T00:00:20.000Z", &[]), 0));
        assert!(!storage_protection_due(&db, &state, &renewals, 5000));
        // A renewal's token of another generation never stands in for this one's.
        let mut woken = db.clone();
        woken["generation"] = 4.into();
        woken["storage_authority"] = Value::Null;
        assert!(storage_protection_due(&woken, &state, &renewals, 5000));
        // A newer snapshot entry wins again: here Cloudflare stopped allowing writes.
        state.region["storage_nodes"][0] = json!({"node_uid":NODE,"revision":5,"write_allowed":false,"expires_at":"1970-01-01T00:00:20.000Z"});
        assert!(storage_protection_due(&db, &state, &renewals, 5000));
    }
    #[test]
    fn writes_continue_while_the_newest_delivered_token_is_unexpired() {
        let db = json!({"id":"db000000000000000001","generation":3,"desired_state":"running","storage":{"node_uid":NODE},"storage_authority":token(3,2,2000)});
        let mut state = snapshot(vec![]);
        state.region = json!({"storage_nodes":[{"node_uid":NODE,"revision":2,"write_allowed":true,"expires_at":"1970-01-01T00:00:02.000Z"}]});
        let mut renewals = Renewals::default();
        renewals.accept(
            renewal(4, true, "1970-01-01T00:00:10.000Z", &[token(3, 4, 10_000)]),
            0,
        );
        // A later renewal without this database's token keeps the one already delivered,
        // as its ledger does, until it expires.
        renewals.accept(renewal(5, true, "1970-01-01T00:00:12.000Z", &[]), 0);
        assert!(!storage_protection_due(&db, &state, &renewals, 9_000));
        assert!(storage_protection_due(&db, &state, &renewals, 10_000));
        let (view, _) = renewals.effective(&db, &Arc::new(state));
        assert_eq!(view["storage_authority"], token(3, 4, 10_000));
        // Expired tokens leave the cache with the next renewal.
        renewals.accept(renewal(6, true, "1970-01-01T00:00:20.000Z", &[]), 10_000);
        assert!(renewals.tokens.is_empty());
    }
    #[test]
    fn an_omitted_sampling_target_revokes_cached_authority_and_tokens() {
        let db = json!({"id":"db000000000000000001","generation":3,"desired_state":"running","storage":{"node_uid":NODE},"storage_authority":token(3,2,2000)});
        let mut state = snapshot(vec![]);
        state.region = json!({"storage_nodes":[{"node_uid":NODE,"revision":2,"write_allowed":true,"expires_at":"1970-01-01T00:00:02.000Z"}]});
        state.region["storage_samples"] = json!([sampling_target()]);
        let older = state.clone();
        let mut renewals = Renewals::default();
        renewals.sync_targets(&state, &sampler_targets(&state));
        renewals.accept(
            renewal(4, true, "1970-01-01T00:00:10.000Z", &[token(3, 4, 10_000)]),
            0,
        );
        assert!(!storage_protection_due(&db, &state, &renewals, 5000));
        state.region["storage_nodes"] = json!([]);
        state.region["storage_samples"] = json!([]);
        renewals.sync_targets(&state, &sampler_targets(&state));
        assert!(storage_protection_due(&db, &state, &renewals, 5000));
        assert!(storage_protection_due(&db, &older, &renewals, 1000));
        assert!(renewals.nodes.is_empty());
        assert!(renewals.tokens.is_empty());
        let (_, effective) = renewals.effective(&db, &Arc::new(state));
        assert_eq!(effective.region["storage_nodes"], json!([]));
    }
    fn sampling_target() -> Value {
        json!({"node_id":format!("nod_{}", "x".repeat(20)),"node_uid":NODE,"name":"customer-node","period_milliseconds":2000,"qualification_run":null})
    }
    #[test]
    fn a_current_sampler_recovers_when_expired_authority_is_absent_from_desired() {
        let db = json!({"id":"db000000000000000001","generation":3,"desired_state":"running","storage":{"node_uid":NODE},"storage_authority":null});
        let mut state = snapshot(vec![]);
        state.region["storage_samples"] = json!([sampling_target()]);
        let mut renewals = Renewals::default();
        renewals.sync_targets(&state, &sampler_targets(&state));
        assert!(storage_protection_due(&db, &state, &renewals, 5000));
        assert!(renewals.accept(
            renewal(4, true, "1970-01-01T00:00:10.000Z", &[token(3, 4, 10_000)]),
            5000,
        ));
        assert!(!storage_protection_due(&db, &state, &renewals, 5000));
        let (_, effective) = renewals.effective(&db, &Arc::new(state));
        assert_eq!(effective.region["storage_nodes"][0]["revision"], 4);
    }
    #[tokio::test]
    async fn replacing_a_sampler_drops_its_queued_reply_before_it_can_restore_authority() {
        let mut state = snapshot(vec![]);
        state.region["storage_samples"] = json!([sampling_target()]);
        let wanted = sampler_targets(&state);
        let (node, source) = wanted.iter().next().unwrap();
        let (sender, replies) = mpsc::channel(1);
        let task = tokio::spawn(std::future::pending::<()>());
        let mut samplers = HashMap::from([(
            node.clone(),
            Sampling {
                started_for: source.clone(),
                task: task.id(),
                abort: task.abort_handle(),
                replies,
            },
        )]);
        let mut renewals = Renewals::default();
        renewals.sync_targets(&state, &wanted);
        sender
            .send(renewal(
                4,
                true,
                "1970-01-01T00:00:10.000Z",
                &[token(3, 4, 10_000)],
            ))
            .await
            .unwrap();
        poll_renewals(&mut samplers, &mut renewals, 0);
        assert!(!renewals.nodes.is_empty());
        sender
            .send(renewal(
                5,
                true,
                "1970-01-01T00:00:12.000Z",
                &[token(3, 5, 12_000)],
            ))
            .await
            .unwrap();
        // A changed period represents a new sampling target, even with the same Node UID.
        state.region["storage_samples"][0]["period_milliseconds"] = 4000.into();
        let replacement = sampler_targets(&state);
        renewals.sync_targets(&state, &replacement);
        retain_samplers(&mut samplers, &replacement);
        poll_renewals(&mut samplers, &mut renewals, 0);
        assert!(sender.is_closed());
        assert!(samplers.is_empty());
        assert!(renewals.nodes.is_empty());
        assert!(renewals.tokens.is_empty());
        assert!(task.await.unwrap_err().is_cancelled());
    }
    #[test]
    fn jobs_run_on_the_newest_token_and_node_authority() {
        let db = json!({"id":"db000000000000000001","generation":3,"desired_state":"running","storage":{"node_uid":NODE},"storage_authority":token(3,2,2000)});
        let mut state = snapshot(vec![]);
        state.region = json!({"backup":{},"storage_nodes":[{"node_uid":NODE,"revision":2,"write_allowed":true}]});
        let state = Arc::new(state);
        let mut renewals = Renewals::default();
        let (view, effective) = renewals.effective(&db, &state);
        assert_eq!((&view, Arc::ptr_eq(&effective, &state)), (&db, true));
        renewals.accept(
            renewal(4, false, "1970-01-01T00:00:10.000Z", &[token(3, 4, 10_000)]),
            0,
        );
        let (view, effective) = renewals.effective(&db, &state);
        assert_eq!(view["storage_authority"], token(3, 4, 10_000));
        assert_eq!(
            effective.region["storage_nodes"],
            json!([renewal(4, false, "1970-01-01T00:00:10.000Z", &[]).authority])
        );
        assert_eq!(effective.region["backup"], json!({}));
        // The renewed write state is the host state a snapshot is compared under.
        assert_eq!(
            host_write_state(&db, &state, &renewals)["write_allowed"],
            false
        );
    }
    #[test]
    fn runtime_lease_rotation_is_not_a_configuration_change() {
        let db = json!({"id":"a","generation":1,"storage_authority":"old"});
        let mut new = db.clone();
        new["storage_authority"] = "renewed".into();
        assert_eq!(
            fingerprint(&db, &snapshot(vec![])).unwrap(),
            fingerprint(&new, &snapshot(vec![])).unwrap()
        );
    }
    #[test]
    fn a_completed_wake_is_due_again_when_its_proof_renews_and_not_before() {
        // The pass of the wake met no change of anyone else: the cell was not hinted while it
        // ran, so the pass settles at the marker it started at. Nothing is due then until the
        // attestation has to be renewed, which is inside its lifetime.
        let start = Instant::now();
        let wall = clock_ms();
        let ttl = pgcf_native_controller::contracts::constant("DATABASE_RUNTIME_PROOF_MAX_AGE_MS")
            .as_u64()
            .unwrap();
        let mut entry = cell(wake("db", &operation(1)), start, false);
        let marker = entry.hints;
        settle(
            &mut entry,
            start,
            Some(
                &json!({"state":"ready","runtime_attestation":{"v":2,"observation":{"expires_at":u64::try_from(wall).unwrap()+ttl}}}),
            ),
            marker,
        );
        assert!(entry.ready);
        let cells = HashMap::from([("db".to_owned(), entry)]);
        let due = |second: u64| {
            schedule(
                &cells,
                &Renewals::default(),
                &HashMap::new(),
                start + Duration::from_secs(second),
                wall + i128::from(second * 1000),
                true,
            )
        };
        let renews = ttl / 1000 / 2;
        for second in [0, 1, renews / 2, renews - 1] {
            assert!(due(second).is_empty(), "due at {second} s");
        }
        assert_eq!(
            due(renews + 1),
            vec![("db".to_owned(), Class::Routine)],
            "the attestation is renewed before it expires"
        );
        assert!(renews + 1 < ttl / 1000);
    }
    #[test]
    fn v2_verification_expires_unless_continuous_token_renewals_leave_reconcile_due() {
        let start = Instant::now();
        let wall = clock_ms();
        let ttl = pgcf_native_controller::contracts::constant("DATABASE_RUNTIME_PROOF_MAX_AGE_MS")
            .as_u64()
            .unwrap();
        let mut entry = cell(
            json!({"id":"db","generation":1,"desired_state":"running"}),
            start,
            true,
        );
        finish(
            &mut entry,
            start,
            Some(
                &json!({"state":"ready","runtime_attestation":{"v":2,"observation":{"expires_at":u64::try_from(wall).unwrap()+ttl}}}),
            ),
        );
        let mut saw_routine = false;
        let mut cells = HashMap::from([("db".to_owned(), entry)]);
        for second in 1..=(ttl / 1000) {
            let now = start + Duration::from_secs(second);
            let entry = cells.get_mut("db").unwrap();
            entry.renew = true;
            entry.due = now;
            entry.hints += 1;
            let marker = entry.hints;
            renewed(entry, now, true, marker, now);
            let selected = schedule(
                &cells,
                &Renewals::default(),
                &HashMap::new(),
                now,
                wall + i128::from(second * 1000),
                true,
            );
            if !selected.is_empty() {
                assert_eq!(selected, vec![("db".to_owned(), Class::Routine)]);
                assert!(
                    second * 1000 < ttl,
                    "verification starts within the actual proof lifetime"
                );
                let entry = cells.get_mut("db").unwrap();
                entry.renew = true;
                assert!(
                    next_kind(
                        entry,
                        &Renewals::default(),
                        wall + i128::from(second * 1000),
                        now
                    ) == JobKind::Reconcile
                );
                let busy = HashMap::from([("db".to_owned(), Class::Routine)]);
                assert!(
                    schedule(
                        &cells,
                        &Renewals::default(),
                        &busy,
                        now,
                        wall + i128::from(second * 1000),
                        true
                    )
                    .is_empty()
                );
                cells.get_mut("db").unwrap().db["storage"] =
                    json!({"node_uid":"missing-authority"});
                assert!(
                    next_kind(
                        &cells["db"],
                        &Renewals::default(),
                        wall + i128::from(second * 1000),
                        now
                    ) == JobKind::Protect
                );
                assert_eq!(
                    schedule(
                        &cells,
                        &Renewals::default(),
                        &HashMap::new(),
                        now,
                        wall + i128::from(second * 1000),
                        true
                    ),
                    vec![("db".to_owned(), Class::Storage)]
                );
                saw_routine = true;
                break;
            }
        }
        assert!(
            saw_routine,
            "token-only delivery cannot refresh the actual CF V2 proof whose fixed TTL expires"
        );
    }
}
