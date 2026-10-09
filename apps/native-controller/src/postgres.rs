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
        self.task.abort();
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
