// SPDX-License-Identifier: Apache-2.0
use super::{
    Phase,
    power::{Slept, Why},
    testing::{Rig, eventually},
};
use crate::{machine::Machine, postgres, state::DatabaseState, storage::VolumeId};
use serde_json::{Value, json};

async fn tenant(rig: &Rig, id: &str) -> postgres::Session {
    postgres::connect(&rig.machine.layout().socket_directory(id), "postgres", id)
        .await
        .unwrap()
}

async fn source(rig: &Rig) -> (Value, DatabaseState, String) {
    let mut db = rig.entry_json();
    let (entry, handle) = rig.create_from(&db).await;
    db.as_object_mut().unwrap().remove("origin");
    let session = tenant(rig, &entry.id).await;
    session.batch("CREATE TABLE replacement_marker (id int PRIMARY KEY); INSERT INTO replacement_marker VALUES (1)").await.unwrap();
    // The selected time lies between two committed writes, on the database server's clock.
    session.batch("SELECT pg_sleep(0.005)").await.unwrap();
    let point: String = session.query("SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')", &[]).await.unwrap()[0].get(0);
    session
        .batch("INSERT INTO replacement_marker VALUES (2)")
        .await
        .unwrap();
    drop(session);
    assert_eq!(rig.core.sleep(&handle, Why::Idle).await, Slept::Proven);
    (db, handle.state().unwrap(), point)
}

fn replace(rig: &Rig, source: &Value, state: &DatabaseState, point: &str) -> Value {
    let mut target = source.clone();
    let id = target["id"].as_str().unwrap().to_string();
    target["generation"] = json!(10);
    target["storage_generation"] = json!(2);
    target["operation"] = json!("op_rrrrrrrrrrrrrrrrrrrr");
    target["archive"]["path"] = json!(format!(
        "s3://pgcf-eu/eu-dev/{id}/g2-op_rrrrrrrrrrrrrrrrrrrr"
    ));
    target["origin"] = json!({"kind":"replace", "source": {
        "database_id":id, "path":source["archive"]["path"],
        "backup_id":state.backup.as_ref().unwrap().backup_id,"target_time":point,
        "credential":{"id":"crd_rrrrrrrrrrrrrrrrrrrr","expires_at":"2099-01-01T00:00:00.000Z"}
    },"previous":{"storage_generation":1,"end":state.record}});
    credentials(rig, &target);
    target
}

fn credentials(rig: &Rig, target: &Value) {
    rig.deliver(
        target["origin"]["source"]["path"].as_str().unwrap(),
        "read_only",
    );
    rig.deliver(target["archive"]["path"].as_str().unwrap(), "read_write");
}

