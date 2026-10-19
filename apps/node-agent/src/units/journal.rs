// SPDX-License-Identifier: Apache-2.0
//! The unit's own account of a start (ULTRA plan 11.1): when its postmaster logged the three
//! messages every start of PostgreSQL writes, read from the journal of the unit's invocation. Only
//! the journal's monotonic timestamps leave this module: a message is matched, never kept.
use std::io;

/// The gaps between the handoff to the postmaster and the three messages of its start, in
/// microseconds of the journal's receive times.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Startup {
    /// The handoff, when systemd-executor was about to execute postgres, to `starting PostgreSQL`.
    pub handoff_to_starting_us: u64,
    /// `starting PostgreSQL` to `database system was shut down at`.
    pub starting_to_shut_down_us: u64,
    /// `database system was shut down at` to `database system is ready to accept connections`.
    pub shut_down_to_ready_us: u64,
}

/// The messages of a start, in the order PostgreSQL writes them.
const MARKS: [&str; 3] = [
    "LOG:  starting PostgreSQL",
    "LOG:  database system was shut down at",
    "LOG:  database system is ready to accept connections",
];

/// The three gaps of the start in `journal`, the lines of `journalctl -o json` for one invocation,
/// when systemd handed the unit over to the postmaster at `handoff_us`
/// (`ExecMainHandoffTimestampMonotonic`: the executor's sandbox is set up, the execve is next).
/// `None` when a message is missing, as after a crash, which writes no `shut down at` line, or
/// when the messages are not in this order after the handoff.
pub fn startup(journal: &str, handoff_us: u64) -> Option<Startup> {
    let mut marks = [None; 3];
    for line in journal.lines() {
        let Ok(entry) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        // A message the journal cannot print as text is an array of bytes, and is no mark.
        let Some(message) = entry["MESSAGE"].as_str() else {
            continue;
        };
        let Some(at) = entry["__MONOTONIC_TIMESTAMP"]
            .as_str()
            .and_then(|at| at.parse::<u64>().ok())
        else {
            continue;
        };
        if let Some(mark) = MARKS.iter().position(|mark| message.contains(mark)) {
            marks[mark].get_or_insert(at);
        }
    }
    let [starting, shut_down, ready] = marks;
    Some(Startup {
        handoff_to_starting_us: starting?.checked_sub(handoff_us)?,
        starting_to_shut_down_us: shut_down?.checked_sub(starting?)?,
        shut_down_to_ready_us: ready?.checked_sub(shut_down?)?,
    })
}

/// The journal of one invocation, as `journalctl -o json` prints it: one object a line. `id` is
/// the invocation ID as a UUID. Only the two fields the gaps are made of are asked for.
pub async fn read(id: &str) -> io::Result<String> {
    let output = tokio::process::Command::new("journalctl")
        .args([
            "--no-pager",
            "-o",
            "json",
            "--output-fields=MESSAGE,__MONOTONIC_TIMESTAMP",
        ])
        .arg(format!("_SYSTEMD_INVOCATION_ID={}", id.replace('-', "")))
        .stdin(std::process::Stdio::null())
        .output()
        .await?;
    if !output.status.success() {
        return Err(io::Error::other(format!(
            "journalctl ended with {}",
            output.status
        )));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A start of PostgreSQL 18.6 as the node's unit runs it, in the lab: `journalctl -o json
    /// --output-fields=MESSAGE,__MONOTONIC_TIMESTAMP _SYSTEMD_INVOCATION_ID=<id>`. The unit's
    /// `ExecMainHandoffTimestampMonotonic` was 453497890723 (its `ExecMainStartTimestampMonotonic`,
    /// the fork of systemd-executor, 453497856837).
    const CLEAN: &str = include_str!("fixtures/journal-clean-start.jsonl");
    const CLEAN_HANDOFF_US: u64 = 453_497_890_723;
    /// The start after the postmaster was killed with SIGKILL, same lab (handoff at
    /// 453500022333): crash recovery, which writes no `shut down at` line.
    const CRASH: &str = include_str!("fixtures/journal-crash-recovery.jsonl");
    const CRASH_HANDOFF_US: u64 = 453_500_022_333;

    #[test]
    fn the_gaps_of_a_start_are_the_journals_times_between_the_handoff_and_the_three_messages() {
        assert_eq!(
            startup(CLEAN, CLEAN_HANDOFF_US),
            Some(Startup {
                handoff_to_starting_us: 12_840,
                starting_to_shut_down_us: 1_605,
                shut_down_to_ready_us: 1_522,
            })
        );
    }

    #[test]
    fn a_start_with_a_message_missing_has_no_gaps() {
        // Crash recovery says it was interrupted, not shut down.
        assert_eq!(startup(CRASH, CRASH_HANDOFF_US), None);
        for message in [
            "starting PostgreSQL",
            "database system was shut down at",
            "database system is ready to accept connections",
        ] {
            let without: String = CLEAN
                .lines()
                .filter(|line| !line.contains(message))
                .flat_map(|line| [line, "\n"])
                .collect();
            assert_eq!(without.lines().count(), 3, "{message}");
            assert_eq!(startup(&without, CLEAN_HANDOFF_US), None, "{message}");
        }
        assert_eq!(startup("", CLEAN_HANDOFF_US), None);
    }

    #[test]
    fn lines_that_are_no_text_message_or_come_before_the_handoff_are_not_marks() {
        // A message the journal prints as bytes, a line that is no JSON and one without a time.
        let noise = [
            r#"{"MESSAGE":[115,116,97,114],"__MONOTONIC_TIMESTAMP":"1"}"#,
            "-- No entries --",
            r#"{"MESSAGE":"LOG:  starting PostgreSQL 18"}"#,
        ];
        let journal = format!("{}\n{CLEAN}", noise.join("\n"));
        assert_eq!(
            startup(&journal, CLEAN_HANDOFF_US),
            startup(CLEAN, CLEAN_HANDOFF_US)
        );
        // A handoff after the first message is another invocation's: no gaps, not a wrapped number.
        assert_eq!(startup(CLEAN, CLEAN_HANDOFF_US + 60_000), None);
    }
}
