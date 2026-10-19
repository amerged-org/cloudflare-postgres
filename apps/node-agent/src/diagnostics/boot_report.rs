// SPDX-License-Identifier: Apache-2.0
//! What the agent says of the boot before this one (SEC-05, ULTRA plan 5.6 job 9). A node has no
//! shell, and a node that stopped answering could not tell why: after every reboot the agent posts
//! the tail of the previous boot's journal, reduced to the lines of the agent, the gateway,
//! cloudflared, networkd, PID 1 and the kernel, and to the fields of `NodeJournalEntry`. The
//! lines of a database's unit and of a backup job are never reported: their output can hold the
//! tenant's SQL. An event line of the agent is reported as far as the observation report carries
//! events, so the tail of a failed job's stderr in it stays on the node.
use crate::{
    Error,
    archive::{facts, job},
    events,
    layout::Layout,
    link::Link,
    machine::{Boot, Machine},
    node_link::constant,
    units,
};
use serde_json::{Value, json};
use std::{
    io,
    path::{Path, PathBuf},
    process::Output,
};

/// The matches of the journal the agent reads (SEC-05, SEC-09). The matches before the first `+`
/// are alternatives of one field (units), and each `+` starts another group of alternatives, so
/// the lines are those of the four units, of PID 1 and of the kernel.
const JOURNAL_MATCHES: [&str; 8] = [
    "_SYSTEMD_UNIT=pgcf-agent.service",
    "_SYSTEMD_UNIT=pgcf-gateway.service",
    "_SYSTEMD_UNIT=pgcf-cloudflared.service",
    "_SYSTEMD_UNIT=systemd-networkd.service",
    "+",
    "_PID=1",
    "+",
    "_TRANSPORT=kernel",
];

/// The arguments of `journalctl`, run with no shell, for the newest `lines` lines of `boot` (0 is
/// this boot, -1 the one before) that match `JOURNAL_MATCHES`, and, where `since_seconds` is
/// given, not older than that. Only integers the caller has checked are put into the words.
pub fn journal_arguments(boot: i64, since_seconds: Option<u64>, lines: u64) -> Vec<String> {
    let mut arguments = vec![
        "--no-pager".to_string(),
        "--output=json".to_string(),
        format!("--boot={boot}"),
    ];
    arguments.extend(since_seconds.map(|seconds| format!("--since=-{seconds}s")));
    arguments.push(format!("--lines={lines}"));
    arguments.extend(JOURNAL_MATCHES.map(String::from));
    arguments
}

/// The arguments for the journal of the previous boot that the boot report is made of: the newest
/// 1,000 lines.
pub fn previous_boot_arguments() -> Vec<String> {
    journal_arguments(-1, None, bound("NODE_BOOT_REPORT_ENTRIES_MAX") as u64)
}

/// What `journalctl` printed for the previous boot: its lines, or `None` when the journal holds no
/// earlier boot, which it answers with status 1 and a line on stderr and nothing on stdout. A
/// previous boot that none of the matches selects is a success with no line.
pub fn previous_boot(output: &Output) -> io::Result<Option<String>> {
    if output.status.success() {
        return Ok(Some(String::from_utf8_lossy(&output.stdout).into_owned()));
    }
    let error = String::from_utf8_lossy(&output.stderr);
    if output.status.code() == Some(1) && error.contains("No journal boot entry found") {
        return Ok(None);
    }
    Err(io::Error::other(format!(
        "journalctl ended with {}: {}",
        output.status,
        error.trim()
    )))
}

/// Whether the previous boot's journal is due: the boot is not the one the agent last reported, or
/// the agent reported none. Whether there is a previous boot is for the journal to say.
pub fn boot_report_due(stored: Option<&str>, current: &str) -> bool {
    stored != Some(current)
}

/// The unit names whose lines can hold a tenant's SQL: a database's unit and a backup job. PID 1
/// writes a job's whole command line, an address and a role included, into the lines about it.
pub(super) const TENANT_UNITS: [&str; 2] = [units::UNIT_PREFIX, job::UNIT_PREFIX];

/// The unit of the agent, whose event lines go through `events::sanitize` on their way here.
const AGENT_UNIT: &str = "pgcf-agent.service";

