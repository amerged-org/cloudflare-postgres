// SPDX-License-Identifier: Apache-2.0
//! The platform schema `pgcf` of a tenant database (plan database-events-and-schedules 4.5): the
//! outbox that `pgcf.emit` and the `pgcf.capture` trigger write, and the agent's access to it. The
//! agent installs the schema as the cluster's superuser, configures its limits, and drains the
//! outbox over its own events session. Its objects belong to the platform role (`PLATFORM_ROLE`),
//! which can log in to nothing, so a tenant can reach them only through the functions it is granted.
use crate::{
    Error,
    postgres::{self, Session},
};
use serde::{Deserialize, Serialize};
use std::{path::Path, sync::Arc};
use tokio::sync::Notify;

/// The revision of `schema.sql`, which is also its first line.
pub const SCHEMA_REVISION: u32 = 1;
/// The role that owns the platform schema and its objects.
pub const PLATFORM_ROLE: &str = "pgcf-events";
/// The channel `pgcf.emit` notifies after each row, so the drain wakes up.
pub const CHANNEL: &str = "pgcf_outbox";
/// The platform schema, run between `BEGIN` and `COMMIT` by `install`.
const SCHEMA: &str = include_str!("pgcf/schema.sql");

/// The limits and the storage generation (epoch) that `pgcf.emit` stamps on each row.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Settings {
    pub epoch: u64,
    pub max_payload_bytes: u64,
    pub max_outbox_rows: u64,
}

/// Whether `install` made the schema, or left a schema named `pgcf` that a tenant owns alone.
#[derive(Debug, PartialEq, Eq)]
pub enum Installed {
    Done,
    Conflict,
}

/// One outbox row as the drain reads it: the payload as JSON text (`None` when it is longer than
/// the ceiling the read was given) and the emit time in milliseconds since the Unix epoch.
pub struct Row {
    pub seq: i64,
    pub epoch: i64,
    pub topic: String,
    pub payload: Option<String>,
    pub at_ms: i64,
}

/// The events of a database as the agent's marker file records them.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EventsRecord {
    pub v: u32,
    pub schema: u32,
    pub epoch: u64,
    pub max_payload_bytes: u64,
    pub max_outbox_rows: u64,
    pub conflict: bool,
}
impl EventsRecord {
    pub fn of(settings: &Settings, conflict: bool) -> Self {
        Self {
            v: 1,
            schema: SCHEMA_REVISION,
            epoch: settings.epoch,
            max_payload_bytes: settings.max_payload_bytes,
            max_outbox_rows: settings.max_outbox_rows,
            conflict,
        }
    }
}

/// The events session of `database`. When the tenant has closed its database to connections
/// (`ALLOW_CONNECTIONS false`, which the superuser is refused too), the agent's session on the
/// maintenance database opens it again, and the events session is tried once more.
pub async fn connect(
    socket_directory: &Path,
    database: &str,
    notify: Option<Arc<Notify>>,
) -> Result<Session, Error> {
    let error = match postgres::connect_events(socket_directory, database, notify.clone()).await {
        Ok(session) => return Ok(session),
        Err(error) => error,
    };
    let Ok(agent) = postgres::agent(socket_directory).await else {
        return Err(error);
    };
    let closed = agent.query(CLOSED_QUERY, &[&database]).await?;
    let Some(row) = closed.first() else {
        return Err(error);
    };
    let name: String = row.try_get(0)?;
    agent
        .batch(&format!(
            "ALTER DATABASE {name} WITH ALLOW_CONNECTIONS true"
        ))
        .await?;
    postgres::connect_events(socket_directory, database, notify).await
}
/// The quoted name of `database` when it does not accept connections.
const CLOSED_QUERY: &str = "SELECT pg_catalog.quote_ident(datname)::pg_catalog.text FROM pg_catalog.pg_database WHERE datname = $1 AND NOT datallowconn";

/// Whether the database has a schema `pgcf` that no superuser owns: `install` then leaves it
/// alone. The schema and its tables belong to a superuser so that no role the tenant's code runs as
/// can attach a trigger or a rule to the outbox, which the drain reads and empties as a superuser.
pub async fn conflict(session: &Session) -> Result<bool, Error> {
    let rows = session.query(CONFLICT_QUERY, &[]).await?;
    Ok(rows[0].get::<_, bool>(0))
}
const CONFLICT_QUERY: &str = "SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspname = 'pgcf' AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.oid = n.nspowner AND r.rolsuper))";

/// Makes the platform schema of the database, with `settings`. A schema that exists keeps its
/// rows; `truncate` empties the outbox and restarts its sequence. A foreign schema `pgcf` is never
/// touched.
pub async fn install(
    session: &Session,
    settings: &Settings,
    truncate: bool,
) -> Result<Installed, Error> {
    if conflict(session).await? {
        return Ok(Installed::Conflict);
    }
    session.batch("BEGIN").await?;
    match install_within(session, settings, truncate).await {
        Ok(()) => {
            session.batch("COMMIT").await?;
            Ok(Installed::Done)
        }
        Err(error) => {
            let _ = session.batch("ROLLBACK").await;
            Err(error)
        }
    }
}
async fn install_within(
    session: &Session,
    settings: &Settings,
    truncate: bool,
) -> Result<(), Error> {
    session.batch(SCHEMA).await?;
    configure(session, settings).await?;
    if truncate {
        session
            .batch("TRUNCATE ONLY pgcf.outbox RESTART IDENTITY")
            .await?;
    }
    Ok(())
}

/// Sets the limits and the epoch that `pgcf.emit` reads.
pub async fn configure(session: &Session, settings: &Settings) -> Result<(), Error> {
    session
        .query(
            CONFIGURE_QUERY,
            &[
                &i64::try_from(settings.epoch)?,
                &i64::try_from(settings.max_payload_bytes)?,
                &i64::try_from(settings.max_outbox_rows)?,
            ],
        )
        .await?;
    Ok(())
}
const CONFIGURE_QUERY: &str = "INSERT INTO pgcf.settings (singleton, epoch, max_payload_bytes, max_outbox_rows) VALUES (true, $1, $2, $3) ON CONFLICT (singleton) DO UPDATE SET epoch = EXCLUDED.epoch, max_payload_bytes = EXCLUDED.max_payload_bytes, max_outbox_rows = EXCLUDED.max_outbox_rows";

/// Whether the database has the platform's own `pgcf.outbox`: the schema and the table belong to a
/// superuser. A drain reads and empties the outbox only where this holds.
pub async fn owned(session: &Session) -> Result<bool, Error> {
    let rows = session.query(OWNED_QUERY, &[]).await?;
    Ok(rows[0].get::<_, bool>(0))
}
const OWNED_QUERY: &str = "SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace JOIN pg_catalog.pg_roles r ON r.oid = c.relowner JOIN pg_catalog.pg_roles s ON s.oid = n.nspowner WHERE n.nspname = 'pgcf' AND c.relname = 'outbox' AND c.relkind = 'r' AND r.rolsuper AND s.rolsuper)";

