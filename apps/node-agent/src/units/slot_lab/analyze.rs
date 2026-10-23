// SPDX-License-Identifier: Apache-2.0
//! What `ANALYZE`, `VACUUM` and autovacuum hold in memory, in every class of the catalog, on the
//! real unit (plan 4.4): a database in a pooled slot with the limits its class sets (`MemoryMax`,
//! `MemoryHigh` at 90 % and no swap, from `limits::Limits`), the class's own `postgresql.conf`
//! (`settings::postgresql_conf`) and three tables of 100,000 rows: rows of 8 KB that are never
//! toasted (`STORAGE PLAIN`), rows of 2 KB, and the widest row an `ANALYZE` keeps (a PLAIN column of
//! 7 KB beside a compressed one). Each step runs in a window in which the unit's cgroup is read
//! every 10 ms; what a step must show is that it ends, that the kernel killed nothing and never
//! reached the ceiling, that the memory the unit cannot give back (anonymous, shared and kernel)
//! stayed below the soft limit, that the sample is no larger than `settings::analyze_sample_bytes`
//! says, and that the unit was stalled for memory no longer than `STALL_MS_PER_SECOND` of the step.
//! Three more tables of 6,000 documents of 22 KB show what the model does not cover: the values of
//! an index expression, which `ANALYZE` keeps for every sampled row (`settings::ANALYZE_ROW_BYTES`).
//! A full-text index on `to_tsvector(body)` holds 26 KB for each row, the same index with the
//! statistics of its column off holds nothing, and a stored generated column that the index is on
//! holds nothing: the lab measures all three in every class and asserts what the plan promises.
//! Run as the pool's lab (the header of `slot_lab`), with the filter `units::slot_lab::analyze`.
use super::*;
use crate::units::slots::slot_cgroup;
use std::{
    collections::HashMap,
    sync::atomic::{AtomicBool, Ordering as AtomicOrdering},
};

const MIB: u64 = 1 << 20;
/// The production catalog's classes (plan 11.1, G10): name, memory in MiB and `max_connections`.
const CLASSES: [(&str, u64, u32); 4] = [
    ("xs", 256, 20),
    ("sm", 1024, 100),
    ("md", 2048, 200),
    ("lg", 4096, 300),
];
/// The volume: three tables of 100,000 rows (1.8 GB), four of 35,000 (1.1 GB), three of 6,000
/// documents (0.7 GB), and the WAL a quarter of the volume allows.
const VOLUME: u64 = 8 << 30;
/// The documents of the tables `dx`, `d0` and `dc`: 300 × the target of `xs` (20) is the sample of
/// the smallest class, and every other class samples all of them.
const DOCUMENTS: u64 = 6_000;
/// The stall the unit may have for memory (`memory.pressure`, `full`) in a step, in milliseconds
/// per second of the step, and a floor for the shortest steps. Reading a table larger than the unit
/// fills its page cache to the soft limit, which the kernel gives back at once; that is not a stall
/// of the database.
const STALL_MS_PER_SECOND: f64 = 100.0;
const STALL_FLOOR_MS: u64 = 100;
/// What a backend grows beside the sample (caches, the executor, the dead-item store of a vacuum
/// of a few thousand rows), in bytes, for each backend, a new autovacuum worker included.
const BACKEND_MARGIN: u64 = 8 * MIB;

struct Cgroup(PathBuf);
impl Cgroup {
    fn of(slot: u32) -> Cgroup {
        Cgroup(Path::new("/sys/fs/cgroup").join(slot_cgroup(slot).trim_start_matches('/')))
    }
    fn text(&self, file: &str) -> String {
        fs::read_to_string(self.0.join(file)).unwrap_or_default()
    }
    fn keyed(&self, file: &str) -> HashMap<String, u64> {
        self.text(file)
            .lines()
            .filter_map(|line| {
                let mut parts = line.split_whitespace();
                Some((parts.next()?.to_string(), parts.next()?.parse().ok()?))
            })
            .collect()
    }
    /// The microseconds the whole unit was stalled for memory (`full` of `memory.pressure`).
    fn stalled_us(&self) -> u64 {
        self.text("memory.pressure")
            .lines()
            .find_map(|line| line.strip_prefix("full "))
            .and_then(|rest| {
                rest.split_whitespace()
                    .find_map(|f| f.strip_prefix("total="))
            })
            .and_then(|total| total.parse().ok())
            .unwrap_or(0)
    }
    fn limit(&self, file: &str) -> u64 {
        self.text(file).trim().parse().unwrap()
    }
}