/// The text of a line of the agent. An event, a JSON object with a valid name, keeps what
/// `events::sanitize` keeps of it, as in the observation report: the contract refuses error text,
/// and the tail of a failed job's stderr is such text. Any other line (a panic, the error that
/// ended the process) is the text it is.
fn agent_text(text: String) -> String {
    let Ok(line) = serde_json::from_str::<Value>(&text) else {
        return text;
    };
    let Some(mut event) = events::sanitize(&line, "") else {
        return text;
    };
    let Value::Object(mut kept) = event["fields"].take() else {
        return text;
    };
    kept.insert("event".into(), event["event"].take());
    if let Some(database) = event.get_mut("database_id") {
        kept.insert("database_id".into(), database.take());
    }
    Value::Object(kept).to_string()
}

/// The values of a field of a line as `journalctl --output=json` prints it: text; the bytes of a
/// value that is not text, as an array of numbers; null for a value it left out for its size; and
/// an array of those for a field that occurs more than once.
fn texts(value: &Value) -> Vec<String> {
    match value {
        Value::String(text) => vec![text.clone()],
        Value::Array(items) if !items.is_empty() && items.iter().all(Value::is_number) => {
            let bytes: Option<Vec<u8>> = items
                .iter()
                .map(|byte| u8::try_from(byte.as_u64()?).ok())
                .collect();
            bytes
                .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
                .into_iter()
                .collect()
        }
        Value::Array(items) => items.iter().flat_map(texts).collect(),
        _ => Vec::new(),
    }
}

/// The text of `message` cut to `max` bytes at a character boundary.
fn cut(mut message: String, max: usize) -> String {
    if message.len() > max {
        let mut end = max;
        while !message.is_char_boundary(end) {
            end -= 1;
        }
        message.truncate(end);
    }
    message
}

/// A bound of the contract.
fn bound(name: &str) -> usize {
    usize::try_from(constant(name).as_u64().expect("generated bound")).expect("bound fits")
}

/// One line of the journal as an entry of the report, or `None` for a line that is no JSON object,
/// has no time or transport, or belongs to a tenant's unit. Only the fields of `NodeJournalEntry`
/// are read out of it; everything else the line holds (command lines, user IDs, cgroups, host
/// names) stays on the node.
fn entry(line: &str) -> Option<Value> {
    let line: Value = serde_json::from_str(line).ok()?;
    let first = |field: &str| texts(line.get(field)?).into_iter().next();
    // The unit the line is from, and the unit PID 1 writes it about.
    let tenant = ["_SYSTEMD_UNIT", "UNIT"].iter().any(|field| {
        line.get(*field).is_some_and(|value| {
            texts(value)
                .iter()
                .any(|unit| TENANT_UNITS.iter().any(|prefix| unit.starts_with(prefix)))
        })
    });
    if tenant {
        return None;
    }
    let micros: i64 = first("__REALTIME_TIMESTAMP")?.parse().ok()?;
    let transport = first("_TRANSPORT").filter(|transport| {
        (1..=16).contains(&transport.len()) && transport.bytes().all(|b| b.is_ascii_lowercase())
    })?;
    let name = |field: &str| first(field).filter(|name| (1..=255).contains(&name.len()));
    let unit = name("_SYSTEMD_UNIT");
    let priority = first("PRIORITY")
        .and_then(|priority| priority.parse::<u8>().ok())
        .filter(|priority| *priority <= 7)
        .unwrap_or(6);
    let message = first("MESSAGE").unwrap_or_default();
    let message = if unit.as_deref() == Some(AGENT_UNIT) {
        agent_text(message)
    } else {
        message
    };
    Some(json!({
        "at": facts::timestamp(micros / 1000),
        "unit": unit,
        "identifier": name("SYSLOG_IDENTIFIER"),
        "transport": transport,
        "priority": priority,
        "message": cut(message, bound("NODE_BOOT_REPORT_MESSAGE_MAX_BYTES")),
    }))
}

/// The entries of `NodeBootReport` that the lines of `journal` make, in their order: at most the
/// newest 1,000.
pub fn sanitize(journal: &str) -> Vec<Value> {
    sanitize_newest(journal, bound("NODE_BOOT_REPORT_ENTRIES_MAX"))
}

/// The same, at most the newest `max`.
pub fn sanitize_newest(journal: &str, max: usize) -> Vec<Value> {
    let entries: Vec<Value> = journal.lines().filter_map(entry).collect();
    let excess = entries.len().saturating_sub(max);
    entries.into_iter().skip(excess).collect()
}