/// Whether the outbox holds rows. A database without the platform's own `pgcf.outbox` has none.
pub async fn outbox_pending(session: &Session) -> Result<bool, Error> {
    if !owned(session).await? {
        return Ok(false);
    }
    let rows = session.query(PENDING_QUERY, &[]).await?;
    Ok(rows[0].get::<_, bool>(0))
}
const PENDING_QUERY: &str = "SELECT EXISTS (SELECT 1 FROM ONLY pgcf.outbox)";

/// The oldest `limit` rows, in sequence order. A payload longer than `max_payload_bytes` as text
/// arrives as `None`, so a row the tenant stored far over the ceiling never enters the agent's
/// memory. The time is clamped to the years 1970 to 9999 (a row can hold `infinity` or a date
/// before the epoch).
pub async fn read_batch(
    session: &Session,
    limit: i64,
    max_payload_bytes: i64,
) -> Result<Vec<Row>, Error> {
    let rows = session
        .query(READ_QUERY, &[&limit, &max_payload_bytes])
        .await?;
    rows.iter().map(row).collect()
}
fn row(row: &tokio_postgres::Row) -> Result<Row, Error> {
    Ok(Row {
        seq: row.try_get("seq")?,
        epoch: row.try_get("epoch")?,
        topic: row.try_get("topic")?,
        payload: row.try_get("payload")?,
        at_ms: row.try_get("at_ms")?,
    })
}
const READ_QUERY: &str = "SELECT seq, epoch, topic, CASE WHEN pg_catalog.octet_length(payload::pg_catalog.text) <= $2::pg_catalog.int8 THEN payload::pg_catalog.text END AS payload, pg_catalog.round(pg_catalog.date_part('epoch', LEAST(GREATEST(emitted_at, 'epoch'::pg_catalog.timestamptz), '9999-12-31 23:59:59.999+00'::pg_catalog.timestamptz)) * 1000)::pg_catalog.int8 AS at_ms FROM ONLY pgcf.outbox ORDER BY seq LIMIT $1";

