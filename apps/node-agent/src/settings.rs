// SPDX-License-Identifier: Apache-2.0
//! The configuration the agent writes for every database (plan 4.4, 5.5, 7.5 and Appendix C):
//! `postgresql.conf` by the database's size, and the two files that decide who may log in. The
//! agent owns all three; a restored database's are the source's, and are replaced before it starts.
use std::path::Path;

const MIB: u64 = 1024 * 1024;
/// The role of the node agent. It is the cluster's superuser: `initdb -U postgres`, and only the
/// operating system's root reaches it, through the `pgcf_agent` map of `pg_ident.conf`.
pub const AGENT_ROLE: &str = "postgres";
/// The role of barman's base backups (`archive::job::BACKUP_ROLE`).
pub use crate::archive::job::BACKUP_ROLE;
/// Up to this size a database runs the settings of the small column of the plan's table.
const SMALL_DATABASE_MEMORY_MIB: u64 = 512;

/// What a small database runs besides the memory settings (plan Appendix C): one autovacuum worker
/// out of two slots, one I/O worker, no parallel query or parallel maintenance, four background
/// worker slots, and no replication of any kind. Autoprewarm needs two of the slots, its leader
/// and its worker for one database at a time (with one slot the load fails with "registering
/// dynamic bgworker autoprewarm failed", checked on PostgreSQL 18); the other two are spare for a
/// parallel worker a session asks for. `max_parallel_workers` keeps its default of 8: it only
/// caps the workers, which come from the free slots, and none is planned. Nothing replicates:
/// `pg_hba.conf` refuses replication connections and barman's base backup uses the backup API, so
/// no WAL sender, slot or logical worker (and no logical replication launcher process) is ever
/// needed. A recovery compares `max_worker_processes` and `max_wal_senders` with the source's, so
/// a restore runs with more (`archive::recovery::settings`).
const SMALL_DATABASE_SETTINGS: &str = "\
autovacuum_max_workers = 1\n\
autovacuum_worker_slots = 2\n\
io_workers = 1\n\
max_parallel_workers_per_gather = 0\n\
max_parallel_maintenance_workers = 0\n\
max_worker_processes = 4\n\
max_logical_replication_workers = 0\n\
max_wal_senders = 0\n\
max_replication_slots = 0\n";

/// What PostgreSQL's memory settings are for a database of `memory_mib` (plan Appendix C): the
/// shared buffers stay small because shared memory cannot be reclaimed without swap, and the page
/// cache does the caching. A small database (up to 512 MiB) also runs `SMALL_DATABASE_SETTINGS`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Tuning {
    pub shared_buffers_mib: u64,
    pub effective_cache_size_mib: u64,
    pub work_mem_mib: u64,
    pub maintenance_work_mem_mib: u64,
    pub small: bool,
}
pub fn tuning(memory_mib: u64) -> Tuning {
    Tuning {
        shared_buffers_mib: (memory_mib / 8).max(1),
        effective_cache_size_mib: memory_mib * 3 / 4,
        work_mem_mib: match memory_mib {
            ..=512 => 2,
            513..=2048 => 4,
            _ => 8,
        },
        maintenance_work_mem_mib: (memory_mib / 16).max(16),
        small: memory_mib <= SMALL_DATABASE_MEMORY_MIB,
    }
}

/// What `postgresql.conf` is made from.
#[derive(Clone, Debug)]
pub struct Settings<'a> {
    /// `/run/pgcf/<id>`; the unit passes the same on its command line.
    pub socket_directory: &'a Path,
    pub memory_mib: u64,
    /// The volume's nominal size: `max_wal_size` is a quarter of it.
    pub volume_bytes: u64,
    pub max_connections: u32,
    pub archive_timeout_seconds: u32,
    /// The client of `archive_command`; `None` archives nothing (the scratch database of the health
    /// check, which has no archive of its own).
    pub archive_command: Option<&'a str>,
}

/// A value that can sit between single quotes in `postgresql.conf` as it is.
fn plain(text: &str) -> bool {
    !text.is_empty()
        && text
            .bytes()
            .all(|b| b.is_ascii_graphic() && b != b'\'' && b != b'\\')
}

