// SPDX-License-Identifier: Apache-2.0
use crate::{
    Error,
    contracts::{constant, database_valid, namespace, number, text},
    manifests::parameters,
};
use rustls::RootCertStore;
use rustls_pki_types::{CertificateDer, pem::PemObject};
use serde_json::Value;
use std::{net::SocketAddr, time::Duration};
use tokio_postgres::{Client, Row, config::SslMode, types::ToSql};
/// PostgreSQL's port inside a database Pod.
pub const PORT: u16 = 5432;
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
    connect_at(db, ca, role, password, database, None).await
}
/// Like `connect`, with the socket given: `None` dials the tenant's Service by name. TLS always
/// verifies the Service name, so a Pod address never weakens the server identity.
pub async fn connect_via(
    db: &Value,
    ca: &[u8],
    role: &str,
    password: &str,
    database: &str,
    socket: Option<SocketAddr>,
) -> Result<Session, Error> {
    connect_at(db, ca, role, password, database, socket).await
}
/// TLS keeps the tenant's exact CNPG server name while the socket uses the authenticated pool Pod IP.
pub async fn connect_pool(
    db: &Value,
    scope: &Value,
    ca: &[u8],
    role: &str,
    password: &str,
    database: &str,
) -> Result<Session, Error> {
    if !pgcf_native_protocol::pool::validate("PoolBindingScope", scope)
        || scope["database_id"] != db["id"]
        || scope["generation"].as_u64() > db["generation"].as_u64()
    {
        return Err("pool PostgreSQL probe scope changed".into());
    }
    let address: std::net::IpAddr = scope["pool_pod_ip"]
        .as_str()
        .ok_or("pool PostgreSQL address absent")?
        .parse()?;
    if !match address {
        std::net::IpAddr::V4(v) => v.is_private(),
        std::net::IpAddr::V6(v) => v.is_unique_local(),
    } {
        return Err("pool PostgreSQL address is not private".into());
    }
    connect_at(
        db,
        ca,
        role,
        password,
        database,
        Some(SocketAddr::new(address, PORT)),
    )
    .await
}
async fn connect_at(
    db: &Value,
    ca: &[u8],
    role: &str,
    password: &str,
    database: &str,
    socket: Option<SocketAddr>,
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
        .port(socket.map_or(PORT, |socket| socket.port()))
        .user(role)
        .password(password)
        .dbname(database)
        .application_name("pgcf-readiness")
        .options("-c statement_timeout=5000")
        .connect_timeout(Duration::from_secs(5))
        .ssl_mode(SslMode::Require);
    if let Some(socket) = socket {
        config.hostaddr(socket.ip());
    }
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

fn probe_identity_current(
    database: &str,
    actual_database: &str,
    address: &str,
    actual_address: &str,
    recovery: bool,
) -> bool {
    !recovery
        && database == actual_database
        && address
            .parse::<std::net::IpAddr>()
            .ok()
            .is_some_and(|expected| {
                actual_address.parse::<std::net::IpAddr>().ok() == Some(expected)
            })
}
/// Where a role's login dials: the tenant's Service, a pool Pod's recorded address, or the
/// instance Pod itself.
enum Route<'a> {
    /// The tenant's Service by name, or the given socket in its place.
    Service(Option<SocketAddr>),
    Pool(&'a Value),
    Pod(SocketAddr),
}
/// Every role logs in through the tenant's Service (`socket` is `None`), one after the other.
pub async fn roles(
    db: &Value,
    ca: &[u8],
    primary_address: &str,
    socket: Option<SocketAddr>,
) -> Result<bool, Error> {
    roles_at(db, ca, primary_address, Route::Service(socket)).await
}
/// Every role logs in to the instance Pod itself, concurrently: the kubelet's readiness, and so
/// the Service's endpoint, is not awaited.
pub async fn roles_pod(
    db: &Value,
    ca: &[u8],
    primary_address: &str,
    socket: SocketAddr,
) -> Result<bool, Error> {
    roles_at(db, ca, primary_address, Route::Pod(socket)).await
}
pub async fn pool_roles(db: &Value, scope: &Value, ca: &[u8]) -> Result<bool, Error> {
    roles_at(
        db,
        ca,
        scope["pool_pod_ip"]
            .as_str()
            .ok_or("pool PostgreSQL address absent")?,
        Route::Pool(scope),
    )
    .await
}
/// A drained gateway is necessary but not sufficient: prepared transactions and real
/// background client backends also prevent a clean pool stop.
pub async fn pool_idle(db: &Value, scope: &Value, ca: &[u8]) -> Result<bool, Error> {
    if db["maintenance"].is_null() {
        return Err("pool maintenance authority absent".into());
    }
    let role = text(&db["maintenance"], "role");
    let session = connect_pool(
        db,
        scope,
        ca,
        role,
        text(&db["maintenance"], "password"),
        text(db, "id"),
    )
    .await?;
    idle_on(&session, db, role, text(scope, "pool_pod_ip")).await
}
/// Whether the PostgreSQL behind `session` is the database's primary at `address`, has no client
/// backend besides the session and holds no prepared transaction.
async fn idle_on(session: &Session, db: &Value, role: &str, address: &str) -> Result<bool, Error> {
    let rows = session.query(IDLE_QUERY, &[]).await?;
    if rows.len() != 1 {
        return Ok(false);
    }
    let row = &rows[0];
    Ok(probe_identity_current(
        text(db, "id"),
        &row.try_get::<_, String>(0)?,
        address,
        &row.try_get::<_, String>(2)?,
        row.try_get(3)?,
    ) && row.try_get::<_, String>(1)? == role
        && row.try_get::<_, String>(4)? == "0"
        && row.try_get::<_, String>(5)? == "0")
}
/// A role's login, its server settings and its privileges against the desired state.
async fn role_current(
    db: &Value,
    ca: &[u8],
    primary_address: &str,
    route: &Route<'_>,
    role: &Value,
) -> Result<bool, Error> {
    let session = match route {
        Route::Service(socket) => {
            connect_via(
                db,
                ca,
                text(role, "name"),
                text(role, "password"),
                text(db, "id"),
                *socket,
            )
            .await?
        }
        Route::Pool(scope) => {
            connect_pool(
                db,
                scope,
                ca,
                text(role, "name"),
                text(role, "password"),
                text(db, "id"),
            )
            .await?
        }
        Route::Pod(socket) => {
            connect_via(
                db,
                ca,
                text(role, "name"),
                text(role, "password"),
                text(db, "id"),
                Some(*socket),
            )
            .await?
        }
    };
    let rows = session.query(ROLE_QUERY, &[]).await?;
    if rows.len() != 1 {
        return Ok(false);
    }
    let row = &rows[0];
    let tuning = parameters(db);
    let shared = text(&tuning, "shared_buffers")
        .trim_end_matches("MB")
        .parse::<u64>()?;
    let version: String = row.try_get(1)?;
    let server_num: i32 = row.try_get(2)?;
    let max_connections: i32 = row.try_get(3)?;
    let buffers: String = row.try_get(4)?;
    let cache: String = row.try_get(5)?;
    let archive: i32 = row.try_get(6)?;
    if row.try_get::<_, String>(0)? != text(role, "name")
        || server_num / 10000 != 18
        || db["postgres"]["version"]
            .as_str()
            .is_some_and(|pin| version.split_whitespace().next() != Some(pin))
        || u64::try_from(max_connections).ok() != Some(number(&db["size"], "max_connections"))
        || buffers.parse::<u64>()? != shared * 1024 * 1024
        || cache.parse::<u64>()? != number(&db["size"], "memory_mib") / 2 * 1024 * 1024
        || u64::try_from(archive).ok() != Some(number(&db["size"], "archive_timeout_seconds"))
    {
        return Ok(false);
    }
    if !probe_identity_current(
        text(db, "id"),
        &row.try_get::<_, String>(7)?,
        primary_address,
        &row.try_get::<_, String>(8)?,
        row.try_get::<_, bool>(9)?,
    ) {
        return Ok(false);
    }
    let privileges = session.query(PRIVILEGES_QUERY, &[]).await?;
    if privileges.len() != 1
        || !(0..5).all(|i| privileges[0].try_get::<_, bool>(i).is_ok_and(|v| !v))
        || !privileges[0].try_get::<_, bool>(5)?
    {
        return Ok(false);
    }
    Ok(true)
}
async fn roles_at(
    db: &Value,
    ca: &[u8],
    primary_address: &str,
    route: Route<'_>,
) -> Result<bool, Error> {
    if text(db, "desired_state") != "running" {
        return Ok(false);
    }
    tokio::time::timeout(Duration::from_secs(20), async {
        let roles = db["roles"].as_array().ok_or("roles unavailable")?;
        if matches!(route, Route::Pod(_)) {
            let all = futures_util::future::try_join_all(
                roles
                    .iter()
                    .map(|role| role_current(db, ca, primary_address, &route, role)),
            )
            .await?;
            return Ok::<bool, Error>(all.into_iter().all(|ok| ok));
        }
        for role in roles {
            if !role_current(db, ca, primary_address, &route, role).await? {
                return Ok(false);
            }
        }
        Ok(true)
    })
    .await?
}
/// What a pool holder's PostgreSQL says of itself, by position: its database, its user, the
/// address it was reached at (`host()`: the cast of an `inet` to `text` keeps the netmask, which no
/// Pod address has), whether it is a standby, and its client backends and prepared transactions.
pub(crate) const IDLE_QUERY: &str = "SELECT current_database()::text, current_user::text, pg_catalog.host(pg_catalog.inet_server_addr()), pg_is_in_recovery(), (SELECT count(*)::text FROM pg_stat_activity WHERE backend_type='client backend' AND pid<>pg_backend_pid()), (SELECT count(*)::text FROM pg_prepared_xacts)";
/// A role's own view of the server: user, version, settings, database and the address it was
/// reached at (see `IDLE_QUERY` for `host()`), by position.
pub(crate) const ROLE_QUERY: &str = "SELECT current_user::text, current_setting('server_version')::text, current_setting('server_version_num')::int, current_setting('max_connections')::int, pg_size_bytes(current_setting('shared_buffers'))::text, pg_size_bytes(current_setting('effective_cache_size'))::text, EXTRACT(EPOCH FROM current_setting('archive_timeout')::interval)::int, current_database()::text, pg_catalog.host(pg_catalog.inet_server_addr()), pg_is_in_recovery()";
/// A role's privileges: none beyond login.
pub(crate) const PRIVILEGES_QUERY: &str = "SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,rolcanlogin FROM pg_roles WHERE rolname=current_user";
/// The readiness of a resumed Pod by SQL: its database and TLS, whether it is a primary, which
/// Pod answers, and how long ago its postmaster started on the server's own clock.
pub const ACCEPTING_QUERY: &str = "SELECT pg_catalog.current_database() AS database,
 pg_catalog.pg_is_in_recovery() AS recovery,
 (SELECT ssl FROM pg_catalog.pg_stat_ssl WHERE pid=pg_catalog.pg_backend_pid()) AS tls,
 pg_catalog.host(pg_catalog.inet_server_addr()) AS server_address,
 (pg_catalog.date_part('epoch', pg_catalog.clock_timestamp() - pg_catalog.pg_postmaster_start_time()) * 1000)::pg_catalog.int8 AS postmaster_age_ms";

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn readiness_sql_identity_is_bound_to_the_published_primary_address() {
        assert!(probe_identity_current(
            "database", "database", "10.0.0.7", "10.0.0.7", false
        ));
        assert!(!probe_identity_current(
            "database", "other", "10.0.0.7", "10.0.0.7", false
        ));
        assert!(!probe_identity_current(
            "database", "database", "10.0.0.7", "10.0.0.8", false
        ));
        assert!(!probe_identity_current(
            "database", "database", "10.0.0.7", "10.0.0.7", true
        ));
    }
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
    /// The wire forms of PostgreSQL's `inet` as the controller's statements meet them: the cast to
    /// `text` keeps the netmask, so a comparison with the Pod's address can only hold for `host()`.
    #[test]
    fn a_server_address_with_its_netmask_is_not_the_pods_address() {
        assert!(!probe_identity_current(
            "database",
            "database",
            "10.0.0.7",
            "10.0.0.7/32",
            false
        ));
        assert!(!probe_identity_current(
            "database",
            "database",
            "fd00::7",
            "fd00::7/128",
            false
        ));
        assert!(probe_identity_current(
            "database", "database", "fd00::7", "fd00::7", false
        ));
    }
    /// A double that answers one statement with one cell, to a session without the world.
    async fn answer_with(
        cell: crate::test_postgres::Cell,
    ) -> (Session, crate::test_postgres::Postgres) {
        let authority = crate::test_postgres::Authority::new();
        let server = crate::test_postgres::Postgres::start(
            &authority,
            HOST,
            None,
            Arc::new(move |_, _, _| {
                crate::test_postgres::Answer::Rows(vec![vec![("value", cell.clone())]])
            }),
        )
        .await;
        let mut config = tokio_postgres::Config::new();
        config
            .host(HOST)
            .hostaddr(server.address.ip())
            .port(server.address.port())
            .user("app")
            .ssl_mode(SslMode::Require);
        (
            open(&config, authority.pem.as_bytes()).await.unwrap(),
            server,
        )
    }
    #[tokio::test]
    async fn an_inet_cell_is_binary_and_no_text_decode_accepts_it() {
        use crate::test_postgres::Cell;
        let (session, _server) = answer_with(Cell::Inet("10.0.0.7".into())).await;
        let rows = session
            .query("SELECT inet_server_addr()", &[])
            .await
            .unwrap();
        assert_eq!(
            rows[0].columns()[0].type_(),
            &tokio_postgres::types::Type::INET
        );
        assert!(rows[0].try_get::<_, String>(0).is_err());
        // The cast to text is what keeps the netmask; the cell for it is text with `/32`.
        let (session, _server) = answer_with(Cell::Text("10.0.0.7/32".into())).await;
        let rows = session
            .query("SELECT inet_server_addr()::text", &[])
            .await
            .unwrap();
        assert_eq!(rows[0].try_get::<_, String>(0).unwrap(), "10.0.0.7/32");
        // `name` decodes as a string, as `current_database()` does in the sleep proof.
        let (session, _server) = answer_with(Cell::Name("database".into())).await;
        let rows = session
            .query("SELECT current_database()", &[])
            .await
            .unwrap();
        assert_eq!(
            rows[0].columns()[0].type_(),
            &tokio_postgres::types::Type::NAME
        );
        assert_eq!(rows[0].try_get::<_, String>(0).unwrap(), "database");
    }
    /// The whole role login of a database whose PostgreSQL answers as the real server does: the
    /// address it reports for itself is the Pod's, printed without a netmask.
    #[tokio::test]
    async fn a_role_login_accepts_the_address_postgresql_reports_for_the_pod() {
        use crate::test_world::{POD_IP, World};
        let mut w = World::awake().await;
        w.wake(3);
        let socket = w.reconciler.power.postgres;
        let all = roles(&w.db, w.authority.pem.as_bytes(), POD_IP, socket)
            .await
            .unwrap();
        assert!(all, "every role of the Pod logs in");
        let concurrently = roles_pod(&w.db, w.authority.pem.as_bytes(), POD_IP, socket.unwrap())
            .await
            .unwrap();
        assert!(concurrently);
        // Another Pod answering is not this one.
        assert!(
            !roles(&w.db, w.authority.pem.as_bytes(), "10.0.0.99", socket)
                .await
                .unwrap()
        );
    }
    /// The idleness check of a pool holder reads the same address the same way.
    #[tokio::test]
    async fn a_pool_holder_is_idle_at_the_address_postgresql_reports_for_it() {
        use crate::test_world::{POD_IP, World};
        let w = World::awake().await;
        let role = text(&w.db["maintenance"], "role");
        let session = connect_via(
            &w.db,
            w.authority.pem.as_bytes(),
            role,
            text(&w.db["maintenance"], "password"),
            text(&w.db, "id"),
            w.reconciler.power.postgres,
        )
        .await
        .unwrap();
        assert!(idle_on(&session, &w.db, role, POD_IP).await.unwrap());
        assert!(!idle_on(&session, &w.db, role, "10.0.0.99").await.unwrap());
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
