// SPDX-License-Identifier: Apache-2.0
use super::*;
use crate::link::test_server::{TempDir, release_vectors, tempdir};
use std::os::unix::fs::symlink;

fn sha(text: &str) -> String {
    crate::update::hex(&Sha256::digest(text.as_bytes()))
}
fn host(path: &str, content: &str, mode: &str, apply: &str) -> HostFile {
    HostFile {
        path: path.into(),
        kind: Kind::File,
        mode: mode.into(),
        sha256: sha(content),
        size_bytes: content.len() as u64,
        apply: apply.into(),
    }
}
fn mask(path: &str, apply: &str) -> HostFile {
    HostFile {
        path: path.into(),
        kind: Kind::Mask,
        mode: String::new(),
        sha256: String::new(),
        size_bytes: 0,
        apply: apply.into(),
    }
}
/// The bytes of the files that have any, by digest, as the agent has fetched them.
fn contents(files: &[(&HostFile, &str)]) -> HashMap<String, Vec<u8>> {
    files
        .iter()
        .map(|(file, text)| (file.sha256.clone(), text.as_bytes().to_vec()))
        .collect()
}
fn never(_: Step) -> io::Result<()> {
    Ok(())
}

const GATEWAY: &str = "/usr/lib/systemd/system/pgcf-gateway.service";
const DATABASE: &str = "/usr/lib/systemd/system/pgcf-pg@.service";
const MASK: &str = "/etc/systemd/system/modprobe@loop.service";
const SYSUSERS: &str = "/usr/lib/sysusers.d/pgcf.conf";

/// A root with the directories the image has, as a node's `/` has them.
fn root() -> TempDir {
    let root = tempdir();
    for directory in strings("HOST_FILE_DIRECTORIES") {
        fs::create_dir_all(root.join(directory.trim_start_matches('/'))).unwrap();
    }
    root
}
fn at(root: &Path, path: &str) -> PathBuf {
    root.join(path.trim_start_matches('/'))
}
fn read(root: &Path, path: &str) -> String {
    fs::read_to_string(at(root, path)).unwrap()
}
fn mode_of(root: &Path, path: &str) -> u32 {
    fs::metadata(at(root, path)).unwrap().permissions().mode() & 0o7777
}
fn hidden_files(root: &Path, directory: &str) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(at(root, directory))
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|name| name.starts_with('.'))
        .collect();
    names.sort();
    names
}

/// The list and the bytes of a release that changes three units, a mask and a file that waits for
/// a reboot, ascending by path.
fn release() -> (Vec<HostFile>, HashMap<String, Vec<u8>>) {
    let sysusers = host(SYSUSERS, "u pgcf-gateway\n", "0644", "reboot");
    let gateway = host(
        GATEWAY,
        "[Service]\n# gateway 2\n",
        "0644",
        "restart_unit:pgcf-gateway.service",
    );
    let database = host(DATABASE, "[Service]\n# database 2\n", "0755", "next_start");
    let files = vec![
        mask(MASK, "daemon_reload"),
        gateway.clone(),
        database.clone(),
        sysusers.clone(),
    ];
    let bytes = contents(&[
        (&sysusers, "u pgcf-gateway\n"),
        (&gateway, "[Service]\n# gateway 2\n"),
        (&database, "[Service]\n# database 2\n"),
    ]);
    assert!(files.windows(2).all(|pair| pair[0].path < pair[1].path));
    (files, bytes)
}
fn apply_all(
    root: &Path,
    state: &Path,
    files: &[HostFile],
    bytes: &HashMap<String, Vec<u8>>,
    boot: &str,
    crash: &mut dyn FnMut(Step) -> io::Result<()>,
) -> io::Result<Applied> {
    let state_now = State::load(state);
    let plan = plan(root, &state_now, files)?;
    let target = Target {
        root,
        state,
        boot_id: boot,
    };
    apply(&target, "r2", files, &plan, bytes, crash)
}