/// What `build` makes of `entries` without their oldest, as many as it takes for the body to be at
/// most `cap` bytes.
pub fn newest_within(cap: usize, build: impl Fn(&[Value]) -> Value, entries: &[Value]) -> Value {
    let size = |value: &Value| value.to_string().len();
    // Each entry costs its own text and a comma, and the first one has no comma.
    let sizes: Vec<usize> = entries.iter().map(|entry| size(entry) + 1).collect();
    let mut total =
        size(&build(&[])) + sizes.iter().sum::<usize>() - usize::from(!sizes.is_empty());
    let mut dropped = 0;
    while total > cap && dropped < sizes.len() {
        total -= sizes[dropped];
        dropped += 1;
    }
    build(&entries[dropped..])
}

/// The report of this boot: the entries, without their oldest while the body is above its cap.
pub fn report(boot: &Boot, previous: Option<&str>, entries: Vec<Value>) -> Value {
    newest_within(
        bound("NODE_BOOT_REPORT_MAX_BYTES"),
        |entries| {
            json!({
                "boot_id": boot.id,
                "previous_boot_id": previous,
                "kernel_release": boot.kernel_release,
                "entries": entries,
            })
        },
        &entries,
    )
}

/// Where the agent keeps the boot it last reported.
fn stored_path(layout: &Layout) -> PathBuf {
    layout.agent().join("boot-id")
}

