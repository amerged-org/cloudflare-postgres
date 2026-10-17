// SPDX-License-Identifier: Apache-2.0
//! Test fixtures of the archive module. Real PostgreSQL 18 serves every database behaviour; what a
//! laptop cannot run is stood in for by real executables with the interface of the original: a
//! `systemd-run` that runs its command with the unit's environment file, and barman-cloud
//! commands whose "bucket" is a directory. The R2 round trip, `systemd-run` with its sandbox and
//! the real barman are proved on a node (plan 10, Stage 1 and Stage 5).
use super::job::{Database, Runner};
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::atomic::{AtomicU64, Ordering},
};

static SEQUENCE: AtomicU64 = AtomicU64::new(0);

pub fn directory(name: &str) -> PathBuf {
    let directory = std::env::temp_dir().join(format!(
        "pa-{}-{}-{name}",
        std::process::id(),
        SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = fs::remove_dir_all(&directory);
    fs::create_dir_all(&directory).unwrap();
    directory
}

fn script(path: &Path, text: String) {
    fs::write(path, text).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
}

const CREDENTIAL_CHECK: &str = r#"[ -n "$AWS_ACCESS_KEY_ID" ] && [ -n "$AWS_SECRET_ACCESS_KEY" ] && [ -n "$AWS_SESSION_TOKEN" ] && [ "$AWS_DEFAULT_REGION" = auto ] && [ "$TMPDIR" = /var/tmp ] || { echo 'no credential in the environment' >&2; exit 3; }
echo "$AWS_ACCESS_KEY_ID" > "$STORE/key-id""#;

/// A directory with the executables a job needs and the "bucket" they write to.
pub struct Fixture {
    root: PathBuf,
}
impl Fixture {
    pub fn new(name: &str) -> Self {
        let root = directory(name);
        let store = root.join("store");
        fs::create_dir_all(root.join("bin")).unwrap();
        fs::create_dir_all(&store).unwrap();
        let store = store.display();
        // systemd-run: the unit's command with the unit's environment file; the options are the
        // contract of `systemd_run_arguments`.
        script(
            &root.join("bin/systemd-run"),
            r#"#!/bin/sh
env_file=
while [ $# -gt 0 ]; do
  case "$1" in
    --) shift; break ;;
    -p) shift; case "$1" in EnvironmentFile=*) env_file=${1#EnvironmentFile=} ;; esac ;;
  esac
  shift
done
if [ -n "$env_file" ]; then set -a; . "$env_file"; set +a; fi
exec "$@"
"#
            .into(),
        );
        // barman-cloud-wal-archive: the object exists, whole, only when the command exits 0.
        script(
            &root.join("bin/barman-cloud-wal-archive"),
            format!(
                r#"#!/bin/sh
STORE='{store}'
{CREDENTIAL_CHECK}
while [ $# -gt 0 ]; do case "$1" in --gzip) ;; --endpoint-url) shift ;; *) break ;; esac; shift; done
dest=$1; server=$2; path=$3
touch "$STORE/running.$$"
ls "$STORE" | grep -c '^running\.' >> "$STORE/seen"
if [ -f "$STORE/delay" ]; then sleep "$(cat "$STORE/delay")"; fi
if [ -f "$STORE/fail" ]; then echo 'simulated R2 outage' >&2; rm "$STORE/running.$$"; exit 4; fi
key="$STORE/objects/${{dest#s3://}}/$server/wals/$(basename "$path").gz"
mkdir -p "$(dirname "$key")"
gzip -c "$path" > "$key.part" && sync && mv "$key.part" "$key"
status=$?
rm "$STORE/running.$$"
touch "$STORE/finished"
exit $status
"#
            ),
        );
        // barman-cloud-wal-restore: exit 1 and barman's message when the object is absent.
        script(
            &root.join("bin/barman-cloud-wal-restore"),
            format!(
                r#"#!/bin/sh
STORE='{store}'
{CREDENTIAL_CHECK}
while [ $# -gt 0 ]; do case "$1" in -p|--endpoint-url) shift ;; --spool-dir) echo "$2" >> "$STORE/spool-dirs"; shift ;; *) break ;; esac; shift; done
dest=$1; server=$2; name=$3; target=$4
if [ -f "$STORE/fetch-fail" ]; then echo 'simulated R2 outage' >&2; exit 4; fi
key="$STORE/objects/${{dest#s3://}}/$server/wals/$name.gz"
if [ ! -f "$key" ]; then echo "WAL file $name for server $server does not exist" >&2; exit 1; fi
gunzip -c "$key" > "$target.part" && mv "$target.part" "$target"
"#
            ),
        );
        Self { root }
    }
    pub fn runner(&self) -> Runner {
        fs::create_dir_all(self.root.join("jobs")).unwrap();
        Runner::new(
            self.root.join("bin/systemd-run"),
            self.root.join("bin"),
            self.root.join("jobs"),
        )
    }
    pub fn jobs_directory(&self) -> PathBuf {
        self.root.join("jobs")
    }
    fn store(&self, file: &str) -> PathBuf {
        self.root.join("store").join(file)
    }
    /// Switches a behaviour of the commands on (`fail`, `fetch-fail`) or sets it (`delay`).
    pub fn set(&self, flag: &str, value: &str) {
        fs::write(self.store(flag), value).unwrap();
    }
    pub fn clear(&self, flag: &str) {
        let _ = fs::remove_file(self.store(flag));
    }
    /// The object an upload to `destination` leaves for `name`.
    pub fn object(&self, destination: &str, name: &str) -> PathBuf {
        self.root.join(format!(
            "store/objects/{}/database/wals/{name}.gz",
            destination.strip_prefix("s3://").unwrap()
        ))
    }
    pub fn put_object(&self, destination: &str, name: &str, bytes: &[u8]) {
        let object = self.object(destination, name);
        fs::create_dir_all(object.parent().unwrap()).unwrap();
        let mut gzip = Command::new("gzip")
            .arg("-c")
            .stdin(Stdio::piped())
            .stdout(fs::File::create(&object).unwrap())
            .spawn()
            .unwrap();
        std::io::Write::write_all(&mut gzip.stdin.take().unwrap(), bytes).unwrap();
        assert!(gzip.wait().unwrap().success());
    }
    /// How many uploads ran at the start of each upload, itself included.
    pub fn concurrency(&self) -> Vec<usize> {
        fs::read_to_string(self.store("seen"))
            .unwrap_or_default()
            .lines()
            .map(|line| line.trim().parse().unwrap())
            .collect()
    }
    pub fn spool_directories(&self) -> Vec<String> {
        fs::read_to_string(self.store("spool-dirs"))
            .unwrap_or_default()
            .lines()
            .map(Into::into)
            .collect()
    }
    /// The access key id the last command ran with.
    pub fn key_id(&self) -> Option<String> {
        fs::read_to_string(self.store("key-id"))
            .ok()
            .map(|id| id.trim().into())
    }
    /// Whether an upload ran to its end.
    pub fn finished(&self) -> bool {
        self.store("finished").exists()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

pub fn database(volume: &Path) -> Database {
    Database {
        id: "abcdefghijklmnopqrst".into(),
        user: "pgcf-abcdefghijklmnopqrst".into(),
        volume: volume.into(),
        socket_directory: volume.join("socket"),
    }
}

use super::{
    job::{Jobs, Limits, Store},
    server::{Recovery, Registration, Server, Table, bind},
    upload_log::UploadLog,
};
use crate::credentials::{Access, Credential, Credentials};
use std::{os::unix::fs::MetadataExt, sync::Arc, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::UnixStream,
};

pub const SEGMENT: &str = "000000010000000000000001";
pub const ARCHIVE: &str = "s3://pgcf-eu/eu-dev/abcdefghijklmnopqrst/g1-op_aaaaaaaaaaaaaaaaaaaa";
pub const SOURCE: &str = "s3://pgcf-eu/eu-dev/zyxwvutsrqponmlkjihg/g1-op_bbbbbbbbbbbbbbbbbbbb";

pub fn credential() -> Credential {
    Credential::delivered(
        "fixturekeyid",
        "fixturesecret",
        "fixturetoken",
        1,
        u64::MAX / 2,
    )
    .unwrap()
}
pub fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
}
pub fn store(path: &str, access: Access) -> Store {
    Store::new(path, "https://account.r2.cloudflarestorage.com", access).unwrap()
}

/// A node with one database whose volume and socket live in a temporary directory.
pub struct Node {
    pub fixture: Fixture,
    pub root: PathBuf,
    pub socket: PathBuf,
    pub table: Arc<Table>,
    pub credentials: Arc<Credentials>,
    pub uid: u32,
    pub task: tokio::task::JoinHandle<std::convert::Infallible>,
}
impl Node {
    pub async fn start(name: &str, bound: Duration) -> Self {
        let fixture = Fixture::new(name);
        let root = directory(name);
        let volume = root.join("volume");
        std::fs::create_dir_all(volume.join("data/pg_wal")).unwrap();
        std::fs::write(volume.join("data/pg_wal").join(SEGMENT), vec![9u8; 2048]).unwrap();
        let uid = std::fs::metadata(&volume).unwrap().uid();
        let table = Arc::new(Table::default());
        let credentials = Arc::new(Credentials::delivered());
        for access in [Access::ReadWrite, Access::ReadOnly] {
            for path in [ARCHIVE, SOURCE] {
                credentials.hold(store(path, access).scope, credential());
            }
        }
        let jobs = Arc::new(Jobs::new(
            fixture.runner().with_grace(Duration::ZERO),
            Limits::default(),
        ));
        let socket = root.join("a.sock");
        let server =
            Arc::new(Server::new(table.clone(), jobs, credentials.clone()).with_bound(bound));
        let task = tokio::spawn(server.serve(bind(&socket).unwrap()));
        let node = Self {
            fixture,
            root,
            socket,
            table,
            credentials,
            uid,
            task,
        };
        node.register(None);
        node
    }
    pub fn volume(&self) -> PathBuf {
        self.root.join("volume")
    }
    pub fn log(&self) -> UploadLog {
        UploadLog::new(self.root.join("uploads"))
    }
    pub fn register(&self, recovery: Option<Recovery>) {
        self.table.set(Registration {
            database: database(&self.volume()),
            uid: self.uid,
            store: store(ARCHIVE, Access::ReadWrite),
            recovery,
            upload_log: self.log(),
        });
    }
    pub fn recovery(&self, required_through: Option<&str>) -> Recovery {
        Recovery {
            source: store(SOURCE, Access::ReadOnly),
            spool: self.volume().join("spool-op_cccccccccccccccccccc"),
            required_through: required_through.map(Into::into),
        }
    }
    pub async fn ask(&self, line: &str) -> String {
        let mut stream = UnixStream::connect(&self.socket).await.unwrap();
        stream.write_all(line.as_bytes()).await.unwrap();
        let mut answer = String::new();
        stream.read_to_string(&mut answer).await.unwrap();
        answer
    }
    pub async fn archive(&self, name: &str) -> String {
        self.ask(&format!("pgcf-archive/1 archive {name}\n")).await
    }
    pub async fn fetch(&self, name: &str) -> String {
        self.ask(&format!(
            "pgcf-archive/1 fetch {name} pg_wal/RECOVERYXLOG\n"
        ))
        .await
    }
}
impl Drop for Node {
    fn drop(&mut self) {
        self.task.abort();
        let _ = std::fs::remove_dir_all(&self.root);
    }
}
