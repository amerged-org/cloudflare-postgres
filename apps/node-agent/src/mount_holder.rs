// SPDX-License-Identifier: Apache-2.0
//! The mount namespace of the agent's volumes outlives the agent (found live on EU1, 2026-10-23).
//!
//! The agent mounts the volume of every database it knows in a mount namespace of its own, so
//! that the mounts stay out of PID 1's (the image's README). A process that dies leaves its mount
//! namespace, and the kernel unmounts what it holds one after the other, each as slow as the disk's
//! flushes: 312 volumes took 14 s after a `kill -9` of the agent (lab, 300 volumes on a disk with
//! 10 ms flushes: 13 to 21 s). The process is not gone until it has, systemd starts the next agent
//! only then, and the node answers no wake meanwhile. The graceful exit unmounts 16 at a time
//! (`Storage::unmount_all`), which a kill leaves no time for.
//!
//! So the namespace is held by a process that is not the agent: `pgcf-agent hold`, the one process
//! of the transient unit `pgcf-mounts.service` (`PrivateMounts=yes`, the setting the agent's own
//! unit has). The agent starts the unit if the node has none (once a boot) and joins its namespace
//! with `setns(2)` before it starts any thread. A killed agent then leaves nothing to unmount (lab:
//! 11 ms against 13 to 21 s), the volumes stay mounted and their page cache stays, and the next
//! agent finds them where they were, joins in 12 ms and mounts nothing at its start. The holder
//! unmounts them 16 at a time when it is stopped (a shutdown, `systemctl stop pgcf-mounts`).
//!
//! Where the namespace cannot be joined (no systemd, the unit does not start, `setns` is refused)
//! the agent runs in the namespace its own unit gave it, as it did before, and says so
//! (`mount_holder_unavailable`): its exit then unmounts the volumes itself.
// `pgcf_slot_lab` is set by RUSTFLAGS, not declared in the manifest.
#![allow(unexpected_cfgs)]
use crate::{Error, layout::Layout, notify::notify, storage};
use std::{
    fs::{self, File},
    os::fd::AsRawFd,
    path::Path,
    process::{Command, Stdio},
    sync::atomic::{AtomicBool, Ordering},
};

/// The unit that holds the namespace.
pub const UNIT: &str = "pgcf-mounts.service";

/// Whether this process joined the holder's namespace, so that its mounts outlive it.
static HELD: AtomicBool = AtomicBool::new(false);
pub fn held() -> bool {
    HELD.load(Ordering::Relaxed)
}

/// The words of the command that starts the holder: a transient `Type=notify` service in a mount
/// namespace of its own, which systemd removes again when it ends (`--collect`), running
/// `<agent> hold`. `systemd-run` returns when the holder has told systemd that it is ready.
pub fn start_words(systemd_run: &Path, agent: &Path) -> Vec<String> {
    let mut words: Vec<String> = [
        &*systemd_run.to_string_lossy(),
        "--quiet",
        "--collect",
        "--unit",
        UNIT,
        "--description",
        "PGCF mount namespace of the node agent's volumes",
        "--property",
        "Type=notify",
        "--property",
        "PrivateMounts=yes",
        "--property",
        "OOMScoreAdjust=-900",
        "--",
    ]
    .iter()
    .map(|word| word.to_string())
    .collect();
    words.push(agent.to_string_lossy().into_owned());
    words.push("hold".into());
    words
}

/// The main process of the unit from `systemctl show --property=MainPID --value`: `None` when the
/// unit has none (`0`) or the answer is no number.
pub fn parse_main_pid(output: &str) -> Option<u32> {
    output.trim().parse().ok().filter(|pid| *pid > 0)
}

/// Why the namespace was not joined: a class for the event, never the text of an error.
type Unavailable = &'static str;

fn holder_pid() -> Result<Option<u32>, Unavailable> {
    let output = Command::new("systemctl")
        .args(["show", "--property=MainPID", "--value", UNIT])
        .stdin(Stdio::null())
        .output()
        .map_err(|_| "systemctl_not_run")?;
    Ok(output
        .status
        .success()
        .then(|| parse_main_pid(&String::from_utf8_lossy(&output.stdout)))
        .flatten())
}

/// The pid of the holder, started if the node has none.
pub fn ensure(layout: &Layout, agent: &Path) -> Result<u32, Unavailable> {
    if let Some(pid) = holder_pid()? {
        return Ok(pid);
    }
    let words = start_words(&layout.systemd_run, agent);
    let started = Command::new(&words[0])
        .args(&words[1..])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|_| "systemd_run_not_run")?;
    // A unit that was started by something else between the two reads is the holder all the same.
    match holder_pid()? {
        Some(pid) => Ok(pid),
        None if started.success() => Err("holder_has_no_process"),
        None => Err("holder_not_started"),
    }
}

