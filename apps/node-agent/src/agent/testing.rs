// SPDX-License-Identifier: Apache-2.0
//! The core against real PostgreSQL 18 on a machine that stands in for systemd and LVM only. The
//! archive socket, its upload log, the jobs and the roles are the agent's own; R2 and barman are
//! the fixture's executables, which take a real backup with the backup API of the database they
//! are pointed at (see `archive::test_support`).
use super::{Core, Entry, Parts, Policy, Timing};
use crate::{
    admission::{EarlySleep, Running},
    archive::{
        job::{Jobs, Limits},
        protocol::AGENT_BOUND,
        server::{Server, Table, bind},
        test_support::{CREDENTIAL_CHECK, Fixture},
    },
    credentials::Credentials,
    fence::Fences,
    gateway::Feed,
    link::test_server::{database, vector},
    machine::{Machine, local::Local},
    postgres, testpg,
};
use pgcf_native_protocol::{
    agent::{FromGateway, SessionStatus, ToGateway, decode_to_gateway},
    wake::WakeRequest,
};
use serde_json::{Value, json};
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::mpsc::UnboundedReceiver;
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::UnixStream,
};

pub(crate) const OPERATION: &str = "op_cccccccccccccccccccc";

/// A node with the core on it.
pub(crate) struct Rig {
    pub core: Arc<Core<Local>>,
    pub machine: Arc<Local>,
    pub fixture: Arc<Fixture>,
    pub table: Arc<Table>,
    pub gateway: Arc<Feed>,
    pub early: UnboundedReceiver<EarlySleep>,
    pub root: PathBuf,
    /// The wakes the gateway sends; kept open so the feed has somewhere to put them.
    wakes: Option<UnboundedReceiver<WakeRequest>>,
    tasks: Vec<tokio::task::JoinHandle<std::convert::Infallible>>,
}
impl Drop for Rig {
    fn drop(&mut self) {
        for task in &self.tasks {
            task.abort();
        }
    }
}

fn executable(path: &Path, text: &str) {
    fs::write(path, text).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
}

/// `barman-cloud-backup` over the backup API of the database it is pointed at: it copies the data
/// directory between `pg_backup_start` and `pg_backup_stop` as the backup role and leaves a
/// backup of the "bucket" that a restore can start from.
fn barman_backup(store: &Path, psql: &Path) -> String {
    format!(
        r#"#!/bin/sh
STORE='{store}'
PSQL='{psql}'
{CREDENTIAL_CHECK}
host=; user=; db=
while [ $# -gt 0 ]; do
  case "$1" in
    --gzip|--immediate-checkpoint) ;;
    -J|--endpoint-url) shift ;;
    --host) host=$2; shift ;;
    -U) user=$2; shift ;;
    -d) db=$2; shift ;;
    *) break ;;
  esac
  shift
done
dest=$1; server=$2
if [ -f "$STORE/backup-fail" ]; then echo 'simulated backup failure' >&2; exit 4; fi
base="$STORE/objects/${{dest#s3://}}/$server/base"
id=$(date -u +%Y%m%dT%H%M%S)
while [ -d "$base/$id" ]; do sleep 1; id=$(date -u +%Y%m%dT%H%M%S); done
target="$base/$id"
mkdir -p "$target"
sql() {{ "$PSQL" -X -At -h "$host" -U "$user" -d "$db" -c "$1"; }}
data=$(sql 'SHOW data_directory') || exit 3
"$PSQL" -X -q -At -h "$host" -U "$user" -d "$db" -v ON_ERROR_STOP=1 >/dev/null <<SQL || exit 5
SELECT pg_backup_start('fixture', true);
\! cp -R "$data" "$target/data"
\o $target/label
SELECT labelfile FROM pg_backup_stop(false);
SQL
mv "$target/label" "$target/data/backup_label"
rm -f "$target/data/postmaster.pid" "$target/data/postmaster.opts"
timeline=$(sql 'SELECT timeline_id FROM pg_control_checkpoint()')
system=$(sql 'SELECT system_identifier FROM pg_control_system()')
endwal=$(sql 'SELECT pg_walfile_name(pg_current_wal_lsn())')
now=$(date -u +%Y-%m-%dT%H:%M:%S+00:00)
printf '{{"backup_id":"%s","status":"DONE","timeline":%s,"systemid":"%s","end_wal":"%s","end_time_iso":"%s","xlog_segment_size":16777216}}' "$id" "$timeline" "$system" "$endwal" "$now" > "$target/backup.json"
"#,
        store = store.display(),
        psql = psql.display()
    )
}