#[test]
fn the_page_of_the_contract_is_read_and_its_lines_are_the_manifests() {
    let vector = &release_vectors()[0];
    let files: Vec<HostFile> = vector["release"]["os"]["host_files"]
        .as_array()
        .unwrap()
        .iter()
        .map(|file| HostFile::parse(file).unwrap())
        .collect();
    assert_eq!(files.len(), 6);
    assert_eq!(check(&files), Ok(()));
    // One line a file in the text the release key signs, in the list's order, after the lock.
    let manifest = vector["manifest"].as_str().unwrap();
    let lines: Vec<&str> = manifest
        .lines()
        .filter(|line| line.starts_with("os.host_file="))
        .collect();
    let ours: Vec<String> = files
        .iter()
        .map(|file| format!("os.host_file={}", file.line()))
        .collect();
    assert_eq!(lines, ours);
    assert_eq!(
        manifest
            .lines()
            .position(|line| line.starts_with("os.host_file=")),
        manifest
            .lines()
            .position(|line| line.starts_with("os.package_lock="))
            .map(|at| at + 1)
    );
    // The digest a node reports for the list is the contract's.
    assert_eq!(
        list_digest(&files),
        vector["host_files_sha256"].as_str().unwrap()
    );
    // Every kind, mode and way to take effect of the vector is one the agent knows.
    assert!(files.iter().any(|file| file.kind == Kind::Mask));
    assert!(files.iter().any(|file| file.apply() == Some(Apply::Reboot)));
    assert!(
        files
            .iter()
            .any(|file| file.apply() == Some(Apply::NextStart))
    );
    assert!(
        files
            .iter()
            .any(|file| file.apply() == Some(Apply::DaemonReload))
    );
    assert!(
        files
            .iter()
            .any(|file| file.apply() == Some(Apply::RestartUnit("pgcf-agent.service")))
    );
    // A page of any other shape is no host file.
    for broken in [
        serde_json::json!({"path": "/etc/sysctl.d/a.conf", "kind": "link", "apply": "reboot"}),
        serde_json::json!({"path": "/etc/sysctl.d/a.conf", "kind": "file", "apply": "reboot", "url": "https://x.example/a"}),
        serde_json::json!({"kind": "file", "apply": "reboot"}),
        serde_json::json!("a path"),
        Value::Null,
    ] {
        assert_eq!(HostFile::parse(&broken), None, "{broken}");
    }
}

#[test]
fn the_classes_of_refusal_are_the_contracts() {
    let theirs: Vec<&str> = strings("RELEASE_REFUSALS").collect();
    for refusal in Refusal::ALL {
        assert!(theirs.contains(&refusal.code()), "{}", refusal.code());
    }
}

