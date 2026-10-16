// SPDX-License-Identifier: Apache-2.0
//! The pool of free PostgreSQL instances (pool design 2026-10-16): free CNPG slots on each node,
//! fenced from creation; a wake of a sleeping thin database attaches its volume to a free slot,
//! binds the slot to the tenant and lifts the fence. The slot is that database until it sleeps,
//! and is discarded afterwards.
use crate::{
    Error,
    api::DesiredSnapshot,
    attach_protocol::{
        self, Action, Agent, AttachRequest, AttachResponse, CallError, Control, Holder,
        HoldersRequest, HoldersResponse, InspectRequest, InspectResponse, Keys, ReleaseRequest,
        ReleaseResponse, Volume,
    },
    contracts::{configuration_fingerprint, number, optional_number, text},
    intake::Intake,
    kubernetes::Kubernetes,
    manifests,
    power::{Basis, GatewayPod, PowerCoordinator, PowerIntent, Sleep, SlotSleep},
    reconcile::Reconciler,
};
use base64::{Engine, engine::general_purpose::STANDARD};
use pgcf_native_protocol::wake::{
    Outcome, REASONS, SLOT_NAMESPACE_PREFIX, WakeRequest, WakeResult, slot_tls_name,
};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashMap},
    net::SocketAddr,
    sync::Mutex,
    time::{Duration, Instant},
};

