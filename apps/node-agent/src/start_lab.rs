// SPDX-License-Identifier: Apache-2.0
//! The agent's start on a node with hundreds of databases, on the real thing: systemd as PID 1 and
//! its bus, LVM thin volumes, ext4, the image's units and PostgreSQL 18, with only Cloudflare
//! stood in for (the link's double). They run as root in the lab container (Debian 13, systemd as
//! PID 1, the image's `pgcf-pg@.service` and `pgcf.slice`, a group `pgcf-gateway`, lvm2, e2fsprogs,
//! PostgreSQL 18) with `--ignored`, under `unshare --mount --propagation slave` as the agent runs
//! under `PrivateMounts=yes`: the volumes it mounts are in its namespace, which ends with it, and
//! the next one finds none mounted.
//!
//! - `prepare` makes the node once: `PGCF_LAB_VOLUMES` databases (300), each with its user, thin
//!   volume, state file and the files its proven sleep is read from; the first `PGCF_LAB_AWAKE`
//!   (8) and the next `PGCF_LAB_ASLEEP` (12) have a real PostgreSQL, and the first are woken and
//!   run on. The others have the `pg_control` of one of them, which is all an agent reads of a
//!   sleeping database before it is woken.
//! - `start` is the agent's start on that node, as `main` makes it, against a double of the link,
//!   with the agent's real timing. A gateway connects as soon as the agent serves it and asks for
//!   the wake of a sleeping database that has a PostgreSQL. The test prints the phases, the wake
//!   and the time until every database is decided.
//!
//! The disk is the lab's to make slow: a mount on the plan's EU1 took 96 to 122 ms and a loop
//! device in memory takes 3. The physical volume is a `dm-delay` device straight over the loop
//! device (`dmsetup create slowpv --table "0 <sectors> delay <loop> 0 <read ms> <loop> 0 <write
//! ms> <loop> 0 <flush ms>"`, changed with `reload` and `resume`), not a file on a slow
//! filesystem, which a loop device would answer one request at a time. Read 2 ms, write 2 ms and
//! flush 10 ms make one cold mount 89 ms and one unmount 39 ms. A container has no udev, so
//! `/etc/lvm/lvmlocal.conf` sets `udev_sync = 0`, `udev_rules = 0` and
//! `obtain_device_list_from_udev = 0` and a `filter` that rejects the loop device below the
//! physical volume; `/var/lib/pgcf` and `/run/pgcf` are mode 0755, `/usr/libexec/pgcf/pgcf-archive`
//! exits 0, and `pgcf-gateway.service` and `pgcf-cloudflared.service` are `sleep infinity`.
//!
//! `PGCF_LAB_DEVICE` is the block device of the volume group (`/dev/mapper/slowpv`),
//! `PGCF_LAB_GROUP` its name, `PGCF_LAB_CREDENTIAL_MS` the time the double takes to answer a
//! credential, and `PGCF_LAB_PROBE` which of the sleeping databases with a PostgreSQL `start`
//! wakes. A run is `unshare --mount --propagation slave <test binary> --ignored --exact
//! --nocapture --test-threads=1 start_lab::prepare` (once) and then `start_lab::start`; `reset`
//! puts the sleeping databases back after a run that ended early.
use crate::{
    agent::{
        Entry, Timing,
        testing::{FakeGateway, eventually, policy},
    },
    layout::Layout,
    link::{
        LinkConfig, Paths, Timing as LinkTiming, Transport,
        test_server::{Cloud, database, tempdir},
    },
    machine::{Machine, Node, os_report, restore_runtime},
    pg_control::{Lsn, parse_control_file},
    service::{Intervals, Service, ServiceConfig},
    state::{DatabaseState, Files, ProvenSleepRecord, Resources},
    storage::{self, VolumeId},
    timing,
    units::slots,
};
use pgcf_native_protocol::{
    agent::ToGateway,
    wake::{Outcome, WakeRequest},
};
use serde_json::{Value, json};
use std::{
    os::unix::fs::chown,
    path::Path,
    process::Command,
    sync::Arc,
    time::{Duration, Instant},
};

fn number(name: &str, default: usize) -> usize {
    std::env::var(name)
        .ok()
        .and_then(|text| text.parse().ok())
        .unwrap_or(default)
}

