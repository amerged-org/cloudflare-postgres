// SPDX-License-Identifier: Apache-2.0
//! Retry the first CNPG backup rejected before execution because its cluster was hibernated.
use crate::{
    Error,
    contracts::{generation, namespace, number, text},
    kubernetes::Kubernetes,
};
use serde_json::{Value, json};

const PLUGIN: &str = "barman-cloud.cloudnative-pg.io";
const RETRY_SOURCE: &str = "pgcf.io/retries-backup-uid";

fn owned_by_cluster(backup: &Value, cluster: &Value) -> bool {
    let owners: Vec<_> = backup["metadata"]["ownerReferences"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|owner| owner["kind"] == "Cluster")
        .collect();
    owners.len() == 1
        && owners[0]["apiVersion"] == cluster["apiVersion"]
        && owners[0]["name"] == cluster["metadata"]["name"]
        && owners[0]["uid"] == cluster["metadata"]["uid"]
}

fn retry_manifest(
    db: &Value,
    ns: &Value,
    cluster: &Value,
    schedule: &Value,
    backups: &[Value],
) -> Result<Option<Value>, Error> {
    // Pool-owned storage is backed up by the supervisor. A stale desired snapshot must not
    // cross a newer namespace generation or a CNPG hibernation/primary transition.
    if text(db, "desired_state") != "running"
        || db.get("pool_binding").is_some()
        || generation(ns) != number(db, "generation")
        || ns["metadata"]["annotations"]["pgcf.io/accepted-generation"].as_str()
            != Some(number(db, "generation").to_string().as_str())
        || cluster["metadata"]["annotations"]["cnpg.io/hibernation"] == "on"
        || !cluster["metadata"]["deletionTimestamp"].is_null()
        || text(&cluster["status"], "currentPrimary").is_empty()
        || !cluster["status"]["conditions"]
            .as_array()
            .is_some_and(|conditions| {
                conditions
                    .iter()
                    .any(|c| c["type"] == "Ready" && c["status"] == "True")
            })
    {
        return Ok(None);
    }
    if schedule["spec"]["immediate"] != true
        || schedule["spec"]["suspend"] == true
        || schedule["metadata"]["name"] != "daily-backup"
        || schedule["spec"]["backupOwnerReference"] != "cluster"
        || schedule["spec"]["cluster"]["name"] != cluster["metadata"]["name"]
        || schedule["spec"]["method"] != "plugin"
        || schedule["spec"]["pluginConfiguration"]["name"] != PLUGIN
    {
        return Ok(None);
    }
    let uid = text(&cluster["metadata"], "uid");
    if !pgcf_native_protocol::valid_pattern("uuid", uid) {
        return Err("initial backup Cluster identity invalid".into());
    }
    let name = format!("initial-backup-{uid}");
    let retries: Vec<_> = backups
        .iter()
        .filter(|b| b["metadata"]["name"] == name)
        .collect();
    if retries.len() > 1 {
        return Err("initial backup retry identity ambiguous".into());
    }
    if let Some(existing) = retries.first() {
        if !owned_by_cluster(existing, cluster)
            || existing["spec"]["cluster"]["name"] != cluster["metadata"]["name"]
            || existing["spec"]["method"] != "plugin"
            || existing["spec"]["pluginConfiguration"] != schedule["spec"]["pluginConfiguration"]
            || !pgcf_native_protocol::valid_pattern(
                "uuid",
                text(&existing["metadata"]["annotations"], RETRY_SOURCE),
            )
        {
            return Err("initial backup retry ownership changed".into());
        }
        // Any observed phase, including failure or absent status, consumes this one retry.
        return Ok(None);
    }
    let current: Vec<_> = backups
        .iter()
        .filter(|b| b["spec"]["cluster"]["name"] == cluster["metadata"]["name"])
        .collect();
    // Refuse observed in-flight/unknown work and any successful base backup. CNPG also
    // serializes execution if another scheduler creates a Backup after this inventory read.
    if current
        .iter()
        .any(|b| text(&b["status"], "phase") != "failed")
    {
        return Ok(None);
    }
    let failed: Vec<_> = current
        .into_iter()
        .filter(|b| {
            b["metadata"]["labels"]["cnpg.io/scheduled-backup"] == schedule["metadata"]["name"]
                && b["metadata"]["labels"]["cnpg.io/immediateBackup"] == "true"
                && b["status"]["error"] == "cannot backup a hibernated cluster"
        })
        .collect();
    if failed.len() != 1 {
        return Ok(None);
    }
    let failed = failed[0];
    let failed_uid = text(&failed["metadata"], "uid");
    if !owned_by_cluster(failed, cluster)
        || !pgcf_native_protocol::valid_pattern("uuid", failed_uid)
        || !failed["metadata"]["deletionTimestamp"].is_null()
        || failed["spec"]["method"] != "plugin"
        || failed["spec"]["pluginConfiguration"] != schedule["spec"]["pluginConfiguration"]
    {
        return Err("initial backup failure ownership changed".into());
    }
    Ok(Some(
        json!({"apiVersion":"postgresql.cnpg.io/v1","kind":"Backup","metadata":{
        "name":name,"namespace":namespace(db),"labels":{"pgcf.io/database-id":db["id"],"cnpg.io/cluster":cluster["metadata"]["name"]},
        "annotations":{RETRY_SOURCE:failed_uid},"ownerReferences":[{"apiVersion":cluster["apiVersion"],"kind":"Cluster","name":cluster["metadata"]["name"],"uid":uid}]},
        "spec":{"cluster":{"name":cluster["metadata"]["name"]},"method":"plugin","pluginConfiguration":schedule["spec"]["pluginConfiguration"]}}),
    ))
}

