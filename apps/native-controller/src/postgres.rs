// SPDX-License-Identifier: Apache-2.0
use crate::{
    Error,
    contracts::{constant, database_valid, namespace, number, text},
    manifests::parameters,
};
use rustls::RootCertStore;
use rustls_pki_types::{CertificateDer, pem::PemObject};
use serde_json::Value;
use std::time::Duration;
use tokio_postgres::{Client, Row, config::SslMode, types::ToSql};
pub struct Session {
    pub client: Client,
    task: tokio::task::JoinHandle<Result<(), tokio_postgres::Error>>,
}
pub fn validate_ca(ca: &[u8]) -> Result<(), Error> {
    if ca.is_empty() || ca.len() > 128 * 1024 {
        return Err("PostgreSQL CA exceeds bound".into());
    }
    let certificates = CertificateDer::pem_slice_iter(ca).collect::<Result<Vec<_>, _>>()?;
    if certificates.is_empty() {
        return Err("PostgreSQL CA certificate missing".into());
    }
    for der in certificates {
        let (remaining, certificate) = x509_parser::parse_x509_certificate(der.as_ref())
            .map_err(|_| "PostgreSQL CA DER invalid")?;
        if !remaining.is_empty()
            || !certificate
                .basic_constraints()
                .map_err(|_| "PostgreSQL CA constraints invalid")?
                .is_some_and(|extension| extension.value.ca)
        {
            return Err("PostgreSQL trust material is not a certificate authority".into());
        }
    }
    Ok(())
}
impl Drop for Session {
    fn drop(&mut self) {
        // The client drops next, so its connection sends Terminate and ends TLS with close_notify
        // and FIN. A connection still open 500 ms later, e.g. awaiting a reply, is aborted.
        // Outside a runtime nothing can bound that close, so the connection is aborted at once.
        let task = self.task.abort_handle();
        match tokio::runtime::Handle::try_current() {
            Ok(runtime) => {
                runtime.spawn(async move {
                    tokio::time::sleep(Duration::from_millis(500)).await;
                    task.abort();
                });
            }
            Err(_) => task.abort(),
        }
    }
}
impl Session {
    pub async fn query(&self, sql: &str, args: &[&(dyn ToSql + Sync)]) -> Result<Vec<Row>, Error> {
        Ok(tokio::time::timeout(Duration::from_secs(5), self.client.query(sql, args)).await??)
    }
}
pub async fn connect(
    db: &Value,
    ca: &[u8],
    role: &str,
    password: &str,
    database: &str,
) -> Result<Session, Error> {
    let recovery = !db["recovery"].is_null();
    let role_allowed = pgcf_native_protocol::valid_role(role)
        || Some(role) == constant("MAINTENANCE_ROLE").as_str()
        || (role == "postgres" && recovery);
    let database_allowed = database == text(db, "id")
        || (recovery
            && (database == "postgres" || database == text(&db["recovery"], "source_database_id")));
    if !database_valid(db) || !role_allowed || password.is_empty() || !database_allowed {
        return Err("PostgreSQL probe authority invalid".into());
    }
    let mut config = tokio_postgres::Config::new();
    config
        .host(format!("database-rw.{}.svc", namespace(db)))
        .port(5432)
        .user(role)
        .password(password)
        .dbname(database)
        .application_name("pgcf-readiness")
        .options("-c statement_timeout=5000")
        .connect_timeout(Duration::from_secs(5))
        .ssl_mode(SslMode::Require);
    open(&config, ca).await
}
/// Opens a session whose TLS is verified against `ca`; `connect` checks the probe authority.
async fn open(config: &tokio_postgres::Config, ca: &[u8]) -> Result<Session, Error> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    validate_ca(ca)?;
    let mut roots = RootCertStore::empty();
    for cert in CertificateDer::pem_slice_iter(ca) {
        roots.add(cert?)?;
    }
    if roots.is_empty() {
        return Err("PostgreSQL CA missing".into());
    }
    let tls = rustls::ClientConfig::builder()
        .with_root_certificates(roots)
        .with_no_client_auth();
    let connector = tokio_postgres_rustls::MakeRustlsConnect::new(tls);
    let (client, connection) =
        tokio::time::timeout(Duration::from_secs(5), config.connect(connector)).await??;
    let task = tokio::spawn(connection);
    Ok(Session { client, task })
}

