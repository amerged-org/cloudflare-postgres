// SPDX-License-Identifier: Apache-2.0
//! The PostgreSQL units of a node (plan 4.4, 5.5, 5.6 job 4, Appendix C): `pgcf-pg@<id>.service`
//! driven over systemd's D-Bus API.
//!
//! - A start is `StartUnit` and the wait for its `JobRemoved`. The unit is `Type=notify`, so the job
//!   ends when the postmaster accepts connections: nothing polls. One read of `postmaster.pid`
//!   (`ready`) then names the socket the gateway dials. The unit has no start timeout, because
//!   crash recovery or a restore's replay can outlast any: the caller owns the deadline and may
//!   drop the future, which leaves the start running.
//! - Limits are unit properties set with `SetUnitProperties`, never a reload (`limits`). Size
//!   limits are persistent. The CPU quota is applied after ready and outlives the stop of the unit
//!   (a runtime property stays in `/run` until reboot, Stage 1), where it would throttle the next
//!   start; `stop` lifts it, and so does `set_cpu_quota(.., None)`, which the agent also calls for
//!   every stopped unit when it starts.
//! - A database's Linux user and uid are `users`.
//! - What a start took, off the path of a wake: systemd's fork of the main process and its handoff
//!   to the postmaster, and the journal's times of PostgreSQL's three start messages (`timeline`,
//!   `journal`).
//!
//! - The memory ceiling of `pgcf.slice`, which holds every database, is the operator's awake-database
//!   budget (`set_slice_memory`): the kernel's backstop under either memory rule. The image's slice
//!   has 80 % of RAM until the agent sets it.
//!
//! The agent runs as root on the node; systemd answers these calls without further authorization.
pub mod journal;
pub mod limits;
pub mod ready;
pub mod users;

mod dbus;

use futures_util::StreamExt;
use limits::{Limits, Property, cpu_quota, slice_memory};
use pgcf_native_protocol::valid_pattern;
use std::{num::NonZeroU32, path::PathBuf};
use zbus::{proxy::CacheProperties, zvariant::OwnedObjectPath};

/// Where the database volumes are mounted: `<DB_ROOT>/<id>` holds the data directory `data`.
pub const DB_ROOT: &str = "/var/lib/pgcf/db";

/// The directory of the device links: `<DEVICE_LINKS>/<id>` is what `MountImages=` and
/// `AssertPathExists=` of `pgcf-pg@.service` name (`storage::Config::device_links`).
pub const DEVICE_LINKS: &str = "/run/pgcf/dev";

/// The slice that holds every database unit (`Slice=` of `pgcf-pg@.service`).
const SLICE: &str = "pgcf.slice";

/// The prefix of a database's unit; the instance is the database ID.
pub const UNIT_PREFIX: &str = "pgcf-pg@";
const UNIT_SUFFIX: &str = ".service";

/// The unit of a database.
pub fn unit_name(database: &str) -> String {
    format!("{UNIT_PREFIX}{database}{UNIT_SUFFIX}")
}

/// The database a unit name belongs to; `None` for any other unit and for an instance that is no
/// database ID.
pub fn database_of(unit: &str) -> Option<&str> {
    let database = unit.strip_prefix(UNIT_PREFIX)?.strip_suffix(UNIT_SUFFIX)?;
    valid_pattern("database", database).then_some(database)
}

/// systemd's D-Bus object path of a unit: every byte that is not an ASCII letter or digit becomes
/// `_` and two lower-case hexadecimal digits (a leading digit as well), so no `GetUnit` round trip
/// is needed on the start path.
pub fn unit_path(unit: &str) -> String {
    let mut path = String::from("/org/freedesktop/systemd1/unit/");
    if unit.is_empty() {
        path.push('_');
    }
    for (index, byte) in unit.bytes().enumerate() {
        if byte.is_ascii_alphanumeric() && !(index == 0 && byte.is_ascii_digit()) {
            path.push(char::from(byte));
        } else {
            path.push_str(&format!("_{byte:02x}"));
        }
    }
    path
}

