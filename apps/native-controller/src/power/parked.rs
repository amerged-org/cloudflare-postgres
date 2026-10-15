// SPDX-License-Identifier: Apache-2.0
//! The parked sleep tier. An idle sleep keeps the database's own instance Pod and stops only
//! PostgreSQL, through CNPG's instance fence; the next wake lifts the fence on the same Pod.
//!
//! Everything the other sleeps guarantee holds here. Intent (`Parking`, `Wake`, `Hibernating`) is
//! persisted before the Cluster is written, every Cluster write is a CAS merge-patch whose
//! outcome is read back, the gateway fence stays closed until the wake is verified, and a
//! predicate that cannot be established ends in a real hibernation, never in a guess.
//!
//! The predicates of the fast wake are judged while the database sleeps as well as when it wakes:
//! a Pod whose desired manifests, image, runtime, node boot or fleet release changed since it was
//! parked is demoted before any wake can meet it, and the parked observation claims the fast wake
//! only while every one of them holds.
use super::*;
use crate::{
    reconcile::{cluster_owned, contains, quantity},
    timing,
};
use futures_util::future::try_join_all;
use std::time::Instant;

const FENCE_ALL: &str = "[\"*\"]";
const POSTGRES: &str = "postgres";
const SIDECAR: &str = "plugin-barman-cloud";
const SELECTOR: &str = "cnpg.io/cluster=database";
/// The Cluster phase CNPG registers while nothing is pending; hibernation proceeds only then.
const HEALTHY: &str = "Cluster in healthy state";
/// How long a resize is awaited before the Pod is parked at the requests it still has.
const RESIZE_BUDGET: Duration = Duration::from_secs(2);

/// What the region's `parking` policy asks of a parked sleep.
pub(super) struct Policy {
    ttl_ms: u64,
    max_per_node: u64,
    postgres: (u64, u64),
    sidecar: (u64, u64),
}
/// `None` unless the tier is enabled; a malformed policy is no policy.
pub(super) fn policy(value: &Value) -> Option<Policy> {
    if value["enabled"] != true {
        return None;
    }
    let n = |key: &str| crate::contracts::integer(value, key).ok();
    Some(Policy {
        ttl_ms: n("ttl_seconds")?.checked_mul(1000)?,
        max_per_node: n("max_per_node")?,
        postgres: (n("postgres_cpu_millicores")?, n("postgres_memory_mib")?),
        sidecar: (n("sidecar_cpu_millicores")?, n("sidecar_memory_mib")?),
    })
}
fn ceil_units(value: f64) -> u64 {
    let nearest = value.round();
    if (value - nearest).abs() < 1e-6 {
        nearest as u64
    } else {
        value.ceil() as u64
    }
}
/// (cores, bytes) of a requests/limits object; a missing resource requests nothing.
fn amounts(resources: &Value) -> (f64, f64) {
    (
        quantity(&resources["cpu"]).unwrap_or(0.0),
        quantity(&resources["memory"]).unwrap_or(0.0),
    )
}
fn pair_max(a: (f64, f64), b: (f64, f64)) -> (f64, f64) {
    (a.0.max(b.0), a.1.max(b.1))
}
fn pair_sum(a: (f64, f64), b: (f64, f64)) -> (f64, f64) {
    (a.0 + b.0, a.1 + b.1)
}
fn status_of<'a>(statuses: &'a Value, name: &str) -> Option<&'a Value> {
    statuses
        .as_array()?
        .iter()
        .find(|status| status["name"] == name)
}
/// The Pod's effective scheduling request after Kubernetes' own rule, as (millicores, MiB): the
/// sum of its containers and restartable init containers against the largest regular init
/// container (plus the sidecars started before it), plus the RuntimeClass overhead. An in-place
/// resize counts at the larger of what is specified, actuated and allocated until it completes.
pub(super) fn effective_requests(pod: &Value) -> Option<(u64, u64)> {
    let spec = &pod["spec"];
    let status = &pod["status"];
    spec["containers"].as_array()?;
    let infeasible = status["conditions"].as_array().is_some_and(|all| {
        all.iter()
            .any(|c| c["type"] == "PodResizePending" && c["reason"] == "Infeasible")
    });
    let resized = |container: &Value, statuses: &Value| -> (f64, f64) {
        let wanted = amounts(&container["resources"]["requests"]);
        let Some(seen) = status_of(statuses, text(container, "name")) else {
            return wanted;
        };
        let held = pair_max(
            amounts(&seen["resources"]["requests"]),
            amounts(&seen["allocatedResources"]),
        );
        if infeasible {
            held
        } else {
            pair_max(wanted, held)
        }
    };
    let mut total = (0.0, 0.0);
    for container in spec["containers"].as_array()? {
        total = pair_sum(total, resized(container, &status["containerStatuses"]));
    }
    let mut sidecars = (0.0, 0.0);
    let mut floor = (0.0, 0.0);
    for init in spec["initContainers"].as_array().into_iter().flatten() {
        if init["restartPolicy"] == "Always" {
            let request = resized(init, &status["initContainerStatuses"]);
            total = pair_sum(total, request);
            sidecars = pair_sum(sidecars, request);
            floor = pair_max(floor, sidecars);
        } else {
            let request = amounts(&init["resources"]["requests"]);
            floor = pair_max(floor, pair_sum(request, sidecars));
        }
    }
    total = pair_max(total, floor);
    total = pair_sum(total, amounts(&spec["overhead"]));
    Some((
        ceil_units(total.0 * 1000.0),
        ceil_units(total.1 / 1_048_576.0),
    ))
}

