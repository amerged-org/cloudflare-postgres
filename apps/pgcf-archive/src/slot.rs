// SPDX-License-Identifier: Apache-2.0
//! `pgcf-archive slot <n>`: the supervisor of one PostgreSQL slot (plan 5.5 and 5.9). A slot is the
//! unit `pgcf-slot@<n>.service`, a sandbox that exists before any database is bound to it. It
//! runs this program as the slot's own user, with no capability, and waits. Only the node agent
//! (root) talks to it, on `$RUNTIME_DIRECTORY/control`, one line per connection:
//!
//! ```text
//! ping                      ->  pgcf-slot/1 idle
//! exec <database> <major>   ->  exec <CLOCK_MONOTONIC microseconds>      (then the exec)
//!                           ->  refused order | id | major | unbound | held | lock
//! ```
//!
//! The agent sends `exec` last: after it set the database's limits on the slot (an idle slot's
//! memory limit is below `shared_buffers`) and mounted the database's volume and socket
//! directory into the slot. The supervisor then, in this order:
//!
//! 1. opens `<data root>/<database>/data` without following a link, and the directory must be
//!    owned by the supervisor's own uid, which proves the agent's idmapped mount is in place;
//! 2. checks that `<socket root>/<database>` is a directory of the same owner;
//! 3. takes `flock(LOCK_EX | LOCK_NB)` on the data directory, and keeps the descriptor across the
//!    exec;
//! 4. answers `exec <microseconds>`;
//! 5. replaces itself with exactly the command line of `pgcf-pg@.service`.
//!
//! The lock is the kernel's guard against a second postmaster on one data directory, which
//! PostgreSQL's own guard cannot be, once two slots with two uids see the directory as their own:
//! `postmaster.pid` names a live process of the other uid, but `kill(pid, 0)` fails with `EPERM`
//! and `miscinit.c` takes that for a stale file; the old shared memory segment is owned by the
//! other uid, `shmget` fails with `EACCES` and `sysv_shmem.c` takes that for a segment of
//! another cluster. A `flock` belongs to the open file description, which PostgreSQL and every
//! backend inherit, so it lasts until the last process of the slot has ended, and it conflicts
//! with another open of the directory in any process. The agent try-locks the same directory
//! before it binds a slot and while it writes the configuration of a sleeping database. A lock
//! belongs to one inode, so it does not exclude a slot that holds another generation of the same
//! database (another filesystem): the agent's binding rule does.
//!
//! Every refusal and every failure is answered where possible and ends the supervisor with status
//! 1: the slot may hold mounts and is not used again. It accepts one `exec` for its whole life,
//! because that either replaces it or ends it. It never forks, mounts or runs anything else.
//! Standard library only; the few C library calls the standard library does not offer are in
//! `sys`.
use std::{
    ffi::{OsStr, OsString},
    fmt,
    fs::{self, File, TryLockError},
    io::{self, BufRead, BufReader, Read, Write},
    os::{
        linux::net::SocketAddrExt,
        unix::{
            ffi::OsStrExt,
            fs::{MetadataExt, OpenOptionsExt},
            net::{SocketAddr, UnixDatagram, UnixListener, UnixStream},
            process::CommandExt,
        },
    },
    path::{Path, PathBuf},
    process::{Command, ExitCode},
    time::Duration,
};

/// Slot numbers are 0 to this, exclusive.
const SLOT_COUNT: u32 = 1024;
/// The PostgreSQL major the image carries.
const MAJOR: u32 = 18;
const POSTGRES: &str = "/usr/lib/postgresql/18/bin/postgres";
const DATA_ROOT: &str = "/var/lib/pgcf/db";
const SOCKET_ROOT: &str = "/run/pgcf";
/// The uid that may give orders.
const AGENT_UID: u32 = 0;
/// The longest line, newline included.
const MAX_LINE_BYTES: usize = 256;
/// How long the agent has to send its line once connected.
const LINE_BOUND: Duration = Duration::from_secs(10);
const IDLE: &str = "pgcf-slot/1 idle";

/// The few calls of the C library that the standard library does not offer, for Linux on x86-64
/// and AArch64 (the constants differ on other architectures).
mod sys {
    use std::{
        ffi::{c_int, c_long, c_void},
        io,
        os::fd::AsRawFd,
    };

    #[cfg(target_arch = "x86_64")]
    pub const O_DIRECTORY: c_int = 0o200_000;
    #[cfg(target_arch = "x86_64")]
    pub const O_NOFOLLOW: c_int = 0o400_000;
    #[cfg(target_arch = "aarch64")]
    pub const O_DIRECTORY: c_int = 0o40_000;
    #[cfg(target_arch = "aarch64")]
    pub const O_NOFOLLOW: c_int = 0o100_000;
    #[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64")))]
    compile_error!("the slot supervisor knows the Linux constants of x86-64 and AArch64 only");

