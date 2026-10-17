// SPDX-License-Identifier: Apache-2.0
use crate::{
    Error,
    contracts::{
        constant, database_valid, namespace, number, optional_number, present_roles, text,
    },
};
use rustls::RootCertStore;
use rustls_pki_types::{CertificateDer, pem::PemObject};
use serde_json::{Value, json};
use std::{
    collections::{BTreeSet, HashSet},
    net::SocketAddr,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio_postgres::{
    Client, Row,
    config::SslMode,
    types::{Timestamp, ToSql},
};
/// The settings PostgreSQL runs a database with, by its size.
pub fn parameters(db: &Value) -> Value {
    let size = &db["size"];
    let memory = number(size, "memory_mib");
    let request = optional_number(size, "memory_request_mib", memory);
    json!({"shared_buffers":format!("{}MB",(request/4).max(1)),"effective_cache_size":format!("{}MB",memory/2),"max_connections":number(size,"max_connections").to_string(),"archive_timeout":format!("{}s",number(size,"archive_timeout_seconds"))})
}
/// The roles in input order, each only after the roles it is a member of: the first role whose
/// memberships are all emitted comes next. Without memberships the input order is kept. A cycle,
/// which PostgreSQL refuses, is emitted as it stands.
pub fn membership_order<'a>(roles: impl Iterator<Item = &'a Value>) -> Vec<&'a Value> {
    let mut remaining: Vec<&Value> = roles.collect();
    let names: HashSet<&str> = remaining.iter().map(|role| text(role, "name")).collect();
    let mut emitted: HashSet<&str> = HashSet::new();
    let mut ordered = Vec::with_capacity(remaining.len());
    while !remaining.is_empty() {
        let ready = remaining.iter().position(|role| {
            role["member_of"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .all(|target| emitted.contains(target) || !names.contains(target))
        });
        let next = remaining.remove(ready.unwrap_or(0));
        emitted.insert(text(next, "name"));
        ordered.push(next);
    }
    ordered
}
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
/// Every role logs in through the tenant's Service (`socket` is `None`, or the socket in its
/// place), one after the other, and the catalogs hold each as the record states it.
pub async fn roles(
    db: &Value,
    ca: &[u8],
    primary_address: &str,
    socket: Option<SocketAddr>,
) -> Result<bool, Error> {
    if text(db, "desired_state") != "running" {
        return Ok(false);
    }
    tokio::time::timeout(Duration::from_secs(20), async {
        db["roles"].as_array().ok_or("roles unavailable")?;
        // A role awaiting removal has no credential to log in with.
        let roles: Vec<&Value> = present_roles(db).collect();
        for role in &roles {
            if !role_current(db, ca, primary_address, socket, role).await? {
                return Ok::<bool, Error>(false);
            }
        }
        attributes_current(db, ca, socket, &roles).await
    })
    .await?
}
/// A session of the maintenance role; `socket` as for `connect_via`.
pub async fn maintenance(
    db: &Value,
    ca: &[u8],
    socket: Option<SocketAddr>,
) -> Result<Session, Error> {
    if db["maintenance"].is_null() {
        return Err("maintenance authority absent".into());
    }
    connect_via(
        db,
        ca,
        text(&db["maintenance"], "role"),
        text(&db["maintenance"], "password"),
        text(db, "id"),
        socket,
    )
    .await
}
/// A role as the catalogs hold it, for its removal.
pub enum Held {
    Absent,
    Login,
    NoLogin,
}
/// Whether PostgreSQL has the role, and whether it can still log in.
pub async fn held(session: &Session, name: &str) -> Result<Held, Error> {
    let rows = session.query(ROLE_CATALOG_QUERY, &[&name]).await?;
    match rows.as_slice() {
        [] => Ok(Held::Absent),
        [row] if row.try_get::<_, bool>("rolcanlogin")? => Ok(Held::Login),
        [_] => Ok(Held::NoLogin),
        _ => Err("role catalog ambiguous".into()),
    }
}
/// The objects and privileges, in any database, that depend on the role.
pub async fn dependencies(session: &Session, name: &str) -> Result<i64, Error> {
    let rows = session.query(DEPENDENCIES_QUERY, &[&name]).await?;
    let [row] = rows.as_slice() else {
        return Err("role dependencies unavailable".into());
    };
    Ok(row.try_get(0)?)
}
/// Ends the sessions of the role and says whether none remain. A refusal for want of
/// `pg_signal_backend` is not an error: the role keeps its sessions until the grant arrives.
pub async fn end_sessions(session: &Session, name: &str) -> Result<bool, Error> {
    match session.query(TERMINATE_QUERY, &[&name]).await {
        Ok(_) => {}
        Err(error)
            if error
                .downcast_ref::<tokio_postgres::Error>()
                .and_then(|error| error.code())
                .is_some_and(|code| {
                    *code == tokio_postgres::error::SqlState::INSUFFICIENT_PRIVILEGE
                }) =>
        {
            return Ok(false);
        }
        Err(error) => return Err(error),
    }
    let rows = session.query(SESSIONS_QUERY, &[&name]).await?;
    let [row] = rows.as_slice() else {
        return Err("role sessions unavailable".into());
    };
    Ok(row.try_get::<_, i64>(0)? == 0)
}
/// How far ahead of its expiry a role's credential is no longer one a login can prove: a client
/// that connects after the check finds it expired.
const EXPIRY_MARGIN: Duration = Duration::from_secs(10);
/// Whether a role's credential has expired, or does within `EXPIRY_MARGIN`, by the agent's
/// clock. PostgreSQL refuses an expired credential, so its login says nothing of the credential.
fn expiring(role: &Value, now: SystemTime) -> bool {
    let Some(until) = role["valid_until"].as_str().and_then(|until| {
        time::OffsetDateTime::parse(until, &time::format_description::well_known::Rfc3339).ok()
    }) else {
        return false;
    };
    let now = now
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis());
    let until = until.unix_timestamp_nanos() / 1_000_000;
    until <= i128::try_from(now + EXPIRY_MARGIN.as_millis()).unwrap_or(i128::MAX)
}
/// Whether a startup was refused for too many connections. PostgreSQL checks a role's own limit
/// only after the credential was accepted.
fn too_many_connections(error: &Error) -> bool {
    error
        .downcast_ref::<tokio_postgres::Error>()
        .and_then(|error| error.code())
        .is_some_and(|code| *code == tokio_postgres::error::SqlState::TOO_MANY_CONNECTIONS)
}
/// A session of `role` through the tenant's Service, or `socket` in its place.
async fn open_on(
    db: &Value,
    ca: &[u8],
    socket: Option<SocketAddr>,
    role: &str,
    password: &str,
) -> Result<Session, Error> {
    connect_via(db, ca, role, password, text(db, "id"), socket).await
}
/// A role's login, its server settings and its privileges against the desired state.
async fn role_current(
    db: &Value,
    ca: &[u8],
    primary_address: &str,
    socket: Option<SocketAddr>,
    role: &Value,
) -> Result<bool, Error> {
    if expiring(role, SystemTime::now()) {
        return Ok(true);
    }
    let session = match open_on(db, ca, socket, text(role, "name"), text(role, "password")).await {
        Ok(session) => session,
        // The credential was accepted: PostgreSQL refuses a role at its limit afterwards.
        Err(error) if role.get("connection_limit").is_some() && too_many_connections(&error) => {
            return Ok(true);
        }
        Err(error) => return Err(error),
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
    // Superuser, createdb, createrole and replication are never granted; BYPASSRLS only where the
    // record states it; and the role logs in.
    if privileges.len() != 1
        || !(0..4).all(|i| privileges[0].try_get::<_, bool>(i).is_ok_and(|v| !v))
        || privileges[0].try_get::<_, bool>(4)? != (role["bypass_rls"] == true)
        || !privileges[0].try_get::<_, bool>(5)?
    {
        return Ok(false);
    }
    Ok(true)
}
/// A role carries an attribute a plain login role does not.
fn attributed(role: &Value) -> bool {
    ["valid_until", "connection_limit", "bypass_rls"]
        .iter()
        .any(|attribute| role.get(*attribute).is_some())
        || role["member_of"]
            .as_array()
            .is_some_and(|targets| !targets.is_empty())
}
/// The unix second an expiry falls in: its milliseconds are cut, as the Cluster cuts them.
fn whole_seconds(until: &str) -> Option<i64> {
    time::OffsetDateTime::parse(until, &time::format_description::well_known::Rfc3339)
        .ok()
        .map(|until| until.unix_timestamp())
}
/// Whether the catalogs hold the role as the record states it: it logs in, its expiry (to the
/// whole second; NULL and `infinity` are none), its connection limit, BYPASSRLS and exactly the
/// memberships asked for.
async fn catalog_holds(session: &Session, role: &Value) -> Result<bool, Error> {
    let name = text(role, "name");
    let rows = session.query(ROLE_CATALOG_QUERY, &[&name]).await?;
    let [row] = rows.as_slice() else {
        return Ok(false);
    };
    let limit: i32 = row.try_get("rolconnlimit")?;
    let expiry: Option<Timestamp<SystemTime>> = row.try_get("rolvaliduntil")?;
    let held_until = match expiry {
        None | Some(Timestamp::PosInfinity) => None,
        Some(Timestamp::Value(at)) => Some(time::OffsetDateTime::from(at).unix_timestamp()),
        // Always expired: no expiry the record can state.
        Some(Timestamp::NegInfinity) => return Ok(false),
    };
    if row.try_get::<_, String>("rolname")? != name
        || !row.try_get::<_, bool>("rolcanlogin")?
        || row.try_get::<_, bool>("rolbypassrls")? != (role["bypass_rls"] == true)
        || i64::from(limit) != role["connection_limit"].as_i64().unwrap_or(-1)
        || held_until != role["valid_until"].as_str().and_then(whole_seconds)
    {
        return Ok(false);
    }
    let held = session
        .query(MEMBERSHIP_QUERY, &[&name])
        .await?
        .iter()
        .map(|granted| granted.try_get::<_, String>(0))
        .collect::<Result<BTreeSet<_>, _>>()?;
    let wanted: BTreeSet<String> = role["member_of"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|target| target.as_str().map(str::to_string))
        .collect();
    Ok(held == wanted)
}
/// Whether the catalogs hold every role as the record states it, read in one session of the
/// maintenance role on the route of the logins. A record whose roles are all plain needs no
/// session: the login proves them. Attributes without the credential to read them are unproven.
async fn attributes_current(
    db: &Value,
    ca: &[u8],
    socket: Option<SocketAddr>,
    roles: &[&Value],
) -> Result<bool, Error> {
    // The owner is the application's bootstrap role, not a role CNPG manages.
    let managed: Vec<&&Value> = roles.iter().filter(|role| role["owner"] != true).collect();
    if !managed.iter().any(|role| attributed(role)) {
        return Ok(true);
    }
    if db["maintenance"].is_null() {
        return Ok(false);
    }
    let session = open_on(
        db,
        ca,
        socket,
        text(&db["maintenance"], "role"),
        text(&db["maintenance"], "password"),
    )
    .await?;
    for role in managed {
        if !catalog_holds(&session, role).await? {
            return Ok(false);
        }
    }
    Ok(true)
}
/// A role's own view of the server: user, version, settings, database and the address it was
/// reached at (`host()`: the cast of an `inet` to `text` keeps the netmask, which no Pod address
/// has), by position.
pub(crate) const ROLE_QUERY: &str = "SELECT current_user::text, current_setting('server_version')::text, current_setting('server_version_num')::int, current_setting('max_connections')::int, pg_size_bytes(current_setting('shared_buffers'))::text, pg_size_bytes(current_setting('effective_cache_size'))::text, EXTRACT(EPOCH FROM current_setting('archive_timeout')::interval)::int, current_database()::text, pg_catalog.host(pg_catalog.inet_server_addr()), pg_is_in_recovery()";
/// A role's privileges: none beyond login, and row security bypassed only where the record asks.
pub(crate) const PRIVILEGES_QUERY: &str = "SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,rolcanlogin FROM pg_roles WHERE rolname=current_user";
/// The row of a role in the catalog by name, columns by position. `rolvaliduntil` is a
/// `timestamptz`, NULL for no expiry and possibly `infinity`; `rolconnlimit` is -1 for no limit.
/// No row is a role PostgreSQL does not have.
pub(crate) const ROLE_CATALOG_QUERY: &str = "SELECT rolname, rolcanlogin, rolvaliduntil, rolconnlimit, rolbypassrls FROM pg_catalog.pg_roles WHERE rolname = $1";
/// The roles a role is a member of, one row each.
pub(crate) const MEMBERSHIP_QUERY: &str = "SELECT granted.rolname FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles granted ON granted.oid = m.roleid JOIN pg_catalog.pg_roles member ON member.oid = m.member WHERE member.rolname = $1";
/// The objects and privileges in any database that depend on a role: what makes `DROP ROLE` fail.
pub(crate) const DEPENDENCIES_QUERY: &str = "SELECT count(*) FROM pg_catalog.pg_shdepend d JOIN pg_catalog.pg_roles r ON r.oid = d.refobjid WHERE d.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass AND r.rolname = $1";
/// Ends the sessions of a role; the role is bound, never part of the text.
pub(crate) const TERMINATE_QUERY: &str = "SELECT pg_catalog.pg_terminate_backend(pid) FROM pg_catalog.pg_stat_activity WHERE usename = $1 AND pid <> pg_catalog.pg_backend_pid()";
/// The sessions of a role that are still there.
pub(crate) const SESSIONS_QUERY: &str = "SELECT count(*) FROM pg_catalog.pg_stat_activity WHERE usename = $1 AND pid <> pg_catalog.pg_backend_pid()";
/// The data directory a postmaster runs on: the system identifier of its `pg_control` (fixed by
/// `initdb`, the same for a clone of the cluster) and the timeline of its latest checkpoint. Both
/// functions answer any role.
pub const SERVER_IDENTITY_QUERY: &str = "SELECT (SELECT system_identifier FROM pg_catalog.pg_control_system())::pg_catalog.text AS system_identifier,
 (SELECT timeline_id FROM pg_catalog.pg_control_checkpoint())::pg_catalog.int4 AS timeline";
/// The readiness of a started PostgreSQL by SQL: its database and TLS, whether it is a primary,
/// which Pod answers, how long ago its postmaster started on the server's own clock, and the data
/// directory it runs on (see `SERVER_IDENTITY_QUERY`).
pub const ACCEPTING_QUERY: &str = "SELECT pg_catalog.current_database() AS database,
 pg_catalog.pg_is_in_recovery() AS recovery,
 (SELECT ssl FROM pg_catalog.pg_stat_ssl WHERE pid=pg_catalog.pg_backend_pid()) AS tls,
 pg_catalog.host(pg_catalog.inet_server_addr()) AS server_address,
 (pg_catalog.date_part('epoch', pg_catalog.clock_timestamp() - pg_catalog.pg_postmaster_start_time()) * 1000)::pg_catalog.int8 AS postmaster_age_ms,
 (SELECT system_identifier FROM pg_catalog.pg_control_system())::pg_catalog.text AS system_identifier,
 (SELECT timeline_id FROM pg_catalog.pg_control_checkpoint())::pg_catalog.int4 AS timeline";

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
    use crate::test_postgres::Instant;
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
    /// The wire forms of PostgreSQL's `inet` as the agent's statements meet them: the cast to
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
        use crate::test_sql::{POD_IP, World};
        let mut w = World::awake().await;
        w.wake(3);
        let socket = w.address();
        let all = roles(&w.db, w.authority.pem.as_bytes(), POD_IP, socket)
            .await
            .unwrap();
        assert!(all, "every role of the Pod logs in");
        // Another Pod answering is not this one.
        assert!(
            !roles(&w.db, w.authority.pem.as_bytes(), "10.0.0.99", socket)
                .await
                .unwrap()
        );
    }
    /// The roles are created in the order of their memberships; plain roles keep their order.
    #[test]
    fn a_role_is_ordered_after_the_roles_it_is_a_member_of() {
        let vectors: Value = serde_json::from_str(include_str!(
            "../../../packages/contracts/native/controller-vectors.generated.json"
        ))
        .unwrap();
        let v = vectors
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["name"] == "role-membership-order")
            .unwrap();
        let names = |db: &Value| -> Vec<String> {
            membership_order(present_roles(db).filter(|role| role["owner"] != true))
                .iter()
                .map(|role| text(role, "name").to_string())
                .collect()
        };
        assert_eq!(
            names(&v["db"]),
            [
                "reader_query",
                "other_job",
                "base_job",
                "mid_job",
                "leaf_job"
            ]
        );
        // Without memberships the input order stands: plain databases do not move.
        let mut flat = v["db"].clone();
        for role in flat["roles"].as_array_mut().unwrap() {
            role.as_object_mut().unwrap().remove("member_of");
        }
        assert_eq!(
            names(&flat),
            [
                "reader_query",
                "leaf_job",
                "mid_job",
                "other_job",
                "base_job"
            ]
        );
    }
    /// The role a statement concerns is bound, never part of its text, whatever the role is called.
    #[test]
    fn the_role_statements_bind_the_role() {
        for statement in [
            ROLE_CATALOG_QUERY,
            MEMBERSHIP_QUERY,
            DEPENDENCIES_QUERY,
            TERMINATE_QUERY,
            SESSIONS_QUERY,
        ] {
            assert_eq!(statement.matches("$1").count(), 1, "{statement}");
            // The only literal is the catalog the dependencies are read from.
            assert!(
                !statement
                    .replace("'pg_catalog.pg_authid'", "")
                    .contains('\''),
                "{statement}"
            );
        }
    }
    /// The role functions against a real PostgreSQL: the forms they decode, the catalog rows they
    /// compare, the sessions they end and the privilege refusal they read as "not yet". Set
    /// `PGCF_TEST_POSTGRES_ADDR` to `host:port` of a scratch server that trusts its roles (the
    /// product image started with `initdb -A trust` does). The test creates roles named
    /// `pgcf_t_*` and drops them again. Without the variable it is skipped.
    #[tokio::test]
    async fn the_role_functions_read_and_end_what_a_real_postgresql_holds() {
        let Ok(address) = std::env::var("PGCF_TEST_POSTGRES_ADDR") else {
            eprintln!("skipped: PGCF_TEST_POSTGRES_ADDR names no PostgreSQL");
            return;
        };
        let (host, port) = address.rsplit_once(':').expect("host:port");
        let port: u16 = port.parse().unwrap();
        async fn session(host: &str, port: u16, user: &str) -> Session {
            let (client, connection) = tokio_postgres::Config::new()
                .host(host)
                .port(port)
                .user(user)
                .dbname("postgres")
                .connect(tokio_postgres::NoTls)
                .await
                .unwrap();
            Session {
                client,
                task: tokio::spawn(connection),
            }
        }
        let admin = session(host, port, "postgres").await;
        let teardown = "DROP TABLE IF EXISTS pgcf_t_object;
            DROP ROLE IF EXISTS pgcf_t_report, pgcf_t_plain, pgcf_t_reader, pgcf_t_maintenance, pgcf_t_stats";
        admin.client.batch_execute(teardown).await.unwrap();
        admin
            .client
            .batch_execute(
                "CREATE ROLE pgcf_t_reader NOLOGIN;
                CREATE ROLE pgcf_t_report LOGIN CONNECTION LIMIT 5 VALID UNTIL '2031-01-02T03:04:05Z' IN ROLE pgcf_t_reader BYPASSRLS;
                CREATE ROLE pgcf_t_plain LOGIN;
                CREATE ROLE pgcf_t_maintenance LOGIN;
                GRANT pg_read_all_stats, pg_signal_backend TO pgcf_t_maintenance;
                CREATE ROLE pgcf_t_stats LOGIN;
                GRANT pg_read_all_stats TO pgcf_t_stats",
            )
            .await
            .unwrap();
        let maintenance = session(host, port, "pgcf_t_maintenance").await;
        // The catalogs hold the role as the record states it, to the whole second of its expiry.
        let report = serde_json::json!({"name":"pgcf_t_report","owner":false,"valid_until":"2031-01-02T03:04:05.678Z","connection_limit":5,"member_of":["pgcf_t_reader"],"bypass_rls":true});
        assert!(catalog_holds(&maintenance, &report).await.unwrap());
        for (key, wrong) in [
            ("connection_limit", serde_json::json!(4)),
            ("valid_until", serde_json::json!("2031-01-02T03:04:06.000Z")),
            ("member_of", serde_json::json!([])),
            ("bypass_rls", serde_json::Value::Null),
        ] {
            let mut role = report.clone();
            role[key] = wrong;
            assert!(!catalog_holds(&maintenance, &role).await.unwrap(), "{key}");
        }
        // NULL and infinity are no expiry; any other instant is one.
        let plain = serde_json::json!({"name":"pgcf_t_plain","owner":false});
        assert!(catalog_holds(&maintenance, &plain).await.unwrap());
        admin
            .client
            .batch_execute("ALTER ROLE pgcf_t_plain VALID UNTIL 'infinity'")
            .await
            .unwrap();
        assert!(catalog_holds(&maintenance, &plain).await.unwrap());
        admin
            .client
            .batch_execute("ALTER ROLE pgcf_t_plain VALID UNTIL '2031-01-02T03:04:05Z'")
            .await
            .unwrap();
        assert!(!catalog_holds(&maintenance, &plain).await.unwrap());
        admin
            .client
            .batch_execute("ALTER ROLE pgcf_t_plain VALID UNTIL 'infinity'")
            .await
            .unwrap();
        // Whether the role is there and can log in.
        assert!(matches!(
            held(&maintenance, "pgcf_t_report").await.unwrap(),
            Held::Login
        ));
        assert!(matches!(
            held(&maintenance, "pgcf_t_gone").await.unwrap(),
            Held::Absent
        ));
        admin
            .client
            .batch_execute("ALTER ROLE pgcf_t_report NOLOGIN")
            .await
            .unwrap();
        assert!(matches!(
            held(&maintenance, "pgcf_t_report").await.unwrap(),
            Held::NoLogin
        ));
        // What keeps DROP ROLE from succeeding, in any database.
        assert_eq!(
            dependencies(&maintenance, "pgcf_t_report").await.unwrap(),
            0
        );
        admin
            .client
            .batch_execute(
                "CREATE TABLE pgcf_t_object (id int); ALTER TABLE pgcf_t_object OWNER TO pgcf_t_report",
            )
            .await
            .unwrap();
        assert!(dependencies(&maintenance, "pgcf_t_report").await.unwrap() > 0);
        admin
            .client
            .batch_execute("DROP TABLE pgcf_t_object")
            .await
            .unwrap();
        assert_eq!(
            dependencies(&maintenance, "pgcf_t_report").await.unwrap(),
            0
        );
        // Without pg_signal_backend the sessions of a role stay, and that is not an error.
        let victim = session(host, port, "pgcf_t_plain").await;
        let weak = session(host, port, "pgcf_t_stats").await;
        assert!(!end_sessions(&weak, "pgcf_t_plain").await.unwrap());
        assert!(victim.client.simple_query("SELECT 1").await.is_ok());
        // With it they end, and the role's session count reaches zero.
        let mut none = false;
        for _ in 0..50 {
            none = end_sessions(&maintenance, "pgcf_t_plain").await.unwrap();
            if none {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert!(none, "the sessions of the role did not leave");
        assert!(victim.client.simple_query("SELECT 1").await.is_err());
        admin.client.batch_execute(teardown).await.unwrap();
    }
    /// A world whose record holds the role `report_job` beside `reader_query`, with the
    /// attributes `extra` states, and whose catalogs hold every role as the record states it.
    async fn world_with_role(extra: serde_json::Value) -> crate::test_sql::World {
        let mut w = crate::test_sql::World::awake().await;
        w.wake(3);
        let mut role = serde_json::json!({"name":"report_job","owner":false,"password":"q".repeat(43),"revision":3});
        for (key, value) in extra.as_object().unwrap() {
            role[key] = value.clone();
        }
        w.db["roles"].as_array_mut().unwrap().push(role);
        w.catalog_follows_desired();
        w
    }
    /// Whether every present role of the record logs in and holds what the record states.
    async fn verified(w: &crate::test_sql::World) -> Result<bool, Error> {
        roles(
            &w.db,
            w.authority.pem.as_bytes(),
            crate::test_sql::POD_IP,
            w.address(),
        )
        .await
    }
    /// An expiry `seconds` from now, in the contract's form (UTC, milliseconds).
    fn expiry_in(seconds: i64) -> String {
        let at = time::OffsetDateTime::now_utc() + time::Duration::seconds(seconds);
        let at = at.replace_nanosecond(0).unwrap();
        at.format(&time::format_description::well_known::Rfc3339)
            .unwrap()
            .replace('Z', ".000Z")
    }
    fn catalog_row(
        w: &crate::test_sql::World,
        role: &str,
        change: impl FnOnce(&mut crate::test_sql::RoleRow),
    ) {
        change(w.sql.lock().unwrap().roles.get_mut(role).unwrap());
    }
    fn log_has(w: &crate::test_sql::World, needle: &str) -> bool {
        w.log
            .lock()
            .unwrap()
            .iter()
            .any(|line| line.contains(needle))
    }
    /// A role that bypasses row security is verified by its own view of its privileges: it must
    /// bypass exactly where the record says, and a plain role must not.
    #[tokio::test]
    async fn a_role_must_bypass_row_security_exactly_where_the_record_says() {
        let w = world_with_role(serde_json::json!({"bypass_rls":true})).await;
        assert!(verified(&w).await.unwrap());
        catalog_row(&w, "report_job", |role| role.bypass_rls = false);
        assert!(
            !verified(&w).await.unwrap(),
            "the record asks for BYPASSRLS"
        );
        catalog_row(&w, "report_job", |role| role.bypass_rls = true);
        catalog_row(&w, "reader_query", |role| role.bypass_rls = true);
        assert!(
            !verified(&w).await.unwrap(),
            "a plain role bypasses nothing"
        );
    }
    /// PostgreSQL refuses the credential of an expired role, so its login proves nothing and
    /// cannot keep the database from becoming ready; the catalog still has to hold the expiry.
    #[tokio::test]
    async fn an_expired_role_is_not_logged_in_but_its_expiry_is_verified() {
        let w = world_with_role(serde_json::json!({"valid_until":expiry_in(-3600)})).await;
        w.sql.lock().unwrap().refused.insert(
            "report_job".into(),
            ("28P01", "password authentication failed"),
        );
        assert!(verified(&w).await.unwrap());
        assert!(!log_has(&w, "SQL report_job"), "no login was attempted");
        // The catalog still has to hold the expiry the record states.
        catalog_row(&w, "report_job", |role| role.valid_until = None);
        assert!(!verified(&w).await.unwrap());
    }
    /// An expiry a few seconds ahead is as good as passed by the time a client connects; one
    /// further ahead is logged in like any role, and a refused login is an error as before.
    #[tokio::test]
    async fn only_an_expiry_inside_ten_seconds_skips_the_login() {
        let refused = ("28P01", "password authentication failed");
        let soon = world_with_role(serde_json::json!({"valid_until":expiry_in(5)})).await;
        soon.sql
            .lock()
            .unwrap()
            .refused
            .insert("report_job".into(), refused);
        assert!(verified(&soon).await.unwrap());
        let later = world_with_role(serde_json::json!({"valid_until":expiry_in(120)})).await;
        later
            .sql
            .lock()
            .unwrap()
            .refused
            .insert("report_job".into(), refused);
        assert!(verified(&later).await.is_err());
        later.sql.lock().unwrap().refused.clear();
        assert!(verified(&later).await.unwrap());
        assert!(log_has(&later, "SQL report_job role login"));
    }
    /// PostgreSQL checks a role's connection limit only after the credential was accepted, so a
    /// login refused with 53300 proves the credential for a role that has a limit and nothing
    /// for a role that has none.
    #[tokio::test]
    async fn a_login_refused_at_the_connection_limit_has_authenticated_only_a_limited_role() {
        let limit = ("53300", "too many connections for role");
        let w = world_with_role(serde_json::json!({"connection_limit":1})).await;
        w.sql
            .lock()
            .unwrap()
            .refused
            .insert("report_job".into(), limit);
        assert!(verified(&w).await.unwrap());
        w.sql.lock().unwrap().refused.clear();
        w.sql
            .lock()
            .unwrap()
            .refused
            .insert("reader_query".into(), limit);
        assert!(verified(&w).await.is_err(), "reader_query has no limit");
    }
    /// The catalogs hold what the record states, to the precision the record has: an expiry to
    /// the whole second, a limit, the exact set of memberships and the ability to log in.
    #[tokio::test]
    async fn the_catalogs_must_hold_the_attributes_the_record_states() {
        let w = world_with_role(serde_json::json!({"valid_until":"2031-01-02T03:04:05.678Z","connection_limit":5,"member_of":["reader_query"],"bypass_rls":true})).await;
        assert!(verified(&w).await.unwrap());
        let at = Instant::At(
            time::OffsetDateTime::parse(
                "2031-01-02T03:04:05Z",
                &time::format_description::well_known::Rfc3339,
            )
            .unwrap()
            .unix_timestamp(),
            0,
        );
        assert_eq!(
            w.sql.lock().unwrap().roles["report_job"].valid_until,
            Some(at)
        );
        type Change = Box<dyn Fn(&mut crate::test_sql::RoleRow)>;
        let wrong: Vec<(&str, Change)> = vec![
            (
                "a limit that is not the record's",
                Box::new(|r| r.connection_limit = 4),
            ),
            ("no limit", Box::new(|r| r.connection_limit = -1)),
            (
                "an expiry a second later",
                Box::new(move |r| {
                    r.valid_until = Some(match at {
                        Instant::At(seconds, micros) => Instant::At(seconds + 1, micros),
                        other => other,
                    })
                }),
            ),
            ("no expiry", Box::new(|r| r.valid_until = None)),
            (
                "an infinite expiry",
                Box::new(|r| r.valid_until = Some(Instant::Infinity)),
            ),
            (
                "a past infinite expiry",
                Box::new(|r| r.valid_until = Some(Instant::NegativeInfinity)),
            ),
            ("a missing membership", Box::new(|r| r.member_of.clear())),
            (
                "an extra membership",
                Box::new(|r| r.member_of.push("pg_read_all_data".into())),
            ),
            (
                "another membership",
                Box::new(|r| r.member_of = vec!["other_job".into()]),
            ),
            ("a role that cannot log in", Box::new(|r| r.login = false)),
        ];
        for (reason, change) in wrong {
            let held_before = w.sql.lock().unwrap().roles["report_job"].clone();
            catalog_row(&w, "report_job", |role| change(role));
            assert!(!verified(&w).await.unwrap(), "{reason}");
            w.sql
                .lock()
                .unwrap()
                .roles
                .insert("report_job".into(), held_before);
        }
        // Held to the second the record has, which is the whole second of its milliseconds.
        assert!(verified(&w).await.unwrap());
        // A role PostgreSQL does not have is not verified.
        w.sql.lock().unwrap().roles.remove("report_job");
        assert!(!verified(&w).await.unwrap());
    }
    /// An infinite expiry is no expiry, as NULL is; a plain role with an expiry is not plain.
    #[tokio::test]
    async fn infinity_is_no_expiry_for_a_role_the_record_leaves_without_one() {
        let w = world_with_role(serde_json::json!({"connection_limit":5})).await;
        catalog_row(&w, "reader_query", |role| {
            role.valid_until = Some(Instant::Infinity)
        });
        assert!(verified(&w).await.unwrap());
        catalog_row(&w, "reader_query", |role| {
            role.valid_until = Some(Instant::At(1_900_000_000, 0))
        });
        assert!(!verified(&w).await.unwrap());
    }
    /// Without the maintenance credential nothing can read the catalogs: a record that states an
    /// attribute is not verified, and a plain record still is, by the logins alone.
    #[tokio::test]
    async fn attributes_cannot_be_verified_without_the_maintenance_credential() {
        let mut w = world_with_role(serde_json::json!({"connection_limit":5})).await;
        w.db.as_object_mut().unwrap().remove("maintenance");
        assert!(!verified(&w).await.unwrap());
        let mut plain = crate::test_sql::World::awake().await;
        plain.wake(3);
        plain.db.as_object_mut().unwrap().remove("maintenance");
        assert!(verified(&plain).await.unwrap());
    }
    /// A database whose roles are all plain is verified by its logins alone: no catalog is read.
    #[tokio::test]
    async fn a_database_of_plain_roles_reads_no_catalog() {
        let mut w = crate::test_sql::World::awake().await;
        w.wake(3);
        assert!(verified(&w).await.unwrap());
        assert!(
            !log_has(&w, "role attributes"),
            "{:?}",
            w.log.lock().unwrap()
        );
        assert!(!log_has(&w, "role memberships"));
    }
    /// A role awaiting removal has no credential: no login is attempted for it.
    #[tokio::test]
    async fn a_role_awaiting_removal_is_not_logged_in() {
        let mut w = crate::test_sql::World::awake().await;
        w.wake(3);
        w.db["roles"]
            .as_array_mut()
            .unwrap()
            .push(serde_json::json!({"name":"gone_job","state":"absent"}));
        assert!(verified(&w).await.unwrap());
        assert!(!log_has(&w, "SQL gone_job"));
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