pub async fn roles(db: &Value, ca: &[u8]) -> Result<bool, Error> {
    if text(db, "desired_state") != "running" {
        return Ok(false);
    }
    tokio::time::timeout(Duration::from_secs(20),async{
  for role in db["roles"].as_array().ok_or("roles unavailable")?{
   let session=connect(db,ca,text(role,"name"),text(role,"password"),text(db,"id")).await?;
   let rows=session.query("SELECT current_user::text, current_setting('server_version')::text, current_setting('server_version_num')::int, current_setting('max_connections')::int, pg_size_bytes(current_setting('shared_buffers'))::text, pg_size_bytes(current_setting('effective_cache_size'))::text, EXTRACT(EPOCH FROM current_setting('archive_timeout')::interval)::int",&[]).await?;
   if rows.len()!=1{return Ok::<bool,Error>(false);}let row=&rows[0];let tuning=parameters(db);let shared=text(&tuning,"shared_buffers").trim_end_matches("MB").parse::<u64>()?;let version:String=row.try_get(1)?;let server_num:i32=row.try_get(2)?;let max_connections:i32=row.try_get(3)?;let buffers:String=row.try_get(4)?;let cache:String=row.try_get(5)?;let archive:i32=row.try_get(6)?;
   if row.try_get::<_,String>(0)?!=text(role,"name")||server_num/10000!=18||db["postgres"]["version"].as_str().is_some_and(|pin|version.split_whitespace().next()!=Some(pin))||u64::try_from(max_connections).ok()!=Some(number(&db["size"],"max_connections"))||buffers.parse::<u64>()?!=shared*1024*1024||cache.parse::<u64>()?!=number(&db["size"],"memory_mib")/2*1024*1024||u64::try_from(archive).ok()!=Some(number(&db["size"],"archive_timeout_seconds")){return Ok(false);}
   let privileges=session.query("SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,rolcanlogin FROM pg_roles WHERE rolname=current_user",&[]).await?;
   if privileges.len()!=1||!(0..5).all(|i|privileges[0].try_get::<_,bool>(i).is_ok_and(|v|!v))||!privileges[0].try_get::<_,bool>(5)?{return Ok(false);}
  }
  Ok(true)
 }).await?
}