    const SOL_SOCKET: c_int = 1;
    const SO_PEERCRED: c_int = 17;
    const F_SETFD: c_int = 2;
    const CLOCK_MONOTONIC: c_int = 1;

    #[repr(C)]
    struct Credentials {
        pid: i32,
        uid: u32,
        gid: u32,
    }
    #[repr(C)]
    struct Timespec {
        seconds: c_long,
        nanoseconds: c_long,
    }
    unsafe extern "C" {
        pub safe fn getuid() -> u32;
        fn getsockopt(
            socket: c_int,
            level: c_int,
            name: c_int,
            value: *mut c_void,
            length: *mut u32,
        ) -> c_int;
        fn fcntl(descriptor: c_int, command: c_int, ...) -> c_int;
        fn clock_gettime(clock: c_int, time: *mut Timespec) -> c_int;
    }

    /// The uid the kernel recorded for the process that connected `socket`.
    pub fn peer_uid(socket: &impl AsRawFd) -> io::Result<u32> {
        let mut credentials = Credentials {
            pid: 0,
            uid: 0,
            gid: 0,
        };
        let mut length = size_of::<Credentials>() as u32;
        // SAFETY: `credentials` and `length` are live for the call, and `length` is the size of
        // the buffer that `value` points to.
        let status = unsafe {
            getsockopt(
                socket.as_raw_fd(),
                SOL_SOCKET,
                SO_PEERCRED,
                (&raw mut credentials).cast(),
                &raw mut length,
            )
        };
        if status == 0 {
            Ok(credentials.uid)
        } else {
            Err(io::Error::last_os_error())
        }
    }

    /// Clears close-on-exec: the descriptor survives `execve`. The standard library opens every
    /// file with it set.
    pub fn inherit(descriptor: &impl AsRawFd) -> io::Result<()> {
        let flags: c_int = 0;
        // SAFETY: F_SETFD takes an integer, and the descriptor is open.
        if unsafe { fcntl(descriptor.as_raw_fd(), F_SETFD, flags) } == 0 {
            Ok(())
        } else {
            Err(io::Error::last_os_error())
        }
    }

    /// CLOCK_MONOTONIC in microseconds, the clock the agent measures its own steps with.
    pub fn monotonic_microseconds() -> io::Result<u64> {
        let mut time = Timespec {
            seconds: 0,
            nanoseconds: 0,
        };
        // SAFETY: `time` is live for the call.
        if unsafe { clock_gettime(CLOCK_MONOTONIC, &raw mut time) } != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(time.seconds.unsigned_abs() * 1_000_000 + time.nanoseconds.unsigned_abs() / 1_000)
    }
}

/// Where a slot finds its socket and its database, and who may order it.
struct Config {
    control: PathBuf,
    /// systemd's `NOTIFY_SOCKET`.
    notify: Option<OsString>,
    data_root: PathBuf,
    socket_root: PathBuf,
    postgres: PathBuf,
    /// The supervisor's own uid: the owner the mounted directories must have.
    uid: u32,
    /// The uid of the only peer that may connect.
    agent: u32,
}
impl Config {
    /// The configuration of slot `slot` on a node, from what systemd gives the unit.
    fn slot(
        slot: &str,
        runtime_directory: Option<OsString>,
        notify: Option<OsString>,
        uid: u32,
    ) -> Result<Self, String> {
        if !slot
            .parse::<u32>()
            .is_ok_and(|number| number < SLOT_COUNT && number.to_string() == slot)
        {
            return Err(format!("{slot:?} is not a slot number below {SLOT_COUNT}"));
        }
        let directory = PathBuf::from(runtime_directory.ok_or("RUNTIME_DIRECTORY is not set")?);
        if !directory.is_absolute() {
            return Err("RUNTIME_DIRECTORY is not an absolute path".into());
        }
        Ok(Self {
            control: directory.join("control"),
            notify,
            data_root: DATA_ROOT.into(),
            socket_root: SOCKET_ROOT.into(),
            postgres: POSTGRES.into(),
            uid,
            agent: AGENT_UID,
        })
    }
}

/// Why an order is refused. The word is the answer the agent reads.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Reason {
    /// Not a line of the protocol.
    Order,
    /// The database ID is not one.
    Id,
    /// The PostgreSQL major is not the image's.
    Major,
    /// The data or the socket directory is not what the agent's mounts make it.
    Unbound,
    /// Another open file description holds the lock: a postmaster of this database lives.
    Held,
    /// The lock could not be taken or kept for the exec.
    Lock,
}
impl Reason {
    fn word(self) -> &'static str {
        match self {
            Self::Order => "order",
            Self::Id => "id",
            Self::Major => "major",
            Self::Unbound => "unbound",
            Self::Held => "held",
            Self::Lock => "lock",
        }
    }
}

