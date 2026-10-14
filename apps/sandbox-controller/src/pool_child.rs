// SPDX-License-Identifier: Apache-2.0
//! One owned host worker at a time; a deadline never means that the kernel reaped a child.
use crate::pool_runtime::Payload;
use std::{os::unix::fs::MetadataExt, process::Stdio, sync::LazyLock, time::Instant};
use tokio::io::AsyncReadExt;
use tonic::Status;

pub(crate) enum Kind {
    Mount,
    Read,
}
struct Running {
    child: tokio::process::Child,
    stdout: tokio::process::ChildStdout,
    _payload: Option<Payload>,
}
#[derive(Default)]
struct Registry {
    running: Option<Running>,
}
static WORKER: LazyLock<tokio::sync::Mutex<Registry>> =
    LazyLock::new(|| tokio::sync::Mutex::new(Registry::default()));
fn refused() -> Status {
    Status::failed_precondition("pool_worker_unconfirmed")
}
impl Registry {
    fn reap_pending(&mut self) -> Result<(), Status> {
        let Some(running) = self.running.as_mut() else {
            return Ok(());
        };
        running.child.start_kill().map_err(|_| refused())?;
        if running.child.try_wait().map_err(|_| refused())?.is_none() {
            return Err(Status::failed_precondition("pool_worker_cleanup_pending"));
        }
        self.running.take();
        Ok(())
    }
    async fn run(
        &mut self,
        mut command: tokio::process::Command,
        payload: Option<Payload>,
        deadline: Instant,
        limit: u64,
    ) -> Result<Vec<u8>, Status> {
        self.reap_pending()?;
        if Instant::now() >= deadline {
            return Err(refused());
        }
        let mut child = command
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|_| refused())?;
        let stdout = child.stdout.take().ok_or_else(refused)?;
        self.running = Some(Running {
            child,
            stdout,
            _payload: payload,
        });
        let running = self.running.as_mut().ok_or_else(refused)?;
        let outcome = tokio::time::timeout_at(tokio::time::Instant::from_std(deadline), async {
            let mut bytes = Vec::new();
            (&mut running.stdout)
                .take(limit + 1)
                .read_to_end(&mut bytes)
                .await
                .map_err(|_| refused())?;
            let exit = running.child.wait().await.map_err(|_| refused())?;
            Ok::<_, Status>((exit, bytes))
        })
        .await;
        match outcome {
            Ok(Ok((exit, bytes))) => {
                self.running.take();
                if !exit.success() || bytes.len() as u64 > limit {
                    return Err(refused());
                }
                Ok(bytes)
            }
            _ => {
                // SIGKILL is a request, not a reap. A blocked kernel worker and its private
                // payload remain owned here; no later worker can dispatch until try_wait succeeds.
                if let Some(running) = self.running.as_mut() {
                    let _ = running.child.start_kill();
                }
                Err(Status::deadline_exceeded("pool_worker_deadline_exceeded"))
            }
        }
    }
}
pub(crate) async fn execute(
    kind: Kind,
    payload: Payload,
    deadline: Instant,
    limit: u64,
) -> Result<Vec<u8>, Status> {
    let executable = std::env::current_exe().map_err(|_| refused())?;
    let metadata = std::fs::metadata(&executable).map_err(|_| refused())?;
    if !metadata.is_file() || metadata.uid() != 0 || metadata.mode() & 0o022 != 0 {
        return Err(refused());
    }
    let mut command = tokio::process::Command::new(executable);
    command
        .arg(match kind {
            Kind::Mount => "--pool-mount-worker",
            Kind::Read => "--pool-read-worker",
        })
        .arg(&payload.path);
    tokio::time::timeout_at(tokio::time::Instant::from_std(deadline), WORKER.lock())
        .await
        .map_err(|_| refused())?
        .run(command, Some(payload), deadline, limit)
        .await
}
/// Reap timed-out/cancelled workers even if Cloudflare removes their preparation afterward.
pub(crate) async fn reap() -> Result<(), Status> {
    WORKER.lock().await.reap_pending()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn timeout_retains_real_child_until_wait_confirms_reaping() {
        let mut registry = Registry::default();
        let mut command = tokio::process::Command::new("/bin/sh");
        command.args(["-c", "exec sleep 30"]);
        let result = registry
            .run(
                command,
                None,
                Instant::now() + std::time::Duration::from_millis(50),
                32,
            )
            .await;
        assert!(result.is_err());
        assert!(
            registry.running.is_some(),
            "a timeout must retain the real child until actual wait/reap"
        );
        let deadline = Instant::now() + std::time::Duration::from_secs(5);
        while registry.reap_pending().is_err() {
            assert!(Instant::now() < deadline);
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert!(registry.running.is_none());
    }
    #[tokio::test]
    async fn cancelled_future_keeps_the_child_owned_until_reaped() {
        let mut registry = Registry::default();
        let mut command = tokio::process::Command::new("/bin/sh");
        command.args(["-c", "exec sleep 30"]);
        assert!(
            tokio::time::timeout(
                std::time::Duration::from_millis(50),
                registry.run(
                    command,
                    None,
                    Instant::now() + std::time::Duration::from_secs(10),
                    32
                )
            )
            .await
            .is_err()
        );
        assert!(registry.running.is_some());
        let deadline = Instant::now() + std::time::Duration::from_secs(5);
        while registry.reap_pending().is_err() {
            assert!(Instant::now() < deadline);
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert!(registry.running.is_none());
    }
}