#[cfg(test)]
mod tests {
    use super::*;
    use rustls::pki_types::{PrivateKeyDer, PrivatePkcs8KeyDer};
    use std::sync::Arc;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };
    use tokio_rustls::TlsAcceptor;
    const HOST: &str = "database-rw.pgcf-db-aaaaaaaaaaaaaaaaaaaa.svc";
    /// A TLS PostgreSQL double for one session: it completes startup, never answers a query and
    /// returns the frontend bytes it then received and whether TLS ended with close_notify.
    async fn postgres() -> (
        tokio_postgres::Config,
        String,
        tokio::task::JoinHandle<(Vec<u8>, bool)>,
    ) {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let mut params = rcgen::CertificateParams::new(Vec::<String>::new()).unwrap();
        params.is_ca = rcgen::IsCa::Ca(rcgen::BasicConstraints::Unconstrained);
        let ca = rcgen::CertifiedIssuer::self_signed(params, rcgen::KeyPair::generate().unwrap())
            .unwrap();
        let key = rcgen::KeyPair::generate().unwrap();
        let leaf = rcgen::CertificateParams::new(vec![HOST.into()])
            .unwrap()
            .signed_by(&key, &ca)
            .unwrap();
        let tls = rustls::ServerConfig::builder()
            .with_no_client_auth()
            .with_single_cert(
                vec![leaf.der().clone()],
                PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(key.serialize_der())),
            )
            .unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut tcp, _) = listener.accept().await.unwrap();
            let mut request = [0; 8];
            tcp.read_exact(&mut request).await.unwrap();
            assert_eq!(request, [0, 0, 0, 8, 4, 210, 22, 47]);
            tcp.write_all(b"S").await.unwrap();
            let mut tls = TlsAcceptor::from(Arc::new(tls)).accept(tcp).await.unwrap();
            let length = tls.read_u32().await.unwrap() as usize;
            tls.read_exact(&mut vec![0; length - 4]).await.unwrap();
            // AuthenticationOk and ReadyForQuery.
            tls.write_all(&[b'R', 0, 0, 0, 8, 0, 0, 0, 0, b'Z', 0, 0, 0, 5, b'I'])
                .await
                .unwrap();
            let mut received = Vec::new();
            let mut buffer = [0; 4096];
            loop {
                // close_notify reads as end of stream; a bare TCP close is an unexpected EOF.
                match tls.read(&mut buffer).await {
                    Ok(0) => return (received, true),
                    Ok(length) => received.extend_from_slice(&buffer[..length]),
                    Err(_) => return (received, false),
                }
            }
        });
        let mut config = tokio_postgres::Config::new();
        config
            .host(HOST)
            .hostaddr(address.ip())
            .port(address.port())
            .user("app")
            .ssl_mode(SslMode::Require);
        (config, ca.pem(), server)
    }
    #[tokio::test]
    async fn a_dropped_session_terminates_and_ends_tls_with_close_notify() {
        let (config, ca, server) = postgres().await;
        drop(open(&config, ca.as_bytes()).await.unwrap());
        let (received, clean) = tokio::time::timeout(Duration::from_secs(2), server)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(received, [b'X', 0, 0, 0, 4]);
        assert!(clean, "TLS ended without close_notify");
    }
    #[tokio::test]
    async fn a_dropped_session_with_an_unanswered_query_closes_within_the_bound() {
        let (config, ca, server) = postgres().await;
        let session = open(&config, ca.as_bytes()).await.unwrap();
        assert!(
            tokio::time::timeout(
                Duration::from_millis(100),
                session.client.simple_query("SELECT 1")
            )
            .await
            .is_err()
        );
        drop(session);
        // The connection waits for the reply before its Terminate, so the bound aborts it.
        let (received, _) = tokio::time::timeout(Duration::from_secs(2), server)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(received.first(), Some(&b'Q'));
    }
    #[test]
    fn a_session_dropped_outside_a_runtime_is_aborted_at_once() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let (session, server) = runtime.block_on(async {
            let (config, ca, server) = postgres().await;
            (open(&config, ca.as_bytes()).await.unwrap(), server)
        });
        drop(session);
        let (received, _) = runtime
            .block_on(async { tokio::time::timeout(Duration::from_secs(2), server).await })
            .unwrap()
            .unwrap();
        // Without a runtime for the bounded close, no Terminate is sent.
        assert!(received.is_empty());
    }
    #[test]
    fn trust_material_must_be_an_actual_ca() {
        let key = rcgen::KeyPair::generate().unwrap();
        let leaf = rcgen::CertificateParams::new(vec!["database-rw.pgcf-db-test.svc".into()])
            .unwrap()
            .self_signed(&key)
            .unwrap();
        assert!(validate_ca(leaf.pem().as_bytes()).is_err());
        let mut params = rcgen::CertificateParams::new(vec!["unit-ca".into()]).unwrap();
        params.is_ca = rcgen::IsCa::Ca(rcgen::BasicConstraints::Unconstrained);
        let ca = params.self_signed(&key).unwrap();
        assert!(validate_ca(ca.pem().as_bytes()).is_ok());
        assert!(validate_ca(b"not a certificate").is_err());
    }
}