fn rollback(source: &Value, state: &DatabaseState, target: &Value) -> Value {
    let mut rollback = target.clone();
    let id = source["id"].as_str().unwrap();
    rollback["generation"] = json!(11);
    rollback["storage_generation"] = json!(3);
    rollback["archive"]["path"] = json!(format!(
        "s3://pgcf-eu/eu-dev/{id}/g3-op_rrrrrrrrrrrrrrrrrrrr"
    ));
    rollback["origin"] = json!({"kind":"replace_rollback","source":{
        "database_id":id,"path":source["archive"]["path"],"backup_id":state.backup.as_ref().unwrap().backup_id,
        "credential":{"id":"crd_rrrrrrrrrrrrrrrrrrrr","expires_at":"2099-01-01T00:00:00.000Z"}},
        "previous":{"storage_generation":1,"end":state.record},"replacement_generation":2});
    rollback
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn reviewed_rollback_bootstraps_its_source_journal_after_the_first_journal_write_failed() {
    let Some(rig) = Rig::new("replace-journal-io").await else {
        return;
    };
    let (source, state, point) = source(&rig).await;
    let target = replace(&rig, &source, &state, &point);
    let id = source["id"].as_str().unwrap();
    let partial = rig
        .core
        .files(id)
        .directory()
        .join("replacement.json.partial");
    std::fs::create_dir(&partial).unwrap();
    assert!(
        rig.core
            .prepare_replacement(&rig.entry_for(&target))
            .await
            .is_err()
    );
    assert!(rig.core.files(id).load_replacement().unwrap().is_none());
    assert_eq!(rig.core.files(id).load().unwrap(), Some(state.clone()));
    std::fs::remove_dir(&partial).unwrap();
    let rollback = rollback(&source, &state, &target);
    rig.core
        .prepare_replacement(&rig.entry_for(&rollback))
        .await
        .unwrap();
    assert!(
        rig.core.files(id).load_replacement().unwrap().is_some(),
        "rollback must journal the source even if the first journal write failed"
    );
    assert!(rig.core.replacement_rollback(&rig.entry_for(&rollback)));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn reviewed_rollback_stops_the_failed_target_left_running_before_releasing_its_volume() {
    let Some(rig) = Rig::new("replace-interrupted-failure").await else {
        return;
    };
    let (source, state, point) = source(&rig).await;
    let target = replace(&rig, &source, &state, &point);
    let id = source["id"].as_str().unwrap().to_string();
    ready(&rig, &target).await;
    let mut journal = rig.core.files(&id).load_replacement().unwrap().unwrap();
    journal.attempt.failed = true;
    rig.core.files(&id).save_replacement(&journal).unwrap();
    let rig = rig.restart().await;
    assert!(rig.machine.running(&id));
    let rollback = rollback(&source, &state, &target);
    credentials(&rig, &rollback);
    let entry = rig.entry_for(&rollback);
    rig.core.prepare_replacement(&entry).await.unwrap();
    assert!(
        !rig.machine.running(&id),
        "the journal-owned failed target must stop before release"
    );
    assert!(rig.core.release_previous_generation(&entry).await);
    assert!(
        rig.machine
            .has_volume(&VolumeId::new(&id, 1).unwrap())
            .await
            .unwrap()
    );
    ready(&rig, &rollback).await;
    let session = tenant(&rig, &id).await;
    assert_eq!(
        session
            .query("SELECT count(*) FROM replacement_marker", &[])
            .await
            .unwrap()[0]
            .get::<_, i64>(0),
        2
    );
    drop(session);
    assert_eq!(
        rig.machine.volumes().len(),
        3,
        "source and staged failure remain until the backed-up rollback is accepted"
    );
    let mut promoted = rollback;
    promoted.as_object_mut().unwrap().remove("origin");
    rig.core
        .apply(&Rig::page(
            vec![promoted],
            vec![crate::link::Order::Superseded {
                operation: "op_ssssssssssssssssssss".into(),
                database: id.clone(),
                storage_generation: 2,
                remove_volume: true,
            }],
        ))
        .await;
    eventually(
        30,
        "rollback cleanup through its failed staged generation",
        || rig.core.pending_order("op_ssssssssssssssssssss").is_some(),
    )
    .await;
    assert_eq!(rig.machine.volumes().len(), 1);
    assert_eq!(rig.machine.volumes()[0].0.generation(), 3);
    assert!(rig.core.files(&id).load_replacement().unwrap().is_none());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn reviewed_a_built_replacement_does_not_adopt_tampered_origin_metadata_after_restart() {
    let Some(rig) = Rig::new("replace-adoption-identity").await else {
        return;
    };
    let (source, state, point) = source(&rig).await;
    let mut target = replace(&rig, &source, &state, &point);
    let id = source["id"].as_str().unwrap().to_string();
    ready(&rig, &target).await;
    let rig = rig.restart().await;
    target["origin"]["source"]["target_time"] = json!("2020-01-01T00:00:00.000Z");
    credentials(&rig, &target);
    let handle = rig.core.db(&id);
    rig.core.apply(&Rig::page(vec![target], vec![])).await;
    eventually(30, "the restored generation's identity check", || {
        handle.view().adopted
    })
    .await;
    assert_eq!(
        handle.phase(),
        Phase::Error,
        "a built volume is not proof of the requested restore point"
    );
}

async fn ready(rig: &Rig, target: &Value) {
    let id = target["id"].as_str().unwrap();
    let handle = rig.core.db(id);
    rig.core.set(&handle, |view| {
        view.moving = Some("op_rrrrrrrrrrrrrrrrrrrr".into())
    });
    rig.core
        .apply(&Rig::page(vec![target.clone()], vec![]))
        .await;
    eventually(120, "the replacement to finish", || {
        matches!(handle.phase(), Phase::Ready | Phase::Error)
    })
    .await;
    assert_eq!(
        handle.phase(),
        Phase::Ready,
        "{:?} {:?}",
        handle.view().error,
        rig.machine.calls()
    );
    let state = handle.state().unwrap();
    assert!(state.built && state.backup.is_some());
    assert!(
        handle.view().moving.is_none(),
        "cutover has no stale source move hold"
    );
    assert_eq!(
        state.storage_generation,
        target["storage_generation"].as_u64().unwrap()
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn replacement_keeps_identity_and_a_selected_commit_through_restarts_and_retains_source_until_cleanup()
 {
    let Some(rig) = Rig::new("replace-restarts").await else {
        return;
    };
    let (source, source_state, point) = source(&rig).await;
    let target = replace(&rig, &source, &source_state, &point);
    let id = target["id"].as_str().unwrap().to_string();
    let entry = rig.entry_for(&target);

    // Crash after the journal and source detach, just after the active state was replaced but
    // before any target volume exists. The original source state lives durably in the journal.
    rig.core.prepare_replacement(&entry).await.unwrap();
    assert!(rig.core.release_previous_generation(&entry).await);
    rig.core.files(&id).save(&DatabaseState::new(2)).unwrap();
    let rig = rig.restart().await;
    credentials(&rig, &target);
    ready(&rig, &target).await;
    let own_backup = rig.core.db(&id).state().unwrap().backup.unwrap();
    assert_eq!(rig.machine.volumes().len(), 2);
    assert_eq!(
        rig.core
            .files(&id)
            .load_replacement()
            .unwrap()
            .unwrap()
            .source,
        source_state
    );
    let session = tenant(&rig, &id).await;
    assert_eq!(
        session
            .query("SELECT count(*) FROM replacement_marker", &[])
            .await
            .unwrap()[0]
            .get::<_, i64>(0),
        1
    );
    drop(session);
    // Both original credentials still log in at exactly the same socket and database name.
    for (role, password) in [
        ("app", crate::testpg::password(1)),
        ("reader", crate::testpg::password(2)),
    ] {
        let mut config = tokio_postgres::Config::new();
        config
            .host_path(rig.machine.layout().socket_directory(&id))
            .port(crate::layout::PORT)
            .user(role)
            .password(password)
            .dbname(&id);
        let (client, connection) = config.connect(tokio_postgres::NoTls).await.unwrap();
        let task = tokio::spawn(connection);
        client.simple_query("SELECT 1").await.unwrap();
        drop(client);
        task.abort();
    }

    // Crash after the first DONE backup, before the built-state fsync: resume the same target,
    // which already has its backup, without recreating the original or producing a second one.
    rig.core.files(&id).save(&DatabaseState::new(2)).unwrap();
    let rig = rig.restart().await;
    credentials(&rig, &target);
    ready(&rig, &target).await;
    assert_eq!(
        rig.core.db(&id).state().unwrap().backup.unwrap(),
        own_backup
    );
    assert_eq!(rig.machine.volumes().len(), 2);
    let cleanup = crate::link::Order::Superseded {
        operation: "op_ssssssssssssssssssss".into(),
        database: id.clone(),
        storage_generation: 1,
        remove_volume: true,
    };
    let mut promoted = target;
    promoted.as_object_mut().unwrap().remove("origin");
    rig.core
        .apply(&Rig::page(vec![promoted], vec![cleanup]))
        .await;
    eventually(30, "the accepted source cleanup", || {
        rig.core.pending_order("op_ssssssssssssssssssss").is_some()
    })
    .await;
    assert!(rig.core.files(&id).load_replacement().unwrap().is_none());
    assert_eq!(rig.machine.volumes().len(), 1);
    assert_eq!(rig.machine.volumes()[0].0.generation(), 2);
    assert_eq!(rig.core.db(&id).phase(), Phase::Ready);
    // Cleanup is local; the archive lineage remains available for its retention period.
    assert!(
        rig.fixture
            .store_directory()
            .join(format!(
                "objects/{}",
                source["archive"]["path"]
                    .as_str()
                    .unwrap()
                    .strip_prefix("s3://")
                    .unwrap()
            ))
            .exists()
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_failed_replacement_preserves_source_across_restart_and_rollback_retries_r2_outage_at_a_higher_generation()
 {
    let Some(rig) = Rig::new("replace-rollback").await else {
        return;
    };
    let (source, source_state, point) = source(&rig).await;
    let target = replace(&rig, &source, &source_state, &point);
    let id = target["id"].as_str().unwrap().to_string();
    let handle = rig.core.db(&id);
    rig.fixture.set("restore-fail", "");
    rig.core
        .apply(&Rig::page(vec![target.clone()], vec![]))
        .await;
    eventually(60, "the target failure", || handle.phase() == Phase::Error).await;
    let journal = rig.core.files(&id).load_replacement().unwrap().unwrap();
    assert!(journal.attempt.failed);
    assert_eq!(journal.source, source_state);
    assert!(rig.core.files(&id).upload_log(1).path().exists());
    assert!(!rig.core.replacement_cleanup_ready(&id, 1));
    assert_eq!(
        rig.machine
            .volumes()
            .iter()
            .map(|(v, _)| v.generation())
            .collect::<Vec<_>>(),
        [1]
    );

    let rig = rig.restart().await;
    credentials(&rig, &target);
    let handle = rig.core.db(&id);
    rig.core
        .apply(&Rig::page(vec![target.clone()], vec![]))
        .await;
    eventually(30, "the persisted failure", || {
        handle.phase() == Phase::Error
    })
    .await;
    assert!(!rig.machine.running(&id));
    // Even a stale source page after a restart cannot re-open the original generation.
    assert!(
        rig.core
            .replacement_blocks(&handle, &rig.entry_for(&source))
    );

    let rollback = rollback(&source, &source_state, &target);
    credentials(&rig, &rollback);
    let removals = || {
        rig.machine
            .calls()
            .iter()
            .filter(|call| **call == format!("remove {id}"))
            .count()
    };
    let before_rollback = removals();
    rig.core
        .apply(&Rig::page(vec![rollback.clone()], vec![]))
        .await;
    eventually(60, "rollback to record its forward generation", || {
        rig.core
            .files(&id)
            .load_replacement()
            .ok()
            .flatten()
            .is_some_and(|j| j.attempt.generation == 3)
            && handle.phase() == Phase::Error
            && removals() > before_rollback
    })
    .await;
    assert!(
        rig.machine
            .has_volume(&VolumeId::new(&id, 1).unwrap())
            .await
            .unwrap()
    );
    assert!(
        !rig.core
            .files(&id)
            .load_replacement()
            .unwrap()
            .unwrap()
            .attempt
            .failed
    );
    // The same generation and operation recover once the archive answers; no new request and
    // no downgrade or local-volume alias is needed.
    rig.fixture.clear("restore-fail");
    eventually(120, "rollback retry after the archive recovers", || {
        handle.phase() == Phase::Ready
    })
    .await;
    assert_eq!(handle.state().unwrap().storage_generation, 3);
    let session = tenant(&rig, &id).await;
    assert_eq!(
        session
            .query("SELECT count(*) FROM replacement_marker", &[])
            .await
            .unwrap()[0]
            .get::<_, i64>(0),
        2
    );
    assert!(rig.core.replacement_cleanup_ready(&id, 1));
    assert!(
        rig.machine
            .has_volume(&VolumeId::new(&id, 1).unwrap())
            .await
            .unwrap()
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn replacement_rejects_a_changed_proof_an_active_source_and_different_replay_metadata() {
    let Some(rig) = Rig::new("replace-guard").await else {
        return;
    };
    let (source, state, point) = source(&rig).await;
    let target = replace(&rig, &source, &state, &point);
    let id = target["id"].as_str().unwrap();
    let mut wrong = target.clone();
    wrong["origin"]["previous"]["end"]["checkpoint_lsn"] = json!("0/1");
    assert!(
        rig.core
            .prepare_replacement(&rig.entry_for(&wrong))
            .await
            .is_err()
    );
    assert_eq!(rig.core.files(id).load().unwrap(), Some(state.clone()));
    assert!(rig.core.files(id).load_replacement().unwrap().is_none());
    rig.core
        .prepare_replacement(&rig.entry_for(&target))
        .await
        .unwrap();
    wrong = target.clone();
    wrong["origin"]["source"]["backup_id"] = json!("20200101T000000");
    assert!(
        rig.core
            .prepare_replacement(&rig.entry_for(&wrong))
            .await
            .is_err()
    );
    rig.machine.start(id).await.unwrap();
    assert!(
        rig.core
            .prepare_replacement(&rig.entry_for(&target))
            .await
            .is_err()
    );
    assert!(
        rig.machine.running(id),
        "the replacement does not stop an unproven source"
    );
    assert_eq!(rig.machine.volumes().len(), 1);
}