/// Why the supervisor ends. Success is the exec, which never returns.
enum Stop {
    Refused(Reason),
    Failed(String),
}
impl Stop {
    fn failed(what: &str, error: &io::Error) -> Self {
        Self::Failed(format!("{what}: {error}"))
    }
}
impl fmt::Display for Stop {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Refused(reason) => write!(formatter, "refused {}", reason.word()),
            Self::Failed(text) => formatter.write_str(text),
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
enum Order<'a> {
    Ping,
    Exec(&'a str),
}
/// A database ID: `^[a-z][a-z0-9]{19}$`, so that it is one path component and nothing else.
fn valid_id(id: &str) -> bool {
    id.len() == 20
        && id.starts_with(|first: char| first.is_ascii_lowercase())
        && id
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
}
fn parse(line: &[u8]) -> Result<Order<'_>, Reason> {
    let line = std::str::from_utf8(line).map_err(|_| Reason::Order)?;
    match line.split(' ').collect::<Vec<_>>()[..] {
        ["ping"] => Ok(Order::Ping),
        ["exec", id, major] => {
            if !valid_id(id) {
                Err(Reason::Id)
            } else if major != MAJOR.to_string() {
                Err(Reason::Major)
            } else {
                Ok(Order::Exec(id))
            }
        }
        _ => Err(Reason::Order),
    }
}

/// The command line of `ExecStart=` in `pgcf-pg@.service`, for the database `id`.
fn postgres(config: &Config, id: &str) -> Command {
    let mut command = Command::new(&config.postgres);
    command
        .arg("-D")
        .arg(config.data_root.join(id).join("data"))
        .args(["-c", "listen_addresses=", "-c"])
        .arg({
            let mut setting = OsString::from("unix_socket_directories=");
            setting.push(config.socket_root.join(id));
            setting
        });
    command
}

fn open_directory(path: &Path) -> io::Result<File> {
    File::options()
        .read(true)
        .custom_flags(sys::O_DIRECTORY | sys::O_NOFOLLOW)
        .open(path)
}
fn owned_by(metadata: &fs::Metadata, uid: u32) -> bool {
    metadata.is_dir() && metadata.uid() == uid
}

fn notify_ready(address: Option<&OsStr>) -> io::Result<()> {
    let Some(address) = address else {
        return Ok(());
    };
    let socket = UnixDatagram::unbound()?;
    match address.as_bytes().strip_prefix(b"@") {
        Some(name) => socket
            .send_to_addr(b"READY=1", &SocketAddr::from_abstract_name(name)?)
            .map(drop),
        None => socket.send_to(b"READY=1", address).map(drop),
    }
}

enum Line {
    Complete(Vec<u8>),
    TooLong,
    /// The peer closed, or was too slow, before the end of its line.
    Incomplete,
}
fn read_line(stream: &UnixStream) -> Line {
    if stream.set_read_timeout(Some(LINE_BOUND)).is_err() {
        return Line::Incomplete;
    }
    let mut line = Vec::new();
    let mut reader = BufReader::new(stream.take(MAX_LINE_BYTES as u64));
    match reader.read_until(b'\n', &mut line) {
        Ok(_) if line.ends_with(b"\n") => {
            line.pop();
            Line::Complete(line)
        }
        Ok(_) if line.len() >= MAX_LINE_BYTES => Line::TooLong,
        _ => Line::Incomplete,
    }
}

/// Answers a refusal where the peer still listens.
fn refuse(mut stream: UnixStream, reason: Reason) -> Stop {
    let _ = stream.write_all(format!("refused {}\n", reason.word()).as_bytes());
    Stop::Refused(reason)
}

/// Carries out an `exec` order: it returns only when the slot ends instead.
fn exec(config: &Config, mut stream: UnixStream, id: &str) -> Stop {
    let Ok(data) = open_directory(&config.data_root.join(id).join("data")) else {
        return refuse(stream, Reason::Unbound);
    };
    if !data
        .metadata()
        .is_ok_and(|metadata| owned_by(&metadata, config.uid))
    {
        return refuse(stream, Reason::Unbound);
    }
    if !fs::symlink_metadata(config.socket_root.join(id))
        .is_ok_and(|metadata| owned_by(&metadata, config.uid))
    {
        return refuse(stream, Reason::Unbound);
    }
    match data.try_lock() {
        Ok(()) => {}
        Err(TryLockError::WouldBlock) => return refuse(stream, Reason::Held),
        Err(TryLockError::Error(_)) => return refuse(stream, Reason::Lock),
    }
    if sys::inherit(&data).is_err() {
        return refuse(stream, Reason::Lock);
    }
    let reply = sys::monotonic_microseconds().map(|micros| format!("exec {micros}\n"));
    match reply {
        Ok(reply) => {
            if let Err(error) = stream.write_all(reply.as_bytes()) {
                return Stop::failed("answering the exec order", &error);
            }
        }
        Err(error) => return Stop::failed("reading the clock", &error),
    }
    // The lock descriptor is open and not close-on-exec; the control socket and the connection
    // are close-on-exec and end here.
    let error = postgres(config, id).exec();
    Stop::failed("exec of postgres", &error)
}