pub async fn retry(
    kube: &Kubernetes,
    db: &Value,
    ns: &Value,
    cluster: &Value,
    backups: &[Value],
) -> Result<(), Error> {
    if text(db, "desired_state") != "running" || db.get("pool_binding").is_some() {
        return Ok(());
    }
    let namespace = namespace(db);
    let Some(schedule) = kube
        .read("ScheduledBackup", Some(&namespace), "daily-backup")
        .await?
    else {
        return Ok(());
    };
    if schedule["metadata"]["labels"]["pgcf.io/database-id"] != db["id"]
        || !schedule["metadata"]["deletionTimestamp"].is_null()
    {
        return Err("initial backup schedule ownership changed".into());
    }
    if retry_manifest(db, ns, cluster, &schedule, backups)?.is_none() {
        return Ok(());
    }
    let primary = text(&cluster["status"], "currentPrimary");
    let Some(pod) = kube.read("Pod", Some(&namespace), primary).await? else {
        return Ok(());
    };
    if !owned_by_cluster(&pod, cluster)
        || !pod["metadata"]["deletionTimestamp"].is_null()
        || pod["status"]["phase"] != "Running"
        || !pod["status"]["conditions"]
            .as_array()
            .is_some_and(|conditions| {
                conditions
                    .iter()
                    .any(|c| c["type"] == "Ready" && c["status"] == "True")
            })
    {
        return Ok(());
    }
    // The health inventory preceded schedule/primary reads. Observe any newly scheduled work
    // before deciding again; Kubernetes provides no transaction across these resources.
    let current_backups = kube.list("Backup", Some(&namespace), None).await?;
    let Some(manifest) = retry_manifest(db, ns, cluster, &schedule, &current_backups)? else {
        return Ok(());
    };
    // Exact API revisions prevent a known intervening state change. CNPG independently refuses
    // hibernation if it races after these reads; this never unhibernates or starts PostgreSQL.
    for before in [ns, cluster, &schedule, &pod] {
        let Some(after) = kube
            .read(
                text(before, "kind"),
                before["metadata"]["namespace"].as_str(),
                text(&before["metadata"], "name"),
            )
            .await?
        else {
            return Ok(());
        };
        if after["metadata"]["uid"] != before["metadata"]["uid"]
            || after["metadata"]["resourceVersion"] != before["metadata"]["resourceVersion"]
        {
            return Ok(());
        }
    }
    // Deterministic name makes a lost POST response discoverable. Never replay the underlying
    // backup command: an observed retry object is final for this initial failure in every phase.
    kube.create(&manifest).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn failed_immediate_backup_gets_one_owned_retry_only_after_cnpg_is_ready() {
        let db = json!({"id":"vq2oep9bz6aukdx4cxd9","generation":2,"desired_state":"running"});
        let namespace = json!({"metadata":{"uid":"54bb46e2-cdfd-4ed3-ae24-8c4850721cac","annotations":{"pgcf.io/generation":"2","pgcf.io/accepted-generation":"2"}}});
        let mut cluster = json!({"apiVersion":"postgresql.cnpg.io/v1","kind":"Cluster","metadata":{"name":"database","namespace":"pgcf-db-vq2oep9bz6aukdx4cxd9","uid":"724af55c-e16c-47fb-8fc0-53894dae0a40","annotations":{"cnpg.io/hibernation":"on"}},"status":{"currentPrimary":"database-1","conditions":[{"type":"Ready","status":"True"}]}});
        let schedule = json!({"metadata":{"name":"daily-backup","uid":"7a7c52d7-fbf4-46f6-951c-1968a46aed88"},"spec":{"immediate":true,"backupOwnerReference":"cluster","cluster":{"name":"database"},"method":"plugin","pluginConfiguration":{"name":"barman-cloud.cloudnative-pg.io"}}});
        let failed = json!({"apiVersion":"postgresql.cnpg.io/v1","kind":"Backup","metadata":{"name":"daily-backup-20261014003807","namespace":"pgcf-db-vq2oep9bz6aukdx4cxd9","uid":"6f6706e0-30c5-4ca4-a070-fce5584e719b","labels":{"cnpg.io/scheduled-backup":"daily-backup","cnpg.io/immediateBackup":"true"},"ownerReferences":[{"apiVersion":"postgresql.cnpg.io/v1","kind":"Cluster","name":"database","uid":"724af55c-e16c-47fb-8fc0-53894dae0a40"}]},"spec":schedule["spec"],"status":{"phase":"failed","error":"cannot backup a hibernated cluster"}});
        assert!(
            retry_manifest(
                &db,
                &namespace,
                &cluster,
                &schedule,
                std::slice::from_ref(&failed)
            )
            .unwrap()
            .is_none()
        );
        cluster["metadata"]["annotations"]["cnpg.io/hibernation"] = json!("off");
        let retry = retry_manifest(
            &db,
            &namespace,
            &cluster,
            &schedule,
            std::slice::from_ref(&failed),
        )
        .unwrap()
        .expect("failed initial backup must be retried after recovery");
        assert_eq!(
            retry["metadata"]["name"],
            "initial-backup-724af55c-e16c-47fb-8fc0-53894dae0a40"
        );
        assert_eq!(
            retry["metadata"]["annotations"]["pgcf.io/retries-backup-uid"],
            failed["metadata"]["uid"]
        );
        assert_eq!(
            retry["metadata"]["ownerReferences"][0]["uid"],
            cluster["metadata"]["uid"]
        );
        assert_eq!(retry["spec"]["method"], "plugin");
        assert!(retry["spec"].get("immediate").is_none());
        let mut existing = retry.clone();
        existing["metadata"]["uid"] = json!("c926df99-c68e-4440-81cb-7bde0d96b2db");
        existing["status"] = json!({"phase":"failed"});
        assert!(
            retry_manifest(
                &db,
                &namespace,
                &cluster,
                &schedule,
                &[failed.clone(), existing.clone()]
            )
            .unwrap()
            .is_none()
        );
        existing["metadata"]["ownerReferences"][0]["uid"] =
            json!("b7d4ae65-fc2a-4f67-944f-5f73c6c729dd");
        assert!(
            retry_manifest(
                &db,
                &namespace,
                &cluster,
                &schedule,
                &[failed.clone(), existing]
            )
            .is_err()
        );
        let mut completed = failed.clone();
        completed["metadata"]["uid"] = json!("ba09714a-4a9f-4503-9ad1-0b9700e89f03");
        completed["status"]["phase"] = json!("completed");
        assert!(
            retry_manifest(
                &db,
                &namespace,
                &cluster,
                &schedule,
                &[failed.clone(), completed]
            )
            .unwrap()
            .is_none()
        );
        let mut stale = namespace.clone();
        stale["metadata"]["annotations"]["pgcf.io/accepted-generation"] = json!("3");
        assert!(
            retry_manifest(
                &db,
                &stale,
                &cluster,
                &schedule,
                std::slice::from_ref(&failed)
            )
            .unwrap()
            .is_none()
        );
        let mut held = db.clone();
        held["pool_binding"] = json!({"state":"serving"});
        assert!(
            retry_manifest(
                &held,
                &namespace,
                &cluster,
                &schedule,
                std::slice::from_ref(&failed)
            )
            .unwrap()
            .is_none()
        );
    }
}