struct Lab {
    layout: Layout,
    config: storage::Config,
    volumes: usize,
    awake: usize,
    asleep: usize,
}
impl Lab {
    /// The lab, or `None` where this is no lab: systemd is not PID 1, or not root, or no device.
    fn from_env() -> Option<Self> {
        if !Path::new("/run/systemd/system").is_dir() || unsafe { libc::geteuid() } != 0 {
            eprintln!("skipped: needs systemd as PID 1 and root");
            return None;
        }
        let Ok(device) = std::env::var("PGCF_LAB_DEVICE") else {
            eprintln!("skipped: PGCF_LAB_DEVICE names no device");
            return None;
        };
        Some(Self {
            layout: Layout::default(),
            config: storage::Config {
                device: device.into(),
                group: std::env::var("PGCF_LAB_GROUP").unwrap_or_else(|_| "pgcflab".into()),
                pv_metadata_bytes: 8 << 20,
                pool_metadata_bytes: 64 << 20,
                ..storage::Config::default()
            },
            volumes: number("PGCF_LAB_VOLUMES", 300),
            awake: number("PGCF_LAB_AWAKE", 8),
            asleep: number("PGCF_LAB_ASLEEP", 12),
        })
    }
    fn real(&self) -> usize {
        self.awake + self.asleep
    }
}

fn database_id(n: usize) -> String {
    format!("lab{n:017}")
}

/// The page entry of database `n`: the contract's example under its own identifier and its own
/// archive credential, built long ago (no origin).
fn entry_json(n: usize) -> Value {
    let mut db = database(&database_id(n));
    db["archive"]["credential"]["id"] = json!(format!("crd_{n:020}"));
    db
}

/// What `udev` makes on a node and a container lacks: the `/dev/dm-<minor>` node that systemd's
/// image dissection reads a volume's device number through.
fn dm_node(device: &str) {
    let name = device.trim_start_matches("/dev/mapper/");
    let info = Command::new("dmsetup")
        .args(["info", "-c", "--noheadings", "-o", "major,minor", name])
        .output()
        .unwrap();
    let info = String::from_utf8(info.stdout).unwrap();
    let (major, minor) = info.trim().split_once(':').unwrap();
    let node = format!("/dev/dm-{minor}");
    if !Path::new(&node).exists() {
        assert!(
            Command::new("mknod")
                .args([&node, "b", major, minor])
                .status()
                .unwrap()
                .success()
        );
    }
}

/// The proven-sleep record that a database's `pg_control` matches.
fn record_of(control: &[u8]) -> ProvenSleepRecord {
    let file = parse_control_file(control).expect("a pg_control");
    ProvenSleepRecord {
        system_identifier: file.control.system_identifier,
        timeline: file.control.timeline,
        checkpoint_lsn: Lsn(file.checkpoint).to_string(),
        last_archived_segment: "000000010000000000000001".into(),
        proven_at: crate::archive::facts::timestamp(crate::agent::now_ms()),
    }
}

fn save_state(lab: &Lab, n: usize, control: &[u8]) {
    let entry = Entry::parse(&entry_json(n)).unwrap();
    let mut state = DatabaseState::new(1);
    state.built = true;
    state.roles = entry.role_revisions();
    state.record = Some(record_of(control));
    state.resources = Some(Resources {
        memory_mib: entry.memory_mib,
        cpu_millicores: entry.cpu_millicores,
        storage_gib: entry.storage_gib,
    });
    Files::new(lab.layout.database_files(&database_id(n)))
        .save(&state)
        .unwrap();
}

fn control_of(lab: &Lab, n: usize) -> Vec<u8> {
    std::fs::read(lab.layout.data(&database_id(n)).join("global/pg_control")).unwrap()
}

/// The agent on the node, linked to a double of Cloudflare that pages the lab's databases, and
/// the gateway that connects to it.
struct Agent {
    service: Arc<Service<Node>>,
    gateway: FakeGateway,
    _cloud: Cloud,
    _base: crate::link::test_server::TempDir,
    began: Instant,
}

