// SPDX-License-Identifier: Apache-2.0
//! Bounded, authentication-scoped counters. Reads cannot allocate or invent history.
use pgcf_native_protocol::{constant, valid_pattern};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashMap},
    sync::{Arc, LazyLock},
    time::{SystemTime, UNIX_EPOCH},
};
const MAX_SAFE: u64 = (1u64 << 53) - 1;
pub type Clock = Arc<dyn Fn() -> u64 + Send + Sync>;
fn real_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock after epoch")
        .as_millis()
        .try_into()
        .expect("bounded system time")
}
fn uuid() -> String {
    let mut bytes = [0u8; 16];
    rustls::crypto::ring::default_provider()
        .secure_random
        .fill(&mut bytes)
        .expect("secure runtime identity");
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    let hex = bytes.iter().map(|b| format!("{b:02x}")).collect::<String>();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    )
}
fn iso(milliseconds: u64) -> String {
    let value =
        time::OffsetDateTime::from_unix_timestamp_nanos(i128::from(milliseconds) * 1_000_000)
            .expect("supported system timestamp");
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        value.year(),
        u8::from(value.month()),
        value.day(),
        value.hour(),
        value.minute(),
        value.second(),
        value.millisecond()
    )
}
static PROCESS: LazyLock<(String, u64)> = LazyLock::new(|| (uuid(), real_now()));
struct Record {
    ingress: u64,
    egress: u64,
    total: u64,
    closed_ms: u64,
    active: usize,
    last_activity: Option<u64>,
    since: u64,
    complete: bool,
    invalid: bool,
    order: u128,
}
struct Session {
    database: String,
    record: bool,
    authenticated_at: Option<u64>,
    ingress: u64,
    egress: u64,
    invalid: bool,
}
#[derive(Clone, Copy)]
enum Counter {
    Ingress,
    Egress,
    Total,
    ClosedMilliseconds,
}
pub struct GatewayMeasurements {
    pub epoch: String,
    pub process_epoch: String,
    pub started_at: String,
    pub counter_started_at: String,
    counter_started_ms: u64,
    records: HashMap<String, Record>,
    order: BTreeMap<u128, String>,
    next_order: u128,
    sessions: HashMap<String, Session>,
    clock: Clock,
    max_records: usize,
    incomplete: bool,
}
impl Default for GatewayMeasurements {
    fn default() -> Self {
        Self::new()
    }
}
impl GatewayMeasurements {
    pub fn new() -> Self {
        Self::new_with_clock(Arc::new(real_now))
    }
    pub fn new_with_clock(clock: Clock) -> Self {
        Self::new_with_options(clock, constant("MAX_ACTIVITY_RECORDS") as usize)
            .expect("generated activity record bound")
    }
    pub fn new_with_options(clock: Clock, max_records: usize) -> Result<Self, &'static str> {
        if max_records == 0 || max_records > constant("MAX_ACTIVITY_RECORDS") as usize {
            return Err("invalid activity record bound");
        }
        let process = &*PROCESS;
        let now = clock();
        Ok(Self {
            epoch: uuid(),
            process_epoch: process.0.clone(),
            started_at: iso(process.1),
            counter_started_at: iso(now),
            counter_started_ms: now,
            records: HashMap::new(),
            order: BTreeMap::new(),
            next_order: 0,
            sessions: HashMap::new(),
            clock,
            max_records,
            incomplete: false,
        })
    }
    pub fn size(&self) -> usize {
        self.records.len()
    }
    /// A transport must reject a duplicate live handle; replacing it loses another session's counters.
    #[must_use]
    pub fn begin(&mut self, database: &str, id: &str) -> bool {
        if !valid_pattern("database", database) || id.is_empty() || self.sessions.contains_key(id) {
            return false;
        }
        self.sessions.insert(
            id.into(),
            Session {
                database: database.into(),
                record: false,
                authenticated_at: None,
                ingress: 0,
                egress: 0,
                invalid: false,
            },
        );
        true
    }
    fn insert_record(&mut self, database: &str) {
        if self.records.contains_key(database) {
            return;
        }
        if self.records.len() >= self.max_records {
            if let Some((order, id)) = self
                .order
                .iter()
                .find(|(_, id)| self.records[*id].active == 0)
                .map(|(order, id)| (*order, id.clone()))
            {
                self.order.remove(&order);
                self.records.remove(&id);
            }
            self.incomplete = true;
        }
        if self.records.len() < self.max_records {
            self.next_order += 1;
            let order = self.next_order;
            let since = if self.incomplete {
                (self.clock)()
            } else {
                self.counter_started_ms
            };
            self.records.insert(
                database.into(),
                Record {
                    ingress: 0,
                    egress: 0,
                    total: 0,
                    closed_ms: 0,
                    active: 0,
                    last_activity: None,
                    since,
                    complete: !self.incomplete,
                    invalid: false,
                    order,
                },
            );
            self.order.insert(order, database.into());
        }
    }
    fn add(&mut self, database: &str, counter: Counter, amount: u64) {
        if let Some(record) = self.records.get_mut(database) {
            let target = match counter {
                Counter::Ingress => &mut record.ingress,
                Counter::Egress => &mut record.egress,
                Counter::Total => &mut record.total,
                Counter::ClosedMilliseconds => &mut record.closed_ms,
            };
            if let Some(value) = target.checked_add(amount).filter(|v| *v <= MAX_SAFE) {
                *target = value;
            } else {
                record.invalid = true;
            }
        }
    }
    fn touch(&mut self, database: &str) {
        if let Some(record) = self.records.get_mut(database) {
            record.last_activity = Some((self.clock)());
            self.order.remove(&record.order);
            self.next_order += 1;
            record.order = self.next_order;
            self.order.insert(record.order, database.into());
        }
    }
    fn bytes(&mut self, id: &str, amount: usize, incoming: bool) {
        let Some(session) = self.sessions.get_mut(id) else {
            return;
        };
        assert!(
            (amount as u128) <= u128::from(MAX_SAFE),
            "invalid activity bytes"
        );
        let amount = amount as u64;
        let field = if incoming {
            &mut session.ingress
        } else {
            &mut session.egress
        };
        if let Some(value) = field.checked_add(amount).filter(|v| *v <= MAX_SAFE) {
            *field = value;
        } else {
            session.invalid = true;
        }
        let database = session.database.clone();
        let record = session.record;
        let invalid = session.invalid;
        if record {
            if invalid {
                self.records.get_mut(&database).unwrap().invalid = true;
            }
            self.add(
                &database,
                if incoming {
                    Counter::Ingress
                } else {
                    Counter::Egress
                },
                amount,
            );
        }
    }
    pub fn ingress(&mut self, id: &str, bytes: usize) {
        self.bytes(id, bytes, true)
    }
    pub fn egress(&mut self, id: &str, bytes: usize) {
        self.bytes(id, bytes, false)
    }
    pub fn authenticated(&self, id: &str) -> bool {
        self.sessions
            .get(id)
            .is_some_and(|v| v.authenticated_at.is_some())
    }
    pub fn authenticate(&mut self, id: &str) {
        let Some(session) = self.sessions.get(id) else {
            return;
        };
        if session.authenticated_at.is_some() {
            return;
        }
        let database = session.database.clone();
        self.insert_record(&database);
        let record = self.records.get_mut(&database);
        let has_record = record.is_some();
        if let Some(record) = record {
            record.active += 1;
        }
        let session = self.sessions.get_mut(id).unwrap();
        session.record = has_record;
        session.authenticated_at = Some((self.clock)());
        let (ingress, egress, invalid) = (session.ingress, session.egress, session.invalid);
        if has_record {
            if invalid {
                self.records.get_mut(&database).unwrap().invalid = true;
            }
            self.add(&database, Counter::Ingress, ingress);
            self.add(&database, Counter::Egress, egress);
            self.add(&database, Counter::Total, 1);
            self.touch(&database);
        }
    }
    pub fn client_activity(&mut self, id: &str) {
        if let Some(session) = self.sessions.get(id)
            && session.authenticated_at.is_some()
            && session.record
        {
            let database = session.database.clone();
            self.touch(&database);
        }
    }
    pub fn close(&mut self, id: &str) {
        let Some(session) = self.sessions.remove(id) else {
            return;
        };
        if session.record {
            self.records.get_mut(&session.database).unwrap().active -= 1;
            if let Some(at) = session.authenticated_at {
                self.add(
                    &session.database,
                    Counter::ClosedMilliseconds,
                    (self.clock)().saturating_sub(at),
                );
            }
        }
    }
    /// `database` is validated by the signed activity claim before this internal read.
    pub fn read(&self, database: &str) -> Value {
        assert!(
            valid_pattern("database", database),
            "invalid database identity"
        );
        let observed = (self.clock)();
        let record = self.records.get(database);
        let mut milliseconds = record.map(|r| r.closed_ms);
        let mut unavailable = record.is_some_and(|r| r.invalid);
        if record.is_some() {
            for session in self
                .sessions
                .values()
                .filter(|v| v.database == database && v.record)
            {
                if let Some(at) = session.authenticated_at {
                    milliseconds = milliseconds
                        .and_then(|v| v.checked_add(observed.saturating_sub(at)))
                        .filter(|v| *v <= MAX_SAFE);
                    if milliseconds.is_none() {
                        unavailable = true;
                    }
                }
            }
        }
        let history = if unavailable {
            "unavailable"
        } else if let Some(record) = record {
            if record.complete {
                "complete"
            } else {
                "partial"
            }
        } else if self.incomplete {
            "unavailable"
        } else {
            "current_process_absence"
        };
        let absent = history == "current_process_absence";
        let count = |value: Option<u64>| {
            if unavailable {
                None
            } else {
                value.or(if absent { Some(0) } else { None })
            }
        };
        json!({"processEpoch":self.process_epoch,"epoch":self.epoch,"startedAt":self.started_at,"counterStartedAt":self.counter_started_at,"observedAt":iso(observed),"history":history,"countersSince":if unavailable || (record.is_none()&&!absent){None}else{Some(record.map(|r|iso(r.since)).unwrap_or_else(||self.counter_started_at.clone()))},"ingressBytes":count(record.map(|r|r.ingress)),"egressBytes":count(record.map(|r|r.egress)),"totalConnections":count(record.map(|r|r.total)),"connectionMilliseconds":count(milliseconds),"lastActivityAt":record.and_then(|r|r.last_activity).map(iso)})
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    fn normalize(mut value: Value) -> Value {
        for field in ["processEpoch", "epoch", "startedAt"] {
            value.as_object_mut().unwrap().remove(field);
        }
        value
    }
    #[test]
    fn authoritative_typescript_measurement_vectors() {
        let fixtures: Value = serde_json::from_str(include_str!(
            "../../../packages/contracts/native/conformance.generated.json"
        ))
        .unwrap();
        for case in fixtures["gatewayMeasurements"].as_array().unwrap() {
            let now = Arc::new(AtomicU64::new(case["initialNow"].as_u64().unwrap()));
            let clock = {
                let now = now.clone();
                Arc::new(move || now.load(Ordering::SeqCst)) as Clock
            };
            let mut measurements = GatewayMeasurements::new_with_options(
                clock,
                case["maxRecords"].as_u64().unwrap() as usize,
            )
            .unwrap();
            for step in case["steps"].as_array().unwrap() {
                match step["action"].as_str().unwrap() {
                    "time" => now.store(step["now"].as_u64().unwrap(), Ordering::SeqCst),
                    "begin" => assert!(measurements.begin(
                        step["database"].as_str().unwrap(),
                        step["id"].as_str().unwrap()
                    )),
                    "ingress" => measurements.ingress(
                        step["id"].as_str().unwrap(),
                        step["bytes"].as_u64().unwrap() as usize,
                    ),
                    "egress" => measurements.egress(
                        step["id"].as_str().unwrap(),
                        step["bytes"].as_u64().unwrap() as usize,
                    ),
                    "authenticate" => measurements.authenticate(step["id"].as_str().unwrap()),
                    "activity" => measurements.client_activity(step["id"].as_str().unwrap()),
                    "close" => measurements.close(step["id"].as_str().unwrap()),
                    "read" => {
                        assert_eq!(
                            normalize(measurements.read(step["database"].as_str().unwrap())),
                            step["expected"],
                            "{} {step}",
                            case["name"]
                        );
                        assert_eq!(measurements.size(), step["size"].as_u64().unwrap() as usize);
                    }
                    _ => panic!("unknown generated telemetry action"),
                }
            }
        }
    }
    #[test]
    fn duplicate_live_ids_never_replace_authenticated_records() {
        let mut m = GatewayMeasurements::new();
        assert!(m.begin(&"a".repeat(20), "live"));
        m.authenticate("live");
        m.ingress("live", 17);
        assert!(!m.begin(&"b".repeat(20), "live"));
        assert_eq!(m.read(&"a".repeat(20))["ingressBytes"], 17);
        assert_eq!(
            m.read(&"b".repeat(20))["history"],
            "current_process_absence"
        );
    }
    #[test]
    fn epochs_are_distinct_but_share_a_process_identity() {
        let a = GatewayMeasurements::new();
        let b = GatewayMeasurements::new();
        assert_ne!(a.epoch, b.epoch);
        assert_eq!(a.process_epoch, b.process_epoch);
        assert_eq!(a.started_at, b.started_at);
        assert!(a.started_at <= a.counter_started_at);
        assert!(b.started_at <= b.counter_started_at);
        assert!(valid_pattern("uuid", &a.epoch));
        assert!(valid_pattern("uuid", &a.process_epoch));
    }
}