/// One connection: `Ok` when the slot goes on waiting.
fn connection(config: &Config, mut stream: UnixStream) -> Result<(), Stop> {
    // Anything but the agent is closed unheard, whatever it sends.
    if !sys::peer_uid(&stream).is_ok_and(|uid| uid == config.agent) {
        return Ok(());
    }
    let line = match read_line(&stream) {
        Line::Complete(line) => line,
        Line::TooLong => return Err(refuse(stream, Reason::Order)),
        Line::Incomplete => return Ok(()),
    };
    match parse(&line) {
        Ok(Order::Ping) => {
            let _ = stream.write_all(format!("{IDLE}\n").as_bytes());
            Ok(())
        }
        Ok(Order::Exec(id)) => Err(exec(config, stream, id)),
        Err(reason) => Err(refuse(stream, reason)),
    }
}

/// Listens, reports READY=1 and serves until an order ends the slot. It returns only the reason.
fn serve(config: &Config) -> Stop {
    let listener = match UnixListener::bind(&config.control) {
        Ok(listener) => listener,
        Err(error) => return Stop::failed("binding the control socket", &error),
    };
    if let Err(error) = notify_ready(config.notify.as_deref()) {
        return Stop::failed("reporting READY=1", &error);
    }
    loop {
        let stream = match listener.accept() {
            Ok((stream, _)) => stream,
            Err(error) => return Stop::failed("accepting a connection", &error),
        };
        if let Err(stop) = connection(config, stream) {
            return stop;
        }
    }
}

/// `pgcf-archive slot <slot>`. It never returns success: the exec replaces the process.
pub fn run(slot: &str) -> ExitCode {
    let config = Config::slot(
        slot,
        std::env::var_os("RUNTIME_DIRECTORY"),
        std::env::var_os("NOTIFY_SOCKET"),
        sys::getuid(),
    );
    let stop = match config {
        Ok(config) => serve(&config),
        Err(error) => Stop::Failed(error),
    };
    eprintln!("pgcf-archive slot {slot}: {stop}");
    ExitCode::FAILURE
}

#[cfg(test)]
mod tests {
    use super::*;
    use pgcf_test_postgres::{Cluster, Directory, binaries};
    use std::{
        fs::{self, File, TryLockError},
        io::{ErrorKind, Read, Write},
        os::unix::{
            fs::{PermissionsExt, symlink},
            net::{UnixDatagram, UnixStream},
        },
        process::{Child, Stdio},
        time::{Duration, Instant},
    };

    const ID: &str = "a0b1c2d3e4f5g6h7i8j9";
    const OTHER: &str = "k0l1m2n3o4p5q6r7s8t9";
    /// The environment variable that turns `supervisor_child` into a supervisor process.
    const CHILD: &str = "PGCF_SLOT_TEST_CHILD";
    const RECORD: &str = "PGCF_SLOT_TEST_RECORD";
    const MODE: &str = "PGCF_SLOT_TEST_MODE";
    const HOLD: &str = "PGCF_SLOT_TEST_HOLD";
    /// What the tests exec in place of postgres: it records its arguments, then ends at once, holds
    /// in the foreground or leaves a background child, as `MODE` says, for as long as the `HOLD`
    /// file exists.
    const TARGET: &str = r#"#!/bin/sh
[ -n "$PGCF_SLOT_TEST_RECORD" ] || exit 0
printf '%s\n' "$@" > "$PGCF_SLOT_TEST_RECORD.tmp" && mv "$PGCF_SLOT_TEST_RECORD.tmp" "$PGCF_SLOT_TEST_RECORD"
held() { while [ -e "$PGCF_SLOT_TEST_HOLD" ]; do sleep 0.05; done; }
case "$PGCF_SLOT_TEST_MODE" in
  foreground) held ;;
  background) held > /dev/null 2>&1 & ;;
