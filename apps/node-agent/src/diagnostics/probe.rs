// SPDX-License-Identifier: Apache-2.0
//! What an administrator may ask the node to read (SEC-09, ULTRA plan 5.6 job 9 and 9.9). The node
//! has no shell, and the sshd it once had is off. A request on the desired page names one of eight
//! probes and three integers, and the agent builds the command itself: a fixed program with fixed
//! words and the integers it has checked, run with no shell, or a read of fixed files of `/proc`.
//! Nothing of a request but those integers reaches a command line. The output is reduced as the
//! boot report's is (no line of a database's unit or of a backup job), cut to 1 MiB, and posted
//! once.
use crate::{
    diagnostics::boot_report::{self, TENANT_UNITS},
    machine::Machine,
    node_link::constant,
};
use serde::Deserialize;
use serde_json::Value;
use std::{
    collections::{HashSet, VecDeque},
    io,
    path::PathBuf,
    process::Output,
    sync::{Mutex, PoisonError},
    time::Duration,
};

/// The probes of `NODE_PROBES`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Probe {
    Journal,
    Kernel,
    Boots,
    FailedUnits,
    Sockets,
    Listeners,
    Pressure,
    Pool,
}

/// A request of the desired page (`NodeDiagnosticRequest`).
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub id: String,
    pub probe: Probe,
    pub boot: i64,
    pub since_seconds: u64,
    pub lines: u64,
}

/// A program of the system and its arguments, run with no shell.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Argv {
    pub program: &'static str,
    pub arguments: Vec<String>,
}

/// The files of `/proc` that the pressure probe reads.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProcFile {
    PressureCpu,
    PressureMemory,
    PressureIo,
    Meminfo,
    Loadavg,
    Stat,
}

/// Where a probe's output comes from.
#[derive(Debug, PartialEq, Eq)]
pub enum Source {
    Command(Argv),
    Proc,
}

/// The integer of a request that is out of its range.
#[derive(Debug, PartialEq, Eq)]
pub struct Refused(pub &'static str);

/// A bound of the contract.
fn bound(name: &str) -> u64 {
    constant(name).as_u64().expect("generated bound")
}

/// How long a command may run. `kill_on_drop` ends one that is still running after it.
const TIMEOUT: Duration = Duration::from_secs(30);

/// Where the cut of a text says it was cut.
const TRUNCATED: &str = "\n[truncated]\n";

impl Probe {
    /// The name the contract gives the probe.
    pub fn name(self) -> &'static str {
        match self {
            Self::Journal => "journal",
            Self::Kernel => "kernel",
            Self::Boots => "boots",
            Self::FailedUnits => "failed_units",
            Self::Sockets => "sockets",
            Self::Listeners => "listeners",
            Self::Pressure => "pressure",
            Self::Pool => "pool",
        }
    }
    /// Whether the answer is journal entries, and not text.
    fn journal(self) -> bool {
        matches!(self, Self::Journal | Self::Kernel)
    }
}

impl ProcFile {
    const ALL: [Self; 6] = [
        Self::PressureCpu,
        Self::PressureMemory,
        Self::PressureIo,
        Self::Meminfo,
        Self::Loadavg,
        Self::Stat,
    ];
    pub fn path(self) -> &'static str {
        match self {
            Self::PressureCpu => "/proc/pressure/cpu",
            Self::PressureMemory => "/proc/pressure/memory",
            Self::PressureIo => "/proc/pressure/io",
            Self::Meminfo => "/proc/meminfo",
            Self::Loadavg => "/proc/loadavg",
            Self::Stat => "/proc/stat",
        }
    }
    /// What of the file the probe reports: all of it, but of `/proc/stat` the line of the total CPU
    /// time, without the line of each core and the counters that follow.
    fn select(self, content: &str) -> String {
        match self {
            Self::Stat => content
                .split_inclusive('\n')
                .find(|line| line.starts_with("cpu "))
                .unwrap_or_default()
                .to_string(),
            _ => content.to_string(),
        }
    }
}