/// The two `ns/mnt` links of `/proc`: whether they name one namespace.
fn same_namespace(a: &Path, b: &Path) -> bool {
    matches!((fs::read_link(a), fs::read_link(b)), (Ok(a), Ok(b)) if a == b)
}

/// Joins the mount namespace of process `pid`. The kernel refuses it (`EINVAL`) in a process with
/// more than one thread, so this runs before the runtime starts.
fn enter(pid: u32) -> Result<(), Unavailable> {
    let target = format!("/proc/{pid}/ns/mnt");
    // Never PID 1's: a holder without its own namespace would mount the volumes there.
    if same_namespace(Path::new(&target), Path::new("/proc/1/ns/mnt")) {
        return Err("holder_in_init_namespace");
    }
    if same_namespace(Path::new(&target), Path::new("/proc/self/ns/mnt")) {
        return Ok(());
    }
    let namespace = File::open(&target).map_err(|_| "namespace_unreadable")?;
    // SAFETY: `setns` reads a descriptor this function owns and changes only the calling process's
    // mount namespace.
    if unsafe { libc::setns(namespace.as_raw_fd(), libc::CLONE_NEWNS) } != 0 {
        return Err("setns_refused");
    }
    // The working directory belongs to the namespace that was left.
    std::env::set_current_dir("/").map_err(|_| "chdir_failed")?;
    Ok(())
}

/// Joins the holder's namespace, before any thread exists. `Ok(pid)` of the holder; the reason
/// otherwise, and the process stays in the namespace its unit gave it.
pub fn join(layout: &Layout, agent: &Path) -> Result<u32, Unavailable> {
    let pid = ensure(layout, agent)?;
    enter(pid)?;
    HELD.store(true, Ordering::Relaxed);
    Ok(pid)
}