/// Starts the agent as `main` does, up to the link, and then the service; the gateway connects as
/// soon as the socket is there. Returns when the service has started.
async fn start_agent(lab: &Lab, node: &Arc<Node>, began: Instant) -> Agent {
    let credential_delay = Duration::from_millis(number("PGCF_LAB_CREDENTIAL_MS", 0) as u64);
    let cloud = Cloud::start().await;
    cloud.with(|inner| {
        inner.databases = (0..lab.volumes).map(entry_json).collect();
        for n in 0..lab.volumes {
            let db = entry_json(n);
            inner.credential_paths.insert(
                format!("crd_{n:020}"),
                db["archive"]["path"].as_str().unwrap().to_string(),
            );
        }
        inner.credential_delay = credential_delay;
        // The release is not this test's: the page names none.
        inner.release = Some(Value::Null);
    });
    let base = tempdir();
    cloud.seed(&base);
    let (link, events) = crate::link::Link::start(
        LinkConfig {
            paths: Paths::new(&base),
            image_version: "25".into(),
            agent_version: "0.1.0".into(),
            release_id: None,
            os: os_report(&**node).await.unwrap(),
            timing: LinkTiming::default(),
        },
        Transport::new(cloud.roots()).unwrap(),
    )
    .await
    .unwrap();
    timing::phase("link_started");
    std::fs::create_dir_all(lab.layout.agent_run()).unwrap();
    let starting = tokio::spawn(Service::start(
        node.clone(),
        link,
        events,
        ServiceConfig {
            intervals: Intervals::default(),
            timing: Timing::default(),
            gateway: None,
            release_key: [0; 32],
        },
    ));
    let gateway = FakeGateway::connect(&lab.layout.gateway_socket()).await;
    let service = starting.await.unwrap().unwrap();
    timing::phase("service_started");
    Agent {
        service,
        gateway,
        _cloud: cloud,
        _base: base,
        began,
    }
}

impl Agent {
    fn since(&self) -> u128 {
        self.began.elapsed().as_millis()
    }
    /// Asks for the wake of database `n` until it is started; the milliseconds since the agent
    /// began.
    async fn wake(&mut self, n: usize) -> u128 {
        let entry = Entry::parse(&entry_json(n)).unwrap();
        let ticket = WakeRequest {
            database: entry.id.clone(),
            operation: format!("op_{}", "w".repeat(20)),
            generation: entry.generation + 1,
            route_revision: entry.route_revision,
            role_revision_hash: entry.role_hash(),
            queued_at_ms: u64::try_from(crate::agent::now_ms()).unwrap(),
        };
        // The gateway delivers a wake again after 3 s while the agent answers `wake_in_progress`,
        // which is no result.
        loop {
            let seen = self.gateway.received().len();
            self.gateway.send_wake(ticket.clone()).await;
            let asked = Instant::now();
            while asked.elapsed() < Duration::from_secs(3) {
                let result = self
                    .gateway
                    .received()
                    .into_iter()
                    .skip(seen)
                    .filter_map(|message| match message {
                        ToGateway::WakeResult { result } if result.database == entry.id => {
                            Some(result)
                        }
                        _ => None,
                    })
                    .next_back();
                match result {
                    Some(result) if result.outcome == Outcome::Started => return self.since(),
                    Some(result) if result.reason.as_deref() == Some("wake_in_progress") => {
                        tokio::time::sleep(Duration::from_secs(3).saturating_sub(asked.elapsed()))
                            .await;
                        break;
                    }
                    Some(result) => {
                        panic!("the wake of {} was refused: {:?}", entry.id, result.reason)
                    }
                    None => tokio::time::sleep(Duration::from_millis(5)).await,
                }
            }
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 6)]
#[ignore = "needs systemd as PID 1, root, LVM and the node image's units (lab)"]
async fn prepare() {
    let Some(lab) = Lab::from_env() else {
        return;
    };
    let node = Arc::new(
        Node::connect(lab.layout.clone(), lab.config.clone(), slots::POOL)
            .await
            .unwrap(),
    );
    node.poll_pool().await.unwrap();
    let storage_policy = policy().storage;
    let mut template = None;
    for n in 0..lab.volumes {
        let (id, real) = (database_id(n), n < lab.real());
        let volume = VolumeId::new(&id, 1).unwrap();
        let account = node.ensure_account(&id).await.unwrap();
        if !node.has_volume(&volume).await.unwrap() {
            let bytes = if real { 192 << 20 } else { 32 << 20 };
            node.create_volume(&volume, bytes, &account, &storage_policy)
                .await
                .unwrap();
        } else {
            assert!(
                node.mount_volumes(std::slice::from_ref(&volume))
                    .await
                    .unwrap()
                    .is_empty()
            );
        }
        if real {
            dm_node(&node.device(&volume));
        }
        node.prepare_socket_directory(&id, &account).unwrap();
        let data = lab.layout.data(&id);
        if real && !data.join("PG_VERSION").exists() {
            node.initdb(&account, &data).await.unwrap();
        } else if !real && !data.join("global/pg_control").exists() {
            let control = template.get_or_insert_with(|| control_of(&lab, 0));
            std::fs::create_dir_all(data.join("global")).unwrap();
            std::fs::create_dir_all(data.join("pg_wal/archive_status")).unwrap();
            std::fs::write(data.join("global/pg_control"), &*control).unwrap();
            let owner = Command::new("chown")
                .args(["-R", &format!("{}:{}", account.uid, account.gid)])
                .arg(&data)
                .status()
                .unwrap();
            assert!(owner.success());
            chown(&data, Some(account.uid), Some(account.gid)).unwrap();
        }
        let control = control_of(&lab, n);
        save_state(&lab, n, &control);
    }
    eprintln!("lab: {} databases are made", lab.volumes);

    // The first databases run: the agent wakes them as it wakes any.
    let mut agent = start_agent(&lab, &node, Instant::now()).await;
    for n in 0..lab.awake {
        agent.wake(n).await;
    }
    eprintln!("lab: {} databases run", lab.awake);
    agent.service.stop();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 6)]
