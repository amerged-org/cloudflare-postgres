// SPDX-License-Identifier: Apache-2.0
//! Run only against tests/run-kubernetes.py's isolated actual API, never a Dev/customer cluster.
//! It proves the API-server semantics the parked sleep tier relies on and that need no kubelet
//! or CNPG: annotation merge-patch removal of the instance fence under a CAS, and the Pod
//! `resize` subresource (strategic merge, UID precondition, requests only). The Cluster kind is
//! a minimal stand-in CRD that keeps unknown fields; the real CNPG operator is not run here.
use pgcf_native_controller::{Error, kubernetes::Kubernetes};
use reqwest::{Client, StatusCode, Url};
use serde_json::{Value, json};
use std::{path::PathBuf, time::Duration};

const FENCE: &str = "cnpg.io/fencedInstances";
const HIBERNATION: &str = "cnpg.io/hibernation";

async fn run() -> Result<Value, Error> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let origin = Url::parse(&std::env::var("PGCF_POOL_TEST_ORIGIN")?)?;
    let host = origin.host_str().ok_or("isolated API host missing")?;
    if !host.strip_prefix("pgcf-pool-api-").is_some_and(|suffix| {
        suffix.len() == 32 && suffix.bytes().all(|byte| byte.is_ascii_hexdigit())
    }) {
        return Err("isolated fixture host required".into());
    }
    let ca = tokio::fs::read(std::env::var("PGCF_POOL_TEST_CA")?).await?;
    let token_path = PathBuf::from(std::env::var("PGCF_POOL_TEST_TOKEN")?);
    let token = tokio::fs::read_to_string(&token_path).await?;
    let k8s = Kubernetes::with_ca(origin.clone(), &ca, token_path)?;
    let client = Client::builder()
        .tls_certs_only([reqwest::Certificate::from_pem(&ca)?])
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(10))
        .build()?;
    let attempt = std::env::var("PGCF_POOL_TEST_ATTEMPT")?;
    if attempt.len() != 32 || !attempt.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("isolated attempt identity invalid".into());
    }
    let namespace = format!("pgcf-db-a{}", &attempt[..19]);
    k8s.create(&json!({"apiVersion":"v1","kind":"Namespace","metadata":{"name":namespace}}))
        .await?;
    // A minimal stand-in for CNPG's Cluster kind.
    let crd = json!({"apiVersion":"apiextensions.k8s.io/v1","kind":"CustomResourceDefinition","metadata":{"name":"clusters.postgresql.cnpg.io"},"spec":{"group":"postgresql.cnpg.io","names":{"kind":"Cluster","listKind":"ClusterList","plural":"clusters","singular":"cluster"},"scope":"Namespaced","versions":[{"name":"v1","served":true,"storage":true,"subresources":{"status":{}},"schema":{"openAPIV3Schema":{"type":"object","x-kubernetes-preserve-unknown-fields":true}}}]}});
    let response = client
        .post(origin.join("/apis/apiextensions.k8s.io/v1/customresourcedefinitions")?)
        .bearer_auth(token.trim())
        .json(&crd)
        .send()
        .await?;
    if !response.status().is_success() && response.status() != StatusCode::CONFLICT {
        return Err("isolated CRD creation refused".into());
    }
    let url = origin.join(
        "/apis/apiextensions.k8s.io/v1/customresourcedefinitions/clusters.postgresql.cnpg.io",
    )?;
    let until = tokio::time::Instant::now() + Duration::from_secs(20);
    loop {
        let current: Value = client
            .get(url.clone())
            .bearer_auth(token.trim())
            .send()
            .await?
            .json()
            .await?;
        if current["status"]["conditions"]
            .as_array()
            .is_some_and(|all| {
                all.iter()
                    .any(|c| c["type"] == "Established" && c["status"] == "True")
            })
        {
            break;
        }
        if tokio::time::Instant::now() >= until {
            return Err("isolated CRD establishment missing".into());
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    // 1. The fence: set under a CAS, removed by a null in one patch with another annotation.
    let cluster = k8s
        .create(&json!({"apiVersion":"postgresql.cnpg.io/v1","kind":"Cluster","metadata":{"name":"database","namespace":namespace},"spec":{"instances":1}}))
        .await?;
    let fenced = k8s
        .patch(
            &cluster,
            &json!({"metadata":{"annotations":{FENCE:"[\"*\"]","pgcf.io/power-revision":"2"}}}),
        )
        .await?;
    assert_eq!(fenced["metadata"]["annotations"][FENCE], "[\"*\"]");
    assert!(
        k8s.patch(
            &cluster,
            &json!({"metadata":{"annotations":{FENCE:Value::Null}}})
        )
        .await
        .is_err(),
        "a stale resourceVersion never lifts the fence"
    );
    let released = k8s
        .patch(
            &fenced,
            &json!({"metadata":{"annotations":{FENCE:Value::Null,HIBERNATION:"off"}}}),
        )
        .await?;
    assert!(released["metadata"]["annotations"].get(FENCE).is_none());
    assert_eq!(released["metadata"]["annotations"][HIBERNATION], "off");
    assert_eq!(
        released["metadata"]["annotations"]["pgcf.io/power-revision"],
        "2"
    );
    // 2. The Pod resize subresource.
    let account = client
        .post(origin.join(&format!("/api/v1/namespaces/{namespace}/serviceaccounts"))?)
        .bearer_auth(token.trim())
        .json(&json!({"apiVersion":"v1","kind":"ServiceAccount","metadata":{"name":"default"},"automountServiceAccountToken":false}))
        .send()
        .await?;
    if !account.status().is_success() && account.status() != StatusCode::CONFLICT {
        return Err("isolated ServiceAccount fixture failed".into());
    }
    // The resize is admitted against the node the Pod runs on, which the API server must know.
    let node = format!("isolated-{}", &attempt[..16]);
    let created = k8s
        .create(&json!({"apiVersion":"v1","kind":"Node","metadata":{"name":node}}))
        .await?;
    let capacity = json!({"cpu":"4","memory":"8Gi","pods":"110","ephemeral-storage":"20Gi"});
    let status = client
        .patch(origin.join(&format!("/api/v1/nodes/{node}/status"))?)
        .bearer_auth(token.trim())
        .header("Content-Type", "application/merge-patch+json")
        .json(&json!({"metadata":{"resourceVersion":created["metadata"]["resourceVersion"]},"status":{"capacity":capacity,"allocatable":capacity,"conditions":[{"type":"Ready","status":"True","lastHeartbeatTime":"2026-10-13T00:00:00Z","lastTransitionTime":"2026-10-13T00:00:00Z"}]}}))
        .send()
        .await?;
    if !status.status().is_success() {
        return Err("isolated Node status fixture failed".into());
    }
    let image = "registry.test/instance@sha256:0000000000000000000000000000000000000000000000000000000000000000";
    let limits = json!({"cpu":"250m","memory":"256Mi"});
    let pod = k8s
        .create(&json!({"apiVersion":"v1","kind":"Pod","metadata":{"name":"database-1","namespace":namespace},
            "spec":{"nodeName":node,"automountServiceAccountToken":false,
                "containers":[{"name":"postgres","image":image,"resources":{"requests":{"cpu":"25m","memory":"128Mi"},"limits":limits}}],
                "initContainers":[
                    {"name":"bootstrap-controller","image":image,"resources":{"requests":{"cpu":"25m","memory":"128Mi"},"limits":limits}},
                    {"name":"plugin-barman-cloud","image":image,"restartPolicy":"Always","resources":{"requests":{"cpu":"100m","memory":"128Mi"},"limits":{"cpu":"500m","memory":"512Mi"}}}]}}))
        .await?;
    let qos = pod["status"]["qosClass"].clone();
    let resized = k8s
        .resize_pod(
            &pod,
            &[("postgres", json!({"cpu":"10m","memory":"96Mi"}))],
            &[("plugin-barman-cloud", json!({"cpu":"5m","memory":"64Mi"}))],
        )
        .await
        .map_err(|_| "isolated Pod resize refused")?;
    assert_eq!(resized["metadata"]["uid"], pod["metadata"]["uid"]);
    assert_eq!(
        resized["spec"]["containers"][0]["resources"]["requests"],
        json!({"cpu":"10m","memory":"96Mi"})
    );
    assert_eq!(
        resized["spec"]["containers"][0]["resources"]["limits"],
        limits
    );
    assert_eq!(
        resized["spec"]["initContainers"][1]["resources"]["requests"],
        json!({"cpu":"5m","memory":"64Mi"})
    );
    assert_eq!(
        resized["spec"]["initContainers"][1]["resources"]["limits"],
        json!({"cpu":"500m","memory":"512Mi"})
    );
    assert_eq!(
        resized["spec"]["initContainers"][0]["resources"]["requests"],
        json!({"cpu":"25m","memory":"128Mi"}),
        "the regular init container keeps the Cluster's requests"
    );
    assert_eq!(resized["status"]["qosClass"], qos);
    // A JSON merge patch would replace the container lists and drop what the patch omits.
    let pod_url = origin.join(&format!(
        "/api/v1/namespaces/{namespace}/pods/database-1/resize"
    ))?;
    let merge = client
        .patch(pod_url.clone())
        .bearer_auth(token.trim())
        .header("Content-Type", "application/merge-patch+json")
        .json(&json!({"metadata":{"uid":pod["metadata"]["uid"]},"spec":{"containers":[{"name":"postgres","resources":{"requests":{"cpu":"20m","memory":"96Mi"}}}]}}))
        .send()
        .await?;
    assert!(
        !merge.status().is_success(),
        "a merge patch cannot edit a named container"
    );
    // The UID is the precondition.
    let mut forged = resized.clone();
    forged["metadata"]["uid"] = "00000000-0000-4000-8000-000000000000".into();
    assert!(
        k8s.resize_pod(
            &forged,
            &[("postgres", json!({"cpu":"20m","memory":"96Mi"}))],
            &[]
        )
        .await
        .is_err()
    );
    let after = k8s
        .read("Pod", Some(&namespace), "database-1")
        .await?
        .unwrap();
    assert_eq!(
        after["spec"]["containers"][0]["resources"]["requests"],
        json!({"cpu":"10m","memory":"96Mi"})
    );
    Ok(
        json!({"fence_set_and_null_removal":"passed","fence_resource_version_cas":"passed","pod_resize_strategic_merge":"passed","pod_resize_limits_and_qos_unchanged":"passed","pod_resize_merge_patch_refused":"passed","pod_resize_uid_precondition":"passed","kubelet_actuation":"not_exercised"}),
    )
}
#[tokio::main]
async fn main() -> Result<(), Error> {
    println!("{}", run().await?);
    Ok(())
}