/// The boot ID the agent last reported, if the file holds one.
fn stored_boot(path: &Path) -> Option<String> {
    let text = std::fs::read_to_string(path).ok()?;
    let id = text.trim();
    (id.len() == 36 && id.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-'))
        .then(|| id.to_string())
}

/// After a boot: posts the previous boot's journal, and remembers this boot only once Cloudflare
/// answered. A failure leaves the stored boot as it was, so that the next start tries again. A
/// node whose journal holds no earlier boot is a first start: nothing is posted, and the boot is
/// remembered, unless the agent reported an earlier boot, in which case the report goes without lines.
pub async fn report_boot<M: Machine>(machine: &M, link: &Link) -> Result<(), Error> {
    let boot = machine.boot().ok_or("the boot cannot be read")?;
    let path = stored_path(machine.layout());
    let stored = stored_boot(&path);
    if !boot_report_due(stored.as_deref(), &boot.id) {
        return Ok(());
    }
    let journal = machine.previous_boot_journal().await?;
    if journal.is_some() || stored.is_some() {
        let entries = journal.as_deref().map(sanitize).unwrap_or_default();
        link.post_diagnostics(&report(&boot, stored.as_deref(), entries))
            .await?;
    }
    crate::link::file::create_private_directory(&machine.layout().agent())?;
    crate::link::file::write_private(&path, boot.id.as_bytes())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        archive::{
            facts,
            job::{Exit, Outcome},
            server::failed_job_line,
            test_support::credential,
        },
        link::{
            LinkConfig, Paths, Timing, Transport,
            test_server::{Cloud, Failure, tempdir},
        },
        machine::{local::Local, os_report},
        node_link::{constant, contract_valid},
    };
    use serde_json::json;
    use std::time::Duration;

    /// Lines `journalctl --output=json` printed on a systemd 257 node for the boot before the
    /// present one, as the arguments select them, and the lines of a database's unit and of the
    /// agent's backup jobs, which the report must not carry. PID 1 wrote the job lines when
    /// `systemd-run` ran the arguments of `systemd_run_arguments` for a WAL upload that succeeded
    /// and a base backup that failed; the job's own output goes to `systemd-run` and not to the
    /// journal, so none of it is here.
    const JOURNAL: &str = include_str!("previous-boot.jsonl");
    const CURRENT: &str = "2f1c8a6e-3b57-4d0a-9c1e-7a4b5d6e8f90";
    const EARLIER: &str = "9a7c1d2e-4b3f-4a65-8e10-6c5d4b3a2f10";

    fn line(unit: &str, message: &Value) -> String {
        json!({
            "__REALTIME_TIMESTAMP": "1792366611261953", "_SYSTEMD_UNIT": unit, "_TRANSPORT": "stdout",
            "PRIORITY": "6", "SYSLOG_IDENTIFIER": "pgcf-agent", "MESSAGE": message,
        })
        .to_string()
    }
    fn number(name: &str) -> usize {
        constant(name).as_u64().unwrap().try_into().unwrap()
    }

    #[test]
    fn a_report_is_due_when_the_boot_changed_or_none_was_reported() {
        assert!(boot_report_due(None, CURRENT));
        assert!(boot_report_due(Some(EARLIER), CURRENT));
        assert!(!boot_report_due(Some(CURRENT), CURRENT));
    }

    #[test]
    fn the_command_is_the_journal_of_the_previous_boot_of_the_nodes_own_units_pid_1_and_the_kernel()
    {
        assert_eq!(
            previous_boot_arguments().join(" "),
            concat!(
                "--no-pager --output=json --boot=-1 --lines=1000 ",
                "_SYSTEMD_UNIT=pgcf-agent.service _SYSTEMD_UNIT=pgcf-gateway.service ",
                "_SYSTEMD_UNIT=pgcf-cloudflared.service _SYSTEMD_UNIT=systemd-networkd.service ",
                "+ _PID=1 + _TRANSPORT=kernel"
            )
        );
    }

    fn exited(code: i32, stdout: &str, stderr: &str) -> Output {
        use std::os::unix::process::ExitStatusExt;
        Output {
            status: std::process::ExitStatus::from_raw(code << 8),
            stdout: stdout.into(),
            stderr: stderr.into(),
        }
    }

    #[test]
    fn journalctl_says_no_earlier_boot_with_status_1_and_any_other_failure_is_one() {
        // What systemd 257 printed for `--boot=-1` on a journal of one boot, and for a boot
        // that none of the matches selects.
        let none = "No journal boot entry found for the specified boot (-1).\n";
        assert_eq!(previous_boot(&exited(1, "", none)).unwrap(), None);
        assert_eq!(
            previous_boot(&exited(0, JOURNAL, "")).unwrap().as_deref(),
            Some(JOURNAL)
        );
        assert_eq!(
            previous_boot(&exited(0, "", "")).unwrap().as_deref(),
            Some("")
        );
        for failed in [
            exited(1, "", "Failed to open journal: Permission denied\n"),
            exited(2, "", none),
            exited(1, "", ""),
        ] {
            assert!(previous_boot(&failed).is_err(), "{failed:?}");
        }
    }

    #[test]
    fn the_journal_is_reduced_to_the_fields_of_the_contract_and_keeps_no_line_of_a_tenants_unit() {
        let entries = sanitize(JOURNAL);
        // 19 lines: the kernel's two, the gateway's, cloudflared's, the agent's three and its
        // three of PID 1 are kept; a database's unit has a line of its own and three of PID 1, and
        // the two backup jobs have five of PID 1.
        assert_eq!(JOURNAL.lines().count(), 19);
        assert_eq!(entries.len(), 10, "{entries:#?}");
        let names = [
            "at",
            "unit",
            "identifier",
            "transport",
            "priority",
            "message",
        ];
        for entry in &entries {
            let mut keys: Vec<_> = entry.as_object().unwrap().keys().cloned().collect();
            keys.sort();
            let mut expected = names.map(String::from);
            expected.sort();
            assert_eq!(keys, expected, "{entry}");
        }
        let text = serde_json::to_string(&entries).unwrap();
        for tenant in [
            "pgcf-pg@",
            "pgcf-job-",
            "SELECT",
            "barman",
            "--endpoint-url",
            "pgcf_backup",
        ] {
            assert!(!text.contains(tenant), "{tenant}");
        }
        assert_eq!(
            entries[0],
            json!({"at": facts::timestamp(1_792_366_592_980), "unit": null, "identifier": "kernel",
                   "transport": "kernel", "priority": 6,
                   "message": "docker0: port 1(vethd2a4825) entered forwarding state"})
        );
        // The agent's lines, one of which journald printed as the bytes of a message that is not UTF-8.
        let agent: Vec<_> = entries
            .iter()
            .filter(|e| e["unit"] == "pgcf-agent.service")
            .collect();
        assert_eq!(agent.len(), 3);
        assert_eq!(
            agent[0]["message"],
            r#"{"event":"agent_started","uptime_s":12}"#
        );
        assert_eq!(agent[2]["message"], "binary \u{fffd}\u{fffd} tail");
        assert_eq!(agent[0]["identifier"], "pgcf-agent");
        assert_eq!(agent[0]["transport"], "stdout");
        // PID 1 reports about the units it manages as `init.scope`; the kernel has no unit.
        assert!(entries.iter().any(|e| {
            e["unit"] == "init.scope"
                && e["message"]
                    .as_str()
                    .unwrap()
                    .starts_with("Stopping pgcf-agent.service")
        }));
        assert!(
            entries
                .iter()
                .any(|e| e["unit"].is_null() && e["priority"] == 3)
        );
        let report = report(
            &Boot {
                id: CURRENT.into(),
                booted_at: 1_792_366_700,
                kernel_release: "6.12.113+deb13-amd64".into(),
            },
            Some(EARLIER),
            entries,
        );
        assert!(contract_valid("NodeBootReport", &report), "{report}");
    }

    #[test]
    fn an_event_of_the_agent_is_reported_as_the_observation_report_carries_it_and_other_text_as_written()
     {
        // What the agent logs when a job for the archive failed, with the tail of barman's stderr.
        let outcome = Outcome {
            exit: Exit::Code(1),
            stdout: String::new(),
            stderr: "ERROR: Upload of 000000010000000000000003 to https://account.r2.cloudflarestorage.com/pgcf-eu failed: /var/lib/pgcf/db/abcdefghijklmnopqrst/data/pg_wal".into(),
            elapsed: Duration::from_millis(1234),
        };
        let event = failed_job_line(
            "archive_failed",
            "abcdefghijklmnopqrst",
            "000000010000000000000003",
            &outcome,
            &credential(),
        );
        assert!(event["stderr"].as_str().unwrap().contains("account.r2"));
        let panic = "thread 'main' panicked at apps/node-agent/src/service.rs:12:5:\nout of memory";
        let gateway = r#"{"event":"sql_stages","database":"abcdefghijklmnopqrst","outcome":"ok","agent_ms":{"a":1}}"#;
        let journal = [
            line("pgcf-agent.service", &json!(event.to_string())),
            line("pgcf-agent.service", &json!(panic)),
            line(
                "pgcf-agent.service",
                &json!(r#"{"event":"agent_started","uptime_s":12}"#),
            ),
            line("pgcf-gateway.service", &json!(gateway)),
        ]
        .join("\n");
        let messages: Vec<String> = sanitize(&journal)
            .iter()
            .map(|e| e["message"].as_str().unwrap().to_string())
            .collect();
        let reported: Value = serde_json::from_str(&messages[0]).unwrap();
        let keys: Vec<&str> = reported
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(
            keys,
            ["at_ms", "database_id", "elapsed_ms", "event", "file"],
            "{reported}"
        );
        assert_eq!(reported["event"], "archive_failed");
        assert_eq!(reported["database_id"], "abcdefghijklmnopqrst");
        assert_eq!(reported["file"], "000000010000000000000003");
        assert_eq!(reported["elapsed_ms"], 1234);
        // The text of a panic, a line of the gateway and an event with nothing to drop stay as written.
        assert_eq!(messages[1], panic);
        assert_eq!(messages[2], r#"{"event":"agent_started","uptime_s":12}"#);
        assert_eq!(messages[3], gateway);
    }

    #[test]
    fn a_message_is_cut_at_2048_bytes_on_a_character_boundary_and_a_line_that_is_none_is_skipped() {
        let max = number("NODE_BOOT_REPORT_MESSAGE_MAX_BYTES");
        let long = "\u{e9}".repeat(1500);
        let bytes: Vec<Value> = long.bytes().map(Value::from).collect();
        let journal = [
            line("pgcf-agent.service", &json!(long)),
            line("pgcf-agent.service", &Value::Array(bytes)),
            line("pgcf-agent.service", &json!("a".repeat(max))),
            // A message journalctl left out for its size is null: the line stays, without text.
            line("pgcf-agent.service", &Value::Null),
            "not json".to_string(),
            String::new(),
            json!({"MESSAGE": "no time", "_TRANSPORT": "kernel"}).to_string(),
            json!({"__REALTIME_TIMESTAMP": "soon", "_TRANSPORT": "kernel"}).to_string(),
            json!({"__REALTIME_TIMESTAMP": "1792366611261953", "MESSAGE": "no transport"})
                .to_string(),
        ]
        .join("\n");
        let entries = sanitize(&journal);
        let messages: Vec<&str> = entries
            .iter()
            .map(|e| e["message"].as_str().unwrap())
            .collect();
        assert_eq!(messages.len(), 4, "{messages:?}");
        assert_eq!(messages[0], "\u{e9}".repeat(max / 2));
        assert_eq!(messages[1], messages[0]);
        assert_eq!(messages[2].len(), max);
        assert_eq!(messages[3], "");
        // An odd limit cannot split a two-byte character.
        let odd = line(
            "pgcf-agent.service",
            &json!(format!("a{}", "\u{e9}".repeat(1500))),
        );
        assert_eq!(
            sanitize(&odd)[0]["message"].as_str().unwrap().len(),
            max - 1
        );
    }

    #[test]
    fn an_entry_of_an_unnamed_priority_is_info_and_a_field_that_repeats_is_read_by_its_first_value()
    {
        let journal = json!({
            "__REALTIME_TIMESTAMP": ["1792366611261953", "1792366611261954"], "_TRANSPORT": ["kernel"],
            "SYSLOG_IDENTIFIER": ["kernel", "other"], "MESSAGE": ["first", "second"],
            "_SYSTEMD_UNIT": "x".repeat(300),
        })
        .to_string();
        assert_eq!(
            sanitize(&journal),
            [
                json!({"at": facts::timestamp(1_792_366_611_261), "unit": null, "identifier": "kernel",
                    "transport": "kernel", "priority": 6, "message": "first"})
            ]
        );
        for (given, kept) in [("0", 0), ("7", 7), ("8", 6), ("x", 6)] {
            let journal = json!({"__REALTIME_TIMESTAMP": "1", "_TRANSPORT": "kernel", "PRIORITY": given, "MESSAGE": ""}).to_string();
            assert_eq!(sanitize(&journal)[0]["priority"], kept, "{given}");
        }
    }

    #[test]
    fn only_the_newest_thousand_lines_are_reported() {
        let max = number("NODE_BOOT_REPORT_ENTRIES_MAX");
        let journal: Vec<String> = (0..max + 5)
            .map(|n| line("pgcf-agent.service", &json!(n.to_string())))
            .collect();
        let entries = sanitize(&journal.join("\n"));
        assert_eq!(entries.len(), max);
        assert_eq!(entries[0]["message"], "5");
        assert_eq!(entries[max - 1]["message"], (max + 4).to_string());
    }

    #[test]
    fn a_report_above_one_mebibyte_loses_its_oldest_lines_first() {
        let boot = Boot {
            id: CURRENT.into(),
            booted_at: 1_792_366_700,
            kernel_release: "6.12.113+deb13-amd64".into(),
        };
        let cap = number("NODE_BOOT_REPORT_MAX_BYTES");
        let full = |n: usize| {
            let mut entry = sanitize(&line("pgcf-agent.service", &json!("a".repeat(2048))));
            entry[0]["message"] = format!("{n:04}{}", "a".repeat(2044)).into();
            entry.remove(0)
        };
        let entries: Vec<Value> = (0..1000).map(full).collect();
        assert!(serde_json::to_vec(&json!(entries)).unwrap().len() > cap);
        let report = report(&boot, None, entries);
        let kept = report["entries"].as_array().unwrap();
        assert!(serde_json::to_vec(&report).unwrap().len() <= cap);
        assert!(contract_valid("NodeBootReport", &report));
        // One line fewer would leave room for the oldest one that was dropped.
        assert!(kept.len() > 400 && kept.len() < 1000, "{}", kept.len());
        let first = 1000 - kept.len();
        assert!(
            kept.last().unwrap()["message"]
                .as_str()
                .unwrap()
                .starts_with("0999")
        );
        assert!(
            kept[0]["message"]
                .as_str()
                .unwrap()
                .starts_with(&format!("{first:04}"))
        );
        let older = full(first - 1);
        let one_more: Vec<&Value> = std::iter::once(&older).chain(kept).collect();
        let one_more = serde_json::to_vec(&json!({
            "boot_id": CURRENT, "previous_boot_id": null, "kernel_release": "6.12.113+deb13-amd64",
            "entries": one_more,
        }))
        .unwrap();
        assert!(one_more.len() > cap);
    }

    async fn linked(cloud: &Cloud, machine: &Local) -> Link {
        let base = tempdir();
        cloud.seed(&base);
        let (link, _events) = Link::start(
            LinkConfig {
                paths: Paths::new(&base),
                image_version: "25".into(),
                agent_version: "0.1.0".into(),
                release_id: None,
                os: os_report(machine).await.unwrap(),
                timing: Timing::default(),
            },
            Transport::new(cloud.roots()).unwrap(),
        )
        .await
        .unwrap();
        link
    }
    fn stored(machine: &Local) -> Option<String> {
        std::fs::read_to_string(machine.layout().agent().join("boot-id")).ok()
    }

    #[tokio::test]
    async fn a_new_boot_posts_the_previous_journal_once_and_is_remembered_only_after_the_answer() {
        let Some(machine) = Local::new("boot-report") else {
            return;
        };
        let cloud = Cloud::start().await;
        let link = linked(&cloud, &machine).await;
        let posted = || cloud.acknowledged("/node/v1/diagnostics");
        let first = machine.boot().unwrap().id;

        // The first start of a node has no earlier boot: nothing is posted, and the boot is
        // remembered so that the next one is told apart.
        report_boot(&machine, &link).await.unwrap();
        assert_eq!(stored(&machine).as_deref(), Some(first.as_str()));
        report_boot(&machine, &link).await.unwrap();
        assert!(posted().is_empty());

        // The node reboots. The answer to the first attempt is a refusal: the boot is not
        // remembered, and the next start posts the same report.
        machine.reboot().await.unwrap();
        let second = machine.boot().unwrap().id;
        cloud.fail_next([Failure::Status(503)]);
        assert!(report_boot(&machine, &link).await.is_err());
        assert_eq!(stored(&machine).as_deref(), Some(first.as_str()));
        assert!(posted().is_empty());
        report_boot(&machine, &link).await.unwrap();
        assert_eq!(stored(&machine).as_deref(), Some(second.as_str()));
        let [report] = &posted()[..] else {
            panic!("exactly one report: {:?}", posted());
        };
        assert_eq!(report["boot_id"], second);
        assert_eq!(report["previous_boot_id"], first);
        assert_eq!(report["kernel_release"], "6.12.111+deb13-amd64");
        assert_eq!(report["entries"].as_array().unwrap().len(), 10);
        // A start that finds the boot reported posts nothing more, and the post was signed.
        report_boot(&machine, &link).await.unwrap();
        assert_eq!(posted().len(), 1);
        assert!(
            cloud
                .requests()
                .iter()
                .skip(1)
                .all(|seen| seen.signed == Some(Ok(())))
        );
    }

    #[tokio::test]
    async fn a_reboot_is_reported_without_lines_when_the_journal_lost_the_boot() {
        let Some(machine) = Local::new("boot-report-lost") else {
            return;
        };
        let cloud = Cloud::start().await;
        let link = linked(&cloud, &machine).await;
        // The agent reported an earlier boot, and the node has no journal of any boot before this.
        crate::link::file::create_private_directory(&machine.layout().agent()).unwrap();
        std::fs::write(machine.layout().agent().join("boot-id"), EARLIER).unwrap();
        report_boot(&machine, &link).await.unwrap();
        let reports = cloud.acknowledged("/node/v1/diagnostics");
        assert_eq!(reports.len(), 1);
        assert_eq!(reports[0]["previous_boot_id"], EARLIER);
        assert_eq!(reports[0]["entries"], json!([]));
        assert_eq!(stored(&machine), Some(machine.boot().unwrap().id));
    }

    #[tokio::test]
    async fn an_agent_that_reported_no_boot_before_the_reboot_claims_no_earlier_boot() {
        let Some(machine) = Local::new("boot-report-unknown") else {
            return;
        };
        let cloud = Cloud::start().await;
        let link = linked(&cloud, &machine).await;
        // The agent was updated on a node that had rebooted before: its journal has an earlier
        // boot and the agent stored none.
        machine.reboot().await.unwrap();
        report_boot(&machine, &link).await.unwrap();
        let reports = cloud.acknowledged("/node/v1/diagnostics");
        assert_eq!(reports.len(), 1);
        assert_eq!(reports[0]["previous_boot_id"], Value::Null);
        assert_eq!(reports[0]["boot_id"], machine.boot().unwrap().id);
    }
}