#[ignore = "needs systemd as PID 1, root, LVM and the node image's units (lab)"]
async fn start() {
    let Some(lab) = Lab::from_env() else {
        return;
    };
    let began = Instant::now();
    timing::phase("process_start");
    let node = Arc::new(
        Node::connect(lab.layout.clone(), lab.config.clone(), slots::POOL)
            .await
            .unwrap(),
    );
    timing::phase("storage_open");
    node.reset_device_links().await.unwrap();
    timing::phase("device_links");
    restore_runtime(&*node).await;
    timing::phase("restore_runtime");
    let mut agent = start_agent(&lab, &node, began).await;
    let started = agent.since();
    // The gateway asks for a sleeping database with a PostgreSQL; it is served while the agent
    // decides on the rest.
    let probe = lab.awake + number("PGCF_LAB_PROBE", 0) % lab.asleep;
    let woken = agent.wake(probe).await;
    let table = agent
        .gateway
        .received()
        .iter()
        .position(|message| matches!(message, ToGateway::Table { .. }));
    let core = agent.service.core().clone();
    let all = core.all().len();
    eventually(600, "every database to be decided", || {
        core.all().iter().all(|db| db.view().adopted)
    })
    .await;
    let decided = agent.since();
    let running = core
        .all()
        .iter()
        .filter(|db| db.phase() == crate::agent::Phase::Ready)
        .count();
    for db in core.all() {
        let (phase, error) = {
            let view = db.view();
            (view.phase, view.error)
        };
        if !matches!(
            phase,
            crate::agent::Phase::Asleep | crate::agent::Phase::Ready
        ) {
            eprintln!("lab: {} is {phase:?} {error:?}", db.id);
        }
    }
    eprintln!(
        "lab: databases {all}, ready {running}, service started at {started} ms, first wake \
         served at {woken} ms, every database decided at {decided} ms, table message {table:?}"
    );
    for event in crate::events::seen() {
        if event["event"] == "agent_start_phase" {
            eprintln!("lab: phase {event}");
        }
    }
    // The probe goes back to sleep for the next run: stopped, and its record made of what it left.
    agent.service.stop();
    node.stop(&database_id(probe)).await.unwrap();
    let control = control_of(&lab, probe);
    save_state(&lab, probe, &control);
    // The agent exits: its mounts go before the process does, as `main` has it.
    let releasing = Instant::now();
    node.release_mounts().await;
    eprintln!(
        "lab: the mounts were released in {} ms",
        releasing.elapsed().as_millis()
    );
    eprintln!(
        "lab: finished at {} ms, epoch {}",
        began.elapsed().as_millis(),
        crate::agent::now_ms()
    );
}

/// Puts the sleeping databases with a PostgreSQL back as `prepare` left them, after a run that
/// ended before it could (a wake it did not wait for, a failed assertion).
#[tokio::test(flavor = "multi_thread", worker_threads = 6)]
#[ignore = "needs systemd as PID 1, root, LVM and the node image's units (lab)"]
async fn reset() {
    let Some(lab) = Lab::from_env() else {
        return;
    };
    let node = Node::connect(lab.layout.clone(), lab.config.clone(), slots::POOL)
        .await
        .unwrap();
    for n in lab.awake..lab.real() {
        let volume = VolumeId::new(&database_id(n), 1).unwrap();
        assert!(
            node.mount_volumes(std::slice::from_ref(&volume))
                .await
                .unwrap()
                .is_empty()
        );
        node.stop(&database_id(n)).await.unwrap();
        let control = control_of(&lab, n);
        save_state(&lab, n, &control);
    }
}