#[test]
fn the_agents_own_rules_refuse_what_is_not_a_plain_file_of_an_allowed_directory() {
    let good = |path: &str| host(path, "x", "0644", "daemon_reload");
    let allowed: Vec<&str> = strings("HOST_FILE_DIRECTORIES").collect();
    assert_eq!(allowed.len(), 12);
    for directory in &allowed {
        assert_eq!(
            check(&[good(&format!("{directory}/pgcf.conf"))]),
            Ok(()),
            "{directory}"
        );
    }
    // Traversal, another prefix, a further directory, a hidden name, a name with other symbols.
    for path in [
        "/etc/passwd",
        "/etc/shadow",
        "/usr/bin/pgcf-agent",
        "/var/lib/pgcf/bin/current",
        "/etc/systemd/system",
        "/etc/systemd/system/",
        "/etc/systemd/system/../../passwd",
        "/etc/systemd/system/..",
        "/etc/systemd/system/a/b.service",
        "/etc/systemd/system/x.service.d/override.conf",
        "/etc/systemd/system-generators/systemd-ssh-generator",
        "/etc/systemd/system/.hidden.service",
        "/etc/systemd/system/.a.pgcf-new",
        "/etc/systemd/system/a b.service",
        "/etc/systemd/system/a\nb.service",
        "/etc/systemd/system/a:b.service",
        "/etc/systemd/systemx/a.service",
        "/etc/ssh/principals/root",
        "/etc/nftables.conf",
        "etc/systemd/system/a.service",
        "//etc/systemd/system/a.service",
        "/etc/systemd/system//a.service",
        "",
    ] {
        assert_eq!(check(&[good(path)]), Err(Refusal::Path), "{path:?}");
        assert_eq!(
            check(&[mask(path, "daemon_reload")]),
            Err(Refusal::Path),
            "{path:?}"
        );
    }
    assert_eq!(
        check(&[good(&format!("/etc/sysctl.d/{}", "a".repeat(129)))]),
        Err(Refusal::Path)
    );
    // A mode that is neither of the two.
    for mode in ["0600", "0664", "0777", "4755", "644", "", "0644 "] {
        let mut file = good(GATEWAY);
        file.mode = mode.into();
        assert_eq!(check(&[file]), Err(Refusal::Mode), "{mode:?}");
    }
    // A way to take effect the agent does not know.
    for apply in [
        "",
        "reload",
        "restart",
        "restart_unit:",
        "restart_unit:sshd.service",
        "restart_unit:postgresql.service",
        "restart_unit:pgcf-pg@a.service",
        "DAEMON_RELOAD",
    ] {
        let mut file = good(GATEWAY);
        file.apply = apply.into();
        assert_eq!(check(&[file]), Err(Refusal::Apply), "{apply:?}");
    }
    // The list and its entries.
    let (list, _) = release();
    assert_eq!(check(&list), Ok(()));
    assert_eq!(check(&[]), Err(Refusal::Invalid));
    let mut reversed = list.clone();
    reversed.reverse();
    assert_eq!(check(&reversed), Err(Refusal::Invalid));
    let twice = vec![list[1].clone(), list[1].clone()];
    assert_eq!(check(&twice), Err(Refusal::Invalid));
    let many: Vec<HostFile> = (0..=64)
        .map(|n| good(&format!("/etc/sysctl.d/{n:03}.conf")))
        .collect();
    assert_eq!(check(&many[..64]), Ok(()));
    assert_eq!(check(&many), Err(Refusal::Invalid));
    for change in [
        |file: &mut HostFile| file.sha256 = "A".repeat(64),
        |file: &mut HostFile| file.sha256 = "a".repeat(63),
        |file: &mut HostFile| file.sha256.clear(),
        |file: &mut HostFile| file.size_bytes = 1_048_577,
    ] {
        let mut file = good(GATEWAY);
        change(&mut file);
        assert_eq!(check(&[file]), Err(Refusal::Invalid));
    }
    for change in [
        |file: &mut HostFile| file.mode = "0644".into(),
        |file: &mut HostFile| file.sha256 = "a".repeat(64),
        |file: &mut HostFile| file.size_bytes = 5,
    ] {
        let mut file = mask(MASK, "daemon_reload");
        change(&mut file);
        assert_eq!(check(&[file]), Err(Refusal::Invalid));
    }
}

#[test]
fn a_file_is_written_whole_with_its_mode_and_a_second_apply_changes_nothing() {
    let (root, files) = (root(), release());
    let state = root.join("host-files.json");
    let (list, bytes) = &files;
    let first = apply_all(&root, &state, list, bytes, "boot-1", &mut never).unwrap();
    assert_eq!(
        first,
        Applied {
            written: 4,
            removed: 0
        }
    );
    assert_eq!(read(&root, GATEWAY), "[Service]\n# gateway 2\n");
    assert_eq!(read(&root, DATABASE), "[Service]\n# database 2\n");
    assert_eq!(mode_of(&root, GATEWAY), 0o644);
    assert_eq!(mode_of(&root, DATABASE), 0o755);
    assert_eq!(
        fs::read_link(at(&root, MASK)).unwrap(),
        PathBuf::from("/dev/null")
    );
    // Nothing is left beside them.
    for directory in [
        "/usr/lib/systemd/system",
        "/etc/systemd/system",
        "/usr/lib/sysusers.d",
    ] {
        assert_eq!(hidden_files(&root, directory), Vec::<String>::new());
    }
    // The record: the list, its release and what has still to be done.
    let saved = State::load(&state);
    assert_eq!(saved.release, "r2");
    assert_eq!(saved.files, *list);
    assert_eq!(
        saved.owned,
        list.iter().map(|f| f.path.clone()).collect::<Vec<_>>()
    );
    assert!(saved.reload);
    assert_eq!(saved.restarts, ["pgcf-gateway.service"]);
    assert_eq!(
        saved.reboot.as_ref().map(|p| p.paths.clone()),
        Some(vec![SYSUSERS.to_string()])
    );
    assert_eq!(
        fs::metadata(&state).unwrap().permissions().mode() & 0o777,
        0o600
    );
    // The same list again: the disk holds it, so nothing is planned, written or recorded anew.
    assert_eq!(plan(&root, &saved, list).unwrap(), Plan::default());
    let before = fs::metadata(at(&root, GATEWAY))
        .unwrap()
        .modified()
        .unwrap();
    let second = apply_all(&root, &state, list, bytes, "boot-1", &mut never).unwrap();
    assert_eq!(second, Applied::default());
    assert_eq!(
        fs::metadata(at(&root, GATEWAY))
            .unwrap()
            .modified()
            .unwrap(),
        before
    );
    assert_eq!(State::load(&state), saved);
}

