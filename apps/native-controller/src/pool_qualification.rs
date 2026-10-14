// SPDX-License-Identifier: Apache-2.0
//! Finite qualification effects. Cloudflare's journal is the only restart authority.
use crate::{
    Error,
    kubernetes::Kubernetes,
    pool::{Runtime, clock},
};
use pgcf_native_protocol::{qualification, valid_pattern};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::time::Duration;
fn text<'a>(v: &'a Value, k: &str) -> Result<&'a str, Error> {
    v[k].as_str()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "pool_qualification_field_missing".into())
}
fn hash(raw: &str) -> String {
    Sha256::digest(raw.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
fn snapshot_name(q: &Value) -> String {
    format!(
        "pgcf-q-{}",
        q["scope_sha256"]
            .as_str()
            .unwrap_or("")
            .chars()
            .take(24)
            .collect::<String>()
    )
}
fn parts(q: &Value) -> Vec<&Value> {
    let nonce = q["challenge"]["nonce"].as_str().map(hash);
    q["pending_progress"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|p| p["nonce_sha256"].as_str() == nonce.as_deref())
        .collect()
}
fn phase<'a>(q: &'a Value, name: &str) -> Option<&'a Value> {
    parts(q)
        .into_iter()
        .find(|p| p["progress"]["phase"] == name)
}
fn current(q: &Value, previous: &Value) -> Result<(), Error> {
    if q["scope"] != previous["scope"]
        || q["scope_sha256"] != previous["scope_sha256"]
        || q["challenge"] != previous["challenge"]
        || q["status"] != "running"
        || q["challenge"]["gate"] != "finite_creator_fence"
        || q["challenge"]["expires_at"]
            .as_u64()
            .is_none_or(|n| n <= clock().unwrap_or(u64::MAX))
    {
        return Err("pool_qualification_challenge_changed".into());
    }
    Ok(())
}
async fn refresh(runtime: &Runtime, q: &Value) -> Result<Value, Error> {
    let next = runtime
        .qualification(text(&q["scope"], "node_id")?)
        .await?
        .ok_or("pool_qualification_missing")?;
    current(&next, q)?;
    Ok(next)
}
async fn append(runtime: &Runtime, q: &Value, progress: Value) -> Result<Value, Error> {
    let now = clock()?;
    let report = json!({"run_id":q["scope"]["run_id"],"scope_sha256":q["scope_sha256"],"node_uid":q["scope"]["node_uid"],"boot_id":q["execution"]["boot_id"],"candidate_spec_sha256":q["execution"]["candidate_spec_sha256"],"sequence":q["challenge"]["sequence"],"nonce":q["challenge"]["nonce"],"producer":"controller","started_at":now,"observed_at":now,"progress":progress});
    if !qualification::validate("PostgresPoolQualificationProgressReport", &report) {
        return Err("pool_qualification_progress_invalid".into());
    }
    // One POST. An uncertain reply is resolved by the authenticated journal read, never replayed.
    let response = runtime
        .api
        .request(
            &format!(
                "/agent/v1/nodes/{}/postgres-pool/qualification",
                text(&q["scope"], "node_id")?
            ),
            Some(&report),
        )
        .await;
    if response
        .as_ref()
        .is_ok_and(|v| v != &json!({"recorded":true}))
    {
        return Err("pool_qualification_progress_unconfirmed".into());
    }
    let next = refresh(runtime, q).await?;
    let stored =
        phase(&next, text(&progress, "phase")?).ok_or("pool_qualification_progress_unconfirmed")?;
    if stored["progress"] != progress || stored["started_at"] != now || stored["observed_at"] != now
    {
        return Err("pool_qualification_progress_changed".into());
    }
    Ok(next)
}
fn owner(pod: &Value) -> Result<&Value, Error> {
    let owners = pod["metadata"]["ownerReferences"]
        .as_array()
        .ok_or("pool_qualification_driver_owner_missing")?
        .iter()
        .filter(|o| {
            o["kind"] == "DaemonSet" && o["apiVersion"] == "apps/v1" && o["controller"] == true
        })
        .collect::<Vec<_>>();
    if owners.len() != 1 {
        return Err("pool_qualification_driver_owner_changed".into());
    }
    Ok(owners[0])
}
fn driver_container<'a>(pod: &'a Value, image: &str) -> Result<&'a str, Error> {
    let containers = pod["spec"]["containers"]
        .as_array()
        .ok_or("pool_qualification_driver_container_missing")?
        .iter()
        .filter(|c| c["image"] == image)
        .collect::<Vec<_>>();
    if containers.len() != 1 {
        return Err("pool_qualification_driver_image_changed".into());
    }
    text(containers[0], "name")
}
async fn node(kube: &Kubernetes, q: &Value) -> Result<Value, Error> {
    let nodes = kube.list("Node", None, None).await?;
    let found = nodes
        .into_iter()
        .find(|n| n["metadata"]["uid"] == q["scope"]["node_uid"])
        .ok_or("pool_qualification_node_missing")?;
    if !found["metadata"]["deletionTimestamp"].is_null()
        || found["status"]["nodeInfo"]["bootID"] != q["execution"]["boot_id"]
        || q["execution"]["boot_id"] != q["scope"]["boot_id"]
    {
        return Err("pool_qualification_node_boot_changed".into());
    }
    Ok(found)
}
async fn driver(
    kube: &Kubernetes,
    q: &Value,
    uid: &Value,
    daemonset: Option<&Value>,
) -> Result<Value, Error> {
    let node = node(kube, q).await?;
    let pods = kube.list("Pod", Some("openebs"), None).await?;
    let matches = pods
        .into_iter()
        .filter(|p| {
            p["metadata"]["uid"] == *uid && p["spec"]["nodeName"] == node["metadata"]["name"]
        })
        .collect::<Vec<_>>();
    if matches.len() != 1 {
        return Err("pool_qualification_driver_missing".into());
    }
    let pod = matches[0].clone();
    let owned = owner(&pod)?;
    let ds = kube
        .read("DaemonSet", Some("openebs"), text(owned, "name")?)
        .await?
        .ok_or("pool_qualification_driver_owner_missing")?;
    if ds["metadata"]["uid"] != owned["uid"]
        || !ds["metadata"]["deletionTimestamp"].is_null()
        || daemonset.is_some_and(|d| ds["metadata"]["uid"] != *d)
        || pod["metadata"]["deletionTimestamp"].is_string()
        || driver_container(&pod, text(&q["scope"]["software"], "driver_image")?).is_err()
        || driver_container(
            &ds["spec"]["template"],
            text(&q["scope"]["software"], "driver_image")?,
        )
        .is_err()
    {
        return Err("pool_qualification_driver_scope_changed".into());
    }
    Ok(pod)
}
/// Only a timestamped denial for this owned workqueue key counts; raw logs never leave this module.
fn denial_at(raw: &str, name: &str, since: u64) -> Option<u64> {
    let key = format!("error syncing 'openebs/{name}': pool_creator_fence_denied, requeuing");
    raw.lines()
        .filter_map(|line| {
            let (stamp, message) = line.split_once(' ')?;
            if !message.contains(&key) {
                return None;
            }
            let t =
                time::OffsetDateTime::parse(stamp, &time::format_description::well_known::Rfc3339)
                    .ok()?;
            let millis = u64::try_from(t.unix_timestamp_nanos() / 1_000_000).ok()?;
            (millis >= since).then_some(millis)
        })
        .min()
}
async fn denial(
    kube: &Kubernetes,
    q: &Value,
    pod: &Value,
    key: &str,
    since: u64,
) -> Result<Option<u64>, Error> {
    let image = text(&q["scope"]["software"], "driver_image")?;
    let raw = kube
        .openebs_driver_logs(pod, driver_container(pod, image)?, image, since)
        .await
        .map_err(|_| "pool_qualification_driver_log_unavailable")?;
    Ok(denial_at(&raw, key, since))
}
pub fn snapshot_disposable(q: &Value, snapshot: &Value, uid: &str) -> bool {
    snapshot["apiVersion"] == "local.openebs.io/v1alpha1"
        && snapshot["kind"] == "LVMSnapshot"
        && snapshot["metadata"]["name"] == snapshot_name(q)
        && snapshot["metadata"]["namespace"] == "openebs"
        && snapshot["metadata"]["uid"] == uid
        && snapshot["metadata"]["resourceVersion"]
            .as_str()
            .is_some_and(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()))
        && snapshot["metadata"]["labels"]["openebs.io/persistent-volume"]
            == q["scope"]["volume"]["volume_handle"]
        && snapshot["metadata"]["labels"]["pgcf.io/qualification-run"] == q["scope"]["run_id"]
        && snapshot["metadata"]["annotations"]["pgcf.io/qualification-scope"] == q["scope_sha256"]
        && snapshot["metadata"]["finalizers"]
            .as_array()
            .is_none_or(Vec::is_empty)
        && snapshot["status"]["state"] == "Pending"
}
fn snapshot_created_progress(q: &Value, snapshot: &Value, denial: Option<u64>) -> Option<Value> {
    denial?;
    Some(
        json!({"gate":"finite_creator_fence","phase":"snapshot_created","snapshot_uid":snapshot["metadata"]["uid"],"snapshot_resource_version":snapshot["metadata"]["resourceVersion"],"snapshot_name":snapshot_name(q),"snapshot_namespace":"openebs","source_volume_handle":q["scope"]["volume"]["volume_handle"]}),
    )
}
pub fn snapshot_manifest(q: &Value, volume: &Value) -> Result<Value, Error> {
    if volume["kind"] != "LVMVolume"
        || volume["apiVersion"] != "local.openebs.io/v1alpha1"
        || volume["metadata"]["name"] != q["scope"]["volume"]["volume_handle"]
        || volume["metadata"]["namespace"] != "openebs"
        || !volume["metadata"]["deletionTimestamp"].is_null()
        || volume["spec"]["thinProvision"] != "yes"
        || volume["status"]["state"] != "Ready"
        || !volume["metadata"]["uid"]
            .as_str()
            .is_some_and(|s| valid_pattern("uuid", s))
    {
        return Err("pool_qualification_source_volume_changed".into());
    }
    let manifest = json!({"apiVersion":"local.openebs.io/v1alpha1","kind":"LVMSnapshot","metadata":{"name":snapshot_name(q),"namespace":"openebs","labels":{"openebs.io/persistent-volume":volume["metadata"]["name"],"pgcf.io/qualification-run":q["scope"]["run_id"]},"annotations":{"pgcf.io/qualification-scope":q["scope_sha256"]},"ownerReferences":[{"apiVersion":"local.openebs.io/v1alpha1","kind":"LVMVolume","name":volume["metadata"]["name"],"uid":volume["metadata"]["uid"]}]},"spec":{"ownerNodeID":text(&volume["spec"],"ownerNodeID")?,"volGroup":text(&volume["spec"],"volGroup")?,"thinProvision":true},"status":{"state":"Pending"}});
    Ok(manifest)
}
/// Actual Kube cleanup handoff; nonzero/unknown resources stay pending for their existing owners.
pub async fn observe_cleanup(runtime: &Runtime, kube: &Kubernetes, q: &Value) -> Result<(), Error> {
    if q["status"] != "cleanup"
        || q["challenge"]["gate"] != "cleanup"
        || phase(q, "controller_cleanup_observed").is_some()
    {
        return Ok(());
    }
    let ns = format!("pgcf-db-{}", text(&q["scope"], "database_id")?);
    let namespace = kube
        .read("Namespace", None, &ns)
        .await?
        .ok_or("pool_qualification_cleanup_namespace_unknown")?;
    let cluster = kube
        .read("Cluster", Some(&ns), "database")
        .await?
        .ok_or("pool_qualification_cleanup_cluster_unknown")?;
    if namespace["metadata"]["uid"] != q["scope"]["volume"]["namespace_uid"]
        || cluster["metadata"]["uid"] != q["scope"]["volume"]["cluster_uid"]
        || cluster["metadata"]["annotations"]["cnpg.io/hibernation"] != "on"
    {
        return Ok(());
    }
    let nodes = kube.list("Node", None, None).await?;
    let node = nodes
        .iter()
        .find(|n| n["metadata"]["uid"] == q["execution"]["node_uid"])
        .ok_or("pool_qualification_cleanup_node_unknown")?;
    if node["status"]["nodeInfo"]["bootID"] != q["execution"]["boot_id"] {
        return Ok(());
    }
    let instances = kube.list("Pod", Some(&ns), None).await?;
    let pools = kube
        .list("Pod", Some("pgcf-pool"), None)
        .await?
        .into_iter()
        .filter(|p| p["spec"]["nodeName"] == node["metadata"]["name"])
        .collect::<Vec<_>>();
    let lease = kube.read("Lease", Some(&ns), "database").await?;
    if !instances.is_empty()
        || !pools.is_empty()
        || lease.as_ref().is_some_and(|l| {
            l["spec"]["holderIdentity"]
                .as_str()
                .is_some_and(|h| !h.is_empty())
        })
    {
        return Ok(());
    }
    let progress = json!({"gate":"cleanup","phase":"controller_cleanup_observed","namespace_uid":namespace["metadata"]["uid"],"cnpg_cluster_uid":cluster["metadata"]["uid"],"hibernation":"on","remaining_instance_pods":0,"remaining_pool_pods":0,"primary_lease":lease.map(|l|json!({"uid":l["metadata"]["uid"],"resource_version":l["metadata"]["resourceVersion"],"holder_identity":null}))});
    let now = clock()?;
    let report = json!({"run_id":q["scope"]["run_id"],"scope_sha256":q["scope_sha256"],"node_uid":q["scope"]["node_uid"],"boot_id":q["execution"]["boot_id"],"candidate_spec_sha256":q["execution"]["candidate_spec_sha256"],"sequence":q["challenge"]["sequence"],"nonce":q["challenge"]["nonce"],"producer":"controller","started_at":now,"observed_at":now,"progress":progress});
    if !qualification::validate("PostgresPoolQualificationProgressReport", &report) {
        return Err("pool_qualification_cleanup_report_invalid".into());
    }
    let result = runtime
        .api
        .request(
            &format!(
                "/agent/v1/nodes/{}/postgres-pool/qualification",
                text(&q["scope"], "node_id")?
            ),
            Some(&report),
        )
        .await?;
    if result != json!({"recorded":true}) {
        return Err("pool_qualification_cleanup_unconfirmed".into());
    }
    Ok(())
}
/// Advances only this run's composite finite gate. Existing intents never dispatch effects again.
pub async fn advance(runtime: &Runtime, kube: &Kubernetes, initial: &Value) -> Result<(), Error> {
    if initial["status"] != "running" || initial["challenge"]["gate"] != "finite_creator_fence" {
        return Ok(());
    }
    let mut q = refresh(runtime, initial).await?;
    if parts(&q).len() == 1 {
        let pod = driver(kube, &q, &q["execution"]["driver_pod_uid"], None).await?;
        let intent = json!({"gate":"finite_creator_fence","phase":"driver_delete_intent","driver_pod_uid":pod["metadata"]["uid"],"driver_pod_name":pod["metadata"]["name"],"driver_pod_resource_version":pod["metadata"]["resourceVersion"],"driver_namespace":"openebs","driver_daemonset_uid":owner(&pod)?["uid"],"driver_image":q["scope"]["software"]["driver_image"]});
        q = append(runtime, &q, intent).await?;
        // This invocation alone knows that its newly durable intent has not been dispatched.
        // Cancellation or an uncertain response leaves only GET readback on the next invocation.
        let _ = kube.delete(&pod, "Background").await;
    }
    if parts(&q).len() == 2 {
        let intent = phase(&q, "driver_delete_intent")
            .ok_or("pool_qualification_driver_intent_missing")?["progress"]
            .clone();
        let old = kube
            .read("Pod", Some("openebs"), text(&intent, "driver_pod_name")?)
            .await?;
        if old
            .as_ref()
            .is_some_and(|p| p["metadata"]["uid"] == intent["driver_pod_uid"])
        {
            return Ok(());
        }
        let deleted_at = clock()?;
        // Wait for the normal authenticated thin identity read to name the replacement.
        if q["execution"]["driver_pod_uid"] == intent["driver_pod_uid"] {
            return Ok(());
        }
        let pod = driver(
            kube,
            &q,
            &q["execution"]["driver_pod_uid"],
            Some(&intent["driver_daemonset_uid"]),
        )
        .await?;
        let until = std::cmp::min(
            q["challenge"]["expires_at"]
                .as_u64()
                .ok_or("pool_qualification_deadline_missing")?,
            deleted_at + 5000,
        );
        let at = loop {
            q = refresh(runtime, &q).await?;
            if let Some(at) = denial(
                kube,
                &q,
                &pod,
                text(&q["scope"]["volume"], "volume_handle")?,
                deleted_at,
            )
            .await?
            {
                break at;
            }
            if clock()? >= until {
                return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        };
        // Deletion and readiness timestamps are observations of current states, not a guessed ACK.
        let observed = clock()?;
        q=append(runtime,&q,json!({"gate":"finite_creator_fence","phase":"driver_restarted","driver_pod_uid_before_restart":intent["driver_pod_uid"],"driver_pod_uid_after_restart":pod["metadata"]["uid"],"driver_daemonset_uid":intent["driver_daemonset_uid"],"driver_image":intent["driver_image"],"driver_deleted_at":deleted_at,"driver_replacement_ready_at":observed,"volume_reconcile_error":"pool_creator_fence_denied","volume_reconcile_observed_at":at})).await?;
    }
    if parts(&q).len() == 3 {
        let name = snapshot_name(&q);
        if kube
            .read("LVMSnapshot", Some("openebs"), &name)
            .await?
            .is_some()
        {
            return Err("pool_qualification_snapshot_name_occupied".into());
        }
        let volume = kube
            .read(
                "LVMVolume",
                Some("openebs"),
                text(&q["scope"]["volume"], "volume_handle")?,
            )
            .await?
            .ok_or("pool_qualification_source_volume_missing")?;
        let actual_node = node(kube, &q).await?;
        if volume["spec"]["ownerNodeID"] != actual_node["metadata"]["name"] {
            return Err("pool_qualification_source_node_changed".into());
        }
        let manifest = snapshot_manifest(&q, &volume)?;
        q=append(runtime,&q,json!({"gate":"finite_creator_fence","phase":"snapshot_create_intent","snapshot_name":name,"snapshot_namespace":"openebs","source_volume_handle":q["scope"]["volume"]["volume_handle"]})).await?;
        let _ = kube.create(&manifest).await;
        let Some(snapshot) = kube.read("LVMSnapshot", Some("openebs"), &name).await? else {
            return Ok(());
        };
        if !snapshot_disposable(&q, &snapshot, text(&snapshot["metadata"], "uid")?) {
            return Err("pool_qualification_snapshot_not_pending".into());
        }

        remove_snapshot(runtime, kube, &q, &snapshot).await?;
    } else if parts(&q).len() == 4 {
        // A restarted/uncertain CREATE is resolved by its fixed owned name, never replayed.
        let Some(snapshot) = kube
            .read("LVMSnapshot", Some("openebs"), &snapshot_name(&q))
            .await?
        else {
            return Ok(());
        };
        if !snapshot_disposable(&q, &snapshot, text(&snapshot["metadata"], "uid")?) {
            return Err("pool_qualification_snapshot_not_pending".into());
        }

        remove_snapshot(runtime, kube, &q, &snapshot).await?;
    } else if parts(&q).len() == 5 {
        // A cancelled/uncertain DELETE is GET-only. A still-present probe is retained.
        if kube
            .read("LVMSnapshot", Some("openebs"), &snapshot_name(&q))
            .await?
            .is_none()
        {
            let pod = driver(kube, &q, &q["execution"]["driver_pod_uid"], None).await?;
            let since = phase(&q, "snapshot_create_intent")
                .ok_or("pool_qualification_snapshot_intent_missing")?["received_at"]
                .as_u64()
                .ok_or("pool_qualification_timestamp_missing")?;
            if let Some(at) = denial(
                kube,
                &q,
                &pod,
                &snapshot_name(&q),
                since.saturating_sub(5000),
            )
            .await?
            {
                let observed = clock()?;
                append(runtime,&q,json!({"gate":"finite_creator_fence","phase":"snapshot_removed","snapshot_uid":phase(&q,"snapshot_created").ok_or("pool_qualification_snapshot_created_missing")?["progress"]["snapshot_uid"],"source_volume_handle":q["scope"]["volume"]["volume_handle"],"state_at_denial":"Pending","error":"pool_creator_fence_denied","requested_at":at,"deleted_at":observed,"absent_at":observed})).await?;
            }
        }
    }
    Ok(())
}
async fn remove_snapshot(
    runtime: &Runtime,
    kube: &Kubernetes,
    q: &Value,
    snapshot: &Value,
) -> Result<(), Error> {
    let q = refresh(runtime, q).await?;
    if q["execution"]["driver_pod_uid"]
        != phase(&q, "driver_restarted").ok_or("pool_qualification_driver_restart_missing")?["progress"]
            ["driver_pod_uid_after_restart"]
    {
        return Err("pool_qualification_driver_changed".into());
    }
    let pod = driver(kube, &q, &q["execution"]["driver_pod_uid"], None).await?;
    let since = phase(&q, "snapshot_create_intent")
        .ok_or("pool_qualification_snapshot_intent_missing")?["received_at"]
        .as_u64()
        .ok_or("pool_qualification_timestamp_missing")?;
    let until = std::cmp::min(
        q["challenge"]["expires_at"]
            .as_u64()
            .ok_or("pool_qualification_deadline_missing")?,
        clock()? + 5000,
    );
    let at = loop {
        if let Some(at) = denial(
            kube,
            &q,
            &pod,
            &snapshot_name(&q),
            since.saturating_sub(5000),
        )
        .await?
        {
            break at;
        }
        if clock()? >= until {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    };
    if !snapshot_disposable(&q, snapshot, text(&snapshot["metadata"], "uid")?) {
        return Err("pool_qualification_snapshot_not_pending".into());
    }
    // Piece five is the durable disposition to DELETE, only after the actual denial is available.
    // Until this point piece four remains repeatable through reads, so delayed logs cannot strand it.
    let q = append(
        runtime,
        &q,
        snapshot_created_progress(&q, snapshot, Some(at))
            .ok_or("pool_qualification_snapshot_denial_missing")?,
    )
    .await?;
    let q = refresh(runtime, &q).await?;
    let deleted = clock()?;
    let _ = kube.delete(snapshot, "Background").await;
    if kube
        .read("LVMSnapshot", Some("openebs"), &snapshot_name(&q))
        .await?
        .is_some()
    {
        return Ok(());
    }
    let absent = clock()?;
    append(runtime,&q,json!({"gate":"finite_creator_fence","phase":"snapshot_removed","snapshot_uid":snapshot["metadata"]["uid"],"source_volume_handle":q["scope"]["volume"]["volume_handle"],"state_at_denial":"Pending","error":"pool_creator_fence_denied","requested_at":at,"deleted_at":deleted,"absent_at":absent})).await?;
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn missing_denial_keeps_piece_four_available_for_a_later_read() {
        let q = json!({"scope_sha256":"scope","scope":{"volume":{"volume_handle":"pvc-owned"}}});
        let snapshot = json!({"metadata":{"uid":"uid","resourceVersion":"1"}});
        assert!(snapshot_created_progress(&q, &snapshot, None).is_none());
        assert!(snapshot_created_progress(&q, &snapshot, Some(1)).is_some());
    }
    #[test]
    fn only_the_owned_timestamped_workqueue_denial_is_evidence() {
        let line = "2026-10-14T00:00:01Z E1014 error syncing 'openebs/pgcf-q-owned': pool_creator_fence_denied, requeuing";
        assert_eq!(
            denial_at(line, "pgcf-q-owned", 1791936000000),
            Some(1791936001000)
        );
        assert!(denial_at(line, "another-snapshot", 1791936000000).is_none());
        assert!(denial_at(line, "pgcf-q-owned", 1791936002000).is_none());
        assert!(denial_at("pool_creator_fence_denied", "pgcf-q-owned", 0).is_none());
    }
    #[test]
    fn a_ready_or_finalized_snapshot_cannot_be_deleted_as_a_pending_probe() {
        let q = json!({"scope":{"run_id":"run","volume":{"volume_handle":"pvc-owned"}},"scope_sha256":"scope"});
        let mut snapshot = json!({"apiVersion":"local.openebs.io/v1alpha1","kind":"LVMSnapshot","metadata":{"name":"pgcf-q-scope","namespace":"openebs","uid":"uid","resourceVersion":"1","labels":{"openebs.io/persistent-volume":"pvc-owned","pgcf.io/qualification-run":"run"},"annotations":{"pgcf.io/qualification-scope":"scope"}},"status":{"state":"Pending"}});
        assert!(snapshot_disposable(&q, &snapshot, "uid"));
        snapshot["metadata"]["finalizers"] = json!(["local.openebs.io/finalizer"]);
        assert!(!snapshot_disposable(&q, &snapshot, "uid"));
        snapshot["metadata"]
            .as_object_mut()
            .unwrap()
            .remove("finalizers");
        snapshot["status"]["state"] = "Ready".into();
        assert!(!snapshot_disposable(&q, &snapshot, "uid"));
    }
}