/// `postgresql.conf`. `None` for a setting that cannot be written as it is.
///
/// Every database runs autoprewarm: PostgreSQL's `pg_prewarm` library, loaded at start, writes the
/// list of the shared buffers (`autoprewarm.blocks` in the data directory) when the database
/// stops, and reads those blocks again after the next start. With `autoprewarm_interval = 0` the
/// list is written at shutdown only, so a running database pays nothing for it. The reading is
/// background work of one process after the database accepts connections; it competes with the
/// first queries for the disk, and what it gains is the first queries' pages in memory, which the
/// page cache lost while the database slept (plan 5.9). Nothing needs `CREATE EXTENSION`.
pub fn postgresql_conf(settings: &Settings) -> Option<String> {
    let socket = settings.socket_directory.to_str().filter(|s| plain(s))?;
    let archive = match settings.archive_command {
        Some(command) if plain(command) => {
            format!("archive_mode = on\narchive_command = '{command} %p'\n")
        }
        Some(_) => return None,
        None => "archive_mode = off\n".to_string(),
    };
    let tuning = tuning(settings.memory_mib);
    // A quarter of the volume, and never below the 64 MiB that keeps checkpoints from running
    // back to back on a tiny volume.
    let max_wal_mib = (settings.volume_bytes / 4 / MIB).max(64);
    let mut conf = format!(
        "# Written by pgcf-agent for every start of the database. Do not edit.\n\
         listen_addresses = ''\n\
         unix_socket_directories = '{socket}'\n\
         max_connections = {max_connections}\n\
         shared_buffers = {shared}MB\n\
         effective_cache_size = {cache}MB\n\
         work_mem = {work}MB\n\
         maintenance_work_mem = {maintenance}MB\n\
         huge_pages = off\n\
         jit = off\n\
         shared_preload_libraries = 'pg_prewarm'\n\
         pg_prewarm.autoprewarm = on\n\
         pg_prewarm.autoprewarm_interval = 0\n\
         wal_level = replica\n\
         {archive}\
         archive_timeout = {timeout}s\n\
         {sync_method}\
         wal_init_zero = off\n\
         wal_recycle = on\n\
         min_wal_size = 32MB\n\
         max_wal_size = {max_wal_mib}MB\n\
         password_encryption = scram-sha-256\n\
         log_line_prefix = '%m [%p] %q%u@%d '\n",
        max_connections = settings.max_connections,
        shared = tuning.shared_buffers_mib,
        cache = tuning.effective_cache_size_mib,
        work = tuning.work_mem_mib,
        maintenance = tuning.maintenance_work_mem_mib,
        timeout = settings.archive_timeout_seconds,
        // Crash recovery syncs the whole file system once instead of every file. `syncfs` exists
        // on Linux, which is where the agent runs; a laptop's tests start without it.
        sync_method = if cfg!(target_os = "linux") {
            "recovery_init_sync_method = syncfs\n"
        } else {
            ""
        },
    );
    if tuning.small {
        conf.push_str(SMALL_DATABASE_SETTINGS);
    }
    conf.push_str(&format!(
        "include_if_exists = '{}'\n",
        crate::archive::recovery::SETTINGS_FILE
    ));
    Some(conf)
}

/// `pg_hba.conf`: the agent and the backup role by peer through their maps, every other role over
/// the socket with SCRAM-SHA-256, and nothing over a network (there is no address to listen on).
/// `replication` is not matched by `all`, so replication connections are refused.
pub const PG_HBA: &str = "\
# Written by pgcf-agent. Do not edit.\n\
local all postgres peer map=pgcf_agent\n\
local all pgcf_backup peer map=pgcf_backup\n\
local all all scram-sha-256\n";

