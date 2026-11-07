// SPDX-License-Identifier: Apache-2.0
//! Closed, nonsecret health-check failure reports at the child-process boundary.

use crate::Error;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{fmt, io, process::Output};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Stage {
    Runtime,
    MountNamespace,
    NodeConnect,
    ScratchAccount,
    VolumeIdentity,
    AdoptSlots,
    StopPrevious,
    PoolSample,
    VolumeCreate,
    Initdb,
    SettingsBuild,
    SettingsWrite,
    SocketPrepare,
    SlotRefill,
    SlotBind,
    SlotExec,
    SqlConnect,
    SqlQuery,
    SqlValidate,
    StopAfter,
    ChildSpawn,
    ChildReport,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Class {
    IoNotFound,
    IoPermissionDenied,
    IoConnectionRefused,
    IoConnectionReset,
    IoBrokenPipe,
    IoTimedOut,
    IoUnexpectedEof,
    IoOutOfMemory,
    IoOther,
    UnitsInvalidDatabase,
    UnitsBusLimitsExceeded,
    UnitsBusNoReply,
    UnitsBusOther,
    UnitsJobFailed,
    UnitsJobTimeout,
    UnitsJobOther,
    UnitsNotReadyExited,
    UnitsNotReadyInactive,
    UnitsNotReady,
    UnitsStrayProcesses,
    UnitsHeld,
    UnitsNoSlot,
    UnitsRefused,
    UnitsUnexpected,
    StorageCommandFailed,
    StorageCommandSignaled,
    StorageNeedsRepair,
    StorageNoRoom,
    StorageLogicalCap,
    StorageMissing,
    StorageBusy,
    StorageOtherGeneration,
    StorageFsckFailed,
    StorageOther,
    PostgresAuthentication,
    PostgresOutOfMemory,
    PostgresDiskFull,
    PostgresTooManyConnections,
    PostgresClosed,
    PostgresOther,
    Invariant,
    Other,
    ChildReportUnavailable,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Program {
    Lvs,
    Lvcreate,
    Lvchange,
    Vgchange,
    Dmsetup,
    MkfsExt4,
    E2fsck,
    Mount,
    Umount,
}
impl Program {
    fn named(name: &str) -> Option<Self> {
        Some(match name {
            "lvs" => Self::Lvs,
            "lvcreate" => Self::Lvcreate,
            "lvchange" => Self::Lvchange,
            "vgchange" => Self::Vgchange,
            "dmsetup" => Self::Dmsetup,
            "mkfs.ext4" => Self::MkfsExt4,
            "e2fsck" => Self::E2fsck,
            "mount" => Self::Mount,
            "umount" => Self::Umount,
            _ => return None,
        })
    }
}

/// No field can carry error text, a path, an identifier or an arbitrary token.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Failure {
    pub stage: Stage,
    pub class: Class,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub program: Option<Program>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<u8>,
}
impl Failure {
    pub fn fixed(stage: Stage, class: Class) -> Self {
        Self {
            stage,
            class,
            program: None,
            exit_code: None,
        }
    }
    pub fn from_io(stage: Stage, error: &io::Error) -> Self {
        Self::fixed(stage, io_class(error))
    }
    pub fn from_error(stage: Stage, error: &Error) -> Self {
        use crate::{storage, units};
        let mut report = Self::fixed(stage, Class::Other);
        report.class = if let Some(error) = error.downcast_ref::<io::Error>() {
            io_class(error)
        } else if let Some(error) = error.downcast_ref::<units::Error>() {
            match error {
                units::Error::InvalidDatabase => Class::UnitsInvalidDatabase,
                units::Error::Bus(zbus::Error::MethodError(name, ..)) => bus_class(name.as_str()),
                units::Error::Bus(zbus::Error::FDO(error)) => {
                    bus_class(zbus::DBusError::name(error.as_ref()).as_str())
                }
                units::Error::Bus(_) => Class::UnitsBusOther,
                units::Error::Job { result, .. } => match result.as_str() {
                    "failed" => Class::UnitsJobFailed,
                    "timeout" => Class::UnitsJobTimeout,
                    _ => Class::UnitsJobOther,
                },
                units::Error::NotReady("exited") => Class::UnitsNotReadyExited,
                units::Error::NotReady("unit_not_active") => Class::UnitsNotReadyInactive,
                units::Error::NotReady(_) => Class::UnitsNotReady,
                units::Error::StrayProcesses => Class::UnitsStrayProcesses,
                units::Error::Held => Class::UnitsHeld,
                units::Error::NoSlot => Class::UnitsNoSlot,
                units::Error::Refused(_) => Class::UnitsRefused,
                units::Error::Io(error) => io_class(error),
                units::Error::Unexpected(_) => Class::UnitsUnexpected,
            }
        } else if let Some(error) = error.downcast_ref::<storage::Error>() {
            match error {
                storage::Error::Io(error) => io_class(error),
                storage::Error::Command { program, code, .. } => {
                    report.program = Program::named(program);
                    report.exit_code = u8::try_from(*code).ok();
                    if *code < 0 {
                        Class::StorageCommandSignaled
                    } else {
                        Class::StorageCommandFailed
                    }
                }
                storage::Error::NeedsRepair => Class::StorageNeedsRepair,
                storage::Error::NoRoom(_) => Class::StorageNoRoom,
                storage::Error::LogicalCap { .. } => Class::StorageLogicalCap,
                storage::Error::Missing => Class::StorageMissing,
                storage::Error::Busy | storage::Error::Mounted => Class::StorageBusy,
                storage::Error::OtherGeneration => Class::StorageOtherGeneration,
                storage::Error::Fsck(code) => {
                    report.program = Some(Program::E2fsck);
                    report.exit_code = u8::try_from(*code).ok();
                    Class::StorageFsckFailed
                }
                _ => Class::StorageOther,
            }
        } else if let Some(error) = error.downcast_ref::<tokio_postgres::Error>() {
            match error.code().map(|state| state.code()) {
                Some("28P01") => Class::PostgresAuthentication,
                Some("53200") => Class::PostgresOutOfMemory,
                Some("53100") => Class::PostgresDiskFull,
                Some("53300") => Class::PostgresTooManyConnections,
                _ if error.is_closed() => Class::PostgresClosed,
                _ => Class::PostgresOther,
            }
        } else {
            Class::Other
        };
        report
    }
    pub fn for_cli(error: &Error) -> Self {
        error
            .downcast_ref::<Self>()
            .copied()
            .unwrap_or_else(|| Self::fixed(Stage::ChildReport, Class::Other))
    }
    pub fn json(&self) -> String {
        serde_json::to_string(self).expect("closed health report serializes")
    }
}
impl fmt::Display for Failure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("the health check failed; see its stage and class")
    }
}
impl std::error::Error for Failure {}

