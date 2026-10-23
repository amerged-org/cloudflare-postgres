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
//!
//! `pgcf-agent hold` is the one process of `pgcf-mounts.service`, which `run` starts and whose
//! mount namespace it joins, so that the volumes it mounts outlive it (`mount_holder`).

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
        machine::{Node, WARM_BOUND, os_report, restore_runtime, warm_start_path},
        mount_holder,
        notify::notify,
        release,
        sample::uptime_seconds,
        service::{
            Intervals, START_FAILURE_PAUSE, Service, ServiceConfig, gateway_owner,
            pause_after_failed_start,
        },
        storage,
        timing::{self, emit_event},
        units::slots,
        update,
    };
    use serde_json::json;
    use std::{sync::Arc, time::Duration};
    use tokio::{
        signal::unix::{SignalKind, signal},
        task::JoinSet,
    };

    /// What the agent gets from Cloudflare before it can decide on anything: the link, its events
    /// and the first desired page.
    type Linked = (Link, LinkEvents, pgcf_node_agent::link::Desired);

    /// One attempt to enroll, if the node is not, and to start the link.
    async fn link_once(node: &Node, layout: &Layout) -> Result<(Link, LinkEvents), Error> {
        let image_version = release::this_image_version().ok_or("the image has no version")?;
        let config = LinkConfig {
            paths: Paths::new(layout.state.clone()),
            image_version,
            agent_version: env!("CARGO_PKG_VERSION").into(),
            release_id: release::release_id(&layout.bin().join("current")),
            os: os_report(node).await?,
            timing: LinkTiming::default(),
        };
        let link = Link::start(config, Transport::production()?).await?;
        // Beside the row: the link is started while the storage opens.
        timing::phase_once("link_started");
        Ok(link)
    }

    /// The link of the node to Cloudflare, retried until it stands: the node may not be enrolled
    /// yet (the installer writes the seed), and Cloudflare may not be reachable.
    async fn link(node: &Node, layout: &Layout) -> (Link, LinkEvents) {
        let mut wait = Duration::from_secs(1);
        loop {
            match link_once(node, layout).await {
                Ok(link) => return link,
                Err(error) => {
                    emit_event(json!({"event": "link_not_started", "class": error_code(&error)}));
                    tokio::time::sleep(wait).await;
                    wait = (wait * 2).min(Duration::from_secs(60));
                }
            }
        }
    }

    /// The link and the first page, asked for as the agent starts: they need the node's boot and
    /// packages (`os_report`) and nothing of its storage, which takes seconds to open with
    /// hundreds of volumes (EU1: 1.8 s of the 2.9 s to the first page).
    async fn linked(node: Arc<Node>, layout: Layout) -> Linked {
        let (link, events) = link(&node, &layout).await;
        let page = Service::<Node>::first_page(&link).await;
        (link, events, page)
    }

    async fn start(
        node: Arc<Node>,
        linking: &mut JoinSet<Linked>,
    ) -> Result<Arc<Service<Node>>, Error> {
        let (link, events, page) = linking
            .join_next()
            .await
            .ok_or("the link was not started")?
            .map_err(|error| Error::from(error.to_string()))?;
        timing::phase("linked");
        let gateway = gateway_owner().ok_or("the gateway's user does not exist")?;
        Service::start_with_page(
            node,
            link,
            events,
            page,
            ServiceConfig {
                intervals: Intervals::default(),
                timing: Timing::default(),
                gateway: Some(gateway),
                release_key: update::RELEASE_KEY,
            },
        )
        .await
    }

    /// Joins the namespace of the volumes' holder, before the first thread exists (`setns(2)` of a
    /// mount namespace is refused in a process with threads).
    pub fn join_mounts() {
        let layout = Layout::default();
        let agent = layout.bin().join("current").join("pgcf-agent");
        match mount_holder::join(&layout, &agent) {
            Ok(_) => emit_event(json!({"event": "mount_holder_joined"})),
            Err(class) => {
                emit_event(json!({"event": "mount_holder_unavailable", "class": class}));
            }
        }
    }

    /// The agent's exit: the mounts it made go before the process does, many at once, where the
    /// kernel would end them one by one with the namespace. Where the holder has the namespace
    /// they stay, with their page cache, for the next agent.
    async fn release(node: &Node) {
        if !mount_holder::held() {
            node.release_mounts().await;
        }
    }

    pub async fn run() -> Result<(), Error> {
        let result = serve().await;
        if let Err(error) = &result {
            emit_event(json!({"event": "agent_failed", "class": error_code(error)}));
            // systemd starts the next process 100 ms after this one ends: a start that fails is
            // not tried again at that pace (`pause_after_failed_start`). A stop ends the pause.
            let stop = async {
                if let (Ok(mut terminate), Ok(mut interrupt)) = (
                    signal(SignalKind::terminate()),
                    signal(SignalKind::interrupt()),
                ) {
                    tokio::select! {
                        _ = terminate.recv() => {}
                        _ = interrupt.recv() => {}
                    }
                }
            };
            pause_after_failed_start(START_FAILURE_PAUSE, stop).await;
        }
        result
    }

    async fn serve() -> Result<(), Error> {
        timing::phase("process_start");
        let layout = Layout::default();
        let node = Arc::new(
            Node::connect_unopened(layout.clone(), storage::Config::default(), slots::POOL).await?,
        );
        // Cloudflare is asked while the storage opens. A set, so that a start that fails ends the
        // link with it.
        let mut linking = JoinSet::new();
        linking.spawn(linked(node.clone(), layout.clone()));
        node.open_storage().await?;
        timing::phase("storage_open");
        // The volumes the agent before mounted are unmounted with its namespace: so are their links.
        node.reset_device_links().await?;
        timing::phase("device_links");
        // What a boot lost is back before the agent is ready, link or no link.
        restore_runtime(&*node).await;
        timing::phase("restore_runtime");
        // After a boot the first wake would read its start path from the disk: have it cached in
        // the background, while the agent gets ready.
        let warm = node.clone();
        tokio::spawn(async move {
            if let Err(error) = warm_start_path(&*warm, WARM_BOUND).await {
                emit_event(json!({
                    "event": "start_path_not_warmed", "class": error_code(&error.into()),
                }));
            }
        });
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
            service = start(node.clone(), &mut linking) => service?,
            () = &mut stop => {
                release(&node).await;
                return Ok(());
            }
        };
        // The seconds since boot tell a node that restarted from an agent that did.
        let uptime = std::fs::read_to_string("/proc/uptime")
            .ok()
            .and_then(|text| uptime_seconds(&text));
        timing::phase("service_started");
        emit_event(json!({"event": "agent_started", "uptime_s": uptime}));
        tokio::select! {
            () = &mut stop => {}
            // A release that changes this binary was installed (plan 9.3): exit, and systemd
            // starts the agent from the new link.
            () = service.restart_requested() => emit_event(json!({"event": "agent_restarting"})),
        }
        // The databases run on: they are units of their own.
        service.stop();
        release(&node).await;
        Ok(())
    }

    pub async fn hold() -> Result<(), Error> {
        mount_holder::hold().await
    }

    pub async fn check() -> Result<(), Error> {
        // Before anything is made: the scratch volume is mounted in this process's namespace.
        pgcf_node_agent::machine::refuse_init_mount_namespace(
            std::path::Path::new("/proc/self/ns/mnt"),
            std::path::Path::new("/proc/1/ns/mnt"),
        )?;
        let node = Node::connect(
            Layout::default(),
            storage::Config::default(),
            slots::CHECK_SLOT..slots::CHECK_SLOT + 1,
        )
        .await?;
        let account = node.scratch_account(SCRATCH).await?;
        let checked = check::run(&node, &account).await?;
        println!(
            "{}",
            json!({"event": "check", "database": SCRATCH, "created": checked.created, "slot": checked.slot})
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
    // On Linux `run` has said `agent_failed` with the class and has waited (`linux::run`).
    if command != "run" || cfg!(not(target_os = "linux")) {
        eprintln!("pgcf-agent {command}: {error}");
    }
    std::process::ExitCode::FAILURE
}

fn main() -> std::process::ExitCode {
    let command = std::env::args().nth(1).unwrap_or_default();
    if !matches!(command.as_str(), "run" | "check" | "hold") {
        eprintln!("usage: pgcf-agent run | check | hold");
        return std::process::ExitCode::from(2);
    }
    // Before the runtime, which starts the threads: the mount namespace cannot be joined after.
    #[cfg(target_os = "linux")]
    if command == "run" {
        linux::join_mounts();
    }
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("pgcf-agent {command}: {error}");
            return std::process::ExitCode::FAILURE;
        }
    };
    #[cfg(target_os = "linux")]
    let result = runtime.block_on(async {
        match command.as_str() {
            "run" => linux::run().await,
            "hold" => linux::hold().await,
            _ => linux::check().await,
        }
    });
    #[cfg(not(target_os = "linux"))]
    let result: Result<(), pgcf_node_agent::Error> = {
        let _ = &runtime;
        Err("pgcf-agent runs on Linux only".into())
    };
    finish(result, &command)
}