/// A unit's invocation ID, the 128 bits systemd draws at every start, as a UUID; `None` for the
/// all-zero ID of a unit that was never started.
pub fn invocation_uuid(id: &[u8]) -> Option<String> {
    if id.len() != 16 || id.iter().all(|byte| *byte == 0) {
        return None;
    }
    let hex = |range: std::ops::Range<usize>| -> String {
        id[range].iter().map(|byte| format!("{byte:02x}")).collect()
    };
    Some(format!(
        "{}-{}-{}-{}-{}",
        hex(0..4),
        hex(4..6),
        hex(6..8),
        hex(8..10),
        hex(10..16)
    ))
}

/// The `ActiveState` of a unit.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ActiveState {
    Active,
    Reloading,
    Inactive,
    Failed,
    Activating,
    Deactivating,
    Maintenance,
    Refreshing,
}
impl ActiveState {
    pub fn parse(state: &str) -> Option<Self> {
        Some(match state {
            "active" => Self::Active,
            "reloading" => Self::Reloading,
            "inactive" => Self::Inactive,
            "failed" => Self::Failed,
            "activating" => Self::Activating,
            "deactivating" => Self::Deactivating,
            "maintenance" => Self::Maintenance,
            "refreshing" => Self::Refreshing,
            _ => return None,
        })
    }
    /// The unit has a process, or is starting one or stopping one: it holds the database's memory.
    pub fn awake(self) -> bool {
        matches!(
            self,
            Self::Active
                | Self::Reloading
                | Self::Activating
                | Self::Deactivating
                | Self::Refreshing
        )
    }
}

/// What the agent reads of a database's unit.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UnitState {
    pub database: String,
    pub active: ActiveState,
    /// The postmaster; `None` while the unit has no main process.
    pub main_pid: Option<u32>,
    /// The invocation ID of the unit's current or last start, as a UUID.
    pub invocation_id: Option<String>,
    /// The uid the unit's process runs as.
    pub uid: Option<u32>,
    /// `MemoryMax` in bytes; `None` for no ceiling. The agent sets it to the database's memory.
    pub memory_max_bytes: Option<u64>,
}
impl UnitState {
    /// From the raw values of the unit's D-Bus properties, which spell "none" as zero, `u32::MAX`
    /// and `u64::MAX`.
    pub fn from_properties(
        database: &str,
        active_state: &str,
        main_pid: u32,
        invocation_id: &[u8],
        uid: u32,
        memory_max: u64,
    ) -> Option<Self> {
        Some(Self {
            database: database.to_string(),
            active: ActiveState::parse(active_state)?,
            main_pid: (main_pid != 0).then_some(main_pid),
            invocation_id: invocation_uuid(invocation_id),
            uid: (uid != u32::MAX).then_some(uid),
            memory_max_bytes: (memory_max != u64::MAX).then_some(memory_max),
        })
    }
}

/// What a call on a unit can fail with.
#[derive(Debug)]
pub enum Error {
    /// The argument is no database ID.
    InvalidDatabase,
    /// The bus or systemd refused or did not answer.
    Bus(zbus::Error),
    /// The start or stop job ended with a result other than `done`: `failed`, `canceled`,
    /// `timeout`, `dependency` or `skipped`.
    Job { unit: String, result: String },
    /// The unit finished starting but PostgreSQL is not the ready main process. The reason is one
    /// of `ready::ready_socket` or `unit_not_active`, `no_main_pid`, `no_uid`, `no_invocation_id`.
    NotReady(&'static str),
    /// systemd did something the agent does not understand.
    Unexpected(&'static str),
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidDatabase => f.write_str("not a database ID"),
            Self::Bus(error) => write!(f, "systemd: {error}"),
            Self::Job { unit, result } => write!(f, "the job of {unit} ended with {result}"),
            Self::NotReady(reason) => write!(f, "PostgreSQL is not ready: {reason}"),
            Self::Unexpected(what) => write!(f, "unexpected from systemd: {what}"),
        }
    }
}
impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Bus(error) => Some(error),
            _ => None,
        }
    }
}
impl From<zbus::Error> for Error {
    fn from(error: zbus::Error) -> Self {
        Self::Bus(error)
    }
}

/// A database whose PostgreSQL accepts connections.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Started {
    /// The postmaster, the unit's main process.
    pub main_pid: u32,
    /// The unit's invocation ID as a UUID; the route names it.
    pub invocation_id: String,
    /// The uid the postmaster runs as.
    pub uid: u32,
    /// The Unix socket it listens on, as its `postmaster.pid` says.
    pub socket: PathBuf,
    /// When the agent asked systemd to start the unit, in microseconds of `CLOCK_MONOTONIC`;
    /// `None` for a start the agent only waited for, and where the clock is not read.
    pub requested_us: Option<u64>,
}

