// SPDX-License-Identifier: Apache-2.0
//! Usage and idle observations. Persist immutable samples before sending; missing history or
//! physical facts remain unknown, never manufactured zeroes.
use crate::{
    Error,
    contracts::{integer, number, schema_valid, text},
};
use pgcf_native_protocol::valid_pattern;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{collections::HashSet, sync::LazyLock};
static CONTRACT: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!(
        "../../../packages/contracts/native/measurements.generated.json"
    ))
    .expect("generated measurement contract")
});
fn limit(name: &str) -> u64 {
    CONTRACT["constants"][name]
        .as_u64()
        .expect("generated measurement limit")
}
fn key(name: &str) -> &'static str {
    CONTRACT["constants"][name]
        .as_str()
        .expect("generated measurement key")
}
fn iso(ms: u64) -> Result<String, Error> {
    let value = time::OffsetDateTime::from_unix_timestamp_nanos(i128::from(ms) * 1_000_000)?;
    Ok(format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        value.year(),
        u8::from(value.month()),
        value.day(),
        value.hour(),
        value.minute(),
        value.second(),
        value.millisecond()
    ))
}
fn millis(value: &Value) -> Result<u64, Error> {
    let raw = value.as_str().ok_or("measurement timestamp missing")?;
    let time = time::OffsetDateTime::parse(raw, &time::format_description::well_known::Rfc3339)?;
    let ms: u64 = (time.unix_timestamp_nanos() / 1_000_000).try_into()?;
    if iso(ms)? != raw {
        return Err("measurement timestamp precision invalid".into());
    }
    Ok(ms)
}
fn remove(value: &mut Value, key: &str) {
    if let Some(map) = value.as_object_mut() {
        map.remove(key);
    }
}
fn history(v: &Value) -> bool {
    !v["countersSince"].is_null()
        && (v["history"] == "current_process_absence"
            || (v["history"] == "complete" && !v["lastActivityAt"].is_null()))
}
fn same_epoch(a: &Value, b: &Value) -> bool {
    [
        "pod",
        "processEpoch",
        "epoch",
        "startedAt",
        "counterStartedAt",
        "countersSince",
    ]
    .iter()
    .all(|field| a[*field] == b[*field])
}
fn producer(v: &Value) -> String {
    format!(
        "gw_{}_{}_{}",
        text(v, "pod"),
        text(v, "processEpoch"),
        text(v, "epoch")
    )
}
fn report_valid(v: &Value) -> bool {
    if !schema_valid("GatewayActivityReport", v) {
        return false;
    }
    let checked = (|| -> Result<(), Error> {
        let start = millis(&v["startedAt"])?;
        let counter = millis(&v["counterStartedAt"])?;
        let observed = millis(&v["observedAt"])?;
        if counter < start || observed < counter {
            return Err("measurement report clock invalid".into());
        }
        for field in ["countersSince", "lastActivityAt"] {
            if !v[field].is_null() {
                let n = millis(&v[field])?;
                if n < counter || n > observed {
                    return Err("measurement report clock invalid".into());
                }
            }
        }
        if integer(v, "authenticatedConnections")? > integer(v, "connections")?
            || integer(v, "busyConnections")? > integer(v, "authenticatedConnections")?
            || integer(v, "pendingDials")? > integer(v, "connections")?
        {
            return Err("measurement report count invalid".into());
        }
        let fields = [
            "ingressBytes",
            "egressBytes",
            "totalConnections",
            "connectionMilliseconds",
        ];
        if v["history"] == "unavailable" {
            if !v["countersSince"].is_null() || fields.iter().any(|f| !v[*f].is_null()) {
                return Err("unknown history invalid".into());
            }
        } else if v["countersSince"].is_null() || fields.iter().any(|f| integer(v, f).is_err()) {
            return Err("known history invalid".into());
        }
        if ["complete", "current_process_absence"]
            .iter()
            .any(|h| v["history"] == *h)
            && v["countersSince"] != v["counterStartedAt"]
        {
            return Err("measurement history start invalid".into());
        }
        if v["history"] == "current_process_absence"
            && (!v["lastActivityAt"].is_null()
                || fields.iter().any(|f| number(v, f) != 0)
                || integer(v, "authenticatedConnections")? != 0
                || integer(v, "busyConnections")? != 0)
        {
            return Err("absence conceals activity".into());
        }
        Ok(())
    })();
    checked.is_ok()
}
/// The storage state compares by content: its writers serialize the same keys in different orders.
fn same_identity(stored: &Value, current: &Value) -> bool {
    let parse = |v: &Value| {
        v.as_str()
            .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
    };
    stored.as_object().is_some_and(|fields| fields.len() == 5)
        && ["storage", "namespace", "cluster", "fence"]
            .iter()
            .all(|key| stored[*key] == current[*key])
        && parse(&stored["state"]).is_some_and(|state| Some(state) == parse(&current["state"]))
}
pub fn checkpoint(resource: &Value, identity: &Value) -> Result<Value, Error> {
    let Some(raw) = resource["data"][key("MEASUREMENT_CHECKPOINT_KEY")].as_str() else {
        if !resource["data"][key("MEASUREMENT_CHECKPOINT_KEY")].is_null() {
            return Err("measurement checkpoint invalid".into());
        }
        return Ok(json!({"version":1,"identity":identity,"outbox":[]}));
    };
    if raw.len() > limit("MEASUREMENT_CHECKPOINT_BYTES") as usize {
        return Err("measurement checkpoint exceeds bound".into());
    }
    let value: Value = serde_json::from_str(raw)?;
    if value["version"] != 1 || !same_identity(&value["identity"], identity) {
        return Err("measurement checkpoint identity changed".into());
    }
    let outbox = value["outbox"]
        .as_array()
        .filter(|rows| rows.len() <= limit("MEASUREMENT_MAX_OUTBOX") as usize)
        .ok_or("measurement outbox invalid")?;
    if outbox
        .iter()
        .any(|sample| !schema_valid("UsageSample", sample))
    {
        return Err("measurement outbox invalid".into());
    }
    let mut result = json!({"version":1,"identity":identity,"outbox":outbox});
    for field in ["gapSince", "idleObservedSince"] {
        if !value[field].is_null() {
            millis(&value[field])?;
            result[field] = value[field].clone();
        }
    }
    if !value["baseline"].is_null() {
        let base = &value["baseline"];
        let reports = base["reports"]
            .as_array()
            .filter(|rows| !rows.is_empty() && rows.len() <= 16)
            .ok_or("measurement baseline invalid")?;
        let inventory = base["inventory"]
            .as_array()
            .filter(|rows| rows.len() == reports.len())
            .ok_or("measurement inventory invalid")?;
        if text(base, "keyUid").is_empty()
            || text(base, "keyVersion").is_empty()
            || reports.iter().any(|v| !report_valid(v))
        {
            return Err("measurement baseline invalid".into());
        }
        let mut pod_ids = HashSet::new();
        for pod in inventory {
            if !valid_pattern("uuid", text(pod, "uid"))
                || text(pod, "name").is_empty()
                || text(pod, "name").len() > 253
                || text(pod, "ip").parse::<std::net::IpAddr>().is_err()
                || integer(pod, "restarts").is_err()
                || !pod_ids.insert(text(pod, "uid"))
            {
                return Err("measurement inventory invalid".into());
            }
        }
        let mut respondents = HashSet::new();
        if reports.iter().any(|report| {
            !pod_ids.contains(text(report, "pod")) || !respondents.insert(text(report, "pod"))
        }) {
            return Err("measurement baseline respondents invalid".into());
        }
        let mut normalized = json!({"inventory":inventory,"reports":reports,"keyUid":base["keyUid"],"keyVersion":base["keyVersion"]});
        if !base["sampledAt"].is_null() {
            millis(&base["sampledAt"])?;
            normalized["sampledAt"] = base["sampledAt"].clone();
        }
        result["baseline"] = normalized;
    }
    if !result["idleObservedSince"].is_null() {
        let idle = millis(&result["idleObservedSince"])?;
        if result["baseline"]["sampledAt"].is_null()
            || idle > millis(&result["baseline"]["sampledAt"])?
            || (!result["gapSince"].is_null() && idle < millis(&result["gapSince"])?)
        {
            return Err("measurement idle boundary invalid".into());
        }
    }
    Ok(result)
}
/// The cumulative gateway counters: the usage sample field and the report field it is counted from.
const COUNTERS: [(&str, &str); 4] = [
    ("ingress_bytes", "ingressBytes"),
    ("egress_bytes", "egressBytes"),
    ("connections", "totalConnections"),
    ("connection_seconds", "connectionMilliseconds"),
];
/// Whole seconds are integers, like the JSON the TypeScript authority writes.
fn seconds(milliseconds: u64) -> Value {
    if milliseconds.is_multiple_of(1000) {
        Value::from(milliseconds / 1000)
    } else {
        Value::from(milliseconds as f64 / 1000.0)
    }
}
/// The traffic between two observations of one gateway counter run. A sample never crosses a UTC
/// hour, so a span that touches two adjacent hours is two fragments. A known delta is split between
/// them pro rata by elapsed time in exact integer arithmetic: the earlier fragment takes the floor of
/// its share and the later one the remainder, so the parts always add up to the measured delta. The
/// timing error is bounded by the span, one measurement interval. A restart, counter reset,
/// inventory change or incomplete report is unknown in every fragment, and so is a span over more
/// than two hours: the hours in between have no fragment to receive a share.
///
/// `unchanged_until` is when `previous`, held across quiet cycles, was last seen with its counters
/// unchanged: the traffic was counted after it, so the share is spread over that window instead of
/// the whole held span. Without it the window is the span itself.
fn differences(
    previous: &Value,
    current: &Value,
    expected: &Value,
    continuous: bool,
    unchanged_until: Option<u64>,
) -> Result<Vec<Value>, Error> {
    let start = millis(&previous["observedAt"])?;
    let end = millis(&current["observedAt"])?;
    if end <= start {
        return Ok(vec![]);
    }
    let known = continuous
        && same_epoch(previous, current)
        && history(previous)
        && history(current)
        && COUNTERS.iter().all(|(_, field)| {
            integer(previous, field)
                .ok()
                .zip(integer(current, field).ok())
                .is_some_and(|(a, b)| b >= a)
        });
    let hour = limit("USAGE_HOUR_MS");
    let (first, last) = (start / hour, (end - 1) / hour);
    let boundary = (first + 1) * hour;
    let fragments = if first == last {
        vec![(start, end)]
    } else {
        vec![(start, boundary), (last * hour, end)]
    };
    let window = unchanged_until.map_or(start, |at| at.clamp(start, end - 1));
    // What each fragment receives of one counter's delta; `None` where it is unknown.
    let shares = |field: &str| -> Vec<Option<u64>> {
        if !known {
            return vec![None; fragments.len()];
        }
        let delta = number(current, field) - number(previous, field);
        match last - first {
            0 => vec![Some(delta)],
            1 => {
                let before = u128::from(boundary.saturating_sub(window));
                let earlier = u64::try_from(u128::from(delta) * before / u128::from(end - window))
                    .expect("a share of a delta fits the delta");
                vec![Some(earlier), Some(delta - earlier)]
            }
            _ => vec![None, None],
        }
    };
    let counted = COUNTERS.map(|(_, field)| shares(field));
    fragments
        .iter()
        .enumerate()
        .map(|(index, &(from, to))| {
            let value = |counter: usize| counted[counter][index].map_or(Value::Null, Value::from);
            let sample = json!({
                "database_id": current["database"],
                "source": "gateway",
                "producer_id": producer(current),
                "sequence": to,
                "observed_at": current["observedAt"],
                "interval_start": iso(from)?,
                "interval_end": iso(to)?,
                "expected_producers": expected,
                "ingress_bytes": value(0),
                "egress_bytes": value(1),
                "connections": value(2),
                "connection_seconds": counted[3][index].map_or(Value::Null, seconds),
            });
            if !schema_valid("UsageSample", &sample) {
                return Err("measurement delta invalid".into());
            }
            Ok(sample)
        })
        .collect()
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayPod {
    pub name: String,
    pub uid: String,
    pub ip: String,
    pub restarts: u64,
}
/// The gateway processes whose reports a database's activity is judged from, and the key that
/// signed them.
#[derive(Clone)]
pub struct GatewaySnapshot {
    pub pods: Vec<GatewayPod>,
    pub key_uid: String,
    pub key_version: String,
}
/// The storage gauge most recently handed to the outbox, with the UTC hour it was taken in.
pub type Gauge = (Option<u64>, Option<u64>, u64);
/// One database's measurement state: its desired record, the persisted checkpoint, the allocated
/// bytes of its volume and the storage gauge last queued.
pub struct Work {
    pub db: Value,
    pub checkpoint: Value,
    pub allocated: Option<u64>,
    /// The storage gauge last queued in the outbox; the process keeps it once that checkpoint is saved.
    pub gauge: Option<Gauge>,
}
pub fn batches(field: &str, values: Vec<Value>) -> Result<Vec<Vec<Value>>, Error> {
    let mut result = Vec::new();
    let mut current = Vec::new();
    for value in values {
        let mut candidate = current.clone();
        candidate.push(value.clone());
        if current.len() == limit("MEASUREMENT_COHORT") as usize
            || serde_json::to_vec(&json!({field:candidate}))?.len()
                > limit("MEASUREMENT_BODY_BYTES") as usize
        {
            if current.is_empty() {
                return Err("measurement record exceeds body bound".into());
            }
            result.push(std::mem::take(&mut current));
        }
        if serde_json::to_vec(&json!({field:[&value]}))?.len()
            > limit("MEASUREMENT_BODY_BYTES") as usize
        {
            return Err("measurement record exceeds body bound".into());
        }
        current.push(value);
    }
    if !current.is_empty() {
        result.push(current);
    }
    Ok(result)
}
/// A known, measured interval inside one UTC hour in which nothing was counted. An interval over the
/// boundary is never held: both of its fragments are emitted so that each hour is complete.
fn quiet(samples: &[Value]) -> bool {
    samples.len() == 1
        && COUNTERS
            .iter()
            .all(|(field, _)| samples[0][*field].as_f64() == Some(0.0))
}
pub fn advance(
    work: &mut Work,
    reports: &[Value],
    snapshot: &GatewaySnapshot,
    used: Option<u64>,
    process: &str,
    clock: u64,
) -> Result<Option<Value>, Error> {
    let db = &work.db;
    let checkpoint = &mut work.checkpoint;
    let now = iso(clock)?;
    let inventory = serde_json::to_value(&snapshot.pods)?;
    let prior = checkpoint["baseline"].clone();
    let previous = prior["reports"].as_array();
    let complete = reports.iter().all(history);
    let continuous = !prior.is_null()
        && prior["inventory"] == inventory
        && prior["keyUid"] == snapshot.key_uid
        && prior["keyVersion"] == snapshot.key_version;
    let monotonic = previous.is_none_or(|previous| {
        reports.iter().all(|report| {
            previous
                .iter()
                .find(|last| last["pod"] == report["pod"])
                .is_none_or(|last| {
                    !same_epoch(last, report)
                        || [
                            "ingressBytes",
                            "egressBytes",
                            "totalConnections",
                            "connectionMilliseconds",
                        ]
                        .iter()
                        .all(|field| {
                            last[*field].is_null()
                                || report[*field].is_null()
                                || number(report, field) >= number(last, field)
                        })
                })
        })
    });
    let epochs_match = previous.is_some_and(|previous| {
        reports.iter().all(|report| {
            previous
                .iter()
                .find(|last| last["pod"] == report["pod"])
                .is_some_and(|last| {
                    same_epoch(last, report) && last["revision"] == report["revision"]
                })
        })
    });
    let later = previous.is_some_and(|previous| {
        reports.iter().all(|report| {
            previous
                .iter()
                .find(|last| last["pod"] == report["pod"])
                .is_some_and(|last| {
                    history(last) && text(report, "observedAt") > text(last, "observedAt")
                })
        })
    });
    let had_gap = !checkpoint["gapSince"].is_null();
    let gap_detected =
        !complete || (!prior.is_null() && (!continuous || !epochs_match)) || !monotonic;
    if gap_detected {
        checkpoint["gapSince"] = now.clone().into();
        remove(checkpoint, "idleObservedSince");
    }
    let oldest = reports
        .iter()
        .map(|v| text(v, "observedAt"))
        .min()
        .ok_or("measurement respondents missing")?;
    let recovered = complete
        && continuous
        && epochs_match
        && monotonic
        && later
        && !checkpoint["idleObservedSince"].is_null()
        && text(checkpoint, "idleObservedSince") <= oldest;
    if !checkpoint["gapSince"].is_null() && complete {
        if recovered {
            remove(checkpoint, "gapSince");
        } else if checkpoint["idleObservedSince"].is_null()
            && clock >= millis(&checkpoint["gapSince"])?
        {
            checkpoint["idleObservedSince"] = now.clone().into();
        }
    }
    let mut boundaries = reports
        .iter()
        .flat_map(|report| {
            [
                "startedAt",
                "counterStartedAt",
                "countersSince",
                "lastActivityAt",
            ]
            .iter()
            .filter_map(move |key| report[*key].as_str())
        })
        .collect::<Vec<_>>();
    if let Some(idle) = checkpoint["idleObservedSince"].as_str() {
        boundaries.push(idle);
    }
    let boundary = boundaries
        .into_iter()
        .max()
        .ok_or("measurement boundary unavailable")?;
    let mut activity = None;
    if complete && checkpoint["gapSince"].is_null() {
        let sum = |field: &str| -> Result<u64, Error> {
            reports
                .iter()
                .map(|report| integer(report, field))
                .try_fold(0u64, |sum, v| {
                    sum.checked_add(v?)
                        .filter(|v| *v <= 1_000_000)
                        .ok_or_else(|| "measurement count exceeds bound".into())
                })
        };
        let mut candidate = json!({"id":db["id"],"revision":db["generation"],"observed_at":reports.iter().map(|v|text(v,"observedAt")).max(),"last_activity_at":boundary,"connections":sum("connections")?,"busy_connections":sum("busyConnections")?,"pending_dials":sum("pendingDials")?,"expected_gateway_pods":snapshot.pods.iter().map(|pod|&pod.uid).collect::<Vec<_>>(),"reports":reports});
        if !checkpoint["idleObservedSince"].is_null() {
            candidate["idle_observed_since"] = checkpoint["idleObservedSince"].clone();
        }
        let process_epochs = reports
            .iter()
            .map(|v| text(v, "processEpoch"))
            .collect::<HashSet<_>>();
        let epochs = reports
            .iter()
            .map(|v| text(v, "epoch"))
            .collect::<HashSet<_>>();
        if process_epochs.len() == reports.len()
            && epochs.len() == reports.len()
            && number(&candidate, "busy_connections")
                .checked_add(number(&candidate, "pending_dials"))
                .is_some_and(|v| v <= 1_000_000)
            && schema_valid("AgentActivityRequest", &json!({"databases":[&candidate]}))
        {
            activity = Some(candidate);
        }
    }
    let mut pending = checkpoint["outbox"]
        .as_array()
        .ok_or("measurement outbox missing")?
        .clone();
    // A pod whose counters did not move keeps its last emitted observation as the baseline, so the
    // next sample spans the quiet period instead of one sample per cycle recording nothing.
    let mut held = HashSet::new();
    // A held pod was seen with unchanged counters at every cycle since its baseline report, the last
    // one at the time the baseline was sampled.
    let unchanged_until = millis(&prior["sampledAt"]).ok();
    if let Some(previous) = previous {
        let mut expected = reports.iter().map(producer).collect::<Vec<_>>();
        expected.sort();
        for report in reports {
            if let Some(last) = previous.iter().find(|last| last["pod"] == report["pod"]) {
                let samples = differences(
                    last,
                    report,
                    &json!(expected),
                    continuous && ((!had_gap && !gap_detected) || recovered),
                    unchanged_until,
                )?;
                if quiet(&samples) {
                    held.insert(text(report, "pod").to_string());
                } else {
                    pending.extend(samples);
                }
            }
        }
    }
    // A storage gauge nobody can measure that did not change adds nothing within its UTC hour. A
    // measured gauge is emitted every cycle: disk health reads the newest sample.
    let gauge = (used, work.allocated, clock / limit("USAGE_HOUR_MS"));
    let repeated = used.is_none() && work.gauge == Some(gauge);
    if !repeated {
        let sample = json!({"database_id":db["id"],"source":"agent","producer_id":process,"sequence":clock,"observed_at":now,"storage_used_bytes":used,"storage_allocated_bytes":work.allocated});
        if !schema_valid("UsageSample", &sample) {
            return Err("measurement storage sample invalid".into());
        }
        pending.push(sample);
    }
    let mut candidate = checkpoint.clone();
    candidate["outbox"] = json!(pending);
    if pending.len() <= limit("MEASUREMENT_MAX_OUTBOX") as usize
        && serde_json::to_vec(&candidate)?.len() <= limit("MEASUREMENT_CHECKPOINT_BYTES") as usize
    {
        let baseline = reports
            .iter()
            .map(|report| {
                previous
                    .and_then(|previous| {
                        previous.iter().find(|last| {
                            held.contains(text(report, "pod")) && last["pod"] == report["pod"]
                        })
                    })
                    .unwrap_or(report)
            })
            .collect::<Vec<_>>();
        checkpoint["outbox"] = candidate["outbox"].clone();
        checkpoint["baseline"] = json!({"sampledAt":now,"inventory":inventory,"keyUid":snapshot.key_uid,"keyVersion":snapshot.key_version,"reports":baseline});
        if !repeated {
            work.gauge = Some(gauge);
        }
    }
    Ok(activity)
}
#[cfg(test)]
mod tests {
    use super::*;
    fn vectors() -> Value {
        serde_json::from_str(include_str!(
            "../../../packages/contracts/native/measurements-vectors.generated.json"
        ))
        .unwrap()
    }
    /// Checkpoint cases recorded from the TypeScript agent before its deletion.
    fn checkpoints() -> Value {
        serde_json::from_str(include_str!("measurement-checkpoints.json")).unwrap()
    }
    #[test]
    fn recorded_checkpoint_cases_parse_as_before() {
        for value in checkpoints().as_array().unwrap() {
            let result = checkpoint(&json!({"data":value["data"]}), &value["identity"]);
            if value["rejected"] == true {
                assert!(result.is_err(), "{}", value["name"]);
            } else {
                assert_eq!(result.unwrap(), value["result"], "{}", value["name"]);
            }
        }
    }
    #[test]
    fn authoritative_typescript_counter_deltas_split_known_traffic_pro_rata() {
        for value in vectors()["differences"].as_array().unwrap() {
            assert_eq!(
                json!(
                    differences(
                        &value["previous"],
                        &value["current"],
                        &value["expected_producers"],
                        value["continuous"].as_bool().unwrap(),
                        None
                    )
                    .unwrap()
                ),
                value["result"],
                "{}",
                value["name"]
            );
        }
    }
    fn snapshot(base: &Value) -> GatewaySnapshot {
        GatewaySnapshot {
            pods: serde_json::from_value(base["inventory"].clone()).unwrap(),
            key_uid: text(base, "keyUid").into(),
            key_version: text(base, "keyVersion").into(),
        }
    }
    #[test]
    fn process_restart_requires_two_complete_observations_before_idle_recovers() {
        let vector = &checkpoints()[1];
        let mut checkpoint = vector["result"].clone();
        let snapshot = snapshot(&checkpoint["baseline"]);
        let mut report = checkpoint["baseline"]["reports"][0].clone();
        report["processEpoch"] = "01234567-89ab-4def-8123-000000000004".into();
        report["epoch"] = "01234567-89ab-4def-8123-000000000005".into();
        report["startedAt"] = iso(120000).unwrap().into();
        report["counterStartedAt"] = iso(120000).unwrap().into();
        report["countersSince"] = iso(120000).unwrap().into();
        report["lastActivityAt"] = Value::Null;
        report["history"] = "current_process_absence".into();
        for field in [
            "ingressBytes",
            "egressBytes",
            "totalConnections",
            "connectionMilliseconds",
        ] {
            report[field] = 0.into();
        }
        report["observedAt"] = iso(130000).unwrap().into();
        assert!(report_valid(&report));
        let mut work = Work {
            db: json!({"id":report["database"],"generation":1,"storage":{"backend":"lvm-thin-v1"}}),
            checkpoint: std::mem::take(&mut checkpoint),
            allocated: None,
            gauge: None,
        };
        assert!(
            advance(
                &mut work,
                &[report.clone()],
                &snapshot,
                None,
                "agent_test",
                130000
            )
            .unwrap()
            .is_none()
        );
        assert_eq!(work.checkpoint["gapSince"], iso(130000).unwrap());
        assert_eq!(work.checkpoint["idleObservedSince"], iso(130000).unwrap());
        let sample = work.checkpoint["outbox"]
            .as_array()
            .unwrap()
            .last()
            .unwrap();
        assert!(sample["storage_allocated_bytes"].is_null());
        assert!(sample["storage_used_bytes"].is_null());
        work.checkpoint["outbox"] = json!([]);
        report["observedAt"] = iso(145000).unwrap().into();
        let activity = advance(&mut work, &[report], &snapshot, None, "agent_test", 145000)
            .unwrap()
            .unwrap();
        assert!(work.checkpoint["gapSince"].is_null());
        assert_eq!(activity["last_activity_at"], iso(130000).unwrap());
        assert_eq!(activity["idle_observed_since"], iso(130000).unwrap());
        assert_eq!(activity["connections"], 0);
    }
    /// A persisted one-pod checkpoint whose baseline report was observed at 115000 ms.
    fn quiet_work() -> (Work, GatewaySnapshot) {
        let checkpoint = checkpoints()[1]["result"].clone();
        let snapshot = snapshot(&checkpoint["baseline"]);
        let work = Work {
            db: json!({"id":checkpoint["baseline"]["reports"][0]["database"],"generation":1,"storage":{"backend":"lvm-thin-v1"}}),
            checkpoint,
            allocated: None,
            gauge: None,
        };
        (work, snapshot)
    }
    /// The baseline pod observed again at `at` with `ingress` more bytes since it was held.
    fn observed(work: &Work, at: u64, ingress: u64) -> Value {
        let mut report = work.checkpoint["baseline"]["reports"][0].clone();
        report["observedAt"] = iso(at).unwrap().into();
        report["ingressBytes"] = (number(&report, "ingressBytes") + ingress).into();
        report
    }
    fn gateway_samples(work: &Work) -> Vec<Value> {
        work.checkpoint["outbox"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|sample| sample["source"] == "gateway")
            .cloned()
            .collect()
    }
    #[test]
    fn quiet_gateway_intervals_stay_open_until_traffic_is_counted() {
        let (mut work, snapshot) = quiet_work();
        let held = work.checkpoint["baseline"]["reports"].clone();
        for at in [130000, 145000] {
            let report = observed(&work, at, 0);
            advance(&mut work, &[report], &snapshot, None, "agent_test", at).unwrap();
            // Nothing was counted: no gateway sample, and the next interval still starts at 115000.
            assert!(gateway_samples(&work).is_empty(), "{at}");
            assert_eq!(work.checkpoint["baseline"]["reports"], held, "{at}");
            assert_eq!(work.checkpoint["baseline"]["sampledAt"], iso(at).unwrap());
            assert!(checkpoint(&json!({"data":{key("MEASUREMENT_CHECKPOINT_KEY"):work.checkpoint.to_string()}}), &work.checkpoint["identity"]).is_ok());
        }
        let report = observed(&work, 160000, 10);
        advance(
            &mut work,
            std::slice::from_ref(&report),
            &snapshot,
            None,
            "agent_test",
            160000,
        )
        .unwrap();
        let samples = gateway_samples(&work);
        assert_eq!(samples.len(), 1);
        assert_eq!(samples[0]["interval_start"], iso(115000).unwrap());
        assert_eq!(samples[0]["interval_end"], iso(160000).unwrap());
        assert_eq!(samples[0]["sequence"], 160000);
        assert_eq!(samples[0]["ingress_bytes"], 10);
        assert_eq!(work.checkpoint["baseline"]["reports"], json!([report]));
    }
    #[test]
    fn a_quiet_interval_across_the_hour_closes_as_two_known_zero_fragments() {
        let (mut work, snapshot) = quiet_work();
        let report = observed(&work, 3_605_000, 0);
        advance(
            &mut work,
            std::slice::from_ref(&report),
            &snapshot,
            None,
            "agent_test",
            3_605_000,
        )
        .unwrap();
        let samples = gateway_samples(&work);
        assert_eq!(samples.len(), 2);
        assert_eq!(samples[0]["interval_start"], iso(115000).unwrap());
        assert_eq!(samples[0]["interval_end"], iso(3_600_000).unwrap());
        assert_eq!(samples[1]["interval_start"], iso(3_600_000).unwrap());
        assert_eq!(samples[1]["interval_end"], iso(3_605_000).unwrap());
        for sample in &samples {
            for field in [
                "ingress_bytes",
                "egress_bytes",
                "connections",
                "connection_seconds",
            ] {
                assert_eq!(sample[field], 0, "{field}");
            }
        }
        // Closing the span moves the baseline, so the hour that ended is complete.
        assert_eq!(work.checkpoint["baseline"]["reports"], json!([report]));
    }
    #[test]
    fn traffic_over_the_hour_is_split_pro_rata_and_moves_the_baseline() {
        let (mut work, snapshot) = quiet_work();
        let first = observed(&work, 3_590_000, 10);
        advance(
            &mut work,
            &[first],
            &snapshot,
            None,
            "agent_test",
            3_590_000,
        )
        .unwrap();
        // Ten of the fifteen seconds since the last observation lie before the boundary.
        let report = observed(&work, 3_605_000, 30);
        advance(
            &mut work,
            std::slice::from_ref(&report),
            &snapshot,
            None,
            "agent_test",
            3_605_000,
        )
        .unwrap();
        let samples = gateway_samples(&work);
        assert_eq!(samples.len(), 3);
        assert_eq!(samples[0]["ingress_bytes"], 10);
        assert_eq!(samples[1]["interval_start"], iso(3_590_000).unwrap());
        assert_eq!(samples[1]["interval_end"], iso(3_600_000).unwrap());
        assert_eq!(samples[1]["ingress_bytes"], 20);
        assert_eq!(samples[2]["interval_start"], iso(3_600_000).unwrap());
        assert_eq!(samples[2]["interval_end"], iso(3_605_000).unwrap());
        assert_eq!(samples[2]["ingress_bytes"], 10);
        assert_eq!(work.checkpoint["baseline"]["reports"], json!([report]));
    }
    #[test]
    fn traffic_after_a_held_interval_is_split_over_the_cycle_that_counted_it() {
        let (mut work, snapshot) = quiet_work();
        let held = work.checkpoint["baseline"]["reports"].clone();
        for at in [3_560_000, 3_585_000] {
            let report = observed(&work, at, 0);
            advance(&mut work, &[report], &snapshot, None, "agent_test", at).unwrap();
        }
        assert!(gateway_samples(&work).is_empty());
        assert_eq!(work.checkpoint["baseline"]["reports"], held);
        // The counters were last seen unchanged at 3_585_000: the 30 bytes were counted in the 20 s
        // after it, fifteen of them before the boundary, not spread over the whole held hour.
        let report = observed(&work, 3_605_000, 30);
        advance(
            &mut work,
            std::slice::from_ref(&report),
            &snapshot,
            None,
            "agent_test",
            3_605_000,
        )
        .unwrap();
        let samples = gateway_samples(&work);
        assert_eq!(samples.len(), 2);
        assert_eq!(samples[0]["interval_start"], iso(115000).unwrap());
        assert_eq!(samples[0]["interval_end"], iso(3_600_000).unwrap());
        assert_eq!(samples[0]["ingress_bytes"], 22);
        assert_eq!(samples[1]["interval_start"], iso(3_600_000).unwrap());
        assert_eq!(samples[1]["interval_end"], iso(3_605_000).unwrap());
        assert_eq!(samples[1]["ingress_bytes"], 8);
        assert_eq!(work.checkpoint["baseline"]["reports"], json!([report]));
    }
    #[test]
    fn a_restart_during_a_held_interval_is_unknown_not_zero() {
        let (mut work, snapshot) = quiet_work();
        let held = observed(&work, 130000, 0);
        advance(&mut work, &[held], &snapshot, None, "agent_test", 130000).unwrap();
        let mut restarted = observed(&work, 145000, 0);
        restarted["processEpoch"] = "01234567-89ab-4def-8123-000000000004".into();
        restarted["epoch"] = "01234567-89ab-4def-8123-000000000005".into();
        restarted["startedAt"] = iso(140000).unwrap().into();
        restarted["counterStartedAt"] = iso(140000).unwrap().into();
        restarted["countersSince"] = iso(140000).unwrap().into();
        restarted["lastActivityAt"] = Value::Null;
        restarted["history"] = "current_process_absence".into();
        for field in [
            "ingressBytes",
            "egressBytes",
            "totalConnections",
            "connectionMilliseconds",
        ] {
            restarted[field] = 0.into();
        }
        advance(
            &mut work,
            &[restarted.clone()],
            &snapshot,
            None,
            "agent_test",
            145000,
        )
        .unwrap();
        let samples = gateway_samples(&work);
        assert_eq!(samples.len(), 1);
        assert_eq!(samples[0]["interval_start"], iso(115000).unwrap());
        assert!(samples[0]["ingress_bytes"].is_null());
        assert!(samples[0]["connection_seconds"].is_null());
        assert_eq!(work.checkpoint["gapSince"], iso(145000).unwrap());
        assert_eq!(work.checkpoint["baseline"]["reports"], json!([restarted]));
    }
    #[test]
    fn an_unmeasurable_storage_gauge_is_repeated_once_per_hour_while_a_measured_one_stays_fresh() {
        let (mut work, snapshot) = quiet_work();
        let mut emitted = Vec::new();
        for (at, used) in [
            (130000, None),
            (145000, None),
            (160000, Some(5)),
            (175000, Some(5)),
            (190000, None),
            (205000, None),
            (3_700_000, None),
        ] {
            work.checkpoint["outbox"] = json!([]);
            let report = observed(&work, at, 0);
            advance(&mut work, &[report], &snapshot, used, "agent_test", at).unwrap();
            emitted.push(
                work.checkpoint["outbox"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter(|sample| sample["source"] == "agent")
                    .count(),
            );
        }
        assert_eq!(emitted, [1, 0, 1, 1, 1, 0, 1]);
    }
    #[test]
    fn unknown_counters_or_impossible_counts_never_authorize_idle() {
        let mut report = vectors()["differences"][0]["current"].clone();
        report["connections"] = Value::Null;
        assert!(!report_valid(&report));
        report["connections"] = 0.into();
        report["busyConnections"] = 1.into();
        assert!(!report_valid(&report));
    }
}
