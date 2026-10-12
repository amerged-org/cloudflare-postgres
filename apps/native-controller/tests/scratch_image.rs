// SPDX-License-Identifier: Apache-2.0
//! The controller image is `FROM scratch`: on Linux it has no platform CA roots. Startup must not
//! depend on them, because every in-cluster HTTP client speaks plain HTTP and the Kubernetes and
//! Cloudflare clients pin their own roots.
use pgcf_native_controller::{
    api::ControlApi, kubernetes::Kubernetes, measurements::Measurements, reconcile::Reconciler,
};
use std::sync::Arc;

#[tokio::test]
async fn controller_starts_without_platform_ca_roots() {
    let roots = std::env::temp_dir().join(format!("pgcf-no-roots-{}", std::process::id()));
    std::fs::create_dir_all(&roots).unwrap();
    // SAFETY: this binary holds a single test, so no other thread reads the environment meanwhile.
    unsafe {
        std::env::set_var("SSL_CERT_DIR", &roots);
        std::env::remove_var("SSL_CERT_FILE");
        std::env::set_var("PGCF_REGION_ID", "eu-test");
        std::env::set_var("PGCF_API_URL", "https://api.example.invalid");
        std::env::set_var(
            "PGCF_AGENT_KEY",
            format!("pgcf_ak_eu-test_{}", "a".repeat(43)),
        );
        std::env::remove_var("PGCF_AGENT_KEY_FILE");
    }
    let _ = rustls::crypto::ring::default_provider().install_default();
    // Linux resolves platform roots from SSL_CERT_DIR only; the empty directory is the scratch image.
    #[cfg(all(unix, not(target_vendor = "apple")))]
    assert!(
        reqwest::Client::builder().build().is_err(),
        "the empty trust directory must reproduce the scratch image"
    );
    let ca = rcgen::generate_simple_self_signed(vec!["kubernetes.default.svc".into()])
        .unwrap()
        .cert
        .pem();
    let token = roots.join("token");
    std::fs::write(&token, "test-token").unwrap();
    let k8s = Kubernetes::with_ca(
        reqwest::Url::parse("https://10.96.0.1/").unwrap(),
        ca.as_bytes(),
        token,
    )
    .unwrap();
    let api = ControlApi::from_env().await.unwrap();
    let controller = Reconciler::new(
        k8s.clone(),
        "00000000-0000-4000-8000-000000000001".into(),
        format!("ghcr.io/example/postgres@sha256:{}", "0".repeat(64)),
        "eu-test".into(),
        2,
    )
    .unwrap();
    Measurements::new(k8s, api, Arc::new(controller)).unwrap();
    std::fs::remove_dir_all(&roots).unwrap();
}
