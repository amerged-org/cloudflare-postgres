// SPDX-License-Identifier: Apache-2.0
//! The roles of a database (plan 5.6 job 5, 5.10, 7.8 step 5; `NodeDesiredDatabase.roles`): the
//! agent makes PostgreSQL hold exactly the roles the desired page states, as the agent role over the
//! database's socket. A role is written when the page's revision of it is not the one applied, and
//! never otherwise, so that a wake with nothing changed runs no statement. A role the API deleted
//! (`state: "absent"`) is made NOLOGIN, loses its sessions and is dropped, or reported blocked.

use crate::{
    Error,
    node_link::constant,
    postgres::{
        DEPENDENCIES_QUERY, MEMBERSHIP_QUERY, ROLE_CATALOG_QUERY, SESSIONS_QUERY, Session,
        TERMINATE_QUERY,
    },
    scram,
    settings::{AGENT_ROLE, BACKUP_ROLE},
};
use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet},
    time::Duration,
};

/// The role that owns the tenant's database (`OWNER_ROLE_NAME` of the contract).
pub const OWNER_ROLE: &str = "app";

/// How long the sessions of a role that is being removed may take to end.
const SESSIONS_END: Duration = Duration::from_secs(3);

/// A role the page states (`DesiredRole`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Role {
    pub name: String,
    pub owner: bool,
    pub password: String,
    pub revision: u64,
    /// The contract's timestamp; applied at whole seconds.
    pub valid_until: Option<String>,
    pub connection_limit: Option<u32>,
    pub member_of: Vec<String>,
    pub bypass_rls: bool,
}

/// One entry of the page's roles.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Wanted {
    Present(Role),
    /// `DesiredRoleRemoval`: a role the API deleted, to be removed from PostgreSQL.
    Absent(String),
}

/// Whether a role entry of the page is a removal (`DesiredRoleRemoval`): `state: "absent"` and no
/// property of a present role. The schema the node holds is open, so that a property it does not
/// know is ignored; a present role that also says `state: "absent"` is then valid to it (it
/// matches either variant), and the removal would set it NOLOGIN, end its sessions and drop it.
/// The contract refuses such a role, and so does the node.
pub(crate) fn removal(role: &Value) -> bool {
    role["state"] == "absent"
        && constant("PRESENT_ROLE_PROPERTIES")
            .as_array()
            .expect("generated role properties")
            .iter()
            .filter_map(Value::as_str)
            .all(|property| role.get(property).is_none())
}

/// A role name as the contract allows it (`^[a-z][a-z0-9_]{0,62}$`), which needs no quoting.
fn role_name(name: &str) -> bool {
    (1..=63).contains(&name.len())
        && name.as_bytes()[0].is_ascii_lowercase()
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
}

/// The roles of a database entry of the desired page; `None` for a role that is not what the
/// contract states, so that nothing unchecked reaches a statement.
pub fn parse(roles: &[Value]) -> Option<Vec<Wanted>> {
    roles
        .iter()
        .map(|role| {
            let name = role["name"].as_str().filter(|name| role_name(name))?;
            if role.get("state").is_some() {
                return removal(role).then(|| Wanted::Absent(name.into()));
            }
            let member_of = role["member_of"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|target| target.as_str().filter(|t| role_name(t)).map(String::from))
                .collect::<Option<Vec<_>>>()?;
            Some(Wanted::Present(Role {
                name: name.into(),
                owner: role["owner"].as_bool()?,
                password: role["password"].as_str()?.into(),
                revision: role["revision"].as_u64()?,
                valid_until: match role.get("valid_until") {
                    None => None,
                    Some(until) => Some(until.as_str().filter(|u| timestamp(u))?.into()),
                },
                connection_limit: match role.get("connection_limit") {
                    None => None,
                    Some(limit) => Some(u32::try_from(limit.as_u64()?).ok()?),
                },
                member_of,
                bypass_rls: role["bypass_rls"] == true,
            }))
        })
        .collect()
}

/// A contract timestamp, `YYYY-MM-DDTHH:MM:SS.mmmZ`.
pub(crate) fn timestamp(text: &str) -> bool {
    let bytes = text.as_bytes();
    bytes.len() == 24
        && bytes.iter().enumerate().all(|(index, b)| match index {
            4 | 7 => *b == b'-',
            10 => *b == b'T',
            13 | 16 => *b == b':',
            19 => *b == b'.',
            23 => *b == b'Z',
            _ => b.is_ascii_digit(),
        })
}

