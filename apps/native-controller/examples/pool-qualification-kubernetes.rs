// SPDX-License-Identifier: Apache-2.0
//! Actual isolated API proof; no kubelet, driver denial, physical LV or qualification receipt claim.
//! CRDs are the unmodified JSON projection of openebs/lvm-localpv e8a234cbfeef5fa16fde1330c8de2d91e31831f1 deploy/yamls (Apache-2.0).
use pgcf_native_controller::{
    Error,
    kubernetes::Kubernetes,
    pool_qualification::{snapshot_disposable, snapshot_manifest},
};
use reqwest::{Client, Url};
use serde_json::{Value, json};
use std::{path::PathBuf, time::Duration};
async fn run() -> Result<(), Error> {
    let origin = Url::parse(&std::env::var("PGCF_POOL_TEST_ORIGIN")?)?;
    if !origin.host_str().is_some_and(|h| {
        h.strip_prefix("pgcf-pool-api-")
            .is_some_and(|s| s.len() == 32 && s.bytes().all(|b| b.is_ascii_hexdigit()))
    }) {
        return Err("isolated fixture required".into());
    }
    let ca = tokio::fs::read(std::env::var("PGCF_POOL_TEST_CA")?).await?;
    let token_path = PathBuf::from(std::env::var("PGCF_POOL_TEST_TOKEN")?);
    let token = tokio::fs::read_to_string(&token_path).await?;
    let kube = Kubernetes::with_ca(origin.clone(), &ca, token_path)?;
    let client = Client::builder()
        .tls_certs_only([reqwest::Certificate::from_pem(&ca)?])
        .retry(reqwest::retry::never())
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(10))
        .build()?;
    for raw in [
        include_str!("../tests/fixtures/lvmvolume-crd.json"),
        include_str!("../tests/fixtures/lvmsnapshot-crd.json"),
    ] {
        let crd: Value = serde_json::from_str(raw)?;
        let response = client
            .post(origin.join("/apis/apiextensions.k8s.io/v1/customresourcedefinitions")?)
            .bearer_auth(token.trim())
            .json(&crd)
            .send()
            .await?;
        if !response.status().is_success() && response.status() != reqwest::StatusCode::CONFLICT {
            return Err("isolated CRD creation refused".into());
        }
        let url = origin.join(&format!(
            "/apis/apiextensions.k8s.io/v1/customresourcedefinitions/{}",
            crd["metadata"]["name"].as_str().unwrap()
        ))?;
        let until = tokio::time::Instant::now() + Duration::from_secs(10);
        loop {
            let current: Value = client
                .get(url.clone())
                .bearer_auth(token.trim())
                .send()
                .await?
                .json()
                .await?;
            if current["status"]["conditions"].as_array().is_some_and(|c| {
                c.iter()
                    .any(|x| x["type"] == "Established" && x["status"] == "True")
            }) {
                break;
            }
            if tokio::time::Instant::now() >= until {
                return Err("isolated CRD establishment missing".into());
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }
    let namespace = kube
        .create(&json!({"apiVersion":"v1","kind":"Namespace","metadata":{"name":"openebs"}}))
        .await?;
    let uid = namespace["metadata"]["uid"]
        .as_str()
        .ok_or("isolated namespace identity missing")?;
    let mut scope =
        pgcf_native_protocol::qualification::CONTRACT["fixture"]["claims"]["scope"].clone();
    scope["run_id"] = uid.into();
    let q = json!({"scope_sha256":pgcf_native_protocol::qualification::scope_hash(&scope).unwrap(),"scope":scope});
    let volume=kube.create(&json!({"apiVersion":"local.openebs.io/v1alpha1","kind":"LVMVolume","metadata":{"name":q["scope"]["volume"]["volume_handle"],"namespace":"openebs"},"spec":{"ownerNodeID":"isolated-owned-node","capacity":"1073741824","volGroup":"owned-fixture","vgPattern":"owned-fixture","thinProvision":"yes"},"status":{"state":"Ready"}})).await?;
    let manifest = snapshot_manifest(&q, &volume)?;
    let snapshot = kube.create(&manifest).await?;
    let id = snapshot["metadata"]["uid"]
        .as_str()
        .ok_or("isolated snapshot identity missing")?;
    assert!(snapshot_disposable(&q, &snapshot, id));
    assert!(snapshot["metadata"]["finalizers"].is_null());
    assert_eq!(snapshot["status"]["state"], "Pending");
    let changed = kube
        .patch(
            &snapshot,
            &json!({"metadata":{"annotations":{"pgcf.test/actual-cas":"changed"}}}),
        )
        .await?;
    assert!(kube.delete(&snapshot, "Background").await.is_err());
    kube.delete(&changed, "Background").await?;
    assert!(
        kube.read(
            "LVMSnapshot",
            Some("openebs"),
            manifest["metadata"]["name"].as_str().unwrap()
        )
        .await?
        .is_none()
    );
    let replacement = kube.create(&manifest).await?;
    assert_ne!(replacement["metadata"]["uid"], snapshot["metadata"]["uid"]);
    assert!(kube.delete(&changed, "Background").await.is_err());
    let finalized = kube
        .patch(
            &replacement,
            &json!({"metadata":{"finalizers":["local.openebs.io/finalizer"]}}),
        )
        .await?;
    assert!(!snapshot_disposable(
        &q,
        &finalized,
        finalized["metadata"]["uid"].as_str().unwrap()
    ));
    // No finalizer removal: deleting the owned isolated API fixture cleans this retained object.
    println!(
        "{}",
        json!({"actual_pending_snapshot_no_finalizers":true,"actual_uid_rv_delete_conflicts_refused":true,"unexpected_finalizer_retained":true,"physical_snapshot_absence_claimed":false,"qualification_receipt_claimed":false})
    );
    Ok(())
}
#[tokio::main]
async fn main() {
    if run().await.is_err() {
        eprintln!(
            "{}",
            json!({"check":"isolated_finite_qualification_api_failed","passed":false})
        );
        std::process::exit(1);
    }
}
