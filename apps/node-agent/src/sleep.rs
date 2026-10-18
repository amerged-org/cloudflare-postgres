// SPDX-License-Identifier: Apache-2.0
//! The statements of the sleep proof (plan 7.9) on the agent's session with the database: the
//! guard (no busy session, no prepared transaction), the identity of the data directory, and the
//! WAL switch whose closed segment the archive must hold before the database stops. The flow that
//! orders them is `proof`; the statements are the contract's (`SLEEP_SQL`).
use crate::{Error, pg_control::Lsn, postgres};
use serde::{Deserialize, Serialize};
use serde_json::Value;

static POWER_CONTRACT: std::sync::LazyLock<Value> = std::sync::LazyLock::new(|| {
    serde_json::from_str(include_str!(
        "../../../packages/contracts/native/power.generated.json"
    ))
    .expect("generated power constants")
});
/// The sessions the sleep guard counts as busy, for the refusal's log line only.
pub(crate) const BUSY_SESSIONS: &str = "SELECT pg_catalog.left(pg_catalog.string_agg(pg_catalog.concat_ws('/', usename, application_name, state, backend_type), ','), 512) AS sessions FROM pg_catalog.pg_stat_activity WHERE datid IS NOT NULL AND pid <> pg_catalog.pg_backend_pid() AND (state IS DISTINCT FROM 'idle' OR xact_start IS NOT NULL)";
/// The size of a WAL segment of the cluster, in bytes.
const SEGMENT_BYTES: &str = "SELECT pg_catalog.pg_size_bytes(pg_catalog.current_setting('wal_segment_size'))::pg_catalog.int8 AS bytes";
pub(crate) fn sql(name: &str) -> &'static str {
    POWER_CONTRACT["constants"]["SLEEP_SQL"][name]
        .as_str()
        .expect("generated SQL")
}

/// Why a sleep is refused. The database stays awake and wakeable (plan 3.3, invariant 8).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refusal {
    /// A session is busy (`sql_busy`), or the gateway says one is (`not_quiescent`).
    Busy,
    /// A prepared transaction exists (`prepared_work`).
    Prepared,
    /// The state of the sessions cannot be read (`sql_unknown`).
    Unknown,
    /// The outcome of the WAL switch is not known (`switch_unknown`).
    SwitchUnknown,
    /// The archive did not hold the closed segment in time (`archive_timeout`).
    ArchiveTimeout,
}
impl Refusal {
    /// The name in the contract's `SLEEP_REFUSALS`.
    pub fn reason(self) -> &'static str {
        match self {
            Self::Busy => "sql_busy",
            Self::Prepared => "prepared_work",
            Self::Unknown => "sql_unknown",
            Self::SwitchUnknown => "switch_unknown",
            Self::ArchiveTimeout => "archive_timeout",
        }
    }
    /// The refusal an observation reports (`NodeDatabaseObservation.refusal`): the database was
    /// busy, or its archive did not drain.
    pub fn observation(self) -> &'static str {
        match self {
            Self::Busy | Self::Prepared => "power_busy",
            Self::Unknown | Self::SwitchUnknown | Self::ArchiveTimeout => "power_archive",
        }
    }
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
    /// What a row of `SERVER_IDENTITY_QUERY` says; `None` if it says none.
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

/// Whether `value` names a whole WAL segment: 24 upper-case hexadecimal digits.
pub fn is_segment(value: &str) -> bool {
    value.len() == 24
        && value
            .bytes()
            .all(|v| v.is_ascii_digit() || (b'A'..=b'F').contains(&v))
}

