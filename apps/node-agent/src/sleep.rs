// SPDX-License-Identifier: Apache-2.0
//! The proof of a clean sleep on the database's own session: the role is the maintenance role on
//! the primary, nothing is busy and no transaction is prepared, the WAL is switched and the closed
//! segment is archived. The caller records "switching" durably before `switch` and the closed
//! segment after it: a lost outcome of the switch is never dispatched again.
use crate::{Error, contracts::text, postgres};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;

static POWER_CONTRACT: std::sync::LazyLock<Value> = std::sync::LazyLock::new(|| {
    serde_json::from_str(include_str!(
        "../../../packages/contracts/native/power.generated.json"
    ))
    .expect("generated power constants")
});
/// The sessions the sleep guard counts as busy, for the refusal's log line only.
pub(crate) const BUSY_SESSIONS: &str = "SELECT pg_catalog.left(pg_catalog.string_agg(pg_catalog.concat_ws('/', usename, application_name, state, backend_type), ','), 512) AS sessions FROM pg_catalog.pg_stat_activity WHERE datid IS NOT NULL AND pid <> pg_catalog.pg_backend_pid() AND (state IS DISTINCT FROM 'idle' OR xact_start IS NOT NULL)";
pub(crate) fn sql(name: &str) -> &'static str {
    POWER_CONTRACT["constants"]["SLEEP_SQL"][name]
        .as_str()
        .expect("generated SQL")
}
/// The data directory a postmaster runs on: the system identifier of its `pg_control` and the
/// timeline of its latest checkpoint (see `postgres::SERVER_IDENTITY_QUERY`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SystemIdentity {
    pub identifier: String,
    pub timeline: i32,
}
impl SystemIdentity {
    /// What a row of `SERVER_IDENTITY_QUERY` or of `ACCEPTING_QUERY` says; `None` if it says none.
    pub fn of(row: &tokio_postgres::Row) -> Option<Self> {
        let identifier = row.try_get::<_, String>("system_identifier").ok()?;
        let timeline = row.try_get::<_, i32>("timeline").ok()?;
        Self::valid(&identifier, timeline).then_some(Self {
            identifier,
            timeline,
        })
    }
    /// An identifier is the 64-bit number `initdb` drew, in decimal; timelines count from 1.
    fn valid(identifier: &str, timeline: i32) -> bool {
        (1..=20).contains(&identifier.len())
            && identifier.bytes().all(|b| b.is_ascii_digit())
            && timeline >= 1
    }
}
fn segment(value: &str) -> bool {
    value.len() == 24
        && value
            .bytes()
            .all(|v| v.is_ascii_digit() || (b'A'..=b'F').contains(&v))
}
/// Why the database is not quiet, if it is not: `prepared_work`, `sql_busy` or `sql_unknown`.
pub async fn guard(session: &postgres::Session) -> Result<Option<&'static str>, Error> {
    session.query(sql("CLEAR"), &[]).await?;
    let rows = session.query(sql("GUARD"), &[]).await?;
    if rows.len() != 1 {
        return Ok(Some("sql_unknown"));
    }
    let busy = rows[0].try_get::<_, i32>("busy").ok();
    let prepared = rows[0].try_get::<_, i32>("prepared").ok();
    if busy.is_none_or(|v| v < 0) || prepared.is_none_or(|v| v < 0) {
        return Ok(Some("sql_unknown"));
    }
    if prepared.is_some_and(|v| v > 0) {
        return Ok(Some("prepared_work"));
    }
    if busy.is_some_and(|v| v > 0) {
        return Ok(Some("sql_busy"));
    }
    Ok(None)
}
/// Whether the session is the maintenance role `role` on the writable primary of `db` over a
/// connection the proof may trust; `probe_unavailable` when it is not.
pub async fn identity(
    session: &postgres::Session,
    db: &Value,
    role: &str,
) -> Result<Option<&'static str>, Error> {
    let rows = session.query(sql("IDENTITY"), &[&role]).await?;
    if rows.len() != 1
        || rows[0].try_get::<_, String>("database").ok().as_deref() != Some(text(db, "id"))
        || rows[0].try_get::<_, bool>("recovery").ok() != Some(false)
        || rows[0].try_get::<_, bool>("tls").ok() != Some(true)
        || rows[0].try_get::<_, bool>("stats").ok() != Some(true)
        || [
            "rolsuper",
            "rolcreatedb",
            "rolcreaterole",
            "rolreplication",
            "rolbypassrls",
        ]
        .iter()
        .any(|name| rows[0].try_get::<_, bool>(*name).ok() != Some(false))
    {
        return Ok(Some("probe_unavailable"));
    }
    Ok(None)
}
/// The sessions that kept the database busy (`role/application/state/backend type`), when they
/// can be read, for the refusal's log line only.
pub async fn busy_sessions(session: &postgres::Session) -> Option<String> {
    session
        .query(BUSY_SESSIONS, &[])
        .await
        .ok()
        .and_then(|rows| {
            rows.first()?
                .try_get::<_, Option<String>>("sessions")
                .ok()?
        })
}
/// The data directory the postmaster runs on, while it runs; `None` if it does not say.
pub async fn system(session: &postgres::Session) -> Option<SystemIdentity> {
    session
        .query(postgres::SERVER_IDENTITY_QUERY, &[])
        .await
        .ok()
        .and_then(|rows| match rows.as_slice() {
            [row] => SystemIdentity::of(row),
            _ => None,
        })
}
/// Switches the WAL once: the closed segment, or `switch_unknown` when the outcome is not known.
pub async fn switch(session: &postgres::Session) -> Result<String, &'static str> {
    let rows = match session.query(sql("SWITCH"), &[]).await {
        Ok(rows) => rows,
        Err(_) => return Err("switch_unknown"),
    };
    if rows.len() != 1 {
        return Err("switch_unknown");
    }
    let lsn = rows[0].try_get::<_, String>("lsn").ok();
    let closed = rows[0].try_get::<_, String>("segment").ok();
    let valid_lsn = lsn.as_deref().is_some_and(|v| {
        v != "0/0"
            && v.split_once('/').is_some_and(|(a, b)| {
                !a.is_empty()
                    && !b.is_empty()
                    && a.bytes()
                        .chain(b.bytes())
                        .all(|v| v.is_ascii_digit() || (b'A'..=b'F').contains(&v))
            })
    });
    if !valid_lsn || closed.as_deref().is_none_or(|v| !segment(v)) {
        return Err("switch_unknown");
    }
    closed.ok_or("switch_unknown")
}
/// Waits until the archiver has the closed `segment`: `sql_unknown` when its status cannot be read.
pub async fn archived(
    session: &postgres::Session,
    segment: &str,
) -> Result<Option<&'static str>, Error> {
    let filename = format!("{segment}.done");
    loop {
        let rows = session.query(sql("ARCHIVE_STATUS"), &[&filename]).await?;
        if rows.len() != 1 {
            return Ok(Some("sql_unknown"));
        }
        match rows[0].try_get::<_, bool>("done") {
            Ok(true) => break,
            Ok(false) => tokio::time::sleep(Duration::from_millis(250)).await,
            Err(_) => return Ok(Some("sql_unknown")),
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_sql::World;

    async fn maintenance(w: &World) -> postgres::Session {
        postgres::maintenance(&w.db, w.authority.pem.as_bytes(), w.address())
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn a_quiet_database_is_proved_by_its_switched_and_archived_segment() {
        let mut w = World::awake().await;
        w.wake(3);
        let session = maintenance(&w).await;
        let role = text(&w.db["maintenance"], "role");
        assert_eq!(identity(&session, &w.db, role).await.unwrap(), None);
        assert_eq!(guard(&session).await.unwrap(), None);
        assert_eq!(
            system(&session).await,
            Some(SystemIdentity {
                identifier: "7430000000000000001".into(),
                timeline: 1
            })
        );
        let closed = switch(&session).await.unwrap();
        assert_eq!(closed, "0000000100000000000000A7");
        assert_eq!(archived(&session, &closed).await.unwrap(), None);
    }

    #[tokio::test]
    async fn busy_or_prepared_work_refuses_the_sleep_and_says_which_session() {
        let mut w = World::awake().await;
        w.wake(3);
        let session = maintenance(&w).await;
        w.sql.lock().unwrap().busy = 1;
        assert_eq!(guard(&session).await.unwrap(), Some("sql_busy"));
        assert_eq!(
            busy_sessions(&session).await.as_deref(),
            Some("app/psql/active/client backend")
        );
        w.sql.lock().unwrap().prepared = 1;
        assert_eq!(guard(&session).await.unwrap(), Some("prepared_work"));
    }

    #[tokio::test]
    async fn the_archive_wait_ends_only_when_the_closed_segment_is_done() {
        let mut w = World::awake().await;
        w.wake(3);
        let session = maintenance(&w).await;
        w.sql.lock().unwrap().archived = false;
        let segment = "0000000100000000000000A7";
        assert!(
            tokio::time::timeout(Duration::from_millis(600), archived(&session, segment))
                .await
                .is_err()
        );
        w.sql.lock().unwrap().archived = true;
        assert_eq!(archived(&session, segment).await.unwrap(), None);
        // A segment name the server does not produce is not a switch.
        w.sql.lock().unwrap().segment = "0000000100000000000000a7".into();
        assert_eq!(switch(&session).await, Err("switch_unknown"));
    }
}