fn quote_identifier(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}
fn quote_literal(text: &str) -> String {
    format!("'{}'", text.replace('\'', "''"))
}

/// The statement that makes a role what the page states: `CREATE ROLE` or `ALTER ROLE`. The
/// attributes a tenant could use to leave its database are never granted. `verifier` is the
/// password's SCRAM-SHA-256 verifier.
fn role_statement(role: &Role, exists: bool, verifier: &str) -> String {
    let verb = if exists { "ALTER" } else { "CREATE" };
    let until = role
        .valid_until
        .as_deref()
        .map_or("infinity".to_string(), |until| {
            // Applied at whole seconds, truncated.
            format!("{} {}+00", &until[..10], &until[11..19])
        });
    format!(
        "{verb} ROLE {} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION {} \
         CONNECTION LIMIT {} PASSWORD {} VALID UNTIL {}",
        quote_identifier(&role.name),
        if role.bypass_rls {
            "BYPASSRLS"
        } else {
            "NOBYPASSRLS"
        },
        role.connection_limit.map_or(-1, i64::from),
        quote_literal(verifier),
        quote_literal(&until),
    )
}

/// Whether anything of the page's roles is yet to be written: a revision the node has not applied,
/// or a role waiting to be removed.
pub fn needs_apply(wanted: &[Wanted], applied: &BTreeMap<String, u64>) -> bool {
    let present: BTreeSet<&str> = wanted
        .iter()
        .filter_map(|role| match role {
            Wanted::Present(role) => Some(role.name.as_str()),
            Wanted::Absent(_) => None,
        })
        .collect();
    wanted.iter().any(|role| match role {
        Wanted::Present(role) => applied.get(&role.name) != Some(&role.revision),
        Wanted::Absent(_) => true,
    }) || applied.keys().any(|name| !present.contains(name.as_str()))
}

/// What a pass over the roles did.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Report {
    /// The revision of every present role, which the node keeps as applied.
    pub revisions: BTreeMap<String, u64>,
    /// The roles of the page that are gone from PostgreSQL, sorted.
    pub removed: Vec<String>,
    /// The roles that could not be removed yet: they own something, or hold a session.
    pub blocked: Vec<String>,
}

/// The roles `role` is a member of, sorted.
async fn held_roles(session: &Session, role: &str) -> Result<Vec<String>, Error> {
    let mut held = session
        .query(MEMBERSHIP_QUERY, &[&role])
        .await?
        .iter()
        .map(|row| row.try_get::<_, String>(0))
        .collect::<Result<Vec<_>, _>>()?;
    held.sort();
    Ok(held)
}

/// Whether PostgreSQL has the role, and whether it can still log in.
enum Held {
    Absent,
    Login,
    NoLogin,
}
async fn held(session: &Session, name: &str) -> Result<Held, Error> {
    let rows = session.query(ROLE_CATALOG_QUERY, &[&name]).await?;
    match rows.as_slice() {
        [] => Ok(Held::Absent),
        [row] if row.try_get::<_, bool>("rolcanlogin")? => Ok(Held::Login),
        [_] => Ok(Held::NoLogin),
        _ => Err("role catalog ambiguous".into()),
    }
}

