// SPDX-License-Identifier: Apache-2.0
use futures_util::{SinkExt, StreamExt};
use pgcf_native_controller::{
    Error,
    api::{ControlApi, DesiredSnapshot},
    contracts::{constant, desired_valid, integer, number, removal_roles, schema_valid, text},
    diagnostics::error_code,
    kubernetes::Kubernetes,
    measurements::Measurements,
    node_storage::{Renewal, Sampler, driver_image, sample_node},
    pool::{PoolWork, TicketOutcome},
    power::GatewayPod,
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
    /// A wake's hint with the desired page of its one database, and when it arrived.
    Desired(String, DesiredSnapshot, Instant),
    /// A watched database object changed: its database ID, the object kind and the object's name.
    Kube(String, &'static str, String),
    /// A gateway Pod delivered a wake its client waits on (pool design 2026-10-16).
    Wake(GatewayPod, pgcf_native_protocol::wake::WakeRequest),
    /// An object of a pool slot changed: the slot's hex.
    Slot(String),
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
    /// When the pending wake first reported not ready.
    wake_since: Option<Instant>,
    /// A Pod change of the ready database awaits a fresh runtime attestation.
    reattest: bool,
    /// Actual V2 proof expiry is independent of token-only ledger deliveries.
    verification_due: Option<Instant>,
    /// When the latest pass of the database began: a change of its objects makes the next one due
    /// no sooner than `HINT_SPACING` after it.
    started: Option<Instant>,
    /// When the log last named what hinted the database.
    hint_logged: Option<Instant>,
    /// A pool slot serves the database, or served it and no row pulled since has been applied:
    /// only a lapse of its node's write authority protects it.
    served: bool,
    /// A pool slot serves the database now: its start hold is not refreshed.
    slot: bool,
    /// When a pool slot stopped serving the database, until a row pulled since has been applied.
    unserved_at: Option<Instant>,
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum JobKind {
    Reconcile,
    Renew,
    Protect,
    /// The decision about a wake a gateway delivered, and a hit's release.
    Wake,
    /// The retirement of a pool slot that served the database.
    Unwind,
}
impl JobKind {
    /// Whether a job of this kind runs to its end whatever changes meanwhile: a cut-off claim or
    /// retirement of a pool slot would leave the slot to be retired again.
    fn uninterrupted(self) -> bool {
        matches!(self, Self::Wake | Self::Unwind)
    }
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
        if let Some(job) = active.get(&id).filter(|job| !job.kind.uninterrupted()) {
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
                if let Some(job) = active.get(&id).filter(|job| !job.kind.uninterrupted()) {
                    job.abort.abort();
                }
                cell.ready = false;
                cell.verification_due = None;
                cell.renew = false;
                cell.attempt = 0;
                cell.stalled = 0;
                cell.wake_since = None;
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
                    wake_since: None,
                    reattest: false,
                    verification_due: None,
                    started: None,
                    hint_logged: None,
                    served: false,
                    slot: false,
                    unserved_at: None,
                },
            );
        }
    }
    Ok(())
}
/// A `desired` link message. A wake's hint may carry the desired page of its one database, read
/// right after the claim committed: valid for this region and naming exactly that database, it is
/// taken like the page a targeted pull of it reads. Anything else is the pull, as before.
fn desired_hint(message: &Value, page: Option<Value>, region: &str, received: Instant) -> Hint {
    let ids: Option<Vec<String>> = message["ids"].as_array().map(|ids| {
        ids.iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect()
    });
    if let (Some(page), Some([id])) = (page, ids.as_deref())
        && page["next"].is_null()
        && desired_valid(&page, region)
        && page["databases"]
            .as_array()
            .is_some_and(|rows| rows.len() == 1 && text(&rows[0], "id") == id)
    {
        return Hint::Desired(
            id.clone(),
            DesiredSnapshot {
                region: page["region"].clone(),
                fleet_release: page["fleet_release"].clone(),
                databases: page["databases"].as_array().cloned().unwrap_or_default(),
            },
            received,
        );
    }
    Hint::Pull(ids)
}
/// Whether a hinted page stands in for the pull: only when it moves a database the controller
/// holds to a newer revision, so its row was read after the commit the held one predates. A page
/// of the same or an older revision, or of a database not held, is left to the targeted pull.
fn hint_advances(cells: &HashMap<String, Cell>, snapshot: &DesiredSnapshot) -> bool {
    !snapshot.databases.is_empty()
        && snapshot.databases.iter().all(|db| {
            cells
                .get(text(db, "id"))
                .is_some_and(|cell| number(db, "generation") > number(&cell.db, "generation"))
        })
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
/// Whether the database is to be protected now. A database a pool slot serves is protected only
/// when its node's write authority lapsed: start holds and write tokens are the miss path's, its
/// own Pod's (rule 6.7).
fn storage_protection_due(
    db: &Value,
    snapshot: &DesiredSnapshot,
    renewals: &Renewals,
    clock: i128,
    served: bool,
) -> bool {
    served_protection_reason(db, snapshot, renewals, clock, served).is_some()
}
fn served_protection_reason(
    db: &Value,
    snapshot: &DesiredSnapshot,
    renewals: &Renewals,
    clock: i128,
    served: bool,
) -> Option<StorageProtectionReason> {
    storage_protection_reason(db, snapshot, renewals, clock).filter(|reason| {
        !served
            || matches!(
                reason,
                StorageProtectionReason::AuthorityMissing
                    | StorageProtectionReason::AuthorityRevoked
                    | StorageProtectionReason::AuthorityExpiryInvalid
                    | StorageProtectionReason::AuthorityExpired
            )
    })
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
/// Fast node headroom is not permission to extend its cached expiry locally. A database a pool
/// slot serves gets no writer token and is never protected for its hold (rule 6.7): its hold is
/// not refreshed.
fn startup_refresh_due(db: &Value, renewals: &Renewals, clock: i128, served: bool) -> bool {
    let hold = &db["storage_startup"];
    if served
        || db["storage"].is_null()
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
/// Follows whether a pool slot serves the database. Its start hold is not refreshed while a slot
/// serves it, so once the slot stopped serving it the cached hold is stale: the database stays
/// protected only for its node's authority until a row pulled since then has been applied.
/// `true` when the slot stopped serving it now: its row is to be pulled.
fn track_slot(cell: &mut Cell, serves: bool, now: Instant) -> bool {
    let left = cell.slot && !serves;
    cell.slot = serves;
    if serves {
        cell.unserved_at = None;
    } else if left {
        cell.unserved_at = Some(now);
    } else if cell.unserved_at.is_some_and(|at| cell.authority_at >= at) {
        cell.unserved_at = None;
    }
    cell.served = serves || cell.unserved_at.is_some();
    left
}
fn preempt_storage(
    db: &Value,
    snapshot: &DesiredSnapshot,
    renewals: &Renewals,
    clock: i128,
    kind: JobKind,
    served: bool,
) -> bool {
    kind != JobKind::Protect
        && !kind.uninterrupted()
        && storage_protection_due(db, snapshot, renewals, clock, served)
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
    if storage_protection_due(&cell.db, &cell.snapshot, renewals, clock, cell.served)
        || (cell.renew && cell.ready)
    {
        Class::Storage
    } else if waking(cell) {
        Class::Wake
    } else {
        Class::Routine
    }
}
/// How long a pending wake is polled each second whatever the passes before: a cold wake waits
/// for the node's next identity proof about twenty seconds, and the passes that CNPG's Pod
/// changes cause while the Pod is created would otherwise have used up the backoff by then.
const WAKE_POLL: Duration = Duration::from_secs(60);
/// A pending wake retries each second for its first minute; later not-ready results back off to
/// 30 s, so stuck wakes cannot hold the slots. A Kubernetes hint still retries at once.
fn not_ready_delay(stalled: u32, waited: Duration) -> Duration {
    Duration::from_secs(if waited < WAKE_POLL || stalled <= 5 {
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
/// The delay after a failed reconcile of `error`. A runtime proof that changed while its target was
/// published is a race with the kubelet's status of the Pod the wake resumed and is met by another
/// pass at once, up to four times; a proof that keeps changing is a fault and backs off.
fn reconcile_retry(error: &Error, attempt: u32) -> Duration {
    if attempt <= 4 && error_code(error).starts_with("runtime_proof_changed_") {
        Duration::from_millis(250)
    } else {
        reconcile_failure_delay(attempt)
    }
}
fn stale_snapshot_retry(cell: &mut Cell, now: Instant) {
    cell.attempt = 0;
    cell.stalled = 0;
    cell.wake_since = None;
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
    if storage_protection_due(&cell.db, &cell.snapshot, renewals, clock, cell.served) {
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
            cell.wake_since = None;
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
            let since = *cell.wake_since.get_or_insert(started);
            not_ready_delay(cell.stalled, started.saturating_duration_since(since))
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
            let protect =
                storage_protection_due(&cell.db, &cell.snapshot, renewals, clock, cell.served);
            (cell.due <= now || verification_due(cell, now) || (cell.ready && protect))
                && (protect
                    || (control_healthy
                        && now.duration_since(cell.authority_at) <= Duration::from_secs(90)))
                && !busy.contains_key(*id)
        })
        .map(|(id, cell)| {
            let protect =
                storage_protection_due(&cell.db, &cell.snapshot, renewals, clock, cell.served);
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
            let bound=constant("LINK_MESSAGE_MAX_BYTES").as_u64().and_then(|bytes|usize::try_from(bytes).ok()).ok_or("regional link bound unknown")?;
            let config=WebSocketConfig::default().max_message_size(Some(bound)).max_frame_size(Some(bound));
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
                                let mut value:Value=serde_json::from_str(&bytes)?;
                                // A wake's page is judged on its own: one that is not taken is pulled, the link stays.
                                let page=value.as_object_mut().and_then(|message|message.remove("desired"));
                                if !schema_valid("ServerLinkMessage",&value){return Err("regional link message invalid".into());}
                                match text(&value,"type") {
                                    "welcome" if !welcome && page.is_none() => { welcome=true;hints.send(Hint::Pull(None)).await.map_err(|_|"controller queue closed")?; },
                                    "desired" if welcome => { hints.send(desired_hint(&value,page,&api.region,Instant::now())).await.map_err(|_|"controller queue closed")?; },
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
                    let mut sent = Ok(());
                    if let Some(slot) = trigger.slot {
                        sent = hints.send(Hint::Slot(slot)).await;
                    }
                    if sent.is_ok() && !trigger.database.is_empty() {
                        sent = hints
                            .send(Hint::Kube(trigger.database, kind, trigger.name))
                            .await;
                    }
                    if sent.is_err() {
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
    // The gateways' wakes reach the loop as hints (pool design 2026-10-16).
    {
        let (wakes, mut delivered) = mpsc::channel(256);
        let controller = controller.clone();
        tokio::task::spawn_local(async move {
            controller.pool.intake.run(&controller.power, wakes).await;
        });
        let hints = hints.clone();
        tokio::task::spawn_local(async move {
            while let Some((pod, wake)) = delivered.recv().await {
                if hints.send(Hint::Wake(pod, wake)).await.is_err() {
                    return;
                }
            }
        });
    }
    // The slots and serving facts of the cluster are known before anything is scheduled.
    loop {
        match controller.pool.rediscover(&controller).await {
            Ok(_) => break,
            Err(error) => {
                eprintln!(
                    "{}",
                    json!({"event":"pool_rediscovery_failed","error":error_code(&error)})
                );
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        }
    }
    if controller.pool.publish_keys(&controller).await.is_err() {
        eprintln!("{{\"event\":\"attach_keys_unpublished\"}}");
    }
    let mut pool_tasks: JoinSet<Option<String>> = JoinSet::new();
    let mut refills: JoinSet<()> = JoinSet::new();
    let mut pool_interval = tokio::time::interval(Duration::from_secs(1));
    let mut unwinding_after: HashMap<String, Instant> = HashMap::new();
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
                {
                    let controller = controller.clone();
                    pool_tasks.spawn_local(async move {
                        if controller.pool.publish_keys(&controller).await.is_err() {
                            eprintln!("{{\"event\":\"attach_keys_unpublished\"}}");
                        }
                        for (node, (free, creating, serving)) in controller.pool.states() {
                            timing::emit_event(timing::pool_state_event(&node, free, creating, serving));
                        }
                        None
                    });
                }
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
            _ = pool_interval.tick() => {
                if control_healthy && have_full_snapshot && refills.is_empty()
                    && let Some((_, snapshot)) = latest_snapshot.clone()
                {
                    let controller = controller.clone();
                    let dbs: Vec<Value> = cells.values().map(|cell| cell.db.clone()).collect();
                    refills.spawn_local(async move {
                        // What the request path reads is read here, off it.
                        let ready = controller.pool.refresh(&controller).await;
                        let work = controller.pool.refill_work(&dbs, ready, Instant::now().into_std());
                        let done = futures_util::future::join_all(work.iter().map(|step| async {
                            match step {
                                PoolWork::Create(spec) => controller.pool.create_slot(&controller, &snapshot, spec).await,
                                PoolWork::Discard(hex) => controller.pool.discard(hex).await,
                            }
                        })).await;
                        if done.iter().any(Result::is_err) {
                            eprintln!("{{\"event\":\"pool_refill_failed\"}}");
                        }
                    });
                }
            },
            _ = refills.join_next(), if !refills.is_empty() => {},
            result = pool_tasks.join_next(), if !pool_tasks.is_empty() => {
                // A slot that serves a database and changed is retired by an Unwind job.
                if let Some(Ok(Some(id))) = result {
                    unwinding_after.remove(&id);
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
                    Some(Hint::Desired(id, snapshot, received)) => {
                        if cells.get(&id).is_some_and(|cell| cell.db["desired_state"] == "suspended") {
                            timing::point("wake_hint_received", &id);
                        }
                        if hint_advances(&cells, &snapshot) {
                            // Taken like the result of a targeted pull of this database begun when the hint arrived.
                            if latest_snapshot.as_ref().is_none_or(|(at,_)|received>=*at) {
                                let latest = Arc::new(snapshot.clone());
                                sync_samplers(&mut samplers, &mut sampling, &latest, (&kube, &api, &mut renewals));
                                latest_snapshot=Some((received,latest));
                            }
                            apply_snapshot(&mut cells, &active, &renewals, snapshot, Some(std::slice::from_ref(&id)), received)?;
                            timing::point("desired_from_hint", &id);
                        } else {
                            pull_ids.insert(id);
                        }
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
                    Some(Hint::Slot(hex)) => {
                        let controller = controller.clone();
                        pool_tasks.spawn_local(async move {
                            controller.pool.observe(&hex).await.ok().flatten()
                        });
                    },
                    Some(Hint::Wake(pod, wake)) => {
                        timing::point("wake_delivered", &wake.database);
                        controller.pool.delivered(&pod, &wake);
                        let id = wake.database.clone();
                        // A routine pass gives way to the wake; a wake or a storage job of the
                        // database already running is the wake in progress.
                        let busy = match active.get(&id) {
                            Some(job) if job.class == Class::Routine && job.kind == JobKind::Reconcile => {
                                job.abort.abort();
                                active.remove(&id);
                                false
                            }
                            Some(_) => true,
                            None => false,
                        };
                        let cell = cells.get_mut(&id);
                        let known = cell.as_ref().map(|cell| {
                            let (db, snapshot) = renewals.effective(&cell.db, &cell.snapshot);
                            (db, snapshot, cell.hints)
                        });
                        let started = Instant::now();
                        let controller = controller.clone();
                        if busy || known.is_none() {
                            // Decided at once, by no job of the database.
                            pool_tasks.spawn_local(async move {
                                let cell = known.as_ref().map(|(db, snapshot, _)| (db, snapshot.as_ref()));
                                let _ = controller.pool.wake(&controller, cell, &wake, busy).await;
                                None
                            });
                            continue;
                        }
                        if let Some(cell) = cell {
                            cell.started = Some(started);
                        }
                        let (db, snapshot, marker) = known.unwrap();
                        let generation = number(&db, "generation");
                        let job_id = id.clone();
                        let abort = jobs.spawn_local(async move {
                            let result = controller
                                .pool
                                .wake(&controller, Some((&db, &snapshot)), &wake, false)
                                .await;
                            (job_id, generation, marker, started, JobKind::Wake, result)
                        });
                        active.insert(id, Active { task: abort.id(), abort, kind: JobKind::Wake, class: Class::Wake });
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
                                    cell.due = Instant::now() + reconcile_retry(&error, cell.attempt);
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
        // What Cloudflare's rows say of the pool's tickets; a confirmed wake's row is due at once.
        for (id, outcome) in controller.pool.confirm_tickets(
            |id| cells.get(id).map(|cell| &cell.db),
            Instant::now().into_std(),
        ) {
            if outcome == TicketOutcome::Confirmed
                && let Some(cell) = cells.get_mut(&id)
            {
                cell.due = Instant::now();
            }
        }
        let now = Instant::now();
        for (id, cell) in cells.iter_mut() {
            if track_slot(cell, controller.pool.serves(id), now) {
                pull_ids.insert(id.clone());
            }
        }
        // Slots to be retired, one Unwind job each, again a second after one that did not end it.
        let now = Instant::now();
        for id in controller.pool.unwinding() {
            if active.contains_key(&id)
                || unwinding_after.get(&id).is_some_and(|after| *after > now)
            {
                continue;
            }
            unwinding_after.insert(id.clone(), now + Duration::from_secs(1));
            let cell = cells.get(&id);
            let db = cell.map(|cell| cell.db.clone());
            let generation = db.as_ref().map_or(0, |db| number(db, "generation"));
            let marker = cell.map_or(0, |cell| cell.hints);
            let controller = controller.clone();
            let job_id = id.clone();
            let abort = jobs.spawn_local(async move {
                let result = controller
                    .pool
                    .unwind(&controller, &job_id, db.as_ref())
                    .await
                    .map(|_| None);
                (job_id, generation, marker, now, JobKind::Unwind, result)
            });
            active.insert(
                id,
                Active {
                    task: abort.id(),
                    abort,
                    kind: JobKind::Unwind,
                    class: Class::Storage,
                },
            );
        }

        let read_at = Instant::now();
        startup_reads.retain(|id, _| cells.contains_key(id));
        for (id, cell) in &cells {
            if !targeted_pulls.contains(id)
                && startup_reads.get(id).is_none_or(|after| *after <= read_at)
                && startup_refresh_due(&cell.db, &renewals, clock_ms(), cell.slot)
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
                preempt_storage(
                    &cell.db,
                    &cell.snapshot,
                    &renewals,
                    clock_ms(),
                    job.kind,
                    cell.served,
                )
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
                let protection = served_protection_reason(
                    &cell.db,
                    &cell.snapshot,
                    &renewals,
                    clock_ms(),
                    cell.served,
                );
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
                            return controller.protect_storage(&db).await;
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
            wake_since: None,
            reattest: false,
            verification_due: None,
            started: None,
            hint_logged: None,
            served: false,
            slot: false,
            unserved_at: None,
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
        assert!(!startup_refresh_due(&db, &Renewals::default(), 4000, false));
        assert!(startup_refresh_due(&db, &Renewals::default(), 5000, false));
        assert!(startup_refresh_due(&db, &Renewals::default(), 10000, false));
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
    #[test]
    fn a_slot_served_database_never_pulls_its_start_hold_again() {
        // A pool hit's claim leaves a start hold, and write tokens are the database's own Pod's,
        // not the slot's (rule 6.7). Refreshing the hold pulled the row every second for as long
        // as the database was served and Cloudflare had not taken a ready report.
        let db = json!({"id":"db","generation":2,"desired_state":"running","storage":{"node_uid":"same","guard_seconds":10},"storage_startup":{"operation_id":operation(2),"generation":2,"node_uid":"same","budget_bytes":5368709120_u64,"expires_at":"1970-01-01T00:00:10.000Z"}});
        for clock in [5000, 10000, 60000] {
            assert!(!startup_refresh_due(&db, &Renewals::default(), clock, true));
        }
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
            JobKind::Reconcile,
            false
        ));
        state.region["storage_nodes"][0]["write_allowed"] = false.into();
        assert!(preempt_storage(
            &db,
            &state,
            &renewals,
            2000,
            JobKind::Reconcile,
            false
        ));
        if preempt_storage(&db, &state, &renewals, 2000, JobKind::Reconcile, false) {
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
            JobKind::Reconcile,
            false
        ));
        assert!(!preempt_storage(
            &db,
            &state,
            &renewals,
            2000,
            JobKind::Protect,
            false
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
            1000,
            false
        ));
        assert!(storage_protection_due(
            &db,
            &state,
            &Renewals::default(),
            2000,
            false
        ));
        assert!(storage_protection_due(
            &db,
            &state,
            &Renewals::default(),
            3000,
            false
        ));
        state.region["storage_nodes"][0]["write_allowed"] = false.into();
        assert!(storage_protection_due(
            &db,
            &state,
            &Renewals::default(),
            1000,
            false
        ));
    }
    #[test]
    fn a_database_a_slot_stops_serving_keeps_its_stale_hold_unread_until_its_row_is_pulled_again() {
        // While a slot served the database, its start hold was not refreshed: the cached expiry
        // is long past when the slot is retired (a restarted slot Pod, a configuration change, a
        // refuted ticket), and the database's own Cluster takes it over.
        let db = json!({"id":"db000000000000000001","generation":3,"desired_state":"running","storage":{"node_uid":NODE,"guard_seconds":10},"storage_startup":{"generation":3,"node_uid":NODE,"expires_at":"1970-01-01T00:00:02.000Z"}});
        let mut state = snapshot(vec![]);
        state.region = json!({"storage_nodes":[{"node_uid":NODE,"write_allowed":true,"expires_at":"1970-01-01T00:01:40.000Z"}]});
        let renewals = Renewals::default();
        let clock = 50_000;
        let pulled = Instant::now();
        let mut served = cell(db, pulled, false);
        served.snapshot = Arc::new(state);
        assert!(!track_slot(&mut served, true, pulled));
        assert!(!startup_refresh_due(
            &served.db,
            &renewals,
            clock,
            served.slot
        ));
        assert!(next_kind(&served, &renewals, clock, pulled) == JobKind::Reconcile);
        // The slot stops serving it: its row is pulled at once, and until a row pulled since then
        // is applied, the stale hold neither aborts the takeover nor dispatches a protection.
        let left = pulled + Duration::from_secs(30);
        assert!(track_slot(&mut served, false, left));
        assert!(startup_refresh_due(
            &served.db,
            &renewals,
            clock,
            served.slot
        ));
        assert_ne!(class(&served, &renewals, clock), Class::Storage);
        assert!(next_kind(&served, &renewals, clock, left) == JobKind::Reconcile);
        assert!(!preempt_storage(
            &served.db,
            &served.snapshot,
            &renewals,
            clock,
            JobKind::Reconcile,
            served.served
        ));
        // A row pulled before the slot stopped serving it says nothing newer.
        served.authority_at = left - Duration::from_millis(1);
        assert!(!track_slot(
            &mut served,
            false,
            left + Duration::from_millis(5)
        ));
        assert!(next_kind(&served, &renewals, clock, left) == JobKind::Reconcile);
        // A row pulled since then that still holds the expired hold protects it.
        served.authority_at = left + Duration::from_millis(10);
        assert!(!track_slot(
            &mut served,
            false,
            left + Duration::from_millis(20)
        ));
        assert_eq!(class(&served, &renewals, clock), Class::Storage);
        assert!(next_kind(&served, &renewals, clock, left) == JobKind::Protect);
        // Served again, it is protected only for its node's authority.
        assert!(!track_slot(
            &mut served,
            true,
            left + Duration::from_secs(1)
        ));
        assert!(next_kind(&served, &renewals, clock, left) == JobKind::Reconcile);
    }
    #[test]
    fn a_slot_served_database_is_protected_only_for_node_authority_not_for_start_tokens() {
        // A served database's slot holds the volume under the node's write authority; the
        // startup hold and the write tokens are its own Pod's, on the miss path.
        let mut db = json!({"id":"db000000000000000001","generation":3,"desired_state":"running","storage":{"node_uid":NODE},"storage_startup":{"generation":3,"node_uid":NODE,"expires_at":"1970-01-01T00:00:02.000Z"}});
        let mut state = snapshot(vec![]);
        state.region = json!({"storage_nodes":[{"node_uid":NODE,"write_allowed":true,"expires_at":"1970-01-01T00:00:03.000Z"}]});
        let renewals = Renewals::default();
        assert!(storage_protection_due(&db, &state, &renewals, 2000, false));
        assert!(!storage_protection_due(&db, &state, &renewals, 2000, true));
        db["storage_startup"] = Value::Null;
        assert_eq!(
            served_protection_reason(&db, &state, &renewals, 1000, false)
                .map(StorageProtectionReason::code),
            Some("startup_missing")
        );
        assert_eq!(
            served_protection_reason(&db, &state, &renewals, 1000, true),
            None
        );
        db["storage_authority"] = token(3, 1, 500).into();
        assert!(!storage_protection_due(&db, &state, &renewals, 1000, true));
        // The node's authority lapses or is revoked: served or not, the database is protected.
        assert_eq!(
            served_protection_reason(&db, &state, &renewals, 3000, true)
                .map(StorageProtectionReason::code),
            Some("authority_expired")
        );
        state.region["storage_nodes"][0]["write_allowed"] = false.into();
        assert_eq!(
            served_protection_reason(&db, &state, &renewals, 1000, true)
                .map(StorageProtectionReason::code),
            Some("authority_revoked")
        );
        state.region["storage_nodes"] = json!([]);
        assert!(storage_protection_due(&db, &state, &renewals, 1000, true));
        // A wake or a retirement of a slot runs to its end: a protection waits for it.
        assert!(!preempt_storage(
            &db,
            &state,
            &renewals,
            1000,
            JobKind::Wake,
            true
        ));
        assert!(!preempt_storage(
            &db,
            &state,
            &renewals,
            1000,
            JobKind::Unwind,
            true
        ));
        assert!(preempt_storage(
            &db,
            &state,
            &renewals,
            1000,
            JobKind::Reconcile,
            true
        ));
    }
    #[tokio::test]
    async fn a_changed_desired_row_does_not_cut_off_a_wake_or_a_slot_retirement() {
        let now = Instant::now();
        let mut cells = HashMap::new();
        let db = json!({"id":"db","generation":3,"desired_state":"suspended","power":{"operation":operation(3),"revision":3,"mode":"quiesce","reason":"idle"}});
        cells.insert("db".to_string(), cell(db.clone(), now, true));
        let mut active = HashMap::new();
        let mut tasks = JoinSet::new();
        for kind in [JobKind::Wake, JobKind::Reconcile] {
            let abort = tasks.spawn(std::future::pending::<()>());
            active.insert(
                "db".to_string(),
                Active {
                    task: abort.id(),
                    abort: abort.clone(),
                    kind,
                    class: Class::Wake,
                },
            );
            // Cloudflare's row of the wake arrives while the job runs.
            let mut woken = db.clone();
            woken["generation"] = 4.into();
            woken["desired_state"] = "running".into();
            woken["power"] =
                json!({"operation":operation(4),"revision":4,"mode":"running","reason":null});
            apply_snapshot(
                &mut cells,
                &active,
                &Renewals::default(),
                snapshot(vec![woken]),
                None,
                Instant::now(),
            )
            .unwrap();
            tokio::task::yield_now().await;
            assert_eq!(
                abort.is_finished(),
                kind == JobKind::Reconcile,
                "{}",
                kind == JobKind::Wake
            );
            cells.insert("db".to_string(), cell(db.clone(), now, true));
        }
        tasks.abort_all();
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
        // Each stuck wake polls each second for its first minute and backs off after it.
        let stuck = cells.get_mut("wake3").unwrap();
        finish(stuck, now, None);
        assert_eq!(stuck.due.duration_since(now).as_secs(), 1);
        let late = now + WAKE_POLL + Duration::from_secs(1);
        let delays: Vec<_> = (0..11)
            .map(|_| {
                finish(stuck, late, None);
                stuck.due.duration_since(late).as_secs()
            })
            .collect();
        assert_eq!(delays, [1, 1, 1, 1, 2, 4, 8, 16, 30, 30, 30]);
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
    fn a_wake_that_waits_for_a_proof_polls_each_second_for_a_minute_and_then_backs_off() {
        // The cold wake of a thin database waited 30 s for the node's next identity proof although
        // the proof was accepted 18 s into the wait: the passes CNPG's Pod changes had caused
        // while the Pod was created had used up the backoff, so the first timer-driven pass after
        // the proof was thirty seconds away. No object changes while it waits, only the timer
        // brings the next pass.
        let start = Instant::now();
        let mut entry = cell(wake("db", &operation(1)), start, false);
        let marker = entry.hints;
        let pending = json!({"state":"provisioning"});
        // A dozen passes in the first two seconds, as the Pod changes cause them.
        for step in 0..12 {
            settle(
                &mut entry,
                start + Duration::from_millis(step * 150),
                Some(&pending),
                marker,
            );
        }
        let mut began: Vec<Duration> = vec![];
        let mut now = start + Duration::from_secs(2);
        while now < start + Duration::from_secs(300) {
            if entry.due <= now {
                began.push(now - start);
                entry.started = Some(now);
                settle(&mut entry, now, Some(&pending), marker);
            }
            now += Duration::from_millis(10);
        }
        let gaps: Vec<_> = began.windows(2).map(|pair| pair[1] - pair[0]).collect();
        let first_minute: Vec<_> = began
            .iter()
            .zip(&gaps)
            .filter(|(at, _)| **at < Duration::from_secs(59))
            .map(|(_, gap)| *gap)
            .collect();
        assert!(first_minute.len() >= 50, "{first_minute:?}");
        assert!(
            first_minute
                .iter()
                .all(|gap| *gap <= Duration::from_millis(1100)),
            "{first_minute:?}"
        );
        // After the minute the pending wake backs off so stuck wakes cannot hold the slots.
        let late = began
            .iter()
            .filter(|at| **at > Duration::from_secs(62))
            .count();
        assert!(late <= 9, "{late} passes after the first minute: {began:?}");
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
    fn a_proof_that_changed_while_its_target_was_published_is_retried_at_once() {
        // The kubelet's status of a resumed Pod arrives between forming the runtime proof and
        // publishing its target: live that failed a parked wake twice in a row and the second
        // failure waited the 2 s step (4.5 s and 4.8 s against 2.2 s).
        let raced: Error = "runtime proof changed during target publication".into();
        let other: Error = "something else failed".into();
        let at_once: Vec<_> = (1..=4)
            .map(|attempt| reconcile_retry(&raced, attempt).as_millis())
            .collect();
        assert_eq!(at_once, [250, 250, 250, 250]);
        // A proof that keeps changing is a fault, not a race: the backoff takes over.
        assert_eq!(reconcile_retry(&raced, 5), reconcile_failure_delay(5));
        // Every other failure keeps its schedule.
        assert_eq!(reconcile_retry(&other, 2), reconcile_failure_delay(2));
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
        assert!(storage_protection_due(&db, &state, &renewals, 5000, false));
        assert!(renewals.accept(
            renewal(4, true, "1970-01-01T00:00:10.000Z", &[token(3, 4, 10_000)]),
            0
        ));
        assert!(!storage_protection_due(&db, &state, &renewals, 5000, false));
        assert!(storage_protection_due(
            &db, &state, &renewals, 10_000, false
        ));
        // An older renewal never replaces a newer one.
        assert!(!renewals.accept(renewal(3, false, "1970-01-01T00:00:20.000Z", &[]), 0));
        assert!(!storage_protection_due(&db, &state, &renewals, 5000, false));
        // A renewal's token of another generation never stands in for this one's.
        let mut woken = db.clone();
        woken["generation"] = 4.into();
        woken["storage_authority"] = Value::Null;
        assert!(storage_protection_due(
            &woken, &state, &renewals, 5000, false
        ));
        // A newer snapshot entry wins again: here Cloudflare stopped allowing writes.
        state.region["storage_nodes"][0] = json!({"node_uid":NODE,"revision":5,"write_allowed":false,"expires_at":"1970-01-01T00:00:20.000Z"});
        assert!(storage_protection_due(&db, &state, &renewals, 5000, false));
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
        assert!(!storage_protection_due(
            &db, &state, &renewals, 9_000, false
        ));
        assert!(storage_protection_due(
            &db, &state, &renewals, 10_000, false
        ));
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
        assert!(!storage_protection_due(&db, &state, &renewals, 5000, false));
        state.region["storage_nodes"] = json!([]);
        state.region["storage_samples"] = json!([]);
        renewals.sync_targets(&state, &sampler_targets(&state));
        assert!(storage_protection_due(&db, &state, &renewals, 5000, false));
        assert!(storage_protection_due(&db, &older, &renewals, 1000, false));
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
        assert!(storage_protection_due(&db, &state, &renewals, 5000, false));
        assert!(renewals.accept(
            renewal(4, true, "1970-01-01T00:00:10.000Z", &[token(3, 4, 10_000)]),
            5000,
        ));
        assert!(!storage_protection_due(&db, &state, &renewals, 5000, false));
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
    /// A wake's hint message for the first builder vector, and its desired page for region `eu-test`.
    fn hinted_wake() -> (Value, Value) {
        let vectors: Value = serde_json::from_str(include_str!(
            "../../../packages/contracts/native/controller-vectors.generated.json"
        ))
        .unwrap();
        let mut db = vectors[1]["db"].clone();
        db["generation"] = 3.into();
        db["power"] = json!({"operation":operation(3),"revision":3,"mode":"running","reason":null});
        let page = json!({"region":{"id":"eu-test","backup":{"bucket":"native-controller-test","endpoint_url":"https://backup.example.invalid","region":"auto"}},"databases":[db],"next":null});
        (json!({"type":"desired","ids":[db["id"]]}), page)
    }
    fn hinted_page(hint: Hint) -> Option<(String, DesiredSnapshot, Instant)> {
        match hint {
            Hint::Desired(id, snapshot, received) => Some((id, snapshot, received)),
            _ => None,
        }
    }
    #[test]
    fn a_wake_hint_carries_its_page_only_when_it_is_valid_for_its_one_database() {
        let (message, page) = hinted_wake();
        let id = message["ids"][0].as_str().unwrap().to_string();
        let received = Instant::now();
        let (hinted, snapshot, at) = hinted_page(desired_hint(
            &message,
            Some(page.clone()),
            "eu-test",
            received,
        ))
        .unwrap();
        assert_eq!(hinted, id);
        assert_eq!(at, received);
        assert_eq!(
            snapshot.databases,
            page["databases"].as_array().unwrap().clone()
        );
        assert_eq!(snapshot.region, page["region"]);
        assert!(snapshot.fleet_release.is_null());
        // Anything else is the targeted pull of the IDs, as a hint without a page has always been.
        let mut invalid = page.clone();
        invalid["databases"][0]["roles"] = json!([]);
        let mut other = page.clone();
        other["databases"][0]["id"] = "dccccccccccccccccccc".into();
        let mut paged = page.clone();
        paged["next"] = "dccccccccccccccccccc".into();
        let two = json!({"type":"desired","ids":[id,"dccccccccccccccccccc"]});
        for (message, page, region) in [
            (&message, Some(invalid), "eu-test"),
            (&message, Some(other), "eu-test"),
            (&message, Some(paged), "eu-test"),
            (&message, Some(page.clone()), "eu-other"),
            (&two, Some(page.clone()), "eu-test"),
            (&message, None, "eu-test"),
        ] {
            match desired_hint(message, page, region, received) {
                Hint::Pull(Some(ids)) => assert_eq!(Value::from(ids), message["ids"]),
                _ => panic!("a page that is not taken asks for the pull"),
            }
        }
    }
    #[test]
    fn a_hinted_page_that_advances_a_known_database_makes_it_due_without_a_pull() {
        let (message, page) = hinted_wake();
        let id = message["ids"][0].as_str().unwrap().to_string();
        let asleep = Instant::now();
        let mut cells = HashMap::new();
        let mut sleeping = page["databases"][0].clone();
        sleeping["generation"] = 2.into();
        sleeping["desired_state"] = "suspended".into();
        sleeping["power"] =
            json!({"operation":operation(2),"revision":2,"mode":"quiesce","reason":"idle"});
        apply_snapshot(
            &mut cells,
            &HashMap::new(),
            &Renewals::default(),
            snapshot(vec![sleeping]),
            None,
            asleep,
        )
        .unwrap();
        cells.get_mut(&id).unwrap().due = asleep + Duration::from_secs(60);
        let received = asleep + Duration::from_millis(5);
        let (_, hinted, _) =
            hinted_page(desired_hint(&message, Some(page), "eu-test", received)).unwrap();
        // Taken, the loop applies it as a targeted pull of the database begun when it arrived.
        assert!(hint_advances(&cells, &hinted));
        apply_snapshot(
            &mut cells,
            &HashMap::new(),
            &Renewals::default(),
            hinted,
            Some(std::slice::from_ref(&id)),
            received,
        )
        .unwrap();
        assert_eq!(cells[&id].db["generation"], 3);
        assert_eq!(cells[&id].authority_at, received);
        assert!(cells[&id].due <= Instant::now());
        assert!(waking(&cells[&id]));
    }
    #[test]
    fn a_stale_or_unknown_hinted_page_is_left_to_the_pull() {
        let (message, page) = hinted_wake();
        let started = Instant::now();
        for held in [None, Some(3), Some(4)] {
            let mut cells = HashMap::new();
            if let Some(generation) = held {
                let mut db = page["databases"][0].clone();
                db["generation"] = generation.into();
                db["power"]["revision"] = generation.into();
                db["power"]["operation"] = operation(generation as usize).into();
                apply_snapshot(
                    &mut cells,
                    &HashMap::new(),
                    &Renewals::default(),
                    snapshot(vec![db]),
                    None,
                    started,
                )
                .unwrap();
            }
            let (_, hinted, _) = hinted_page(desired_hint(
                &message,
                Some(page.clone()),
                "eu-test",
                started + Duration::from_millis(5),
            ))
            .unwrap();
            // Not taken, the loop pulls the database as it did for every hint before.
            assert!(!hint_advances(&cells, &hinted), "{held:?}");
        }
    }
    #[test]
    fn the_periodic_pull_after_a_hinted_page_still_repairs_it() {
        let (message, page) = hinted_wake();
        let id = message["ids"][0].as_str().unwrap().to_string();
        let started = Instant::now();
        let mut cells = HashMap::new();
        let mut sleeping = page["databases"][0].clone();
        sleeping["generation"] = 2.into();
        apply_snapshot(
            &mut cells,
            &HashMap::new(),
            &Renewals::default(),
            snapshot(vec![sleeping]),
            None,
            started,
        )
        .unwrap();
        let received = started + Duration::from_millis(5);
        let (_, hinted, _) = hinted_page(desired_hint(
            &message,
            Some(page.clone()),
            "eu-test",
            received,
        ))
        .unwrap();
        assert!(hint_advances(&cells, &hinted));
        apply_snapshot(
            &mut cells,
            &HashMap::new(),
            &Renewals::default(),
            hinted,
            Some(std::slice::from_ref(&id)),
            received,
        )
        .unwrap();
        // A pull begun before the hint arrived never undoes it; one begun after it is the repair.
        let mut older = page["databases"][0].clone();
        older["size"]["max_connections"] = 99.into();
        apply_snapshot(
            &mut cells,
            &HashMap::new(),
            &Renewals::default(),
            snapshot(vec![older.clone()]),
            None,
            started + Duration::from_millis(1),
        )
        .unwrap();
        assert_eq!(cells[&id].db, page["databases"][0]);
        apply_snapshot(
            &mut cells,
            &HashMap::new(),
            &Renewals::default(),
            snapshot(vec![older.clone()]),
            None,
            received + Duration::from_secs(60),
        )
        .unwrap();
        assert_eq!(cells[&id].db, older);
        apply_snapshot(
            &mut cells,
            &HashMap::new(),
            &Renewals::default(),
            snapshot(vec![]),
            None,
            received + Duration::from_secs(120),
        )
        .unwrap();
        assert!(!cells.contains_key(&id));
    }
}
