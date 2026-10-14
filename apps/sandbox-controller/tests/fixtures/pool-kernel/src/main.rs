// SPDX-License-Identifier: Apache-2.0
#[path = "../../../../src/pool_device.rs"]
mod pool_device;
#[path = "../../../../src/pool_gate.rs"]
mod pool_gate;
#[path = "../../../../src/pool_journal.rs"]
mod pool_journal;
#[path = "../../../../src/pool_mount.rs"]
mod pool_mount;
#[allow(dead_code)]
#[path = "../../../../src/pool_namespaces.rs"]
mod pool_namespaces;

fn main() {
    let args = std::env::args().collect::<Vec<_>>();
    if args.len() == 4 && args[1] == "--detach-crash" {
        let identity = pool_mount::MountIdentity {
            device: args[2].parse().unwrap(),
            mount_id: args[3].parse().unwrap(),
        };
        pool_mount::MountedAnchor::open(std::path::Path::new("/tmp/pgcf-a8/anchor"))
            .unwrap()
            .detach_in_one_shot(identity)
            .unwrap();
        // Deliberately die after the real syscall and before any durable completion write.
        unsafe { libc::_exit(73) }
    }
    if args.len() == 6 && args[1] == "--zero-suspended" {
        let before = pool_device::thin_metadata(&args[2], &args[3], "volume", &args[4]).unwrap();
        let zero = pool_device::zero_thin(
            &args[2],
            &args[3],
            "volume",
            &args[4],
            args[5].parse().unwrap(),
        )
        .unwrap();
        assert!(before.suspended);
        assert_eq!(before.open_count, 0);
        assert_eq!(before.logical_size_bytes, 32 * 1024 * 1024);
        assert!(zero.still_zero().unwrap());
        let after = pool_device::thin_metadata(&args[2], &args[3], "volume", &args[4]).unwrap();
        assert!(after.suspended);
        assert_eq!(after.device, before.device);
        assert_eq!(after.logical_size_bytes, before.logical_size_bytes);
        assert_eq!(after.open_count, 0);
        println!("actual_suspended_readonly_metadata_dm0=true device_remained_suspended=true");
        return;
    }
    if args.len() == 6 && args[1] == "--blocked-read-status" {
        let m = pool_device::thin_metadata(&args[2], &args[3], "volume", &args[4]).unwrap();
        assert_eq!(m.thin_id, args[5].parse::<u32>().unwrap());
        assert!(m.suspended);
        println!("owned_dm_suspended_actual_open_count={}", m.open_count);
        return;
    }
    if args.len() == 3 && args[1] == "--blocked-read-unmount" {
        blocked_read_unmount(&args[2]);
        return;
    }
    if args.len() == 8 && args[1] == "--blocked-read-mount" {
        blocked_read_mount(&args);
        return;
    }
    if args.len() == 4 && args[1] == "--publisher" {
        publisher(&args[2], &args[3]);
        return;
    }
    if args.len() == 5 && args[1] == "--claimer" {
        claimer(&args[2], &args[3], &args[4]);
        return;
    }
    assert!([4, 6].contains(&args.len()));

    if args[1] == "--holder" {
        unsafe { libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) };
        let file = std::fs::File::open("/tmp/pgcf-a8/anchor/data/owned-marker").unwrap();
        std::env::set_current_dir("/tmp/pgcf-a8/anchor/data").unwrap();
        std::fs::write("/tmp/pgcf-a8/holder-ready", b"ready").unwrap();
        std::thread::sleep(std::time::Duration::from_secs(30));
        drop(file);
        return;
    }
    assert!(args[1].starts_with("/dev/mapper/pgcf_a8_"));
    assert!(
        pool_namespaces::eligible().is_err(),
        "an unsupported kernel or container PID namespace cannot provide the qualified census"
    );
    use std::os::unix::fs::MetadataExt;
    assert_ne!(
        std::fs::metadata("/proc/self/ns/pid").unwrap().ino(),
        0xefff_fffcu64
    );
    println!(
        "unsupported_kernel_or_noninitial_context_refused=true actual_noninitial_pid_namespace_measured=true"
    );
    let device_proof = pool_device::Device::verify(
        &args[2],
        &args[3],
        "volume",
        if args.len() == 6 {
            pool_device::Backend::Thin {
                pool_uuid: args[4].clone(),
                thin_id: args[5].parse().unwrap(),
            }
        } else {
            pool_device::Backend::Linear
        },
    )
    .unwrap();
    if args.len() == 6 {
        let id = args[5].parse::<u32>().unwrap();
        let observed = pool_device::thin_metadata(&args[2], &args[3], "volume", &args[4]).unwrap();
        assert_eq!(observed.thin_id, id);
        assert_eq!(observed.device, device_proof.device());
        assert_eq!(observed.open_count, 0);
        assert!(!observed.suspended && !observed.read_only);
        assert!(
            pool_device::Device::verify(
                &args[2],
                &args[3],
                "volume",
                pool_device::Backend::Thin {
                    pool_uuid: args[4].clone(),
                    thin_id: id + 1
                }
            )
            .is_err()
        );
        assert!(
            pool_device::Device::verify(
                &args[2],
                &args[3],
                "volume",
                pool_device::Backend::Thin {
                    pool_uuid: args[3].clone(),
                    thin_id: id
                }
            )
            .is_err()
        );
        println!("actual_thin_pool_uuid_id_verified=true mismatched_thin_identity_refused=true");
    }
    let (gate_path, record) = process_gate_tests(device_proof.uuid());
    let gate = pool_gate::GateRoot::open(&gate_path).unwrap();
    let mut locked = gate.lock("volume").unwrap();
    locked.claim(&record).unwrap();
    let uuid = std::fs::read_to_string("/proc/sys/kernel/random/uuid")
        .unwrap()
        .trim()
        .to_owned();
    let mut journal_state = pool_journal::State {
        v: 1,
        record: record.clone(),
        binding_id: uuid.clone(),
        node_uid: uuid.clone(),
        boot_id: std::fs::read_to_string("/proc/sys/kernel/random/boot_id")
            .unwrap()
            .trim()
            .to_owned(),
        pool_pod_uid: uuid,
        container_ids: vec!["a".repeat(64)],
        phase: pool_journal::Phase::Prepared,
        ever_attached: false,
        device: device_proof.device(),
        mount_id: None,
        authority_revision: 1,
        storage_authority: None,
        scope: None,
        io_attestation: None,
        groups: vec![],
        terminal_report: None,
        terminal_history: vec![],
        terminal_acknowledged: false,
    };
    let journal =
        pool_journal::Journal::open(&gate_path.join(format!("{}.state", "a".repeat(64)))).unwrap();
    journal.store(&journal_state).unwrap();
    journal_state = journal_state.dispatch_mount().unwrap();
    journal.store(&journal_state).unwrap();
    assert!(
        journal.read().unwrap().unwrap().dispatch_mount().is_err(),
        "durable dispatched mount never becomes replayable on re-entry"
    );
    println!(
        "actual_device_descriptor_flags={} expected_opath={}",
        unsafe {
            libc::fcntl(
                std::os::fd::AsRawFd::as_raw_fd(device_proof.descriptor()),
                libc::F_GETFL,
            )
        },
        libc::O_PATH
    );
    assert_eq!(device_proof.open_count().unwrap(), 0);
    println!("actual_prebind_dm_open_count=0");
    let zero_before = device_proof.zero().unwrap();
    let device = device_proof.descriptor();
    assert_eq!(pool_gate::ROOT, "/var/lib/kubelet/pgcf-pool-gates");
    let anchor = pool_mount::DataAnchor::open(std::path::Path::new("/tmp/pgcf-a8/anchor")).unwrap();
    let made = pool_mount::Ext4Creation::exclusive(device).unwrap();
    let dev = made.attach(&anchor).unwrap();
    journal_state = journal_state.mounted(dev).unwrap();
    journal.store(&journal_state).unwrap();
    let mut erased = journal_state.clone();
    erased.ever_attached = false;
    assert!(
        journal.store(&erased).is_err(),
        "mounted history cannot be erased"
    );
    let existing = pool_mount::Ext4Creation::exclusive(device).err().unwrap();
    assert_eq!(existing.raw_os_error(), Some(libc::EBUSY));
    println!("actual_create_exclusive_existing_errno=16");
    assert_eq!(dev.device, device_proof.device());
    assert!(
        locked.release_zero(&record, &zero_before).is_err(),
        "stale zero token cannot clear mounted custody"
    );
    std::fs::write(
        "/tmp/pgcf-a8/anchor/data/owned-marker",
        b"actual ext4 content",
    )
    .unwrap();
    std::fs::create_dir("/tmp/pgcf-a8/anchor/data/pgdata").unwrap();
    std::fs::write(
        "/tmp/pgcf-a8/anchor/data/pgdata/read-only-marker",
        b"actual read-only fixture",
    )
    .unwrap();
    assert_eq!(
        std::fs::read("/tmp/pgcf-a8/anchor/data/owned-marker").unwrap(),
        b"actual ext4 content"
    );
    let mut holder = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--holder", "unused", "unused"])
        .spawn()
        .unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while !std::path::Path::new("/tmp/pgcf-a8/holder-ready").exists() {
        assert!(std::time::Instant::now() < deadline);
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    assert!(
        anchor
            .detach_in_one_shot(pool_mount::MountIdentity {
                device: dev.device,
                mount_id: dev.mount_id + 1
            })
            .is_err()
    );
    let error = anchor.detach_in_one_shot(dev).unwrap_err();
    assert_eq!(error.raw_os_error(), Some(libc::EBUSY));
    assert_eq!(
        std::fs::read("/tmp/pgcf-a8/anchor/data/owned-marker").unwrap(),
        b"actual ext4 content"
    );
    holder.kill().unwrap();
    holder.wait().unwrap();
    let recovered =
        pool_mount::MountedAnchor::open(std::path::Path::new("/tmp/pgcf-a8/anchor")).unwrap();
    assert_eq!(recovered.identity().unwrap(), dev);
    recovered.detach_in_one_shot(dev).unwrap();
    println!("actual_existing_mount_reentry_nonlazy_detach=true");
    assert!(!std::path::Path::new("/tmp/pgcf-a8/anchor/data/owned-marker").exists());
    assert_eq!(device_proof.open_count().unwrap(), 0);
    {
        let probe = pool_mount::Ext4ReadOnly::exclusive_noload(device).unwrap();
        let data = probe.pgdata().unwrap();
        use std::os::fd::AsRawFd;
        assert_eq!(
            std::fs::read(format!(
                "/proc/self/fd/{}/read-only-marker",
                data.as_raw_fd()
            ))
            .unwrap(),
            b"actual read-only fixture"
        );
        let result = unsafe {
            libc::openat(
                data.as_raw_fd(),
                c"forbidden-write".as_ptr(),
                libc::O_CREAT | libc::O_WRONLY | libc::O_CLOEXEC,
                0o600,
            )
        };
        assert_eq!(result, -1);
        assert_eq!(
            std::io::Error::last_os_error().raw_os_error(),
            Some(libc::EROFS)
        );
        assert_eq!(device_proof.open_count().unwrap(), 1);
        drop(data);
        drop(probe);
    }
    assert_eq!(device_proof.open_count().unwrap(), 0);
    println!(
        "actual_prewake_readonly_noload_descriptor_read=true actual_write_errno=30 all_creation_refs_closed_dm0=true"
    );
    assert!(pool_mount::DataAnchor::for_pod("../wrong").is_err());
    std::fs::set_permissions(
        "/tmp/pgcf-a8/anchor",
        std::os::unix::fs::PermissionsExt::from_mode(0o777),
    )
    .unwrap();
    assert!(pool_mount::DataAnchor::open(std::path::Path::new("/tmp/pgcf-a8/anchor")).is_err());
    std::fs::set_permissions(
        "/tmp/pgcf-a8/anchor",
        std::os::unix::fs::PermissionsExt::from_mode(0o755),
    )
    .unwrap();
    let again = pool_mount::DataAnchor::open(std::path::Path::new("/tmp/pgcf-a8/anchor")).unwrap();
    let same = pool_mount::Ext4Creation::exclusive(device)
        .unwrap()
        .attach(&again)
        .unwrap();
    assert_eq!(same.device, dev.device);
    assert_ne!(same.mount_id, dev.mount_id);
    assert_eq!(
        std::fs::read("/tmp/pgcf-a8/anchor/data/owned-marker").unwrap(),
        b"actual ext4 content"
    );
    journal_state = journal_state.dispatch_detach().unwrap();
    journal.store(&journal_state).unwrap();
    let crashed = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--detach-crash",
            &same.device.to_string(),
            &same.mount_id.to_string(),
        ])
        .status()
        .unwrap();
    assert_eq!(crashed.code(), Some(73));
    let durable = journal.read().unwrap().unwrap();
    assert_eq!(durable.phase, pool_journal::Phase::DetachDispatched);
    assert!(durable.terminal_report.is_none());
    assert!(!durable.terminal_acknowledged);
    assert!(durable.dispatch_mount().is_err());
    assert!(!locked.publish_allowed().unwrap());
    let zero = device_proof.zero().unwrap();
    assert!(zero.still_zero().unwrap());
    println!(
        "actual_crash_after_nonlazy_unmount_before_journal=true original_dispatch_and_deny_retained=true actual_worker_reaped=true actual_global_dm0=true"
    );
    journal_state = journal_state.detached(&zero).unwrap();
    journal.store(&journal_state).unwrap();
    assert!(
        journal.read().unwrap().unwrap().dispatch_mount().is_err(),
        "released intent cannot grant a new mount"
    );
    locked.release_zero(&record, &zero).unwrap();
    assert!(locked.publish_allowed().unwrap());
    drop(locked);
    println!(
        "production_descriptor_attach=true real_busy_refused=true normal_unmount=true owned_content_preserved=true failed_teardown_mode_refused=true"
    );
    println!("actual_durable_mount_reentry_no_replay=true mounted_history_retained=true");
}

