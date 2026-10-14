// SPDX-License-Identifier: Apache-2.0
//! Run only against tests/run-kubernetes.py's isolated actual API, never a Dev/customer cluster.
use pgcf_native_controller::{Error, kubernetes::Kubernetes, pool};
use reqwest::{Client, Url};
use serde_json::{Value, json};
use std::path::PathBuf;

#[tokio::main]
async fn main() -> Result<(), Error> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let origin = Url::parse(&std::env::var("PGCF_POOL_TEST_ORIGIN")?)?;
    let host = origin.host_str().ok_or("isolated API host missing")?;
    if !host.strip_prefix("pgcf-pool-api-").is_some_and(|suffix| {
        suffix.len() == 32 && suffix.bytes().all(|byte| byte.is_ascii_hexdigit())
    }) {
        return Err("isolated fixture host required".into());
    }
    let ca_path = PathBuf::from(std::env::var("PGCF_POOL_TEST_CA")?);
    let token_path = PathBuf::from(std::env::var("PGCF_POOL_TEST_TOKEN")?);
    let ca = tokio::fs::read(ca_path).await?;
    let token = tokio::fs::read_to_string(&token_path).await?;
    let k8s = Kubernetes::with_ca(origin.clone(), &ca, token_path)?;
    let client = Client::builder()
        .tls_certs_only([reqwest::Certificate::from_pem(&ca)?])
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .build()?;
    let attempt = std::env::var("PGCF_POOL_TEST_ATTEMPT")?;
    if attempt.len() != 32 || !attempt.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("isolated attempt identity invalid".into());
    }
    let database = format!("a{}", &attempt[..19]);
    let node_name = format!("pool-schema-{}", &attempt[..16]);
    let namespace = format!("pgcf-db-{database}");
    k8s.create(&json!({"apiVersion":"v1","kind":"Namespace","metadata":{"name":namespace}}))
        .await?;
    if let Some(namespace) = k8s.read("Namespace", None, "pgcf-pool").await? {
        assert_eq!(
            namespace["metadata"]["labels"]["pod-security.kubernetes.io/enforce"],
            "restricted"
        );
    } else {
        k8s.create(&json!({"apiVersion":"v1","kind":"Namespace","metadata":{"name":"pgcf-pool","labels":{"pod-security.kubernetes.io/enforce":"restricted"}}})).await?;
    }
    let initial=k8s.create(&json!({"apiVersion":"coordination.k8s.io/v1","kind":"Lease","metadata":{"name":"database","namespace":namespace},"spec":{"holderIdentity":"","leaseDurationSeconds":15,"leaseTransitions":0}})).await?;
    let renewal = json!({"spec":{"holderIdentity":"pgcf-pool/test-holder","renewTime":pool::primary_lease_timestamp()?}});
    let first = k8s
        .patch(&initial, &renewal)
        .await
        .map_err(|_| "isolated Lease renewTime update failed")?;
    assert!(pool::primary_lease_readback_matches(&first, &renewal));
    assert_eq!(first["metadata"]["uid"], initial["metadata"]["uid"]);
    assert_ne!(
        first["metadata"]["resourceVersion"],
        initial["metadata"]["resourceVersion"]
    );
    assert!(
        k8s.patch(&initial, &json!({"spec":{"holderIdentity":"stale-holder"}}))
            .await
            .is_err()
    );
    assert_eq!(
        k8s.read("Lease", Some(&namespace), "database")
            .await?
            .unwrap()["spec"]["holderIdentity"],
        "pgcf-pool/test-holder"
    );
    k8s.delete(&first, "Background").await?;
    let replacement=k8s.create(&json!({"apiVersion":"coordination.k8s.io/v1","kind":"Lease","metadata":{"name":"database","namespace":namespace},"spec":{"holderIdentity":"","leaseDurationSeconds":15,"leaseTransitions":0}})).await?;
    assert_ne!(replacement["metadata"]["uid"], first["metadata"]["uid"]);
    let mut forged = replacement.clone();
    forged["metadata"]["uid"] = first["metadata"]["uid"].clone();
    assert!(
        k8s.patch(
            &forged,
            &json!({"spec":{"holderIdentity":"replaced-holder"}})
        )
        .await
        .is_err()
    );
    assert_eq!(
        k8s.read("Lease", Some(&namespace), "database")
            .await?
            .unwrap()["spec"]["holderIdentity"],
        ""
    );
    let mut scope = pgcf_native_protocol::pool::CONTRACT["thin_scope"].clone();
    scope["database_id"] = database.clone().into();
    let binding = json!({"v":1,"scope_sha256":pgcf_native_protocol::pool::scope_hash(&scope).unwrap(),"scope":scope,"holder_revision":2,"state":"released","created_at":1000,"updated_at":2000});
    let name = format!("handoff-{}", &attempt[..16]);
    let scope = &binding["scope"];
    let target = json!({"v":1,"generation":scope["generation"],"route_revision":scope["route_revision"],"admission_epoch":scope["admission_epoch"],"pod_uid":scope["pool_pod_uid"],"container_id":scope["container_id"],"ca_secret_uid":scope["pool_namespace_uid"],"ca_secret_resource_version":"1","ca_sha256":"f".repeat(64),"tls_server_name":format!("database-rw.pgcf-db-{}.svc",scope["database_id"].as_str().unwrap())});
    let handoff=k8s.create(&json!({"apiVersion":"v1","kind":"ConfigMap","metadata":{"name":name,"namespace":namespace},"data":{"pool-binding.json":binding.to_string(),"admission_target":target.to_string(),"physical":"retained"}})).await?;
    k8s.patch(&handoff, &json!({"data":{"concurrent":"current"}}))
        .await?;
    let stale_patch = pool::terminal_handoff_patch(&handoff, &binding)?;
    assert!(k8s.patch(&handoff, &stale_patch).await.is_err());
    let current = k8s
        .read("ConfigMap", Some(&namespace), &name)
        .await?
        .unwrap();
    assert_eq!(current["data"]["pool-binding.json"], binding.to_string());
    let cleared = k8s
        .patch(&current, &pool::terminal_handoff_patch(&current, &binding)?)
        .await?;
    assert!(
        cleared["data"]["pool-binding.json"].is_null()
            && cleared["data"]["admission_target"].is_null()
    );
    assert_eq!(cleared["data"]["physical"], "retained");
    assert!(pool::terminal_handoff_patch(&cleared, &binding).is_err());
    let priority = json!({"apiVersion":"scheduling.k8s.io/v1","kind":"PriorityClass","metadata":{"name":"pgcf-pool"},"value":-1000,"globalDefault":false,"preemptionPolicy":"Never"});
    let prior = client
        .get(origin.join("/apis/scheduling.k8s.io/v1/priorityclasses/pgcf-pool")?)
        .bearer_auth(token.trim())
        .send()
        .await?;
    if prior.status() == reqwest::StatusCode::NOT_FOUND {
        let reply = client
            .post(origin.join("/apis/scheduling.k8s.io/v1/priorityclasses")?)
            .bearer_auth(token.trim())
            .json(&priority)
            .send()
            .await?;
        if !reply.status().is_success() {
            return Err("isolated PriorityClass validation failed".into());
        }
    } else {
        let value: Value = prior.error_for_status()?.json().await?;
        assert_eq!(value["value"], -1000);
        assert_eq!(value["preemptionPolicy"], "Never");
    }
    let sa=client.post(origin.join("/api/v1/namespaces/pgcf-pool/serviceaccounts")?).bearer_auth(token.trim()).json(&json!({"apiVersion":"v1","kind":"ServiceAccount","metadata":{"name":"default","namespace":"pgcf-pool"},"automountServiceAccountToken":false})).send().await?;
    if !sa.status().is_success() && sa.status() != reqwest::StatusCode::CONFLICT {
        return Err("isolated ServiceAccount fixture failed".into());
    }
    let created = k8s
        .create(&json!({"apiVersion":"v1","kind":"Node","metadata":{"name":node_name}}))
        .await?;
    let boot = "01234567-89ab-4def-8123-0123456789ab";
    let status = json!({"metadata":{"resourceVersion":created["metadata"]["resourceVersion"]},"status":{"nodeInfo":{"bootID":boot},"conditions":[{"type":"Ready","status":"True","lastHeartbeatTime":"2026-10-13T00:00:00Z","lastTransitionTime":"2026-10-13T00:00:00Z"}]}});
    let reply = client
        .patch(origin.join(&format!("/api/v1/nodes/{node_name}/status"))?)
        .bearer_auth(token.trim())
        .header("Content-Type", "application/merge-patch+json")
        .json(&status)
        .send()
        .await?;
    if !reply.status().is_success() {
        return Err("isolated Node status fixture failed".into());
    }
    let node = k8s.read("Node", None, &node_name).await?.unwrap();
    let state = json!({"node_id":format!("nod_{database}"),"node_uid":node["metadata"]["uid"],"region_id":"test","revision":1,"updated_at":"2026-10-13T00:00:00.000Z","policy":{"version":1,"kind":"postgres_pods","target_slots":1,"max_idle_cpu_millicores":350,"max_idle_memory_mib":384,"idle_cpu_millicores":350,"idle_memory_mib":384,"release_id":"r2-pool-test","class":{"postgres_image_sha256":"a".repeat(64),"cpu_request_millicores":250,"cpu_limit_millicores":500,"memory_request_bytes":268435456,"memory_limit_bytes":536870912,"configuration_profile_sha256":"b".repeat(64)},"driver_image":format!("registry.test/driver@sha256:{}","1".repeat(64)),"driver_sha256":"2".repeat(64),"host_controller_sha256":"3".repeat(64),"supervisor_image":format!("registry.test/supervisor@sha256:{}","c".repeat(64)),"supervisor_sha256":"d".repeat(64),"archiver_image":format!("registry.test/archiver@sha256:{}","e".repeat(64)),"archiver_sha256":"e".repeat(64)}});
    let pool_namespace = k8s.read("Namespace", None, "pgcf-pool").await?.unwrap();
    let plans = pool::inventory_plan(
        true,
        &state,
        &node,
        &pool_namespace,
        &format!("registry.test/postgres@sha256:{}", "a".repeat(64)),
        &"9".repeat(64),
    )?;
    assert_eq!(plans.len(), 1);
    // This fixture has no kubelet. It proves API/restricted-Pod schema and CAS, never readiness.
    let pod = k8s
        .create(&plans[0])
        .await
        .map_err(|_| "isolated restricted pool Pod create failed")?;
    assert_eq!(
        pod["spec"]["containers"][0]["resources"]["requests"],
        plans[0]["spec"]["containers"][0]["resources"]["requests"]
    );
    assert!(pod["status"]["containerStatuses"].is_null());
    let _: Value = pod;
    println!(
        "{}",
        json!({"lease_microtime_readback":"passed","lease_resource_version_cas":"passed","lease_replaced_uid_refusal":"passed","terminal_handoff_resource_version_cas":"passed","terminal_handoff_retained_physical_keys":"passed","restricted_pool_pod_schema":"passed","runtime_readiness":"not_exercised"})
    );
    Ok(())
}