pub fn at(stage: Stage, error: impl Into<Error>) -> Error {
    Box::new(Failure::from_error(stage, &error.into()))
}
pub fn invariant(stage: Stage) -> Error {
    Box::new(Failure::fixed(stage, Class::Invariant))
}
fn io_class(error: &io::Error) -> Class {
    match error.kind() {
        io::ErrorKind::NotFound => Class::IoNotFound,
        io::ErrorKind::PermissionDenied => Class::IoPermissionDenied,
        io::ErrorKind::ConnectionRefused => Class::IoConnectionRefused,
        io::ErrorKind::ConnectionReset => Class::IoConnectionReset,
        io::ErrorKind::BrokenPipe => Class::IoBrokenPipe,
        io::ErrorKind::TimedOut => Class::IoTimedOut,
        io::ErrorKind::UnexpectedEof => Class::IoUnexpectedEof,
        io::ErrorKind::OutOfMemory => Class::IoOutOfMemory,
        _ => Class::IoOther,
    }
}
fn bus_class(name: &str) -> Class {
    match name {
        "org.freedesktop.DBus.Error.LimitsExceeded" => Class::UnitsBusLimitsExceeded,
        "org.freedesktop.DBus.Error.NoReply" => Class::UnitsBusNoReply,
        _ => Class::UnitsBusOther,
    }
}

