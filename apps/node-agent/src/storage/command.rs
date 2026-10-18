// SPDX-License-Identifier: Apache-2.0
//! The lvm2, e2fsprogs and util-linux command lines. The agent runs them on the node itself, so
//! the runner is a trait only to say where a command line goes: the system in production, and
//! in tests too, on loop devices.
use std::{
    io,
    process::{Command, Stdio},
};

/// A finished command.
#[derive(Debug, Clone)]
pub struct Output {
    /// The exit code; -1 when a signal ended the command.
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

pub trait CommandRunner {
    /// Runs `command[0]` with the other words as arguments. It waits for the command to end.
    fn run(&self, command: &[String]) -> io::Result<Output>;
}

/// Runs commands on this machine with the C locale, without a terminal and without input.
#[derive(Clone, Copy, Debug, Default)]
pub struct SystemRunner;

impl CommandRunner for SystemRunner {
    fn run(&self, command: &[String]) -> io::Result<Output> {
        let (program, args) = command
            .split_first()
            .ok_or_else(|| io::Error::from(io::ErrorKind::InvalidInput))?;
        let output = Command::new(program)
            .args(args)
            .env("LC_ALL", "C")
            .stdin(Stdio::null())
            .output()?;
        Ok(Output {
            code: output.status.code().unwrap_or(-1),
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        })
    }
}

/// Words for a command line.
pub fn words<const N: usize>(parts: [&str; N]) -> Vec<String> {
    parts.iter().map(|part| part.to_string()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_system_runner_returns_code_stdout_and_stderr() {
        let run = |script: &str| {
            SystemRunner
                .run(&words(["sh", "-c", script]))
                .expect("sh runs")
        };
        let ok = run("printf out; printf err >&2");
        assert_eq!(
            (ok.code, ok.stdout.as_str(), ok.stderr.as_str()),
            (0, "out", "err")
        );
        assert_eq!(run("exit 5").code, 5);
        assert_eq!(run("kill -9 $$").code, -1);
        assert_eq!(run("printf %s \"$LC_ALL\"").stdout, "C");
        assert!(
            SystemRunner
                .run(&words(["/nonexistent/pgcf-command"]))
                .is_err()
        );
        assert!(SystemRunner.run(&[]).is_err());
    }
}
