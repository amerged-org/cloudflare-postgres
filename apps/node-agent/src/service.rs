// SPDX-License-Identifier: Apache-2.0
//! The agent's loops (plan 5.6): the core on the node, and what feeds it and what it feeds. The link
//! brings the desired page, its orders and the credentials in, and takes the observations, the events,
//! the sample and the volume report out; the gateway's channel brings the wakes in; the clock
//! brings the watches of the units, of idle time and of the pool.
use crate::{
    Error,
    admission::Running,
    agent::{Core, Entry, Origin, Parts, Policy, Timing},
    archive::{
        facts,
        job::{Jobs, Runner},
        server::{Server, Table, bind as bind_archive},
    },
    credentials::Credentials,
    fence::Fences,
    gateway::{Feed, bind as bind_gateway},
    link::{Desired as Page, Link, LinkEvent, LinkEvents},
    machine::{CpuTimes, Machine},
    sample::{Inputs, busy_millicores, node_sample},
    storage::VolumeId,
    update,
};
use pgcf_native_protocol::wake::WakeRequest;
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    sync::{
        Arc, Mutex, PoisonError,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::{
    sync::{Notify, mpsc},
    task::JoinSet,
};

/// How often each loop runs. The defaults are the plan's (4.3, 4.9); tests shorten them.
#[derive(Clone, Debug)]
pub struct Intervals {
    /// The sample for placement (`NODE_SAMPLE_INTERVAL_MS`).
    pub sample: Duration,
    /// Every volume's space and inodes (`NODE_VOLUME_REPORT_INTERVAL_MS`).
    pub volumes: Duration,
    /// The usage meter's rows: what a crash of the agent can lose of awake time.
    pub usage: Duration,
    /// The thin pool (plan 4.3).
    pub pool: Duration,
    /// The whole desired page, which a message the link lost would leave unread.
    pub full_pull: Duration,
    /// Observations, events and results are posted this long after the first change, so that a
    /// burst is one request.
    pub batch: Duration,
}
impl Default for Intervals {
    fn default() -> Self {
        Self {
            sample: Duration::from_millis(
                crate::node_link::constant("NODE_SAMPLE_INTERVAL_MS")
                    .as_u64()
                    .expect("generated interval"),
            ),
            volumes: Duration::from_millis(
                crate::node_link::constant("NODE_VOLUME_REPORT_INTERVAL_MS")
                    .as_u64()
                    .expect("generated interval"),
            ),
            usage: Duration::from_secs(60),
            pool: crate::storage::POOL_SAMPLE_INTERVAL,
            full_pull: Duration::from_secs(60),
            batch: Duration::from_millis(200),
        }
    }
}

pub struct ServiceConfig {
    pub intervals: Intervals,
    pub timing: Timing,
    /// The gateway's user and group, who alone may reach the agent's channel.
    pub gateway: Option<(u32, u32)>,
}

pub struct Service<M: Machine> {
    core: Arc<Core<M>>,
    link: Link,
    machine: Arc<M>,
    intervals: Intervals,
    /// The archive credentials read, by identifier.
    delivered: Mutex<HashSet<String>>,
    /// The revision of the node's credentials the agent applied.
    credentials_revision: Mutex<Option<u64>>,
    cpu: Mutex<Option<CpuTimes>>,
    tasks: Mutex<JoinSet<()>>,
    /// The release of the newest page (plan 9.3).
    release: Mutex<Option<update::Release>>,
    /// A release is being installed.
    updating: AtomicBool,
    /// The release that was installed runs another agent: the agent restarts to run it.
    restart: Notify,
}

/// The identifiers of the archive credentials an entry of the page needs: its own, and the one
/// that reads the archive it is built from.
fn credential_ids(entry: &Entry) -> Vec<String> {
    let mut ids = vec![entry.credential_id.clone()];
    if let Some(Origin::Restore(source) | Origin::Move(source, _)) = &entry.origin {
        ids.push(source.credential_id.clone());
    }
    ids
}

/// The gateway's user and group, from `/etc/passwd`.
pub fn gateway_owner() -> Option<(u32, u32)> {
    let passwd = std::fs::read_to_string("/etc/passwd").ok()?;
    passwd.lines().find_map(|line| {
        let fields: Vec<&str> = line.split(':').collect();
        (fields.first() == Some(&"pgcf-gateway"))
            .then(|| Some((fields.get(2)?.parse().ok()?, fields.get(3)?.parse().ok()?)))
            .flatten()
    })
}

impl<M: Machine> Service<M> {
    /// Starts the agent on a node: reads the first desired page, builds the core from the node's
    /// units and the page's policy, serves the archive socket and the gateway's channel, does
    /// what a boot does, and starts the loops. Returns once the node is up; the loops run until
    /// `stop`.
    pub async fn start(
        machine: Arc<M>,
        link: Link,
        mut events: LinkEvents,
        config: ServiceConfig,
    ) -> Result<Arc<Self>, Error> {
        let layout = machine.layout().clone();
        let fences = Fences::load(layout.fences())?;
        // Nothing can be decided without the policy of the page.
        let mut wait = Duration::from_secs(1);
        let page = loop {
            match link.desired_page(None).await {
                Ok(page) => break page,
                Err(error) => {
                    crate::timing::emit_event(json!({
                        "event": "first_page_failed", "class": crate::diagnostics::error_code(&error),
                    }));
                    tokio::time::sleep(wait).await;
                    wait = (wait * 2).min(Duration::from_secs(30));
                }
            }
        };
        let policy = Policy::parse(&page.policy).ok_or("the desired page's policy is invalid")?;
        let units = machine.units().await?;
        let running: Vec<Running> = units
            .iter()
            .filter_map(|unit| Running::from_unit(unit, false))
            .collect();
        let table = Arc::new(Table::default());
        let credentials = Arc::new(Credentials::default());
        crate::link::file::create_private_directory(&layout.jobs())?;
        let jobs = Arc::new(Jobs::new(
            Runner::new(&layout.systemd_run, &layout.barman_bin, layout.jobs()),
            policy.backup.clone(),
        ));
        let gateway = Arc::new(Feed::new());
        let (core, early, resumed) = Core::new(
            Parts {
                machine: machine.clone(),
                jobs: jobs.clone(),
                table: table.clone(),
                credentials: credentials.clone(),
                gateway: gateway.clone(),
                fences,
                policy,
                timing: config.timing.clone(),
            },
            running,
        );
        let service = Arc::new(Self {
            core: core.clone(),
            link,
            machine: machine.clone(),
            intervals: config.intervals,
            delivered: Mutex::new(HashSet::new()),
            credentials_revision: Mutex::new(None),
            cpu: Mutex::new(None),
            tasks: Mutex::new(JoinSet::new()),
            release: Mutex::new(None),
            updating: AtomicBool::new(false),
            restart: Notify::new(),
        });

        // The two sockets of the agent: the archive socket for the databases' units, and the
        // gateway's channel, which only the gateway's user may reach.
        let archive = Arc::new(Server::new(table, jobs, credentials));
        let listener = bind_archive(&layout.archive_socket())?;
        let channel = bind_gateway(&layout.gateway_socket(), 0o600, config.gateway)?;
        let (wake_sender, wakes) = mpsc::unbounded_channel();
        service.spawn(async move {
            archive.serve(listener).await;
        });
        // Starts that were in flight when the agent began end with their units' answers.
        for permit in resumed {
            let (machine, database) = (machine.clone(), permit.database().to_string());
            service.spawn(async move {
                match machine.wait_started(&database).await {
                    Ok(_) => permit.ready(),
                    Err(_) => permit.failed(),
                }
            });
        }

        service.boot(&page).await;
        service.pull_page(page).await;
        // The gateway is served once the node has found what runs: its first table is then what
        // runs, and the sessions it kept across the agent's restart go on.
        core.settled(config.timing.settle).await;
        let feed = gateway.clone();
        let owner = config.gateway.map(|(uid, _)| uid);
        service.spawn(async move {
            feed.serve(channel, wake_sender, owner).await;
        });

        let s = service.clone();
        service.spawn(async move { s.follow(&mut events).await });
        let s = service.clone();
        service.spawn(async move { s.maintenance().await });
        let s = service.clone();
        service.spawn(async move { s.serve_wakes(wakes).await });
        let s = service.clone();
        service.spawn(async move { s.report().await });
        let s = service.clone();
        service.spawn(async move { s.sample().await });
        let s = service.clone();
        service.spawn(async move { s.volumes().await });
        let s = service.clone();
        service.spawn(async move { s.usage().await });
        let s = service.clone();
        service.spawn(async move { s.pool().await });
        let s = service.clone();
        service.spawn(async move { s.full_pulls().await });
        let s = service.clone();
        service.spawn(async move { s.watches().await });
        let s = service.clone();
        service.spawn(async move { s.idle().await });
        let s = service.clone();
        service.spawn(async move { s.early_sleeps(early).await });
        Ok(service)
    }

    pub fn core(&self) -> &Arc<Core<M>> {
        &self.core
    }

    /// Ends the loops and closes the agent's sockets. The databases run on: they are units of
    /// their own.
    pub fn stop(&self) {
        self.tasks
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .abort_all();
    }

    fn spawn(&self, task: impl std::future::Future<Output = ()> + Send + 'static) {
        self.tasks
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .spawn(task);
    }

    /// What the first page of a boot does (plan 5.6 job 4, 4.3): the memory ceiling of all
    /// databases and the volumes of the page's databases mounted, and again what the agent
    /// restored when it started (`restore_runtime`), now that the mounts are there.
    async fn boot(&self, page: &Page) {
        let budget = self.core.policy().admission.admission.awake_budget_mib;
        let _ = self.machine.set_slice_memory(budget).await;
        let current: Vec<VolumeId> = page
            .databases
            .iter()
            .filter_map(Entry::parse)
            .filter_map(|entry| VolumeId::new(&entry.id, entry.storage_generation).ok())
            .collect();
        match self.machine.mount_volumes(&current).await {
            Ok(failures) => {
                for (volume, error) in failures {
                    crate::timing::emit_event(json!({
                        "event": "mount_failed", "database_id": volume.database(),
                        "class": crate::diagnostics::error_code(&error.into()),
                    }));
                }
            }
            Err(error) => crate::timing::emit_event(json!({
                "event": "mount_failed", "class": crate::diagnostics::error_code(&error.into()),
            })),
        }
        crate::machine::restore_runtime(&*self.machine).await;
    }

    // ---- the link brings the page

    /// Reads the archive credentials the page's databases need and have not been read.
    async fn deliver_credentials(&self, page: &Page) {
        let wanted: Vec<String> = page
            .databases
            .iter()
            .filter_map(Entry::parse)
            .flat_map(|entry| credential_ids(&entry))
            .collect();
        for id in wanted {
            if self
                .delivered
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .contains(&id)
            {
                continue;
            }
            let delivered = match self.link.archive_credential(&id).await {
                Ok(credential) => self.core.deliver(&credential),
                Err(error) => Err(error),
            };
            match delivered {
                Ok(()) => {
                    self.delivered
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner)
                        .insert(id);
                }
                Err(error) => crate::timing::emit_event(json!({
                    "event": "credential_not_delivered",
                    "class": crate::diagnostics::error_code(&error),
                })),
            }
        }
    }

    /// The Tunnel token and the route keyring, when the page names a newer revision than the one
    /// applied: the gateway and the Tunnel start with them (plan 8).
    async fn apply_credentials(&self, page: &Page) {
        let applied = *self
            .credentials_revision
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if applied.is_some_and(|applied| applied >= page.credentials_revision) {
            return;
        }
        let credentials = match self.link.credentials().await {
            Ok(credentials) => credentials,
            Err(error) => {
                crate::timing::emit_event(json!({
                    "event": "credentials_not_read", "class": crate::diagnostics::error_code(&error),
                }));
                return;
            }
        };
        let revision = credentials["revision"].as_u64().unwrap_or(0);
        match self
            .machine
            .apply_credentials(self.link.node(), &credentials, applied.is_some())
            .await
        {
            Ok(()) => {
                *self
                    .credentials_revision
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner) = Some(revision);
            }
            Err(error) => crate::timing::emit_event(json!({
                "event": "credentials_not_applied",
                "class": crate::diagnostics::error_code(&error.into()),
            })),
        }
    }

    async fn pull_page(self: &Arc<Self>, page: Page) {
        self.deliver_credentials(&page).await;
        self.apply_credentials(&page).await;
        self.core.apply(&page).await;
        self.consider_update(&page.release);
    }

    async fn pull(self: &Arc<Self>, ids: Option<&[String]>) {
        match self.link.desired_page(ids).await {
            Ok(page) => self.pull_page(page).await,
            Err(error) => crate::timing::emit_event(json!({
                "event": "desired_pull_failed", "class": crate::diagnostics::error_code(&error),
            })),
        }
    }

    /// What Cloudflare asks: a pull of the page, or the fence (after which the page holds the
    /// fence order and the link ends).
    async fn follow(self: &Arc<Self>, events: &mut LinkEvents) {
        while let Some(event) = events.next().await {
            match event {
                LinkEvent::Desired(ids) => self.pull(ids.as_deref()).await,
                LinkEvent::Fenced => {}
            }
        }
    }

    /// The whole page again at an interval: a message the link lost is made up for.
    async fn full_pulls(self: &Arc<Self>) {
        let mut tick = tokio::time::interval(self.intervals.full_pull);
        tick.tick().await;
        loop {
            tick.tick().await;
            self.pull(None).await;
        }
    }

    // ---- updates (plan 9.3)

    /// The release of the page: if the node does not run it, it is installed, in the background.
    fn consider_update(self: &Arc<Self>, page_release: &Value) {
        let Some(release) = update::Release::parse(page_release) else {
            return;
        };
        *self.release.lock().unwrap_or_else(PoisonError::into_inner) = Some(release.clone());
        let bin = self.machine.layout().bin();
        if update::current_release(&bin).as_deref() == Some(release.id.as_str())
            || self.updating.swap(true, Ordering::AcqRel)
        {
            return;
        }
        let service = self.clone();
        self.spawn(async move {
            service.install(&release, &bin).await;
            service.updating.store(false, Ordering::Release);
        });
    }

    /// Installs the release's binaries, and restarts what runs one that changed: the gateway
    /// (its sessions reconnect) and then the agent, which exits and is started by systemd from the
    /// new link. The databases keep running: they are units of their own.
    async fn install(&self, release: &update::Release, bin: &std::path::Path) {
        let link = self.link.clone();
        let switched = update::install_binaries(bin, release, |pinned, path| {
            let link = link.clone();
            async move {
                link.fetch(&pinned.url, pinned.size_bytes, &pinned.sha256, &path)
                    .await
            }
        })
        .await;
        let switched = match switched {
            Ok(switched) => switched,
            Err(error) => {
                crate::timing::emit_event(json!({
                    "event": "release_not_installed", "release": release.id,
                    "class": crate::diagnostics::error_code(&error),
                }));
                return;
            }
        };
        crate::timing::emit_event(json!({"event": "release_installed", "release": release.id}));
        if switched.gateway
            && let Err(error) = self.machine.restart_service("pgcf-gateway.service").await
        {
            crate::timing::emit_event(json!({
                "event": "gateway_not_restarted", "class": crate::diagnostics::error_code(&error.into()),
            }));
        }
        if switched.agent {
            self.restart.notify_one();
        }
    }

    /// Completes when the agent has to restart to run the release it installed. The caller stops
    /// the service and exits; systemd starts the new binary.
    pub async fn restart_requested(&self) {
        self.restart.notified().await;
    }

    /// The maintenance orders whose databases sleep: their packages, their reboot and their check.
    async fn maintenance(&self) {
        loop {
            self.core.slept_signal.notified().await;
            for operation in self.core.take_slept() {
                match self.cycle().await {
                    // The node reboots: the page lists the order until it is answered, and the
                    // agent that starts after the boot finds the packages in place.
                    Ok(true) => {}
                    Ok(false) => {
                        self.report_os().await;
                        match self.machine.health_check().await {
                            Ok(()) => self.core.report_order(&operation, Ok(())),
                            Err(_) => self.core.report_order(&operation, Err("check_failed")),
                        }
                    }
                    Err(reason) => self.core.report_order(&operation, Err(reason)),
                }
            }
        }
    }

    /// The packages may have changed without a reboot: the next hello of the link names the
    /// digest of what is installed now (SEC-03). After a reboot the agent starts again and says it.
    async fn report_os(&self) {
        let reported = match crate::machine::os_report(&*self.machine).await {
            Ok(os) => self.link.set_os(&os),
            Err(error) => Err(error),
        };
        if let Err(error) = reported {
            crate::timing::emit_event(json!({
                "event": "os_not_reported", "class": crate::diagnostics::error_code(&error),
            }));
        }
    }

    /// Brings the packages to the lock of the release (plan 9.3): what the node lacks or has in
    /// another version is installed, and `true` is returned if the node reboots for it.
    async fn cycle(&self) -> Result<bool, &'static str> {
        let release = self
            .release
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
            .ok_or("release_missing")?;
        let work = self.machine.layout().agent().join("packages");
        let outcome = self.install_packages(&release, &work).await;
        let _ = std::fs::remove_dir_all(&work);
        outcome
    }
    async fn install_packages(
        &self,
        release: &update::Release,
        work: &std::path::Path,
    ) -> Result<bool, &'static str> {
        let _ = std::fs::remove_dir_all(work);
        crate::link::file::create_private_directory(work).map_err(|_| "packages_not_installed")?;
        let lock = work.join("packages.lock.json");
        let pinned = &release.package_lock;
        self.link
            .fetch(&pinned.url, pinned.size_bytes, &pinned.sha256, &lock)
            .await
            .map_err(|_| "lock_not_read")?;
        let lock = std::fs::read(&lock)
            .ok()
            .and_then(|bytes| update::Lock::parse(&bytes))
            .ok_or("lock_not_read")?;
        let installed = self
            .machine
            .installed_packages()
            .await
            .map_err(|_| "packages_not_read")?;
        let plan = update::plan(&lock, &installed);
        if plan.versions.is_empty() && plan.files.is_empty() {
            return Ok(false);
        }
        let mut files = Vec::new();
        for package in &plan.files {
            let path = work.join(format!("{}.deb", package.name));
            self.link
                .fetch(
                    &package.pinned.url,
                    package.pinned.size_bytes,
                    &package.pinned.sha256,
                    &path,
                )
                .await
                .map_err(|_| "package_not_read")?;
            files.push(path);
        }
        self.machine
            .install_packages(&release.debian_snapshot, &plan.versions, &files)
            .await
            .map_err(|_| "packages_not_installed")?;
        if plan.reboot {
            self.machine.reboot().await.map_err(|_| "reboot_failed")?;
        }
        Ok(plan.reboot)
    }

    // ---- the gateway brings the wakes

    async fn serve_wakes(self: &Arc<Self>, mut wakes: mpsc::UnboundedReceiver<WakeRequest>) {
        while let Some(request) = wakes.recv().await {
            let service = self.clone();
            tokio::spawn(async move {
                // A database the page does not name yet: it is pulled once, as the page may be
                // ahead of the node.
                if service.core.find(&request.database).is_none() {
                    service
                        .pull(Some(std::slice::from_ref(&request.database)))
                        .await;
                }
                let result = service.core.wake(&request).await;
                service.core.gateway.wake_result(result);
            });
        }
    }

    // ---- the node reports

    /// Posts what the core queued: the observations and results, and the events.
    async fn report(&self) {
        let mut wait = self.intervals.batch;
        loop {
            self.core.changed.notified().await;
            tokio::time::sleep(self.intervals.batch).await;
            while let Some(report) = self.core.take_report() {
                match self.link.post_observation(&report).await {
                    Ok(()) => wait = self.intervals.batch,
                    Err(error) => {
                        crate::timing::emit_event(json!({
                            "event": "observation_not_posted",
                            "class": crate::diagnostics::error_code(&error),
                        }));
                        self.core.unsent(&report);
                        tokio::time::sleep(wait).await;
                        wait = (wait * 2).min(Duration::from_secs(30));
                        break;
                    }
                }
            }
            let events = self.core.take_events();
            if !events.is_empty() {
                let _ = self.link.queue_events(&events);
            }
        }
    }

    /// The sample for placement every 15 s (plan 4.9).
    async fn sample(&self) {
        let mut tick = tokio::time::interval(self.intervals.sample);
        loop {
            tick.tick().await;
            self.post_sample().await;
        }
    }

    pub(crate) async fn post_sample(&self) {
        let Some(memory) = self.machine.memory() else {
            return;
        };
        let Some(times) = self.machine.cpu() else {
            return;
        };
        let busy = {
            let mut previous = self.cpu.lock().unwrap_or_else(PoisonError::into_inner);
            let busy = busy_millicores(*previous, times);
            *previous = Some(times);
            busy
        };
        let inventory = self.machine.inventory().await.ok();
        let pool = self.machine.poll_pool().await.ok();
        let Some(awake) = self.core.admission.snapshot().await else {
            return;
        };
        let (total, mounted) = inventory.as_ref().map_or((0, 0), |inventory| {
            (
                inventory.volumes.len() as u64,
                inventory.volumes.iter().filter(|v| v.mounted()).count() as u64,
            )
        });
        let sample = node_sample(&Inputs {
            now_ms: crate::agent::now_ms(),
            memory,
            busy_millicores: busy,
            cores: times.cores,
            pool: pool
                .as_ref()
                .zip(inventory.as_ref())
                .map(|(pool, inventory)| (pool, inventory.nominal_bytes)),
            room: self.machine.room(&self.core.policy().storage).is_ok(),
            volumes_total: total,
            volumes_mounted: mounted,
            archive: self.core.archive_summary(),
            awake: &awake,
            credentials_revision: *self
                .credentials_revision
                .lock()
                .unwrap_or_else(PoisonError::into_inner),
        });
        if let Err(error) = self.link.post_samples(&sample).await {
            crate::timing::emit_event(json!({
                "event": "sample_not_posted", "class": crate::diagnostics::error_code(&error),
            }));
        }
    }

    /// Every volume's space and inodes every 60 s (plan 4.3).
    async fn volumes(&self) {
        let mut tick = tokio::time::interval(self.intervals.volumes);
        loop {
            tick.tick().await;
            self.post_volumes().await;
        }
    }

    pub(crate) async fn post_volumes(&self) {
        let Ok(inventory) = self.machine.inventory().await else {
            return;
        };
        let report = json!({
            "observed_at": facts::timestamp(crate::agent::now_ms()),
            "volumes": inventory.volumes.iter().map(|volume| volume.to_contract()).collect::<Vec<Value>>(),
        });
        if let Err(error) = self.link.post_volumes(&report).await {
            crate::timing::emit_event(json!({
                "event": "volumes_not_posted", "class": crate::diagnostics::error_code(&error),
            }));
        }
    }

    /// The usage rows: what each database used since the last tick, queued for Cloudflare.
    async fn usage(&self) {
        let mut tick = tokio::time::interval(self.intervals.usage);
        loop {
            tick.tick().await;
            self.queue_usage().await;
        }
    }

    pub(crate) async fn queue_usage(&self) {
        if let Err(error) = self
            .core
            .meter_tick(|rows| self.link.queue_usage(rows))
            .await
        {
            crate::timing::emit_event(json!({
                "event": "usage_not_queued", "class": crate::diagnostics::error_code(&error),
            }));
        }
    }

    /// The thin pool every 5 s, for the room rule.
    async fn pool(&self) {
        let mut tick = tokio::time::interval(self.intervals.pool);
        loop {
            tick.tick().await;
            let _ = self.machine.poll_pool().await;
        }
    }

    /// The units that ended on their own. A loop of its own: an idle check that waits for the
    /// gateway, or a sleep that waits for the archive, never holds it up.
    async fn watches(&self) {
        let mut tick = tokio::time::interval(self.core.timing.watch);
        loop {
            tick.tick().await;
            self.core.watch_pass().await;
        }
    }

    /// The databases nobody uses.
    async fn idle(&self) {
        let mut tick = tokio::time::interval(self.core.timing.idle_poll);
        loop {
            tick.tick().await;
            self.core.idle_pass().await;
        }
    }

    /// The databases to put to sleep early for the wakes that wait (plan 4.7).
    async fn early_sleeps(&self, mut early: mpsc::UnboundedReceiver<crate::admission::EarlySleep>) {
        while let Some(order) = early.recv().await {
            let core = self.core.clone();
            tokio::spawn(async move { core.early_sleep(order).await });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        agent::testing::{FakeGateway, eventually, new_entry_json, site, timing},
        link::{
            LinkConfig, Timing as LinkTiming, Transport,
            test_server::{Cloud, tempdir},
        },
        node_link::contract_valid,
    };
    use pgcf_native_protocol::{
        agent::{Mode, ToGateway},
        wake::Outcome,
    };

    fn quick() -> Intervals {
        Intervals {
            sample: Duration::from_millis(300),
            volumes: Duration::from_millis(300),
            usage: Duration::from_millis(300),
            pool: Duration::from_millis(300),
            full_pull: Duration::from_secs(30),
            batch: Duration::from_millis(50),
        }
    }
    fn observed(cloud: &crate::link::test_server::Cloud, id: &str, state: &str) -> bool {
        cloud
            .acknowledged("/node/v1/observations")
            .iter()
            .flat_map(|report| report["databases"].as_array().cloned().unwrap_or_default())
            .any(|db| db["id"] == id && db["state"] == state)
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn the_agent_builds_reports_sleeps_and_wakes_a_database_for_a_cloud_and_a_gateway() {
        let Some((machine, _fixture, _root)) =
            site("service", &|root| root.join("r/agent/archive.sock"))
        else {
            return;
        };
        let cloud = Cloud::start().await;
        let base = tempdir();
        cloud.seed(&base);
        let (link, events) = Link::start(
            LinkConfig {
                paths: crate::link::Paths::new(&base),
                image_version: "25".into(),
                agent_version: "0.1.0".into(),
                release_id: None,
                os: crate::machine::os_report(&*machine).await.unwrap(),
                timing: LinkTiming {
                    interval: Duration::from_millis(300),
                    ..LinkTiming::default()
                },
            },
            Transport::new(cloud.roots()).unwrap(),
        )
        .await
        .unwrap();
        let mut db = new_entry_json();
        let id = db["id"].as_str().unwrap().to_string();
        let credential = db["archive"]["credential"]["id"]
            .as_str()
            .unwrap()
            .to_string();
        let path = db["archive"]["path"].as_str().unwrap().to_string();
        cloud.with(|inner| {
            inner.databases = vec![db.clone()];
            inner.credential_paths.insert(credential, path);
        });
        let service = Service::start(
            machine.clone(),
            link,
            events,
            ServiceConfig {
                intervals: quick(),
                timing: timing(),
                gateway: None,
            },
        )
        .await
        .unwrap();

        // The page's database is built, and the cloud is told it is ready, with its first backup.
        eventually(90, "the cloud to be told the database is ready", || {
            observed(&cloud, &id, "ready")
        })
        .await;
        // The sample for placement, the volume report and the events arrive, each as the contract states
        // (the double refuses what does not); the node applied its credentials.
        eventually(30, "the sample, the volumes and the events", || {
            !cloud.with(|inner| inner.samples.clone()).is_empty()
                && !cloud.acknowledged("/node/v1/volumes").is_empty()
                && cloud
                    .acknowledged("/node/v1/events")
                    .iter()
                    .flat_map(|report| report["events"].as_array().cloned().unwrap_or_default())
                    .any(|event| event["type"] == "admission" && event["start"] == "create")
        })
        .await;
        let sample = cloud.with(|inner| inner.samples.last().cloned()).unwrap();
        assert!(
            contract_valid("NodeSample", &sample["sample"])
                || contract_valid("NodeSample", &sample)
        );
        assert_eq!(
            machine.credentials_applied(),
            [(
                "eu-dev".to_string(),
                crate::link::test_server::NODE_ID.to_string(),
                3,
                false
            )]
        );
        assert_eq!(machine.slice_memory_mib(), Some(9913));
        // The database is served, and the meter says for how long.
        eventually(30, "the usage of the served database", || {
            cloud
                .acknowledged("/node/v1/usage")
                .iter()
                .flat_map(|report| report["rows"].as_array().cloned().unwrap_or_default())
                .any(|row| row["database"] == id && row["awake_ms"].as_u64() > Some(0))
        })
        .await;

        // The page suspends it, and the cloud is told that it sleeps with its proof.
        let mut gateway = FakeGateway::connect(&machine.layout().gateway_socket()).await;
        db.as_object_mut().unwrap().remove("origin");
        db["desired_state"] = serde_json::json!("suspended");
        db["generation"] = serde_json::json!(5);
        db["operation"] = serde_json::json!("op_dddddddddddddddddddd");
        cloud.with(|inner| inner.databases = vec![db.clone()]);
        cloud.push(serde_json::json!({"type": "desired", "ids": [id]}));
        eventually(60, "the cloud to be told the database sleeps", || {
            observed(&cloud, &id, "asleep")
        })
        .await;
        assert!(!machine.running(&id));

        // A connection wakes it: the gateway's ticket is answered with the table entry first and
        // then the result.
        db["desired_state"] = serde_json::json!("running");
        db["generation"] = serde_json::json!(6);
        db["operation"] = serde_json::json!("op_eeeeeeeeeeeeeeeeeeee");
        cloud.with(|inner| inner.databases = vec![db.clone()]);
        cloud.push(serde_json::json!({"type": "desired", "ids": [id]}));
        let entry = crate::agent::Entry::parse(&db).unwrap();
        eventually(30, "the node to know the running entry", || {
            service.core().find(&id).is_some_and(|handle| {
                handle
                    .view()
                    .entry
                    .as_ref()
                    .is_some_and(|e| e.generation == 6)
            })
        })
        .await;
        let mut ticket = crate::agent::testing::Rig::ticket(&entry);
        ticket.operation = "op_wwwwwwwwwwwwwwwwwwww".into();
        gateway.send_wake(ticket.clone()).await;
        eventually(60, "the result of the wake", || {
            gateway.received().iter().any(|message| {
                matches!(message, ToGateway::WakeResult { result } if result.outcome == Outcome::Started)
            })
        })
        .await;
        let modes: Vec<Mode> = gateway
            .received()
            .iter()
            .filter_map(|message| match message {
                ToGateway::Database { database } if database.database == id => Some(database.mode),
                _ => None,
            })
            .collect();
        assert!(modes.ends_with(&[Mode::Running]), "{modes:?}");
        assert!(machine.running(&id));
        eventually(
            30,
            "the cloud to be told it runs at the claimed generation",
            || {
                cloud
                    .acknowledged("/node/v1/observations")
                    .iter()
                    .flat_map(|report| report["databases"].as_array().cloned().unwrap_or_default())
                    .any(|db| db["id"] == id && db["state"] == "ready" && db["generation"] == 7)
            },
        )
        .await;
        drop(service);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_restarted_agent_tells_the_gateway_what_runs_before_anything_else() {
        let Some((machine, _fixture, _root)) =
            site("restart-gateway", &|root| root.join("r/agent/archive.sock"))
        else {
            return;
        };
        let cloud = Cloud::start().await;
        let base = tempdir();
        cloud.seed(&base);
        let link = || async {
            Link::start(
                LinkConfig {
                    paths: crate::link::Paths::new(&base),
                    image_version: "25".into(),
                    agent_version: "0.1.0".into(),
                    release_id: None,
                    os: crate::machine::os_report(&*machine).await.unwrap(),
                    timing: LinkTiming {
                        interval: Duration::from_millis(300),
                        ..LinkTiming::default()
                    },
                },
                Transport::new(cloud.roots()).unwrap(),
            )
            .await
            .unwrap()
        };
        let config = || ServiceConfig {
            intervals: quick(),
            timing: timing(),
            gateway: None,
        };
        let db = new_entry_json();
        let id = db["id"].as_str().unwrap().to_string();
        let credential = db["archive"]["credential"]["id"]
            .as_str()
            .unwrap()
            .to_string();
        let path = db["archive"]["path"].as_str().unwrap().to_string();
        cloud.with(|inner| {
            inner.databases = vec![db.clone()];
            inner.credential_paths.insert(credential, path);
        });
        let (first, events) = link().await;
        let service = Service::start(machine.clone(), first, events, config())
            .await
            .unwrap();
        eventually(90, "the database to be ready", || {
            observed(&cloud, &id, "ready")
        })
        .await;
        let writer = service.core().find(&id).unwrap().view().writer.clone();
        assert!(writer.is_some());

        // The agent stops and starts again; its database runs on, and so do the gateway's
        // sessions: the gateway, which connects again as soon as it can, is never told that the
        // database sleeps or is gone, which would end them.
        service.stop();
        drop(service);
        assert!(machine.running(&id));
        let (second, events) = link().await;
        let starting = tokio::spawn(Service::start(machine.clone(), second, events, config()));
        let gateway = FakeGateway::connect(&machine.layout().gateway_socket()).await;
        let service = starting.await.unwrap().unwrap();
        eventually(30, "the gateway to have the table", || {
            !gateway.received().is_empty()
        })
        .await;
        let received = gateway.received();
        let ToGateway::Table { databases } = &received[0] else {
            panic!("the first message is the table: {received:?}");
        };
        let entry = databases.iter().find(|entry| entry.database == id);
        assert_eq!(
            entry.map(|entry| (entry.mode, entry.writer.clone())),
            Some((Mode::Running, writer)),
            "{received:?}"
        );
        assert!(
            !received.iter().any(|message| matches!(
                message,
                ToGateway::Database { database } if database.database == id && database.mode != Mode::Running
            ) || matches!(message, ToGateway::Removed { database } if database == &id)),
            "{received:?}"
        );
        service.stop();
    }

    // ---- updates (plan 9.3)

    fn digest(bytes: &[u8]) -> String {
        use sha2::{Digest, Sha256};
        crate::update::hex(&Sha256::digest(bytes))
    }
    /// The files the node runs, in `bin/<id>/`, and the `current` link to them.
    fn runs(machine: &crate::machine::local::Local, id: &str, files: &[(&str, &[u8])]) {
        let bin = machine.layout().state.join("bin");
        std::fs::create_dir_all(bin.join(id)).unwrap();
        for (name, bytes) in files {
            std::fs::write(bin.join(id).join(name), bytes).unwrap();
        }
        let _ = std::fs::remove_file(bin.join("current"));
        std::os::unix::fs::symlink(bin.join(id), bin.join("current")).unwrap();
    }
    /// The release `id` as the page names it: its binaries served by the double, and the package
    /// lock, which is `lock` (served too).
    fn release_of(cloud: &Cloud, id: &str, files: &[(&str, &[u8])], lock: &[u8]) -> Value {
        let pin = |name: &str, bytes: &[u8]| {
            let url = cloud.serve_file(&format!("/files/{id}/{name}"), bytes.to_vec());
            json!({"url": url, "sha256": digest(bytes), "size_bytes": bytes.len()})
        };
        let binaries: serde_json::Map<String, Value> = files
            .iter()
            .map(|(name, bytes)| (name.to_string(), pin(name, bytes)))
            .collect();
        json!({
            "id": id, "binaries": binaries,
            "os": {"image_version": "25", "debian_snapshot": "20261016T000000Z",
                   "package_lock": pin("packages.lock.json", lock)}
        })
    }
    const NAMES: [&str; 4] = [
        "pgcf-agent",
        "pgcf-native-gateway",
        "pgcf-archive",
        "pgcf-wal-fetch",
    ];
    fn same(bytes: &'static [u8]) -> Vec<(&'static str, &'static [u8])> {
        NAMES.iter().map(|name| (*name, bytes)).collect()
    }
    /// The agent on `machine`, linked as the node that keeps its identity under `base`.
    async fn serve(
        machine: &Arc<crate::machine::local::Local>,
        cloud: &Cloud,
        base: &std::path::Path,
    ) -> Arc<Service<crate::machine::local::Local>> {
        cloud.seed(base);
        let (link, events) = Link::start(
            LinkConfig {
                paths: crate::link::Paths::new(base),
                image_version: "25".into(),
                agent_version: "0.1.0".into(),
                release_id: None,
                os: crate::machine::os_report(&**machine).await.unwrap(),
                timing: LinkTiming {
                    interval: Duration::from_millis(300),
                    ..LinkTiming::default()
                },
            },
            Transport::new(cloud.roots()).unwrap(),
        )
        .await
        .unwrap();
        Service::start(
            machine.clone(),
            link,
            events,
            ServiceConfig {
                intervals: quick(),
                timing: timing(),
                gateway: None,
            },
        )
        .await
        .unwrap()
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_new_release_is_downloaded_checked_and_switched_to_and_what_runs_it_restarts() {
        let Some((machine, _fixture, _root)) =
            site("update", &|root| root.join("r/agent/archive.sock"))
        else {
            return;
        };
        runs(&machine, "r0", &same(b"old"));
        let cloud = Cloud::start().await;
        // r1 changes the agent and the gateway, and not the archive clients.
        let mut files = same(b"old");
        files[0].1 = b"new agent";
        files[1].1 = b"new gateway";
        let release = release_of(&cloud, "r1", &files, b"{}");
        cloud.with(|inner| inner.release = Some(release));
        let base = tempdir();
        let service = serve(&machine, &cloud, &base).await;

        let bin = machine.layout().state.join("bin");
        eventually(30, "the link to move to r1", || {
            crate::update::current_release(&bin).as_deref() == Some("r1")
        })
        .await;
        for (name, bytes) in &files {
            assert_eq!(
                &std::fs::read(bin.join("current").join(name)).unwrap(),
                bytes
            );
        }
        // The gateway restarts, the agent asks for its own restart, and the old release stays.
        eventually(10, "the gateway to restart", || {
            machine
                .calls()
                .contains(&"restart pgcf-gateway.service".to_string())
        })
        .await;
        tokio::time::timeout(Duration::from_secs(10), service.restart_requested())
            .await
            .expect("the agent asks to be restarted");
        assert!(bin.join("r0").exists());
        assert!(
            machine
                .calls()
                .iter()
                .all(|call| !call.contains("cloudflared")),
            "{:?}",
            machine.calls()
        );
        service.stop();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_maintenance_order_installs_what_the_lock_pins_checks_the_node_and_reports() {
        let Some((machine, _fixture, _root)) =
            site("maintenance", &|root| root.join("r/agent/archive.sock"))
        else {
            return;
        };
        runs(&machine, "r1", &same(b"bin"));
        machine.set_packages(&[
            ("bash", "5.2"),
            ("postgresql-18", "18.6-1"),
            ("cloudflared", "2026.10.0"),
        ]);
        let before = crate::update::packages_digest(&machine.installed_packages().await.unwrap());
        let cloud = Cloud::start().await;
        let deb = b"cloudflared 2026.10.1".to_vec();
        let url = cloud.serve_file("/files/cloudflared.deb", deb.clone());
        let lock = json!({
            "packages": [
                {"name": "bash", "version": "5.2", "architecture": "amd64", "url": "https://snapshot.example/bash.deb", "size": 10, "sha256": "a".repeat(64)},
                {"name": "postgresql-18", "version": "18.7-1", "architecture": "amd64", "url": "https://snapshot.example/pg.deb", "size": 10, "sha256": "b".repeat(64)},
            ],
            "extra": [
                {"name": "cloudflared", "version": "2026.10.1", "architecture": "amd64", "url": url, "size": deb.len(), "sha256": digest(&deb)},
            ],
        })
        .to_string();
        let release = release_of(&cloud, "r1", &same(b"bin"), lock.as_bytes());
        let operation = "op_mmmmmmmmmmmmmmmmmmmm";
        cloud.with(|inner| {
            inner.release = Some(release);
            inner.orders = vec![json!({"type": "maintenance", "operation": operation})];
        });
        let base = tempdir();
        let service = serve(&machine, &cloud, &base).await;

        eventually(60, "the order to be reported", || {
            cloud
                .acknowledged("/node/v1/observations")
                .iter()
                .flat_map(|report| report["orders"].as_array().cloned().unwrap_or_default())
                .any(|order| order["operation"] == operation && order["status"] == "done")
        })
        .await;
        // The pinned versions are installed from the release's snapshot, the extra package as the
        // file it downloaded, and the node is checked afterwards. No reboot: no kernel changed.
        let calls = machine.calls();
        let at = |what: &str| calls.iter().position(|call| call.starts_with(what));
        assert!(
            calls.contains(
                &"install 20261016T000000Z postgresql-18=18.7-1 + cloudflared.deb".to_string()
            ),
            "{calls:?}"
        );
        assert!(
            at("install").unwrap() < at("health_check").unwrap(),
            "{calls:?}"
        );
        assert!(at("reboot").is_none(), "{calls:?}");
        // The packages changed and the node did not boot again: the hello says the digest of what
        // is installed now, on the link that was up or on a new one, and no hello says another boot.
        let after = crate::update::packages_digest(&machine.installed_packages().await.unwrap());
        assert_ne!(after, before);
        eventually(30, "the new packages to be said", || {
            cloud.with(|inner| {
                inner
                    .hellos
                    .iter()
                    .any(|hello| hello["os"]["packages_sha256"] == after.as_str())
            })
        })
        .await;
        let hellos = cloud.with(|inner| inner.hellos.clone());
        assert!(
            hellos
                .iter()
                .all(|hello| hello["os"]["boot_id"] == hellos[0]["os"]["boot_id"]),
            "{hellos:?}"
        );
        service.stop();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_lock_that_is_not_the_pinned_one_installs_nothing_and_fails_the_order() {
        let Some((machine, _fixture, _root)) = site("maintenance-lock", &|root| {
            root.join("r/agent/archive.sock")
        }) else {
            return;
        };
        runs(&machine, "r1", &same(b"bin"));
        machine.set_packages(&[("bash", "5.1")]);
        let cloud = Cloud::start().await;
        let lock = json!({"packages": [
            {"name": "bash", "version": "5.2", "architecture": "amd64", "url": "https://snapshot.example/bash.deb", "size": 10, "sha256": "a".repeat(64)},
        ], "extra": []})
        .to_string();
        let release = release_of(&cloud, "r1", &same(b"bin"), lock.as_bytes());
        // What the URL serves is not what the page pinned.
        let url = release["os"]["package_lock"]["url"].as_str().unwrap();
        cloud.serve_file(
            url.strip_prefix(&cloud.url("")).unwrap(),
            lock.replace("5.2", "9.9"),
        );
        let operation = "op_llllllllllllllllllll";
        cloud.with(|inner| {
            inner.release = Some(release);
            inner.orders = vec![json!({"type": "maintenance", "operation": operation})];
        });
        let base = tempdir();
        let service = serve(&machine, &cloud, &base).await;
        eventually(60, "the order to be answered", || {
            cloud
                .acknowledged("/node/v1/observations")
                .iter()
                .flat_map(|report| report["orders"].as_array().cloned().unwrap_or_default())
                .any(|order| {
                    order["operation"] == operation
                        && order["status"] == "failed"
                        && order["reason"] == "lock_not_read"
                })
        })
        .await;
        assert!(
            machine
                .calls()
                .iter()
                .all(|call| !call.starts_with("install"))
        );
        service.stop();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_kernel_takes_a_reboot_and_the_order_is_answered_after_it() {
        let Some((machine, _fixture, _root)) = site("maintenance-kernel", &|root| {
            root.join("r/agent/archive.sock")
        }) else {
            return;
        };
        runs(&machine, "r1", &same(b"bin"));
        machine.set_packages(&[("bash", "5.2")]);
        let booted = machine.boot().unwrap().id;
        let cloud = Cloud::start().await;
        let lock = json!({
            "packages": [
                {"name": "bash", "version": "5.2", "architecture": "amd64", "url": "https://snapshot.example/bash.deb", "size": 10, "sha256": "a".repeat(64)},
                {"name": "linux-image-6.12.99-amd64", "version": "6.12.99-1", "architecture": "amd64", "url": "https://snapshot.example/k.deb", "size": 10, "sha256": "c".repeat(64)},
            ],
            "extra": [],
        })
        .to_string();
        let release = release_of(&cloud, "r1", &same(b"bin"), lock.as_bytes());
        let operation = "op_kkkkkkkkkkkkkkkkkkkk";
        cloud.with(|inner| {
            inner.release = Some(release);
            inner.orders = vec![json!({"type": "maintenance", "operation": operation})];
        });
        // How the order was answered, once it was.
        let answer = || {
            cloud
                .acknowledged("/node/v1/observations")
                .iter()
                .flat_map(|report| report["orders"].as_array().cloned().unwrap_or_default())
                .find(|order| order["operation"] == operation)
                .map(|order| order["status"].clone())
        };
        let base = tempdir();
        let service = serve(&machine, &cloud, &base).await;
        eventually(60, "the node to reboot", || {
            machine.calls().contains(&"reboot".to_string())
        })
        .await;
        // The node is going down: nothing is checked, and the order is not answered.
        tokio::time::sleep(Duration::from_millis(500)).await;
        assert!(!machine.calls().contains(&"health_check".to_string()));
        assert_eq!(answer(), None);
        service.stop();

        // After the boot the page still lists the order. The packages are the lock's now, so
        // nothing is installed and the node does not reboot again; it is checked and answers.
        machine.clear_calls();
        let service = serve(&machine, &cloud, &base).await;
        eventually(60, "the order to be answered", || answer().is_some()).await;
        assert_eq!(answer(), Some(json!("done")));
        // The agent that started after the boot says another boot, the kernel the lock named and
        // the lock's packages: what the API compares with the release.
        let digest = crate::update::packages_digest(&machine.installed_packages().await.unwrap());
        eventually(30, "the new boot to be said", || {
            cloud.with(|inner| {
                inner.hellos.iter().any(|hello| {
                    let os = &hello["os"];
                    os["boot_id"] != booted.as_str()
                        && os["kernel_release"] == "6.12.99-amd64"
                        && os["packages_sha256"] == digest.as_str()
                })
            })
        })
        .await;
        let calls = machine.calls();
        assert!(calls.contains(&"health_check".to_string()), "{calls:?}");
        assert!(
            calls
                .iter()
                .all(|call| !call.starts_with("install") && call != "reboot"),
            "{calls:?}"
        );
        service.stop();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_gateway_that_does_not_answer_keeps_no_crash_from_being_found() {
        use tokio::io::{AsyncBufReadExt, BufReader};
        let Some((machine, _fixture, _root)) =
            site("watch-silent", &|root| root.join("r/agent/archive.sock"))
        else {
            return;
        };
        let cloud = Cloud::start().await;
        let base = tempdir();
        cloud.seed(&base);
        let (link, events) = Link::start(
            LinkConfig {
                paths: crate::link::Paths::new(&base),
                image_version: "25".into(),
                agent_version: "0.1.0".into(),
                release_id: None,
                os: crate::machine::os_report(&*machine).await.unwrap(),
                timing: LinkTiming {
                    interval: Duration::from_millis(300),
                    ..LinkTiming::default()
                },
            },
            Transport::new(cloud.roots()).unwrap(),
        )
        .await
        .unwrap();
        let db = new_entry_json();
        let id = db["id"].as_str().unwrap().to_string();
        let credential = db["archive"]["credential"]["id"]
            .as_str()
            .unwrap()
            .to_string();
        let path = db["archive"]["path"].as_str().unwrap().to_string();
        cloud.with(|inner| {
            inner.databases = vec![db.clone()];
            inner.credential_paths.insert(credential, path);
        });
        let service = Service::start(
            machine.clone(),
            link,
            events,
            ServiceConfig {
                intervals: quick(),
                timing: timing(),
                gateway: None,
            },
        )
        .await
        .unwrap();
        let handle = service.core().find(&id).unwrap();
        eventually(90, "ready", || handle.phase() == crate::agent::Phase::Ready).await;

        // A gateway that reads the agent's requests and answers none: each idle check of the
        // database waits for it in vain.
        let stream = tokio::net::UnixStream::connect(machine.layout().gateway_socket())
            .await
            .unwrap();
        let mut lines = BufReader::new(stream).lines();
        loop {
            let line = lines.next_line().await.unwrap().unwrap();
            if matches!(
                pgcf_native_protocol::agent::decode_to_gateway(line.as_bytes()),
                Ok(ToGateway::Activity { .. })
            ) {
                break;
            }
        }
        // The postmaster dies while an idle check waits: the watch of the units finds it at once.
        machine.crash(&id);
        eventually(2, "the crash to be found", || {
            handle.phase() != crate::agent::Phase::Ready
        })
        .await;
        service.stop();
    }
}