#[test]
fn a_change_of_one_byte_or_of_the_mode_is_a_write_and_nothing_else_is() {
    let (root, files) = (root(), release());
    let state = root.join("host-files.json");
    let (list, bytes) = &files;
    apply_all(&root, &state, list, bytes, "boot-1", &mut never).unwrap();
    let saved = State::load(&state);
    fs::write(at(&root, GATEWAY), "[Service]\n# gateway 3\n").unwrap();
    fs::set_permissions(at(&root, DATABASE), fs::Permissions::from_mode(0o644)).unwrap();
    let planned = plan(&root, &saved, list).unwrap();
    assert_eq!(
        planned
            .writes
            .iter()
            .map(|f| f.path.as_str())
            .collect::<Vec<_>>(),
        [GATEWAY, DATABASE]
    );
    assert!(planned.removals.is_empty());
    // A mask replaced by a file, and a file that is gone, are writes too.
    fs::remove_file(at(&root, MASK)).unwrap();
    fs::write(at(&root, MASK), "x").unwrap();
    fs::remove_file(at(&root, SYSUSERS)).unwrap();
    assert_eq!(plan(&root, &saved, list).unwrap().writes.len(), 4);
}

#[test]
fn a_link_or_file_at_the_target_is_replaced_and_never_followed() {
    let (root, outside) = (root(), tempdir());
    let (list, bytes) = release();
    fs::write(outside.join("keep"), "keep").unwrap();
    // A link to a file elsewhere stands where the unit belongs, and so does one to a directory.
    symlink(outside.join("keep"), at(&root, GATEWAY)).unwrap();
    symlink(&*outside, at(&root, DATABASE)).unwrap();
    // Neither is anything the agent wrote.
    assert_eq!(inspect(&root, GATEWAY).unwrap(), Installed::Other);
    apply_all(
        &root,
        &root.join("s.json"),
        &list,
        &bytes,
        "boot-1",
        &mut never,
    )
    .unwrap();
    assert_eq!(fs::read_to_string(outside.join("keep")).unwrap(), "keep");
    assert_eq!(fs::read_dir(&*outside).unwrap().count(), 1);
    assert!(fs::symlink_metadata(at(&root, GATEWAY)).unwrap().is_file());
    assert_eq!(read(&root, GATEWAY), "[Service]\n# gateway 2\n");
    assert!(fs::symlink_metadata(at(&root, DATABASE)).unwrap().is_file());
}

#[test]
fn a_link_in_the_directory_chain_is_refused_and_nothing_is_written_through_it() {
    let (root, elsewhere) = (tempdir(), tempdir());
    fs::create_dir_all(at(&root, "/etc")).unwrap();
    fs::create_dir_all(elsewhere.join("system")).unwrap();
    // /etc/systemd is a link to a directory outside the root.
    symlink(&*elsewhere, at(&root, "/etc/systemd")).unwrap();
    let file = host(
        MASK.replace("modprobe@loop", "a").as_str(),
        "x",
        "0644",
        "daemon_reload",
    );
    let error = place(&root, &file, b"x", &mut never).unwrap_err();
    assert_eq!(
        error.to_string(),
        "a link or a file stands where a directory belongs"
    );
    assert_eq!(fs::read_dir(elsewhere.join("system")).unwrap().count(), 0);
    assert!(inspect(&root, &file.path).is_err());
    // The same where the last directory is the link.
    let (root, elsewhere) = (tempdir(), tempdir());
    fs::create_dir_all(at(&root, "/etc/systemd")).unwrap();
    symlink(&*elsewhere, at(&root, "/etc/systemd/system")).unwrap();
    assert!(place(&root, &file, b"x", &mut never).is_err());
    assert_eq!(fs::read_dir(&*elsewhere).unwrap().count(), 0);
    // A file where a directory belongs is refused as well.
    let (root, _elsewhere) = (tempdir(), tempdir());
    fs::create_dir_all(at(&root, "/etc")).unwrap();
    fs::write(at(&root, "/etc/systemd"), "not a directory").unwrap();
    assert!(place(&root, &file, b"x", &mut never).is_err());
}