/// What systemd and the journal recorded of one start (`Units::timeline`), in microseconds.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Timeline {
    /// The agent's `StartUnit` to systemd's creation of the main process, which is systemd-executor
    /// until it executes postgres.
    pub job_to_fork_us: Option<u64>,
    /// The fork to the handoff: the executor's setup of the unit's sandbox (namespaces, mounts,
    /// seccomp filter, user), which is systemd's time, not PostgreSQL's.
    pub fork_to_handoff_us: Option<u64>,
    /// The handoff, when the executor was about to execute postgres, to the three messages of
    /// PostgreSQL's start.
    pub startup: Option<journal::Startup>,
}

/// `CLOCK_MONOTONIC` in microseconds: the clock of systemd's `*TimestampMonotonic` properties and
/// of the journal's `__MONOTONIC_TIMESTAMP`.
#[cfg(target_os = "linux")]
fn monotonic_micros() -> Option<u64> {
    let mut now = libc::timespec {
        tv_sec: 0,
        tv_nsec: 0,
    };
    // SAFETY: `clock_gettime` writes the `timespec` it is given and nothing else.
    let read = unsafe { libc::clock_gettime(libc::CLOCK_MONOTONIC, &mut now) };
    let seconds = u64::try_from(now.tv_sec).ok()?;
    let nanos = u64::try_from(now.tv_nsec).ok()?;
    (read == 0).then(|| seconds * 1_000_000 + nanos / 1_000)
}
#[cfg(not(target_os = "linux"))]
fn monotonic_micros() -> Option<u64> {
    None
}

/// The `cpu.stat` of a database's unit in the cgroup tree, where its throttling is counted;
/// `None` for an argument that is no database ID.
pub fn cpu_stat_path(database: &str) -> Option<PathBuf> {
    valid_pattern("database", database).then(|| {
        PathBuf::from(format!(
            "/sys/fs/cgroup/{SLICE}/{}/cpu.stat",
            unit_name(database)
        ))
    })
}

#[derive(Clone, Copy)]
enum JobKind {
    Start,
    Stop,
    Restart,
}

/// The agent's handle on the node's PostgreSQL units. Calls on different databases may run
/// concurrently; the agent's lifecycle serializes the calls on one database.
#[derive(Clone)]
pub struct Units {
    connection: zbus::Connection,
    manager: dbus::ManagerProxy<'static>,
    db_root: PathBuf,
}
impl Units {
    /// Connects to the system bus and subscribes to systemd's job signals. `db_root` is where the
    /// database volumes are mounted (`DB_ROOT` on a node).
    pub async fn connect(db_root: impl Into<PathBuf>) -> Result<Self, Error> {
        let connection = zbus::Connection::system().await?;
        let manager = dbus::ManagerProxy::new(&connection).await?;
        manager.subscribe().await?;
        Ok(Self {
            connection,
            manager,
            db_root: db_root.into(),
        })
    }

    fn unit_of(database: &str) -> Result<String, Error> {
        if valid_pattern("database", database) {
            Ok(unit_name(database))
        } else {
            Err(Error::InvalidDatabase)
        }
    }

    /// Runs a start, stop or restart job and waits for its result. It gives the time the job was
    /// asked for (`Started::requested_us`).
    async fn job(&self, unit: &str, kind: JobKind) -> Result<Option<u64>, Error> {
        // Listening starts before the job exists: a job can end before the reply to its start
        // reaches this client. The bus filters the signals to this unit's.
        let mut removed = self
            .manager
            .inner()
            .receive_signal_with_args("JobRemoved", &[(2, unit)])
            .await?;
        // A start never replaces a job that is queued, and a stop does: an order to stop wins over
        // a start that is under way, whose own waiter then sees `canceled`.
        let requested = monotonic_micros();
        let job = match kind {
            JobKind::Stop => self.manager.stop_unit(unit, "replace").await?,
            JobKind::Start => self.manager.start_unit(unit, "fail").await?,
            JobKind::Restart => self.manager.restart_unit(unit, "replace").await?,
        };
        while let Some(message) = removed.next().await {
            let (_, path, _, result): (u32, OwnedObjectPath, String, String) =
                message.body().deserialize()?;
            if path == job {
                return match result.as_str() {
                    "done" => Ok(requested),
                    _ => Err(Error::Job {
                        unit: unit.to_string(),
                        result,
                    }),
                };
            }
        }
        Err(Error::Unexpected("the bus closed during a job"))
    }

