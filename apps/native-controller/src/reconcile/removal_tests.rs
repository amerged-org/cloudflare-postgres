// SPDX-License-Identifier: Apache-2.0
//! The removal of the roles a desired record names `{name, state:"absent"}`, through the
//! reconciler against the in-process doubles: the role is disabled in the Cluster, its sessions are
//! ended, the Cluster is made to drop it, and only a role PostgreSQL no longer has is reported
//! removed. CNPG's part, applying `login: false` and dropping the role, is played by the test.
use super::*;
use crate::test_world::{RoleRow, World};

const REPORT: &str = "report_job";

async fn pass(w: &World) -> Value {
    let observed = w
        .reconciler
        .reconcile(&w.db, &w.snapshot)
        .await
        .unwrap()
        .expect("an observation");
    assert!(
        crate::contracts::schema_valid("DatabaseObservation", &observed),
        "{observed}"
    );
    observed
}
/// A running database that has a role of its own, which CNPG and the first pass applied.
async fn with_report_job() -> World {
    let mut w = World::running().await;
    w.add_role(json!({"name":REPORT,"owner":false,"password":"q".repeat(43),"revision":3}));
    let observed = pass(&w).await;
    assert_eq!(observed["state"], "ready", "{observed}");
    w
}
fn roles(observed: &Value) -> Value {
    observed["roles"].clone()
}
fn log(w: &World) -> Vec<String> {
    w.log.lock().unwrap().clone()
}
/// The position of the first log line holding every needle, after the line at `after`.
fn at(w: &World, needles: &[&str], after: usize) -> usize {
    log(w)
        .iter()
        .enumerate()
        .position(|(index, line)| index >= after && needles.iter().all(|n| line.contains(n)))
        .unwrap_or_else(|| panic!("no log line with {needles:?} in {:#?}", log(w)))
}
fn held(w: &World, change: impl FnOnce(&mut RoleRow)) {
    change(w.sql.lock().unwrap().roles.get_mut(REPORT).unwrap());
}
/// The disabled role as the Cluster holds it, with the defaults of CNPG's CRD.
fn disabled() -> Value {
    json!({"name":REPORT,"ensure":"present","login":false,"inherit":true,"connectionLimit":-1})
}
/// The dropped role as the Cluster holds it, with the defaults of CNPG's CRD.
fn dropped() -> Value {
    json!({"name":REPORT,"ensure":"absent","inherit":true,"connectionLimit":-1})
}
fn secret(w: &World) -> Option<Value> {
    w.server
        .get("Secret", Some(&w.ns), &manifests::role_secret(REPORT))
}
/// Whether any committed write asked the Cluster to drop the role.
fn asked_to_drop(w: &World) -> bool {
    w.server
        .state
        .lock()
        .unwrap()
        .writes
        .iter()
        .any(|(_, path, body)| {
            path.ends_with("/clusters/database")
                && body["spec"]["managed"]["roles"]
                    .as_array()
                    .is_some_and(|roles| roles.iter().any(|role| role["ensure"] == "absent"))
        })
}

#[tokio::test]
async fn a_database_without_a_removal_reports_no_roles_and_reads_no_catalog() {
    let w = with_report_job().await;
    let observed = pass(&w).await;
    assert_eq!(observed["state"], "ready", "{observed}");
    assert!(observed.get("roles").is_none(), "{observed}");
    assert!(
        log(&w)
            .iter()
            .all(|line| !line.contains("role terminate") && !line.contains("role dependencies")),
        "{:#?}",
        log(&w)
    );
    assert!(secret(&w).is_some());
}