#[test]
fn the_last_directory_is_made_when_the_image_has_none_and_no_other() {
    let root = tempdir();
    fs::create_dir_all(at(&root, "/etc/systemd")).unwrap();
    let file = host(
        "/etc/systemd/journald.conf.d/pgcf.conf",
        "[Journal]\n",
        "0644",
        "daemon_reload",
    );
    place(&root, &file, b"[Journal]\n", &mut never).unwrap();
    assert_eq!(read(&root, &file.path), "[Journal]\n");
    assert_eq!(
        fs::metadata(at(&root, "/etc/systemd/journald.conf.d"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o755
    );
    // The parents are the node's own: one that is missing is an error, not a directory made.
    let empty = tempdir();
    assert!(place(&empty, &file, b"x", &mut never).is_err());
    assert!(!at(&empty, "/etc").exists());
}

#[test]
fn a_mask_replaces_a_file_and_a_file_replaces_a_mask() {
    let root = root();
    let unit = host(MASK, "[Service]\n", "0644", "daemon_reload");
    fs::write(at(&root, MASK), "old").unwrap();
    place(&root, &mask(MASK, "daemon_reload"), &[], &mut never).unwrap();
    assert_eq!(inspect(&root, MASK).unwrap(), Installed::Mask);
    place(&root, &unit, b"[Service]\n", &mut never).unwrap();
    assert!(matches!(
        inspect(&root, MASK).unwrap(),
        Installed::File { .. }
    ));
    assert_eq!(read(&root, MASK), "[Service]\n");
    // A link to anything but /dev/null is not a mask.
    fs::remove_file(at(&root, MASK)).unwrap();
    symlink("/etc/passwd", at(&root, MASK)).unwrap();
    assert_eq!(inspect(&root, MASK).unwrap(), Installed::Other);
}

#[test]
fn a_directory_where_a_file_belongs_is_refused_and_left_as_it_is() {
    let root = root();
    fs::create_dir(at(&root, GATEWAY)).unwrap();
    fs::write(at(&root, GATEWAY).join("inner"), "keep").unwrap();
    let file = host(GATEWAY, "x", "0644", "daemon_reload");
    assert!(place(&root, &file, b"x", &mut never).is_err());
    assert_eq!(
        fs::read_to_string(at(&root, GATEWAY).join("inner")).unwrap(),
        "keep"
    );
    assert_eq!(
        hidden_files(&root, "/usr/lib/systemd/system"),
        Vec::<String>::new()
    );
    // The agent never removes a directory it did not write, owned or not.
    assert!(!remove(&root, GATEWAY).unwrap());
    assert!(at(&root, GATEWAY).is_dir());
}

#[test]
fn a_crash_at_any_step_leaves_the_old_file_or_the_new_one_and_the_next_apply_finishes() {
    for step in [
        Step::Created,
        Step::Written,
        Step::Synced,
        Step::Renamed,
        Step::DirectorySynced,
    ] {
        let root = root();
        let file = host(
            GATEWAY,
            "new content, longer than the old\n",
            "0755",
            "daemon_reload",
        );
        fs::write(at(&root, GATEWAY), "old\n").unwrap();
        fs::set_permissions(at(&root, GATEWAY), fs::Permissions::from_mode(0o644)).unwrap();
        let mut crash = |at_step: Step| {
            if at_step == step {
                Err(io::Error::other("the power went"))
            } else {
                Ok(())
            }
        };
        let content = b"new content, longer than the old\n";
        assert!(
            place(&root, &file, content, &mut crash).is_err(),
            "{step:?}"
        );
        // The target is whole: the old file until the rename, the new one after it, with its mode.
        let renamed = matches!(step, Step::Renamed | Step::DirectorySynced);
        let seen = read(&root, GATEWAY);
        assert_eq!(
            seen,
            if renamed {
                "new content, longer than the old\n"
            } else {
                "old\n"
            },
            "{step:?}"
        );
        assert_eq!(
            mode_of(&root, GATEWAY),
            if renamed { 0o755 } else { 0o644 },
            "{step:?}"
        );
        // What a crash leaves is one hidden file beside the target, which no unit loader reads.
        let left = hidden_files(&root, "/usr/lib/systemd/system");
        assert_eq!(left.len(), if renamed { 0 } else { 1 }, "{step:?} {left:?}");
        // The next apply finishes it, and cleans up a partial file of the crashed one.
        place(&root, &file, content, &mut never).unwrap();
        assert_eq!(read(&root, GATEWAY), "new content, longer than the old\n");
        assert_eq!(mode_of(&root, GATEWAY), 0o755);
        assert_eq!(
            hidden_files(&root, "/usr/lib/systemd/system"),
            Vec::<String>::new()
        );
    }
}

#[test]
fn a_crash_between_two_files_is_recorded_before_and_finished_by_the_next_apply() {
    let (root, files) = (root(), release());
    let state = root.join("host-files.json");
    let (list, bytes) = &files;
    // Power is lost as the second file of the writes is renamed over its target.
    let mut created = 0;
    let mut crash = |step: Step| {
        if step == Step::Created {
            created += 1;
        }
        if created == 2 && step == Step::Renamed {
            Err(io::Error::other("the power went"))
        } else {
            Ok(())
        }
    };
    assert!(apply_all(&root, &state, list, bytes, "boot-1", &mut crash).is_err());
    // The record covers every path and every consequence, though only some files are written.
    let mid = State::load(&state);
    assert_eq!(
        mid.owned,
        list.iter().map(|f| f.path.clone()).collect::<Vec<_>>()
    );
    assert!(mid.reload);
    assert_eq!(mid.restarts, ["pgcf-gateway.service"]);
    assert_eq!(
        mid.reboot.as_ref().map(|p| p.paths.clone()),
        Some(vec![SYSUSERS.to_string()])
    );
    // The list is not recorded as applied: the node does not claim what it does not hold.
    assert_eq!(mid.files, Vec::<HostFile>::new());
    // The next apply plans what is missing only, finishes, and records the list.
    let again = plan(&root, &mid, list).unwrap();
    assert!(
        again.writes.len() < 4 && !again.writes.is_empty(),
        "{again:?}"
    );
    let applied = apply_all(&root, &state, list, bytes, "boot-1", &mut never).unwrap();
    assert_eq!(applied.written, again.writes.len());
    let done = State::load(&state);
    assert_eq!(done.files, *list);
    assert_eq!(done.restarts, ["pgcf-gateway.service"]);
    assert!(done.reload);
    assert_eq!(plan(&root, &done, list).unwrap(), Plan::default());
    for (file, text) in [
        (GATEWAY, "[Service]\n# gateway 2\n"),
        (DATABASE, "[Service]\n# database 2\n"),
    ] {
        assert_eq!(read(&root, file), text);
    }
}

#[test]
fn what_a_release_drops_is_removed_when_the_agent_wrote_it_and_nothing_else() {
    let (root, files) = (root(), release());
    let state = root.join("host-files.json");
    let (list, bytes) = &files;
    // A file of the node that the agent never wrote, beside the ones it owns.
    fs::write(at(&root, "/etc/sysctl.d/10-other.conf"), "kernel.x = 1\n").unwrap();
    apply_all(&root, &state, list, bytes, "boot-1", &mut never).unwrap();
    // The next release keeps the gateway and drops the rest, and names a file the node has too.
    let next = vec![list[1].clone()];
    let planned = plan(&root, &State::load(&state), &next).unwrap();
    assert!(planned.writes.is_empty());
    assert_eq!(planned.removals, [MASK, DATABASE, SYSUSERS]);
    let applied = apply_all(&root, &state, &next, bytes, "boot-1", &mut never).unwrap();
    assert_eq!(
        applied,
        Applied {
            written: 0,
            removed: 3
        }
    );
    assert!(!at(&root, MASK).exists() && fs::symlink_metadata(at(&root, MASK)).is_err());
    assert!(!at(&root, SYSUSERS).exists());
    assert!(!at(&root, DATABASE).exists());
    assert_eq!(read(&root, GATEWAY), "[Service]\n# gateway 2\n");
    assert_eq!(read(&root, "/etc/sysctl.d/10-other.conf"), "kernel.x = 1\n");
    let saved = State::load(&state);
    assert_eq!(saved.owned, [GATEWAY]);
    assert_eq!(saved.files, next);
    // A removal needs a reload. A path the agent did not write is never removed: ownership is the
    // record, not the directory.
    assert!(saved.reload);
    assert_eq!(plan(&root, &saved, &next).unwrap(), Plan::default());
}

#[test]
fn a_file_that_waits_for_a_reboot_is_not_held_until_the_boot_has_changed() {
    let (root, files) = (root(), release());
    let state = root.join("host-files.json");
    let (list, bytes) = &files;
    apply_all(&root, &state, list, bytes, "boot-1", &mut never).unwrap();
    let saved = State::load(&state);
    assert!(saved.reboot_pending("boot-1"));
    assert!(!saved.reboot_pending("boot-2"));
    // The files are on the disk, but one of them takes effect only at a boot: the node reports the
    // digest of what is in effect, which is not the release's.
    let theirs = list_digest(list);
    assert_ne!(observed_digest(&root, &saved, "boot-1"), theirs);
    // After the reboot the same disk is the release's.
    assert_eq!(observed_digest(&root, &saved, "boot-2"), theirs);
    // A list without such a file is held at once.
    let plain = vec![list[0].clone(), list[1].clone(), list[2].clone()];
    let root = self::root();
    let state = root.join("host-files.json");
    apply_all(&root, &state, &plain, bytes, "boot-1", &mut never).unwrap();
    assert!(!State::load(&state).reboot_pending("boot-1"));
    assert_eq!(
        observed_digest(&root, &State::load(&state), "boot-1"),
        list_digest(&plain)
    );
}

#[test]
fn what_a_node_reports_is_read_from_its_disk_and_is_the_lists_only_while_the_disk_holds_it() {
    let (root, files) = (root(), release());
    let state = root.join("host-files.json");
    let (list, bytes) = &files;
    // Nothing applied: the digest of no file, which no release's list has.
    let none = observed_digest(&root, &State::load(&state), "boot-2");
    assert_eq!(none, crate::update::hex(&Sha256::digest(b"")));
    apply_all(&root, &state, list, bytes, "boot-1", &mut never).unwrap();
    let held = State::load(&state);
    let theirs = list_digest(list);
    assert_eq!(observed_digest(&root, &held, "boot-2"), theirs);
    // A byte, a mode, a file gone, a mask replaced by a file, a directory in the way: each shows.
    let digest = || observed_digest(&root, &held, "boot-2");
    fs::write(at(&root, GATEWAY), "[Service]\n# gateway X\n").unwrap();
    assert_ne!(digest(), theirs);
    fs::write(at(&root, GATEWAY), "[Service]\n# gateway 2\n").unwrap();
    assert_eq!(digest(), theirs);
    fs::set_permissions(at(&root, DATABASE), fs::Permissions::from_mode(0o600)).unwrap();
    assert_ne!(digest(), theirs);
    fs::set_permissions(at(&root, DATABASE), fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(digest(), theirs);
    fs::remove_file(at(&root, GATEWAY)).unwrap();
    assert_ne!(digest(), theirs);
    fs::create_dir(at(&root, GATEWAY)).unwrap();
    assert_ne!(digest(), theirs);
    fs::remove_dir(at(&root, GATEWAY)).unwrap();
    fs::write(at(&root, GATEWAY), "[Service]\n# gateway 2\n").unwrap();
    assert_eq!(digest(), theirs);
    fs::remove_file(at(&root, MASK)).unwrap();
    fs::write(at(&root, MASK), "").unwrap();
    assert_ne!(digest(), theirs);
}

#[test]
fn units_are_restarted_in_one_order_with_the_agents_own_last() {
    let state = State {
        restarts: vec![
            "pgcf-gateway.service".into(),
            AGENT_UNIT.into(),
            "ssh.service".into(),
            "pgcf-cloudflared.service".into(),
        ],
        ..State::default()
    };
    assert_eq!(
        restart_order(&state),
        (
            vec![
                "pgcf-cloudflared.service".to_string(),
                "pgcf-gateway.service".to_string(),
                "ssh.service".to_string()
            ],
            true
        )
    );
    assert_eq!(restart_order(&State::default()), (vec![], false));
    assert!(state.unfinished());
    assert!(!State::default().unfinished());
}

#[test]
fn a_state_the_agent_cannot_read_records_nothing_and_is_written_privately() {
    let root = tempdir();
    let path = root.join("host-files.json");
    assert_eq!(State::load(&path), State::default());
    fs::write(&path, "not json").unwrap();
    assert_eq!(State::load(&path), State::default());
    let state = State {
        release: "r1".into(),
        owned: vec![GATEWAY.into()],
        ..State::default()
    };
    state.save(&path).unwrap();
    assert_eq!(State::load(&path), state);
    assert_eq!(
        fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o600
    );
}