fn process_gate_tests(uuid: &str) -> (std::path::PathBuf, pool_gate::Record) {
    use std::os::unix::fs::PermissionsExt;
    let path = std::path::PathBuf::from("/tmp/pgcf-a8/gates");
    std::fs::create_dir(&path).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
    let record = pool_gate::Record::new("volume", &"a".repeat(64), uuid).unwrap();
    let gate = pool_gate::GateRoot::open(&path).unwrap();
    let mut owner = gate.lock("volume").unwrap();
    let mut child = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--publisher", path.to_str().unwrap(), "volume"])
        .spawn()
        .unwrap();
    wait(&path.join("queued"));
    owner.claim(&record).unwrap();
    drop(owner);
    assert!(child.wait().unwrap().success());
    // A separately owned process really dies while holding the lock. Denial must survive it.
    let mut child = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--claimer", path.to_str().unwrap(), "volume", uuid])
        .spawn()
        .unwrap();
    wait(&path.join("claimed"));
    child.kill().unwrap();
    child.wait().unwrap();
    let recovered = gate.lock("volume").unwrap();
    assert!(!recovered.publish_allowed().unwrap());
    drop(recovered);
    println!("queued_publish_refused=true real_agent_sigkill_denial_survived=true");
    (path, record)
}
fn wait(path: &std::path::Path) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while !path.exists() {
        assert!(std::time::Instant::now() < deadline);
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
}
fn publisher(path: &str, handle: &str) {
    std::fs::write(std::path::Path::new(path).join("queued"), b"ready").unwrap();
    let gate = pool_gate::GateRoot::open(std::path::Path::new(path)).unwrap();
    let lock = gate.lock(handle).unwrap();
    assert!(!lock.publish_allowed().unwrap());
}
fn claimer(path: &str, handle: &str, uuid: &str) {
    unsafe { libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) };
    let gate = pool_gate::GateRoot::open(std::path::Path::new(path)).unwrap();
    let mut lock = gate.lock(handle).unwrap();
    lock.claim(&pool_gate::Record::new(handle, &"a".repeat(64), uuid).unwrap())
        .unwrap();
    std::fs::write(std::path::Path::new(path).join("claimed"), b"ready").unwrap();
    std::thread::sleep(std::time::Duration::from_secs(30));
}