pub(crate) fn policy() -> Policy {
    let mut page = vector("NodeDesiredPage", "full-page");
    // Tests wait for what they wait for; nothing in them should be refused for want of time.
    page["policy"]["admission"]["queue_wait_ms"] = json!(300);
    // The quota comes with the wake, as the tests that read it expect; the tests of the burst set
    // theirs (`boost`).
    page["policy"]["admission"]["cpu_boost_ms"] = json!(0);
    Policy::parse(&page["policy"]).unwrap()
}

pub(crate) fn timing() -> Timing {
    Timing {
        archive_wait: Duration::from_secs(20),
        wake_start: Duration::from_secs(20),
        idle_poll: Duration::from_millis(100),
        watch: Duration::from_millis(100),
        recovery_retry: Duration::from_millis(100),
        recovery_retry_maximum: Duration::from_millis(400),
        adopt_wait: Duration::from_secs(5),
        report_retry: Duration::from_millis(10),
        report_retry_maximum: Duration::from_millis(40),
        host_files_retry: Duration::from_millis(500),
        host_files_retry_maximum: Duration::from_millis(2000),
        settle: Duration::from_secs(10),
        detail: Duration::from_millis(100),
    }
}

/// The JSON of the page entry of a new database with the roles `app` and `reader`.
pub(crate) fn new_entry_json() -> Value {
    let id = testpg::database_id();
    let mut db = database(&id);
    db["origin"] = json!({"kind": "create"});
    db["archive"]["path"] = json!(format!("s3://pgcf-eu/eu-dev/{id}/g1-{OPERATION}"));
    db["archive"]["credential"]["id"] = json!("crd_aaaaaaaaaaaaaaaaaaaa");
    db["roles"] = json!([
        {"name": "app", "owner": true, "password": testpg::password(1), "revision": 1},
        {"name": "reader", "owner": false, "password": testpg::password(2), "revision": 2}
    ]);
    db["sleep_after_seconds"] = json!(60);
    db
}

/// A node that has what the agent runs on: a machine, the fixture's executables for the jobs and
/// the clients of the archive socket, which `socket` names. Its layout points at them.
pub(crate) fn site(
    label: &str,
    socket: &dyn Fn(&Path) -> PathBuf,
) -> Option<(Arc<Local>, Arc<Fixture>, PathBuf)> {
    let machine = Local::new(label)?;
    let root = machine.layout().state.parent().unwrap().to_path_buf();
    let fixture = Fixture::new(label);
    fixture.install(
        "barman-cloud-backup",
        barman_backup(
            &fixture.store_directory(),
            &machine.layout().postgres_bin.join("psql"),
        ),
    );
    let archive_socket = socket(&root);
    let client = |name: &str, text: String| {
        let path = root.join(name);
        executable(&path, &text);
        path
    };
    let archive_client = client(
        "archive-client",
        format!(
            "#!/bin/sh\nreply=$(printf 'pgcf-archive/1 archive %s\\n' \"$(basename \"$1\")\" | nc -U -w 70 '{}')\n[ \"$reply\" = ok ]\n",
            archive_socket.display()
        ),
    );
    let fetch_client = client(
        "fetch-client",
        format!(
            "#!/bin/sh\nreply=$(printf 'pgcf-archive/1 fetch %s %s\\n' \"$1\" \"$2\" | nc -U -w 70 '{}')\ncase \"$reply\" in ok) exit 0 ;; missing) exit 1 ;; *) exit 255 ;; esac\n",
            archive_socket.display()
        ),
    );
    let machine = Arc::new(machine.with_layout(|layout| {
        layout.archive_command = archive_client.display().to_string();
        layout.fetch_command = fetch_client.display().to_string();
        layout.systemd_run = fixture.bin_directory().join("systemd-run");
        layout.barman_bin = fixture.bin_directory();
    }));
    Some((machine, Arc::new(fixture), root))
}