#[derive(Clone, Copy, Debug, Default)]
struct Measured {
    seconds: f64,
    /// The peaks of anonymous memory, of what the unit cannot give back (anonymous, shared and
    /// kernel memory) and of everything it is charged (which the page cache fills to the soft
    /// limit).
    anon: u64,
    unreclaimable: u64,
    current: u64,
    /// Events of the window: the soft limit crossed (page cache included), the ceiling reached, a
    /// process killed; and the stall for memory in milliseconds.
    high: u64,
    max: u64,
    oom_kill: u64,
    stalled_ms: u64,
}

/// Runs `work` while the unit's memory is read every 10 ms.
async fn measured<T>(cgroup: &Cgroup, work: impl Future<Output = T>) -> (T, Measured) {
    let events = cgroup.keyed("memory.events");
    let stalled = cgroup.stalled_us();
    let began = Instant::now();
    let done = Arc::new(AtomicBool::new(false));
    let poller = {
        let done = done.clone();
        let path = cgroup.0.clone();
        std::thread::spawn(move || {
            let cgroup = Cgroup(path);
            let mut peaks = Measured::default();
            loop {
                let stat = cgroup.keyed("memory.stat");
                let get = |key: &str| stat.get(key).copied().unwrap_or(0);
                peaks.anon = peaks.anon.max(get("anon"));
                peaks.unreclaimable = peaks
                    .unreclaimable
                    .max(get("anon") + get("shmem") + get("kernel"));
                peaks.current = peaks
                    .current
                    .max(cgroup.text("memory.current").trim().parse().unwrap_or(0));
                if done.load(AtomicOrdering::Relaxed) {
                    return peaks;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
        })
    };
    let out = work.await;
    let seconds = began.elapsed().as_secs_f64();
    done.store(true, AtomicOrdering::Relaxed);
    let mut peaks = poller.join().unwrap();
    let after = cgroup.keyed("memory.events");
    let delta =
        |key: &str| after.get(key).copied().unwrap_or(0) - events.get(key).copied().unwrap_or(0);
    peaks.seconds = seconds;
    peaks.high = delta("high");
    peaks.max = delta("max");
    peaks.oom_kill = delta("oom_kill");
    peaks.stalled_ms = (cgroup.stalled_us() - stalled) / 1000;
    (out, peaks)
}

/// The samples ANALYZE held at once in a step, their statistics target, and the connections beside
/// them.
#[derive(Clone, Copy)]
struct Sampled {
    samples: u64,
    target: u32,
    connections: u64,
}

/// What a step measured, in a line.
fn show(class: &str, step: &str, cgroup: &Cgroup, idle: &Measured, m: &Measured) {
    let high = cgroup.limit("memory.high");
    let max = cgroup.limit("memory.max");
    println!(
        "analyze_lab {class} {step}: {:.2} s, anon {:.1} MiB (+{:.1}), unreclaimable {:.1} MiB, charged {:.1} MiB of high {:.0} / max {:.0}, high events {}, stalled {} ms",
        m.seconds,
        m.anon as f64 / MIB as f64,
        m.anon.saturating_sub(idle.anon) as f64 / MIB as f64,
        m.unreclaimable as f64 / MIB as f64,
        m.current as f64 / MIB as f64,
        high as f64 / MIB as f64,
        max as f64 / MIB as f64,
        m.high,
        m.stalled_ms,
    );
}

/// What a step must show.
fn check(
    class: &str,
    step: &str,
    cgroup: &Cgroup,
    idle: &Measured,
    m: &Measured,
    sampled: Option<Sampled>,
) {
    show(class, step, cgroup, idle, m);
    let high = cgroup.limit("memory.high");
    assert_eq!(
        (m.oom_kill, m.max),
        (0, 0),
        "{class} {step}: the kernel killed or hit the ceiling"
    );
    assert!(
        m.unreclaimable < high,
        "{class} {step}: {} bytes that cannot be given back, soft limit {high}",
        m.unreclaimable
    );
    let allowed = ((m.seconds * STALL_MS_PER_SECOND) as u64).max(STALL_FLOOR_MS);
    assert!(
        m.stalled_ms <= allowed,
        "{class} {step}: stalled for memory {} ms in {:.2} s",
        m.stalled_ms,
        m.seconds
    );
    if let Some(Sampled {
        samples,
        target,
        connections,
    }) = sampled
    {
        let model = samples * settings::analyze_sample_bytes(target)
            + (samples + connections) * BACKEND_MARGIN;
        let grew = m.anon.saturating_sub(idle.anon);
        assert!(
            grew <= model,
            "{class} {step}: the unit grew by {grew} bytes, the model says {model}"
        );
    }
}

impl Database {
    /// The configuration of a class, as the agent writes it before a start, with what the lab adds
    /// through the file a recovery adds settings in.
    fn write_class(&self, memory_mib: u64, max_connections: u32) {
        self.write_conf(memory_mib, max_connections);
        let extra = self.data().join(crate::archive::recovery::SETTINGS_FILE);
        fs::write(
            &extra,
            "autovacuum_naptime = 5s\nlog_min_messages = warning\n",
        )
        .unwrap();
        chown(&extra, Some(DB_ID), Some(DB_ID)).unwrap();
    }

    /// The limits of a class on the slot, without write limits: the lab loads and updates tables.
    fn class_bind(&self, memory_mib: u64) -> Bind {
        let mut bind = self.bind(memory_mib);
        bind.properties = limits::Limits {
            memory_mib,
            cpu_millicores: 500,
            tasks_max: 64,
            io: None,
        }
        .properties();
        bind
    }
}

/// Waits until the unit holds little more anonymous memory than when it was idle: the backend of
/// the step before has ended and given its memory back.
async fn settle(cgroup: &Cgroup, idle: &Measured) {
    for _ in 0..100 {
        let anon = cgroup
            .keyed("memory.stat")
            .get("anon")
            .copied()
            .unwrap_or(0);
        if anon <= idle.anon + 16 * MIB {
            return;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

async fn serve(lab: &Lab, database: &Database, memory_mib: u64, max_connections: u32) -> Cgroup {
    database.write_class(memory_mib, max_connections);
    let pool = &lab.pool;
    pool.refill(1).await.unwrap();
    let bound = pool
        .bind(&database.id, &database.class_bind(memory_mib))
        .await
        .unwrap();
    pool.exec(&bound).await.unwrap();
    Cgroup::of(bound.slot)
}

/// The tables. `wide` rows are 8 KB and never toasted, `narrow` rows 2 KB, `worst` rows hold a
/// PLAIN column of 7 KB beside a compressed one, and `s1` to `s4` are 35,000 of those rows each,
/// for the steps that run several ANALYZE at once. `dx`, `d0` and `dc` are `DOCUMENTS` documents of
/// 22 KB (680 words of a skewed vocabulary): `dx` has a full-text index on the expression
/// `to_tsvector('simple', body)`, `d0` the same with the statistics of the index column off, and
/// `dc` a stored generated tsvector column with the index on the column. Autovacuum is off on all of
/// them until a step turns it on.
const LOAD: [&str; 11] = [
    "CREATE TABLE wide (id int PRIMARY KEY, grp int, created timestamptz, payload text) WITH (autovacuum_enabled = false);
     ALTER TABLE wide ALTER COLUMN payload SET STORAGE PLAIN;
     INSERT INTO wide SELECT g, (random()*1000)::int, now() - (g || ' seconds')::interval, repeat(md5(g::text), 253) FROM generate_series(1, 100000) g",
    "CREATE TABLE narrow (id int PRIMARY KEY, grp int, created timestamptz, payload text) WITH (autovacuum_enabled = false);
     INSERT INTO narrow SELECT g, (random()*1000)::int, now() - (g || ' seconds')::interval, repeat(md5(g::text), 62) FROM generate_series(1, 100000) g",
    "CREATE TABLE worst (id int PRIMARY KEY, grp int, created timestamptz, blob text, note text) WITH (autovacuum_enabled = false);
     ALTER TABLE worst ALTER COLUMN blob SET STORAGE PLAIN;
     INSERT INTO worst SELECT g, (random()*1000)::int, now() - (g || ' seconds')::interval, repeat(md5(g::text), 218), repeat('abcdefghij', 100) FROM generate_series(1, 100000) g",
    "CREATE TABLE s1 (LIKE worst INCLUDING ALL) WITH (autovacuum_enabled = false);
     ALTER TABLE s1 ALTER COLUMN blob SET STORAGE PLAIN;
     INSERT INTO s1 SELECT * FROM worst WHERE id <= 35000",
    "CREATE TABLE s2 (LIKE worst INCLUDING ALL) WITH (autovacuum_enabled = false);
     ALTER TABLE s2 ALTER COLUMN blob SET STORAGE PLAIN;
     INSERT INTO s2 SELECT * FROM worst WHERE id <= 35000",
    "CREATE TABLE s3 (LIKE worst INCLUDING ALL) WITH (autovacuum_enabled = false);
     ALTER TABLE s3 ALTER COLUMN blob SET STORAGE PLAIN;
     INSERT INTO s3 SELECT * FROM worst WHERE id <= 35000",
    "CREATE TABLE s4 (LIKE worst INCLUDING ALL) WITH (autovacuum_enabled = false);
     ALTER TABLE s4 ALTER COLUMN blob SET STORAGE PLAIN;
     INSERT INTO s4 SELECT * FROM worst WHERE id <= 35000",
    "CREATE TABLE dx (id int PRIMARY KEY, body text) WITH (autovacuum_enabled = false);
     INSERT INTO dx SELECT g, (SELECT string_agg(md5(((power(random(), 2.5) * 60000)::int)::text), ' ') FROM generate_series(1, 680) i) FROM generate_series(1, 6000) g;
     CREATE INDEX dx_tsv ON dx USING gin (to_tsvector('simple', body))",
    "CREATE TABLE d0 (id int PRIMARY KEY, body text) WITH (autovacuum_enabled = false);
     INSERT INTO d0 SELECT * FROM dx;
     CREATE INDEX d0_tsv ON d0 USING gin (to_tsvector('simple', body));
     ALTER INDEX d0_tsv ALTER COLUMN 1 SET STATISTICS 0",
    "CREATE TABLE dc (id int PRIMARY KEY, body text, tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', body)) STORED) WITH (autovacuum_enabled = false);
     INSERT INTO dc (id, body) SELECT id, body FROM dx;
     CREATE INDEX dc_tsv ON dc USING gin (tsv)",
    "CREATE TABLE small (id int PRIMARY KEY, v int);
     INSERT INTO small SELECT g, g FROM generate_series(1, 1000) g",
];

/// A manual ANALYZE of a table of each kind, a VACUUM of dead tuples, the autovacuum worker's
/// VACUUM and ANALYZE of one table, the ANALYZE of a table with a full-text index on an expression
/// and of the two tables that end its cost, and as many ANALYZE at once as the class has autovacuum
/// workers plus the session's own, beside connections that ask small questions, each in every class.
#[tokio::test]
#[ignore = "needs systemd as PID 1, root, PostgreSQL 18 and the node image's units (lab)"]
async fn analyze_and_vacuum_stay_inside_the_memory_of_every_class() {
    let (lab, database) = Lab::sized("m", VOLUME, 2048).await;
    // The tables, in a unit that has room for the load.
    {
        let cgroup = serve(&lab, &database, 2048, 50).await;
        let session = database.agent().await;
        for statement in LOAD {
            session.batch_long(statement).await.unwrap();
        }
        assert_eq!(
            session.query("SELECT count(*) FROM dx", &[]).await.unwrap()[0].get::<_, i64>(0),
            DOCUMENTS as i64
        );
        for table in [
            "wide", "narrow", "worst", "s1", "s2", "s3", "s4", "dx", "d0", "dc",
        ] {
            session
                .batch_long(&format!("VACUUM (FREEZE) {table}"))
                .await
                .unwrap();
        }
        session.batch_long("CHECKPOINT").await.unwrap();
        drop(session);
        drop(cgroup);
        assert!(lab.pool.stop(&database.id).await.unwrap());
    }

    for (class, memory_mib, max_connections) in CLASSES {
        let tuning = settings::tuning(memory_mib);
        let (target, workers) = (
            tuning.default_statistics_target,
            u64::from(tuning.autovacuum_max_workers),
        );
        // The page cache starts empty, as after a wake.
        sh("sync", &[]);
        fs::write("/proc/sys/vm/drop_caches", "3").unwrap();
        let cgroup = serve(&lab, &database, memory_mib, max_connections).await;
        {
            let session = database.agent().await;
            assert_eq!(
                session
                    .query("SHOW default_statistics_target", &[])
                    .await
                    .unwrap()[0]
                    .get::<_, String>(0),
                target.to_string(),
                "{class}"
            );
        }
        println!(
            "analyze_lab {class}: {memory_mib} MiB, statistics target {target}, {workers} autovacuum workers, memory.high {} memory.max {}",
            cgroup.limit("memory.high"),
            cgroup.limit("memory.max")
        );

        let ((), idle) = measured(&cgroup, async {
            tokio::time::sleep(Duration::from_secs(3)).await
        })
        .await;
        check(class, "idle", &cgroup, &idle, &idle, None);

        // Each step has a session of its own, which ends with it: a backend keeps the memory it
        // freed (the allocator does not give it back), so a session that went on would carry the
        // sample of the step before into the next.
        for table in ["wide", "narrow", "worst"] {
            settle(&cgroup, &idle).await;
            let session = database.agent().await;
            let (result, m) =
                measured(&cgroup, session.batch_long(&format!("ANALYZE {table}"))).await;
            result.unwrap();
            check(
                class,
                &format!("manual ANALYZE {table}"),
                &cgroup,
                &idle,
                &m,
                Some(Sampled {
                    samples: 1,
                    target,
                    connections: 0,
                }),
            );
            if table == "wide" {
                // The sample is there: it is what the step measured.
                let rows = 300 * u64::from(target);
                assert!(
                    m.anon.saturating_sub(idle.anon) >= rows * 8_200 * 9 / 10,
                    "{class}: no sample of 8 KB rows was measured"
                );
                // What the session still holds a second after its ANALYZE ended, which it gives back
                // only when it disconnects.
                let ((), kept) = measured(&cgroup, async {
                    tokio::time::sleep(Duration::from_secs(1)).await
                })
                .await;
                println!(
                    "analyze_lab {class} kept by the session a second after its ANALYZE: {:.1} MiB",
                    kept.anon.saturating_sub(idle.anon) as f64 / MIB as f64
                );
            }
        }

        settle(&cgroup, &idle).await;
        {
            let session = database.agent().await;
            session
                .batch_long("UPDATE worst SET grp = grp + 1 WHERE id <= 20000")
                .await
                .unwrap();
        }
        settle(&cgroup, &idle).await;
        let session = database.agent().await;
        let (result, m) = measured(&cgroup, session.batch_long("VACUUM worst")).await;
        result.unwrap();
        drop(session);
        check(
            class,
            "manual VACUUM worst, 20,000 dead rows",
            &cgroup,
            &idle,
            &m,
            None,
        );

        // The autovacuum worker: VACUUM then ANALYZE of one table that has outgrown its thresholds.
        settle(&cgroup, &idle).await;
        {
            let session = database.agent().await;
            session
                .query(
                    "SELECT pg_stat_reset_single_table_counters('s1'::regclass)",
                    &[],
                )
                .await
                .unwrap();
            session
                .batch_long("UPDATE s1 SET grp = grp + 1 WHERE id <= 8000")
                .await
                .unwrap();
        }
        settle(&cgroup, &idle).await;
        let session = database.agent().await;
        let (done, m) = measured(&cgroup, async {
            session.batch_long("ALTER TABLE s1 SET (autovacuum_enabled = true)").await.unwrap();
            let began = Instant::now();
            loop {
                let rows = session
                    .query("SELECT (last_autovacuum IS NOT NULL AND last_autoanalyze IS NOT NULL) FROM pg_stat_user_tables WHERE relname = 's1'", &[])
                    .await
                    .unwrap();
                if rows.first().is_some_and(|row| row.get::<_, bool>(0)) {
                    return true;
                }
                if began.elapsed() > Duration::from_secs(300) {
                    return false;
                }
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
        })
        .await;
        assert!(done, "{class}: the autovacuum worker did not finish");
        session
            .batch_long("ALTER TABLE s1 SET (autovacuum_enabled = false)")
            .await
            .unwrap();
        drop(session);
        check(
            class,
            "autovacuum VACUUM + ANALYZE of s1",
            &cgroup,
            &idle,
            &m,
            // The worker holds the sample; the lab's session asks whether it is done.
            Some(Sampled {
                samples: 1,
                target,
                connections: 1,
            }),
        );

        // The values of an index expression, which the model does not cover: `dx` keeps one for
        // every sampled row, and the two remedies keep none.
        let value: u64 = {
            let session = database.agent().await;
            session
                .query(
                    "SELECT avg(pg_column_size(to_tsvector('simple', body)))::bigint FROM dx",
                    &[],
                )
                .await
                .unwrap()[0]
                .get::<_, i64>(0)
                .try_into()
                .unwrap()
        };
        let documents = DOCUMENTS.min(300 * u64::from(target));
        for table in ["dx", "d0", "dc"] {
            settle(&cgroup, &idle).await;
            let session = database.agent().await;
            let (result, m) =
                measured(&cgroup, session.batch_long(&format!("ANALYZE {table}"))).await;
            result.unwrap();
            drop(session);
            let step = format!("ANALYZE {table}, {documents} documents");
            if table == "dx" {
                show(class, &step, &cgroup, &idle, &m);
                let grew = m.anon.saturating_sub(idle.anon);
                // Every sampled row's value is there, and the sample of the model is not the bound.
                assert!(
                    grew >= documents * value * 9 / 10,
                    "{class} {step}: the unit grew by {grew} bytes, a value is {value} bytes"
                );
                assert!(
                    grew > documents * settings::analyze_sample_bytes(1) / 300,
                    "{class} {step}: the model bounds an index expression"
                );
                assert_eq!(
                    (m.oom_kill, m.max),
                    (0, 0),
                    "{class} {step}: the kernel killed or hit the ceiling"
                );
            } else {
                check(
                    class,
                    &step,
                    &cgroup,
                    &idle,
                    &m,
                    Some(Sampled {
                        samples: 1,
                        target,
                        connections: 0,
                    }),
                );
            }
        }

        // The most that can run together: every autovacuum worker and one session analyze at the
        // widest rows, with connections that ask small questions beside them.
        let samples = workers + 1;
        let asking_connections = u64::from((max_connections / 2).min(10));
        let stop = Arc::new(AtomicBool::new(false));
        let mut asking = tokio::task::JoinSet::new();
        for _ in 0..asking_connections {
            let session = database.agent().await;
            let stop = stop.clone();
            asking.spawn(async move {
                while !stop.load(AtomicOrdering::Relaxed) {
                    session
                        .query("SELECT count(*) FROM small a JOIN small b USING (id)", &[])
                        .await
                        .unwrap();
                    tokio::time::sleep(Duration::from_millis(200)).await;
                }
            });
        }
        let ((), m) = measured(&cgroup, async {
            let mut analyzing = tokio::task::JoinSet::new();
            for table in 1..=samples {
                let session = database.agent().await;
                analyzing.spawn(async move {
                    session
                        .batch_long(&format!("ANALYZE s{table}"))
                        .await
                        .unwrap();
                });
            }
            while let Some(result) = analyzing.join_next().await {
                result.unwrap();
            }
        })
        .await;
        stop.store(true, AtomicOrdering::Relaxed);
        while let Some(result) = asking.join_next().await {
            result.unwrap();
        }
        check(
            class,
            &format!("{samples} ANALYZE at once beside {asking_connections} connections"),
            &cgroup,
            &idle,
            &m,
            Some(Sampled {
                samples,
                target,
                connections: asking_connections,
            }),
        );

        assert!(lab.pool.stop(&database.id).await.unwrap());
    }
}