// Explicit fixture only: this moves one OWNED readonly mount into the exact reader's namespace.
fn blocked_read_mount(args: &[String]) {
    use std::os::{
        fd::{AsRawFd, FromRawFd},
        unix::fs::MetadataExt,
    };
    let pid = args[2].parse::<u32>().unwrap();
    assert!(pid > 1);
    let own = std::fs::metadata("/fixture").unwrap();
    let target = std::fs::metadata(format!("/proc/{pid}/root/fixture")).unwrap();
    assert_eq!((own.dev(), own.ino()), (target.dev(), target.ino()));
    assert_eq!(own.uid(), 26);
    assert_eq!(own.mode() & 0o7777, 0o700);
    let before = std::fs::read_to_string(format!("/proc/{pid}/stat")).unwrap();
    let ticks = before
        .rsplit_once(") ")
        .unwrap()
        .1
        .split_whitespace()
        .nth(19)
        .unwrap()
        .to_owned();
    let ns = std::fs::File::open(format!("/proc/{pid}/ns/mnt")).unwrap();
    let root = std::fs::File::open(format!("/proc/{pid}/root")).unwrap();
    let device = pool_device::Device::verify(
        &args[4],
        &args[5],
        "volume",
        pool_device::Backend::Thin {
            pool_uuid: args[6].clone(),
            thin_id: args[7].parse().unwrap(),
        },
    )
    .unwrap();
    assert!(args[3].starts_with("/dev/mapper/pgcf_a8_"));
    assert_eq!(std::fs::metadata(&args[3]).unwrap().rdev(), device.device());
    assert_eq!(device.open_count().unwrap(), 0);
    let source =
        std::ffi::CString::new(format!("/proc/self/fd/{}", device.descriptor().as_raw_fd()))
            .unwrap();
    assert_eq!(
        unsafe {
            libc::mount(
                source.as_ptr(),
                c"/tmp/pgcf-a8/readonly".as_ptr(),
                c"ext4".as_ptr(),
                libc::MS_RDONLY | libc::MS_NOSUID | libc::MS_NODEV | libc::MS_NOEXEC,
                c"noload".as_ptr().cast(),
            )
        },
        0
    );
    let fd = unsafe {
        libc::syscall(
            libc::SYS_open_tree,
            libc::AT_FDCWD,
            c"/tmp/pgcf-a8/readonly".as_ptr(),
            libc::O_CLOEXEC | 1,
        )
    };
    assert!(fd >= 0);
    let mount = unsafe { std::os::fd::OwnedFd::from_raw_fd(fd as i32) };
    let after = std::fs::read_to_string(format!("/proc/{pid}/stat")).unwrap();
    assert_eq!(
        after
            .rsplit_once(") ")
            .unwrap()
            .1
            .split_whitespace()
            .nth(19)
            .unwrap(),
        ticks
    );
    assert_eq!(unsafe { libc::setns(ns.as_raw_fd(), libc::CLONE_NEWNS) }, 0);
    assert_eq!(unsafe { libc::fchdir(root.as_raw_fd()) }, 0);
    assert_eq!(unsafe { libc::chroot(c".".as_ptr()) }, 0);
    std::env::set_current_dir("/").unwrap();
    let path = std::ffi::CString::new("/fixture/readonly").unwrap();
    let fd = unsafe {
        libc::open(
            path.as_ptr(),
            libc::O_PATH | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    assert!(fd >= 0);
    let target = unsafe { std::os::fd::OwnedFd::from_raw_fd(fd) };
    assert_eq!(
        unsafe {
            libc::syscall(
                libc::SYS_move_mount,
                mount.as_raw_fd(),
                c"".as_ptr(),
                target.as_raw_fd(),
                c"".as_ptr(),
                0x04 | 0x40,
            )
        },
        0
    );
    drop(target);
    drop(mount);
    println!("owned_readonly_mount_moved_to_exact_reader_namespace=true");
}

fn blocked_read_unmount(raw: &str) {
    use std::os::{fd::AsRawFd, unix::fs::MetadataExt};
    let pid = raw.parse::<u32>().unwrap();
    assert!(pid > 1);
    let own = std::fs::metadata("/fixture").unwrap();
    let target = std::fs::metadata(format!("/proc/{pid}/root/fixture")).unwrap();
    assert_eq!((own.dev(), own.ino()), (target.dev(), target.ino()));
    assert!(std::path::Path::new("/fixture/reaped").is_file());
    let ns = std::fs::File::open(format!("/proc/{pid}/ns/mnt")).unwrap();
    let root = std::fs::File::open(format!("/proc/{pid}/root")).unwrap();
    let meta = std::fs::metadata(format!("/proc/{pid}/root/fixture/readonly")).unwrap();
    let name = std::fs::read_to_string(format!(
        "/sys/dev/block/{}:{}/dm/name",
        libc::major(meta.dev()),
        libc::minor(meta.dev())
    ))
    .unwrap();
    assert!(name.trim().starts_with("pgcf_a8_") && name.trim().ends_with("-volume"));
    assert_eq!(unsafe { libc::setns(ns.as_raw_fd(), libc::CLONE_NEWNS) }, 0);
    assert_eq!(unsafe { libc::fchdir(root.as_raw_fd()) }, 0);
    assert_eq!(unsafe { libc::chroot(c".".as_ptr()) }, 0);
    std::env::set_current_dir("/").unwrap();
    assert_eq!(
        unsafe { libc::umount2(c"/fixture/readonly".as_ptr(), libc::UMOUNT_NOFOLLOW) },
        0
    );
    println!("owned_reader_normal_unmount_verified=true");
}