/// Removes the rows with these sequence numbers, and returns how many went.
pub async fn delete(session: &Session, seqs: &[i64]) -> Result<u64, Error> {
    let rows = session.query(DELETE_QUERY, &[&seqs]).await?;
    Ok(u64::try_from(rows.len())?)
}
const DELETE_QUERY: &str =
    "DELETE FROM ONLY pgcf.outbox WHERE seq = ANY($1::pg_catalog.int8[]) RETURNING seq";

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        layout::PORT,
        node_link::constant,
        roles::OWNER_ROLE,
        settings::AGENT_ROLE,
        testpg::{Cluster, password},
    };
    use serde_json::{Value, json};

    const SETTINGS: Settings = Settings {
        epoch: 1,
        max_payload_bytes: 54_000,
        max_outbox_rows: 1_000,
    };

    /// A started cluster with the roles `app` (password seed 1) and `reader` (seed 2) and the
    /// database `tenant` that `app` owns, as the platform makes a tenant's database.
    async fn cluster_with_tenant(label: &str) -> Option<Cluster> {
        let cluster = Cluster::create(label)?;
        cluster.start();
        let agent = cluster.agent().await;
        agent
            .batch(&format!(
                "CREATE ROLE app LOGIN PASSWORD '{}'; CREATE ROLE reader LOGIN PASSWORD '{}'",
                password(1),
                password(2)
            ))
            .await
            .unwrap();
        agent
            .batch_long("CREATE DATABASE tenant OWNER app")
            .await
            .unwrap();
        Some(cluster)
    }
    /// A session as `role` (password seed `seed`) on the tenant database, by its password.
    async fn as_role(cluster: &Cluster, role: &str, seed: u8) -> tokio_postgres::Client {
        let mut config = tokio_postgres::Config::new();
        config
            .host_path(cluster.socket_directory())
            .port(PORT)
            .user(role)
            .password(password(seed))
            .dbname("tenant");
        let (client, connection) = config.connect(tokio_postgres::NoTls).await.unwrap();
        tokio::spawn(connection);
        client
    }
    async fn events(cluster: &Cluster) -> Session {
        connect(&cluster.socket_directory(), "tenant", None)
            .await
            .unwrap()
    }
    async fn count(session: &Session) -> i64 {
        let rows = session
            .query("SELECT count(*) FROM pgcf.outbox", &[])
            .await
            .unwrap();
        rows[0].get(0)
    }
    /// The SQLSTATE of a failed statement.
    fn state(error: &tokio_postgres::Error) -> String {
        error
            .code()
            .unwrap_or_else(|| panic!("not a database error: {error}"))
            .code()
            .to_string()
    }
    /// The state of `sql` run in a transaction that is then rolled back, so that a statement that
    /// needs one (`LOCK`) can run.
    async fn refused(client: &tokio_postgres::Client, sql: &str) -> String {
        let error = client
            .batch_execute(&format!("BEGIN; {sql}"))
            .await
            .expect_err(sql);
        client.batch_execute("ROLLBACK").await.unwrap();
        state(&error)
    }
    /// An object of `depth` nested containers: objects, or arrays inside an object.
    fn nested(depth: usize, arrays: bool) -> String {
        if arrays {
            format!(
                "{{\"a\":{}1{}}}",
                "[".repeat(depth - 1),
                "]".repeat(depth - 1)
            )
        } else {
            format!("{}1{}", "{\"a\":".repeat(depth), "}".repeat(depth))
        }
    }

    #[test]
    fn the_schema_is_the_revision_it_declares_and_runs_no_dynamic_sql() {
        assert_eq!(
            SCHEMA.lines().next(),
            Some(format!("-- pgcf-schema-revision: {SCHEMA_REVISION}").as_str())
        );
        assert!(!SCHEMA.contains("format("));
        assert!(
            !SCHEMA
                .lines()
                .any(|line| line.trim_start().starts_with("EXECUTE "))
        );
    }
    #[test]
    fn the_schema_grants_emit_to_the_owner_role_and_rejects_the_contract_depth() {
        assert!(SCHEMA.contains(&format!("TO \"{OWNER_ROLE}\" WITH GRANT OPTION")));
        let depth = constant("NODE_DATA_EVENT_DEPTH_MAX").as_u64().unwrap();
        assert!(SCHEMA.contains(&format!("'$.**{{{} to last}}'", depth + 1)));
    }
    #[test]
    fn the_outbox_checks_pin_the_contract_ceiling_and_depth() {
        let payload_max = constant("NODE_DATA_EVENT_PAYLOAD_MAX_BYTES");
        let depth = constant("NODE_DATA_EVENT_DEPTH_MAX").as_u64().unwrap();
        assert!(SCHEMA.contains(&format!(
            "CHECK (pg_catalog.octet_length(payload::pg_catalog.text) <= {payload_max})"
        )));
        assert!(SCHEMA.contains(&format!(
            "NOT pg_catalog.jsonb_path_exists(payload, '$.**{{{} to last}}')",
            depth + 1
        )));
    }
    #[test]
    fn the_events_record_round_trips_and_refuses_unknown_fields() {
        let record = EventsRecord::of(&SETTINGS, true);
        assert_eq!((record.v, record.schema), (1, SCHEMA_REVISION));
        let text = serde_json::to_string(&record).unwrap();
        assert_eq!(serde_json::from_str::<EventsRecord>(&text).unwrap(), record);
        let extra = text.replacen('{', "{\"extra\":1,", 1);
        assert!(serde_json::from_str::<EventsRecord>(&extra).is_err());
    }

    #[tokio::test]
    async fn install_is_idempotent_and_keeps_rows() {
        let Some(cluster) = cluster_with_tenant("pgcf-install").await else {
            return;
        };
        let session = events(&cluster).await;
        assert_eq!(
            install(&session, &SETTINGS, false).await.unwrap(),
            Installed::Done
        );
        as_role(&cluster, "app", 1)
            .await
            .batch_execute("SELECT pgcf.emit('orders', '{}')")
            .await
            .unwrap();
        assert_eq!(
            install(&session, &SETTINGS, false).await.unwrap(),
            Installed::Done
        );
        assert_eq!(count(&session).await, 1);
    }

    #[tokio::test]
    async fn install_with_truncate_empties_the_outbox_and_restarts_the_sequence() {
        let Some(cluster) = cluster_with_tenant("pgcf-truncate").await else {
            return;
        };
        let session = events(&cluster).await;
        install(&session, &SETTINGS, false).await.unwrap();
        let app = as_role(&cluster, "app", 1).await;
        app.batch_execute("SELECT pgcf.emit('orders', '{}')")
            .await
            .unwrap();
        install(&session, &SETTINGS, true).await.unwrap();
        assert_eq!(count(&session).await, 0);
        let rows = app
            .query("SELECT pgcf.emit('orders', '{}')", &[])
            .await
            .unwrap();
        assert_eq!(rows[0].get::<_, i64>(0), 1);
    }

    #[tokio::test]
    async fn configure_assigns_the_epoch_and_the_limits_at_every_install() {
        let Some(cluster) = cluster_with_tenant("pgcf-configure").await else {
            return;
        };
        let session = events(&cluster).await;
        install(&session, &SETTINGS, false).await.unwrap();
        let app = as_role(&cluster, "app", 1).await;
        app.batch_execute("SELECT pgcf.emit('orders', '{}')")
            .await
            .unwrap();
        let small = Settings {
            epoch: 2,
            max_payload_bytes: 100,
            max_outbox_rows: 2,
        };
        install(&session, &small, false).await.unwrap();
        app.batch_execute("SELECT pgcf.emit('orders', '{}')")
            .await
            .unwrap();
        let epochs = |rows: &[Row]| rows.iter().map(|row| row.epoch).collect::<Vec<_>>();
        assert_eq!(
            epochs(&read_batch(&session, 10, i64::MAX).await.unwrap()),
            [1, 2]
        );
        let oversized = format!(
            "SELECT pgcf.emit('orders', '{{\"x\":\"{}\"}}')",
            "a".repeat(100)
        );
        let error = app.batch_execute(&oversized).await.unwrap_err();
        assert_eq!(state(&error), "54000");
        let error = app
            .batch_execute("SELECT pgcf.emit('orders', '{}')")
            .await
            .unwrap_err();
        assert_eq!(state(&error), "53400");
        assert_eq!(delete(&session, &[1]).await.unwrap(), 1);
        install(&session, &SETTINGS, false).await.unwrap();
        app.batch_execute("SELECT pgcf.emit('orders', '{}')")
            .await
            .unwrap();
        assert_eq!(
            epochs(&read_batch(&session, 10, i64::MAX).await.unwrap()),
            [2, 1]
        );
    }

    #[tokio::test]
    async fn the_tenant_reaches_the_platform_only_through_its_grants() {
        let Some(cluster) = cluster_with_tenant("pgcf-grants").await else {
            return;
        };
        install(&events(&cluster).await, &SETTINGS, false)
            .await
            .unwrap();
        let app = as_role(&cluster, "app", 1).await;
        let reader = as_role(&cluster, "reader", 2).await;
        let set_role = format!("SET ROLE \"{PLATFORM_ROLE}\"");
        let denied = [
            "SELECT * FROM pgcf.outbox",
            "INSERT INTO pgcf.outbox (epoch, topic, payload) VALUES (1, 'orders', '{}')",
            "UPDATE pgcf.outbox SET topic = 'orders'",
            "DELETE FROM pgcf.outbox",
            "TRUNCATE pgcf.outbox",
            "LOCK TABLE pgcf.outbox",
            "SELECT * FROM pgcf.settings",
            "INSERT INTO pgcf.settings (singleton, epoch, max_payload_bytes, max_outbox_rows) VALUES (true, 1, 1, 1)",
            "UPDATE pgcf.settings SET max_outbox_rows = 1000000",
            "DELETE FROM pgcf.settings",
            "TRUNCATE pgcf.settings",
            "LOCK TABLE pgcf.settings",
            "CREATE TABLE pgcf.extra (a int)",
            "DROP SCHEMA pgcf CASCADE",
            "CREATE OR REPLACE FUNCTION pgcf.emit(topic text, payload jsonb) RETURNS bigint LANGUAGE sql AS 'SELECT 1'",
            "ALTER FUNCTION pgcf.emit(text, jsonb) SET search_path = public",
            set_role.as_str(),
            "CREATE TRIGGER hijack AFTER INSERT ON pgcf.outbox FOR EACH ROW EXECUTE FUNCTION pgcf.capture('seq')",
        ];
        for sql in denied {
            assert_eq!(refused(&app, sql).await, "42501", "app: {sql}");
            assert_eq!(refused(&reader, sql).await, "42501", "reader: {sql}");
        }
        assert_eq!(
            reader
                .batch_execute("SELECT pgcf.emit('orders', '{}')")
                .await
                .map_err(|error| state(&error)),
            Err("42501".to_string())
        );
        app.batch_execute("GRANT EXECUTE ON FUNCTION pgcf.emit(text, jsonb) TO reader")
            .await
            .unwrap();
        reader
            .batch_execute("SELECT pgcf.emit('orders', '{}')")
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn the_platform_role_adds_and_reads_rows_and_changes_nothing_else() {
        let Some(cluster) = cluster_with_tenant("pgcf-platform-role").await else {
            return;
        };
        let session = events(&cluster).await;
        install(&session, &SETTINGS, false).await.unwrap();
        session
            .batch(&format!("SET ROLE \"{PLATFORM_ROLE}\""))
            .await
            .unwrap();
        for sql in [
            "INSERT INTO pgcf.outbox (epoch, topic, payload) VALUES (1, 'orders', '{}')",
            "SELECT * FROM pgcf.outbox",
            "SELECT * FROM pgcf.settings",
        ] {
            session
                .batch(&format!("BEGIN; {sql}; ROLLBACK"))
                .await
                .unwrap_or_else(|error| panic!("{sql}: {error}"));
        }
        let denied = [
            "UPDATE pgcf.outbox SET topic = 'orders'",
            "DELETE FROM pgcf.outbox",
            "TRUNCATE pgcf.outbox",
            "LOCK TABLE pgcf.outbox",
            "ALTER TABLE pgcf.outbox ADD COLUMN extra int",
            "DROP TABLE pgcf.outbox",
            "CREATE TRIGGER hijack AFTER INSERT ON pgcf.outbox FOR EACH ROW EXECUTE FUNCTION pgcf.capture('seq')",
            "CREATE RULE hijack AS ON INSERT TO pgcf.outbox DO INSTEAD NOTHING",
            "CREATE FUNCTION pgcf.spy() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN OLD; END'",
            "CREATE TABLE pgcf.extra (a int)",
            "INSERT INTO pgcf.settings (singleton, epoch, max_payload_bytes, max_outbox_rows) VALUES (true, 1, 1, 1)",
            "UPDATE pgcf.settings SET max_outbox_rows = 1000000",
            "DELETE FROM pgcf.settings",
        ];
        for sql in denied {
            assert_eq!(refused(&session.client, sql).await, "42501", "{sql}");
        }
        session.batch("RESET ROLE").await.unwrap();
        assert_eq!(count(&session).await, 0);
    }

    #[tokio::test]
    async fn emit_refuses_each_input_with_its_state() {
        let Some(cluster) = cluster_with_tenant("pgcf-emit").await else {
            return;
        };
        install(&events(&cluster).await, &SETTINGS, false)
            .await
            .unwrap();
        let app = as_role(&cluster, "app", 1).await;
        let cases = [
            ("SELECT pgcf.emit('', '{}')".to_string(), "22023"),
            ("SELECT pgcf.emit('Orders', '{}')".to_string(), "22023"),
            (
                format!("SELECT pgcf.emit('{}', '{{}}')", "a".repeat(49)),
                "22023",
            ),
            ("SELECT pgcf.emit('1orders', '{}')".to_string(), "22023"),
            ("SELECT pgcf.emit(NULL::text, '{}')".to_string(), "22023"),
            ("SELECT pgcf.emit('orders', '[]')".to_string(), "22023"),
            (
                "SELECT pgcf.emit('orders', '\"text\"')".to_string(),
                "22023",
            ),
            (
                "SELECT pgcf.emit('orders', NULL::jsonb)".to_string(),
                "22023",
            ),
            (
                format!(
                    "SELECT pgcf.emit('orders', '{{\"x\":\"{}\"}}')",
                    "a".repeat(54_000)
                ),
                "54000",
            ),
            (
                format!("SELECT pgcf.emit('orders', '{}')", nested(33, false)),
                "54000",
            ),
            (
                format!("SELECT pgcf.emit('orders', '{}')", nested(33, true)),
                "54000",
            ),
        ];
        for (index, (sql, expected)) in cases.iter().enumerate() {
            let error = app
                .query(sql, &[])
                .await
                .expect_err(&format!("case {index} is refused"));
            assert_eq!(state(&error), *expected, "case {index}");
        }
        for sql in [nested(32, false), nested(32, true)] {
            app.batch_execute(&format!("SELECT pgcf.emit('orders', '{sql}')"))
                .await
                .unwrap();
        }
    }

    #[tokio::test]
    async fn a_full_outbox_refuses_until_a_row_leaves_and_an_unconfigured_one_refuses() {
        let Some(cluster) = cluster_with_tenant("pgcf-full").await else {
            return;
        };
        let session = events(&cluster).await;
        let small = Settings {
            max_outbox_rows: 2,
            ..SETTINGS
        };
        install(&session, &small, false).await.unwrap();
        let app = as_role(&cluster, "app", 1).await;
        for _ in 0..2 {
            app.batch_execute("SELECT pgcf.emit('orders', '{}')")
                .await
                .unwrap();
        }
        let error = app
            .batch_execute("SELECT pgcf.emit('orders', '{}')")
            .await
            .unwrap_err();
        assert_eq!(state(&error), "53400");
        assert_eq!(delete(&session, &[1]).await.unwrap(), 1);
        app.batch_execute("SELECT pgcf.emit('orders', '{}')")
            .await
            .unwrap();
        session.batch("DELETE FROM pgcf.settings").await.unwrap();
        let error = app
            .batch_execute("SELECT pgcf.emit('orders', '{}')")
            .await
            .unwrap_err();
        assert_eq!(state(&error), "55000");
    }

    #[tokio::test]
    async fn an_emit_follows_its_transaction() {
        let Some(cluster) = cluster_with_tenant("pgcf-transaction").await else {
            return;
        };
        let session = events(&cluster).await;
        install(&session, &SETTINGS, false).await.unwrap();
        let app = as_role(&cluster, "app", 1).await;
        app.batch_execute("BEGIN; SELECT pgcf.emit('orders', '{}'); ROLLBACK")
            .await
            .unwrap();
        assert_eq!(count(&session).await, 0);
        app.batch_execute("BEGIN; SELECT pgcf.emit('orders', '{}'); COMMIT")
            .await
            .unwrap();
        assert_eq!(count(&session).await, 1);
        app.batch_execute(
            "BEGIN; SAVEPOINT s; SELECT pgcf.emit('orders', '{}'); ROLLBACK TO s; COMMIT",
        )
        .await
        .unwrap();
        assert_eq!(count(&session).await, 1);
    }

    #[tokio::test]
    async fn capture_publishes_the_allowlisted_columns_of_each_write() {
        let Some(cluster) = cluster_with_tenant("pgcf-capture").await else {
            return;
        };
        let session = events(&cluster).await;
        install(&session, &SETTINGS, false).await.unwrap();
        let app = as_role(&cluster, "app", 1).await;
        app.batch_execute(
            "CREATE TABLE orders (id int PRIMARY KEY, total int, secret text);
             CREATE TRIGGER outbox AFTER INSERT OR UPDATE OR DELETE ON orders FOR EACH ROW EXECUTE FUNCTION pgcf.capture('id', 'total');
             INSERT INTO orders VALUES (1, 5, 'x');
             UPDATE orders SET total = total, secret = 'y' WHERE id = 1;
             UPDATE orders SET total = 6 WHERE id = 1;
             DELETE FROM orders WHERE id = 1;",
        )
        .await
        .unwrap();
        let rows = read_batch(&session, 10, i64::MAX).await.unwrap();
        let payloads: Vec<Value> = rows
            .iter()
            .map(|row| serde_json::from_str(row.payload.as_deref().unwrap()).unwrap())
            .collect();
        assert_eq!(
            rows.len(),
            3,
            "an UPDATE of no allowlisted column emits nothing"
        );
        assert!(rows.iter().all(|row| row.topic == "orders"));
        assert_eq!(
            payloads[0],
            json!({"schema": "public", "table": "orders", "op": "insert",
                   "record": {"id": 1, "total": 5}, "old_record": null})
        );
        assert_eq!(
            payloads[1],
            json!({"schema": "public", "table": "orders", "op": "update",
                   "record": {"id": 1, "total": 6}, "old_record": {"id": 1, "total": 5}})
        );
        assert_eq!(
            payloads[2],
            json!({"schema": "public", "table": "orders", "op": "delete",
                   "record": null, "old_record": {"id": 1, "total": 6}})
        );
    }

    #[tokio::test]
    async fn capture_derives_the_topic_from_the_table_name() {
        let Some(cluster) = cluster_with_tenant("pgcf-capture-topic").await else {
            return;
        };
        let session = events(&cluster).await;
        install(&session, &SETTINGS, false).await.unwrap();
        let long = "a".repeat(60);
        let digit_first = format!("9{}", "b".repeat(59));
        let app = as_role(&cluster, "app", 1).await;
        app.batch_execute(&format!(
            "CREATE TABLE \"Order-Items\" (id int);
             CREATE TRIGGER outbox AFTER INSERT ON \"Order-Items\" FOR EACH ROW EXECUTE FUNCTION pgcf.capture('id');
             CREATE TABLE \"2024_orders\" (id int);
             CREATE TRIGGER outbox AFTER INSERT ON \"2024_orders\" FOR EACH ROW EXECUTE FUNCTION pgcf.capture('id');
             CREATE TABLE \"{long}\" (id int);
             CREATE TRIGGER outbox AFTER INSERT ON \"{long}\" FOR EACH ROW EXECUTE FUNCTION pgcf.capture('id');
             CREATE TABLE \"A-b-c\" (id int);
             CREATE TRIGGER outbox AFTER INSERT ON \"A-b-c\" FOR EACH ROW EXECUTE FUNCTION pgcf.capture('id');
             CREATE TABLE \"{digit_first}\" (id int);
             CREATE TRIGGER outbox AFTER INSERT ON \"{digit_first}\" FOR EACH ROW EXECUTE FUNCTION pgcf.capture('id');
             INSERT INTO \"Order-Items\" VALUES (1);
             INSERT INTO \"2024_orders\" VALUES (1);
             INSERT INTO \"{long}\" VALUES (1);
             INSERT INTO \"A-b-c\" VALUES (1);
             INSERT INTO \"{digit_first}\" VALUES (1);"
        ))
        .await
        .unwrap();
        let topics = read_batch(&session, 10, i64::MAX)
            .await
            .unwrap()
            .into_iter()
            .map(|row| row.topic)
            .collect::<Vec<_>>();
        let cut = "a".repeat(48);
        // A digit-first name takes the 't_' prefix, and the 48 characters keep its first 46.
        let digit_cut = format!("t_9{}", "b".repeat(45));
        assert_eq!(
            topics,
            [
                "order_items",
                "t_2024_orders",
                cut.as_str(),
                "a_b_c",
                digit_cut.as_str()
            ]
        );
    }

    #[tokio::test]
    async fn capture_sends_a_number_as_text_when_json_readers_would_round_it() {
        let Some(cluster) = cluster_with_tenant("pgcf-capture-numbers").await else {
            return;
        };
        let session = events(&cluster).await;
        install(&session, &SETTINGS, false).await.unwrap();
        as_role(&cluster, "app", 1)
            .await
            .batch_execute(
                "CREATE TABLE measures (id int, big bigint, safe bigint, dec numeric, small int, huge numeric, tiny numeric, zero numeric, cents numeric(6,2), flt float8, zero_int int, wide numeric);
                 CREATE TRIGGER outbox AFTER INSERT OR UPDATE ON measures FOR EACH ROW EXECUTE FUNCTION pgcf.capture('big', 'safe', 'dec', 'small', 'huge', 'tiny', 'zero', 'cents', 'flt', 'zero_int', 'wide');
                 INSERT INTO measures VALUES (1, 9007199254740993, 9007199254740991, 0.1, 7, 1e400, 1e-400, 0, 0.00, 0, 0, 1.5e305);
                 UPDATE measures SET big = 9007199254740995, huge = 2e400, zero_int = 1 WHERE id = 1;",
            )
            .await
            .unwrap();
        let rows = read_batch(&session, 10, i64::MAX).await.unwrap();
        let payloads: Vec<Value> = rows
            .iter()
            .map(|row| serde_json::from_str(row.payload.as_deref().unwrap()).unwrap())
            .collect();
        let huge = format!("1{}", "0".repeat(400));
        let record = &payloads[0]["record"];
        assert_eq!(record["big"], "9007199254740993");
        assert_eq!(record["safe"], 9007199254740991_i64);
        assert_eq!(record["dec"], 0.1);
        assert_eq!(record["small"], 7);
        assert_eq!(record["huge"], huge);
        assert!(
            record["tiny"]
                .as_str()
                .is_some_and(|text| text.starts_with("0."))
        );
        // Zero is a JSON number in every numeric type; 1.5e305 is a string beyond 1e300.
        for column in ["zero", "cents", "flt", "zero_int"] {
            assert_eq!(record[column], 0.0, "{column}");
        }
        assert!(record["wide"].is_string());
        assert_eq!(payloads[1]["record"]["big"], "9007199254740995");
        assert_eq!(
            payloads[1]["record"]["huge"],
            format!("2{}", "0".repeat(400))
        );
        assert_eq!(payloads[1]["old_record"]["big"], "9007199254740993");
        assert_eq!(payloads[1]["old_record"]["huge"], huge);
        assert_eq!(payloads[1]["old_record"]["safe"], 9007199254740991_i64);
        assert_eq!(payloads[1]["old_record"]["small"], 7);
        assert_eq!(payloads[1]["old_record"]["zero_int"], 0.0);
        assert_eq!(payloads[1]["record"]["zero_int"], 1);
    }

    #[tokio::test]
    async fn capture_refuses_misuse_at_fire_time() {
        let Some(cluster) = cluster_with_tenant("pgcf-misuse").await else {
            return;
        };
        install(&events(&cluster).await, &SETTINGS, false)
            .await
            .unwrap();
        let app = as_role(&cluster, "app", 1).await;
        app.batch_execute(
            "CREATE TABLE no_columns (id int);
             CREATE TRIGGER outbox AFTER INSERT ON no_columns FOR EACH ROW EXECUTE FUNCTION pgcf.capture();
             CREATE TABLE unknown_column (id int);
             CREATE TRIGGER outbox AFTER INSERT ON unknown_column FOR EACH ROW EXECUTE FUNCTION pgcf.capture('nope');
             CREATE TABLE before_row (id int);
             CREATE TRIGGER outbox BEFORE INSERT ON before_row FOR EACH ROW EXECUTE FUNCTION pgcf.capture('id');
             CREATE TABLE per_statement (id int);
             CREATE TRIGGER outbox AFTER INSERT ON per_statement FOR EACH STATEMENT EXECUTE FUNCTION pgcf.capture('id');
             ",
        )
        .await
        .unwrap();
        let cases = [
            ("no_columns", "22023"),
            ("unknown_column", "42703"),
            ("before_row", "39P01"),
            ("per_statement", "39P01"),
        ];
        for (table, expected) in cases {
            let error = app
                .batch_execute(&format!("INSERT INTO {table} VALUES (1)"))
                .await
                .unwrap_err();
            assert_eq!(state(&error), expected, "{table}");
        }
    }

    #[tokio::test]
    async fn a_tenant_shadowing_the_platform_names_does_not_redirect_emit_or_capture() {
        let Some(cluster) = cluster_with_tenant("pgcf-hijack").await else {
            return;
        };
        let session = events(&cluster).await;
        install(&session, &SETTINGS, false).await.unwrap();
        let setup = as_role(&cluster, "app", 1).await;
        setup.batch_execute(
            "CREATE TABLE orders (id int PRIMARY KEY, total int);
             CREATE TRIGGER outbox AFTER INSERT ON orders FOR EACH ROW EXECUTE FUNCTION pgcf.capture('id', 'total');
             CREATE TEMP TABLE outbox (seq bigint, epoch bigint, topic text, payload jsonb);
             CREATE TEMP TABLE settings (singleton boolean, epoch bigint, max_payload_bytes bigint, max_outbox_rows bigint);
             INSERT INTO pg_temp.settings VALUES (true, 9, 1, 1);
             CREATE FUNCTION pg_temp.to_jsonb(anyelement) RETURNS jsonb LANGUAGE sql AS 'SELECT NULL::jsonb';
             CREATE FUNCTION pg_temp.jsonb_build_object(text, anyelement) RETURNS jsonb LANGUAGE sql AS 'SELECT NULL::jsonb';
             CREATE FUNCTION public.poison(jsonb, jsonb) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{\"poisoned\": true}'::jsonb $$;
             CREATE OPERATOR public.|| (LEFTARG = jsonb, RIGHTARG = jsonb, FUNCTION = public.poison);
             SET search_path = pg_temp, public;
             ALTER DATABASE tenant SET search_path TO public, pg_catalog;",
        )
        .await
        .unwrap();
        let app = as_role(&cluster, "app", 1).await;
        app.batch_execute(
            "SELECT pgcf.emit('orders', '{\"x\": 1}'); INSERT INTO public.orders VALUES (1, 5);",
        )
        .await
        .unwrap();
        let rows = read_batch(&session, 10, i64::MAX).await.unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(
            serde_json::from_str::<Value>(rows[1].payload.as_deref().unwrap()).unwrap(),
            json!({"schema": "public", "table": "orders", "op": "insert",
                   "record": {"id": 1, "total": 5}, "old_record": null})
        );
        let shadow = setup
            .query("SELECT count(*) FROM pg_temp.outbox", &[])
            .await
            .unwrap();
        assert_eq!(shadow[0].get::<_, i64>(0), 0);
    }

    #[tokio::test]
    async fn install_leaves_a_foreign_schema_named_pgcf_alone() {
        let Some(cluster) = cluster_with_tenant("pgcf-conflict").await else {
            return;
        };
        let app = as_role(&cluster, "app", 1).await;
        app.batch_execute("CREATE SCHEMA pgcf; CREATE TABLE pgcf.outbox (x int)")
            .await
            .unwrap();
        let session = events(&cluster).await;
        assert!(conflict(&session).await.unwrap());
        assert_eq!(
            install(&session, &SETTINGS, true).await.unwrap(),
            Installed::Conflict
        );
        assert!(!outbox_pending(&session).await.unwrap());
        let roles = session
            .query(
                "SELECT count(*) FROM pg_catalog.pg_roles WHERE rolname = $1",
                &[&PLATFORM_ROLE],
            )
            .await
            .unwrap();
        assert_eq!(roles[0].get::<_, i64>(0), 0);
        app.batch_execute("INSERT INTO pgcf.outbox VALUES (7)")
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn the_schema_refuses_a_tenant_schema_pgcf_created_inside_the_install_transaction() {
        let Some(cluster) = cluster_with_tenant("pgcf-race").await else {
            return;
        };
        as_role(&cluster, "app", 1)
            .await
            .batch_execute("CREATE SCHEMA pgcf; GRANT ALL ON SCHEMA pgcf TO PUBLIC")
            .await
            .unwrap();
        let session = events(&cluster).await;
        session.batch("BEGIN").await.unwrap();
        let error = install_within(&session, &SETTINGS, false)
            .await
            .expect_err("a tenant schema pgcf is not adopted");
        session.batch("ROLLBACK").await.unwrap();
        let state = error
            .downcast_ref::<tokio_postgres::Error>()
            .and_then(tokio_postgres::Error::code)
            .map(tokio_postgres::error::SqlState::code);
        assert_eq!(state, Some("42P06"));
        assert_eq!(
            session
                .query(
                    "SELECT count(*) FROM pg_catalog.pg_roles WHERE rolname = $1",
                    &[&PLATFORM_ROLE],
                )
                .await
                .unwrap()[0]
                .get::<_, i64>(0),
            0
        );
    }

    #[tokio::test]
    async fn owned_holds_only_while_a_superuser_owns_the_schema_and_the_outbox() {
        let Some(cluster) = cluster_with_tenant("pgcf-owned").await else {
            return;
        };
        let session = events(&cluster).await;
        install(&session, &SETTINGS, false).await.unwrap();
        as_role(&cluster, "app", 1)
            .await
            .batch_execute("SELECT pgcf.emit('orders', '{}')")
            .await
            .unwrap();
        assert!(owned(&session).await.unwrap());
        assert!(outbox_pending(&session).await.unwrap());
        session
            .batch("ALTER TABLE pgcf.outbox OWNER TO app")
            .await
            .unwrap();
        assert!(!owned(&session).await.unwrap());
        assert!(!outbox_pending(&session).await.unwrap());
        session
            .batch(&format!(
                "ALTER TABLE pgcf.outbox OWNER TO \"{AGENT_ROLE}\"; ALTER SCHEMA pgcf OWNER TO app"
            ))
            .await
            .unwrap();
        assert!(!owned(&session).await.unwrap());
        assert!(!outbox_pending(&session).await.unwrap());
    }

    #[tokio::test]
    async fn a_tenant_cast_that_runs_as_the_platform_role_cannot_attach_code_to_the_outbox() {
        let Some(cluster) = cluster_with_tenant("pgcf-cast").await else {
            return;
        };
        let session = events(&cluster).await;
        install(&session, &SETTINGS, false).await.unwrap();
        let app = as_role(&cluster, "app", 1).await;
        // pgcf.capture calls to_jsonb on the row, which runs this cast to json as the platform role.
        app.batch_execute(
            "CREATE TYPE hostile AS ENUM ('a');
             CREATE TABLE attempts (who text, what text, state text);
             GRANT INSERT ON attempts TO \"pgcf-events\";
             CREATE FUNCTION hostile_json(value hostile) RETURNS json LANGUAGE plpgsql AS $f$
             DECLARE
               attack text;
             BEGIN
               FOREACH attack IN ARRAY ARRAY[
                 'CREATE FUNCTION pgcf.spy() RETURNS trigger LANGUAGE plpgsql AS $g$ BEGIN RETURN OLD; END $g$',
                 'CREATE TRIGGER spy BEFORE DELETE ON pgcf.outbox FOR EACH ROW EXECUTE FUNCTION pgcf.spy()',
                 'ALTER TABLE pgcf.outbox DISABLE TRIGGER ALL',
                 'DELETE FROM pgcf.outbox'
               ] LOOP
                 BEGIN
                   EXECUTE attack;
                   INSERT INTO public.attempts VALUES (current_user, attack, 'ok');
                 EXCEPTION WHEN OTHERS THEN
                   INSERT INTO public.attempts VALUES (current_user, attack, SQLSTATE);
                 END;
               END LOOP;
               RETURN pg_catalog.to_json(value::pg_catalog.text);
             END $f$;
             CREATE CAST (hostile AS json) WITH FUNCTION hostile_json(hostile) AS IMPLICIT;
             CREATE TABLE tenant_rows (id int, m hostile);
             CREATE TRIGGER outbox AFTER INSERT ON tenant_rows FOR EACH ROW EXECUTE FUNCTION pgcf.capture('id', 'm');
             INSERT INTO tenant_rows VALUES (1, 'a');",
        )
        .await
        .unwrap();
        let attempts = app
            .query("SELECT who, state FROM attempts", &[])
            .await
            .unwrap()
            .iter()
            .map(|row| (row.get::<_, String>(0), row.get::<_, String>(1)))
            .collect::<Vec<_>>();
        assert_eq!(attempts.len(), 4);
        assert!(
            attempts.iter().all(|(who, _)| who == PLATFORM_ROLE),
            "the cast did not run as the platform role: {attempts:?}"
        );
        assert!(
            attempts.iter().all(|(_, state)| state == "42501"),
            "{attempts:?}"
        );
        assert_eq!(count(&session).await, 1);
        let triggers = session
            .query(
                "SELECT count(*) FROM pg_catalog.pg_trigger WHERE tgrelid = 'pgcf.outbox'::regclass AND NOT tgisinternal",
                &[],
            )
            .await
            .unwrap();
        assert_eq!(triggers[0].get::<_, i64>(0), 0);
        assert_eq!(delete(&session, &[1]).await.unwrap(), 1);
        assert_eq!(count(&session).await, 0);
        let attempts = app
            .query("SELECT count(*) FROM attempts", &[])
            .await
            .unwrap();
        assert_eq!(attempts[0].get::<_, i64>(0), 4);
        session
            .batch(&format!("SET ROLE \"{PLATFORM_ROLE}\""))
            .await
            .unwrap();
        assert_eq!(count(&session).await, 0);
        let limit = constant("NODE_DATA_EVENT_PAYLOAD_MAX_BYTES")
            .as_u64()
            .unwrap();
        // The text of `{"x": "<a>"}` is nine bytes around its `a`s.
        let room = usize::try_from(limit).unwrap() - "{\"x\": \"\"}".len();
        let forged = [
            "INSERT INTO pgcf.outbox (seq, epoch, topic, payload) OVERRIDING SYSTEM VALUE VALUES (0, 1, 'orders', '{}')".to_string(),
            "INSERT INTO pgcf.outbox (seq, epoch, topic, payload) OVERRIDING SYSTEM VALUE VALUES (1, 0, 'orders', '{}')".to_string(),
            "INSERT INTO pgcf.outbox (seq, epoch, topic, payload) OVERRIDING SYSTEM VALUE VALUES (9007199254740992, 1, 'orders', '{}')".to_string(),
            "INSERT INTO pgcf.outbox (seq, epoch, topic, payload) OVERRIDING SYSTEM VALUE VALUES (1, 9007199254740992, 'orders', '{}')".to_string(),
            format!("INSERT INTO pgcf.outbox (epoch, topic, payload) VALUES (1, 'orders', '{{\"x\": \"{}\"}}')", "a".repeat(300 * 1024)),
            format!("INSERT INTO pgcf.outbox (epoch, topic, payload) VALUES (1, 'orders', '{}')", nested(33, false)),
            format!("INSERT INTO pgcf.outbox (epoch, topic, payload) VALUES (1, 'orders', '{}')", nested(33, true)),
            format!("INSERT INTO pgcf.outbox (epoch, topic, payload) VALUES (1, 'orders', '{{\"x\": \"{}\"}}')", "a".repeat(room + 1)),
        ];
        for sql in &forged {
            assert_eq!(refused(&session.client, sql).await, "23514", "{sql}");
        }
        // The largest seq and epoch the CHECKs admit are accepted; the transaction is rolled back.
        for sql in [
            "INSERT INTO pgcf.outbox (seq, epoch, topic, payload) OVERRIDING SYSTEM VALUE VALUES (9007199254740991, 1, 'orders', '{}')",
            "INSERT INTO pgcf.outbox (seq, epoch, topic, payload) OVERRIDING SYSTEM VALUE VALUES (1, 9007199254740991, 'orders', '{}')",
        ] {
            session
                .batch(&format!("BEGIN; {sql}; ROLLBACK"))
                .await
                .unwrap();
        }
        session
            .batch(&format!(
                "INSERT INTO pgcf.outbox (epoch, topic, payload) SELECT 1, 'orders', pg_catalog.jsonb_build_object('x', pg_catalog.repeat('a', {room})) FROM pg_catalog.generate_series(1, 61)"
            ))
            .await
            .unwrap();
        session.batch("RESET ROLE").await.unwrap();
        let started = std::time::Instant::now();
        let rows = read_batch(&session, 61, i64::try_from(limit).unwrap())
            .await
            .unwrap();
        assert!(started.elapsed() < std::time::Duration::from_secs(1));
        assert_eq!(rows.len(), 61);
        assert!(rows.iter().all(|row| row.payload.is_some()));
    }

    #[tokio::test]
    async fn a_writer_without_execute_on_emit_is_published_through_capture() {
        let Some(cluster) = cluster_with_tenant("pgcf-writer").await else {
            return;
        };
        let session = events(&cluster).await;
        install(&session, &SETTINGS, false).await.unwrap();
        as_role(&cluster, "app", 1)
            .await
            .batch_execute(
                "CREATE TABLE watched (id int, m text);
                 GRANT INSERT ON watched TO reader;
                 CREATE TRIGGER outbox AFTER INSERT ON watched FOR EACH ROW EXECUTE FUNCTION pgcf.capture('id', 'm');",
            )
            .await
            .unwrap();
        as_role(&cluster, "reader", 2)
            .await
            .batch_execute("INSERT INTO watched VALUES (1, 'a')")
            .await
            .unwrap();
        assert_eq!(count(&session).await, 1);
    }

    #[tokio::test]
    async fn capture_refuses_a_temporary_table_from_any_role() {
        let Some(cluster) = cluster_with_tenant("pgcf-temp-capture").await else {
            return;
        };
        let session = events(&cluster).await;
        install(&session, &SETTINGS, false).await.unwrap();
        let reader = as_role(&cluster, "reader", 2).await;
        reader
            .batch_execute(
                "CREATE TEMP TABLE orders (id int, total int);
                 CREATE TRIGGER outbox AFTER INSERT ON orders FOR EACH ROW EXECUTE FUNCTION pgcf.capture('id', 'total');",
            )
            .await
            .unwrap();
        let error = reader
            .batch_execute("INSERT INTO orders VALUES (1, 999)")
            .await
            .unwrap_err();
        assert_eq!(state(&error), "42501");
        assert_eq!(count(&session).await, 0);
    }

    #[tokio::test]
    async fn connect_reopens_a_database_that_does_not_allow_connections() {
        let Some(cluster) = cluster_with_tenant("pgcf-connect").await else {
            return;
        };
        install(&events(&cluster).await, &SETTINGS, false)
            .await
            .unwrap();
        cluster
            .agent()
            .await
            .batch("ALTER DATABASE tenant WITH ALLOW_CONNECTIONS false")
            .await
            .unwrap();
        let session = connect(&cluster.socket_directory(), "tenant", None)
            .await
            .unwrap();
        assert!(!outbox_pending(&session).await.unwrap());
        let allowed = cluster
            .agent()
            .await
            .query(
                "SELECT datallowconn FROM pg_catalog.pg_database WHERE datname = 'tenant'",
                &[],
            )
            .await
            .unwrap();
        assert!(allowed[0].get::<_, bool>(0));
    }

    #[tokio::test]
    async fn the_outbox_is_pending_only_once_a_row_is_in_it() {
        let Some(cluster) = cluster_with_tenant("pgcf-pending").await else {
            return;
        };
        let session = events(&cluster).await;
        assert!(!outbox_pending(&session).await.unwrap());
        install(&session, &SETTINGS, false).await.unwrap();
        assert!(!outbox_pending(&session).await.unwrap());
        as_role(&cluster, "app", 1)
            .await
            .batch_execute("SELECT pgcf.emit('orders', '{}')")
            .await
            .unwrap();
        assert!(outbox_pending(&session).await.unwrap());
    }

    #[tokio::test]
    async fn read_batch_is_in_sequence_order_and_delete_removes_the_listed_rows() {
        let Some(cluster) = cluster_with_tenant("pgcf-read").await else {
            return;
        };
        let session = events(&cluster).await;
        install(&session, &SETTINGS, false).await.unwrap();
        let app = as_role(&cluster, "app", 1).await;
        app.batch_execute(
            "SELECT pgcf.emit('orders', '{}'); SELECT pgcf.emit('orders', '{}'); SELECT pgcf.emit('orders', '{}');",
        )
        .await
        .unwrap();
        let seqs = |rows: &[Row]| rows.iter().map(|row| row.seq).collect::<Vec<_>>();
        let rows = read_batch(&session, 10, i64::MAX).await.unwrap();
        assert_eq!(seqs(&rows), [1, 2, 3]);
        assert!(
            rows.iter()
                .all(|row| row.epoch == 1 && row.at_ms > 0 && row.topic == "orders")
        );
        assert_eq!(
            seqs(&read_batch(&session, 2, i64::MAX).await.unwrap()),
            [1, 2]
        );
        assert_eq!(delete(&session, &[1, 3]).await.unwrap(), 2);
        assert_eq!(
            seqs(&read_batch(&session, 10, i64::MAX).await.unwrap()),
            [2]
        );
    }

    #[tokio::test]
    async fn read_batch_reads_an_oversized_row_as_none_and_the_rows_behind_it() {
        let Some(cluster) = cluster_with_tenant("pgcf-read-ceiling").await else {
            return;
        };
        let session = events(&cluster).await;
        install(&session, &SETTINGS, false).await.unwrap();
        as_role(&cluster, "app", 1)
            .await
            .batch_execute(
                r#"SELECT pgcf.emit('orders', '{"x": "abc"}'); SELECT pgcf.emit('orders', '{}');"#,
            )
            .await
            .unwrap();
        let rows = read_batch(&session, 10, 11).await.unwrap();
        assert_eq!(
            rows.iter()
                .map(|row| (row.seq, row.payload.as_deref()))
                .collect::<Vec<_>>(),
            [(1, None), (2, Some("{}"))]
        );
        let rows = read_batch(&session, 10, 12).await.unwrap();
        assert_eq!(rows[0].payload.as_deref(), Some(r#"{"x": "abc"}"#));
    }

    #[tokio::test]
    async fn read_batch_measures_the_ceiling_in_bytes_not_characters() {
        let Some(cluster) = cluster_with_tenant("pgcf-read-bytes").await else {
            return;
        };
        let session = events(&cluster).await;
        install(&session, &SETTINGS, false).await.unwrap();
        as_role(&cluster, "app", 1)
            .await
            .batch_execute("SELECT pgcf.emit('orders', '{\"x\": \"é\"}')")
            .await
            .unwrap();
        // The payload is 10 characters and 11 bytes.
        let rows = read_batch(&session, 10, 10).await.unwrap();
        assert_eq!(rows[0].payload, None);
        let rows = read_batch(&session, 10, 11).await.unwrap();
        assert_eq!(rows[0].payload.as_deref(), Some("{\"x\": \"é\"}"));
    }

    #[tokio::test]
    async fn read_batch_orders_hostile_rows_by_seq_not_by_heap_order() {
        let Some(cluster) = cluster_with_tenant("pgcf-read-order").await else {
            return;
        };
        let session = events(&cluster).await;
        install(&session, &SETTINGS, false).await.unwrap();
        session
            .batch(
                "INSERT INTO pgcf.outbox (seq, epoch, topic, payload) OVERRIDING SYSTEM VALUE VALUES
                 (30, 1, 'orders', '{}'),
                 (10, 1, 'orders', '{}'),
                 (20, 1, 'orders', '{}')",
            )
            .await
            .unwrap();
        let seqs = read_batch(&session, 10, i64::MAX)
            .await
            .unwrap()
            .iter()
            .map(|row| row.seq)
            .collect::<Vec<_>>();
        assert_eq!(seqs, [10, 20, 30]);
    }

    #[tokio::test]
    async fn read_batch_clamps_times_outside_the_unix_range_and_reads_on() {
        let Some(cluster) = cluster_with_tenant("pgcf-read-times").await else {
            return;
        };
        let session = events(&cluster).await;
        install(&session, &SETTINGS, false).await.unwrap();
        session
            .batch(
                "INSERT INTO pgcf.outbox (seq, epoch, emitted_at, topic, payload) OVERRIDING SYSTEM VALUE VALUES
                 (1, 1, 'infinity', 'orders', '{}'),
                 (2, 1, '-infinity', 'orders', '{}'),
                 (3, 1, '0001-01-01 00:00:00+00 BC', 'orders', '{}'),
                 (4, 1, '2026-10-31 12:00:00+00', 'orders', '{}')",
            )
            .await
            .unwrap();
        let rows = read_batch(&session, 10, i64::MAX).await.unwrap();
        assert_eq!(
            rows.iter()
                .take(3)
                .map(|row| (row.seq, row.at_ms))
                .collect::<Vec<_>>(),
            [(1, 253_402_300_799_999), (2, 0), (3, 0)]
        );
        assert_eq!(rows[3].seq, 4);
        assert!(rows[3].at_ms > 0);
    }
}