fn root_socket(root: &Path) -> PathBuf {
    root.join("a.sock")
}

impl Rig {
    pub(crate) async fn new(label: &str) -> Option<Self> {
        Self::with_timing(label, timing()).await
    }

    /// A node whose agent waits as `timing` says.
    pub(crate) async fn with_timing(label: &str, timing: Timing) -> Option<Self> {
        let (machine, fixture, root) = site(label, &root_socket)?;
        Some(Self::boot(machine, fixture, root, Vec::new(), timing).await)
    }

    /// The agent process on a machine: its sockets, its tables and its core. A restart is another
    /// boot on the same machine, whose units run on.
    async fn boot(
        machine: Arc<Local>,
        fixture: Arc<Fixture>,
        root: PathBuf,
        running: Vec<Running>,
        timing: Timing,
    ) -> Self {
        let archive_socket = root.join("a.sock");
        let table = Arc::new(Table::default());
        let credentials = Arc::new(Credentials::default());
        let jobs = Arc::new(Jobs::new(
            fixture.runner().with_grace(Duration::ZERO),
            Limits::default(),
        ));
        let server = Arc::new(
            Server::new(table.clone(), jobs.clone(), credentials.clone()).with_bound(AGENT_BOUND),
        );
        let server = tokio::spawn(server.serve(bind(&archive_socket).unwrap()));
        let gateway = Arc::new(Feed::new());
        let (wake_sender, wakes) = tokio::sync::mpsc::unbounded_channel();
        let feed = gateway.clone();
        let listener = crate::gateway::bind(&root.join("g.sock"), 0o600, None).unwrap();
        let feed = tokio::spawn(async move { feed.serve(listener, wake_sender, None).await });
        let fences = Fences::load(machine.layout().fences()).unwrap();
        let (core, early, _resumed) = Core::new(
            Parts {
                machine: machine.clone(),
                jobs,
                table: table.clone(),
                credentials,
                gateway: gateway.clone(),
                fences,
                policy: policy(),
                timing,
            },
            running,
        );
        Self {
            core,
            machine,
            fixture,
            table,
            gateway,
            early,
            root,
            wakes: Some(wakes),
            tasks: vec![server, feed],
        }
    }

    /// The agent restarts: a new process on the same node. What it keeps in memory is gone; the
    /// units run on, and it finds them as it finds them at boot.
    pub(crate) async fn restart(self) -> Self {
        for task in &self.tasks {
            task.abort();
        }
        // The timers that apply the quotas after a burst die with the process.
        for db in self.core.all() {
            db.end_boost();
        }
        let units = self.machine.units().await.unwrap();
        let running = units
            .iter()
            .filter_map(|unit| Running::from_unit(unit, false))
            .collect();
        let (machine, fixture, root) = (
            self.machine.clone(),
            self.fixture.clone(),
            self.root.clone(),
        );
        let timing = self.core.timing.clone();
        drop(self);
        // The agent's mount namespace ends with it: the volumes are mounted again by the next
        // one, which the units that run do not wait for.
        machine.forget_mounts();
        // The old sockets close with the old tasks.
        tokio::time::sleep(Duration::from_millis(50)).await;
        Self::boot(machine, fixture, root, running, timing).await
    }

    /// A page entry for a new database with the roles `app` and `reader`; the archive credential
    /// is delivered.
    pub(crate) fn entry(&self) -> Entry {
        Entry::parse(&self.entry_json()).expect("a valid entry")
    }

    /// The JSON of such an entry, which a test changes before it makes a page of it.
    pub(crate) fn entry_json(&self) -> Value {
        let db = new_entry_json();
        self.deliver(db["archive"]["path"].as_str().unwrap(), "read_write");
        db
    }

    /// The entry of an entry JSON.
    pub(crate) fn entry_for(&self, db: &Value) -> Entry {
        Entry::parse(db).expect("a valid entry")
    }

