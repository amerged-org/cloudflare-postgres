// SPDX-License-Identifier: Apache-2.0
//! What a running admitted database publishes for the gateway's v4 route checks, against the
//! in-process doubles.
use super::{SYSTEM, *};
use crate::test_world::*;

/// Passes over the database until one is ready on a v2 attestation. The first ready pass of a
/// fence it creates binds that fence in the storage receipt, a resource its proof names, and so
/// publishes nothing; the pass after it publishes.
async fn attested(w: &World) -> Value {
    for _ in 0..2 {
        if let Ok(Some(observed)) = w.reconciler.reconcile(&w.db, &w.snapshot).await
            && observed["state"] == "ready"
            && observed["runtime_attestation"]["v"] == 2
        {
            return observed;
        }
    }
    panic!("no attested ready pass");
}
/// The target the gateway routes the running revision by, as the fence publishes it.
fn published_target(w: &World) -> Value {
    let fence = w
        .server
        .get(
            "ConfigMap",
            Some(SYSTEM),
            &format!("gateway-fence-{}", w.id),
        )
        .unwrap();
    serde_json::from_str(text(&fence["data"], "admission_target")).unwrap()
}
/// The CA Secret the CA publication names, as the gateway reads it: its UID and its version.
fn published_authority(w: &World) -> (Value, Value) {
    let map = w
        .server
        .get("ConfigMap", Some(SYSTEM), &format!("ca-{}", w.id))
        .unwrap();
    let annotations = &map["metadata"]["annotations"];
    (
        annotations["pgcf.io/source-ca-secret-uid"].clone(),
        annotations["pgcf.io/source-ca-secret-resource-version"].clone(),
    )
}

#[tokio::test]
async fn the_ca_publication_names_the_authority_of_the_published_target() {
    // The gateway admits a v4 route only when the TLS authority it reads from the CA publication
    // is the one the fence's target names: the source Secret's UID and version are annotated on
    // `ca-<db>`. Without them every v4 route is refused as stale.
    let mut w = World::running().await;
    w.admitted();
    // A new database: nothing is published for its authority yet.
    {
        let mut state = w.server.state.lock().unwrap();
        state.objects.remove(&crate::test_server::path(
            "ConfigMap",
            Some(SYSTEM),
            &format!("ca-{}", w.id),
        ));
        state.sync();
    }
    attested(&w).await;
    let target = published_target(&w);
    assert_eq!(
        published_authority(&w),
        (
            target["ca_secret_uid"].clone(),
            target["ca_secret_resource_version"].clone()
        )
    );
    // CNPG writes the CA Secret again: the publication and the target follow it together.
    w.server
        .external_write("Secret", Some(&w.ns), "database-ca", |secret| {
            secret["metadata"]["labels"] = json!({"cnpg.io/reload":"true"});
        });
    let secret = w.server.get("Secret", Some(&w.ns), "database-ca").unwrap();
    attested(&w).await;
    let target = published_target(&w);
    assert_eq!(
        target["ca_secret_resource_version"],
        secret["metadata"]["resourceVersion"]
    );
    assert_eq!(
        published_authority(&w),
        (
            target["ca_secret_uid"].clone(),
            target["ca_secret_resource_version"].clone()
        )
    );
}