/// Ends the sessions of the role and says whether none remain.
async fn end_sessions(session: &Session, name: &str) -> Result<bool, Error> {
    session.query(TERMINATE_QUERY, &[&name]).await?;
    let started = tokio::time::Instant::now();
    loop {
        let rows = session.query(SESSIONS_QUERY, &[&name]).await?;
        let [row] = rows.as_slice() else {
            return Err("role sessions unavailable".into());
        };
        if row.try_get::<_, i64>(0)? == 0 {
            return Ok(true);
        }
        if started.elapsed() >= SESSIONS_END {
            return Ok(false);
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

/// Removes a role the API deleted: NOLOGIN first, then its sessions, then the role. `true` when it
/// is gone.
async fn remove(session: &Session, name: &str) -> Result<bool, Error> {
    let login = match held(session, name).await? {
        Held::Absent => return Ok(true),
        Held::Login => true,
        Held::NoLogin => false,
    };
    let quoted = quote_identifier(name);
    if login {
        session
            .batch(&format!("ALTER ROLE {quoted} NOLOGIN"))
            .await?;
    }
    if !end_sessions(session, name).await? {
        return Ok(false);
    }
    let rows = session.query(DEPENDENCIES_QUERY, &[&name]).await?;
    let [row] = rows.as_slice() else {
        return Err("role dependencies unavailable".into());
    };
    if row.try_get::<_, i64>(0)? > 0 {
        return Ok(false);
    }
    session.batch(&format!("DROP ROLE {quoted}")).await?;
    Ok(true)
}

/// The role of barman's base backups (plan 7.6) and what barman 3.20 needs of it: `pg_checkpoint`,
/// `pg_monitor` and `EXECUTE` on the backup functions (`archive::job::BACKUP_ROLE`). It logs in by
/// peer, as the database's own Linux user (`pg_ident.conf`), and has no password.
const BACKUP_ROLE_SQL: &str = "\
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'pgcf_backup') THEN
    CREATE ROLE pgcf_backup LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END $$;
GRANT pg_checkpoint, pg_monitor TO pgcf_backup;
GRANT CONNECT ON DATABASE postgres TO pgcf_backup;
GRANT EXECUTE ON FUNCTION pg_catalog.pg_backup_start(text, boolean), pg_catalog.pg_backup_stop(boolean),
  pg_catalog.pg_switch_wal(), pg_catalog.pg_create_restore_point(text) TO pgcf_backup";

/// Makes the backup role what barman needs.
pub async fn ensure_backup_role(session: &Session) -> Result<(), Error> {
    debug_assert_eq!(BACKUP_ROLE, "pgcf_backup");
    session.batch(BACKUP_ROLE_SQL).await
}

/// Makes the database `<id>` owned by `owner`, which the tenant's roles use; the cluster's own
/// `postgres` and `template1` stay for the agent.
pub async fn ensure_database(session: &Session, database: &str, owner: &str) -> Result<(), Error> {
    let exists = session
        .query(
            "SELECT 1 FROM pg_catalog.pg_database WHERE datname = $1",
            &[&database],
        )
        .await?;
    if exists.is_empty() {
        session
            .batch_long(&format!(
                "CREATE DATABASE {} OWNER {}",
                quote_identifier(database),
                quote_identifier(owner)
            ))
            .await?;
    }
    Ok(())
}

/// Makes PostgreSQL hold the page's roles. A present role is written when its applied revision is
/// not the page's, or when PostgreSQL does not have it; its memberships are made exactly the
/// page's. A role awaiting removal is removed or reported blocked. With `exact`, every other role
/// that can log in (but the agent's and the backup role) is made NOLOGIN: the roles of a restored
/// cluster are the source's, and only the page's may log in.
pub async fn apply(
    session: &Session,
    wanted: &[Wanted],
    applied: &BTreeMap<String, u64>,
    exact: bool,
) -> Result<Report, Error> {
    let mut revisions = BTreeMap::new();
    for role in wanted {
        let Wanted::Present(role) = role else {
            continue;
        };
        let exists = !matches!(held(session, &role.name).await?, Held::Absent);
        if !exists || applied.get(&role.name) != Some(&role.revision) {
            let verifier = scram::verifier(&role.password).ok_or("role password invalid")?;
            session
                .batch(&role_statement(role, exists, &verifier))
                .await?;
        }
        revisions.insert(role.name.clone(), role.revision);
    }
    for role in wanted {
        let Wanted::Present(role) = role else {
            continue;
        };
        let held = held_roles(session, &role.name).await?;
        let mut wanted_roles = role.member_of.clone();
        wanted_roles.sort();
        let quoted = quote_identifier(&role.name);
        for target in wanted_roles.iter().filter(|target| !held.contains(target)) {
            session
                .batch(&format!("GRANT {} TO {quoted}", quote_identifier(target)))
                .await?;
        }
        for target in held.iter().filter(|target| !wanted_roles.contains(target)) {
            session
                .batch(&format!(
                    "REVOKE {} FROM {quoted}",
                    quote_identifier(target)
                ))
                .await?;
        }
    }
    let (mut removed, mut blocked) = (Vec::new(), Vec::new());
    for role in wanted {
        if let Wanted::Absent(name) = role {
            if remove(session, name).await? {
                removed.push(name.clone());
            } else {
                blocked.push(name.clone());
            }
        }
    }
    if exact {
        let named: Vec<&str> = wanted
            .iter()
            .map(|role| match role {
                Wanted::Present(role) => role.name.as_str(),
                Wanted::Absent(name) => name.as_str(),
            })
            .chain([AGENT_ROLE, BACKUP_ROLE])
            .collect();
        let rows = session
            .query(
                "SELECT rolname::pg_catalog.text FROM pg_catalog.pg_roles WHERE rolcanlogin AND rolname <> ALL($1)",
                &[&named],
            )
            .await?;
        for row in rows {
            let name: String = row.try_get(0)?;
            session
                .batch(&format!("ALTER ROLE {} NOLOGIN", quote_identifier(&name)))
                .await?;
            end_sessions(session, &name).await?;
        }
    }
    removed.sort();
    blocked.sort();
    Ok(Report {
        revisions,
        removed,
        blocked,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{postgres, testpg::Cluster};
    use serde_json::json;

    fn pw() -> String {
        crate::testpg::password(1)
    }
    fn other_pw() -> String {
        crate::testpg::password(2)
    }

    fn wanted(roles: serde_json::Value) -> Vec<Wanted> {
        parse(roles.as_array().unwrap()).unwrap()
    }
    fn page() -> serde_json::Value {
        json!([
            {"name":"app","owner":true,"password":pw(),"revision":1},
            {"name":"base","owner":false,"password":pw(),"revision":1},
            {"name":"reader","owner":false,"password":pw(),"revision":3,
             "valid_until":"2031-01-02T03:04:05.678Z","connection_limit":5,"member_of":["base"]},
            {"name":"bypasser","owner":false,"password":pw(),"revision":2,"bypass_rls":true}
        ])
    }
    async fn login(
        cluster: &Cluster,
        role: &str,
        password: impl AsRef<str>,
    ) -> Result<(), tokio_postgres::Error> {
        let mut config = tokio_postgres::Config::new();
        config
            .host_path(cluster.socket_directory())
            .port(crate::layout::PORT)
            .user(role)
            .password(password.as_ref())
            .dbname("postgres");
        let (client, connection) = config.connect(tokio_postgres::NoTls).await?;
        tokio::spawn(connection);
        client.simple_query("SELECT 1").await.map(|_| ())
    }
    async fn started() -> Option<(Cluster, postgres::Session)> {
        let cluster = Cluster::create("roles")?;
        cluster.start();
        let agent = cluster.agent().await;
        Some((cluster, agent))
    }

    #[test]
    fn the_page_is_read_into_present_and_absent_roles() {
        let roles = wanted(json!([
            {"name":"app","owner":true,"password":pw(),"revision":1},
            {"name":"gone","state":"absent"},
            {"name":"reader","owner":false,"password":pw(),"revision":4,"connection_limit":9,
             "member_of":["base"],"valid_until":"2031-01-02T03:04:05.678Z","bypass_rls":true}
        ]));
        assert_eq!(roles.len(), 3);
        assert!(matches!(&roles[0], Wanted::Present(role) if role.owner && role.revision == 1));
        assert_eq!(roles[1], Wanted::Absent("gone".into()));
        let Wanted::Present(reader) = &roles[2] else {
            panic!("a present role")
        };
        assert_eq!(reader.connection_limit, Some(9));
        assert_eq!(reader.member_of, ["base"]);
        assert!(reader.bypass_rls);
        // A role that could not be written as a name, or that has no credential, is no role.
        for broken in [
            json!({"name":"Bad Name","owner":false,"password":pw(),"revision":1}),
            json!({"name":"x\"y","owner":false,"password":pw(),"revision":1}),
            json!({"name":"x","owner":false,"revision":1}),
            json!({"name":"x","owner":false,"password":pw()}),
            json!({"name":"x","state":"present"}),
        ] {
            assert!(parse(std::slice::from_ref(&broken)).is_none(), "{broken}");
        }
    }

    #[test]
    fn a_role_is_present_or_removed_never_both() {
        let properties: Vec<&str> = constant("PRESENT_ROLE_PROPERTIES")
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|property| property.as_str())
            .collect();
        assert_eq!(
            properties,
            [
                "owner",
                "password",
                "revision",
                "valid_until",
                "connection_limit",
                "member_of",
                "bypass_rls"
            ]
        );
        let mut present = json!({"name":"reader","owner":false,"password":pw(),"revision":2,
            "valid_until":"2031-01-02T03:04:05.678Z","connection_limit":5,"bypass_rls":true});
        assert!(matches!(
            wanted(json!([present.clone()]))[0],
            Wanted::Present(_)
        ));
        // With `state: "absent"` added it is not read as a removal that drops the role.
        present["state"] = json!("absent");
        assert!(parse(std::slice::from_ref(&present)).is_none());
        // A removal that names any one property of a present role is refused, whatever its value.
        for property in properties {
            let removal = json!({"name":"gone","state":"absent",property:null});
            assert!(parse(std::slice::from_ref(&removal)).is_none(), "{removal}");
        }
        assert_eq!(
            wanted(json!([{"name":"gone","state":"absent"}])),
            [Wanted::Absent("gone".into())]
        );
    }

    #[test]
    fn a_role_statement_states_every_attribute_and_nothing_a_tenant_could_use() {
        let roles = wanted(page());
        let Wanted::Present(reader) = &roles[2] else {
            panic!("a present role")
        };
        let create = role_statement(reader, false, "SCRAM-SHA-256$4096:c2FsdA==$a:b");
        assert_eq!(
            create,
            "CREATE ROLE \"reader\" WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION \
             NOBYPASSRLS CONNECTION LIMIT 5 PASSWORD 'SCRAM-SHA-256$4096:c2FsdA==$a:b' \
             VALID UNTIL '2031-01-02 03:04:05+00'"
        );
        let Wanted::Present(plain) = &roles[1] else {
            panic!("a present role")
        };
        let alter = role_statement(plain, true, "SCRAM-SHA-256$4096:c2FsdA==$a:b");
        assert!(alter.starts_with("ALTER ROLE \"base\" WITH LOGIN "));
        assert!(alter.contains("CONNECTION LIMIT -1"));
        assert!(alter.ends_with("VALID UNTIL 'infinity'"));
        let Wanted::Present(bypasser) = &roles[3] else {
            panic!("a present role")
        };
        assert!(role_statement(bypasser, false, "v").contains(" BYPASSRLS "));
    }

    #[tokio::test]
    async fn the_roles_of_the_page_are_what_postgresql_holds_and_logs_in() {
        let Some((cluster, agent)) = started().await else {
            return;
        };
        let report = apply(&agent, &wanted(page()), &BTreeMap::new(), false)
            .await
            .unwrap();
        assert_eq!(
            report.revisions,
            BTreeMap::from([
                ("app".to_string(), 1),
                ("base".to_string(), 1),
                ("bypasser".to_string(), 2),
                ("reader".to_string(), 3)
            ])
        );
        assert_eq!((report.removed.len(), report.blocked.len()), (0, 0));

        let rows = agent
            .query(
                "SELECT rolname::text, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, \
                 rolbypassrls, rolconnlimit, rolvaliduntil::text FROM pg_roles WHERE rolname = ANY($1) ORDER BY 1",
                &[&vec!["app", "base", "bypasser", "reader"]],
            )
            .await
            .unwrap();
        for row in &rows {
            let name: String = row.get(0);
            assert!(row.get::<_, bool>(1), "{name} logs in");
            assert!(!row.get::<_, bool>(2) && !row.get::<_, bool>(3), "{name}");
            assert!(!row.get::<_, bool>(4) && !row.get::<_, bool>(5), "{name}");
            assert_eq!(row.get::<_, bool>(6), name == "bypasser", "{name} bypass");
            assert_eq!(
                row.get::<_, i32>(7),
                if name == "reader" { 5 } else { -1 },
                "{name}"
            );
            // No expiry is `infinity`.
            assert_eq!(
                row.get::<_, Option<String>>(8).as_deref(),
                Some(if name == "reader" {
                    "2031-01-02 03:04:05+00"
                } else {
                    "infinity"
                }),
                "{name}"
            );
        }
        let held = held_roles(&agent, "reader").await.unwrap();
        assert_eq!(held, ["base"]);
        // Every role logs in with its password over the socket, by SCRAM.
        for role in ["app", "base", "bypasser", "reader"] {
            login(&cluster, role, pw()).await.unwrap();
            assert!(login(&cluster, role, other_pw()).await.is_err(), "{role}");
        }
    }

    #[tokio::test]
    async fn a_role_is_written_when_its_revision_moves_and_not_otherwise() {
        let Some((cluster, agent)) = started().await else {
            return;
        };
        let first = apply(&agent, &wanted(page()), &BTreeMap::new(), false)
            .await
            .unwrap();
        assert!(!needs_apply(&wanted(page()), &first.revisions));
        // Someone changed the password in PostgreSQL: with the revision applied, nothing writes.
        agent
            .batch(&format!("ALTER ROLE reader PASSWORD '{}'", other_pw()))
            .await
            .unwrap();
        apply(&agent, &wanted(page()), &first.revisions, false)
            .await
            .unwrap();
        assert!(login(&cluster, "reader", pw()).await.is_err());
        login(&cluster, "reader", other_pw()).await.unwrap();
        // The page moves the role to revision 4: a new password, no limit, no expiry, no membership.
        let mut next = page();
        next[2] = json!({"name":"reader","owner":false,"password":other_pw(),"revision":4});
        assert!(needs_apply(&wanted(next.clone()), &first.revisions));
        let second = apply(&agent, &wanted(next), &first.revisions, false)
            .await
            .unwrap();
        assert_eq!(second.revisions["reader"], 4);
        let rows = agent
            .query(
                "SELECT rolconnlimit, rolvaliduntil::text FROM pg_roles WHERE rolname = 'reader'",
                &[],
            )
            .await
            .unwrap();
        assert_eq!(rows[0].get::<_, i32>(0), -1);
        assert_eq!(
            rows[0].get::<_, Option<String>>(1).as_deref(),
            Some("infinity")
        );
        assert!(held_roles(&agent, "reader").await.unwrap().is_empty());
        // The other roles kept the password they had.
        login(&cluster, "base", pw()).await.unwrap();
        // A role that PostgreSQL lost is made again although its revision was applied.
        agent.batch("DROP ROLE bypasser").await.unwrap();
        apply(&agent, &wanted(page()), &second.revisions, false)
            .await
            .unwrap();
        login(&cluster, "bypasser", pw()).await.unwrap();
    }

    #[tokio::test]
    async fn a_deleted_role_loses_its_login_and_sessions_and_is_dropped_unless_it_owns_something() {
        let Some((cluster, agent)) = started().await else {
            return;
        };
        let report = apply(&agent, &wanted(page()), &BTreeMap::new(), false)
            .await
            .unwrap();
        // `reader` has a session; `bypasser` owns a table.
        let session = {
            let mut config = tokio_postgres::Config::new();
            config
                .host_path(cluster.socket_directory())
                .port(crate::layout::PORT)
                .user("reader")
                .password(pw())
                .dbname("postgres");
            let (client, connection) = config.connect(tokio_postgres::NoTls).await.unwrap();
            tokio::spawn(connection);
            client
        };
        agent.batch("CREATE TABLE owned_by_bypasser (a int); ALTER TABLE owned_by_bypasser OWNER TO bypasser").await.unwrap();
        let mut roles = wanted(page());
        roles.retain(|role| !matches!(role, Wanted::Present(r) if r.name == "reader" || r.name == "bypasser"));
        roles.push(Wanted::Absent("reader".into()));
        roles.push(Wanted::Absent("bypasser".into()));
        roles.push(Wanted::Absent("never_existed".into()));
        let after = apply(&agent, &roles, &report.revisions, false)
            .await
            .unwrap();
        assert_eq!(after.removed, ["never_existed", "reader"]);
        assert_eq!(after.blocked, ["bypasser"]);
        assert!(
            session.simple_query("SELECT 1").await.is_err(),
            "the session ended"
        );
        assert!(login(&cluster, "reader", pw()).await.is_err());
        // The role with a table is still there, and cannot log in.
        let rows = agent
            .query(
                "SELECT rolcanlogin FROM pg_roles WHERE rolname = 'bypasser'",
                &[],
            )
            .await
            .unwrap();
        assert!(!rows[0].get::<_, bool>(0));
        assert!(login(&cluster, "bypasser", pw()).await.is_err());
        // Once the tenant has dropped what it owned, the next pass drops the role.
        agent.batch("DROP TABLE owned_by_bypasser").await.unwrap();
        let later = apply(&agent, &roles, &after.revisions, false)
            .await
            .unwrap();
        assert_eq!(later.removed, ["bypasser", "never_existed", "reader"]);
        assert!(later.blocked.is_empty());
    }

    #[tokio::test]
    async fn a_restored_database_keeps_no_login_the_page_does_not_name() {
        let Some((cluster, agent)) = started().await else {
            return;
        };
        agent
            .batch(&format!(
                "CREATE ROLE ghost LOGIN PASSWORD '{}'; CREATE ROLE app LOGIN PASSWORD '{}'",
                pw(),
                other_pw()
            ))
            .await
            .unwrap();
        let roles = wanted(json!([{"name":"app","owner":true,"password":pw(),"revision":1}]));
        let report = apply(&agent, &roles, &BTreeMap::new(), true).await.unwrap();
        assert_eq!(report.revisions["app"], 1);
        login(&cluster, "app", pw()).await.unwrap();
        assert!(login(&cluster, "ghost", pw()).await.is_err());
        // The role is made NOLOGIN, not dropped: it may own what the restored data holds.
        let rows = agent
            .query(
                "SELECT rolcanlogin FROM pg_roles WHERE rolname = 'ghost'",
                &[],
            )
            .await
            .unwrap();
        assert!(!rows[0].get::<_, bool>(0));
        // The roles of the cluster itself are not touched.
        let rows = agent
            .query(
                "SELECT rolcanlogin FROM pg_roles WHERE rolname = 'postgres'",
                &[],
            )
            .await
            .unwrap();
        assert!(rows[0].get::<_, bool>(0));
    }

    #[tokio::test]
    async fn the_backup_role_can_run_a_backup_and_nothing_else_and_the_database_is_the_owners() {
        let Some((cluster, agent)) = started().await else {
            return;
        };
        ensure_backup_role(&agent).await.unwrap();
        // Again changes nothing and fails nothing.
        ensure_backup_role(&agent).await.unwrap();
        apply(&agent, &wanted(page()), &BTreeMap::new(), false)
            .await
            .unwrap();
        ensure_database(&agent, "d0123456789abcdefghi", "app")
            .await
            .unwrap();
        ensure_database(&agent, "d0123456789abcdefghi", "app")
            .await
            .unwrap();
        let rows = agent
            .query(
                "SELECT pg_catalog.pg_get_userbyid(datdba)::text FROM pg_database WHERE datname = 'd0123456789abcdefghi'",
                &[],
            )
            .await
            .unwrap();
        assert_eq!(rows[0].get::<_, String>(0), "app");

        // By peer, as the database's own user, it runs what barman 3.20 runs.
        let backup = postgres::connect(&cluster.socket_directory(), "pgcf_backup", "postgres")
            .await
            .unwrap();
        backup
            .query("SELECT pg_backup_start('pgcf', true)", &[])
            .await
            .unwrap();
        backup
            .query("SELECT pg_create_restore_point('pgcf')", &[])
            .await
            .unwrap();
        backup.query("SELECT pg_switch_wal()", &[]).await.unwrap();
        backup
            .query("SELECT * FROM pg_backup_stop(true)", &[])
            .await
            .unwrap();
        backup.batch_long("CHECKPOINT").await.unwrap();
        backup
            .query("SELECT count(*) FROM pg_stat_activity", &[])
            .await
            .unwrap();
        // It cannot make a role or read what a tenant keeps.
        assert!(backup.batch("CREATE ROLE intruder").await.is_err());
        assert!(
            backup
                .batch("ALTER SYSTEM SET work_mem = '1GB'")
                .await
                .is_err()
        );
        let rows = backup
            .query("SELECT rolsuper, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname = current_user", &[])
            .await
            .unwrap();
        assert!((0..4).all(|i| !rows[0].get::<_, bool>(i)));
        // The tenant's roles do not log in by peer, whoever the Linux user is.
        assert!(
            postgres::connect(&cluster.socket_directory(), "app", "postgres")
                .await
                .is_err()
        );
    }
}