fn requests_of(container: &Value) -> Option<ContainerRequests> {
    let requests = &container["resources"]["requests"];
    Some(ContainerRequests {
        cpu: requests["cpu"].as_str()?.into(),
        memory: requests["memory"].as_str()?.into(),
    })
}
fn named<'a>(list: &'a Value, name: &str) -> Option<&'a Value> {
    list.as_array()?.iter().find(|c| c["name"] == name)
}
/// The smaller of what a container requests and what the policy allows; a policy never raises.
fn lowered(current: &ContainerRequests, cpu_m: u64, memory_mib: u64) -> ContainerRequests {
    let below = |now: &str, wanted: f64| {
        quantity(&Value::String(now.into())).is_some_and(|n| wanted + 1e-9 < n)
    };
    ContainerRequests {
        cpu: if below(&current.cpu, cpu_m as f64 / 1000.0) {
            format!("{cpu_m}m")
        } else {
            current.cpu.clone()
        },
        memory: if below(&current.memory, memory_mib as f64 * 1_048_576.0) {
            format!("{memory_mib}Mi")
        } else {
            current.memory.clone()
        },
    }
}
pub(crate) fn fenced(cluster: &Value) -> bool {
    cluster["metadata"]["annotations"][FENCE]
        .as_str()
        .is_some_and(|v| !v.is_empty() && v != "[]")
}
fn hibernation_on(cluster: &Value) -> bool {
    cluster["metadata"]["annotations"][HIBERNATION] == "on"
}
fn healthy(cluster: &Value) -> bool {
    cluster["status"]["phase"] == HEALTHY
}
fn container_ids(pod: &Value) -> Option<(String, String)> {
    let postgres = named(&pod["status"]["containerStatuses"], POSTGRES)?;
    let sidecar = named(&pod["status"]["initContainerStatuses"], SIDECAR)?;
    let (a, b) = (text(postgres, "containerID"), text(sidecar, "containerID"));
    (!a.is_empty() && !b.is_empty()).then(|| (a.into(), b.into()))
}
/// A Running, undeleted instance Pod of this Cluster on the database's node.
fn instance_live(pod: &Value, cluster: &Value, db: &Value) -> bool {
    cluster_owned(pod, cluster)
        && pod["metadata"]["deletionTimestamp"].is_null()
        && text(&pod["status"], "phase") == "Running"
        && pod["spec"]["nodeName"] == db["node"]
}
fn assignment(release: &Value, node: &str) -> Option<u64> {
    release["nodes"]
        .as_array()?
        .iter()
        .find(|n| text(n, "k8s_node_name") == node)
        .and_then(|n| n["revision"].as_u64())
}
fn boot_id(node: &Value) -> &str {
    text(&node["status"]["nodeInfo"], "bootID")
}
/// Whether the Pod is still the one the record bound, by identity alone.
fn bound(pod: &Value, park: &Park) -> bool {
    pod["metadata"]["uid"] == park.pod_uid.as_str()
        && container_ids(pod).is_some_and(|(postgres, sidecar)| {
            postgres == park.postgres_container_id && sidecar == park.sidecar_container_id
        })
}
/// `cnpg_collector_fencing_on 1`: the instance manager reports itself fenced.
fn fencing_on(metrics: &str) -> bool {
    metrics.lines().any(|line| {
        let mut parts = line.split_whitespace();
        parts.next() == Some("cnpg_collector_fencing_on")
            && parts.next().and_then(|v| v.parse::<f64>().ok()) == Some(1.0)
    })
}

