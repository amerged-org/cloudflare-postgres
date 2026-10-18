// SPDX-License-Identifier: Apache-2.0
//! `pgcf-agent`: the node agent, the only local actor on a node (plan 5.6).
//!
//! `pgcf-agent run` is the service of the image's `pgcf-agent.service` (`Type=notify`). It signals
//! `READY=1` once the node's storage is open, then enrolls and links to Cloudflare in the
//! background, so that a node that is not enrolled yet waits instead of crashing. Its restart
//! never stops a database: the databases are units of their own, and the agent finds them again.
//!
//! `pgcf-agent check` makes or wakes the scratch database and queries it, without Cloudflare
//! (the image's boot test). It runs after the agent has signalled ready.

#[cfg(target_os = "linux")]
mod linux {
    use pgcf_node_agent::{
        Error,
        agent::{
            Timing,
            check::{self, SCRATCH},
        },
        diagnostics::error_code,
        layout::Layout,
        link::{Link, LinkConfig, LinkEvents, Paths, Timing as LinkTiming, Transport},
        machine::{Node, restore_runtime},
        notify::notify,
        release,
        sample::uptime_seconds,
        service::{Intervals, Service, ServiceConfig, gateway_owner},
        storage,
        timing::emit_event,
    };
    use serde_json::json;
    use std::{sync::Arc, time::Duration};
    use tokio::signal::unix::{SignalKind, signal};

    /// One attempt to enroll, if the node is not, and to start the link.
    async fn link_once(layout: &Layout) -> Result<(Link, LinkEvents), Error> {
        let image_version = release::this_image_version().ok_or("the image has no version")?;
        let config = LinkConfig {
            paths: Paths::new(layout.state.clone()),
            image_version,
            agent_version: env!("CARGO_PKG_VERSION").into(),
            release_id: release::release_id(&layout.bin().join("current")),
            timing: LinkTiming::default(),
        };
        Link::start(config, Transport::production()?).await
    }

    /// The link of the node to Cloudflare, retried until it stands: the node may not be enrolled
    /// yet (the installer writes the seed), and Cloudflare may not be reachable.
    async fn link(layout: &Layout) -> (Link, LinkEvents) {
        let mut wait = Duration::from_secs(1);
        loop {
            match link_once(layout).await {
                Ok(link) => return link,
                Err(error) => {
                    emit_event(json!({"event": "link_not_started", "class": error_code(&error)}));
                    tokio::time::sleep(wait).await;
                    wait = (wait * 2).min(Duration::from_secs(60));
                }
            }
        }
    }

    async fn start(node: Arc<Node>, layout: &Layout) -> Result<Arc<Service<Node>>, Error> {
        let (link, events) = link(layout).await;
        let gateway = gateway_owner().ok_or("the gateway's user does not exist")?;
        Service::start(
            node,
            link,
            events,
            ServiceConfig {
                intervals: Intervals::default(),
                timing: Timing::default(),
                gateway: Some(gateway),
            },
        )
        .await
    }

    pub async fn run() -> Result<(), Error> {
        let layout = Layout::default();
        let node = Arc::new(Node::connect(layout.clone(), storage::Config::default()).await?);
        // What a boot lost is back before the agent is ready, link or no link.
        restore_runtime(&*node).await;
        let mut terminate = signal(SignalKind::terminate())?;
        let mut interrupt = signal(SignalKind::interrupt())?;
        notify("READY=1")?;
        let stop = async {
            tokio::select! {
                _ = terminate.recv() => {}
                _ = interrupt.recv() => {}
            }
        };
        tokio::pin!(stop);
        let service = tokio::select! {
            service = start(node, &layout) => service?,
            () = &mut stop => return Ok(()),
        };
        // The seconds since boot tell a node that restarted from an agent that did.
        let uptime = std::fs::read_to_string("/proc/uptime")
            .ok()
            .and_then(|text| uptime_seconds(&text));
        emit_event(json!({"event": "agent_started", "uptime_s": uptime}));
        tokio::select! {
            () = &mut stop => {}
            // A release that changes this binary was installed (plan 9.3): exit, and systemd
            // starts the agent from the new link.
            () = service.restart_requested() => emit_event(json!({"event": "agent_restarting"})),
        }
        // The databases run on: they are units of their own.
        service.stop();
        Ok(())
    }

    pub async fn check() -> Result<(), Error> {
        let node = Node::connect(Layout::default(), storage::Config::default()).await?;
        let account = node.scratch_account(SCRATCH).await?;
        let checked = check::run(&node, &account).await?;
        println!(
            "{}",
            json!({"event": "check", "database": SCRATCH, "created": checked.created})
        );
        Ok(())
    }
}

/// The exit code of a command. `run` tells the journal the class of a failure only, as the text
/// of an error can carry an address or a path; `check` is run by a person on the node, and what
/// failed is the point of it.
fn finish(result: Result<(), pgcf_node_agent::Error>, command: &str) -> std::process::ExitCode {
    let Err(error) = result else {
        return std::process::ExitCode::SUCCESS;
    };
    if command == "run" {
        pgcf_node_agent::timing::emit_event(serde_json::json!({
            "event": "agent_failed", "class": pgcf_node_agent::diagnostics::error_code(&error),
        }));
    } else {
        eprintln!("pgcf-agent {command}: {error}");
    }
    std::process::ExitCode::FAILURE
}

#[tokio::main]
async fn main() -> std::process::ExitCode {
    let command = std::env::args().nth(1).unwrap_or_default();
    if !matches!(command.as_str(), "run" | "check") {
        eprintln!("usage: pgcf-agent run | check");
        return std::process::ExitCode::from(2);
    }
    #[cfg(target_os = "linux")]
    let result = match command.as_str() {
        "run" => linux::run().await,
        _ => linux::check().await,
    };
    #[cfg(not(target_os = "linux"))]
    let result: Result<(), pgcf_node_agent::Error> = Err("pgcf-agent runs on Linux only".into());
    finish(result, &command)
}