/// Free (or being created) slots each node with a thin database keeps.
pub const FREE_SLOTS_PER_NODE: usize = 4;
/// A slot that is not free this long after its creation began is deleted.
pub const SLOT_READY_BOUND: Duration = Duration::from_secs(120);
/// How long a node waits after a deleted late slot before it creates the next.
pub const SLOT_RETRY_AFTER: Duration = Duration::from_secs(30);
/// The annotation of the storage receipt `pgcf-system/storage-<db>` that records a clean sleep.
pub const SLEEP_RECORD: &str = "pgcf.io/sleep-record";
/// The annotation of a claimed slot Cluster that names the claim.
pub const CLAIM: &str = "pgcf.io/claim";
pub(crate) const SLOT_LABEL: &str = "pgcf.io/slot";
const FENCE: &str = "cnpg.io/fencedInstances";
const FENCE_ALL: &str = "[\"*\"]";
const HIBERNATION: &str = "cnpg.io/hibernation";
const DATABASE_LABEL: &str = "pgcf.io/database-id";
const SYSTEM: &str = "pgcf-system";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Via {
    Slot,
    Cnpg,
}
/// What a clean sleep left on the volume: the data directory's identity, and the configuration
/// and image it slept under.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SleepRecord {
    pub v: u8,
    pub system_identifier: String,
    pub timeline: u32,
    pub configuration_sha256: String,
    pub image: String,
    pub written_at_ms: u64,
    pub via: Via,
}
impl SleepRecord {
    pub fn parse(text: &str) -> Option<Self> {
        if text.len() > 4096 {
            return None;
        }
        let record: Self = serde_json::from_str(text).ok()?;
        record.valid().then_some(record)
    }
    fn valid(&self) -> bool {
        self.v == 1
            && (1..=20).contains(&self.system_identifier.len())
            && self.system_identifier.bytes().all(|b| b.is_ascii_digit())
            && self.timeline >= 1
            && self.configuration_sha256.len() == 64
            && self
                .configuration_sha256
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            && manifests::pinned_image(&self.image)
            && self.written_at_ms <= 9_007_199_254_740_991
    }
    pub fn encode(&self) -> String {
        serde_json::to_string(self).expect("sleep record serializes")
    }
    /// Whether `control` is the data directory the record was written from.
    pub fn matches(&self, control: &Control) -> bool {
        control.system_identifier == self.system_identifier && control.timeline == self.timeline
    }
}
/// The claim a slot Cluster carries while it serves a database.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Claim {
    pub v: u8,
    pub database: String,
    pub operation: String,
    pub generation: u64,
    pub claimed_at_ms: u64,
}
/// The limits and settings a node's slots are created with.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Shape {
    pub cpu_millicores: u64,
    pub memory_mib: u64,
    pub max_connections: u64,
    pub archive_timeout_seconds: u64,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SlotState {
    Creating {
        since: Instant,
    },
    Free,
    /// Serves the database it names.
    Claimed(String),
    Discarding,
}
/// The running instance of a slot: its Pod, its address and its two containers.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SlotPod {
    pub uid: String,
    pub ip: String,
    /// containerd IDs, 64 lowercase hex digits.
    pub postgres: String,
    pub sidecar: String,
}
#[derive(Clone, Debug)]
pub struct Slot {
    pub hex: String,
    pub node: String,
    pub state: SlotState,
    pub image: String,
    pub cpu_millicores: u64,
    pub memory_mib: u64,
    pub pod: Option<SlotPod>,
    pub created: Instant,
}
/// A released pool hit that D1 has yet to confirm.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Ticket {
    pub database: String,
    pub operation: String,
    pub generation: u64,
    pub released_at: Instant,
    pub deadline: Instant,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TicketOutcome {
    Confirmed,
    Refuted,
    Expired,
}
impl Ticket {
    pub fn new(database: &str, operation: &str, generation: u64, released_at: Instant) -> Self {
        Self {
            database: database.into(),
            operation: operation.into(),
            generation,
            released_at,
            deadline: released_at
                + Duration::from_millis(pgcf_native_protocol::wake::TICKET_LEASE_MS),
        }
    }
    /// What the database's cached desired row says of the ticket at `now`; `None` while it says
    /// nothing yet.
    pub fn outcome(&self, cell: Option<&Value>, now: Instant) -> Option<TicketOutcome> {
        if let Some(cell) = cell {
            let generation = number(cell, "generation");
            if generation == self.generation
                && text(cell, "desired_state") == "running"
                && text(&cell["power"], "operation") == self.operation
            {
                return Some(TicketOutcome::Confirmed);
            }
            if generation >= self.generation {
                return Some(TicketOutcome::Refuted);
            }
        }
        (now > self.deadline).then_some(TicketOutcome::Expired)
    }
}
/// What started a wake decision: a gateway's queued wake (D1 not yet confirmed) or a desired row
/// whose wake D1 already committed.
#[derive(Clone, Copy)]
pub enum Trigger<'a> {
    Gateway(&'a WakeRequest),
    Desired,
}
/// Everything the decision reads, gathered before it.
pub struct Facts<'a> {
    pub trigger: Trigger<'a>,
    /// The database's cached desired row.
    pub cell: Option<&'a Value>,
    /// The generation of a storage protection marker of the database.
    pub protection: Option<u64>,
    /// The database sleeps: its sleep completed and its own Cluster is hibernated.
    pub asleep: bool,
    /// A ticket of another operation or generation is pending for it.
    pub busy: bool,
    /// The volume identity its storage receipt records.
    pub identity: Option<&'a Value>,
    /// Its gateway fence holds a power record with an anchor.
    pub power_record: bool,
    pub record: Option<&'a SleepRecord>,
    /// The image it runs under.
    pub image: &'a str,
    /// `sleep_fingerprint` of the desired row.
    pub fingerprint: &'a str,
    /// The node-wide Cloudflare write authority is current.
    pub authority: bool,
    /// Every gateway Pod answered a wake poll since this controller started.
    pub gateways_ready: bool,
    /// The free slots of the database's node.
    pub slots: Vec<&'a Slot>,
    pub headroom: bool,
}
/// A hit's slot and the volume it attaches.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Choice {
    pub slot: String,
    pub volume: Volume,
}
/// Decides a wake by the table of the build spec (rows 1-16, first failing row wins).
pub fn decide(facts: &Facts) -> Result<Choice, (Outcome, &'static str)> {
    let miss = |reason| Err((Outcome::Miss, reason));
    let Some(cell) = facts.cell else {
        return miss("no_desired_row");
    };
    let generation = number(cell, "generation");
    if text(cell, "desired_state") == "deleted" {
        return Err((Outcome::Refused, "deleted"));
    }
    if let Some(protected) = facts.protection {
        return if protected >= generation {
            Err((Outcome::Refused, "protected"))
        } else {
            miss("protected")
        };
    }
    let power = &cell["power"];
    let sleeping = text(cell, "desired_state") == "suspended"
        && text(power, "reason") == "idle"
        && !text(power, "operation").is_empty();
    let woken = text(cell, "desired_state") == "running" && text(power, "mode") == "running";
    let wanted = match facts.trigger {
        Trigger::Gateway(wake) => {
            sleeping
                || (woken
                    && generation == wake.generation
                    && text(power, "operation") == wake.operation)
        }
        Trigger::Desired => woken,
    };
    if !wanted || !facts.asleep {
        return miss("not_sleeping");
    }
    if facts.busy {
        return miss("wake_in_progress");
    }
    let admission = &cell["admission"];
    if admission.is_null() {
        return miss("desired_stale");
    }
    if let Trigger::Gateway(wake) = facts.trigger {
        let roles = crate::contracts::present_roles(cell)
            .map(|role| (text(role, "name"), number(role, "revision")));
        if wake.route_revision != number(admission, "route_revision")
            || wake.role_revision_hash != pgcf_native_protocol::wake::role_revision_hash(roles)
            || (sleeping && wake.generation != generation + 1)
        {
            return miss("desired_stale");
        }
    }
    let storage = &cell["storage"];
    if storage.is_null() {
        return miss("thick_storage");
    }
    let volume = facts.identity.map(|identity| Volume {
        lv_name: text(identity, "handle").into(),
        lv_uuid: text(identity, "lvUuid").into(),
        vg_uuid: text(storage, "volume_group_uuid").into(),
    });
    let Some(volume) = volume.filter(Volume::valid) else {
        return miss("volume_identity_missing");
    };
    if !facts.power_record {
        return miss("no_power_record");
    }
    let Some(record) = facts.record else {
        return miss("no_sleep_record");
    };
    if record.image != facts.image {
        return miss("image_changed");
    }
    if record.configuration_sha256 != facts.fingerprint {
        return miss("configuration_changed");
    }
    if !facts.authority {
        return miss("write_authority");
    }
    if !facts.gateways_ready {
        return miss("gateways_not_ready");
    }
    let (cpu, memory) = (
        number(&cell["size"], "cpu_millicores"),
        number(&cell["size"], "memory_mib"),
    );
    let Some(slot) = facts
        .slots
        .iter()
        .filter(|slot| {
            slot.state == SlotState::Free
                && slot.image == facts.image
                && slot.cpu_millicores >= cpu
                && slot.memory_mib >= memory
        })
        .min_by(|a, b| {
            (a.memory_mib, a.cpu_millicores, &a.hex).cmp(&(b.memory_mib, b.cpu_millicores, &b.hex))
        })
    else {
        return miss("no_free_slot");
    };
    if !facts.headroom {
        return miss("no_headroom");
    }
    Ok(Choice {
        slot: slot.hex.clone(),
        volume,
    })
}
/// The largest thin class of `node`: the limits its slots are created with.
pub fn slot_shape<'a>(node: &str, dbs: impl IntoIterator<Item = &'a Value>) -> Option<Shape> {
    dbs.into_iter()
        .filter(|db| db["node"] == node && !db["storage"].is_null())
        .map(|db| &db["size"])
        .fold(None, |shape: Option<Shape>, size| {
            let next = Shape {
                cpu_millicores: number(size, "cpu_millicores"),
                memory_mib: number(size, "memory_mib"),
                max_connections: number(size, "max_connections"),
                archive_timeout_seconds: number(size, "archive_timeout_seconds"),
            };
            Some(match shape {
                None => next,
                Some(held) => Shape {
                    cpu_millicores: held.cpu_millicores.max(next.cpu_millicores),
                    memory_mib: held.memory_mib.max(next.memory_mib),
                    max_connections: held.max_connections.max(next.max_connections),
                    archive_timeout_seconds: held
                        .archive_timeout_seconds
                        .max(next.archive_timeout_seconds),
                },
            })
        })
}
/// The memory a claim adds to its node: the class request above the request of the free slot.
pub fn headroom_need(db: &Value) -> u64 {
    let size = &db["size"];
    // The sidecar requests the same in a slot as in the database's own Pod.
    optional_number(size, "memory_request_mib", number(size, "memory_mib"))
        .saturating_sub(SLOT_REQUEST_MEMORY_MIB)
}
/// The memory a free slot's `postgres` container requests.
const SLOT_REQUEST_MEMORY_MIB: u64 = 128;
fn mebibytes(value: &Value) -> Option<f64> {
    crate::reconcile::quantity(value).map(|bytes| bytes / 1_048_576.0)
}
/// Whether `node` has `need_mib` of allocatable memory that no request of a non-terminal Pod on
/// it takes.
pub fn memory_headroom(node: &Value, pods: &[Value], need_mib: u64) -> bool {
    let Some(allocatable) = mebibytes(&node["status"]["allocatable"]["memory"]) else {
        return false;
    };
    let name = &node["metadata"]["name"];
    let taken: f64 = pods
        .iter()
        .filter(|pod| pod["spec"]["nodeName"] == *name && !crate::kubernetes::terminal_pod(pod))
        .flat_map(|pod| {
            let containers = pod["spec"]["containers"].as_array().into_iter().flatten();
            let sidecars = pod["spec"]["initContainers"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|c| c["restartPolicy"] == "Always");
            containers.chain(sidecars)
        })
        .filter_map(|c| mebibytes(&c["resources"]["requests"]["memory"]))
        .sum();
    allocatable - taken >= need_mib as f64
}
/// The configuration a sleep is recorded under: the configuration fingerprint without the
/// request fields that depend on whether the desired row runs.
pub fn sleep_fingerprint(db: &Value, fallback_image: &str) -> Result<String, Error> {
    let mut view = db.clone();
    if let Some(size) = view["size"].as_object_mut() {
        size.remove("memory_request_mib");
        size.remove("cpu_request_millicores");
    }
    configuration_fingerprint(&view, fallback_image)
}
/// `sleep_fingerprint` without the roles and the maintenance credential: what a role-only change
/// leaves as it is.
pub fn structure_fingerprint(db: &Value, fallback_image: &str) -> Result<String, Error> {
    let mut view = db.clone();
    view["roles"] = Value::Array(vec![]);
    view["maintenance"] = Value::Null;
    sleep_fingerprint(&view, fallback_image)
}
/// The one Cluster patch of a claim: the database label, the claim, the fence lifted and the
/// tenant's parameters.
pub fn claim_patch(db: &Value, claim: &Claim) -> Value {
    serde_json::json!({"metadata":{"labels":{DATABASE_LABEL:claim.database},"annotations":{CLAIM:serde_json::to_string(claim).expect("claim serializes"),FENCE:null}},"spec":{"postgresql":{"parameters":manifests::parameters(db)}}})
}
/// The running instance a slot Pod is, when both containers run.
pub fn slot_pod(pod: &Value) -> Option<SlotPod> {
    let running = |statuses: &Value, name: &str| {
        statuses
            .as_array()?
            .iter()
            .find(|c| c["name"] == name)
            .filter(|c| c["state"]["running"].is_object() && c["restartCount"] == 0)
            .and_then(|c| text(c, "containerID").strip_prefix("containerd://"))
            .filter(|id| {
                id.len() == 64
                    && id
                        .bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            })
            .map(str::to_string)
    };
    let ip = text(&pod["status"], "podIP");
    let private = ip.parse::<std::net::IpAddr>().is_ok_and(|ip| match ip {
        std::net::IpAddr::V4(v) => v.is_private(),
        std::net::IpAddr::V6(v) => v.is_unique_local(),
    });
    if text(&pod["status"], "phase") != "Running"
        || !pod["metadata"]["deletionTimestamp"].is_null()
        || text(&pod["metadata"], "uid").is_empty()
        || !private
    {
        return None;
    }
    Some(SlotPod {
        uid: text(&pod["metadata"], "uid").into(),
        ip: ip.into(),
        postgres: running(&pod["status"]["containerStatuses"], "postgres")?,
        sidecar: running(
            &pod["status"]["initContainerStatuses"],
            "plugin-barman-cloud",
        )?,
    })
}
/// Whether a slot is free: its Pod runs fenced on a private address with both containers never
/// restarted, under `image`, and its CA exists.
pub fn slot_free(
    namespace: &Value,
    cluster: &Value,
    pod: &Value,
    ca: Option<&Value>,
    image: &str,
) -> bool {
    namespace["metadata"]["deletionTimestamp"].is_null()
        && !text(&namespace["metadata"]["labels"], SLOT_LABEL).is_empty()
        && cluster["metadata"]["deletionTimestamp"].is_null()
        && crate::power::fenced(cluster)
        && cluster["metadata"]["annotations"][CLAIM].is_null()
        && cluster["spec"]["imageName"] == image
        && pod["spec"]["containers"]
            .as_array()
            .and_then(|all| all.iter().find(|c| c["name"] == "postgres"))
            .is_some_and(|c| c["image"] == image)
        && slot_pod(pod).is_some()
        && ca.is_some_and(|ca| ca["metadata"]["deletionTimestamp"].is_null())
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Refill {
    Create(String),
    Discard(String, &'static str),
}
/// What the pool does next for its free slots.
pub fn refill(
    slots: &[&Slot],
    shapes: &BTreeMap<String, Shape>,
    image: &str,
    gateways_ready: bool,
    retry: &HashMap<String, Instant>,
    now: Instant,
) -> Vec<Refill> {
    let mut plan = vec![];
    let mut held: HashMap<&str, (usize, bool)> = HashMap::new();
    for slot in slots {
        match &slot.state {
            SlotState::Creating { since }
                if now.saturating_duration_since(*since) > SLOT_READY_BOUND =>
            {
                // The node waits for the retry its caller sets.
                held.entry(&slot.node).or_default().1 = true;
                plan.push(Refill::Discard(slot.hex.clone(), "not_free_in_time"));
            }
            SlotState::Creating { .. } => {
                let entry = held.entry(&slot.node).or_default();
                entry.0 += 1;
                entry.1 = true;
            }
            SlotState::Free => {
                let current = slot.image == image
                    && shapes.get(&slot.node).is_none_or(|shape| {
                        slot.cpu_millicores >= shape.cpu_millicores
                            && slot.memory_mib >= shape.memory_mib
                    });
                if current {
                    held.entry(&slot.node).or_default().0 += 1;
                } else {
                    plan.push(Refill::Discard(slot.hex.clone(), "replaced"));
                }
            }
            SlotState::Claimed(_) | SlotState::Discarding => {}
        }
    }
    if gateways_ready {
        for node in shapes.keys() {
            let (count, creating) = held.get(node.as_str()).copied().unwrap_or_default();
            if !creating
                && count < FREE_SLOTS_PER_NODE
                && retry.get(node).is_none_or(|at| *at <= now)
            {
                plan.push(Refill::Create(node.clone()));
            }
        }
    }
    plan
}

// ---------------------------------------------------------------------------------------------
// The node agents.

/// The controller's access to the node agents `pgcf-attach`, which keep the single-writer rule of
/// thin volumes: at most one holder per volume, taken only while the kernel reports it closed.
pub struct Attach {
    k8s: Kubernetes,
    pub(crate) client: attach_protocol::Client,
}
impl Attach {
    pub fn new(k8s: Kubernetes) -> Result<Self, Error> {
        Ok(Self {
            k8s,
            client: attach_protocol::Client::new(crate::cluster_http(Duration::from_secs(15))?),
        })
    }
    /// Every Ready agent.
    pub async fn agents(&self) -> Result<Vec<Agent>, Error> {
        Ok(self
            .k8s
            .list_cached(
                "Pod",
                Some(attach_protocol::NAMESPACE),
                Some("app.kubernetes.io/name=pgcf-attach"),
            )
            .await?
            .iter()
            .filter_map(attach_protocol::agent_of)
            .collect())
    }
    /// The agent of `node`, if one is Ready there.
    pub async fn agent(&self, node: &str) -> Result<Option<Agent>, Error> {
        Ok(self
            .agents()
            .await?
            .into_iter()
            .find(|agent| agent.node == node))
    }
    #[allow(clippy::too_many_arguments)]
    pub async fn call<B: Serialize, R: DeserializeOwned>(
        &self,
        keys: &Keys,
        agent: &Agent,
        action: Action,
        lv_uuid: &str,
        body: &B,
        timeout: Duration,
        now_ms: u64,
    ) -> Result<R, CallError> {
        self.client
            .call(keys, agent, action, lv_uuid, body, timeout, now_ms)
            .await
    }
}
/// The tenant LV a database's recorded volume identity names; `None` for a thick database or an
/// identity without the LV's UUID.
pub(crate) fn volume_of(db: &Value, identity: &str) -> Option<Volume> {
    if db["storage"].is_null() {
        return None;
    }
    let identity: Value = serde_json::from_str(identity).ok()?;
    let volume = Volume {
        lv_name: text(&identity, "handle").into(),
        lv_uuid: text(&identity, "lvUuid").into(),
        vg_uuid: text(&db["storage"], "volume_group_uuid").into(),
    };
    volume.valid().then_some(volume)
}
/// Writes the sleep record of database `id` on its storage receipt (`None` removes it).
pub(crate) async fn write_sleep_record(
    k8s: &Kubernetes,
    id: &str,
    record: Option<&SleepRecord>,
) -> Result<(), Error> {
    let name = format!("storage-{id}");
    let storage = k8s
        .read("ConfigMap", Some(SYSTEM), &name)
        .await?
        .ok_or("storage receipt missing")?;
    if text(&storage["metadata"]["labels"], DATABASE_LABEL) != id {
        return Err("storage receipt ownership changed".into());
    }
    let encoded = record.map(SleepRecord::encode);
    if storage["metadata"]["annotations"][SLEEP_RECORD].as_str() == encoded.as_deref() {
        return Ok(());
    }
    let written = k8s
        .patch(
            &storage,
            &json!({"metadata":{"annotations":{SLEEP_RECORD:encoded}}}),
        )
        .await?;
    if written["metadata"]["annotations"][SLEEP_RECORD].as_str() != encoded.as_deref() {
        return Err("sleep record write unknown".into());
    }
    Ok(())
}
fn now_ms() -> u64 {
    u64::try_from(time::OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000).unwrap_or(0)
}
fn slot_namespace(hex: &str) -> String {
    format!("{SLOT_NAMESPACE_PREFIX}{hex}")
}
fn millis(since: Instant) -> u64 {
    u64::try_from(since.elapsed().as_millis()).unwrap_or(u64::MAX)
}
fn hex_digest(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
/// A new slot's name: eight random lowercase hexadecimal digits.
fn random_hex() -> Result<String, Error> {
    Ok(attach_protocol::nonce()?
        .chars()
        .filter(char::is_ascii_hexdigit)
        .take(8)
        .collect())
}

// ---------------------------------------------------------------------------------------------
// The pool.

/// Why a serving slot is retired, and whether its unconfirmed release is undone first.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Retire {
    pub restore: bool,
    pub reason: &'static str,
}
/// A slot that serves a database.
#[derive(Clone, Debug)]
pub struct Serving {
    pub slot: String,
    pub node: String,
    pub generation: u64,
    pub operation: String,
    /// Present until Cloudflare confirms the wake's generation.
    pub ticket: Option<Ticket>,
    pub pod: SlotPod,
    pub volume: Volume,
    /// The admission target the fence named before the release, restored with an undone claim.
    pub target_before: Option<String>,
    /// `structure_fingerprint` and `sleep_fingerprint` of the database as the slot serves it.
    pub structure: String,
    pub configuration: String,
    pub retire: Option<Retire>,
}
impl Serving {
    fn intent(&self, id: &str) -> PowerIntent {
        PowerIntent {
            database: id.into(),
            operation: self.operation.clone(),
            revision: self.generation,
            mode: "running".into(),
        }
    }
}
/// What a pass over a served database came to.
pub enum Served {
    Observed(Option<Value>),
    /// The slot was retired for the database's own Cluster to start: the pass continues there.
    HandedOver,
}
/// The background work the pool asks of the controller's loop.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PoolWork {
    Create(manifests::SlotSpec),
    Discard(String),
}
#[derive(Default)]
struct State {
    slots: HashMap<String, Slot>,
    serving: HashMap<String, Serving>,
    /// The gateway Pods that delivered each database's wake, with its operation and generation.
    deliveries: HashMap<String, Vec<(GatewayPod, String, u64)>>,
    /// When each node may create a slot again.
    retry: HashMap<String, Instant>,
}
/// What a decision found to claim.
struct Plan {
    /// The running desired row the claim serves.
    view: Value,
    choice: Choice,
    slot: Slot,
    pod: SlotPod,
    record: SleepRecord,
    /// The gateway fence as it was read: the release is a CAS write of it.
    fence: Value,
}
/// The milliseconds of each step of a wake decision.
struct Timer {
    started: Instant,
    step: Instant,
    ms: BTreeMap<String, u64>,
    agent_us: BTreeMap<String, u64>,
}
impl Timer {
    fn new(queued_at_ms: Option<u64>) -> Self {
        let mut ms = BTreeMap::new();
        if let Some(queued) = queued_at_ms {
            ms.insert("intake".into(), now_ms().saturating_sub(queued));
        }
        Self {
            started: Instant::now(),
            step: Instant::now(),
            ms,
            agent_us: BTreeMap::new(),
        }
    }
    fn lap(&mut self, name: &str) {
        self.ms.insert(name.into(), millis(self.step));
        self.step = Instant::now();
    }
    fn total(&mut self) {
        self.ms.insert("total".into(), millis(self.started));
    }
}
/// A claim between its decision and the slot's registration as serving. Dropped while it is
/// pending, as when the pass that makes it is cut off, it registers the slot to be retired.
struct Claiming<'a> {
    pool: &'a Pool,
    pending: Option<(String, Serving)>,
}
impl Drop for Claiming<'_> {
    fn drop(&mut self) {
        if let Some((id, serving)) = self.pending.take()
            && let Ok(mut state) = self.pool.state.lock()
        {
            state.serving.entry(id).or_insert(serving);
        }
    }
}
/// The refusals of an agent that leave a slot as it was: nothing was mounted into it.
const CLEAN_REFUSALS: [&str; 10] = [
    "denied",
    "invalid",
    "busy",
    "keys_unavailable",
    "unsupported_platform",
    "holder_busy",
    "volume_open",
    "volume_suspended",
    "volume_missing",
    "uuid_mismatch",
];
pub struct Pool {
    k8s: Kubernetes,
    pub intake: Intake,
    image: String,
    state: Mutex<State>,
    /// Where slot sessions dial instead of the slot Pod's address and port 5432. Only a test
    /// double sets it.
    pub(crate) postgres: Option<SocketAddr>,
    /// How long PostgreSQL of a claimed slot may take to accept.
    pub(crate) start_budget: Duration,
}
impl Pool {
    pub fn new(k8s: Kubernetes, image: String) -> Result<Self, Error> {
        Ok(Self {
            k8s,
            intake: Intake::new()?,
            image,
            state: Mutex::default(),
            postgres: None,
            start_budget: Duration::from_secs(3),
        })
    }
    /// Whether a slot serves database `id`.
    pub fn serves(&self, id: &str) -> bool {
        self.state.lock().unwrap().serving.contains_key(id)
    }
    pub fn serving(&self, id: &str) -> Option<Serving> {
        self.state.lock().unwrap().serving.get(id).cloned()
    }
    /// The served databases whose slot is to be retired.
    pub fn unwinding(&self) -> Vec<String> {
        self.state
            .lock()
            .unwrap()
            .serving
            .iter()
            .filter(|(_, serving)| serving.retire.is_some())
            .map(|(id, _)| id.clone())
            .collect()
    }
    /// Asks for the slot serving `id` to be retired.
    pub fn unwind_later(&self, id: &str, reason: &'static str) {
        if let Some(serving) = self.state.lock().unwrap().serving.get_mut(id) {
            let restore = serving.ticket.is_some();
            serving.retire.get_or_insert(Retire { restore, reason });
        }
    }
    /// Remembers that `pod` delivered `wake`: its result goes there.
    pub fn delivered(&self, pod: &GatewayPod, wake: &WakeRequest) {
        let mut state = self.state.lock().unwrap();
        let entry = state.deliveries.entry(wake.database.clone()).or_default();
        entry.retain(|(_, op, generation)| *op == wake.operation && *generation == wake.generation);
        if !entry.iter().any(|(held, _, _)| held.uid == pod.uid) {
            entry.push((pod.clone(), wake.operation.clone(), wake.generation));
        }
    }
    /// Whether the wake `wake` is the one a slot already serves: a delivery again.
    pub fn served_already(&self, wake: &WakeRequest) -> bool {
        self.serving(&wake.database).is_some_and(|serving| {
            serving.operation == wake.operation && serving.generation == wake.generation
        })
    }
    /// Sends the result of a wake to every gateway Pod that delivered it, without waiting.
    pub async fn report(
        &self,
        power: &PowerCoordinator,
        wake: (&str, &str, u64),
        (outcome, reason): (Outcome, Option<&str>),
        steps: &BTreeMap<String, u64>,
    ) {
        let (database, operation, generation) = wake;
        let pods: Vec<GatewayPod> = {
            let mut state = self.state.lock().unwrap();
            let pods = state
                .deliveries
                .get(database)
                .into_iter()
                .flatten()
                .filter(|(_, op, held)| op == operation && *held == generation)
                .map(|(pod, _, _)| pod.clone())
                .collect();
            if outcome != Outcome::Miss {
                state.deliveries.remove(database);
            }
            pods
        };
        if pods.is_empty() {
            return;
        }
        let result = WakeResult {
            database: database.into(),
            operation: operation.into(),
            generation,
            outcome,
            reason: reason.map(str::to_string),
            steps_ms: steps
                .iter()
                .filter(|(key, value)| key.len() <= 32 && **value <= 600_000)
                .take(16)
                .map(|(key, value)| (key.clone(), *value))
                .collect(),
        };
        let Ok(keys) = power.regional_keys().await else {
            return;
        };
        let region = power.region().to_string();
        for pod in pods {
            let (intake, keys, region, result) = (
                self.intake.clone(),
                keys.clone(),
                region.clone(),
                result.clone(),
            );
            tokio::spawn(async move {
                let _ = intake.send_result(&keys, &region, &pod, &result).await;
            });
        }
    }
    /// The free slots of `node`.
    fn free_on(&self, node: &str) -> Vec<Slot> {
        self.state
            .lock()
            .unwrap()
            .slots
            .values()
            .filter(|slot| slot.node == node && slot.state == SlotState::Free && slot.pod.is_some())
            .cloned()
            .collect()
    }
    fn emit(path: &crate::timing::WakePath) {
        crate::timing::emit(crate::timing::wake_path_event(path));
    }

