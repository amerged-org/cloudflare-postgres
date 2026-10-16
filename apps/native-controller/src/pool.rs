// SPDX-License-Identifier: Apache-2.0
//! The pool of free PostgreSQL instances (pool design 2026-10-16): free CNPG slots on each node,
//! fenced from creation; a wake of a sleeping thin database attaches its volume to a free slot,
//! binds the slot to the tenant and lifts the fence. The slot is that database until it sleeps,
//! and is discarded afterwards.
use crate::{
    Error,
    attach_protocol::{Control, Volume},
    contracts::{configuration_fingerprint, number, optional_number, text},
    manifests,
};
use pgcf_native_protocol::wake::{Outcome, WakeRequest};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{BTreeMap, HashMap},
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
const DATABASE_LABEL: &str = "pgcf.io/database-id";

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

#[cfg(test)]
#[path = "pool_tests.rs"]
mod tests;