/// Only this closed DTO crosses from the check child into the service's journal.
/// Old, malformed, oversized or signaled output is never treated as error text.
pub fn child_failure_event(output: &Output) -> Value {
    let report = (output.stdout.len() <= 512)
        .then(|| serde_json::from_slice::<Failure>(&output.stdout).ok())
        .flatten()
        .unwrap_or_else(|| Failure::fixed(Stage::ChildReport, Class::ChildReportUnavailable));
    let mut event = serde_json::to_value(report).expect("closed health report serializes");
    event["event"] = json!("health_check_failed");
    // The process's exit and a storage command's exit are different facts.
    if let Some(code) = output
        .status
        .code()
        .and_then(|code| u8::try_from(code).ok())
    {
        event["exit_class"] = json!("exited");
        event["child_exit_code"] = json!(code);
    } else {
        #[cfg(unix)]
        {
            use std::os::unix::process::ExitStatusExt;
            if let Some(signal) = output
                .status
                .signal()
                .and_then(|signal| u8::try_from(signal).ok())
            {
                event["exit_class"] = json!("signaled");
                event["signal"] = json!(signal);
            } else {
                event["exit_class"] = json!("unknown");
            }
        }
        #[cfg(not(unix))]
        {
            event["exit_class"] = json!("unknown");
        }
    }
    event
}
pub fn spawn_failure_event(error: &io::Error) -> Value {
    let mut event = serde_json::to_value(Failure::from_io(Stage::ChildSpawn, error))
        .expect("closed health report serializes");
    event["event"] = json!("health_check_failed");
    event["exit_class"] = json!("not_started");
    event
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{io, os::unix::process::ExitStatusExt, process::Output};

    #[test]
    fn typed_failure_and_cli_output_never_render_private_cause_text() {
        let private = format!("postgres://app:{}@private.invalid/db", "opaque-credential");
        let io: crate::Error =
            io::Error::new(io::ErrorKind::PermissionDenied, private.clone()).into();
        let failure = Failure::from_error(Stage::SettingsWrite, &io);
        assert_eq!(failure.class, Class::IoPermissionDenied);
        assert_eq!(failure.stage, Stage::SettingsWrite);
        assert!(!failure.json().contains(&private));
        assert!(!Failure::for_cli(&io).json().contains(&private));

        let unit: crate::Error = crate::units::Error::Job {
            unit: private.clone(),
            result: private.clone(),
        }
        .into();
        assert_eq!(
            Failure::from_error(Stage::SlotExec, &unit).class,
            Class::UnitsJobOther
        );
        let storage: crate::Error = crate::storage::Error::Command {
            program: private.clone(),
            code: 23,
            stderr: private.clone(),
        }
        .into();
        let command = Failure::from_error(Stage::VolumeCreate, &storage);
        assert_eq!(command.class, Class::StorageCommandFailed);
        assert_eq!(command.program, None);
        assert_eq!(command.exit_code, Some(23));
        assert!(!command.json().contains(&private));
    }

    #[test]
    fn child_boundary_keeps_only_closed_reports_and_never_raw_streams() {
        let private = format!(
            "{} {}",
            "opaque-credential", "postgres://private.invalid/db"
        );
        let valid = Failure::fixed(Stage::SlotExec, Class::UnitsNoSlot);
        let mut output = Output {
            status: std::process::ExitStatus::from_raw(1 << 8),
            stdout: valid.json().into_bytes(),
            stderr: private.as_bytes().to_vec(),
        };
        let kept = child_failure_event(&output);
        assert_eq!(kept["stage"], "slot_exec");
        assert_eq!(kept["class"], "units_no_slot");
        assert_eq!(kept["child_exit_code"], 1);
        assert!(!kept.to_string().contains(&private));

        output.stdout = format!(
            "{{\"stage\":\"slot_exec\",\"class\":\"units_no_slot\",\"stderr\":\"{private}\"}}"
        )
        .into_bytes();
        let refused = child_failure_event(&output);
        assert_eq!(refused["class"], "child_report_unavailable");
        assert!(!refused.to_string().contains("private.invalid"));
        output.stdout = private.as_bytes().to_vec();
        assert_eq!(
            child_failure_event(&output)["class"],
            "child_report_unavailable"
        );
        output.status = std::process::ExitStatus::from_raw(9);
        let killed = child_failure_event(&output);
        assert_eq!(killed["exit_class"], "signaled");
        assert_eq!(killed["signal"], 9);
        assert!(!killed.to_string().contains("opaque-credential"));
    }
}
