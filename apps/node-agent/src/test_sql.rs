// SPDX-License-Identifier: Apache-2.0
//! One database around the PostgreSQL wire double for the role and sleep tests: its desired record,
//! the double's catalogs and settings, and a log of every login and statement. The agent's real
//! code runs against it; nothing here is product code.
use crate::{
    contracts::{namespace, present_roles, text},
    test_postgres::{Answer, Authority, Cell, Handler, Instant, Login, Postgres},
};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    net::SocketAddr,
    sync::{Arc, Mutex},
};

pub const POD_IP: &str = "10.0.0.7";
fn now_ms() -> u64 {
    u64::try_from(time::OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000).unwrap()
}
/// What the catalogs of the PostgreSQL double hold of one role.
#[derive(Clone, Debug)]
pub struct RoleRow {
    /// `rolcanlogin`.
    pub login: bool,
    /// `rolvaliduntil`: `None` is NULL.
    pub valid_until: Option<Instant>,
    /// `rolconnlimit`: `-1` is no limit.
    pub connection_limit: i32,
    /// `rolbypassrls`.
    pub bypass_rls: bool,
    /// The names of the roles it is a member of.
    pub member_of: Vec<String>,
    /// The `pg_shdepend` rows that depend on it.
    pub dependencies: i64,
    /// Its client backends in `pg_stat_activity`.
    pub sessions: i64,
}
impl Default for RoleRow {
    /// A plain role: it logs in, never expires, has no limit, no membership and no object.
    fn default() -> Self {
        Self {
            login: true,
            valid_until: None,
            connection_limit: -1,
            bypass_rls: false,
            member_of: vec![],
            dependencies: 0,
            sessions: 0,
        }
    }
}
/// What the PostgreSQL double answers; tests change it between passes.
#[derive(Clone)]
pub struct Sql {
    pub busy: i32,
    pub prepared: i32,
    /// The closed segment `pg_switch_wal()` reports and whether its `.done` exists. WAL file names
    /// are upper-case hexadecimal, so a name without a letter would hide a validator that rejects
    /// them.
    pub segment: String,
    pub archived: bool,
    pub postmaster_age_ms: i64,
    /// `pg_control_system().system_identifier` of the data directory the postmaster runs on.
    pub system_identifier: String,
    /// `pg_control_checkpoint().timeline_id`.
    pub timeline: i32,
    pub recovery: bool,
    /// The roles of the database by name, as `pg_roles` and its neighbours hold them. A role that
    /// is not here does not exist in PostgreSQL.
    pub roles: BTreeMap<String, RoleRow>,
    /// Roles whose startup PostgreSQL refuses, with the SQLSTATE and message of the FATAL.
    pub refused: BTreeMap<String, (&'static str, &'static str)>,
}
impl Default for Sql {
    fn default() -> Self {
        Self {
            busy: 0,
            prepared: 0,
            segment: "0000000100000000000000A7".into(),
            archived: true,
            postmaster_age_ms: 5,
            system_identifier: "7430000000000000001".into(),
            timeline: 1,
            recovery: false,
            roles: BTreeMap::new(),
            refused: BTreeMap::new(),
        }
    }
}
/// The LSN `pg_switch_wal()` returns when it closed `segment`: the first byte after it, in
/// PostgreSQL's `pg_lsn` text form (`<log>/<offset>`, upper-case hexadecimal).
fn lsn_after(segment: &str) -> String {
    let log = u64::from_str_radix(&segment[8..16], 16).unwrap();
    let number = u64::from_str_radix(&segment[16..24], 16).unwrap();
    format!("{log:X}/{:X}", (number + 1) * 0x100_0000)
}
/// The server address column of a statement, as PostgreSQL returns the select-list expression
/// the statement holds: `host()` prints the address alone, a cast to `text` keeps the netmask the
/// `inet` carries (`10.0.0.7/32`), and the bare `inet` is a binary value no text decode accepts.
fn server_address(sql: &str, ip: &str) -> Cell {
    let plain = sql.replace("pg_catalog.", "");
    if plain.contains("host(inet_server_addr())") {
        Cell::Text(ip.into())
    } else if plain.contains("inet_server_addr()::text") {
        Cell::Text(format!("{ip}/32"))
    } else {
        Cell::Inet(ip.into())
    }
}
/// Every cell has the type and the text form the real server gives the statement's expression
/// (see `test_postgres`).
fn answers(
    db: Value,
    state: Arc<Mutex<Sql>>,
    log: Arc<Mutex<Vec<String>>>,
    (who, ip): (&'static str, &'static str),
) -> Handler {
    Arc::new(move |sql: &str, parameters: &[String], user: &str| {
        let s = state.lock().unwrap().clone();
        // The role a role statement is bound to; a statement being described has no parameter.
        let role = parameters.first().map(String::as_str);
        let kind = if sql.contains("pg_postmaster_start_time") {
            "accepting".to_string()
        } else if sql.contains("pg_control_system") {
            "server identity".to_string()
        } else if sql.contains("current_setting('server_version')") {
            "role login".to_string()
        } else if sql.contains("pg_stat_archiver") {
            "archive".to_string()
        } else if sql.contains("pg_terminate_backend") {
            format!("role terminate {}", role.unwrap_or(""))
        } else if sql.contains("rolvaliduntil") {
            format!("role attributes {}", role.unwrap_or(""))
        } else if sql.contains("WHERE member.rolname = $1") {
            format!("role memberships {}", role.unwrap_or(""))
        } else if sql.contains("pg_shdepend") {
            format!("role dependencies {}", role.unwrap_or(""))
        } else if sql.contains("FROM pg_catalog.pg_stat_activity WHERE usename = $1") {
            format!("role sessions {}", role.unwrap_or(""))
        } else {
            sql.split_whitespace().take(3).collect::<Vec<_>>().join(" ")
        };
        log.lock()
            .unwrap()
            .push(format!("{who} {user} {kind}").trim_end().to_string());
        let text = |v: &str| Cell::Text(v.to_string());
        let name = |v: &str| Cell::Name(v.to_string());
        let one = |row: Vec<(&'static str, Cell)>| Answer::Rows(vec![row]);
        let id = crate::contracts::text(&db, "id");
        let size = &db["size"];
        let memory = crate::contracts::number(size, "memory_mib");
        let request = crate::contracts::optional_number(size, "memory_request_mib", memory);
        if sql.contains("rolvaliduntil") {
            // A role's row by name: no row for a role PostgreSQL does not have. A statement being
            // described has no parameter and answers with a row for its layout.
            let row = |at: &str, held: &RoleRow| {
                vec![
                    ("rolname", name(at)),
                    ("rolcanlogin", Cell::Bool(held.login)),
                    (
                        "rolvaliduntil",
                        held.valid_until
                            .map_or(Cell::Null(Cell::TIMESTAMPTZ), Cell::Timestamptz),
                    ),
                    ("rolconnlimit", Cell::Int4(held.connection_limit)),
                    ("rolbypassrls", Cell::Bool(held.bypass_rls)),
                ]
            };
            match role {
                None => one(row("described", &RoleRow::default())),
                Some(at) => Answer::Rows(
                    s.roles
                        .get(at)
                        .map(|held| vec![row(at, held)])
                        .unwrap_or_default(),
                ),
            }
        } else if sql.contains("WHERE member.rolname = $1") {
            // One `name` per role it is a member of.
            match role {
                None => one(vec![("rolname", name("described"))]),
                Some(at) => Answer::Rows(
                    s.roles
                        .get(at)
                        .map(|held| {
                            held.member_of
                                .iter()
                                .map(|granted| vec![("rolname", name(granted))])
                                .collect()
                        })
                        .unwrap_or_default(),
                ),
            }
        } else if sql.contains("pg_shdepend") {
            let count = role
                .and_then(|at| s.roles.get(at))
                .map_or(0, |held| held.dependencies);
            one(vec![("count", Cell::Int8(count))])
        } else if sql.contains("pg_terminate_backend") {
            match role {
                None => one(vec![("pg_terminate_backend", Cell::Bool(true))]),
                Some(at) => {
                    let sessions = s.roles.get(at).map_or(0, |held| held.sessions);
                    if let Some(held) = state.lock().unwrap().roles.get_mut(at) {
                        held.sessions = 0;
                    }
                    Answer::Rows(
                        (0..sessions)
                            .map(|_| vec![("pg_terminate_backend", Cell::Bool(true))])
                            .collect(),
                    )
                }
            }
        } else if sql.contains("FROM pg_catalog.pg_stat_activity WHERE usename = $1") {
            let count = role
                .and_then(|at| s.roles.get(at))
                .map_or(0, |held| held.sessions);
            one(vec![("count", Cell::Int8(count))])
        } else if sql.contains("pg_stat_clear_snapshot") {
            one(vec![("pg_stat_clear_snapshot", Cell::Void)])
        } else if sql.contains("AS sessions FROM pg_catalog.pg_stat_activity") {
            one(vec![(
                "sessions",
                if s.busy > 0 {
                    text("app/psql/active/client backend")
                } else {
                    Cell::Null(25)
                },
            )])
        } else if sql.contains("pg_prepared_xacts") {
            one(vec![
                ("busy", Cell::Int4(s.busy)),
                ("prepared", Cell::Int4(s.prepared)),
            ])
        } else if sql.contains("pg_switch_wal") {
            one(vec![
                ("lsn", text(&lsn_after(&s.segment))),
                ("segment", text(&s.segment)),
            ])
        } else if sql.contains("pg_ls_archive_statusdir() WHERE name=$1") {
            let _ = parameters;
            one(vec![("done", Cell::Bool(s.archived))])
        } else if sql.contains("pg_postmaster_start_time") {
            one(vec![
                ("database", name(id)),
                ("recovery", Cell::Bool(s.recovery)),
                ("tls", Cell::Bool(true)),
                ("server_address", server_address(sql, ip)),
                ("postmaster_age_ms", Cell::Int8(s.postmaster_age_ms)),
                ("system_identifier", text(&s.system_identifier)),
                ("timeline", Cell::Int4(s.timeline)),
            ])
        } else if sql.contains("pg_control_system") {
            one(vec![
                ("system_identifier", text(&s.system_identifier)),
                ("timeline", Cell::Int4(s.timeline)),
            ])
        } else if sql.contains("AS server_address") {
            one(vec![
                ("database", name(id)),
                ("role", text(user)),
                ("recovery", Cell::Bool(s.recovery)),
                ("server_address", server_address(sql, ip)),
                ("tls", Cell::Bool(true)),
                ("rolsuper", Cell::Bool(false)),
                ("rolcreatedb", Cell::Bool(false)),
                ("rolcreaterole", Cell::Bool(false)),
                ("rolreplication", Cell::Bool(false)),
                ("rolbypassrls", Cell::Bool(false)),
                ("only_stats", Cell::Bool(true)),
                ("stats", Cell::Bool(true)),
                ("archive_listing", Cell::Bool(true)),
            ])
        } else if sql.contains("pg_stat_archiver") {
            // `EXTRACT(EPOCH ...)` is a numeric with six decimals; never archived is `-1`. The
            // last archive was a moment ago, never after the statement is asked.
            let at = now_ms().saturating_sub(1000);
            one(vec![
                ("ready_wal_files", text("0")),
                ("archived_count", text("5")),
                (
                    "last_archived_time",
                    text(&format!("{}.{:06}", at / 1000, (at % 1000) * 1000)),
                ),
                ("failed_count", text("0")),
            ])
        } else if sql.contains("current_setting('server_version')") {
            let column = if sql
                .replace("pg_catalog.", "")
                .contains("host(inet_server_addr())")
            {
                "host"
            } else {
                "inet_server_addr"
            };
            one(vec![
                ("current_user", text(user)),
                ("server_version", text("18.6 (Debian 18.6-1.pgdg13+2)")),
                ("server_version_num", Cell::Int4(180006)),
                ("max_connections", Cell::Int4(20)),
                (
                    "shared_buffers",
                    text(&((request / 4).max(1) * 1024 * 1024).to_string()),
                ),
                (
                    "effective_cache_size",
                    text(&((memory / 2) * 1024 * 1024).to_string()),
                ),
                ("archive_timeout", Cell::Int4(60)),
                ("current_database", text(id)),
                (column, server_address(sql, ip)),
                ("pg_is_in_recovery", Cell::Bool(s.recovery)),
            ])
        } else if sql.contains("FROM pg_roles WHERE rolname=current_user") {
            // The role's own privileges: BYPASSRLS is the one attribute a role can be given.
            one(vec![
                ("rolsuper", Cell::Bool(false)),
                ("rolcreatedb", Cell::Bool(false)),
                ("rolcreaterole", Cell::Bool(false)),
                ("rolreplication", Cell::Bool(false)),
                (
                    "rolbypassrls",
                    Cell::Bool(s.roles.get(user).is_some_and(|held| held.bypass_rls)),
                ),
                ("rolcanlogin", Cell::Bool(true)),
            ])
        } else if sql.contains("pg_has_role(r.oid,'pg_read_all_stats','MEMBER') AS stats") {
            one(vec![
                ("database", name(id)),
                ("recovery", Cell::Bool(s.recovery)),
                ("tls", Cell::Bool(true)),
                ("rolsuper", Cell::Bool(false)),
                ("rolcreatedb", Cell::Bool(false)),
                ("rolcreaterole", Cell::Bool(false)),
                ("rolreplication", Cell::Bool(false)),
                ("rolbypassrls", Cell::Bool(false)),
                ("stats", Cell::Bool(true)),
            ])
        } else {
            Answer::Error("0A000", "statement not served by the test double")
        }
    })
}

pub struct World {
    /// Every login and every statement of PostgreSQL, in the order they happened.
    pub log: Arc<Mutex<Vec<String>>>,
    /// The desired record the next pass sees.
    pub db: Value,
    pub authority: Authority,
    pub postgres: Postgres,
    pub sql: Arc<Mutex<Sql>>,
}
impl World {
    /// A database whose PostgreSQL runs and answers, with the record of the power vectors.
    pub async fn awake() -> Self {
        let vectors: Value = serde_json::from_str(include_str!(
            "../../../packages/contracts/native/power-vectors.generated.json"
        ))
        .unwrap();
        let mut db = vectors["intents"][0]["db"].clone();
        db["creation"]["ever_ready"] = true.into();
        db["creation"]["status"] = "succeeded".into();
        let log: Arc<Mutex<Vec<String>>> = Arc::default();
        let sql = Arc::new(Mutex::new(Sql::default()));
        let authority = Authority::new();
        let (logins, refused) = (log.clone(), sql.clone());
        // Every login is a line of the log, in the order of the statements.
        let login: Login = Arc::new(move |user: &str| {
            logins.lock().unwrap().push(format!("LOGIN {user}"));
            refused.lock().unwrap().refused.get(user).copied()
        });
        let postgres = Postgres::start_with(
            &authority,
            &format!("database-rw.{}.svc", namespace(&db)),
            None,
            answers(db.clone(), sql.clone(), log.clone(), ("SQL", POD_IP)),
            login,
        )
        .await;
        Self {
            log,
            db,
            authority,
            postgres,
            sql,
        }
    }
    /// The address PostgreSQL answers at.
    pub fn address(&self) -> Option<SocketAddr> {
        Some(self.postgres.address)
    }
    /// The desired record of a wake at `generation`, as the API states it.
    pub fn wake(&mut self, generation: u64) {
        self.db["generation"] = generation.into();
        self.db["desired_state"] = "running".into();
        self.db["power"] = json!({"operation":format!("op_{}","w".repeat(20)),"revision":generation,"mode":"running","reason":null});
        self.db["size"]["memory_request_mib"] = 128.into();
    }
    /// PostgreSQL's catalogs hold every present role of the record other than the owner as the
    /// record states it: it logs in, expires, is limited, is a member and bypasses row security
    /// exactly as asked. A role the catalogs hold already keeps its sessions and objects.
    pub fn catalog_follows_desired(&self) {
        let mut sql = self.sql.lock().unwrap();
        for role in present_roles(&self.db).filter(|role| role["owner"] != true) {
            let name = text(role, "name");
            let held = sql.roles.entry(name.to_string()).or_default();
            held.login = true;
            held.valid_until = role["valid_until"].as_str().map(|until| {
                let at = time::OffsetDateTime::parse(
                    until,
                    &time::format_description::well_known::Rfc3339,
                )
                .unwrap();
                Instant::At(at.unix_timestamp(), 0)
            });
            held.connection_limit = role["connection_limit"]
                .as_i64()
                .map_or(-1, |limit| i32::try_from(limit).unwrap());
            held.bypass_rls = role["bypass_rls"] == true;
            held.member_of = role["member_of"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|target| target.as_str().map(str::to_string))
                .collect();
        }
    }
}

/// The double against what PostgreSQL 18.6 of the product image describes for every statement the
/// agent sends to a database. The column types are the `\gdesc` output of the real server and
/// the value shapes its text output; a statement that changes, or a double that answers it with a
/// shape the server does not produce, fails here instead of in a live wake.
#[cfg(test)]
mod wire_tests {
    use super::*;
    use crate::{contracts::constant, postgres, sleep::sql};
    use tokio_postgres::types::Type;

    type Case<'a> = (&'a str, Option<&'a str>, Vec<(&'a str, Type)>);
    /// Every statement the agent sends to a database with the columns PostgreSQL 18.6 of the
    /// product image describes for it (`""` matches any name). `role` is the bound parameter of
    /// the two identity statements.
    fn pinned(role: &str) -> Vec<Case<'_>> {
        let bools = |names: &[&'static str]| -> Vec<(&'static str, Type)> {
            names.iter().map(|n| (*n, Type::BOOL)).collect()
        };
        let archive_identity = constant("ARCHIVE_IDENTITY_QUERY").as_str().unwrap();
        let archive = constant("ARCHIVE_QUERY").as_str().unwrap();
        vec![
            (
                sql("CLEAR"),
                None,
                vec![("pg_stat_clear_snapshot", Type::VOID)],
            ),
            (
                sql("GUARD"),
                None,
                vec![("busy", Type::INT4), ("prepared", Type::INT4)],
            ),
            (
                crate::sleep::BUSY_SESSIONS,
                None,
                vec![("sessions", Type::TEXT)],
            ),
            (
                sql("IDENTITY"),
                Some(role),
                [
                    vec![("database", Type::NAME)],
                    bools(&[
                        "recovery",
                        "tls",
                        "rolsuper",
                        "rolcreatedb",
                        "rolcreaterole",
                        "rolreplication",
                        "rolbypassrls",
                        "stats",
                    ]),
                ]
                .concat(),
            ),
            (
                sql("SWITCH"),
                None,
                vec![("lsn", Type::TEXT), ("segment", Type::TEXT)],
            ),
            (
                sql("ARCHIVE_STATUS"),
                Some("0000000100000000000000A7.done"),
                vec![("done", Type::BOOL)],
            ),
            (
                archive_identity,
                Some(role),
                [
                    vec![
                        ("database", Type::NAME),
                        ("role", Type::TEXT),
                        ("recovery", Type::BOOL),
                        ("server_address", Type::TEXT),
                    ],
                    bools(&[
                        "tls",
                        "rolsuper",
                        "rolcreatedb",
                        "rolcreaterole",
                        "rolreplication",
                        "rolbypassrls",
                        "only_stats",
                        "stats",
                        "archive_listing",
                    ]),
                ]
                .concat(),
            ),
            (
                archive,
                None,
                vec![
                    ("ready_wal_files", Type::TEXT),
                    ("archived_count", Type::TEXT),
                    ("last_archived_time", Type::TEXT),
                    ("failed_count", Type::TEXT),
                ],
            ),
            (
                postgres::ROLE_QUERY,
                None,
                vec![
                    ("", Type::TEXT),
                    ("", Type::TEXT),
                    ("", Type::INT4),
                    ("", Type::INT4),
                    ("", Type::TEXT),
                    ("", Type::TEXT),
                    ("", Type::INT4),
                    ("", Type::TEXT),
                    ("", Type::TEXT),
                    ("", Type::BOOL),
                ],
            ),
            (
                postgres::PRIVILEGES_QUERY,
                None,
                bools(&[
                    "rolsuper",
                    "rolcreatedb",
                    "rolcreaterole",
                    "rolreplication",
                    "rolbypassrls",
                    "rolcanlogin",
                ]),
            ),
            (
                postgres::ACCEPTING_QUERY,
                None,
                vec![
                    ("database", Type::NAME),
                    ("recovery", Type::BOOL),
                    ("tls", Type::BOOL),
                    ("server_address", Type::TEXT),
                    ("postmaster_age_ms", Type::INT8),
                    ("system_identifier", Type::TEXT),
                    ("timeline", Type::INT4),
                ],
            ),
            (
                postgres::SERVER_IDENTITY_QUERY,
                None,
                vec![("system_identifier", Type::TEXT), ("timeline", Type::INT4)],
            ),
            // The role lifecycle: a role's row by name (NULL expiry for none), and the counts
            // that decide whether it can be dropped and whether sessions remain.
            (
                postgres::ROLE_CATALOG_QUERY,
                Some(role),
                vec![
                    ("rolname", Type::NAME),
                    ("rolcanlogin", Type::BOOL),
                    ("rolvaliduntil", Type::TIMESTAMPTZ),
                    ("rolconnlimit", Type::INT4),
                    ("rolbypassrls", Type::BOOL),
                ],
            ),
            (
                postgres::DEPENDENCIES_QUERY,
                Some(role),
                vec![("count", Type::INT8)],
            ),
            (
                postgres::SESSIONS_QUERY,
                Some(role),
                vec![("count", Type::INT8)],
            ),
        ]
    }
    /// The role statements that answer a row per match, which may be none: their columns, read
    /// from the statement the server describes.
    async fn describes(client: &tokio_postgres::Client) {
        for (statement, expected) in [
            (postgres::MEMBERSHIP_QUERY, vec![("rolname", Type::NAME)]),
            (
                postgres::TERMINATE_QUERY,
                vec![("pg_terminate_backend", Type::BOOL)],
            ),
        ] {
            let prepared = client
                .prepare(statement)
                .await
                .unwrap_or_else(|error| panic!("{statement}: {error}"));
            assert_eq!(prepared.params().len(), 1, "{statement}");
            let columns: Vec<_> = prepared
                .columns()
                .iter()
                .map(|column| (column.name().to_string(), column.type_().clone()))
                .collect();
            let expected: Vec<_> = expected
                .into_iter()
                .map(|(name, kind)| (name.to_string(), kind))
                .collect();
            assert_eq!(columns, expected, "{statement}");
        }
    }
    fn text_of(row: &tokio_postgres::Row, column: &str) -> String {
        row.try_get::<_, String>(column).unwrap()
    }
    /// Runs every pinned statement over `client` and checks what comes back against the forms of a
    /// PostgreSQL text output: the columns' types and names, the shape of an LSN, a WAL file name,
    /// an epoch, a server version and a server address. Every cell is what the real server gives.
    async fn conforms(client: &tokio_postgres::Client, role: &str) {
        describes(client).await;
        for (statement, parameter, expected) in pinned(role) {
            let rows = match parameter {
                Some(value) => client.query(statement, &[&value]).await,
                None => client.query(statement, &[]).await,
            }
            .unwrap_or_else(|error| panic!("{statement}: {error}"));
            assert_eq!(rows.len(), 1, "{statement}");
            let columns = rows[0].columns();
            assert_eq!(columns.len(), expected.len(), "{statement}");
            for (column, (name, kind)) in columns.iter().zip(&expected) {
                assert_eq!(column.type_(), kind, "{statement}: {}", column.name());
                if !name.is_empty() {
                    assert_eq!(column.name(), *name, "{statement}");
                }
            }
        }
        let upper_hex = |v: &str| {
            !v.is_empty()
                && v.bytes()
                    .all(|b| b.is_ascii_digit() || (b'A'..=b'F').contains(&b))
        };
        let switched = client.query(sql("SWITCH"), &[]).await.unwrap();
        let (lsn, segment) = (
            text_of(&switched[0], "lsn"),
            text_of(&switched[0], "segment"),
        );
        let (log, offset) = lsn.split_once('/').unwrap();
        assert!(upper_hex(log) && upper_hex(offset), "{lsn}");
        assert!(segment.len() == 24 && upper_hex(&segment), "{segment}");
        // `EXTRACT(EPOCH ...)` is a numeric printed with six decimals; never archived is `-1`.
        let archive = constant("ARCHIVE_QUERY").as_str().unwrap();
        let time = text_of(
            &client.query(archive, &[]).await.unwrap()[0],
            "last_archived_time",
        );
        assert!(
            time == "-1"
                || time.split_once('.').is_some_and(|(whole, fraction)| {
                    !whole.is_empty()
                        && whole.bytes().all(|b| b.is_ascii_digit())
                        && fraction.len() == 6
                        && fraction.bytes().all(|b| b.is_ascii_digit())
                }),
            "{time}"
        );
        // The server's own version string and numeric version.
        let settings = &client.query(postgres::ROLE_QUERY, &[]).await.unwrap()[0];
        let version = settings.try_get::<_, String>(1).unwrap();
        let number = version.split_whitespace().next().unwrap();
        assert!(
            number.split('.').count() == 2
                && number
                    .split('.')
                    .all(|part| part.bytes().all(|b| b.is_ascii_digit())),
            "{version}"
        );
        assert!(settings.try_get::<_, i32>(2).unwrap() >= 180_000);
        // Every address a statement returns as text is an address and carries no netmask.
        let address = |text: String| {
            assert!(!text.contains('/'), "{text}");
            text.parse::<std::net::IpAddr>()
                .unwrap_or_else(|_| panic!("{text} is an address"));
            text
        };
        let role_address = address(settings.try_get::<_, String>(8).unwrap());
        let accepting = &client.query(postgres::ACCEPTING_QUERY, &[]).await.unwrap()[0];
        assert_eq!(text_of(accepting, "server_address"), role_address);
        let identity = &client
            .query(
                constant("ARCHIVE_IDENTITY_QUERY").as_str().unwrap(),
                &[&role],
            )
            .await
            .unwrap()[0];
        assert_eq!(text_of(identity, "server_address"), role_address);
    }
    /// The table above against a real PostgreSQL: set `PGCF_TEST_POSTGRES_ADDR` to `host:port` of
    /// a server that trusts `postgres` (the product image started with `initdb -A trust` does).
    /// The statements are read only apart from the WAL switch of the sleep proof. Without the
    /// variable the test is skipped.
    #[tokio::test]
    async fn the_pinned_forms_are_what_a_real_postgresql_gives() {
        let Ok(address) = std::env::var("PGCF_TEST_POSTGRES_ADDR") else {
            eprintln!("skipped: PGCF_TEST_POSTGRES_ADDR names no PostgreSQL");
            return;
        };
        let (host, port) = address.rsplit_once(':').expect("host:port");
        let (client, connection) = tokio_postgres::Config::new()
            .host(host)
            .port(port.parse().unwrap())
            .user("postgres")
            .dbname("postgres")
            .connect(tokio_postgres::NoTls)
            .await
            .unwrap();
        tokio::spawn(connection);
        conforms(&client, "postgres").await;
    }
    /// The double answers the same statements with the same types and forms, and the three ways
    /// an `inet` reaches a column.
    #[tokio::test]
    async fn the_double_gives_every_statement_the_types_and_forms_postgresql_does() {
        let w = World::awake().await;
        let role = crate::contracts::text(&w.db["maintenance"], "role");
        // The role the statements are bound to exists in the catalogs of the double.
        w.sql
            .lock()
            .unwrap()
            .roles
            .insert(role.to_string(), RoleRow::default());
        let session = postgres::connect_via(
            &w.db,
            w.authority.pem.as_bytes(),
            role,
            crate::contracts::text(&w.db["maintenance"], "password"),
            crate::contracts::text(&w.db, "id"),
            w.address(),
        )
        .await
        .unwrap();
        conforms(&session.client, role).await;
        let settings = &session.query(postgres::ROLE_QUERY, &[]).await.unwrap()[0];
        assert_eq!(settings.try_get::<_, String>(8).unwrap(), POD_IP);
        assert_eq!(
            settings.try_get::<_, String>(1).unwrap(),
            "18.6 (Debian 18.6-1.pgdg13+2)"
        );
        // The three forms of the same value: `host()` is the address alone, the cast to `text`
        // keeps the netmask (the form that blocked every wake of r2.12), and the bare `inet` is a
        // binary value that no string decode accepts.
        let wanted = "pg_catalog.host(pg_catalog.inet_server_addr())";
        assert!(postgres::ROLE_QUERY.contains(wanted));
        let cast = postgres::ROLE_QUERY.replace(wanted, "inet_server_addr()::text");
        let row = &session.query(cast.as_str(), &[]).await.unwrap()[0];
        assert_eq!(row.try_get::<_, String>(8).unwrap(), format!("{POD_IP}/32"));
        let bare = postgres::ROLE_QUERY.replace(wanted, "inet_server_addr()");
        let row = &session.query(bare.as_str(), &[]).await.unwrap()[0];
        assert_eq!(row.columns()[8].type_(), &Type::INET);
        assert!(row.try_get::<_, String>(8).is_err());
        // A WAL file name of the double carries a letter, as about half of PostgreSQL's do.
        let segment = text_of(
            &session.query(sql("SWITCH"), &[]).await.unwrap()[0],
            "segment",
        );
        assert!(segment.bytes().any(|b| b.is_ascii_uppercase()), "{segment}");
    }
}