/// `pg_ident.conf`: the node's root is the agent role, and the database's own Linux user, who runs
/// the barman jobs, is the backup role. Both users are names the agent made itself.
pub fn pg_ident(agent_user: &str, database_user: &str) -> Option<String> {
    let name = |user: &str| {
        !user.is_empty()
            && user
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.'))
    };
    (name(agent_user) && name(database_user)).then(|| {
        format!(
            "# Written by pgcf-agent. Do not edit.\n\
             pgcf_agent {agent_user} {AGENT_ROLE}\n\
             pgcf_backup {database_user} {BACKUP_ROLE}\n"
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testpg::Cluster;
    use std::path::PathBuf;

    fn conf(memory_mib: u64, volume_gib: u64) -> String {
        postgresql_conf(&Settings {
            socket_directory: &PathBuf::from("/run/pgcf/abcdefghij0123456789"),
            memory_mib,
            volume_bytes: volume_gib << 30,
            max_connections: 25,
            archive_timeout_seconds: 60,
            archive_command: Some("/usr/libexec/pgcf/pgcf-archive"),
        })
        .unwrap()
    }

    #[test]
    fn the_sizes_of_the_plans_table_give_its_settings() {
        // Plan Appendix C: 256 MiB and 1 GiB.
        assert_eq!(
            tuning(256),
            Tuning {
                shared_buffers_mib: 32,
                effective_cache_size_mib: 192,
                work_mem_mib: 2,
                maintenance_work_mem_mib: 16,
                small: true
            }
        );
        assert_eq!(
            tuning(1024),
            Tuning {
                shared_buffers_mib: 128,
                effective_cache_size_mib: 768,
                work_mem_mib: 4,
                maintenance_work_mem_mib: 64,
                small: false
            }
        );
        assert_eq!(tuning(4096).work_mem_mib, 8);
        // The worst case of 256 MiB stays below the soft limit of 230 MiB: 32 + 25 * (2 + 4) +
        // 16 + 15, as the plan computes it.
        let t = tuning(256);
        assert!(
            t.shared_buffers_mib + 25 * (t.work_mem_mib + 4) + t.maintenance_work_mem_mib + 15
                < 230
        );
    }

    #[test]
    fn a_small_database_is_configured_as_the_plan_lists() {
        let text = conf(256, 1);
        for line in [
            "listen_addresses = ''",
            "unix_socket_directories = '/run/pgcf/abcdefghij0123456789'",
            "max_connections = 25",
            "shared_buffers = 32MB",
            "effective_cache_size = 192MB",
            "work_mem = 2MB",
            "maintenance_work_mem = 16MB",
            "huge_pages = off",
            "jit = off",
            "shared_preload_libraries = 'pg_prewarm'",
            "pg_prewarm.autoprewarm = on",
            "pg_prewarm.autoprewarm_interval = 0",
            "archive_mode = on",
            "archive_command = '/usr/libexec/pgcf/pgcf-archive %p'",
            "archive_timeout = 60s",
            "wal_init_zero = off",
            "wal_recycle = on",
            "min_wal_size = 32MB",
            "max_wal_size = 256MB",
            "autovacuum_max_workers = 1",
            "autovacuum_worker_slots = 2",
            "io_workers = 1",
            "max_parallel_workers_per_gather = 0",
            "max_parallel_maintenance_workers = 0",
            "max_worker_processes = 4",
            "max_logical_replication_workers = 0",
            "max_wal_senders = 0",
            "max_replication_slots = 0",
            "include_if_exists = 'pgcf-recovery.conf'",
        ] {
            assert!(text.lines().any(|l| l == line), "{line}\n{text}");
        }
        assert_eq!(
            text.lines()
                .any(|l| l == "recovery_init_sync_method = syncfs"),
            cfg!(target_os = "linux")
        );
        // A larger database keeps PostgreSQL's defaults for these.
        let large = conf(1024, 100);
        for absent in [
            "autovacuum_max_workers",
            "autovacuum_worker_slots",
            "io_workers",
            "max_parallel_workers_per_gather",
            "max_parallel_maintenance_workers",
            "max_worker_processes",
            "max_logical_replication_workers",
            "max_wal_senders",
            "max_replication_slots",
        ] {
            assert!(!large.contains(absent), "{absent}");
        }
        assert!(large.contains("max_wal_size = 25600MB"));
    }

    /// The whole file of a 256 MiB and of a 1 GiB class, as PostgreSQL 18 reads it. The small
    /// class trims what it never uses (no replication, no logical workers, four background
    /// workers, two autovacuum slots, no parallel maintenance); a larger class keeps the defaults.
    #[test]
    fn the_rendered_configuration_of_a_small_and_a_larger_class_is_pinned() {
        let sync = if cfg!(target_os = "linux") {
            "recovery_init_sync_method = syncfs\n"
        } else {
            ""
        };
        let head = |connections: u32, shared: u32, cache: u32, work: u32, maintenance: u32| {
            format!(
                "# Written by pgcf-agent for every start of the database. Do not edit.\n\
                 listen_addresses = ''\n\
                 unix_socket_directories = '/run/pgcf/abcdefghij0123456789'\n\
                 max_connections = {connections}\n\
                 shared_buffers = {shared}MB\n\
                 effective_cache_size = {cache}MB\n\
                 work_mem = {work}MB\n\
                 maintenance_work_mem = {maintenance}MB\n\
                 huge_pages = off\n\
                 jit = off\n\
                 shared_preload_libraries = 'pg_prewarm'\n\
                 pg_prewarm.autoprewarm = on\n\
                 pg_prewarm.autoprewarm_interval = 0\n\
                 wal_level = replica\n\
                 archive_mode = on\n\
                 archive_command = '/usr/libexec/pgcf/pgcf-archive %p'\n\
                 archive_timeout = 60s\n\
                 {sync}\
                 wal_init_zero = off\n\
                 wal_recycle = on\n\
                 min_wal_size = 32MB\n"
            )
        };
        let tail = "include_if_exists = 'pgcf-recovery.conf'\n";
        let small = format!(
            "{}max_wal_size = 256MB\n\
             password_encryption = scram-sha-256\n\
             log_line_prefix = '%m [%p] %q%u@%d '\n\
             autovacuum_max_workers = 1\n\
             autovacuum_worker_slots = 2\n\
             io_workers = 1\n\
             max_parallel_workers_per_gather = 0\n\
             max_parallel_maintenance_workers = 0\n\
             max_worker_processes = 4\n\
             max_logical_replication_workers = 0\n\
             max_wal_senders = 0\n\
             max_replication_slots = 0\n\
             {tail}",
            head(25, 32, 192, 2, 16)
        );
        assert_eq!(conf(256, 1), small);
        let larger = format!(
            "{}max_wal_size = 25600MB\n\
             password_encryption = scram-sha-256\n\
             log_line_prefix = '%m [%p] %q%u@%d '\n\
             {tail}",
            head(25, 128, 768, 4, 64)
        );
        assert_eq!(conf(1024, 100), larger);
        // The class boundary is the plan's: 512 MiB is small, one more is not.
        assert!(conf(512, 1).contains("max_wal_senders = 0"));
        assert!(!conf(513, 1).contains("max_wal_senders"));
    }

    /// Every class runs autoprewarm: the library loads at start, the list of shared buffers is
    /// written at shutdown only (a running database pays nothing), and the worker slots are not
    /// the connections' (`max_connections` is the setting's own in every class).
    #[test]
    fn every_class_runs_autoprewarm_with_room_for_its_workers_and_the_same_connections() {
        let value = |text: &str, name: &str| {
            text.lines()
                .find_map(|l| l.strip_prefix(&format!("{name} = ")))
                .map(String::from)
        };
        for (memory, volume) in [
            (128, 1),
            (256, 1),
            (512, 1),
            (513, 1),
            (1024, 100),
            (4096, 100),
        ] {
            let text = conf(memory, volume);
            let class = format!("{memory} MiB");
            assert_eq!(
                value(&text, "shared_preload_libraries").as_deref(),
                Some("'pg_prewarm'"),
                "{class}"
            );
            assert_eq!(
                value(&text, "pg_prewarm.autoprewarm").as_deref(),
                Some("on"),
                "{class}"
            );
            assert_eq!(
                value(&text, "pg_prewarm.autoprewarm_interval").as_deref(),
                Some("0"),
                "{class}"
            );
            // The leader and the worker for one database at a time, and two more: the default of
            // 8 where the class does not set it.
            let workers: u32 =
                value(&text, "max_worker_processes").map_or(8, |v| v.parse().unwrap());
            assert!(workers >= 4, "{class}: {workers}");
            assert_eq!(
                value(&text, "max_connections").as_deref(),
                Some("25"),
                "{class}"
            );
            // No parallel worker draws from the slots in the small class.
            if tuning(memory).small {
                assert_eq!(
                    value(&text, "max_parallel_workers_per_gather").as_deref(),
                    Some("0"),
                    "{class}"
                );
            }
        }
    }

    /// The process titles of what `postmaster` forked, as `ps` shows them.
    fn children(cluster: &Cluster) -> Vec<String> {
        let pid_file = std::fs::read_to_string(cluster.data().join("postmaster.pid")).unwrap();
        let pid = pid_file.lines().next().unwrap().to_string();
        let output = std::process::Command::new("ps")
            .args(["-axo", "ppid=,command="])
            .output()
            .unwrap();
        String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter_map(|line| {
                let (parent, title) = line.trim_start().split_once(' ')?;
                (parent == pid).then(|| title.trim().to_string())
            })
            .collect()
    }
    /// Waits for the autoprewarm leader to be a process of the postmaster: the postmaster starts
    /// its background workers right after it says `ready`, so a look at once may find none.
    async fn leader(cluster: &Cluster) {
        for _ in 0..200 {
            if children(cluster)
                .iter()
                .any(|title| title.ends_with("autoprewarm leader"))
            {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        panic!("no leader: {:?}\n{}", children(cluster), cluster.log());
    }
    /// Waits for `text` in the log of the cluster.
    async fn logged(cluster: &Cluster, text: &str) {
        for _ in 0..200 {
            if cluster.log().contains(text) {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        panic!("{text:?} was not logged:\n{}", cluster.log());
    }

    /// Checked against PostgreSQL 18 as the unit starts it: the library loads without `CREATE
    /// EXTENSION`; its leader is a process without a database, so no row of `pg_stat_activity`;
    /// nothing is dumped while the database runs; a clean stop writes `autoprewarm.blocks` with
    /// the blocks of the shared buffers; and the next start reads them.
    #[tokio::test]
    async fn autoprewarm_starts_with_the_database_dumps_at_its_stop_and_reads_the_dump_at_the_next_start()
     {
        use std::fs;
        let Some(cluster) = Cluster::create("prewarm") else {
            return;
        };
        cluster.start();
        leader(&cluster).await;
        let session = cluster.agent().await;
        let show = |name: &'static str| {
            let session = &session;
            async move {
                let rows = session.query(&format!("SHOW {name}"), &[]).await.unwrap();
                rows[0].get::<_, String>(0)
            }
        };
        assert_eq!(show("shared_preload_libraries").await, "pg_prewarm");
        assert_eq!(show("pg_prewarm.autoprewarm").await, "on");
        assert_eq!(show("pg_prewarm.autoprewarm_interval").await, "0");
        assert_eq!(show("max_worker_processes").await, "4");
        let rows = session
            .query(
                "SELECT count(*) FROM pg_stat_activity WHERE backend_type LIKE 'autoprewarm%'",
                &[],
            )
            .await
            .unwrap();
        assert_eq!(rows[0].get::<_, i64>(0), 0);

        // About 330 blocks, read once so that they sit in the shared buffers.
        session
            .batch("CREATE TABLE t AS SELECT g, repeat('x', 100) AS pad FROM generate_series(1, 20000) g")
            .await
            .unwrap();
        session.query("SELECT count(*) FROM t", &[]).await.unwrap();
        let rows = session
            .query(
                "SELECT pg_relation_filenode('t')::pg_catalog.int8, (SELECT oid::pg_catalog.int8 FROM pg_database WHERE datname = current_database())",
                &[],
            )
            .await
            .unwrap();
        let (filenode, database): (i64, i64) = (rows[0].get(0), rows[0].get(1));
        drop(session);
        let dump = cluster.data().join("autoprewarm.blocks");
        assert!(!dump.exists(), "nothing is dumped while the database runs");

        cluster.stop();
        let text = fs::read_to_string(&dump).unwrap();
        let listed = text
            .lines()
            .filter(|line| line.starts_with(&format!("{database},1663,{filenode},0,")))
            .count();
        assert!(listed >= 250, "{listed} blocks of the table in\n{text}");
        let total = text.lines().count() as u64 - 1;
        assert_eq!(text.lines().next().unwrap(), format!("<<{total}>>"));

        cluster.start();
        let (loaded, of) = cluster.prewarmed().await;
        assert_eq!((loaded, of), (total, total), "{}", cluster.log());
    }

    /// A restored directory brings the dump of its source, and a crash can leave anything. A dump
    /// that names a database, a relation, a tablespace, a fork or a block that is not there, and
    /// one that is no dump at all, do not stop a start or leave the database without its answer;
    /// the next clean stop writes a dump of its own.
    #[tokio::test]
    async fn a_dump_of_what_is_gone_or_a_damaged_one_does_not_stop_a_start() {
        use std::fs;
        let Some(cluster) = Cluster::create("prewarm-stale") else {
            return;
        };
        cluster.start();
        let session = cluster.agent().await;
        let rows = session
            .query(
                "SELECT (SELECT oid::pg_catalog.int8 FROM pg_database WHERE datname = 'postgres'), pg_relation_filenode('pg_class')::pg_catalog.int8",
                &[],
            )
            .await
            .unwrap();
        let (database, relation): (i64, i64) = (rows[0].get(0), rows[0].get(1));
        drop(session);
        cluster.stop();
        let dump = cluster.data().join("autoprewarm.blocks");
        // Of six blocks at most two exist; a database that does not exist ends its worker with
        // FATAL, which PostgreSQL logs and goes on from.
        let stale = format!(
            "<<6>>\n999999,1663,999999,0,0\n{database},1663,999999,0,0\n{database},1663,{relation},0,99999999\n{database},9999,{relation},0,0\n{database},1663,{relation},7,0\n{database},1663,{relation},0,0\n"
        );
        for (what, text) in [
            ("stale", stale.as_str()),
            ("no dump", "this is not a dump\n"),
            ("only a header", "<<5>>\n"),
            ("empty", ""),
        ] {
            fs::write(&dump, text).unwrap();
            cluster.start();
            let session = cluster.agent().await;
            let rows = session
                .query("SELECT 1::pg_catalog.int4", &[])
                .await
                .unwrap();
            assert_eq!(rows[0].get::<_, i32>(0), 1, "{what}");
            drop(session);
            if what == "stale" {
                let (loaded, of) = cluster.prewarmed().await;
                assert!(of == 6 && (1..6).contains(&loaded), "{loaded} of {of}");
            } else {
                // The leader that met the damaged file ends with an error; the postmaster starts
                // another, which does not read the file again and dumps at the stop.
                logged(&cluster, "exited with exit code 1").await;
            }
            leader(&cluster).await;
            cluster.stop();
            let written = fs::read_to_string(&dump).unwrap();
            let blocks = written.lines().count() as u64 - 1;
            assert!(blocks >= 1, "{what}: {written}");
            assert_eq!(
                written.lines().next().unwrap(),
                format!("<<{blocks}>>"),
                "{what}"
            );
            assert!(
                cluster.log().contains("database system is shut down"),
                "{what}:\n{}",
                cluster.log()
            );
        }
    }

    #[test]
    fn a_database_without_an_archive_archives_nothing() {
        let text = postgresql_conf(&Settings {
            socket_directory: Path::new("/run/pgcf/x"),
            memory_mib: 256,
            volume_bytes: 1 << 30,
            max_connections: 10,
            archive_timeout_seconds: 60,
            archive_command: None,
        })
        .unwrap();
        assert!(text.contains("archive_mode = off\n"));
        assert!(!text.contains("archive_command"));
    }

    #[test]
    fn nothing_that_could_leave_its_quotes_is_written() {
        for socket in [
            "/run/pgcf/a'b",
            "/run/pgcf/a b",
            "/run/pgcf/a\nb",
            "/run/a\\b",
            "",
        ] {
            assert!(
                postgresql_conf(&Settings {
                    socket_directory: Path::new(socket),
                    memory_mib: 256,
                    volume_bytes: 1 << 30,
                    max_connections: 10,
                    archive_timeout_seconds: 60,
                    archive_command: Some("/usr/libexec/pgcf/pgcf-archive"),
                })
                .is_none(),
                "{socket:?}"
            );
        }
        assert!(
            postgresql_conf(&Settings {
                socket_directory: Path::new("/run/pgcf/x"),
                memory_mib: 256,
                volume_bytes: 1 << 30,
                max_connections: 10,
                archive_timeout_seconds: 60,
                archive_command: Some("/x'; touch /y; '"),
            })
            .is_none()
        );
        assert!(pg_ident("root", "pgcf-abc").is_some());
        for user in ["", "ro ot", "a\nb", "a#b"] {
            assert!(pg_ident(user, "pgcf-abc").is_none(), "{user:?}");
            assert!(pg_ident("root", user).is_none(), "{user:?}");
        }
    }

    #[test]
    fn only_the_agent_and_the_backup_role_log_in_by_peer() {
        let hba: Vec<&str> = PG_HBA.lines().filter(|l| !l.starts_with('#')).collect();
        assert_eq!(
            hba,
            [
                "local all postgres peer map=pgcf_agent",
                "local all pgcf_backup peer map=pgcf_backup",
                "local all all scram-sha-256"
            ]
        );
        let ident = pg_ident("root", "pgcf-abcdefghij0123456789").unwrap();
        assert!(ident.lines().any(|l| l == "pgcf_agent root postgres"));
        assert!(
            ident
                .lines()
                .any(|l| l == "pgcf_backup pgcf-abcdefghij0123456789 pgcf_backup")
        );
    }
}