    /// A page of the desired state: a full pull of the node's databases and orders.
    pub(crate) fn page(
        databases: Vec<Value>,
        orders: Vec<crate::link::Order>,
    ) -> crate::link::Desired {
        let page = vector("NodeDesiredPage", "full-page");
        crate::link::Desired {
            release: Value::Null,
            policy: page["policy"].clone(),
            credentials_revision: 1,
            orders,
            diagnostics: Vec::new(),
            databases,
            complete: true,
        }
    }

    /// Delivers the credential of an archive path.
    pub(crate) fn deliver(&self, path: &str, access: &str) {
        self.core
            .deliver(&json!({
                "id": "crd_aaaaaaaaaaaaaaaaaaaa", "path": path, "access": access,
                "endpoint_url": "https://account.r2.cloudflarestorage.com",
                "access_key_id": "fixturekeyid1234", "secret_access_key": crate::testpg::password(3),
                "session_token": "fixturetoken1234567", "expires_at": "2099-01-01T00:00:00.000Z"
            }))
            .unwrap();
    }

    /// A session as the agent on a database of the node.
    pub(crate) async fn agent(&self, id: &str) -> postgres::Session {
        postgres::agent(&self.machine.layout().socket_directory(id))
            .await
            .unwrap()
    }

    /// A database built and ready: accepted from the page, then created.
    pub(crate) async fn create(&self) -> (Entry, Arc<super::Db>) {
        self.create_from(&self.entry_json()).await
    }

    /// A database built and ready from the JSON of its entry, which the test keeps to move the
    /// page on.
    pub(crate) async fn create_from(&self, json: &Value) -> (Entry, Arc<super::Db>) {
        let entry = self.entry_for(json);
        let db = self.core.db(&entry.id);
        assert!(self.core.accept(&db, entry.clone()));
        let _flow = db.lock.lock().await;
        self.core.build(&db, &entry).await.expect("the build");
        drop(_flow);
        (entry, db)
    }

    /// Answers the wakes of the gateway as the service does: the core decides, the feed tells the
    /// gateway.
    pub(crate) fn serve_wakes(&mut self) -> tokio::task::JoinHandle<()> {
        let mut wakes = self.wakes.take().expect("the wakes are served once");
        let (core, gateway) = (self.core.clone(), self.gateway.clone());
        tokio::spawn(async move {
            while let Some(request) = wakes.recv().await {
                let (core, gateway) = (core.clone(), gateway.clone());
                tokio::spawn(async move { gateway.wake_result(core.wake(&request).await) });
            }
        })
    }

    /// The wake ticket the Edge would send for the entry's next generation.
    pub(crate) fn ticket(entry: &Entry) -> WakeRequest {
        WakeRequest {
            database: entry.id.clone(),
            operation: format!("op_{}", "w".repeat(20)),
            generation: entry.generation + 1,
            route_revision: entry.route_revision,
            role_revision_hash: entry.role_hash(),
            queued_at_ms: u64::try_from(super::now_ms()).unwrap(),
        }
    }

    /// A gateway connected to the agent's channel.
    pub(crate) async fn connect_gateway(&self) -> FakeGateway {
        let gateway = FakeGateway::connect(&self.root.join("g.sock")).await;
        // From here on every change of the table reaches it as a message of its own.
        eventually(5, "the feed to serve the gateway", || {
            self.gateway.connected()
        })
        .await;
        gateway
    }

    /// The observation the core queued last for a database.
    pub(crate) fn observation(&self, id: &str) -> Value {
        self.core.pending_observation(id).expect("an observation")
    }
}

/// What a fake gateway says of the sessions and the activity of every database.
#[derive(Clone, Debug)]
pub(crate) struct Sessions {
    pub status: SessionStatus,
    pub connections: usize,
    pub busy_connections: usize,
    pub last_activity_ms: Option<i64>,
}