/// The command or the files of a request, or the integer that is out of range. Nothing is clamped.
pub fn source(request: &Request) -> Result<Source, Refused> {
    let boots = constant("NODE_PROBE_BOOTS").as_array();
    if !boots.is_some_and(|boots| boots.iter().any(|boot| boot.as_i64() == Some(request.boot))) {
        return Err(Refused("boot"));
    }
    let since = bound("NODE_PROBE_SINCE_SECONDS_MIN")..=bound("NODE_PROBE_SINCE_SECONDS_MAX");
    if !since.contains(&request.since_seconds) {
        return Err(Refused("since_seconds"));
    }
    if !(1..=bound("NODE_PROBE_LINES_MAX")).contains(&request.lines) {
        return Err(Refused("lines"));
    }
    let fixed = |program, arguments: &[&str]| {
        Source::Command(Argv {
            program,
            arguments: arguments
                .iter()
                .map(|argument| argument.to_string())
                .collect(),
        })
    };
    Ok(match request.probe {
        Probe::Journal => Source::Command(Argv {
            program: "journalctl",
            arguments: boot_report::journal_arguments(
                request.boot,
                Some(request.since_seconds),
                request.lines,
            ),
        }),
        Probe::Kernel => Source::Command(Argv {
            program: "journalctl",
            arguments: [
                "--no-pager".to_string(),
                "--output=json".to_string(),
                "-k".to_string(),
                format!("--boot={}", request.boot),
                format!("--lines={}", request.lines),
            ]
            .into(),
        }),
        Probe::Boots => fixed("journalctl", &["--list-boots", "--no-pager"]),
        Probe::FailedUnits => fixed("systemctl", &["--failed", "--no-legend", "--plain"]),
        Probe::Sockets => fixed(
            "systemctl",
            &["list-sockets", "--all", "--no-legend", "--plain"],
        ),
        Probe::Listeners => fixed(
            "ss",
            &[
                "--listening",
                "--numeric",
                "--tcp",
                "--udp",
                "--unix",
                "--no-header",
            ],
        ),
        Probe::Pressure => Source::Proc,
        Probe::Pool => fixed(
            "lvs",
            &[
                "--reportformat",
                "json",
                "-o",
                "lv_name,lv_attr,data_percent,metadata_percent",
                "pgcf/pgcf_thinpool",
            ],
        ),
    })
}

/// What a command did: its output when it ended with status 0, else why it did not (its status and
/// what it printed, or that it could not be run, or that it did not end). Only the kind of an
/// error that kept a program from starting is said. A journal probe that fails says its status and
/// its stderr only: the lines it printed before it failed are the journal's whole fields, which
/// the sanitizer has not reduced (`stdout_on_failure` is false for it).
fn captured(
    program: &str,
    stdout_on_failure: bool,
    ran: Result<io::Result<Output>, tokio::time::error::Elapsed>,
) -> (bool, String) {
    match ran {
        Ok(Ok(output)) if output.status.success() => {
            (true, String::from_utf8_lossy(&output.stdout).into_owned())
        }
        Ok(Ok(output)) => (
            false,
            format!(
                "{program} ended with {}\n{}{}",
                output.status,
                if stdout_on_failure {
                    String::from_utf8_lossy(&output.stdout)
                } else {
                    "".into()
                },
                String::from_utf8_lossy(&output.stderr)
            ),
        ),
        Ok(Err(error)) => (
            false,
            format!("{program} could not be run: {:?}\n", error.kind()),
        ),
        Err(_) => (
            false,
            format!(
                "{program} did not end within {} seconds\n",
                TIMEOUT.as_secs()
            ),
        ),
    }
}

/// The pressure probe: each file under its heading, as `tail -n +1` shows files. It fails when a
/// file cannot be read (a kernel without pressure accounting has no `/proc/pressure`), and says
/// which, with the rest.
fn pressure<M: Machine>(machine: &M) -> (bool, String) {
    let mut readable = true;
    let mut text = String::new();
    for file in ProcFile::ALL {
        text += &format!("==> {} <==\n", file.path());
        match machine.proc_file(file) {
            Ok(content) => {
                text += &file.select(&content);
                if !text.ends_with('\n') {
                    text.push('\n');
                }
            }
            Err(error) => {
                readable = false;
                text += &format!("unreadable: {:?}\n", error.kind());
            }
        }
    }
    (readable, text)
}

