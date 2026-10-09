// SPDX-License-Identifier: Apache-2.0
use pgcf_native_gateway::transport::negotiate_tls;
use rcgen::generate_simple_self_signed;
use rustls::{
    ServerConfig,
    pki_types::{PrivateKeyDer, PrivatePkcs8KeyDer},
};
use std::{sync::Arc, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    time::timeout,
};
use tokio_rustls::TlsAcceptor;
#[tokio::test]
async fn postgres_ssl_request_precedes_verified_tls_and_exact_authentication_bytes() {
    let identity = generate_simple_self_signed(vec!["database.example".into()]).unwrap();
    let ca = identity.cert.pem();
    let config = ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(
            vec![identity.cert.der().clone()],
            PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(
                identity.signing_key.serialize_der(),
            )),
        )
        .unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut tcp, _) = listener.accept().await.unwrap();
        let mut ssl = [0; 8];
        tcp.read_exact(&mut ssl).await.unwrap();
        assert_eq!(ssl, [0, 0, 0, 8, 4, 210, 22, 47]);
        tcp.write_all(b"S").await.unwrap();
        let mut tls = TlsAcceptor::from(Arc::new(config))
            .accept(tcp)
            .await
            .unwrap();
        // Opaque SASL challenge and credential bytes are forwarded unchanged.
        let challenge = [b'R', 0, 0, 0, 8, 0, 0, 0, 10];
        tls.write_all(&challenge).await.unwrap();
        let mut credential = [0; 11];
        tls.read_exact(&mut credential).await.unwrap();
        assert_eq!(&credential, b"p\0\0\0\x0aopaque");
        tls.write_all(&credential).await.unwrap();
    });
    let tcp = TcpStream::connect(address).await.unwrap();
    let mut tls = timeout(
        Duration::from_secs(2),
        negotiate_tls(tcp, "database.example", ca.as_bytes()),
    )
    .await
    .unwrap()
    .unwrap();
    let mut challenge = [0; 9];
    tls.read_exact(&mut challenge).await.unwrap();
    assert_eq!(challenge, [b'R', 0, 0, 0, 8, 0, 0, 0, 10]);
    tls.write_all(b"p\0\0\0\x0aopaque").await.unwrap();
    let mut echo = [0; 11];
    tls.read_exact(&mut echo).await.unwrap();
    assert_eq!(&echo, b"p\0\0\0\x0aopaque");
    server.await.unwrap();
}
#[tokio::test]
async fn wrong_database_hostname_fails_before_any_startup_or_password() {
    let identity = generate_simple_self_signed(vec!["other.example".into()]).unwrap();
    let ca = identity.cert.pem();
    let config = ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(
            vec![identity.cert.der().clone()],
            PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(
                identity.signing_key.serialize_der(),
            )),
        )
        .unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut tcp, _) = listener.accept().await.unwrap();
        let mut ssl = [0; 8];
        tcp.read_exact(&mut ssl).await.unwrap();
        tcp.write_all(b"S").await.unwrap();
        let result = TlsAcceptor::from(Arc::new(config)).accept(tcp).await;
        match result {
            Err(_) => {}
            Ok(mut tls) => {
                let mut byte = [0];
                assert!(matches!(
                    timeout(Duration::from_secs(2), tls.read(&mut byte)).await,
                    Ok(Err(_)) | Ok(Ok(0))
                ));
            }
        }
    });
    assert!(
        negotiate_tls(
            TcpStream::connect(address).await.unwrap(),
            "database.example",
            ca.as_bytes()
        )
        .await
        .is_err()
    );
    server.await.unwrap();
}
#[tokio::test]
async fn tls_refusal_is_terminal() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let identity = generate_simple_self_signed(vec!["database.example".into()]).unwrap();
    let server = tokio::spawn(async move {
        let (mut tcp, _) = listener.accept().await.unwrap();
        let mut ssl = [0; 8];
        tcp.read_exact(&mut ssl).await.unwrap();
        tcp.write_all(b"N").await.unwrap();
        let mut byte = [0];
        assert_eq!(tcp.read(&mut byte).await.unwrap(), 0);
    });
    assert!(
        negotiate_tls(
            TcpStream::connect(address).await.unwrap(),
            "database.example",
            identity.cert.pem().as_bytes()
        )
        .await
        .is_err()
    );
    server.await.unwrap();
}
#[tokio::test]
async fn matching_hostname_with_an_untrusted_certificate_is_rejected() {
    let identity = generate_simple_self_signed(vec!["database.example".into()]).unwrap();
    let other = generate_simple_self_signed(vec!["database.example".into()]).unwrap();
    let config = ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(
            vec![identity.cert.der().clone()],
            PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(
                identity.signing_key.serialize_der(),
            )),
        )
        .unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut tcp, _) = listener.accept().await.unwrap();
        let mut ssl = [0; 8];
        tcp.read_exact(&mut ssl).await.unwrap();
        tcp.write_all(b"S").await.unwrap();
        if let Ok(mut tls) = TlsAcceptor::from(Arc::new(config)).accept(tcp).await {
            let mut byte = [0];
            assert!(matches!(
                timeout(Duration::from_secs(2), tls.read(&mut byte)).await,
                Ok(Err(_)) | Ok(Ok(0))
            ));
        }
    });
    assert!(
        negotiate_tls(
            TcpStream::connect(address).await.unwrap(),
            "database.example",
            other.cert.pem().as_bytes()
        )
        .await
        .is_err()
    );
    server.await.unwrap();
}