/// `pgcf-agent hold`: tells systemd that the namespace exists, and waits to be stopped. It then
/// unmounts the volumes 16 at a time, as the agent's graceful exit does, because the kernel would
/// unmount them one by one when the namespace ends with this process.
pub async fn hold() -> Result<(), Error> {
    use tokio::signal::unix::{SignalKind, signal};
    let mut terminate = signal(SignalKind::terminate())?;
    let mut interrupt = signal(SignalKind::interrupt())?;
    notify("READY=1")?;
    tokio::select! {
        _ = terminate.recv() => {}
        _ = interrupt.recv() => {}
    }
    tokio::task::spawn_blocking(|| {
        storage::Storage::new(storage::SystemRunner, storage::Config::default()).unmount_all()
    })
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_holder_is_a_notifying_transient_unit_in_a_private_mount_namespace() {
        let words = start_words(
            Path::new("/usr/bin/systemd-run"),
            Path::new("/var/lib/pgcf/bin/current/pgcf-agent"),
        );
        let line = words.join(" ");
        assert_eq!(words[0], "/usr/bin/systemd-run");
        for part in [
            "--unit pgcf-mounts.service",
            "--collect",
            "--property Type=notify",
            "--property PrivateMounts=yes",
        ] {
            assert!(line.contains(part), "{part}: {line}");
        }
        // The agent's own binary through the link of the release that runs, and the one word.
        assert!(
            line.ends_with("-- /var/lib/pgcf/bin/current/pgcf-agent hold"),
            "{line}"
        );
        assert_eq!(UNIT, "pgcf-mounts.service");
    }

    #[test]
    fn the_main_process_of_a_unit_is_a_positive_number() {
        assert_eq!(parse_main_pid("4242\n"), Some(4242));
        assert_eq!(parse_main_pid(" 7 "), Some(7));
        for other in ["0\n", "", "\n", "n/a", "-1", "12 34", "4242abc"] {
            assert_eq!(parse_main_pid(other), None, "{other:?}");
        }
    }

    #[test]
    fn a_namespace_is_the_same_when_both_links_name_it_and_not_when_one_cannot_be_read() {
        let own = Path::new("/proc/self/ns/mnt");
        assert!(same_namespace(own, Path::new("/proc/thread-self/ns/mnt")));
        assert!(!same_namespace(own, Path::new("/proc/0/ns/mnt")));
        assert!(!same_namespace(
            Path::new("/proc/0/ns/mnt"),
            Path::new("/proc/0/ns/mnt")
        ));
    }

    /// A start that fails says why in a class of its own, and the process stays where it is: on a
    /// machine without systemd (this test's) no unit runs and none can be started.
    #[test]
    fn where_the_holder_cannot_be_started_the_process_stays_and_says_why() {
        if matches!(holder_pid(), Ok(Some(_))) {
            return; // a node with a holder: joining is for a process with no threads
        }
        let layout = Layout {
            systemd_run: "/nonexistent/systemd-run".into(),
            ..Layout::default()
        };
        let error = join(&layout, Path::new("/nonexistent/pgcf-agent"));
        assert!(
            matches!(error, Err("systemd_run_not_run" | "systemctl_not_run")),
            "{error:?}"
        );
        assert!(!held());
    }

    /// The holder against a real systemd and a real kernel (the lab of `units/slot_lab.rs`: Debian 13
    /// with systemd as PID 1, root, built with `RUSTFLAGS='--cfg pgcf_slot_lab'`, run with `--ignored
    /// --test-threads=1 mount_holder::lab`). `PGCF_LAB_AGENT` names a `pgcf-agent` binary, which the
    /// holder runs as `pgcf-agent hold`. It makes the unit `pgcf-mounts.service` and one tmpfs below
    /// `/run/pgcf-lab-holder`, and removes them again.
    #[cfg(all(test, pgcf_slot_lab))]
    mod lab {
        use super::*;
        use std::{
            os::unix::process::CommandExt,
            time::{Duration, Instant},
        };

        fn systemctl(args: &[&str]) {
            let _ = Command::new("systemctl")
                .args(args)
                .stderr(Stdio::null())
                .status();
        }
        fn mountinfo(pid: u32) -> String {
            fs::read_to_string(format!("/proc/{pid}/mountinfo")).unwrap()
        }

        /// A process that joined the holder's namespace before it ran: what the agent is.
        fn process_in(holder: u32) -> std::process::Child {
            let mut command = Command::new("sleep");
            command.arg("600");
            // SAFETY: only `open` and `setns`, which are async-signal-safe, run between fork and
            // exec.
            unsafe {
                command.pre_exec(move || {
                    let namespace = File::open(format!("/proc/{holder}/ns/mnt"))?;
                    if libc::setns(namespace.as_raw_fd(), libc::CLONE_NEWNS) != 0 {
                        return Err(std::io::Error::last_os_error());
                    }
                    Ok(())
                });
            }
            command.spawn().unwrap()
        }

        #[test]
        #[ignore = "needs systemd as PID 1, root and a pgcf-agent binary (lab)"]
        fn the_volumes_stay_mounted_when_the_agent_is_killed_and_the_next_agent_finds_them() {
            let Some(agent) = std::env::var_os("PGCF_LAB_AGENT") else {
                eprintln!("skipped: PGCF_LAB_AGENT names no binary");
                return;
            };
            let layout = Layout::default();
            systemctl(&["stop", UNIT]);
            let holder = ensure(&layout, Path::new(&agent)).expect("the holder starts");
            assert_eq!(
                ensure(&layout, Path::new(&agent)),
                Ok(holder),
                "started once"
            );
            let target = format!("/proc/{holder}/ns/mnt");
            assert!(!same_namespace(
                Path::new(&target),
                Path::new("/proc/1/ns/mnt")
            ));

            // A volume of the agent, mounted in the namespace it works in.
            let at = "/run/pgcf-lab-holder/volume";
            let mounted = Command::new("nsenter")
                .args(["--target", &holder.to_string(), "--mount", "sh", "-c"])
                .arg(format!("mkdir -p {at} && mount -t tmpfs tmpfs {at}"))
                .status()
                .unwrap();
            assert!(mounted.success());

            // An agent: a process that joins the namespace before it runs, and is killed.
            let mut agent_process = process_in(holder);
            let pid = agent_process.id();
            assert!(same_namespace(
                Path::new(&format!("/proc/{pid}/ns/mnt")),
                Path::new(&target)
            ));
            assert!(mountinfo(pid).contains(at), "the agent sees the volume");
            let killed = Instant::now();
            agent_process.kill().unwrap();
            agent_process.wait().unwrap();
            // Nothing to unmount at the exit: the namespace stays with the holder.
            assert!(
                killed.elapsed() < Duration::from_secs(1),
                "{:?}",
                killed.elapsed()
            );
            assert!(mountinfo(holder).contains(at), "the volume stays mounted");

            // The next agent finds the holder running and the volume mounted.
            assert_eq!(ensure(&layout, Path::new(&agent)), Ok(holder));
            let mut next = process_in(holder);
            assert!(mountinfo(next.id()).contains(at));
            next.kill().unwrap();
            next.wait().unwrap();

            // Stopped, the holder ends and its namespace with it.
            systemctl(&["stop", UNIT]);
            assert_eq!(holder_pid(), Ok(None));
            let _ = fs::remove_dir_all("/run/pgcf-lab-holder");
        }
    }
}