    /// The unit's proxy on `Unit`, which `cache` keeps up to date or reads on every call.
    async fn unit_proxy(
        &self,
        unit: &str,
        cache: CacheProperties,
    ) -> Result<dbus::UnitProxy<'static>, Error> {
        Ok(dbus::UnitProxy::builder(&self.connection)
            .path(unit_path(unit))?
            .cache_properties(cache)
            .build()
            .await?)
    }

    /// The unit's proxy on `Service`, which reads its properties on every call.
    async fn service_proxy(&self, unit: &str) -> Result<dbus::ServiceProxy<'static>, Error> {
        Ok(dbus::ServiceProxy::builder(&self.connection)
            .path(unit_path(unit))?
            .cache_properties(CacheProperties::No)
            .build()
            .await?)
    }

    /// The state of a database's unit. systemd loads a unit when it is asked for it, so a database
    /// that never started is `inactive`, with the memory ceiling of the unit template.
    pub async fn state(&self, database: &str) -> Result<UnitState, Error> {
        let unit_name = Self::unit_of(database)?;
        let unit = self.unit_proxy(&unit_name, CacheProperties::No).await?;
        let service = self.service_proxy(&unit_name).await?;
        let (active, invocation, pid, uid, memory) = tokio::join!(
            unit.active_state(),
            unit.invocation_id(),
            service.main_pid(),
            service.uid(),
            service.memory_max(),
        );
        UnitState::from_properties(database, &active?, pid?, &invocation?, uid?, memory?)
            .ok_or(Error::Unexpected("an active state systemd does not define"))
    }

    /// Every loaded database unit, whatever its state: the agent rebuilds from these at start.
    pub async fn running(&self) -> Result<Vec<UnitState>, Error> {
        let pattern = format!("{UNIT_PREFIX}*{UNIT_SUFFIX}");
        let listed = self
            .manager
            .list_units_by_patterns(&[], &[pattern.as_str()])
            .await?;
        futures_util::future::try_join_all(
            listed
                .iter()
                .filter_map(|row| database_of(&row.0))
                .map(|database| self.state(database)),
        )
        .await
    }

    /// The facts of a unit that finished starting.
    async fn started(&self, database: &str, requested_us: Option<u64>) -> Result<Started, Error> {
        let state = self.state(database).await?;
        if state.active != ActiveState::Active {
            return Err(Error::NotReady("unit_not_active"));
        }
        let main_pid = state.main_pid.ok_or(Error::NotReady("no_main_pid"))?;
        let socket =
            ready::ready_socket(&self.db_root.join(database), main_pid).map_err(Error::NotReady)?;
        Ok(Started {
            main_pid,
            invocation_id: state
                .invocation_id
                .ok_or(Error::NotReady("no_invocation_id"))?,
            uid: state.uid.ok_or(Error::NotReady("no_uid"))?,
            socket,
            requested_us,
        })
    }

    /// What systemd and the journal recorded of the start that gave `started`: the time from the
    /// agent's request to the fork of the main process, from the fork to the handoff (the
    /// executor's sandbox), and from the handoff to the three messages of PostgreSQL's start.
    /// Empty where the unit started again since, so that its times and its journal are another
    /// invocation's. A journal that cannot be read leaves the last part out.
    pub async fn timeline(&self, database: &str, started: &Started) -> Result<Timeline, Error> {
        let unit_name = Self::unit_of(database)?;
        let state = self.state(database).await?;
        let service = self.service_proxy(&unit_name).await?;
        let (fork_us, handoff_us) = tokio::join!(
            service.exec_main_start_timestamp_monotonic(),
            service.exec_main_handoff_timestamp_monotonic(),
        );
        let (fork_us, handoff_us) = (fork_us?, handoff_us?);
        if fork_us == 0
            || handoff_us == 0
            || state.invocation_id.as_deref() != Some(started.invocation_id.as_str())
        {
            return Ok(Timeline::default());
        }
        let journal = journal::read(&started.invocation_id).await.ok();
        Ok(Timeline {
            job_to_fork_us: started
                .requested_us
                .and_then(|requested| fork_us.checked_sub(requested)),
            fork_to_handoff_us: handoff_us.checked_sub(fork_us),
            startup: journal.and_then(|journal| journal::startup(&journal, handoff_us)),
        })
    }

    /// Starts the unit and returns when PostgreSQL accepts connections. Dropping the future does
    /// not stop the start.
    pub async fn start(&self, database: &str) -> Result<Started, Error> {
        let requested = self.job(&Self::unit_of(database)?, JobKind::Start).await?;
        self.started(database, requested).await
    }

    /// Waits for a unit that is starting, one the agent found `activating` when it started, and
    /// returns when PostgreSQL accepts connections.
    pub async fn wait_started(&self, database: &str) -> Result<Started, Error> {
        // The proxy keeps the unit's properties up to date from systemd's change signals, which is
        // what its change stream needs.
        let unit = self
            .unit_proxy(&Self::unit_of(database)?, CacheProperties::Yes)
            .await?;
        // The stream exists before the first read, so a change in between is not lost.
        let mut changes = unit.receive_active_state_changed().await;
        loop {
            match ActiveState::parse(&unit.active_state().await?) {
                Some(ActiveState::Active) => return self.started(database, None).await,
                Some(ActiveState::Activating) => {}
                _ => return Err(Error::NotReady("unit_not_active")),
            }
            if changes.next().await.is_none() {
                return Err(Error::Unexpected("the bus closed while a unit started"));
            }
        }
    }

    /// Stops the unit (a fast shutdown, systemd's `KillSignal=SIGINT`), waits until it is stopped
    /// and lifts its CPU quota. A unit that is not running is stopped already.
    pub async fn stop(&self, database: &str) -> Result<(), Error> {
        self.job(&Self::unit_of(database)?, JobKind::Stop).await?;
        self.set_cpu_quota(database, None).await
    }

    async fn set_properties(
        &self,
        unit: &str,
        runtime: bool,
        properties: &[Property],
    ) -> Result<(), Error> {
        let encoded: Vec<_> = properties.iter().map(dbus::encode).collect();
        self.manager
            .set_unit_properties(unit, runtime, &encoded)
            .await?;
        Ok(())
    }

    /// Sets a database's size limits on its unit, running or not, and keeps them across a reboot.
    pub async fn set_limits(&self, database: &str, limits: &Limits) -> Result<(), Error> {
        self.set_properties(&Self::unit_of(database)?, false, &limits.properties())
            .await
    }

    /// Sets the memory ceiling of all databases together, the awake budget, on their slice,
    /// running or not, and keeps it across a reboot.
    pub async fn set_slice_memory(&self, awake_budget_mib: u64) -> Result<(), Error> {
        self.set_properties(SLICE, false, &[slice_memory(awake_budget_mib)])
            .await
    }

    /// Starts one of the image's own services (the gateway, the Tunnel), or restarts it, and
    /// waits for the job.
    pub async fn start_service(&self, name: &str, restart: bool) -> Result<(), Error> {
        let kind = if restart {
            JobKind::Restart
        } else {
            JobKind::Start
        };
        self.job(name, kind).await.map(drop)
    }

    /// Sets the CPU quota of a database's unit until the next boot, or lifts it with `None`.
    pub async fn set_cpu_quota(
        &self,
        database: &str,
        millicores: Option<NonZeroU32>,
    ) -> Result<(), Error> {
        self.set_properties(&Self::unit_of(database)?, true, &[cpu_quota(millicores)])
            .await
    }
}