    /// A wake a gateway delivered (trigger `gateway`): its decision, and a hit's release. The
    /// result goes back to the gateways that delivered it. A miss leaves the held connections to
    /// the start of the database's own Cluster that Cloudflare's claim brings about.
    pub async fn wake(
        &self,
        rec: &Reconciler,
        cell: Option<(&Value, &DesiredSnapshot)>,
        wake: &WakeRequest,
        busy: bool,
    ) -> Result<Option<Value>, Error> {
        let mut timer = Timer::new(Some(wake.queued_at_ms));
        let wanted = (
            wake.database.as_str(),
            wake.operation.as_str(),
            wake.generation,
        );
        if self.served_already(wake) {
            self.report(&rec.power, wanted, (Outcome::Hit, None), &timer.ms)
                .await;
            return Ok(None);
        }
        // A slot that serves the database for another wake is that wake's.
        let busy = busy || self.serves(&wake.database);
        let node = cell.map_or("", |(db, _)| text(db, "node")).to_string();
        let decided = match cell {
            Some((db, snapshot)) => {
                self.plan(rec, db, snapshot, Trigger::Gateway(wake), busy)
                    .await
            }
            None => Err((Outcome::Miss, "no_desired_row")),
        };
        timer.lap("decide");
        let outcome = match decided {
            Ok(plan) => {
                let snapshot = cell
                    .map(|(_, snapshot)| snapshot)
                    .ok_or("snapshot missing")?;
                let slot = plan.slot.hex.clone();
                match self.hit(rec, plan, snapshot, Some(wake), &mut timer).await {
                    Ok(()) => (Outcome::Hit, None, Some(slot)),
                    Err(reason) => (Outcome::Miss, Some(reason), Some(slot)),
                }
            }
            Err((outcome, reason)) => (outcome, Some(reason), None),
        };
        timer.total();
        Self::emit(&crate::timing::WakePath {
            database: &wake.database,
            operation: &wake.operation,
            generation: wake.generation,
            trigger: "gateway",
            path: match outcome.0 {
                Outcome::Hit => "pool_hit",
                Outcome::Miss => "pool_miss",
                Outcome::Refused => "refused",
            },
            reason: outcome.1,
            node: &node,
            slot: outcome.2.as_deref(),
            ms: &timer.ms,
            agent_us: &timer.agent_us,
        });
        self.report(&rec.power, wanted, (outcome.0, outcome.1), &timer.ms)
            .await;
        Ok(None)
    }
    /// The wake of a desired row Cloudflare already committed (trigger `desired`), made in the
    /// reconcile pass: a hit answers the pass's observation, a miss leaves the pass to the start
    /// of the database's own Cluster.
    pub async fn desired(
        &self,
        rec: &Reconciler,
        db: &Value,
        snapshot: &DesiredSnapshot,
    ) -> Result<Option<Value>, Error> {
        let id = text(db, "id");
        if db["storage"].is_null() || self.serves(id) {
            return Ok(None);
        }
        // Only a database that sleeps is decided on: its own Cluster hibernated after a
        // completed sleep.
        let ns = crate::contracts::namespace(db);
        let fence_name = format!("gateway-fence-{id}");
        let (cluster, fence) = tokio::try_join!(
            self.k8s.read_known("Cluster", Some(&ns), "database"),
            self.k8s.read_known("ConfigMap", Some(SYSTEM), &fence_name),
        )?;
        if cluster.is_none_or(|cluster| cluster["metadata"]["annotations"][HIBERNATION] != "on")
            || fence.is_none_or(|fence| !crate::power::sleep_completed(&fence, now_ms()))
        {
            return Ok(None);
        }
        let mut timer = Timer::new(None);
        let decided = self.plan(rec, db, snapshot, Trigger::Desired, false).await;
        timer.lap("decide");
        let (operation, generation) = (text(&db["power"], "operation"), number(db, "generation"));
        let (path, reason, slot, observed) = match decided {
            Ok(plan) => {
                let slot = plan.slot.hex.clone();
                match self.hit(rec, plan, snapshot, None, &mut timer).await {
                    // The pass that released the slot publishes its attestation as well.
                    Ok(()) => {
                        let served = match self.serving(id) {
                            Some(serving) => self.serve_pass(rec, db, snapshot, serving).await,
                            None => Ok(Served::Observed(None)),
                        };
                        let observed = served.map(|served| match served {
                            Served::Observed(observed) => observed,
                            Served::HandedOver => None,
                        });
                        ("pool_hit", None, Some(slot), observed)
                    }
                    Err(reason) => ("pool_miss", Some(reason), Some(slot), Ok(None)),
                }
            }
            Err((_, reason)) => ("pool_miss", Some(reason), None, Ok(None)),
        };
        timer.total();
        Self::emit(&crate::timing::WakePath {
            database: id,
            operation,
            generation,
            trigger: "desired",
            path,
            reason,
            node: text(db, "node"),
            slot: slot.as_deref(),
            ms: &timer.ms,
            agent_us: &timer.agent_us,
        });
        observed
    }
    /// Gathers what the decision reads (rows 1-16) and decides. A hit's slot is claimed in
    /// memory before the decision is answered.
    async fn plan(
        &self,
        rec: &Reconciler,
        db: &Value,
        snapshot: &DesiredSnapshot,
        trigger: Trigger<'_>,
        busy: bool,
    ) -> Result<Plan, (Outcome, &'static str)> {
        let id = text(db, "id");
        // The row the claim serves: the wake Cloudflare commits after the release.
        let view = match trigger {
            Trigger::Gateway(wake) if text(db, "desired_state") == "suspended" => {
                let mut view = crate::reconcile::awake(db, &snapshot.region["scheduling"]);
                view["generation"] = wake.generation.into();
                view["power"] = json!({"operation":wake.operation,"revision":wake.generation,"mode":"running","reason":null});
                view
            }
            _ => db.clone(),
        };
        let ns = crate::contracts::namespace(db);
        let storage_name = format!("storage-{id}");
        let fence_name = format!("gateway-fence-{id}");
        let (storage, fence, cluster, node, pods, gateways) = tokio::join!(
            self.k8s
                .read_known("ConfigMap", Some(SYSTEM), &storage_name),
            self.k8s.read_known("ConfigMap", Some(SYSTEM), &fence_name),
            self.k8s.read_known("Cluster", Some(&ns), "database"),
            self.k8s.read_known_cached("Node", None, text(db, "node")),
            self.k8s.list_cached("Pod", None, None),
            rec.power.gateway_pods(),
        );
        let storage = storage.ok().flatten();
        let fence = fence.ok().flatten();
        let node = node.ok().flatten();
        let annotations = storage
            .as_ref()
            .map_or(&Value::Null, |storage| &storage["metadata"]["annotations"]);
        let identity: Option<Value> = annotations["pgcf.io/volume-identity"]
            .as_str()
            .and_then(|raw| serde_json::from_str(raw).ok());
        let record = annotations[SLEEP_RECORD]
            .as_str()
            .and_then(SleepRecord::parse);
        let image = view["postgres"]["image"]
            .as_str()
            .unwrap_or(&self.image)
            .to_string();
        let fingerprint = sleep_fingerprint(&view, &self.image).unwrap_or_default();
        let authority = node
            .as_ref()
            .is_some_and(|node| rec.write_authority(&view, snapshot, node));
        let slots = self.free_on(text(db, "node"));
        let facts = Facts {
            trigger,
            cell: Some(db),
            protection: storage
                .as_ref()
                .and_then(crate::power::protection_generation),
            asleep: cluster
                .ok()
                .flatten()
                .is_some_and(|cluster| cluster["metadata"]["annotations"][HIBERNATION] == "on"),
            busy,
            identity: identity.as_ref(),
            power_record: fence
                .as_ref()
                .is_some_and(|fence| crate::power::sleep_completed(fence, now_ms())),
            record: record.as_ref(),
            image: &image,
            fingerprint: &fingerprint,
            authority,
            gateways_ready: gateways.is_ok_and(|pods| self.intake.ready(&pods)),
            slots: slots.iter().collect(),
            headroom: match (&node, &pods) {
                (Some(node), Ok(pods)) => memory_headroom(node, pods, headroom_need(&view)),
                _ => false,
            },
        };
        let choice = decide(&facts)?;
        let (Some(record), Some(fence)) = (record, fence) else {
            return Err((Outcome::Miss, "no_sleep_record"));
        };
        // Claimed in memory: no other wake takes the slot meanwhile.
        let mut state = self.state.lock().unwrap();
        let Some(slot) = state
            .slots
            .get_mut(&choice.slot)
            .filter(|slot| slot.state == SlotState::Free)
        else {
            return Err((Outcome::Miss, "no_free_slot"));
        };
        let Some(pod) = slot.pod.clone() else {
            return Err((Outcome::Miss, "no_free_slot"));
        };
        slot.state = SlotState::Claimed(id.into());
        Ok(Plan {
            view,
            choice,
            slot: slot.clone(),
            pod,
            record,
            fence,
        })
    }
    /// Gives a claimed slot back to the pool: nothing of the tenant reached it.
    fn unclaim(&self, hex: &str) {
        if let Some(slot) = self.state.lock().unwrap().slots.get_mut(hex) {
            slot.state = SlotState::Free;
        }
    }
    /// The socket a slot session dials.
    fn socket(&self, ip: &str) -> Result<SocketAddr, Error> {
        if let Some(socket) = self.postgres {
            return Ok(socket);
        }
        Ok(SocketAddr::new(ip.parse()?, crate::postgres::PORT))
    }
    /// Steps 17-24 of a hit: the attach, the identity of the volume, the claim wave, the start
    /// of PostgreSQL, the SQL identity, the slot Pod and the release. A failure after the attach
    /// retires the slot before the miss path may take the volume; so does a hit that is cut off.
    async fn hit(
        &self,
        rec: &Reconciler,
        plan: Plan,
        snapshot: &DesiredSnapshot,
        ticket: Option<&WakeRequest>,
        timer: &mut Timer,
    ) -> Result<(), &'static str> {
        let Plan {
            view,
            choice,
            slot,
            pod,
            record,
            fence,
        } = plan;
        let id = text(&view, "id").to_string();
        let ns = slot_namespace(&slot.hex);
        let node = slot.node.clone();
        let claim = Claim {
            v: 1,
            database: id.clone(),
            operation: text(&view["power"], "operation").into(),
            generation: number(&view, "generation"),
            claimed_at_ms: now_ms(),
        };
        let serving = Serving {
            slot: slot.hex.clone(),
            node: node.clone(),
            generation: claim.generation,
            operation: claim.operation.clone(),
            ticket: None,
            pod: pod.clone(),
            volume: choice.volume.clone(),
            target_before: fence["data"]["admission_target"]
                .as_str()
                .map(str::to_string),
            structure: structure_fingerprint(&view, &self.image).unwrap_or_default(),
            configuration: sleep_fingerprint(&view, &self.image).unwrap_or_default(),
            retire: None,
        };
        // Cut off before it serves, the claim leaves its slot to be retired, its release undone.
        let mut claiming = Claiming {
            pool: self,
            pending: Some((
                id.clone(),
                Serving {
                    retire: Some(Retire {
                        restore: true,
                        reason: "interrupted",
                    }),
                    ..serving.clone()
                },
            )),
        };
        // 17-18: the attach.
        let attached = async {
            let agent = rec.power.attach.agent(&node).await.ok().flatten()?;
            let keys = rec.power.attach_keys().await.ok()?;
            let request = AttachRequest {
                volume: choice.volume.clone(),
                pod_uid: pod.uid.clone(),
                containers: vec![pod.postgres.clone(), pod.sidecar.clone()],
            };
            Some(
                rec.power
                    .attach
                    .call::<_, AttachResponse>(
                        &keys,
                        &agent,
                        Action::Attach,
                        &choice.volume.lv_uuid,
                        &request,
                        Duration::from_secs(3),
                        now_ms(),
                    )
                    .await,
            )
        }
        .await;
        timer.lap("attach");
        let attached = match attached {
            None => {
                claiming.pending = None;
                self.unclaim(&slot.hex);
                return Err("agent_unavailable");
            }
            Some(Ok(attached)) => attached,
            Some(Err(CallError::Refused(code))) if CLEAN_REFUSALS.contains(&code.as_str()) => {
                claiming.pending = None;
                self.unclaim(&slot.hex);
                return Err(REASONS
                    .into_iter()
                    .find(|reason| *reason == code)
                    .unwrap_or("agent_unavailable"));
            }
            Some(Err(error)) => {
                // The agent undid what it did, or it is not known what it did: the slot is not
                // given out again.
                let _ = self
                    .retire(rec, &slot, &pod, &choice.volume, &id, None)
                    .await;
                claiming.pending = None;
                return Err(match error {
                    CallError::Refused(code) => REASONS
                        .into_iter()
                        .find(|reason| *reason == code)
                        .unwrap_or(if code == "control_unreadable" {
                            "unclean"
                        } else {
                            "agent_unavailable"
                        }),
                    CallError::Unavailable => "agent_unavailable",
                });
            }
        };
        timer.agent_us = attached.steps_us.clone();
        // A failure from here on retires the slot: with `inspect`, the sleep is recorded from
        // the data directory once PostgreSQL is seen shut down there.
        macro_rules! undo {
            ($reason:expr, $inspect:expr) => {{
                let _ = self
                    .retire(
                        rec,
                        &slot,
                        &pod,
                        &choice.volume,
                        &id,
                        $inspect.then_some(Some(&view)),
                    )
                    .await;
                claiming.pending = None;
                return Err($reason);
            }};
        }
        // 19: the volume is the one that slept, and it slept cleanly.
        if !attached.control.shut_down() {
            undo!("unclean", false);
        }
        if !record.matches(&attached.control) {
            undo!("identity_mismatch", false);
        }
        // 20: the claim wave.
        let bound = self.bind(rec, &view, snapshot, &slot, &claim).await;
        timer.lap("claim_wave");
        let Ok((ca, ca_secret)) = bound else {
            undo!("bind_failed", true);
        };
        // 21-22: PostgreSQL accepts on the tenant data, which is the data that slept.
        let session = self.started(&view, &pod, &ns, &ca).await;
        timer.lap("start");
        let Some(session) = session else {
            undo!("start_timeout", true);
        };
        let identity = session
            .query(crate::postgres::SERVER_IDENTITY_QUERY, &[])
            .await
            .ok()
            .and_then(|rows| match rows.as_slice() {
                [row] => crate::power::SystemIdentity::of(row),
                _ => None,
            });
        drop(session);
        timer.lap("identity");
        if identity.is_none_or(|identity| {
            identity.identifier != record.system_identifier
                || u32::try_from(identity.timeline).ok() != Some(record.timeline)
        }) {
            undo!("sql_identity_mismatch", false);
        }
        // 23: the slot Pod is still the one the volume was moved into.
        let current = self
            .k8s
            .read_known("Pod", Some(&ns), "database-1")
            .await
            .ok()
            .flatten();
        if current.as_ref().and_then(slot_pod).as_ref() != Some(&pod) {
            undo!("container_missing", true);
        }
        // 24: the release.
        let target = json!({"v":1,"generation":claim.generation,"route_revision":view["admission"]["route_revision"],"admission_epoch":view["admission"]["admission_epoch"],"pod_uid":pod.uid,"container_id":pod.postgres,"ca_secret_uid":ca_secret["metadata"]["uid"],"ca_secret_resource_version":ca_secret["metadata"]["resourceVersion"],"ca_sha256":hex_digest(&ca),"tls_server_name":slot_tls_name(&ns)});
        let intent = serving.intent(&id);
        // Registered before the release: whatever its answer, the slot is retired from here on.
        // A gateway's wake is served on a ticket Cloudflare has to confirm.
        self.state.lock().unwrap().serving.insert(
            id.clone(),
            Serving {
                ticket: ticket
                    .map(|wake| Ticket::new(&id, &wake.operation, wake.generation, Instant::now())),
                ..serving
            },
        );
        claiming.pending = None;
        if rec
            .power
            .release_slot(&view, &fence, &intent, &target)
            .await
            .is_err()
        {
            timer.lap("release");
            // Whether the fence write committed is not known: it is undone with the slot.
            if let Some(serving) = self.state.lock().unwrap().serving.get_mut(&id) {
                serving.retire = Some(Retire {
                    restore: true,
                    reason: "release_failed",
                });
            }
            let _ = self.unwind(rec, &id, Some(&view)).await;
            return Err("release_failed");
        }
        timer.lap("release");
        if let Some(ticket) = self
            .state
            .lock()
            .unwrap()
            .serving
            .get_mut(&id)
            .and_then(|serving| serving.ticket.as_mut())
        {
            // The lease runs from the release.
            *ticket = Ticket::new(&id, &ticket.operation, ticket.generation, Instant::now());
        }
        crate::timing::emit(crate::timing::pool_slot_event(
            &slot.hex, &node, "claimed", None, None,
        ));
        self.after_release(&view, &ns, &slot.hex);
        Ok(())
    }
    /// What follows a release off the path: the slot's `postgres` container gets the class's
    /// requests, and the database its daily backup.
    fn after_release(&self, view: &Value, ns: &str, hex: &str) {
        let k8s = self.k8s.clone();
        let size = &view["size"];
        let requests = json!({"cpu":format!("{}m",optional_number(size,"cpu_request_millicores",number(size,"cpu_millicores"))),"memory":format!("{}Mi",optional_number(size,"memory_request_mib",number(size,"memory_mib")))});
        let backup = json!({"apiVersion":"postgresql.cnpg.io/v1","kind":"ScheduledBackup","metadata":{"name":"daily-backup","namespace":ns,"labels":{SLOT_LABEL:hex,DATABASE_LABEL:view["id"]}},"spec":{"schedule":"0 0 3 * * *","immediate":false,"backupOwnerReference":"cluster","cluster":{"name":"database"},"method":"plugin","pluginConfiguration":{"name":"barman-cloud.cloudnative-pg.io"}}});
        let ns = ns.to_string();
        tokio::spawn(async move {
            if let Ok(Some(pod)) = k8s.read_known("Pod", Some(&ns), "database-1").await {
                let _ = k8s.resize_pod(&pod, &[("postgres", requests)], &[]).await;
            }
            if let Ok(None) = k8s
                .read_known("ScheduledBackup", Some(&ns), "daily-backup")
                .await
            {
                let _ = k8s.create(&backup).await;
            }
        });
    }
    /// The claim wave (4.2): the regional archive credentials, the tenant's archive path and
    /// retention and the slot's CA published for the database, written together; then the one
    /// Cluster patch that lifts the fence. Answers the slot's CA and its Secret.
    async fn bind(
        &self,
        rec: &Reconciler,
        view: &Value,
        snapshot: &DesiredSnapshot,
        slot: &Slot,
        claim: &Claim,
    ) -> Result<(Vec<u8>, Value), Error> {
        let id = text(view, "id");
        let ns = slot_namespace(&slot.hex);
        let published = format!("ca-{id}");
        let (secret, store, ca_map, ca_secret, cluster, context) = tokio::join!(
            self.k8s
                .read_known("Secret", Some(&ns), "archive-credentials"),
            self.k8s.read_known("ObjectStore", Some(&ns), "archive"),
            self.k8s.read_known("ConfigMap", Some(SYSTEM), &published),
            self.k8s.read_known("Secret", Some(&ns), "database-ca"),
            self.k8s.read("Cluster", Some(&ns), "database"),
            rec.slot_context(snapshot),
        );
        let secret = secret?.ok_or("slot archive credentials missing")?;
        let store = store?.ok_or("slot archive missing")?;
        let ca_secret = ca_secret?.ok_or("slot CA missing")?;
        let cluster = cluster?.ok_or("slot Cluster missing")?;
        let context = context?;
        if !crate::power::fenced(&cluster) || !cluster["metadata"]["annotations"][CLAIM].is_null() {
            return Err("slot Cluster is not a free slot".into());
        }
        let ca = STANDARD.decode(text(&ca_secret["data"], "ca.crt"))?;
        crate::postgres::validate_ca(&ca)?;
        let credentials = &context["backup"]["credentials"];
        self.k8s.index_slot(&ns, Some(id));
        let ca_data = json!({"ca.crt":String::from_utf8(ca.clone())?});
        let ca_annotations = json!({"pgcf.io/source-ca-secret-uid":ca_secret["metadata"]["uid"],"pgcf.io/source-ca-secret-resource-version":ca_secret["metadata"]["resourceVersion"]});
        let credentials_patch = json!({"data":{"AWS_ACCESS_KEY_ID":STANDARD.encode(text(credentials,"accessKeyId")),"AWS_SECRET_ACCESS_KEY":STANDARD.encode(text(credentials,"secretAccessKey"))}});
        let archive_patch = json!({"spec":{"configuration":{"destinationPath":view["archive"]["destination_path"]},"retentionPolicy":format!("{}d",number(&view["size"],"backup_retention_days"))}});
        let (written_secret, written_store, written_ca) = tokio::join!(
            self.k8s.patch(&secret, &credentials_patch),
            self.k8s.patch(&store, &archive_patch),
            async {
                match ca_map? {
                    Some(map) => {
                        if text(&map["metadata"]["labels"], DATABASE_LABEL) != id {
                            return Err::<Value, Error>("published CA ownership changed".into());
                        }
                        self.k8s
                            .patch(
                                &map,
                                &json!({"metadata":{"annotations":ca_annotations},"data":ca_data}),
                            )
                            .await
                    }
                    None => {
                        self.k8s
                            .create(&json!({"apiVersion":"v1","kind":"ConfigMap","metadata":{"name":published,"namespace":SYSTEM,"labels":{DATABASE_LABEL:id},"annotations":ca_annotations},"data":ca_data}))
                            .await
                    }
                }
            },
        );
        written_secret?;
        written_store?;
        written_ca?;
        self.k8s.patch(&cluster, &claim_patch(view, claim)).await?;
        Ok((ca, ca_secret))
    }
    /// Polls the claimed slot until PostgreSQL accepts there on the tenant's database as a
    /// primary: the session that proved it, or `None` within the start budget.
    async fn started(
        &self,
        view: &Value,
        pod: &SlotPod,
        ns: &str,
        ca: &[u8],
    ) -> Option<crate::postgres::Session> {
        let socket = self.socket(&pod.ip).ok()?;
        let deadline = Instant::now() + self.start_budget;
        let name = slot_tls_name(ns);
        loop {
            let attempt = async {
                let session = crate::postgres::connect_slot(
                    view,
                    socket,
                    &name,
                    ca,
                    text(&view["maintenance"], "role"),
                    text(&view["maintenance"], "password"),
                )
                .await?;
                let rows = session.query(crate::postgres::ACCEPTING_QUERY, &[]).await?;
                let [row] = rows.as_slice() else {
                    return Ok::<_, Error>(None);
                };
                let accepting = row.try_get::<_, String>("database")? == text(view, "id")
                    && !row.try_get::<_, bool>("recovery")?
                    && row.try_get::<_, String>("server_address")? == pod.ip;
                Ok(accepting.then_some(session))
            };
            let remaining = deadline.saturating_duration_since(Instant::now());
            if let Ok(Ok(Some(session))) = tokio::time::timeout(remaining, attempt).await {
                return Some(session);
            }
            if Instant::now() >= deadline {
                return None;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }
    /// Retires a slot that holds database `id`'s volume (4.5): the slot is fenced; with `record`
    /// the sleep is recorded from the data directory once PostgreSQL is seen shut down there (the
    /// desired row given names the configuration); the slot namespace is deleted and the volume's
    /// holder released once the kernel reports it closed. `false`: not yet, the holder stays.
    async fn retire(
        &self,
        rec: &Reconciler,
        slot: &Slot,
        pod: &SlotPod,
        volume: &Volume,
        id: &str,
        record: Option<Option<&Value>>,
    ) -> Result<bool, Error> {
        let ns = slot_namespace(&slot.hex);
        if let Some(mut state) = self.state.lock().ok()
            && let Some(held) = state.slots.get_mut(&slot.hex)
        {
            held.state = SlotState::Discarding;
        }
        let namespace = self.k8s.read("Namespace", None, &ns).await?;
        if namespace.is_some() {
            if let Some(cluster) = self.k8s.read("Cluster", Some(&ns), "database").await?
                && !crate::power::fenced(&cluster)
            {
                self.k8s
                    .patch(
                        &cluster,
                        &json!({"metadata":{"annotations":{FENCE:FENCE_ALL}}}),
                    )
                    .await?;
            }
            if let Some(db) = record {
                let Some(control) = self.shut_down(rec, &slot.node, volume, pod).await? else {
                    return Ok(false);
                };
                self.record(id, db, control.as_ref()).await?;
            }
            if let Some(namespace) =
                namespace.filter(|n| n["metadata"]["deletionTimestamp"].is_null())
            {
                self.k8s.delete(&namespace, "Background").await?;
            }
        }
        self.k8s.index_slot(&ns, None);
        // The holder goes once the kernel reports the device closed: the slot's Pod is gone.
        if let Some(agent) = rec.power.attach.agent(&slot.node).await? {
            let keys = rec.power.attach_keys().await?;
            let request = ReleaseRequest {
                volume: volume.clone(),
                holder: Holder::Slot {
                    pod_uid: pod.uid.clone(),
                },
                wait_ms: attach_protocol::MAX_RELEASE_WAIT_MS,
            };
            match rec
                .power
                .attach
                .call::<_, ReleaseResponse>(
                    &keys,
                    &agent,
                    Action::Release,
                    &volume.lv_uuid,
                    &request,
                    Duration::from_millis(attach_protocol::MAX_RELEASE_WAIT_MS + 2_000),
                    now_ms(),
                )
                .await
            {
                Ok(_) => {}
                Err(CallError::Refused(code)) if code == "holder_mismatch" => {}
                Err(_) => return Ok(false),
            }
        }
        let removed = self.state.lock().unwrap().slots.remove(&slot.hex);
        if removed.is_some() {
            crate::timing::emit(crate::timing::pool_slot_event(
                &slot.hex,
                &slot.node,
                "discarded",
                Some("retired"),
                None,
            ));
        }
        Ok(true)
    }
    /// Polls the slot's `postgres` container until PostgreSQL is seen shut down on the tenant
    /// data: `Some(Some(control))`; `Some(None)` when the container is gone and the state of the
    /// data directory is unknown; `None` when it is not known yet.
    async fn shut_down(
        &self,
        rec: &Reconciler,
        node: &str,
        volume: &Volume,
        pod: &SlotPod,
    ) -> Result<Option<Option<Control>>, Error> {
        let Some(agent) = rec.power.attach.agent(node).await? else {
            return Ok(None);
        };
        let keys = rec.power.attach_keys().await?;
        let request = InspectRequest {
            volume: volume.clone(),
            postgres_container: Some(pod.postgres.clone()),
        };
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            match rec
                .power
                .attach
                .call::<_, InspectResponse>(
                    &keys,
                    &agent,
                    Action::Inspect,
                    &volume.lv_uuid,
                    &request,
                    Duration::from_secs(1),
                    now_ms(),
                )
                .await
            {
                Ok(seen) => {
                    if let Some(control) = seen.control.filter(|control| {
                        control.shut_down() && seen.postmaster_running == Some(false)
                    }) {
                        return Ok(Some(Some(control)));
                    }
                }
                Err(CallError::Refused(code)) if code == "container_missing" => {
                    return Ok(Some(None));
                }
                Err(_) => {}
            }
            if Instant::now() >= deadline {
                return Ok(None);
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
    /// The sleep record a retired slot leaves: from `control` when it is the data directory the
    /// record names, under the configuration of `db` (or the record's own); otherwise none, so
    /// that the next wake takes the database's own Cluster.
    async fn record(
        &self,
        id: &str,
        db: Option<&Value>,
        control: Option<&Control>,
    ) -> Result<(), Error> {
        let storage = self
            .k8s
            .read_known("ConfigMap", Some(SYSTEM), &format!("storage-{id}"))
            .await?;
        let previous = storage
            .as_ref()
            .and_then(|storage| storage["metadata"]["annotations"][SLEEP_RECORD].as_str())
            .and_then(SleepRecord::parse);
        let next = match (previous, control) {
            (Some(previous), Some(control))
                if control.shut_down()
                    && control.system_identifier == previous.system_identifier =>
            {
                let configuration = db
                    .and_then(|db| sleep_fingerprint(db, &self.image).ok())
                    .unwrap_or(previous.configuration_sha256);
                let image = db
                    .and_then(|db| db["postgres"]["image"].as_str())
                    .unwrap_or(&self.image)
                    .to_string();
                Some(SleepRecord {
                    v: 1,
                    system_identifier: control.system_identifier.clone(),
                    timeline: control.timeline,
                    configuration_sha256: configuration,
                    image: if db.is_some() { image } else { previous.image },
                    written_at_ms: now_ms(),
                    via: Via::Slot,
                })
            }
            _ => None,
        };
        write_sleep_record(&self.k8s, id, next.as_ref()).await
    }
    /// Retires the slot that serves `id` (its `retire` says whether its release is undone first);
    /// `db` is the desired row the sleep record is written under. `true` once the slot is gone and
    /// the volume released.
    pub async fn unwind(
        &self,
        rec: &Reconciler,
        id: &str,
        db: Option<&Value>,
    ) -> Result<bool, Error> {
        let Some(serving) = self.serving(id) else {
            return Ok(true);
        };
        if serving.retire.is_some_and(|retire| retire.restore) {
            rec.power
                .restore_fence(id, &serving.intent(id), serving.target_before.as_deref())
                .await?;
        }
        let slot = self
            .state
            .lock()
            .unwrap()
            .slots
            .get(&serving.slot)
            .cloned()
            .unwrap_or_else(|| Slot {
                hex: serving.slot.clone(),
                node: serving.node.clone(),
                state: SlotState::Discarding,
                image: self.image.clone(),
                cpu_millicores: 0,
                memory_mib: 0,
                pod: Some(serving.pod.clone()),
                created: Instant::now(),
            });
        if !self
            .retire(rec, &slot, &serving.pod, &serving.volume, id, Some(db))
            .await?
        {
            return Ok(false);
        }
        self.state.lock().unwrap().serving.remove(id);
        Ok(true)
    }
    /// What Cloudflare's desired rows say of the pending tickets: confirmed ones are dropped,
    /// refuted and expired ones retire their slot (with the release undone).
    pub fn confirm_tickets<'a>(
        &self,
        cell: impl Fn(&str) -> Option<&'a Value>,
        now: Instant,
    ) -> Vec<(String, TicketOutcome)> {
        let mut decided = vec![];
        let mut state = self.state.lock().unwrap();
        for (id, serving) in state.serving.iter_mut() {
            let Some(ticket) = &serving.ticket else {
                continue;
            };
            let Some(outcome) = ticket.outcome(cell(id), now) else {
                continue;
            };
            crate::timing::emit(crate::timing::wake_ticket_event(
                id,
                &ticket.operation,
                ticket.generation,
                match outcome {
                    TicketOutcome::Confirmed => "confirmed",
                    TicketOutcome::Refuted => "refuted",
                    TicketOutcome::Expired => "expired",
                },
                u64::try_from(
                    now.saturating_duration_since(ticket.released_at)
                        .as_millis(),
                )
                .unwrap_or(u64::MAX),
            ));
            if outcome != TicketOutcome::Confirmed {
                serving.retire = Some(Retire {
                    restore: true,
                    reason: if outcome == TicketOutcome::Refuted {
                        "refuted"
                    } else {
                        "expired"
                    },
                });
            }
            serving.ticket = None;
            decided.push((id.clone(), outcome));
        }
        decided
    }
    /// A pass over a database a slot serves (rule 6.3): the volume and the Pod are still the
    /// slot's, a configuration change hands the database over to its own Cluster, a role change
    /// is applied in the slot, and the ready observation carries the slot's attestation.
    pub async fn serve_pass(
        &self,
        rec: &Reconciler,
        db: &Value,
        snapshot: &DesiredSnapshot,
        serving: Serving,
    ) -> Result<Served, Error> {
        let id = text(db, "id");
        if serving.ticket.is_some() {
            return Ok(Served::Observed(None));
        }
        if serving.retire.is_some() {
            self.unwind(rec, id, Some(db)).await?;
            return Err("pool slot retired".into());
        }
        let ns = slot_namespace(&serving.slot);
        let lost = |message: &str| json!({"id":db["id"],"generation":db["generation"],"state":"error","message":message,"archive":{"continuous":false,"ready_wal_files":null}});
        // The volume is open once, by the slot, and not suspended by the host guard.
        let agent = rec
            .power
            .attach
            .agent(&serving.node)
            .await?
            .ok_or("slot agent unavailable")?;
        let keys = rec.power.attach_keys().await?;
        let seen = rec
            .power
            .attach
            .call::<_, InspectResponse>(
                &keys,
                &agent,
                Action::Inspect,
                &serving.volume.lv_uuid,
                &InspectRequest {
                    volume: serving.volume.clone(),
                    postgres_container: Some(serving.pod.postgres.clone()),
                },
                Duration::from_secs(1),
                now_ms(),
            )
            .await;
        let pod = self.k8s.read_known("Pod", Some(&ns), "database-1").await?;
        let held = match &seen {
            Ok(seen) => !seen.suspended && seen.open_count == 1,
            Err(CallError::Refused(code)) => code != "container_missing",
            Err(CallError::Unavailable) => return Err("slot agent unavailable".into()),
        };
        if !held || pod.as_ref().and_then(slot_pod).as_ref() != Some(&serving.pod) {
            self.unwind_later(id, "volume_authority_lost");
            self.unwind(rec, id, Some(db)).await?;
            return Ok(Served::Observed(Some(lost("slot volume authority lost"))));
        }
        // Anything but a role changed: the database's own Cluster takes over.
        if structure_fingerprint(db, &self.image)? != serving.structure {
            self.unwind_later(id, "configuration_changed");
            return if self.unwind(rec, id, Some(db)).await? {
                Ok(Served::HandedOver)
            } else {
                Ok(Served::Observed(None))
            };
        }
        let configuration = sleep_fingerprint(db, &self.image)?;
        if configuration != serving.configuration {
            if !self.roles_applied(rec, db, snapshot, &ns).await? {
                return Ok(Served::Observed(Some(
                    json!({"id":db["id"],"generation":db["generation"],"state":"provisioning","archive":{"continuous":false,"ready_wal_files":null}}),
                )));
            }
            if let Some(held) = self.state.lock().unwrap().serving.get_mut(id) {
                held.configuration = configuration;
            }
        }
        let observation = rec.slot_observation(db, &ns, &serving).await?;
        rec.power
            .publish_ready_fence(db, observation, true)
            .await
            .map(Served::Observed)
    }
    /// Applies the database's roles to the slot that serves it: the role Secrets and the
    /// maintenance credential, and the Cluster's managed roles. `true` once CNPG reconciled them.
    async fn roles_applied(
        &self,
        rec: &Reconciler,
        db: &Value,
        snapshot: &DesiredSnapshot,
        ns: &str,
    ) -> Result<bool, Error> {
        let context = rec.slot_context(snapshot).await?;
        let parts = manifests::tenant_parts(db, &context, ns)?;
        let mut applied = vec![];
        for secret in &parts.secrets {
            let current = self
                .k8s
                .read_known("Secret", Some(ns), text(&secret["metadata"], "name"))
                .await?;
            applied.push(match current {
                Some(current) if current["data"] == secret["data"] => current,
                Some(current) => {
                    self.k8s
                        .patch(&current, &json!({"data":secret["data"]}))
                        .await?
                }
                None => self.k8s.create(secret).await?,
            });
        }
        let cluster = self
            .k8s
            .read("Cluster", Some(ns), "database")
            .await?
            .ok_or("slot Cluster missing")?;
        if cluster["spec"]["managed"]["roles"] != json!(parts.managed_roles) {
            self.k8s
                .patch(
                    &cluster,
                    &json!({"spec":{"managed":{"roles":parts.managed_roles}}}),
                )
                .await?;
            return Ok(false);
        }
        let status = &cluster["status"]["managedRolesStatus"];
        Ok(parts.managed_roles.iter().all(|role| {
            let name = &role["name"];
            let secret = text(&role["passwordSecret"], "name");
            role["ensure"] != "present"
                || secret.is_empty()
                || (status["byStatus"]["reconciled"]
                    .as_array()
                    .is_some_and(|names| names.contains(name))
                    && applied.iter().any(|written| {
                        written["metadata"]["name"] == secret
                            && status["passwordStatus"][name.as_str().unwrap_or("")]
                                ["resourceVersion"]
                                == written["metadata"]["resourceVersion"]
                    }))
        }))
    }
    /// The sleep of a database a slot serves (rule 6.4): the existing sleep proof on the slot,
    /// then the slot's retirement, then the hibernated record.
    pub async fn sleep(
        &self,
        rec: &Reconciler,
        db: &Value,
        snapshot: &DesiredSnapshot,
        serving: Serving,
    ) -> Result<Option<Value>, Error> {
        let id = text(db, "id");
        if serving.ticket.is_some() {
            return Ok(None);
        }
        let ns = slot_namespace(&serving.slot);
        let socket = self.socket(&serving.pod.ip)?;
        let sleep = |gone: bool| Sleep {
            parking: &Value::Null,
            basis: Basis {
                node: &Value::Null,
                release: &snapshot.fleet_release,
                manifests: None,
                runtime_class: "",
            },
            slot: Some(SlotSleep {
                pod: socket,
                tls_name: slot_tls_name(&ns),
                gone,
            }),
        };
        if serving.retire.is_none() {
            let observed = rec.power.suspend(db, &sleep(false)).await?;
            if observed.is_some() {
                return Ok(observed);
            }
            if rec.power.sleep_phase(db).await != Some("hibernating") {
                return Ok(None);
            }
            self.unwind_later(id, "sleep");
        }
        if !self.unwind(rec, id, Some(db)).await? {
            return Ok(None);
        }
        rec.power.suspend(db, &sleep(true)).await
    }

    /// What the pool does next for its free slots, at `now`: slots to create and to delete. A
    /// creation is registered here, so that it is not asked for twice.
    pub fn refill_work<'a>(
        &self,
        dbs: impl IntoIterator<Item = &'a Value>,
        gateways_ready: bool,
        now: Instant,
    ) -> Vec<PoolWork> {
        let dbs: Vec<&Value> = dbs.into_iter().collect();
        let shapes: BTreeMap<String, Shape> = dbs
            .iter()
            .filter(|db| !db["storage"].is_null() && text(db, "desired_state") != "deleted")
            .map(|db| text(db, "node").to_string())
            .filter_map(|node| {
                let shape = slot_shape(&node, dbs.iter().copied())?;
                Some((node, shape))
            })
            .collect();
        let mut state = self.state.lock().unwrap();
        let plan = {
            let slots: Vec<&Slot> = state.slots.values().collect();
            refill(
                &slots,
                &shapes,
                &self.image,
                gateways_ready,
                &state.retry,
                now,
            )
        };
        let mut work = vec![];
        for step in plan {
            match step {
                Refill::Discard(hex, reason) => {
                    if let Some(slot) = state.slots.get_mut(&hex) {
                        slot.state = SlotState::Discarding;
                        let node = slot.node.clone();
                        if reason == "not_free_in_time" {
                            state.retry.insert(node, now + SLOT_RETRY_AFTER);
                        }
                    }
                    work.push(PoolWork::Discard(hex));
                }
                Refill::Create(node) => {
                    let (Some(shape), Ok(hex)) = (shapes.get(&node), random_hex()) else {
                        continue;
                    };
                    if hex.len() != 8 || state.slots.contains_key(&hex) {
                        continue;
                    }
                    let spec = manifests::SlotSpec {
                        hex: hex.clone(),
                        node: node.clone(),
                        image: self.image.clone(),
                        cpu_millicores: shape.cpu_millicores,
                        memory_mib: shape.memory_mib,
                        max_connections: shape.max_connections,
                        archive_timeout_seconds: shape.archive_timeout_seconds,
                    };
                    state.slots.insert(
                        hex.clone(),
                        Slot {
                            hex: hex.clone(),
                            node: node.clone(),
                            state: SlotState::Creating { since: now },
                            image: self.image.clone(),
                            cpu_millicores: shape.cpu_millicores,
                            memory_mib: shape.memory_mib,
                            pod: None,
                            created: now,
                        },
                    );
                    crate::timing::emit(crate::timing::pool_slot_event(
                        &hex, &node, "creating", None, None,
                    ));
                    work.push(PoolWork::Create(spec));
                }
            }
        }
        work
    }
    /// Creates the objects of a new slot, namespace first. A slot that cannot be created is
    /// deleted and its node waits before the next.
    pub async fn create_slot(
        &self,
        rec: &Reconciler,
        snapshot: &DesiredSnapshot,
        spec: &manifests::SlotSpec,
    ) -> Result<(), Error> {
        let result: Result<(), Error> = async {
            let context = rec.slot_context(snapshot).await?;
            for manifest in manifests::slot(spec, &context)? {
                self.k8s.create(&manifest).await?;
            }
            Ok(())
        }
        .await;
        if result.is_err() {
            {
                let mut state = self.state.lock().unwrap();
                state
                    .retry
                    .insert(spec.node.clone(), Instant::now() + SLOT_RETRY_AFTER);
                if let Some(slot) = state.slots.get_mut(&spec.hex) {
                    slot.state = SlotState::Discarding;
                }
            }
            self.discard(&spec.hex).await?;
        }
        result
    }
    /// Deletes a slot that never served a database.
    pub async fn discard(&self, hex: &str) -> Result<(), Error> {
        let ns = slot_namespace(hex);
        if let Some(namespace) = self.k8s.read("Namespace", None, &ns).await?
            && namespace["metadata"]["deletionTimestamp"].is_null()
            && text(&namespace["metadata"]["labels"], SLOT_LABEL) == hex
        {
            self.k8s.delete(&namespace, "Background").await?;
        }
        let removed = self.state.lock().unwrap().slots.remove(hex);
        if let Some(slot) = removed {
            crate::timing::emit(crate::timing::pool_slot_event(
                hex,
                &slot.node,
                "discarded",
                Some("discarded"),
                None,
            ));
        }
        Ok(())
    }
    /// Reads slot `hex` again after a change of one of its objects: a created slot becomes free,
    /// a free one that changed is discarded, and a claimed one whose Pod is no longer the one the
    /// volume was moved into is retired. Answers the database whose slot is to be retired.
    pub async fn observe(&self, hex: &str) -> Result<Option<String>, Error> {
        let ns = slot_namespace(hex);
        let Some(slot) = self.state.lock().unwrap().slots.get(hex).cloned() else {
            return Ok(None);
        };
        let (namespace, cluster, pod, ca) = tokio::try_join!(
            self.k8s.read_known("Namespace", None, &ns),
            self.k8s.read_known("Cluster", Some(&ns), "database"),
            self.k8s.read_known("Pod", Some(&ns), "database-1"),
            self.k8s.read_known("Secret", Some(&ns), "database-ca"),
        )?;
        match &slot.state {
            SlotState::Claimed(id) => {
                let current = pod.as_ref().and_then(slot_pod);
                let held = self
                    .serving(id)
                    .is_some_and(|serving| current.as_ref() == Some(&serving.pod));
                if !held {
                    self.unwind_later(id, "container_missing");
                    return Ok(Some(id.clone()));
                }
                Ok(None)
            }
            SlotState::Creating { since } => {
                if let (Some(namespace), Some(cluster), Some(pod)) = (&namespace, &cluster, &pod)
                    && slot_free(namespace, cluster, pod, ca.as_ref(), &slot.image)
                {
                    let mut state = self.state.lock().unwrap();
                    if let Some(held) = state.slots.get_mut(hex) {
                        held.state = SlotState::Free;
                        held.pod = slot_pod(pod);
                    }
                    crate::timing::emit(crate::timing::pool_slot_event(
                        hex,
                        &slot.node,
                        "free",
                        None,
                        Some(u64::try_from(since.elapsed().as_millis()).unwrap_or(u64::MAX)),
                    ));
                }
                Ok(None)
            }
            SlotState::Free => {
                let still = match (&namespace, &cluster, &pod) {
                    (Some(namespace), Some(cluster), Some(pod)) => {
                        slot_free(namespace, cluster, pod, ca.as_ref(), &slot.image)
                            && slot_pod(pod) == slot.pod
                    }
                    _ => false,
                };
                if !still {
                    self.discard(hex).await?;
                }
                Ok(None)
            }
            SlotState::Discarding => Ok(None),
        }
    }
    /// What the pool holds per node: free, being created and serving slots.
    pub fn states(&self) -> BTreeMap<String, (usize, usize, usize)> {
        let state = self.state.lock().unwrap();
        let mut nodes: BTreeMap<String, (usize, usize, usize)> = BTreeMap::new();
        for slot in state.slots.values() {
            let entry = nodes.entry(slot.node.clone()).or_default();
            match slot.state {
                SlotState::Free => entry.0 += 1,
                SlotState::Creating { .. } => entry.1 += 1,
                SlotState::Claimed(_) => entry.2 += 1,
                SlotState::Discarding => {}
            }
        }
        nodes
    }
    /// The slot and serving facts a controller that starts finds (rule 6.1): free and created
    /// slots, slots that serve a database whose release is in its fence, and claims that never
    /// were released, which are retired. Holders of slot Pods that no longer exist are released.
    /// Answers the databases whose slots are to be retired.
    pub async fn rediscover(&self, rec: &Reconciler) -> Result<Vec<String>, Error> {
        let namespaces = self.k8s.list("Namespace", None, Some(SLOT_LABEL)).await?;
        let storages = self
            .k8s
            .list("ConfigMap", Some(SYSTEM), Some(DATABASE_LABEL))
            .await?;
        let volume_of_lv = |lv_uuid: &str| -> Option<(String, Volume)> {
            storages.iter().find_map(|storage| {
                let identity =
                    storage["metadata"]["annotations"]["pgcf.io/volume-identity"].as_str()?;
                let state: Value = serde_json::from_str(text(&storage["data"], "state")).ok()?;
                let db = json!({"storage":state["storage"]});
                let volume = volume_of(&db, identity)?;
                (volume.lv_uuid == lv_uuid).then(|| {
                    (
                        text(&storage["metadata"]["labels"], DATABASE_LABEL).to_string(),
                        volume,
                    )
                })
            })
        };
        let mut retiring = vec![];
        let mut pods = vec![];
        let now = Instant::now();
        for namespace in &namespaces {
            let name = text(&namespace["metadata"], "name");
            let hex = text(&namespace["metadata"]["labels"], SLOT_LABEL);
            let node = text(&namespace["metadata"]["labels"], "pgcf.io/slot-node");
            if name != slot_namespace(hex) || !pgcf_native_protocol::wake::is_slot_namespace(name) {
                continue;
            }
            let (cluster, pod, ca) = tokio::try_join!(
                self.k8s.read("Cluster", Some(name), "database"),
                self.k8s.read("Pod", Some(name), "database-1"),
                self.k8s.read("Secret", Some(name), "database-ca"),
            )?;
            let Some(cluster) = cluster else {
                // A slot whose Cluster is gone serves nothing: it is deleted.
                self.state.lock().unwrap().slots.insert(
                    hex.into(),
                    Slot {
                        hex: hex.into(),
                        node: node.into(),
                        state: SlotState::Creating { since: now },
                        image: String::new(),
                        cpu_millicores: 0,
                        memory_mib: 0,
                        pod: None,
                        created: now,
                    },
                );
                continue;
            };
            let limits = &cluster["spec"]["resources"]["limits"];
            let current = pod.as_ref().and_then(slot_pod);
            if let Some(current) = &current {
                pods.push(current.uid.clone());
            }
            let mut slot = Slot {
                hex: hex.into(),
                node: node.into(),
                state: SlotState::Creating { since: now },
                image: text(&cluster["spec"], "imageName").into(),
                cpu_millicores: crate::reconcile::quantity(&limits["cpu"])
                    .map_or(0, |cpu| (cpu * 1000.0).round() as u64),
                memory_mib: mebibytes(&limits["memory"]).map_or(0, |mib| mib.round() as u64),
                pod: current.clone(),
                created: now,
            };
            let claim = cluster["metadata"]["annotations"][CLAIM]
                .as_str()
                .and_then(|raw| serde_json::from_str::<Claim>(raw).ok());
            let Some(claim) = claim else {
                if let Some(pod) = &pod
                    && slot_free(namespace, &cluster, pod, ca.as_ref(), &slot.image)
                {
                    slot.state = SlotState::Free;
                }
                self.state.lock().unwrap().slots.insert(hex.into(), slot);
                continue;
            };
            let id = claim.database.clone();
            self.k8s.index_slot(name, Some(&id));
            let fence = self
                .k8s
                .read("ConfigMap", Some(SYSTEM), &format!("gateway-fence-{id}"))
                .await?;
            let intent = PowerIntent {
                database: id.clone(),
                operation: claim.operation.clone(),
                revision: claim.generation,
                mode: "running".into(),
            };
            let target: Option<Value> = fence
                .as_ref()
                .and_then(|fence| fence["data"]["admission_target"].as_str())
                .and_then(|raw| serde_json::from_str(raw).ok());
            let released = fence.as_ref().is_some_and(|fence| {
                crate::power::fence_intent(fence, &id).as_ref() == Some(&intent)
            }) && current.as_ref().is_some_and(|current| {
                target
                    .as_ref()
                    .is_some_and(|target| target["pod_uid"] == current.uid.as_str())
            });
            let confirmed = released
                && fence
                    .as_ref()
                    .is_some_and(|fence| crate::power::woke_under(fence, &intent, now_ms()));
            let storage = storages
                .iter()
                .find(|storage| storage["metadata"]["name"] == format!("storage-{id}"));
            let volume = storage.and_then(|storage| {
                let state: Value = serde_json::from_str(text(&storage["data"], "state")).ok()?;
                volume_of(
                    &json!({"storage":state["storage"]}),
                    storage["metadata"]["annotations"]["pgcf.io/volume-identity"].as_str()?,
                )
            });
            let (Some(volume), Some(pod)) = (
                volume,
                current.or_else(|| {
                    pod.as_ref().map(|pod| SlotPod {
                        uid: text(&pod["metadata"], "uid").into(),
                        ip: text(&pod["status"], "podIP").into(),
                        postgres: String::new(),
                        sidecar: String::new(),
                    })
                }),
            ) else {
                // Nothing of it can be served or released here: the slot is deleted.
                slot.state = SlotState::Discarding;
                self.state.lock().unwrap().slots.insert(hex.into(), slot);
                self.discard(hex).await?;
                continue;
            };
            slot.state = SlotState::Claimed(id.clone());
            let serving = Serving {
                slot: hex.into(),
                node: node.into(),
                generation: claim.generation,
                operation: claim.operation.clone(),
                ticket: (released && !confirmed)
                    .then(|| Ticket::new(&id, &claim.operation, claim.generation, now)),
                pod,
                volume,
                target_before: None,
                // The configuration it serves is not known here: the first pass compares with
                // the desired row and hands over on any difference.
                structure: String::new(),
                configuration: String::new(),
                retire: (!released).then_some(Retire {
                    restore: false,
                    reason: "unreleased",
                }),
            };
            if !released {
                retiring.push(id.clone());
            }
            let mut state = self.state.lock().unwrap();
            state.slots.insert(hex.into(), slot);
            state.serving.insert(id, serving);
        }
        // Holders of slot Pods that are gone: their Pod's mounts went with it.
        for agent in rec.power.attach.agents().await? {
            let keys = rec.power.attach_keys().await?;
            let Ok(held) = rec
                .power
                .attach
                .call::<_, HoldersResponse>(
                    &keys,
                    &agent,
                    Action::Holders,
                    "",
                    &HoldersRequest {},
                    Duration::from_secs(2),
                    now_ms(),
                )
                .await
            else {
                continue;
            };
            for entry in held.holders {
                let Some(pod_uid) = entry
                    .holder
                    .strip_prefix("slot:")
                    .and_then(|rest| rest.split_once(':'))
                    .map(|(uid, _)| uid.to_string())
                else {
                    continue;
                };
                if pods.contains(&pod_uid) {
                    continue;
                }
                let Some((_, volume)) = volume_of_lv(&entry.lv_uuid) else {
                    continue;
                };
                let _ = rec
                    .power
                    .attach
                    .call::<_, ReleaseResponse>(
                        &keys,
                        &agent,
                        Action::Release,
                        &entry.lv_uuid,
                        &ReleaseRequest {
                            volume,
                            holder: Holder::Slot { pod_uid },
                            wait_ms: attach_protocol::MAX_RELEASE_WAIT_MS,
                        },
                        Duration::from_millis(attach_protocol::MAX_RELEASE_WAIT_MS + 2_000),
                        now_ms(),
                    )
                    .await;
            }
        }
        Ok(retiring)
    }
    /// Writes the attach keyring the agents verify tokens with into Secret
    /// `pgcf-attach/pgcf-attach-key`, only when it differs. `true` when it wrote.
    pub async fn publish_keys(&self, rec: &Reconciler) -> Result<bool, Error> {
        let encoded = rec.power.attach_keys().await?.encode();
        let current = self
            .k8s
            .read(
                "Secret",
                Some(attach_protocol::NAMESPACE),
                attach_protocol::KEY_SECRET,
            )
            .await?;
        let data = json!({attach_protocol::KEY_FIELD:STANDARD.encode(&encoded)});
        match current {
            Some(secret) if secret["data"] == data => Ok(false),
            Some(secret) => {
                self.k8s.patch(&secret, &json!({"data":data})).await?;
                Ok(true)
            }
            None => {
                self.k8s
                    .create(&json!({"apiVersion":"v1","kind":"Secret","metadata":{"name":attach_protocol::KEY_SECRET,"namespace":attach_protocol::NAMESPACE,"labels":{"app.kubernetes.io/part-of":"pgcf"}},"type":"Opaque","data":data}))
                    .await?;
                Ok(true)
            }
        }
    }
}

#[cfg(test)]
#[path = "pool_tests.rs"]
mod tests;