/// Why the database is not quiet, if it is not.
pub async fn guard(session: &postgres::Session) -> Result<Option<Refusal>, Error> {
    session.query(sql("CLEAR"), &[]).await?;
    let rows = session.query(sql("GUARD"), &[]).await?;
    if rows.len() != 1 {
        return Ok(Some(Refusal::Unknown));
    }
    let busy = rows[0].try_get::<_, i32>("busy").ok();
    let prepared = rows[0].try_get::<_, i32>("prepared").ok();
    if busy.is_none_or(|v| v < 0) || prepared.is_none_or(|v| v < 0) {
        return Ok(Some(Refusal::Unknown));
    }
    if prepared.is_some_and(|v| v > 0) {
        return Ok(Some(Refusal::Prepared));
    }
    if busy.is_some_and(|v| v > 0) {
        return Ok(Some(Refusal::Busy));
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

/// The size of a WAL segment of the running cluster.
pub async fn wal_segment_bytes(session: &postgres::Session) -> Option<u64> {
    let rows = session.query(SEGMENT_BYTES, &[]).await.ok()?;
    let bytes = u64::try_from(rows.first()?.try_get::<_, i64>("bytes").ok()?).ok()?;
    (bytes.is_power_of_two() && (1 << 20..=1 << 30).contains(&bytes)).then_some(bytes)
}

/// What one WAL switch did.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Switched {
    /// The position the switch returned: the first byte after the segment it closed.
    pub lsn: Lsn,
    /// The segment it closed, which holds every record written before the switch.
    pub segment: String,
}
/// Switches the WAL once, or says that the outcome is not known: a lost reply is never taken for a
/// switch, and the sleep is refused.
pub async fn switch(session: &postgres::Session) -> Result<Switched, Refusal> {
    let rows = session
        .query(sql("SWITCH"), &[])
        .await
        .map_err(|_| Refusal::SwitchUnknown)?;
    let [row] = rows.as_slice() else {
        return Err(Refusal::SwitchUnknown);
    };
    let lsn = row
        .try_get::<_, String>("lsn")
        .ok()
        .and_then(|lsn| Lsn::parse(&lsn))
        .filter(|lsn| lsn.0 != 0);
    let segment = row
        .try_get::<_, String>("segment")
        .ok()
        .filter(|segment| is_segment(segment));
    match (lsn, segment) {
        (Some(lsn), Some(segment)) => Ok(Switched { lsn, segment }),
        _ => Err(Refusal::SwitchUnknown),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{pg_control::Lsn, postgres, testpg::Cluster};

    async fn started(cluster: &Cluster) -> postgres::Session {
        cluster.start();
        cluster.agent().await
    }
    async fn client(cluster: &Cluster) -> postgres::Session {
        cluster.agent().await
    }

    #[tokio::test]
    async fn a_quiet_database_passes_the_guard_and_a_busy_one_names_why() {
        let Some(cluster) = Cluster::create("guard") else {
            return;
        };
        cluster.append_conf("max_prepared_transactions = 2\n");
        let agent = started(&cluster).await;
        assert_eq!(guard(&agent).await.unwrap(), None);

        // An open session that does nothing is not busy: only work is.
        let idle = client(&cluster).await;
        idle.batch("SELECT 1").await.unwrap();
        assert_eq!(guard(&agent).await.unwrap(), None);

        // A transaction left open is work, whatever it does not do.
        idle.batch("BEGIN").await.unwrap();
        assert_eq!(guard(&agent).await.unwrap(), Some(Refusal::Busy));
        assert!(
            busy_sessions(&agent)
                .await
                .unwrap()
                .contains("idle in transaction")
        );
        idle.batch("COMMIT").await.unwrap();
        assert_eq!(guard(&agent).await.unwrap(), None);

        // A statement that runs is work too.
        let running = client(&cluster).await;
        let long = tokio::spawn(async move { running.batch_long("SELECT pg_sleep(2)").await });
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        assert_eq!(guard(&agent).await.unwrap(), Some(Refusal::Busy));
        long.await.unwrap().unwrap();
        assert_eq!(guard(&agent).await.unwrap(), None);

        // A prepared transaction outlives its session and keeps the database awake.
        idle.batch("BEGIN; PREPARE TRANSACTION 'pgcf_t'")
            .await
            .unwrap();
        assert_eq!(guard(&agent).await.unwrap(), Some(Refusal::Prepared));
        idle.batch("COMMIT PREPARED 'pgcf_t'").await.unwrap();
        assert_eq!(guard(&agent).await.unwrap(), None);
    }

    #[tokio::test]
    async fn the_switch_closes_the_segment_the_proof_waits_for() {
        let Some(cluster) = Cluster::create("switch") else {
            return;
        };
        let agent = started(&cluster).await;
        let size = wal_segment_bytes(&agent).await.unwrap();
        assert_eq!(size, 16 << 20);
        let system = system(&agent).await.unwrap();
        assert_eq!(system.timeline, 1);
        agent
            .batch("CREATE TABLE t AS SELECT generate_series(1, 1000) AS a")
            .await
            .unwrap();
        let switched = switch(&agent).await.unwrap();
        assert_eq!(switched.segment.len(), 24);
        assert_eq!(&switched.segment[..8], "00000001");
        // The segment closed is the one before the position the switch returns.
        assert_eq!(
            switched.segment,
            switched.lsn.previous_byte().segment(1, size)
        );
        // Everything the proof reads agrees with the file on disk once the server has stopped.
        cluster.stop();
        let bytes = std::fs::read(cluster.data().join("global/pg_control")).unwrap();
        let file = crate::pg_control::parse_control_file(&bytes).unwrap();
        assert!(file.control.shut_down());
        assert_eq!(file.control.system_identifier, system.identifier);
        assert!(Lsn(file.checkpoint) >= switched.lsn);
    }
}
