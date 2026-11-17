// SPDX-License-Identifier: Apache-2.0
//! Explicitly selected extensions of a fresh tenant database, installed before it serves traffic.
use crate::{Error, postgres::Session};
use serde_json::Value;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ManagedExtension {
    Postgis,
    PgJsonschema,
}

impl ManagedExtension {
    pub(crate) fn parse(names: Option<&Value>) -> Option<Vec<Self>> {
        let Some(names) = names else {
            return Some(Vec::new());
        };
        let mut extensions = Vec::new();
        for name in names.as_array()? {
            let extension = match name.as_str()? {
                "postgis" => Self::Postgis,
                "pg_jsonschema" => Self::PgJsonschema,
                _ => return None,
            };
            if extensions.contains(&extension) {
                return None;
            }
            extensions.push(extension);
        }
        Some(extensions)
    }

    fn installation(self) -> (&'static str, &'static str, &'static str) {
        match self {
            Self::Postgis => (
                "postgis",
                "3.7.0",
                "CREATE EXTENSION IF NOT EXISTS postgis WITH SCHEMA pgcf_extensions VERSION '3.7.0'",
            ),
            Self::PgJsonschema => (
                "pg_jsonschema",
                "0.3.4",
                "CREATE EXTENSION IF NOT EXISTS pg_jsonschema WITH SCHEMA pgcf_extensions VERSION '0.3.4'",
            ),
        }
    }
}

const SCHEMA_CHECK: &str = "
SELECT n.nspowner = 'postgres'::regrole
  AND NOT EXISTS (
    SELECT FROM pg_catalog.aclexplode(COALESCE(n.nspacl, pg_catalog.acldefault('n', n.nspowner))) a
    WHERE a.grantee <> n.nspowner AND (a.privilege_type <> 'USAGE' OR a.is_grantable)
  )
FROM pg_catalog.pg_namespace n WHERE n.nspname = 'pgcf_extensions'";

const EXTENSION_CHECK: &str = "
SELECT e.extversion = $2 AND n.nspname = 'pgcf_extensions' AND e.extowner = 'postgres'::regrole
FROM pg_catalog.pg_extension e JOIN pg_catalog.pg_namespace n ON n.oid = e.extnamespace
WHERE e.extname = $1";

/// Use the agent's peer-authenticated session on the tenant database before first backup and Ready.
/// A retry accepts only an installation with the expected catalog version, owner and schema.
pub(crate) async fn install(
    session: &Session,
    extensions: &[ManagedExtension],
) -> Result<(), Error> {
    if extensions.is_empty() {
        return Ok(());
    }
    session.batch("BEGIN").await?;
    match install_within(session, extensions).await {
        Ok(()) => session.batch("COMMIT").await,
        Err(error) => {
            let _ = session.batch("ROLLBACK").await;
            Err(error)
        }
    }
}

async fn install_within(session: &Session, extensions: &[ManagedExtension]) -> Result<(), Error> {
    session
        .batch(
            "SET LOCAL search_path = pg_catalog;
             CREATE SCHEMA IF NOT EXISTS pgcf_extensions AUTHORIZATION postgres",
        )
        .await?;
    let schema = session.query(SCHEMA_CHECK, &[]).await?;
    if !schema.first().is_some_and(|row| row.get::<_, bool>(0)) {
        return Err("managed extension schema is not protected".into());
    }
    session
        .batch("GRANT USAGE ON SCHEMA pgcf_extensions TO PUBLIC")
        .await?;
    for extension in extensions {
        let (name, version, statement) = extension.installation();
        session.batch_long(statement).await?;
        let catalog = session.query(EXTENSION_CHECK, &[&name, &version]).await?;
        if !catalog.first().is_some_and(|row| row.get::<_, bool>(0)) {
            return Err(
                "managed extension catalog does not match the requested installation".into(),
            );
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testpg::Cluster;

    #[tokio::test]
    async fn opt_in_refuses_a_schema_the_database_owner_can_write() {
        let Some(cluster) = Cluster::create("extschema") else {
            return;
        };
        cluster.start();
        let session = cluster.agent().await;
        install(&session, &[]).await.unwrap();
        assert!(session.query(SCHEMA_CHECK, &[]).await.unwrap().is_empty());

        session
            .batch(
                "CREATE ROLE app;
                 CREATE SCHEMA pgcf_extensions AUTHORIZATION postgres;
                 GRANT CREATE ON SCHEMA pgcf_extensions TO app",
            )
            .await
            .unwrap();
        let error = install(&session, &[ManagedExtension::Postgis])
            .await
            .unwrap_err();
        assert_eq!(
            error.to_string(),
            "managed extension schema is not protected"
        );
        assert!(!session.query(SCHEMA_CHECK, &[]).await.unwrap()[0].get::<_, bool>(0));
        assert!(
            session
                .query(
                    "SELECT FROM pg_catalog.pg_extension WHERE extname = 'postgis'",
                    &[]
                )
                .await
                .unwrap()
                .is_empty()
        );
    }
}