#[tokio::test]
async fn a_deleted_role_is_disabled_ended_dropped_and_only_then_reported_removed() {
    let mut w = with_report_job().await;
    held(&w, |role| role.sessions = 2);
    w.delete_role(REPORT);
    // Stage one: the Cluster disables the role. It is still there and can still log in.
    let first = pass(&w).await;
    assert_eq!(first["state"], "ready", "{first}");
    assert_eq!(roles(&first), json!({"removed":[],"blocked":[]}));
    assert_eq!(w.managed_role(REPORT), Some(disabled()));
    assert!(
        secret(&w).is_some(),
        "the credential stays until the role is gone"
    );
    assert!(
        log(&w).iter().all(|line| !line.contains("role terminate")),
        "no session is ended while the role can still log in"
    );
    // CNPG applied `login: false`: the sessions are ended with the role bound to the statement,
    // and only then does the Cluster ask for the drop.
    held(&w, |role| role.login = false);
    let before = log(&w).len();
    let second = pass(&w).await;
    assert_eq!(
        roles(&second),
        json!({"removed":[],"blocked":[]}),
        "{second}"
    );
    let ended = at(
        &w,
        &["SQL pgcf_maintenance role terminate report_job"],
        before,
    );
    let patched = at(
        &w,
        &["PATCH", "/clusters/database", r#""ensure":"absent""#],
        before,
    );
    assert!(ended < patched, "{:#?}", log(&w));
    assert_eq!(w.managed_role(REPORT), Some(dropped()));
    assert_eq!(w.sql.lock().unwrap().roles[REPORT].sessions, 0);
    assert!(secret(&w).is_some());
    // The Cluster names the role absent and PostgreSQL has not dropped it yet: still pending.
    let waiting = pass(&w).await;
    assert_eq!(roles(&waiting), json!({"removed":[],"blocked":[]}));
    // CNPG dropped it: the credential goes, and only now is the role reported removed.
    let uid = secret(&w).unwrap()["metadata"]["uid"].clone();
    w.sql.lock().unwrap().roles.remove(REPORT);
    let done = pass(&w).await;
    assert_eq!(
        roles(&done),
        json!({"removed":[REPORT],"blocked":[]}),
        "{done}"
    );
    assert!(secret(&w).is_none());
    // Like every delete of the controller: under the Secret's UID and version, in the background.
    let deletes: Vec<Value> = w
        .server
        .state
        .lock()
        .unwrap()
        .writes
        .iter()
        .filter(|(method, path, _)| {
            method == "DELETE" && path.ends_with(&format!("/{}", manifests::role_secret(REPORT)))
        })
        .map(|(_, _, body)| body.clone())
        .collect();
    assert_eq!(deletes.len(), 1, "{deletes:?}");
    assert_eq!(deletes[0]["propagationPolicy"], "Background");
    assert_eq!(deletes[0]["preconditions"]["uid"], uid);
    // The role is not asked back: later passes keep reporting it removed.
    assert_eq!(pass(&w).await["roles"]["removed"], json!([REPORT]));
    assert_eq!(w.managed_role(REPORT), Some(dropped()));
}

#[tokio::test]
async fn a_credential_the_database_does_not_own_is_not_deleted_and_the_role_stays_pending() {
    let mut w = with_report_job().await;
    held(&w, |role| role.login = false);
    w.delete_role(REPORT);
    pass(&w).await;
    w.sql.lock().unwrap().roles.remove(REPORT);
    // A Secret of the same name that another database owns: nothing here may delete it.
    w.server.edit(
        "Secret",
        Some(&w.ns),
        &manifests::role_secret(REPORT),
        |secret| {
            secret["metadata"]["labels"][LABEL] = "dcccccccccccccccccccc".into();
        },
    );
    let observed = pass(&w).await;
    assert_eq!(observed["state"], "ready", "{observed}");
    assert_eq!(roles(&observed), json!({"removed":[],"blocked":[]}));
    assert!(secret(&w).is_some());
    // Once it is the database's own again, the role is removed.
    w.server.edit(
        "Secret",
        Some(&w.ns),
        &manifests::role_secret(REPORT),
        |secret| {
            secret["metadata"]["labels"][LABEL] = w.id.clone().into();
        },
    );
    assert_eq!(pass(&w).await["roles"]["removed"], json!([REPORT]));
    assert!(secret(&w).is_none());
}

#[tokio::test]
async fn a_role_that_still_holds_objects_is_blocked_and_never_asked_to_be_dropped() {
    let mut w = with_report_job().await;
    held(&w, |role| {
        role.login = false;
        role.dependencies = 3;
    });
    w.delete_role(REPORT);
    let first = pass(&w).await;
    assert_eq!(
        roles(&first),
        json!({"removed":[],"blocked":[REPORT]}),
        "{first}"
    );
    assert_eq!(w.managed_role(REPORT), Some(disabled()));
    assert!(
        !asked_to_drop(&w),
        "a drop that cannot succeed is never asked of CNPG"
    );
    assert!(secret(&w).is_some());
    // The owner removes the objects: the same level-triggered pass drops the role after all.
    held(&w, |role| role.dependencies = 0);
    let next = pass(&w).await;
    assert_eq!(roles(&next), json!({"removed":[],"blocked":[]}));
    assert_eq!(w.managed_role(REPORT), Some(dropped()));
    w.sql.lock().unwrap().roles.remove(REPORT);
    assert_eq!(pass(&w).await["roles"]["removed"], json!([REPORT]));
}

#[tokio::test]
async fn a_drop_that_dependencies_made_fail_is_reported_blocked_and_proceeds_when_they_go() {
    let mut w = with_report_job().await;
    held(&w, |role| role.login = false);
    w.delete_role(REPORT);
    pass(&w).await;
    assert_eq!(w.managed_role(REPORT), Some(dropped()));
    // An object appeared before CNPG dropped the role: CNPG reports it cannot be dropped.
    held(&w, |role| role.dependencies = 1);
    w.server
        .edit("Cluster", Some(&w.ns), "database", |cluster| {
            cluster["status"]["managedRolesStatus"]["cannotReconcile"] =
                json!({REPORT:["role \"report_job\" cannot be dropped because some objects depend on it"]});
        });
    let blocked = pass(&w).await;
    assert_eq!(
        roles(&blocked),
        json!({"removed":[],"blocked":[REPORT]}),
        "{blocked}"
    );
    // Gone again: pending until CNPG's retry drops it, then removed.
    held(&w, |role| role.dependencies = 0);
    w.server
        .edit("Cluster", Some(&w.ns), "database", |cluster| {
            cluster["status"]["managedRolesStatus"]
                .as_object_mut()
                .unwrap()
                .remove("cannotReconcile");
        });
    assert_eq!(roles(&pass(&w).await), json!({"removed":[],"blocked":[]}));
    w.sql.lock().unwrap().roles.remove(REPORT);
    assert_eq!(
        roles(&pass(&w).await),
        json!({"removed":[REPORT],"blocked":[]})
    );
}

#[tokio::test]
async fn sessions_that_cannot_be_ended_or_have_not_left_keep_the_removal_pending() {
    let mut w = with_report_job().await;
    held(&w, |role| {
        role.login = false;
        role.sessions = 1;
    });
    w.delete_role(REPORT);
    // The maintenance role does not hold pg_signal_backend yet: PostgreSQL refuses.
    w.sql.lock().unwrap().signal_denied = true;
    let denied = pass(&w).await;
    assert_eq!(
        denied["state"], "ready",
        "readiness is not held for a removal: {denied}"
    );
    assert_eq!(roles(&denied), json!({"removed":[],"blocked":[]}));
    assert_eq!(w.managed_role(REPORT), Some(disabled()));
    // Granted, but the backend takes its time to leave.
    w.sql.lock().unwrap().signal_denied = false;
    w.sql.lock().unwrap().sessions_linger = true;
    assert_eq!(roles(&pass(&w).await), json!({"removed":[],"blocked":[]}));
    assert_eq!(w.managed_role(REPORT), Some(disabled()));
    assert!(!asked_to_drop(&w));
    // It left.
    w.sql.lock().unwrap().sessions_linger = false;
    held(&w, |role| role.sessions = 0);
    pass(&w).await;
    assert_eq!(w.managed_role(REPORT), Some(dropped()));
}

#[tokio::test]
async fn without_a_maintenance_credential_nothing_is_ended_and_the_removal_waits() {
    let mut w = with_report_job().await;
    held(&w, |role| {
        role.login = false;
        role.sessions = 1;
    });
    w.delete_role(REPORT);
    w.db.as_object_mut().unwrap().remove("maintenance");
    let observed = pass(&w).await;
    assert_eq!(observed["state"], "ready", "{observed}");
    assert_eq!(roles(&observed), json!({"removed":[],"blocked":[]}));
    assert!(log(&w).iter().all(|line| !line.contains("role terminate")));
    assert_eq!(w.managed_role(REPORT), Some(disabled()));
    assert_eq!(w.sql.lock().unwrap().roles[REPORT].sessions, 1);
}

#[tokio::test]
async fn a_role_postgresql_never_had_is_dropped_in_the_cluster_before_it_counts_as_removed() {
    // Created and deleted while the database slept: PostgreSQL has no such role, but the Cluster
    // it is applied to would create it as a disabled role if it were left in that stage.
    let mut w = World::running().await;
    w.db["roles"]
        .as_array_mut()
        .unwrap()
        .push(json!({"name":REPORT,"state":"absent"}));
    w.db["generation"] = 3.into();
    let first = pass(&w).await;
    assert_eq!(first["state"], "ready", "{first}");
    assert_eq!(roles(&first), json!({"removed":[],"blocked":[]}), "{first}");
    assert_eq!(w.managed_role(REPORT), Some(dropped()));
    let second = pass(&w).await;
    assert_eq!(
        roles(&second),
        json!({"removed":[REPORT],"blocked":[]}),
        "{second}"
    );
}

#[tokio::test]
async fn the_stage_of_a_removal_is_what_the_cluster_says_across_generations_and_restarts() {
    let mut w = with_report_job().await;
    held(&w, |role| role.login = false);
    w.delete_role(REPORT);
    pass(&w).await;
    assert_eq!(w.managed_role(REPORT), Some(dropped()));
    // A later generation of the record, read by a controller that remembers nothing.
    w.db["generation"] = (w.db["generation"].as_u64().unwrap() + 1).into();
    w.reconciler = Reconciler::new(
        w.server.k8s.clone(),
        crate::test_world::kube_system(),
        crate::test_world::IMAGE.into(),
        "eu-test".into(),
        1,
    )
    .unwrap();
    w.reconciler.power.http = w.gateway.client.clone();
    w.reconciler.http = w.gateway.client.clone();
    w.reconciler.power.postgres = w.postgres.as_ref().map(|postgres| postgres.address);
    let observed = pass(&w).await;
    assert_eq!(observed["state"], "ready", "{observed}");
    assert_eq!(
        w.managed_role(REPORT),
        Some(dropped()),
        "the drop is not undone by a new generation"
    );
}