/// A gateway that answers the agent's requests and records everything the agent sends.
pub(crate) struct FakeGateway {
    pub received: Arc<Mutex<Vec<ToGateway>>>,
    pub sessions: Arc<Mutex<Sessions>>,
    write: Arc<tokio::sync::Mutex<tokio::net::unix::OwnedWriteHalf>>,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for FakeGateway {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl FakeGateway {
    /// Connects as soon as the agent serves `socket`, as the gateway retries while it does not.
    pub(crate) async fn connect(socket: &Path) -> Self {
        let started = std::time::Instant::now();
        let stream = loop {
            match UnixStream::connect(socket).await {
                Ok(stream) => break stream,
                Err(error) => {
                    assert!(started.elapsed() < Duration::from_secs(60), "{error}");
                    tokio::time::sleep(Duration::from_millis(1)).await;
                }
            }
        };
        let (read, write) = stream.into_split();
        let received = Arc::new(Mutex::new(Vec::new()));
        let sessions = Arc::new(Mutex::new(Sessions {
            status: SessionStatus::Idle,
            connections: 0,
            busy_connections: 0,
            last_activity_ms: None,
        }));
        let (log, state) = (received.clone(), sessions.clone());
        let write = Arc::new(tokio::sync::Mutex::new(write));
        let writing = write.clone();
        let task = tokio::spawn(async move {
            let mut lines = BufReader::new(read);
            let mut line = String::new();
            loop {
                line.clear();
                if lines.read_line(&mut line).await.unwrap_or(0) == 0 {
                    return;
                }
                let message = decode_to_gateway(line.trim_end().as_bytes()).unwrap();
                log.lock().unwrap().push(message.clone());
                let seen = state.lock().unwrap().clone();
                let reply = match message {
                    ToGateway::Control { id, database, .. } => Some(FromGateway::Status {
                        id,
                        database,
                        status: seen.status,
                        connections: seen.connections,
                        busy_connections: seen.busy_connections,
                        pending_dials: 0,
                    }),
                    ToGateway::Activity { id, database } => {
                        let at = |ms: i64| crate::archive::facts::timestamp(ms);
                        let now = super::now_ms();
                        Some(FromGateway::Activity {
                            id,
                            database,
                            report: serde_json::from_value(json!({
                                "processEpoch": "0f6c2d8e-5b7a-4c1e-9a3b-2d4e6f8a0b1c",
                                "epoch": "1f6c2d8e-5b7a-4c1e-9a3b-2d4e6f8a0b1c",
                                "startedAt": at(now - 100_000), "counterStartedAt": at(now - 100_000),
                                "observedAt": at(now), "history": "complete",
                                "countersSince": at(now - 100_000),
                                "ingressBytes": 10, "egressBytes": 20, "totalConnections": 1,
                                "connectionMilliseconds": 30, "connections": seen.connections,
                                "authenticatedConnections": seen.connections,
                                "busyConnections": seen.busy_connections, "pendingDials": 0,
                                "lastActivityAt": seen.last_activity_ms.map(at),
                            }))
                            .unwrap(),
                        })
                    }
                    _ => None,
                };
                if let Some(reply) = reply {
                    let mut text = serde_json::to_vec(&reply).unwrap();
                    text.push(b'\n');
                    if writing.lock().await.write_all(&text).await.is_err() {
                        return;
                    }
                }
            }
        });
        Self {
            received,
            sessions,
            write,
            task,
        }
    }
    /// A wake the gateway queued.
    pub(crate) async fn send_wake(&mut self, wake: WakeRequest) {
        let mut text = serde_json::to_vec(&FromGateway::Wake { wake }).unwrap();
        text.push(b'\n');
        self.write.lock().await.write_all(&text).await.unwrap();
    }
    /// Everything the agent sent, in order.
    pub(crate) fn received(&self) -> Vec<ToGateway> {
        self.received.lock().unwrap().clone()
    }
}

/// Waits for `condition`, which is polled, up to `seconds`.
pub(crate) async fn eventually(seconds: u64, what: &str, mut condition: impl FnMut() -> bool) {
    let started = std::time::Instant::now();
    while !condition() {
        assert!(
            started.elapsed() < Duration::from_secs(seconds),
            "timed out: {what}"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}