esac
"#;

    fn own_uid() -> u32 {
        sys::getuid()
    }
    fn id(number: u32) -> String {
        format!("a{number:019}")
    }

    fn wait_until(what: &str, mut done: impl FnMut() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(30);
        while !done() {
            assert!(Instant::now() < deadline, "timed out waiting for {what}");
            std::thread::sleep(Duration::from_millis(20));
        }
    }
    fn lock_is_held(directory: &Path) -> bool {
        match File::open(directory).unwrap().try_lock() {
            Ok(()) => false,
            Err(TryLockError::WouldBlock) => true,
            Err(TryLockError::Error(error)) => panic!("{error}"),
        }
    }

    /// The directories of a node for the database `ID`, under one private temporary directory.
    struct Layout {
        root: Directory,
        target: PathBuf,
    }
    impl Layout {
        fn new() -> Self {
            let root = Directory::new("slot");
            for id in [ID, OTHER] {
                fs::create_dir_all(root.path().join("db").join(id).join("data")).unwrap();
                fs::create_dir_all(root.path().join("run").join(id)).unwrap();
            }
            let target = root.path().join("target.sh");
            fs::write(&target, TARGET).unwrap();
            fs::set_permissions(&target, fs::Permissions::from_mode(0o700)).unwrap();
            // A file that was written a moment ago cannot be executed while another thread's
            // fork still holds a copy of its write descriptor (ETXTBSY): run it until it can.
            loop {
                match Command::new(&target).status() {
                    Err(error) if error.kind() == ErrorKind::ExecutableFileBusy => {
                        std::thread::sleep(Duration::from_millis(10));
                    }
                    other => {
                        assert!(other.unwrap().success());
                        break;
                    }
                }
            }
            Self { root, target }
        }
        fn path(&self, parts: &[&str]) -> PathBuf {
            parts
                .iter()
                .fold(self.root.path().to_path_buf(), |path, part| path.join(part))
        }
        fn data(&self) -> PathBuf {
            self.path(&["db", ID, "data"])
        }
        fn config(&self, name: &str, postgres: &Path, uid: u32, agent: u32) -> Config {
            let directory = self.path(&[name]);
            fs::create_dir_all(&directory).unwrap();
            Config {
                control: directory.join("control"),
                notify: Some(directory.join("notify").into()),
                data_root: self.path(&["db"]),
                socket_root: self.path(&["run"]),
                postgres: postgres.into(),
                uid,
                agent,
            }
        }
        /// A supervisor of the agent's own uid, with the stand-in for postgres.
        fn slot(&self, name: &str, environment: &[(&str, &Path)]) -> Running {
            Running::start(
                &self.config(name, &self.target, own_uid(), own_uid()),
                environment,
            )
        }
    }

    fn text(path: &Path) -> String {
        path.to_str().unwrap().into()
    }
    fn encode(config: &Config) -> String {
        [
            text(&config.control),
            config
                .notify
                .as_ref()
                .map(|notify| notify.to_str().unwrap().to_string())
                .unwrap_or_default(),
            text(&config.data_root),
            text(&config.socket_root),
            text(&config.postgres),
            config.uid.to_string(),
            config.agent.to_string(),
        ]
        .join("\n")
    }
    fn decode(encoded: &str) -> Config {
        let fields: Vec<&str> = encoded.split('\n').collect();
        Config {
            control: fields[0].into(),
            notify: Some(fields[1].into()),
            data_root: fields[2].into(),
            socket_root: fields[3].into(),
            postgres: fields[4].into(),
            uid: fields[5].parse().unwrap(),
            agent: fields[6].parse().unwrap(),
        }
    }

    /// The entry of the supervisor processes the other tests start: the test program runs it
    /// again with `CHILD` set, because a supervisor that execs cannot run inside a test. Without
    /// `CHILD` it does nothing.
    #[test]
    fn supervisor_child() {
        let Some(encoded) = std::env::var_os(CHILD) else {
            return;
        };
        let stop = serve(&decode(encoded.to_str().unwrap()));
        eprintln!("pgcf-archive slot: {stop}");
        std::process::exit(1);
    }

    /// A supervisor process, with the systemd notify socket it reports to.
    struct Running {
        child: Child,
        control: PathBuf,
        errors: PathBuf,
    }
    impl Running {
        fn start(config: &Config, environment: &[(&str, &Path)]) -> Self {
            let notify = Path::new(config.notify.as_ref().unwrap());
            let socket = UnixDatagram::bind(notify).unwrap();
            socket
                .set_read_timeout(Some(Duration::from_millis(100)))
                .unwrap();
            let errors = notify.with_file_name("stderr");
            let child = Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "slot::tests::supervisor_child",
                    "--nocapture",
                    "--test-threads=1",
                ])
                .env(CHILD, encode(config))
                .envs(environment.iter().copied())
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(File::create(&errors).unwrap())
                .spawn()
                .unwrap();
            let mut slot = Self {
                child,
                control: config.control.clone(),
                errors,
            };
            let mut ready = [0u8; 32];
            let deadline = Instant::now() + Duration::from_secs(20);
            let length = loop {
                match socket.recv(&mut ready) {
                    Ok(length) => break length,
                    Err(error) => {
                        assert!(
                            slot.running() && Instant::now() < deadline,
                            "no READY=1 ({error}): {}",
                            slot.stderr()
                        );
                    }
                }
            };
            assert_eq!(&ready[..length], b"READY=1");
            slot
        }
        fn stderr(&self) -> String {
            fs::read_to_string(&self.errors).unwrap_or_default()
        }
        fn connect(&self) -> UnixStream {
            let stream = UnixStream::connect(&self.control).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(20)))
                .unwrap();
            stream
        }
        /// Sends one line and returns the answer line, or "" when the slot closes without one.
        fn ask(&self, line: &str) -> String {
            let mut stream = self.connect();
            let _ = stream.write_all(format!("{line}\n").as_bytes());
            answer(&mut stream)
        }
        fn running(&mut self) -> bool {
            self.child.try_wait().unwrap().is_none()
        }
        /// Waits for the process to end: its exit code and what it wrote to stderr.
        fn exit(&mut self) -> (Option<i32>, String) {
            wait_until("the supervisor to end", || !self.running());
            (self.child.wait().unwrap().code(), self.stderr())
        }
    }
    impl Drop for Running {
        fn drop(&mut self) {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
    fn answer(stream: &mut UnixStream) -> String {
        let mut reply = Vec::new();
        let mut byte = [0u8; 1];
        while let Ok(1) = stream.read(&mut byte) {
            if byte[0] == b'\n' {
                break;
            }
            reply.push(byte[0]);
        }
        String::from_utf8(reply).unwrap()
    }

    #[test]
    fn orders_are_exactly_ping_and_exec_of_a_valid_id_and_major() {
        assert_eq!(parse(b"ping"), Ok(Order::Ping));
        assert_eq!(
            parse(format!("exec {ID} 18").as_bytes()),
            Ok(Order::Exec(ID))
        );
        for (line, reason) in [
            ("", Reason::Order),
            ("ping ", Reason::Order),
            (" ping", Reason::Order),
            ("PING", Reason::Order),
            ("exec", Reason::Order),
            ("exec a0b1c2d3e4f5g6h7i8j9", Reason::Order),
            ("exec a0b1c2d3e4f5g6h7i8j9 18 x", Reason::Order),
            ("exec  a0b1c2d3e4f5g6h7i8j9 18", Reason::Order),
            ("stop", Reason::Order),
            ("exec A0b1c2d3e4f5g6h7i8j9 18", Reason::Id),
            ("exec 00b1c2d3e4f5g6h7i8j9 18", Reason::Id),
            ("exec a0b1c2d3e4f5g6h7i8j 18", Reason::Id),
            ("exec a0b1c2d3e4f5g6h7i8j9k 18", Reason::Id),
            ("exec ../../../etc/passwd/x 18", Reason::Id),
            ("exec a0b1c2d3e4f5g6h7i8j9 17", Reason::Major),
            ("exec a0b1c2d3e4f5g6h7i8j9 018", Reason::Major),
            ("exec a0b1c2d3e4f5g6h7i8j9 +18", Reason::Major),
            ("exec a0b1c2d3e4f5g6h7i8j9 eighteen", Reason::Major),
        ] {
            assert_eq!(parse(line.as_bytes()), Err(reason), "{line:?}");
        }
        assert_eq!(parse(b"exec \xff 18"), Err(Reason::Order));
    }

    #[test]
    fn the_data_directory_is_opened_as_a_directory_and_never_through_a_link() {
        let root = Directory::new("open");
        let (directory, file) = (root.path().join("directory"), root.path().join("file"));
        fs::create_dir(&directory).unwrap();
        fs::write(&file, "").unwrap();
        symlink(&directory, root.path().join("link")).unwrap();
        assert!(open_directory(&directory).is_ok());
        assert_eq!(
            open_directory(&file).unwrap_err().kind(),
            ErrorKind::NotADirectory
        );
        // A link to a directory is refused, not followed (the kernel answers ENOTDIR for it).
        assert_eq!(
            open_directory(&root.path().join("link"))
                .unwrap_err()
                .kind(),
            ErrorKind::NotADirectory
        );
    }

    #[test]
    fn the_slot_is_configured_by_its_number_and_systemd() {
        let config = Config::slot(
            "12",
            Some("/run/pgcf/slot/12".into()),
            Some("/run/systemd/notify".into()),
            300_012,
        )
        .unwrap();
        assert_eq!(config.control, Path::new("/run/pgcf/slot/12/control"));
        assert_eq!(config.notify, Some("/run/systemd/notify".into()));
        assert_eq!(config.data_root, Path::new("/var/lib/pgcf/db"));
        assert_eq!(config.socket_root, Path::new("/run/pgcf"));
        assert_eq!((config.uid, config.agent), (300_012, 0));
        for slot in ["", "1024", "-1", "01", "x", "1 ", "+1"] {
            assert!(
                Config::slot(slot, Some("/run/pgcf/slot/1".into()), None, 1).is_err(),
                "{slot:?}"
            );
        }
        assert!(Config::slot("1023", Some("/run/pgcf/slot/1023".into()), None, 1).is_ok());
        assert!(Config::slot("1", None, None, 1).is_err());
        assert!(Config::slot("1", Some("slot/1".into()), None, 1).is_err());
    }

    #[test]
    fn the_exec_line_is_the_execstart_of_the_database_unit() {
        let unit = fs::read_to_string(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../infra/node-image/mkosi.extra/usr/lib/systemd/system/pgcf-pg@.service"),
        )
        .unwrap();
        let mut starts = unit
            .lines()
            .filter_map(|line| line.strip_prefix("ExecStart="));
        let start = starts.next().unwrap();
        assert!(starts.next().is_none());
        let expected: Vec<String> = start
            .split_whitespace()
            .map(|word| word.replace("%i", ID))
            .collect();
        let config = Config::slot("0", Some("/run/pgcf/slot/0".into()), None, 300_000).unwrap();
        let command = postgres(&config, ID);
        let actual: Vec<String> = std::iter::once(command.get_program())
            .chain(command.get_args())
            .map(|word| word.to_str().unwrap().into())
            .collect();
        assert_eq!(actual, expected);
    }

    #[test]
    fn an_idle_slot_answers_ping_to_the_agent_and_is_closed_to_anyone_else() {
        let layout = Layout::new();
        let record = layout.path(&["record"]);
        let mut slot = layout.slot("agent", &[]);
        assert_eq!(slot.ask("ping"), "pgcf-slot/1 idle");
        assert_eq!(slot.ask("ping"), "pgcf-slot/1 idle");
        assert!(slot.running());
        // A peer that is not the agent gets no answer, not even to a valid order, and the slot
        // goes on waiting.
        let mut closed = Running::start(
            &layout.config("other", &layout.target, own_uid(), own_uid() + 1),
            &[(RECORD, &record)],
        );
        assert_eq!(closed.ask("ping"), "");
        assert_eq!(closed.ask(&format!("exec {ID} 18")), "");
        assert!(closed.running());
        assert!(!record.exists());
    }

    #[test]
    fn every_refused_order_is_answered_and_ends_the_slot_without_running_anything() {
        let layout = Layout::new();
        let record = layout.path(&["record"]);
        // Databases whose directories are not what the agent's mounts make them.
        let (missing, link, file, no_socket, socket_link) = (id(1), id(2), id(3), id(4), id(5));
        for id in [&link, &file, &no_socket, &socket_link] {
            fs::create_dir_all(layout.path(&["db", id])).unwrap();
        }
        symlink(layout.data(), layout.path(&["db", &link, "data"])).unwrap();
        fs::write(layout.path(&["db", &file, "data"]), "").unwrap();
        fs::create_dir(layout.path(&["db", &no_socket, "data"])).unwrap();
        fs::create_dir(layout.path(&["db", &socket_link, "data"])).unwrap();
        for id in [&link, &file] {
            fs::create_dir(layout.path(&["run", id])).unwrap();
        }
        symlink(
            layout.path(&["run", ID]),
            layout.path(&["run", &socket_link]),
        )
        .unwrap();
        let cases: Vec<(String, u32, &str)> = vec![
            (format!("exec {} 18", "A".repeat(20)), 0, "refused id"),
            ("exec ../../etc 18".into(), 0, "refused id"),
            (format!("exec {ID} 17"), 0, "refused major"),
            (format!("exec {ID}"), 0, "refused order"),
            ("stop".into(), 0, "refused order"),
            ("x".repeat(300), 0, "refused order"),
            // A directory that belongs to someone else than the slot's uid.
            (format!("exec {ID} 18"), 1, "refused unbound"),
            (format!("exec {missing} 18"), 0, "refused unbound"),
            (format!("exec {link} 18"), 0, "refused unbound"),
            (format!("exec {file} 18"), 0, "refused unbound"),
            (format!("exec {no_socket} 18"), 0, "refused unbound"),
            (format!("exec {socket_link} 18"), 0, "refused unbound"),
        ];
        for (number, (line, other_uid, reply)) in cases.into_iter().enumerate() {
            let name = format!("refusing{number}");
            let mut slot = Running::start(
                &layout.config(&name, &layout.target, own_uid() + other_uid, own_uid()),
                &[(RECORD, &record)],
            );
            assert_eq!(slot.ask(&line), reply, "{line:?}");
            let (code, errors) = slot.exit();
            assert_eq!(code, Some(1), "{line:?}");
            assert!(errors.contains(reply), "{line:?}: {errors}");
            assert!(!record.exists(), "{line:?}");
        }
    }

    #[test]
    fn the_exec_order_takes_the_lock_answers_with_the_clock_and_runs_exactly_its_command() {
        let layout = Layout::new();
        let (record, hold) = (layout.path(&["record"]), layout.path(&["hold"]));
        fs::write(&hold, "").unwrap();
        let environment: [(&str, &Path); 3] = [
            (RECORD, &record),
            (HOLD, &hold),
            (MODE, Path::new("foreground")),
        ];
        let mut first = layout.slot("first", &environment);
        let before = sys::monotonic_microseconds().unwrap();
        let reply = first.ask(&format!("exec {ID} 18"));
        let after = sys::monotonic_microseconds().unwrap();
        let micros: u64 = reply.strip_prefix("exec ").unwrap().parse().unwrap();
        assert!(
            (before..=after).contains(&micros),
            "{before} {micros} {after}"
        );
        wait_until("the target to run", || record.exists());
        assert_eq!(
            fs::read_to_string(&record).unwrap(),
            format!(
                "-D\n{}/db/{ID}/data\n-c\nlisten_addresses=\n-c\nunix_socket_directories={}/run/{ID}\n",
                layout.path(&[]).display(),
                layout.path(&[]).display(),
            )
        );
        // The process that took the lock is the target now, and it holds the lock.
        assert!(lock_is_held(&layout.data()));
        let mut second = layout.slot("second", &[]);
        assert_eq!(second.ask(&format!("exec {ID} 18")), "refused held");
        assert_eq!(second.exit().0, Some(1));
        // The other database of the node is not locked by it.
        assert!(!lock_is_held(&layout.path(&["db", OTHER, "data"])));
        assert!(first.running());
        fs::remove_file(&hold).unwrap();
        assert_eq!(first.exit().0, Some(0));
        assert!(!lock_is_held(&layout.data()));
    }

    #[test]
    fn a_child_of_the_target_keeps_the_lock_after_the_process_that_took_it_has_ended() {
        let layout = Layout::new();
        let (record, hold) = (layout.path(&["record"]), layout.path(&["hold"]));
        fs::write(&hold, "").unwrap();
        let mut slot = layout.slot(
            "slot",
            &[
                (RECORD, &record),
                (HOLD, &hold),
                (MODE, Path::new("background")),
            ],
        );
        assert!(slot.ask(&format!("exec {ID} 18")).starts_with("exec "));
        // The target ended at once; the descriptor of the lock was inherited by its child.
        assert_eq!(slot.exit().0, Some(0));
        assert!(lock_is_held(&layout.data()));
        fs::remove_file(&hold).unwrap();
        wait_until("the child to release the lock", || {
            !lock_is_held(&layout.data())
        });
    }

    #[test]
    fn a_second_order_is_never_acted_on() {
        let layout = Layout::new();
        let (record, hold) = (layout.path(&["record"]), layout.path(&["hold"]));
        fs::write(&hold, "").unwrap();
        let mut slot = layout.slot(
            "slot",
            &[
                (RECORD, &record),
                (HOLD, &hold),
                (MODE, Path::new("foreground")),
            ],
        );
        // Both connections are queued before the first order is read.
        let mut first = slot.connect();
        let mut second = slot.connect();
        first
            .write_all(format!("exec {ID} 18\n").as_bytes())
            .unwrap();
        assert!(answer(&mut first).starts_with("exec "));
        let _ = second.write_all(format!("exec {OTHER} 18\n").as_bytes());
        assert_eq!(answer(&mut second), "");
        wait_until("the target to run", || record.exists());
        assert!(
            fs::read_to_string(&record)
                .unwrap()
                .contains(&format!("/{ID}/")),
        );
        assert!(!lock_is_held(&layout.path(&["db", OTHER, "data"])));
        assert!(slot.running());
        fs::remove_file(&hold).unwrap();
        assert_eq!(slot.exit().0, Some(0));
    }

    #[test]
    fn postgresql_is_the_exec_target_and_the_lock_stays_with_it() {
        let Some(bin) = binaries() else { return };
        let layout = Layout::new();
        let mut cluster = Cluster::init(&bin, "", "local all all trust\n");
        fs::remove_dir(layout.data()).unwrap();
        fs::rename(&cluster.data, layout.data()).unwrap();
        cluster.data = layout.data();
        cluster.sockets = layout.path(&["run", ID]);
        let mut slot = Running::start(
            &layout.config("slot", &bin.join("postgres"), own_uid(), own_uid()),
            &[],
        );
        assert!(slot.ask(&format!("exec {ID} 18")).starts_with("exec "));
        wait_until("PostgreSQL to be ready", || {
            assert!(slot.running(), "{}", slot.stderr());
            fs::read_to_string(layout.data().join("postmaster.pid")).is_ok_and(|pid| {
                pid.lines()
                    .nth(7)
                    .is_some_and(|status| status.trim() == "ready")
            })
        });
        // The exec replaced the program of the supervisor's process, not the process.
        let pid = fs::read_to_string(layout.data().join("postmaster.pid")).unwrap();
        assert_eq!(pid.lines().next().unwrap(), slot.child.id().to_string());
        assert_eq!(cluster.psql("postgres", "select 1"), "1");
        // Another supervisor on the same database is refused for as long as PostgreSQL runs.
        let mut second = layout.slot("second", &[]);
        assert_eq!(second.ask(&format!("exec {ID} 18")), "refused held");
        assert_eq!(second.exit().0, Some(1));
        let stopped = Command::new(bin.join("pg_ctl"))
            .args(["stop", "-m", "fast", "-w", "-t", "60", "-D"])
            .arg(layout.data())
            .stdout(Stdio::null())
            .status()
            .unwrap();
        assert!(stopped.success());
        assert_eq!(slot.exit().0, Some(0), "{}", cluster.log());
        assert!(!lock_is_held(&layout.data()));
    }
}