/// The lines of `text` that name neither a database's unit nor a backup job: what such a unit or
/// job prints, or says of it, can hold a tenant's SQL. The lines keep their endings.
fn tenant_free(text: &str) -> String {
    text.split_inclusive('\n')
        .filter(|line| !TENANT_UNITS.iter().any(|unit| line.contains(unit)))
        .collect()
}

/// `build` of `text`, or, when the body is above `cap` bytes, of its longest beginning, cut at a
/// character, that leaves room for the mark that says the end is gone. The body counts the text as
/// JSON writes it, so its size is found by trying: the beginnings that fit are a prefix of the
/// ones that do not.
fn text_within(cap: usize, build: impl Fn(&str) -> Value, text: String) -> Value {
    let whole = build(&text);
    if whole.to_string().len() <= cap {
        return whole;
    }
    let cut = |end: usize| format!("{}{TRUNCATED}", &text[..end]);
    let fits = |end: usize| build(&cut(end)).to_string().len() <= cap;
    // `low` is a beginning that fits, `high` one that does not.
    let (mut low, mut high) = (0, text.len());
    while high - low > 1 {
        let mut middle = low + (high - low) / 2;
        while !text.is_char_boundary(middle) {
            middle -= 1;
        }
        if middle == low {
            break;
        }
        if fits(middle) {
            low = middle;
        } else {
            high = middle;
        }
    }
    build(&cut(low))
}

/// The result of a request (`NodeProbeResult`): the probe is run, and its output reduced and cut.
/// A request out of range, a command that fails or does not end, and a file that cannot be read
/// are a result with status "failed" that says so: the administrator asked and gets an answer.
pub async fn run<M: Machine>(machine: &M, request: &Request) -> Value {
    let (ok, output) = match source(request) {
        Err(Refused(what)) => (false, format!("{what} is out of range\n")),
        Ok(Source::Command(argv)) => captured(
            argv.program,
            !request.probe.journal(),
            tokio::time::timeout(TIMEOUT, machine.diagnostic(&argv)).await,
        ),
        Ok(Source::Proc) => pressure(machine),
    };
    let result = |entries: &[Value], text: &str| {
        serde_json::json!({
            "kind": "probe",
            "diagnostic_id": request.id,
            "probe": request.probe.name(),
            "status": if ok { "ok" } else { "failed" },
            "entries": entries,
            "text": text,
        })
    };
    let cap = usize::try_from(bound("NODE_PROBE_RESULT_MAX_BYTES")).expect("bound fits");
    if ok && request.probe.journal() {
        let lines = usize::try_from(request.lines).expect("lines fit");
        let entries = boot_report::sanitize_newest(&output, lines);
        boot_report::newest_within(cap, |entries| result(entries, ""), &entries)
    } else {
        text_within(cap, |text| result(&[], text), tenant_free(&output))
    }
}

/// How many answered requests the agent remembers: the page lists eight at a time, for ten minutes.
const REMEMBERED: usize = 64;