/// How a sleep pass that met a retained Pod ended.
pub(super) enum Retained {
    /// The pass is over: the observation to post, if any.
    Observed(Option<Value>),
    /// The record is stale (the wake already lifted the fence): the ordinary sleep applies.
    Ordinary,
}
enum Demotion {
    Pending,
    Done,
}
/// What a sleeping pass knows of the fast wake of the Pod it retains.
enum Standing {
    /// Every predicate holds right now.
    Holds,
    /// A predicate no longer holds: this Pod will not be resumed.
    Lost(&'static str),
    /// A predicate could not be read or built this pass: neither claimed nor given up.
    Unknown,
}
/// How a wake met a retained Pod.
pub(super) enum Resumed {
    Fast(ParkedWake),
    /// The retained Pod is being hibernated; the wake waits for it.
    Waiting,
    /// No retained Pod stands in the way: the ordinary CNPG wake applies.
    Ordinary,
}

impl PowerCoordinator {
    /// The socket PostgreSQL clients dial for the Pod at `pod_ip`.
    pub(crate) fn pod_socket(
        &self,
        pod_ip: &str,
    ) -> std::result::Result<std::net::SocketAddr, Error> {
        if let Some(socket) = self.postgres {
            return Ok(socket);
        }
        let ip: IpAddr = private_ip(pod_ip)
            .map_err(|_| "pod address is not private")?
            .parse()?;
        Ok(std::net::SocketAddr::new(ip, postgres::PORT))
    }
    /// The single non-terminal instance Pod of the Cluster, if there is exactly one.
    async fn instance_pod(&self, db: &Value) -> Result<Option<Value>> {
        let mut live: Vec<_> = self
            .k8s
            .list("Pod", Some(&namespace(db)), Some(SELECTOR))
            .await?
            .into_iter()
            .filter(|pod| !terminal_pod(pod))
            .collect();
        Ok(if live.len() == 1 { live.pop() } else { None })
    }
    /// The databases of `node` whose Pod is parked or being parked, as (id, parked_at). Read
    /// loosely: one unreadable record must never block another database's decision.
    async fn parked_on_node(&self, node: &str) -> Result<Vec<(String, u64)>> {
        let selector = format!("{}=true", wire("fenceLabel"));
        let maps = self
            .k8s
            .list("ConfigMap", Some(SYSTEM), Some(&selector))
            .await?;
        Ok(maps
            .iter()
            .filter_map(|map| {
                let id = map["metadata"]["labels"][DATABASE_LABEL].as_str()?;
                let record: Value =
                    serde_json::from_str(map["data"]["power.json"].as_str()?).ok()?;
                (matches!(record["phase"].as_str(), Some("parking" | "parked"))
                    && record["anchor"]["node"] == node)
                    .then(|| {
                        (
                            id.to_string(),
                            record["park"]["parkedAt"].as_u64().unwrap_or(0),
                        )
                    })
            })
            .collect())
    }
    /// Step S5: whether this proved idle sleep parks, and the Pod it retains. Any precondition
    /// that cannot be established answers no, which is the ordinary hibernation.
    pub(super) async fn park_plan(
        &self,
        db: &Value,
        intent: &PowerIntent,
        cluster: &Value,
        sleep: &Sleep<'_>,
    ) -> Result<Option<Park>> {
        let Some(policy) = policy(sleep.parking) else {
            return Ok(None);
        };
        if policy.max_per_node == 0
            || text(&db["power"], "reason") != "idle"
            || intent.mode != "quiesce"
            || db.get("pool_binding").is_some()
            || cluster["spec"]["instances"] != 1
            || hibernation_on(cluster)
            || fenced(cluster)
            || boot_id(sleep.basis.node).is_empty()
        {
            return Ok(None);
        }
        let release = &sleep.basis.release["release"];
        let (Some(release_id), Some(spec_sha256), Some(assignment_revision)) = (
            release["id"].as_str(),
            release["spec_sha256"].as_str(),
            assignment(sleep.basis.release, text(db, "node")),
        ) else {
            return Ok(None);
        };
        let Some(pod) = self.instance_pod(db).await? else {
            return Ok(None);
        };
        let running = |statuses: &Value, name: &str| {
            named(statuses, name).is_some_and(|c| c["state"]["running"].is_object())
        };
        let (Some((postgres_container_id, sidecar_container_id)), Some(postgres), Some(sidecar)) = (
            container_ids(&pod),
            named(&pod["spec"]["containers"], POSTGRES).and_then(requests_of),
            named(&pod["spec"]["initContainers"], SIDECAR).and_then(requests_of),
        ) else {
            return Ok(None);
        };
        if !instance_live(&pod, cluster, db)
            || !running(&pod["status"]["containerStatuses"], POSTGRES)
            || !running(&pod["status"]["initContainerStatuses"], SIDECAR)
            || cluster["status"]["currentPrimary"] != pod["metadata"]["name"]
        {
            return Ok(None);
        }
        let peers = self.parked_on_node(text(db, "node")).await?;
        if peers.iter().filter(|(id, _)| id != text(db, "id")).count() as u64 >= policy.max_per_node
        {
            return Ok(None);
        }
        let parked = Requests {
            postgres: lowered(&postgres, policy.postgres.0, policy.postgres.1),
            sidecar: lowered(&sidecar, policy.sidecar.0, policy.sidecar.1),
        };
        let park = Park {
            pod_name: text(&pod["metadata"], "name").into(),
            pod_uid: uid(&pod)?.into(),
            postgres_container_id,
            sidecar_container_id,
            node_boot_id: boot_id(sleep.basis.node).into(),
            release_id: release_id.into(),
            spec_sha256: spec_sha256.into(),
            assignment_revision,
            requests_before: Requests { postgres, sidecar },
            requests_parked: parked,
            parked_at: self.now(),
            stopped: false,
        };
        // A Pod the desired state would change on its next wake is not worth retaining.
        if self
            .intact(db, &park, cluster, &sleep.basis)
            .await?
            .is_some()
        {
            return Ok(None);
        }
        Ok(Some(park))
    }
    /// Step S7: the instance fence and the power annotations in one CAS patch, read back. The
    /// hibernation annotation is never touched; a hibernating Cluster is never fenced.
    pub(super) async fn cluster_fence(&self, intent: &PowerIntent, cluster: &Value) -> Result<()> {
        let annotations = &cluster["metadata"]["annotations"];
        let revision = annotation_number(cluster, POWER_REVISION)?.unwrap_or(0);
        if revision > intent.revision
            || (revision == intent.revision
                && annotations[POWER_OPERATION]
                    .as_str()
                    .is_some_and(|v| v != intent.operation))
        {
            return Err(Fault::Stale);
        }
        let revision_text = intent.revision.to_string();
        let current = |a: &Value| {
            a[FENCE] == FENCE_ALL
                && a[POWER_REVISION].as_str() == Some(revision_text.as_str())
                && a[POWER_OPERATION] == intent.operation
        };
        if current(annotations) {
            return Ok(());
        }
        if hibernation_on(cluster) {
            return Err(Fault::Recovery("park_hibernation_annotation_present"));
        }
        let actual = self
            .k8s
            .patch(
                cluster,
                &json!({"metadata":{"annotations":{FENCE:FENCE_ALL,POWER_REVISION:intent.revision.to_string(),POWER_OPERATION:intent.operation}}}),
            )
            .await?;
        if !current(&actual["metadata"]["annotations"]) {
            return Err(Fault::Unavailable("cluster_fence_write_unknown"));
        }
        Ok(())
    }
    /// Lifts the instance fence alone, as algorithm B of a demotion does.
    async fn lift_fence(&self, cluster: &Value) -> Result<Value> {
        if !fenced(cluster) {
            return Ok(cluster.clone());
        }
        let actual = self
            .k8s
            .patch(
                cluster,
                &json!({"metadata":{"annotations":{FENCE:Value::Null}}}),
            )
            .await?;
        if actual["metadata"]["annotations"].get(FENCE).is_some() {
            return Err(Fault::Unavailable("cluster_unfence_write_unknown"));
        }
        Ok(actual)
    }
    /// Whether the exporter of the instance at `ip` reports itself fenced.
    async fn exporter_fenced(&self, ip: &str) -> bool {
        let Ok(address) = private_ip(ip).map(|ip| ip.parse::<IpAddr>()) else {
            return false;
        };
        let Ok(address) = address else {
            return false;
        };
        let host = match address {
            IpAddr::V4(v) => v.to_string(),
            IpAddr::V6(v) => format!("[{v}]"),
        };
        let Ok(response) = self
            .http
            .get(format!("http://{host}:9187/metrics"))
            .send()
            .await
        else {
            return false;
        };
        if !response.status().is_success() {
            return false;
        }
        let Ok(bytes) = crate::kubernetes::bounded(response, 1024 * 1024).await else {
            return false;
        };
        fencing_on(&String::from_utf8_lossy(&bytes))
    }
    /// Whether nothing listens on PostgreSQL's port of the Pod: only a refused connection proves
    /// the listener gone; an answer or silence proves nothing.
    async fn listener_refused(&self, ip: &str) -> bool {
        let Ok(socket) = self.pod_socket(ip) else {
            return false;
        };
        match tokio::time::timeout(
            Duration::from_millis(500),
            tokio::net::TcpStream::connect(socket),
        )
        .await
        {
            Ok(Err(error)) => error.kind() == std::io::ErrorKind::ConnectionRefused,
            _ => false,
        }
    }
    /// Steps S9 and S10 from the other side: the Pod's requests, restored from the record.
    async fn resize(&self, pod: &Value, requests: &Requests) -> Result<Value> {
        let value = |r: &ContainerRequests| json!({"cpu":r.cpu,"memory":r.memory});
        Ok(self
            .k8s
            .resize_pod(
                pod,
                &[(POSTGRES, value(&requests.postgres))],
                &[(SIDECAR, value(&requests.sidecar))],
            )
            .await?)
    }
    /// Whether the two containers' requests, as specified, are `requests`: what a resize asked.
    fn requested(pod: &Value, requests: &Requests) -> bool {
        let same = |actual: &Value, wanted: &ContainerRequests| {
            [("cpu", &wanted.cpu), ("memory", &wanted.memory)]
                .iter()
                .all(|(key, want)| {
                    quantity(&actual[*key])
                        .zip(quantity(&Value::String((*want).clone())))
                        .is_some_and(|(a, b)| (a - b).abs() <= b.abs().max(1.0) * 1e-12)
                })
        };
        named(&pod["spec"]["containers"], POSTGRES)
            .is_some_and(|c| same(&c["resources"]["requests"], &requests.postgres))
            && named(&pod["spec"]["initContainers"], SIDECAR)
                .is_some_and(|c| same(&c["resources"]["requests"], &requests.sidecar))
    }
    /// Whether the kubelet has actuated `requests` for both containers and nothing is pending.
    fn actuated(pod: &Value, requests: &Requests) -> bool {
        let pending = pod["status"]["conditions"].as_array().is_some_and(|all| {
            all.iter()
                .any(|c| matches!(text(c, "type"), "PodResizePending" | "PodResizeInProgress"))
        });
        let mut seen = pod.clone();
        for (spec, status, name) in [
            ("containers", "containerStatuses", POSTGRES),
            ("initContainers", "initContainerStatuses", SIDECAR),
        ] {
            // The statuses report what is actuated; compare them as if they were the spec.
            let actual = named(&pod["status"][status], name)
                .map(|s| s["resources"].clone())
                .unwrap_or(Value::Null);
            if let Some(container) = seen["spec"][spec]
                .as_array_mut()
                .and_then(|all| all.iter_mut().find(|c| c["name"] == name))
            {
                container["resources"] = actual;
            }
        }
        !pending && Self::requested(&seen, requests)
    }
    /// Steps S8 to S10: PostgreSQL stopped and the instance fenced, then the Pod shrunk and
    /// recorded as parked. Polls inside the pass; `Ok(None)` means not confirmed yet.
    async fn confirm_stop(
        &self,
        db: &Value,
        intent: &PowerIntent,
        sleep: &Sleep<'_>,
        map: Value,
        mut p: Progress,
        mut cluster: Value,
    ) -> Result<Retained> {
        let park = p
            .park
            .clone()
            .ok_or(Fault::Recovery("power_park_missing"))?;
        let deadline = Instant::now() + self.stop_budget;
        let mut pause = Duration::from_millis(100);
        let pod = loop {
            let pod = self
                .k8s
                .read("Pod", Some(&namespace(db)), &park.pod_name)
                .await?;
            // The retained Pod is gone or replaced: it can no longer be confirmed, so the sleep
            // completes as the hibernation it would have been.
            let Some(pod) = pod.filter(|pod| {
                bound(pod, &park) && instance_live(pod, &cluster, db) && !hibernation_on(&cluster)
            }) else {
                return Ok(Retained::Observed(
                    self.demote_pass(db, intent, map, p, cluster).await?,
                ));
            };
            self.cluster_fence(intent, &cluster).await?;
            let ip = text(&pod["status"], "podIP");
            if self.exporter_fenced(ip).await && self.listener_refused(ip).await {
                break pod;
            }
            if Instant::now() >= deadline {
                return Ok(Retained::Observed(None));
            }
            tokio::time::sleep(pause).await;
            pause = (pause * 2).min(Duration::from_millis(250));
            cluster = self
                .k8s
                .read("Cluster", Some(&namespace(db)), "database")
                .await?
                .ok_or(Fault::Recovery(
                    "established_database_resource_missing_or_replaced",
                ))?;
        };
        // The gateway is still closed over exactly the replicas and keys of the proof, and the
        // storage anchor is unchanged: the same continuity the hibernation completion checks.
        let snapshot = self.snapshot().await?;
        if p.gateways.as_ref() != Some(&snapshot.pods)
            || p.key_uid.as_deref() != Some(&snapshot.key_uid)
            || p.key_version.as_deref() != Some(&snapshot.key_version)
        {
            return Ok(Retained::Observed(None));
        }
        self.controls(intent, &snapshot, "status").await?;
        let (confirmed, _) = self.anchor(db).await?;
        if !confirmed.matches(&p.anchor) {
            return Err(Fault::Recovery("power_storage_identity_changed"));
        }
        if self.gateways().await? != snapshot.pods {
            return Ok(Retained::Observed(None));
        }
        // Step S9: shrink the two containers' requests. A rejected resize parks the Pod at the
        // requests it keeps, and the observation reports those; a slow kubelet only delays the
        // smaller figure, which the next pass reports.
        let mut shrunk = pod.clone();
        let mut recorded = park.requests_before.clone();
        if park.requests_parked != park.requests_before
            && let Ok(actual) = self.resize(&pod, &park.requests_parked).await
        {
            recorded = park.requests_parked.clone();
            shrunk = actual;
            let until = Instant::now() + RESIZE_BUDGET;
            while !Self::actuated(&shrunk, &recorded) && Instant::now() < until {
                tokio::time::sleep(Duration::from_millis(100)).await;
                match self
                    .k8s
                    .read("Pod", Some(&namespace(db)), &park.pod_name)
                    .await?
                {
                    Some(next) if next["metadata"]["uid"] == pod["metadata"]["uid"] => {
                        shrunk = next;
                    }
                    _ => break,
                }
            }
        }
        let (cpu, memory) =
            effective_requests(&shrunk).ok_or(Fault::Unavailable("pod_requests_unknown"))?;
        // Step S10. The record says PostgreSQL was seen stopped; the observation claims the fast
        // wake only if every predicate of it holds with the fence in place.
        let record = {
            let record = p
                .park
                .as_mut()
                .ok_or(Fault::Recovery("power_park_missing"))?;
            record.requests_parked = recorded;
            record.stopped = true;
            record.clone()
        };
        let current = self
            .k8s
            .read("Cluster", Some(&namespace(db)), "database")
            .await?
            .ok_or(Fault::Recovery(
                "established_database_resource_missing_or_replaced",
            ))?;
        let standing = self.standing(db, &record, &current, sleep).await?;
        if let Standing::Lost(detail) = standing {
            // Parking a Pod that could not be resumed would only hold its memory.
            self.demotion_event(db, intent, "drift", Some(detail));
            return Ok(Retained::Observed(
                self.demote_pass(db, intent, map, p, current).await?,
            ));
        }
        p.phase = Phase::Parked;
        self.write(db, Some(&map), None, &p).await?;
        Ok(Retained::Observed(Some(parked_observation(
            db,
            intent,
            &park.pod_uid,
            cpu,
            memory,
            matches!(standing, Standing::Holds),
        ))))
    }
    fn demotion_event(&self, db: &Value, intent: &PowerIntent, reason: &str, detail: Option<&str>) {
        let mut event = json!({"event":"park_demotion","database_id":db["id"],"operation":intent.operation,"reason":reason});
        if let Some(detail) = detail {
            event["detail"] = detail.into();
        }
        eprintln!("{event}");
    }
    /// A periodic pass over a Parked database: the demotion triggers, in order, then a fresh
    /// observation of the Pod it still holds.
    async fn parked_pass(
        &self,
        db: &Value,
        intent: &PowerIntent,
        sleep: &Sleep<'_>,
        map: Value,
        p: Progress,
        cluster: Value,
    ) -> Result<Retained> {
        let park = p
            .park
            .clone()
            .ok_or(Fault::Recovery("power_park_missing"))?;
        let policy = policy(sleep.parking);
        let pod = self
            .k8s
            .read("Pod", Some(&namespace(db)), &park.pod_name)
            .await?;
        let identity = pod.as_ref().is_some_and(|pod| {
            bound(pod, &park)
                && instance_live(pod, &cluster, db)
                && boot_id(sleep.basis.node) == park.node_boot_id
                && sleep.basis.release["release"]["id"] == park.release_id.as_str()
                && sleep.basis.release["release"]["spec_sha256"] == park.spec_sha256.as_str()
                && assignment(sleep.basis.release, text(db, "node"))
                    == Some(park.assignment_revision)
        }) && fenced(&cluster)
            && !hibernation_on(&cluster);
        let reason = if policy.is_none() {
            Some("policy_off")
        } else if self.now().saturating_sub(park.parked_at)
            >= policy.as_ref().map_or(0, |p| p.ttl_ms)
        {
            Some("ttl")
        } else if self.over_cap(db, &park, policy.as_ref()).await? {
            Some("cap")
        } else if !identity {
            Some("identity")
        } else {
            None
        };
        if let Some(reason) = reason {
            self.demotion_event(db, intent, reason, None);
            return Ok(Retained::Observed(
                self.demote_pass(db, intent, map, p, cluster).await?,
            ));
        }
        // The Pod is the one that was parked; whether its wake is still the fast one depends on
        // what the desired state asks of it now, and a Pod that drifted is demoted before any
        // wake can meet it.
        let standing = self.standing(db, &park, &cluster, sleep).await?;
        if let Standing::Lost(detail) = standing {
            self.demotion_event(db, intent, "drift", Some(detail));
            return Ok(Retained::Observed(
                self.demote_pass(db, intent, map, p, cluster).await?,
            ));
        }
        let pod = pod.ok_or(Fault::Unavailable("parked_pod_unavailable"))?;
        let snapshot = self.snapshot().await?;
        self.controls(intent, &snapshot, "status").await?;
        if self.gateways().await? != snapshot.pods {
            return Ok(Retained::Observed(None));
        }
        let (cpu, memory) =
            effective_requests(&pod).ok_or(Fault::Unavailable("pod_requests_unknown"))?;
        Ok(Retained::Observed(Some(parked_observation(
            db,
            intent,
            &park.pod_uid,
            cpu,
            memory,
            matches!(standing, Standing::Holds),
        ))))
    }
    /// Whether this database is among the oldest ones above the node's cap, which demote
    /// themselves: ordered by (parked_at, id), the first `count - max` leave.
    async fn over_cap(&self, db: &Value, park: &Park, policy: Option<&Policy>) -> Result<bool> {
        let Some(policy) = policy else {
            return Ok(false);
        };
        let mut peers = self.parked_on_node(text(db, "node")).await?;
        if !peers.iter().any(|(id, _)| id == text(db, "id")) {
            peers.push((text(db, "id").into(), park.parked_at));
        }
        peers.sort_by(|a, b| (a.1, &a.0).cmp(&(b.1, &b.0)));
        let excess = (peers.len() as u64).saturating_sub(policy.max_per_node) as usize;
        Ok(peers
            .iter()
            .take(excess)
            .any(|(id, _)| id == text(db, "id")))
    }
    /// A sleep pass over a database that holds a retained instance Pod.
    #[allow(clippy::too_many_arguments)]
    pub(super) async fn retained_sleep(
        &self,
        db: &Value,
        intent: &PowerIntent,
        sleep: &Sleep<'_>,
        map: Value,
        mut p: Progress,
        cluster: Value,
    ) -> Result<Retained> {
        if p.phase == Phase::Wake {
            // A wake that never lifted the fence leaves the Pod parked; one that did leaves the
            // ordinary hibernation to prove PostgreSQL again.
            if fenced(&cluster) && !hibernation_on(&cluster) {
                p.phase = Phase::Parked;
            } else {
                return Ok(Retained::Ordinary);
            }
        }
        let newer = p.target != *intent;
        match p.phase {
            Phase::Hibernating => Ok(Retained::Observed(
                self.demote_pass(db, intent, map, p, cluster).await?,
            )),
            _ if newer => {
                let reason = if text(&db["power"], "reason") == "manual" {
                    "explicit_suspend"
                } else {
                    "newer_intent"
                };
                self.demotion_event(db, intent, reason, None);
                Ok(Retained::Observed(
                    self.demote_pass(db, intent, map, p, cluster).await?,
                ))
            }
            Phase::Parking => self.confirm_stop(db, intent, sleep, map, p, cluster).await,
            Phase::Parked => self.parked_pass(db, intent, sleep, map, p, cluster).await,
            _ => Err(Fault::Recovery("power_park_invalid")),
        }
    }
    /// One pass of a demotion of a sleeping database: parked to hibernated. Idempotent; every
    /// write is persisted intent first and a CAS patch read back. The first pass of a demotion
    /// under the intent the Pod was parked for observes the Pod once more without the fast wake
    /// claim; the end of every demotion is the plain `hibernated` observation. A demotion for a
    /// newer intent says nothing before its end: its operation is not done until then.
    async fn demote_pass(
        &self,
        db: &Value,
        intent: &PowerIntent,
        map: Value,
        p: Progress,
        cluster: Value,
    ) -> Result<Option<Value>> {
        let first = p.phase != Phase::Hibernating && p.target == *intent;
        let park = p.park.clone();
        match self.demote(db, intent, map, p, &cluster, true).await?.0 {
            Demotion::Done => Ok(Some(observation(db, intent, "hibernated", None))),
            Demotion::Pending => match park.filter(|_| first) {
                // A failed read only loses this one report.
                Some(park) => Ok(self.withdrawn(db, intent, &park).await.ok().flatten()),
                None => Ok(None),
            },
        }
    }
    /// The parked observation of a Pod whose demotion has begun: still held, no longer promised.
    async fn withdrawn(
        &self,
        db: &Value,
        intent: &PowerIntent,
        park: &Park,
    ) -> Result<Option<Value>> {
        let Some(pod) = self
            .k8s
            .read("Pod", Some(&namespace(db)), &park.pod_name)
            .await?
            .filter(|pod| bound(pod, park))
        else {
            return Ok(None);
        };
        let (cpu, memory) =
            effective_requests(&pod).ok_or(Fault::Unavailable("pod_requests_unknown"))?;
        Ok(Some(parked_observation(
            db,
            intent,
            &park.pod_uid,
            cpu,
            memory,
            false,
        )))
    }
    /// Algorithm A while the Cluster phase is healthy: hibernation on with the fence left in
    /// place, so PostgreSQL never starts. Algorithm B otherwise: lift the fence and let CNPG
    /// reach a healthy phase first. Lifting the fence starts PostgreSQL, which only a wake
    /// asks for: a sleeping database (`sleep`) never does.
    async fn demote(
        &self,
        db: &Value,
        intent: &PowerIntent,
        mut map: Value,
        mut p: Progress,
        cluster: &Value,
        sleep: bool,
    ) -> Result<(Demotion, Value, Progress, Value)> {
        let phase = timing::Phase::begin(db, "park_demote");
        // Intent first. A sleeping database re-stamps the gateway's fence with its (possibly
        // newer) intent; a waking one must never stamp the running intent before verification.
        if p.phase != Phase::Hibernating
            || (sleep && p.target != *intent)
            || (!sleep && p.target.revision < intent.revision)
        {
            p.phase = Phase::Hibernating;
            p.target = intent.clone();
            map = self
                .write(db, Some(&map), sleep.then_some(intent), &p)
                .await?;
        }
        let mut cluster = cluster.clone();
        if hibernation_on(&cluster) {
            let pods_done = self
                .k8s
                .list("Pod", Some(&namespace(db)), Some(SELECTOR))
                .await?
                .iter()
                .all(terminal_pod);
            if condition(&cluster, HIBERNATION) && pods_done {
                if sleep {
                    let snapshot = self.snapshot().await?;
                    // Once PostgreSQL was seen stopped nothing can have been written, so the
                    // gateways the proof closed need not be the ones that exist now; each of the
                    // current ones must still report the fence closed.
                    let stopped = p.park.as_ref().is_some_and(|park| park.stopped);
                    if !stopped
                        && (p.gateways.as_ref() != Some(&snapshot.pods)
                            || p.key_uid.as_deref() != Some(&snapshot.key_uid)
                            || p.key_version.as_deref() != Some(&snapshot.key_version))
                    {
                        phase.pending();
                        return Ok((Demotion::Pending, map, p, cluster));
                    }
                    self.controls(intent, &snapshot, "status").await?;
                    if self.gateways().await? != snapshot.pods {
                        phase.pending();
                        return Ok((Demotion::Pending, map, p, cluster));
                    }
                }
                // The fence goes before `Hibernated` is written, so a later resume can never
                // start a fenced Pod.
                cluster = self.lift_fence(&cluster).await?;
                p.phase = Phase::Hibernated;
                p.park = None;
                map = self.write(db, Some(&map), None, &p).await?;
                phase.completed();
                return Ok((Demotion::Done, map, p, cluster));
            }
            // CNPG defers hibernation while its phase is not healthy; only an unfenced instance
            // can become healthy again.
            if fenced(&cluster) && !healthy(&cluster) && !sleep {
                cluster = self.lift_fence(&cluster).await?;
            }
            phase.pending();
            return Ok((Demotion::Pending, map, p, cluster));
        }
        if healthy(&cluster) {
            self.cluster_intent(intent, &cluster, "on").await?;
        } else if fenced(&cluster) && !sleep {
            cluster = self.lift_fence(&cluster).await?;
        }
        phase.pending();
        Ok((Demotion::Pending, map, p, cluster))
    }
    /// Resumes or demotes a retained Pod for a wake, before CNPG's hibernation is released.
    pub(super) async fn resume_retained(
        &self,
        db: &Value,
        intent: &PowerIntent,
        map: Value,
        prior: Progress,
        cluster: Value,
        basis: &Basis<'_>,
    ) -> Result<(Resumed, Value, Progress, Value)> {
        let park = prior
            .park
            .clone()
            .ok_or(Fault::Recovery("power_park_missing"))?;
        let lifted = !fenced(&cluster);
        if lifted && matches!(prior.phase, Phase::Parking | Phase::Parked | Phase::Wake) {
            // The fence is already gone: PostgreSQL starts on the retained Pod without a demotion.
            // Its requests return to what they were, then the ordinary chain verifies the
            // running instance with the same predicates as any other wake.
            if let Some(pod) = self
                .k8s
                .read("Pod", Some(&namespace(db)), &park.pod_name)
                .await?
                && pod["metadata"]["uid"] == park.pod_uid.as_str()
                && pod["metadata"]["deletionTimestamp"].is_null()
                && !terminal_pod(&pod)
                && !Self::requested(&pod, &park.requests_before)
            {
                self.resize(&pod, &park.requests_before).await?;
            }
            return Ok((Resumed::Ordinary, map, prior, cluster));
        }
        let resumable = matches!(prior.phase, Phase::Parking | Phase::Parked | Phase::Wake)
            && !hibernation_on(&cluster);
        let mut decision = timing::Phase::begin(db, "park_eligibility");
        let verdict = if resumable {
            self.eligible(db, &park, &cluster, basis).await?
        } else {
            Some("demotion_in_progress")
        };
        if let Some(reason) = verdict {
            decision.note("reason", reason);
            decision.pending();
            // The slow path: demote first, then the ordinary CNPG wake.
            let (outcome, map, progress, cluster) =
                self.demote(db, intent, map, prior, &cluster, false).await?;
            return Ok(match outcome {
                Demotion::Done => (Resumed::Ordinary, map, progress, cluster),
                Demotion::Pending => (Resumed::Waiting, map, progress, cluster),
            });
        }
        decision.note("reason", Value::Null);
        decision.completed();
        // The fast path. Progress `Wake` is persisted first and keeps the record, so a crash
        // after the unfence still finds the Pod it must resume; then one patch lifts the fence
        // and releases hibernation while the Pod's requests return.
        let started = Instant::now();
        let mut progress = Progress::new(
            intent.clone(),
            Phase::Wake,
            prior.anchor.clone(),
            self.now(),
        );
        progress.park = Some(park.clone());
        progress.proof_intent = prior.proof_intent.clone();
        progress.segment = prior.segment.clone();
        progress.gateways = prior.gateways.clone();
        progress.key_uid = prior.key_uid.clone();
        progress.key_version = prior.key_version.clone();
        if prior.target.revision == intent.revision {
            progress.started_at = prior.started_at;
        }
        let map = self.write(db, Some(&map), None, &progress).await?;
        let lift = timing::Phase::begin(db, "unfence_patch");
        let resize = timing::Phase::begin(db, "resize_up");
        let pod = self
            .k8s
            .read("Pod", Some(&namespace(db)), &park.pod_name)
            .await?;
        let (unfenced, resized) =
            tokio::join!(self.lift_and_release(db, intent, &cluster), async {
                match pod {
                    Some(pod) if !Self::requested(&pod, &park.requests_before) => {
                        self.resize(&pod, &park.requests_before).await.map(|_| ())
                    }
                    _ => Ok(()),
                }
            });
        match &unfenced {
            Ok(()) => lift.completed(),
            Err(_) => lift.failed(),
        }
        match &resized {
            Ok(()) => resize.completed(),
            Err(_) => resize.failed(),
        }
        // A resize that did not land is retried by the next pass (the record is retained); the
        // unfence either landed, and is read back, or was not written.
        unfenced?;
        let _ = resized;
        Ok((
            Resumed::Fast(ParkedWake {
                pod_name: park.pod_name,
                pod_uid: park.pod_uid,
                postgres_container_id: park.postgres_container_id,
                sidecar_container_id: park.sidecar_container_id,
                started,
            }),
            map,
            progress,
            cluster,
        ))
    }
    /// One CAS patch lifting the fence and setting hibernation off, retried across the Cluster
    /// status writes CNPG makes between the read and the write.
    async fn lift_and_release(
        &self,
        db: &Value,
        intent: &PowerIntent,
        cluster: &Value,
    ) -> Result<()> {
        let mut current = cluster.clone();
        let mut last = Fault::Unavailable("cluster_power_write_unknown");
        for attempt in 0..3 {
            match self.cluster_intent(intent, &current, "off").await {
                Ok(()) => return Ok(()),
                Err(Fault::Unavailable(reason)) if attempt < 2 => {
                    last = Fault::Unavailable(reason);
                    let fresh = self
                        .k8s
                        .read("Cluster", Some(&namespace(db)), "database")
                        .await?;
                    let Some(fresh) =
                        fresh.filter(|c| c["metadata"]["uid"] == cluster["metadata"]["uid"])
                    else {
                        return Err(Fault::Recovery(
                            "established_database_resource_missing_or_replaced",
                        ));
                    };
                    current = fresh;
                }
                Err(error) => return Err(error),
            }
        }
        Err(last)
    }
    /// What a sleeping pass knows of the fast wake of the Pod it retains.
    async fn standing(
        &self,
        db: &Value,
        park: &Park,
        cluster: &Value,
        sleep: &Sleep<'_>,
    ) -> Result<Standing> {
        if sleep.basis.manifests.is_none() {
            return Ok(Standing::Unknown);
        }
        match self.eligible(db, park, cluster, &sleep.basis).await {
            Ok(None) => Ok(Standing::Holds),
            Ok(Some(reason)) => Ok(Standing::Lost(reason)),
            Err(Fault::Unavailable(_)) => Ok(Standing::Unknown),
            Err(error) => Err(error),
        }
    }
    /// Whether the retained Pod can be resumed instead of recreated: fenced, not hibernating,
    /// and intact. `Some(reason)` names the first predicate that does not hold.
    async fn eligible(
        &self,
        db: &Value,
        park: &Park,
        cluster: &Value,
        basis: &Basis<'_>,
    ) -> Result<Option<&'static str>> {
        if !fenced(cluster) {
            return Ok(Some("fence_missing"));
        }
        if hibernation_on(cluster) {
            return Ok(Some("hibernation_on"));
        }
        self.intact(db, park, cluster, basis).await
    }
    /// Whether nothing the Pod was parked under has changed: the fleet release and the node's
    /// boot, the Pod and its containers, its image and runtime, and the desired manifests, which
    /// must change no spec and no data when applied (they cover the size class, the image, the
    /// parameters, the plugin and every credential, so none can roll the Pod after a wake or
    /// leave a credential unacknowledged). Every predicate is read, none is guessed.
    async fn intact(
        &self,
        db: &Value,
        park: &Park,
        cluster: &Value,
        basis: &Basis<'_>,
    ) -> Result<Option<&'static str>> {
        let release = &basis.release["release"];
        if release["id"] != park.release_id.as_str()
            || release["spec_sha256"] != park.spec_sha256.as_str()
            || assignment(basis.release, text(db, "node")) != Some(park.assignment_revision)
        {
            return Ok(Some("release_changed"));
        }
        if boot_id(basis.node).is_empty() || boot_id(basis.node) != park.node_boot_id {
            return Ok(Some("boot_changed"));
        }
        if cluster["status"]["currentPrimary"] != park.pod_name.as_str() {
            return Ok(Some("pod_changed"));
        }
        let Some(manifests) = basis.manifests else {
            return Ok(Some("manifests_unavailable"));
        };
        let ns = namespace(db);
        let (pod, current) = tokio::try_join!(
            self.k8s.read("Pod", Some(&ns), &park.pod_name),
            try_join_all(
                manifests
                    .iter()
                    .filter(|m| text(m, "kind") != "Namespace")
                    .map(|m| self.k8s.read(
                        text(m, "kind"),
                        m["metadata"]["namespace"].as_str(),
                        text(&m["metadata"], "name"),
                    ))
            )
        )?;
        let Some(pod) = pod else {
            return Ok(Some("pod_missing"));
        };
        if !bound(&pod, park) || !instance_live(&pod, cluster, db) {
            return Ok(Some("pod_changed"));
        }
        if text(&pod["spec"], "runtimeClassName") != basis.runtime_class {
            return Ok(Some("runtime_changed"));
        }
        // The Pod runs what the Cluster is asked to run: CNPG would otherwise roll it.
        let wanted = manifests.iter().find(|m| text(m, "kind") == "Cluster");
        let image = named(&pod["spec"]["containers"], POSTGRES).map(|c| text(c, "image"));
        if wanted.map(|m| text(&m["spec"], "imageName")) != image {
            return Ok(Some("image_changed"));
        }
        // Applying the desired manifests must change no spec and no data: the `apply` predicate,
        // ignoring only the generation annotation a wake always advances.
        let wanted = manifests.iter().filter(|m| text(m, "kind") != "Namespace");
        for (manifest, actual) in wanted.zip(current) {
            let Some(actual) = actual else {
                return Ok(Some("manifest_missing"));
            };
            let content = if matches!(text(manifest, "kind"), "Secret" | "ConfigMap") {
                "data"
            } else {
                "spec"
            };
            if !contains(&actual[content], &manifest[content], "")
                || !contains(
                    &actual["metadata"]["labels"],
                    &manifest["metadata"]["labels"],
                    "",
                )
            {
                return Ok(Some("manifest_changed"));
            }
        }
        Ok(None)
    }
}