#[cfg(test)]
pub(crate) mod lab;

/// A fresh, private directory path below the temporary directory for a test, kept short because a
/// Unix socket path must fit in `sun_path`. The test creates and removes it.
#[cfg(test)]
pub(crate) fn test_dir(label: &str) -> std::path::PathBuf {
    use std::sync::atomic::{AtomicUsize, Ordering};
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    std::env::temp_dir().join(format!(
        "pgcf-{label}-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_unit_name_and_its_database_round_trip() {
        let name = unit_name("abcdefghij0123456789");
        assert_eq!(name, "pgcf-pg@abcdefghij0123456789.service");
        assert_eq!(database_of(&name), Some("abcdefghij0123456789"));
        for other in [
            "pgcf-pg@.service",
            "pgcf-pg@abc.service",
            "pgcf-pg@ABCDEFGHIJ0123456789.service",
            "pgcf-pg@abcdefghij0123456789.timer",
            "pgcf-pg@abcdefghij0123456789",
            "pgcf-gateway.service",
            "pgcf-pg@abcdefghij0123456789.service.d",
            "",
        ] {
            assert_eq!(database_of(other), None, "{other}");
        }
    }

    #[test]
    fn the_object_path_is_systemds_label_escape() {
        // Read from systemd 257 on Debian 13 (`GetUnit` of a loaded instance).
        assert_eq!(
            unit_path("pgcf-t@abc.service"),
            "/org/freedesktop/systemd1/unit/pgcf_2dt_40abc_2eservice"
        );
        assert_eq!(
            unit_path(&unit_name("abcdefghij0123456789")),
            "/org/freedesktop/systemd1/unit/pgcf_2dpg_40abcdefghij0123456789_2eservice"
        );
        assert_eq!(
            unit_path("9a.service"),
            "/org/freedesktop/systemd1/unit/_39a_2eservice",
            "a leading digit is escaped too"
        );
        assert_eq!(unit_path(""), "/org/freedesktop/systemd1/unit/_");
    }

    #[test]
    fn an_invocation_id_is_a_uuid_and_zero_means_never_started() {
        let id = [
            0x1d, 0x7e, 0x15, 0xfa, 0x5e, 0x6c, 0x47, 0xa0, 0x89, 0x5f, 0xa7, 0x2e, 0x00, 0x0a,
            0xb9, 0xfd,
        ];
        assert_eq!(
            invocation_uuid(&id).as_deref(),
            Some("1d7e15fa-5e6c-47a0-895f-a72e000ab9fd")
        );
        assert_eq!(invocation_uuid(&[0; 16]), None);
        assert_eq!(invocation_uuid(&[]), None);
        assert_eq!(invocation_uuid(&id[..15]), None);
        assert_eq!(invocation_uuid(&[1; 17]), None);
    }

    #[test]
    fn active_states_are_systemds_and_awake_means_a_process_may_exist() {
        for (text, state, awake) in [
            ("active", ActiveState::Active, true),
            ("reloading", ActiveState::Reloading, true),
            ("inactive", ActiveState::Inactive, false),
            ("failed", ActiveState::Failed, false),
            ("activating", ActiveState::Activating, true),
            ("deactivating", ActiveState::Deactivating, true),
            ("maintenance", ActiveState::Maintenance, false),
            ("refreshing", ActiveState::Refreshing, true),
        ] {
            assert_eq!(ActiveState::parse(text), Some(state), "{text}");
            assert_eq!(state.awake(), awake, "{text}");
        }
        assert_eq!(ActiveState::parse("Active"), None);
        assert_eq!(ActiveState::parse(""), None);
    }

    #[test]
    fn the_raw_properties_of_a_running_unit_become_a_state() {
        let invocation = [7u8; 16];
        let state = UnitState::from_properties(
            "abcdefghij0123456789",
            "active",
            4242,
            &invocation,
            200_123,
            256 << 20,
        )
        .unwrap();
        assert_eq!(state.database, "abcdefghij0123456789");
        assert_eq!(state.active, ActiveState::Active);
        assert_eq!(state.main_pid, Some(4242));
        assert_eq!(
            state.invocation_id.as_deref(),
            Some("07070707-0707-0707-0707-070707070707")
        );
        assert_eq!(state.uid, Some(200_123));
        assert_eq!(state.memory_max_bytes, Some(256 << 20));
    }

    #[test]
    fn systemds_spellings_of_none_become_none() {
        let state = UnitState::from_properties(
            "abcdefghij0123456789",
            "inactive",
            0,
            &[0; 16],
            u32::MAX,
            u64::MAX,
        )
        .unwrap();
        assert_eq!(state.main_pid, None);
        assert_eq!(state.invocation_id, None);
        assert_eq!(state.uid, None);
        assert_eq!(state.memory_max_bytes, None);
        assert_eq!(
            UnitState::from_properties("abcdefghij0123456789", "bogus", 0, &[], 0, 0),
            None,
            "a state systemd does not define is no state"
        );
    }
}