/// The requests the agent has answered, which it keeps in a file, and those it is running. A page
/// lists a request until Cloudflare has its result, and a page pulled while the result was on its
/// way lists it still: it is not run twice.
pub struct Answered {
    path: PathBuf,
    state: Mutex<(VecDeque<String>, HashSet<String>)>,
}
impl Answered {
    /// The ids the agent answered before, from `path`; whatever is no identifier is ignored.
    pub fn load(path: PathBuf) -> Self {
        let done = std::fs::read_to_string(&path)
            .unwrap_or_default()
            .lines()
            .filter(|id| id.len() == 36 && id.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-'))
            .map(String::from)
            .collect();
        Self {
            path,
            state: Mutex::new((done, HashSet::new())),
        }
    }
    fn state(&self) -> std::sync::MutexGuard<'_, (VecDeque<String>, HashSet<String>)> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }
    /// Whether the request is to run now: it is neither answered nor running.
    pub fn begin(&self, id: &str) -> bool {
        let mut state = self.state();
        !state.0.iter().any(|done| done == id) && state.1.insert(id.to_string())
    }
    /// The run ended. An answer that Cloudflare took is remembered, newest 64 of them; a request
    /// whose result did not arrive runs again with the next page that lists it.
    pub fn end(&self, id: &str, answered: bool) {
        let mut state = self.state();
        state.1.remove(id);
        if !answered {
            return;
        }
        state.0.push_back(id.to_string());
        while state.0.len() > REMEMBERED {
            state.0.pop_front();
        }
        let text: String = state.0.iter().map(|id| format!("{id}\n")).collect();
        let written = self
            .path
            .parent()
            .map_or(Ok(()), crate::link::file::create_private_directory)
            .and_then(|()| crate::link::file::write_private(&self.path, text.as_bytes()));
        // A file that cannot be written costs a second run after a restart, nothing else.
        if let Err(error) = written {
            crate::timing::emit_event(serde_json::json!({
                "event": "probe_answers_not_kept", "class": crate::diagnostics::error_code(&error.into()),
            }));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{link::test_server::tempdir, machine::local::Local, node_link::contract_valid};
    use serde_json::json;

    const ID: &str = "5b1f0c2e-7d34-4a8b-9e61-0c3d2a4f6b81";
    const MATCHES: &str = "_SYSTEMD_UNIT=pgcf-agent.service _SYSTEMD_UNIT=pgcf-gateway.service \
        _SYSTEMD_UNIT=pgcf-cloudflared.service _SYSTEMD_UNIT=systemd-networkd.service \
        _SYSTEMD_UNIT=ssh.service + _PID=1 + _TRANSPORT=kernel";

    fn request(probe: Probe, boot: i64, since_seconds: u64, lines: u64) -> Request {
        Request {
            id: ID.into(),
            probe,
            boot,
            since_seconds,
            lines,
        }
    }
    fn argv(request: &Request) -> String {
        match source(request) {
            Ok(Source::Command(argv)) => format!("{} {}", argv.program, argv.arguments.join(" ")),
            other => panic!("a command: {other:?}"),
        }
    }

    #[test]
    fn each_probe_with_its_arguments_is_one_exact_command() {
        let table = [
            (
                request(Probe::Journal, -1, 3600, 200),
                format!(
                    "journalctl --no-pager --output=json --boot=-1 --since=-3600s --lines=200 {MATCHES}"
                ),
            ),
            (
                request(Probe::Journal, 0, 60, 2000),
                format!(
                    "journalctl --no-pager --output=json --boot=0 --since=-60s --lines=2000 {MATCHES}"
                ),
            ),
            (
                request(Probe::Kernel, 0, 86_400, 1),
                "journalctl --no-pager --output=json -k --boot=0 --lines=1".into(),
            ),
            (
                request(Probe::Kernel, -1, 60, 2000),
                "journalctl --no-pager --output=json -k --boot=-1 --lines=2000".into(),
            ),
            (
                request(Probe::Boots, 0, 3600, 200),
                "journalctl --list-boots --no-pager".into(),
            ),
            (
                request(Probe::FailedUnits, -1, 60, 1),
                "systemctl --failed --no-legend --plain".into(),
            ),
            (
                request(Probe::Sockets, 0, 3600, 200),
                "systemctl list-sockets --all --no-legend --plain".into(),
            ),
            (
                request(Probe::Listeners, 0, 3600, 200),
                "ss --listening --numeric --tcp --udp --unix --no-header".into(),
            ),
            (
                request(Probe::Pool, 0, 3600, 200),
                "lvs --reportformat json -o lv_name,lv_attr,data_percent,metadata_percent \
                 pgcf/pgcf_thinpool"
                    .into(),
            ),
        ];
        for (request, expected) in table {
            assert_eq!(argv(&request), expected, "{request:?}");
        }
        // The pressure probe runs no command: it reads files.
        assert_eq!(
            source(&request(Probe::Pressure, 0, 3600, 200)),
            Ok(Source::Proc)
        );
    }

    #[test]
    fn the_pool_is_the_one_the_storage_makes() {
        let config = crate::storage::Config::default();
        assert_eq!(
            argv(&request(Probe::Pool, 0, 3600, 200))
                .split(' ')
                .next_back(),
            Some(format!("{}/{}", config.group, config.pool).as_str())
        );
    }

    #[test]
    fn an_integer_out_of_range_is_refused_for_every_probe_and_never_clamped() {
        const PROBES: [Probe; 8] = [
            Probe::Journal,
            Probe::Kernel,
            Probe::Boots,
            Probe::FailedUnits,
            Probe::Sockets,
            Probe::Listeners,
            Probe::Pressure,
            Probe::Pool,
        ];
        for probe in PROBES {
            for (broken, name) in [
                (request(probe, 1, 3600, 200), "boot"),
                (request(probe, -2, 3600, 200), "boot"),
                (request(probe, 0, 59, 200), "since_seconds"),
                (request(probe, 0, 86_401, 200), "since_seconds"),
                (request(probe, 0, 0, 200), "since_seconds"),
                (request(probe, 0, 3600, 0), "lines"),
                (request(probe, 0, 3600, 2001), "lines"),
                (request(probe, 0, 3600, u64::MAX), "lines"),
            ] {
                assert_eq!(source(&broken), Err(Refused(name)), "{broken:?}");
            }
            // The ends of the ranges are in.
            for good in [request(probe, 0, 60, 1), request(probe, -1, 86_400, 2000)] {
                assert!(source(&good).is_ok(), "{good:?}");
            }
        }
    }

    #[test]
    fn the_probes_are_those_of_the_contract() {
        let names: Vec<&str> = constant("NODE_PROBES")
            .as_array()
            .unwrap()
            .iter()
            .map(|name| name.as_str().unwrap())
            .collect();
        assert_eq!(names.len(), 8);
        for name in names {
            let request: Request = serde_json::from_value(json!({
                "id": ID, "probe": name, "boot": 0, "since_seconds": 60, "lines": 1
            }))
            .unwrap_or_else(|error| panic!("{name}: {error}"));
            assert!(source(&request).is_ok(), "{name}");
        }
        // No command, path or unit comes with a request, and no probe the contract lacks.
        for broken in [
            json!({"id": ID, "probe": "shell", "boot": 0, "since_seconds": 60, "lines": 1}),
            json!({"id": ID, "probe": "pool", "boot": 0, "since_seconds": 60, "lines": 1, "command": "id"}),
        ] {
            assert!(serde_json::from_value::<Request>(broken).is_err());
        }
    }

    /// The captured outputs of a systemd 257 lab on Debian trixie, as `Local` serves them.
    async fn answer(machine: &Local, request: &Request) -> Value {
        let result = run(machine, request).await;
        assert!(contract_valid("NodeProbeResult", &result), "{result}");
        result
    }

    #[tokio::test]
    async fn a_text_probe_answers_with_the_output_and_leaves_out_the_lines_of_a_databases_unit() {
        let Some(machine) = Local::new("probe-text") else {
            return;
        };
        let result = answer(&machine, &request(Probe::FailedUnits, 0, 3600, 200)).await;
        assert_eq!(result["kind"], "probe");
        assert_eq!(result["diagnostic_id"], ID);
        assert_eq!(result["probe"], "failed_units");
        assert_eq!(result["status"], "ok");
        assert_eq!(result["entries"], json!([]));
        // The lab had two failed units besides one of a database: only the other two are kept.
        let text = result["text"].as_str().unwrap();
        assert!(text.contains("pgcf-cloudflared.service"), "{text}");
        assert!(!text.contains("pgcf-pg@"), "{text}");
        assert!(
            machine
                .calls()
                .contains(&"diagnostic systemctl --failed --no-legend --plain".to_string())
        );
    }

    #[tokio::test]
    async fn the_other_text_probes_answer_with_what_the_tools_printed() {
        let Some(machine) = Local::new("probe-others") else {
            return;
        };
        for (probe, expect) in [
            (Probe::Boots, "3d2c7f4891ab4e6cb0d55e8a1c7f9a02"),
            (Probe::Sockets, "127.0.0.1:8443"),
            (Probe::Listeners, "tcp   LISTEN 0      4096"),
            (Probe::Pool, "\"lv_name\":\"pgcf_thinpool\""),
        ] {
            let result = answer(&machine, &request(probe, 0, 3600, 200)).await;
            assert_eq!(result["status"], "ok", "{probe:?}");
            assert!(
                result["text"].as_str().unwrap().contains(expect),
                "{probe:?}: {result}"
            );
        }
    }

    #[tokio::test]
    async fn the_pressure_probe_reads_the_files_and_the_cpu_line_of_proc_stat() {
        let Some(machine) = Local::new("probe-pressure") else {
            return;
        };
        let result = answer(&machine, &request(Probe::Pressure, 0, 3600, 200)).await;
        assert_eq!(result["status"], "ok");
        let text = result["text"].as_str().unwrap();
        for heading in [
            "==> /proc/pressure/cpu <==",
            "==> /proc/pressure/memory <==",
            "==> /proc/pressure/io <==",
            "==> /proc/meminfo <==",
            "==> /proc/loadavg <==",
            "==> /proc/stat <==",
        ] {
            assert!(text.contains(heading), "{heading}");
        }
        assert!(text.contains("some avg10="));
        assert!(text.contains("MemAvailable:"));
        // /proc/stat holds a line for every core and many counters: only the total is read.
        let stat = text.split("==> /proc/stat <==\n").nth(1).unwrap();
        assert_eq!(stat.lines().count(), 1, "{stat}");
        assert!(stat.starts_with("cpu  "));
    }

    #[tokio::test]
    async fn the_journal_probes_answer_with_entries_as_the_boot_report_has_them() {
        let Some(machine) = Local::new("probe-journal") else {
            return;
        };
        let result = answer(&machine, &request(Probe::Journal, 0, 3600, 2000)).await;
        assert_eq!(result["status"], "ok");
        assert_eq!(result["text"], "");
        let entries = result["entries"].as_array().unwrap();
        // 24 lines were captured, and three of them are the lines of the database's unit.
        assert_eq!(entries.len(), 21, "{entries:#?}");
        assert!(!result.to_string().contains("pgcf-pg@"));
        assert!(
            entries
                .iter()
                .any(|entry| entry["unit"] == "pgcf-agent.service"
                    && entry["message"] == r#"{"event":"agent_started","uptime_s":12}"#)
        );
        // `lines` keeps the newest.
        let few = answer(&machine, &request(Probe::Journal, 0, 3600, 3)).await;
        assert_eq!(few["entries"].as_array().unwrap().len(), 3);
        assert_eq!(few["entries"], json!(entries[entries.len() - 3..]));
        let kernel = answer(&machine, &request(Probe::Kernel, 0, 3600, 12)).await;
        let lines = kernel["entries"].as_array().unwrap();
        assert_eq!(lines.len(), 3);
        assert!(lines.iter().all(|entry| entry["transport"] == "kernel"));
    }

    #[tokio::test]
    async fn a_command_that_fails_is_a_failed_result_with_its_status_and_what_it_said() {
        let Some(machine) = Local::new("probe-failed") else {
            return;
        };
        // The node has not rebooted: `journalctl --boot=-1` finds no boot, as on a first start.
        let result = answer(&machine, &request(Probe::Journal, -1, 3600, 200)).await;
        assert_eq!(result["status"], "failed");
        assert_eq!(result["entries"], json!([]));
        let text = result["text"].as_str().unwrap();
        assert!(
            text.starts_with("journalctl ended with exit status: 1"),
            "{text}"
        );
        assert!(text.contains("No journal boot entry found for the specified boot (-1)."));
        // After a reboot there is one.
        machine.reboot().await.unwrap();
        let result = answer(&machine, &request(Probe::Journal, -1, 3600, 200)).await;
        assert_eq!(result["status"], "ok");
        // A thin pool that is not there.
        machine.lose_pool();
        let result = answer(&machine, &request(Probe::Pool, 0, 3600, 200)).await;
        assert_eq!(result["status"], "failed");
        assert!(
            result["text"]
                .as_str()
                .unwrap()
                .contains(r#"Failed to find logical volume \"pgcf/pgcf_thinpool\""#)
        );
    }

    #[tokio::test]
    async fn a_journal_probe_that_fails_after_printing_entries_sends_no_line_it_printed() {
        let Some(machine) = Local::new("probe-damaged") else {
            return;
        };
        machine.damage_journal();
        for probe in [Probe::Journal, Probe::Kernel] {
            let result = answer(&machine, &request(probe, 0, 3600, 200)).await;
            assert_eq!(result["status"], "failed", "{probe:?}");
            assert_eq!(result["entries"], json!([]));
            // The status and what journalctl said of it, and none of the fields the boot report
            // keeps on the node (the host name, the machine ID, command lines).
            let text = result["text"].as_str().unwrap();
            assert!(
                text.starts_with("journalctl ended with exit status: 1\n"),
                "{text}"
            );
            assert!(text.contains("Failed to iterate through journal: Bad message"));
            for kept in ["_HOSTNAME", "_MACHINE_ID", "_CMDLINE", "80323333f9fd"] {
                assert!(!text.contains(kept), "{probe:?} {kept}: {text}");
            }
        }
        // A text probe's output is the administrator's answer when its tool fails.
        machine.lose_pool();
        let pool = answer(&machine, &request(Probe::Pool, 0, 3600, 200)).await;
        assert!(pool["text"].as_str().unwrap().contains("\"log_message\""));
    }

    #[tokio::test]
    async fn a_request_out_of_range_is_answered_as_failed_and_runs_nothing() {
        let Some(machine) = Local::new("probe-refused") else {
            return;
        };
        let result = answer(&machine, &request(Probe::Boots, 7, 3600, 200)).await;
        assert_eq!(result["status"], "failed");
        assert!(result["text"].as_str().unwrap().contains("boot"));
        assert!(machine.calls().is_empty());
    }

    #[test]
    fn what_a_command_did_is_its_output_its_status_or_why_it_could_not_run() {
        use std::os::unix::process::ExitStatusExt;
        let output = |code: i32, stdout: &str, stderr: &str| Output {
            status: std::process::ExitStatus::from_raw(code << 8),
            stdout: stdout.into(),
            stderr: stderr.into(),
        };
        assert_eq!(
            captured("ss", true, Ok(Ok(output(0, "tcp\n", "")))),
            (true, "tcp\n".to_string())
        );
        assert_eq!(
            captured("lvs", true, Ok(Ok(output(5, "{}\n", "no pool\n")))),
            (
                false,
                "lvs ended with exit status: 5\n{}\nno pool\n".to_string()
            )
        );
        // A journal probe says its status and stderr, not the lines it printed before it failed.
        assert_eq!(
            captured(
                "journalctl",
                false,
                Ok(Ok(output(1, "{\"_HOSTNAME\":\"h\"}\n", "Bad message\n")))
            ),
            (
                false,
                "journalctl ended with exit status: 1\nBad message\n".to_string()
            )
        );
        let missing = io::Error::new(io::ErrorKind::NotFound, "/usr/bin/ss: not found");
        assert_eq!(
            captured("ss", true, Ok(Err(missing))),
            (false, "ss could not be run: NotFound\n".to_string())
        );
    }

    #[tokio::test]
    async fn a_command_that_does_not_end_is_a_failure_that_names_the_wait() {
        let late = tokio::time::timeout(Duration::from_millis(1), std::future::pending::<()>())
            .await
            .map(|()| {
                Ok::<Output, io::Error>(Output {
                    status: std::process::ExitStatus::default(),
                    stdout: vec![],
                    stderr: vec![],
                })
            });
        let (ok, text) = captured("journalctl", true, late);
        assert!(!ok);
        assert_eq!(text, "journalctl did not end within 30 seconds\n");
    }

    #[test]
    fn the_lines_of_a_databases_unit_or_a_backup_job_are_dropped_and_the_rest_kept_as_written() {
        let text = "a.service loaded failed\npgcf-pg@abcdefghijklmnopqrst.service loaded failed\n\
                    pgcf-job-base-abcdefghijklmnopqrst-1.service loaded failed\nb.socket\n";
        assert_eq!(tenant_free(text), "a.service loaded failed\nb.socket\n");
        // A last line without its newline stays without one.
        assert_eq!(tenant_free("x\ny"), "x\ny");
        assert_eq!(tenant_free("pgcf-pg@x.service"), "");
    }

    fn number(name: &str) -> usize {
        constant(name).as_u64().unwrap().try_into().unwrap()
    }

    #[test]
    fn a_text_above_one_mebibyte_is_cut_until_the_body_fits_and_says_so() {
        let cap = number("NODE_PROBE_RESULT_MAX_BYTES");
        let build = |text: &str| json!({"probe": "sockets", "text": text});
        // Lines of one character, whose newline JSON writes as two: the body is above the cap
        // long before the text is.
        let text = "a\n".repeat(cap);
        let fitted = text_within(cap, build, text);
        let size = fitted.to_string().len();
        assert!(size <= cap && size > cap - 64, "{size}");
        assert!(
            fitted["text"]
                .as_str()
                .unwrap()
                .ends_with("\n[truncated]\n")
        );
        // A text that fits is untouched.
        assert_eq!(text_within(cap, build, "ss\n".into())["text"], "ss\n");
        // Multibyte characters are not split.
        let accents = "\u{e9}".repeat(cap);
        let fitted = text_within(cap, build, accents);
        assert!(fitted.to_string().len() <= cap);
    }

    #[test]
    fn the_contract_takes_a_result_of_one_mebibyte_of_json_and_not_a_byte_more() {
        let cap = number("NODE_PROBE_RESULT_MAX_BYTES");
        let build = |text: &str| {
            json!({"kind": "probe", "diagnostic_id": ID, "probe": "sockets", "status": "ok",
                   "entries": [], "text": text})
        };
        let room = cap - build("").to_string().len();
        assert!(contract_valid("NodeProbeResult", &build(&"a".repeat(room))));
        assert!(!contract_valid(
            "NodeProbeResult",
            &build(&"a".repeat(room + 1))
        ));
        // What the agent makes of a text that is too long is a result the contract takes.
        let fitted = text_within(cap, build, "a\n".repeat(cap));
        assert!(contract_valid("NodeProbeResult", &fitted));
    }

    #[test]
    fn a_journal_result_loses_its_oldest_entries_first_when_it_is_above_one_mebibyte() {
        let cap = number("NODE_PROBE_RESULT_MAX_BYTES");
        let entries: Vec<Value> = (0..2000)
            .map(|n| {
                json!({"at": "2026-10-19T01:00:00.000Z", "unit": "pgcf-agent.service",
                       "identifier": "pgcf-agent", "transport": "stdout", "priority": 6,
                       "message": format!("{n:04}{}", "a".repeat(2044))})
            })
            .collect();
        let build = |entries: &[Value]| json!({"entries": entries, "text": ""});
        let fitted = boot_report::newest_within(cap, build, &entries);
        let kept = fitted["entries"].as_array().unwrap();
        assert!(fitted.to_string().len() <= cap);
        assert!(kept.len() > 400 && kept.len() < 2000, "{}", kept.len());
        assert!(
            kept.last().unwrap()["message"]
                .as_str()
                .unwrap()
                .starts_with("1999")
        );
    }

    #[test]
    fn a_request_is_run_once_remembered_across_a_restart_and_run_again_when_its_answer_is_lost() {
        let directory = tempdir();
        let path = directory.join("agent").join("probes-done");
        let answered = Answered::load(path.clone());
        assert!(answered.begin(ID));
        // Running: a second page that lists it does not start it again.
        assert!(!answered.begin(ID));
        // The result did not arrive: it runs again.
        answered.end(ID, false);
        assert!(answered.begin(ID));
        answered.end(ID, true);
        assert!(!answered.begin(ID));
        // A new process finds it answered. The file is the agent's own.
        let restarted = Answered::load(path.clone());
        assert!(!restarted.begin(ID));
        let other = "6c2a1d3f-8e45-4b9c-af72-1d4e3b5a7c92";
        assert!(restarted.begin(other));
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    #[test]
    fn only_the_newest_sixty_four_answers_are_kept_and_a_file_that_is_not_ids_is_ignored() {
        let directory = tempdir();
        let path = directory.join("agent").join("probes-done");
        let id = |n: u32| format!("00000000-0000-4000-8000-{n:012}");
        let answered = Answered::load(path.clone());
        for n in 0..70 {
            assert!(answered.begin(&id(n)));
            answered.end(&id(n), true);
        }
        let restarted = Answered::load(path.clone());
        assert!(restarted.begin(&id(0)), "the oldest was forgotten");
        assert!(!restarted.begin(&id(69)));
        std::fs::write(&path, "../../etc/passwd\nnot an id\n").unwrap();
        assert!(Answered::load(path).begin(ID));
    }
}
