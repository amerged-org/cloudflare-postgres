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
    diagnostics::probe,
    fence::Fences,
    gateway::{Feed, bind as bind_gateway},
    hostfiles,
    link::{Desired as Page, Link, LinkEvent, LinkEvents},
    machine::{CpuTimes, Machine},
    sample::{Inputs, busy_millicores, node_sample},
    storage::VolumeId,
    update,
};
use pgcf_native_protocol::wake::WakeRequest;
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    sync::{
        Arc, Mutex, PoisonError,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
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
    /// The key that signs releases (`update::RELEASE_KEY`, which the agent's build holds). A test
    /// signs its releases with a key of its own; the binary has no other source for it.
    pub release_key: [u8; 32],
}

/// The credentials the agent applied: their revision, and a digest of what the gateway and the
/// Tunnel run on (the route keyring and the Tunnel token), kept instead of the secrets themselves.
#[derive(Clone)]
struct AppliedCredentials {
    revision: u64,
    secrets: [u8; 32],
}

/// The digest of the secrets of `NodeCredentials` that the gateway and the Tunnel run on. The
/// revision and the shell's key are not among them: a change of those restarts nothing.
fn gateway_secrets(credentials: &Value) -> [u8; 32] {
    use sha2::{Digest, Sha256};
    let secrets = json!({
        "tunnel_token": credentials["tunnel_token"],
        "route_keyring": credentials["route_keyring"],
    });
    Sha256::digest(secrets.to_string().as_bytes()).into()
}

/// The wait before the next try of what failed, which doubles up to a longest wait.
#[derive(Default)]
struct Retry {
    wait: Option<Duration>,
    until: Option<Instant>,
}
impl Retry {
    fn due(&self) -> bool {
        self.until.is_none_or(|until| Instant::now() >= until)
    }
    fn failed(&mut self, first: Duration, longest: Duration) {
        let wait = self.wait.map_or(first, |wait| (wait * 2).min(longest));
        self.wait = Some(wait);
        self.until = Some(Instant::now() + wait);
    }
    fn reset(&mut self) {
        *self = Self::default();
    }
}

pub struct Service<M: Machine> {
    core: Arc<Core<M>>,
    link: Link,
    machine: Arc<M>,
    intervals: Intervals,
    /// The archive credentials read, by identifier.
    delivered: Mutex<HashSet<String>>,
    /// The credentials the agent applied, if it has applied any since it started.
    credentials: Mutex<Option<AppliedCredentials>>,
    cpu: Mutex<Option<CpuTimes>>,
    tasks: Mutex<JoinSet<()>>,
    /// The release of the newest page (plan 9.3).
    release: Mutex<Option<update::Release>>,
    /// The digest of the host files list that the disk was last found to hold whole and that
    /// systemd was told of: a page that names the same list reads nothing from the disk.
    host_files_held: Mutex<Option<String>>,
    /// When the next try to tell systemd what the host files need may be made, after one failed:
    /// a page does not repeat a restart that has just failed.
    host_files_retry: Mutex<Retry>,
    /// The release whose host files this agent's own rules refused and that was reported, so that
    /// the refusal is one event however many pages name the release.
    refused_files: Mutex<Option<update::Release>>,
    /// The key a release must be signed with, and the verdict on the release last checked: a
    /// release is trusted only when this says so (`verified`).
    release_key: [u8; 32],
    verdict: Mutex<Option<(update::Release, Result<(), update::ReleaseRefusal>)>>,
    /// The probes an administrator asked for that the agent has answered or is running (SEC-09).
    probes: probe::Answered,
    /// A release is being installed.
    updating: AtomicBool,
    /// The release that was installed runs another agent: the agent restarts to run it.
    restart: Notify,
    /// The agent's binary was replaced and this process is about to leave: whatever is left to do
    /// for the release is for the agent that starts from the new link.
    superseded: AtomicBool,
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
            credentials: Mutex::new(None),
            cpu: Mutex::new(None),
            tasks: Mutex::new(JoinSet::new()),
            release: Mutex::new(None),
            host_files_held: Mutex::new(None),
            host_files_retry: Mutex::new(Retry::default()),
            refused_files: Mutex::new(None),
            release_key: config.release_key,
            verdict: Mutex::new(None),
            probes: probe::Answered::load(layout.agent().join("probes-done")),
            updating: AtomicBool::new(false),
            restart: Notify::new(),
            superseded: AtomicBool::new(false),
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
        // The agent's mounts of the volumes are made first: a start that was in flight when the
        // agent began reads its database's `postmaster.pid` through them, and the namespace of the
        // agent before is gone with its mounts.
        service.boot(&page).await;
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
        service.pull_page(page).await;
        // The link stands: the previous boot's journal goes to Cloudflare, if there was a boot.
        let s = service.clone();
        service.spawn(async move { s.report_boot().await });
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
    /// restored when it started (`restore_runtime`), now that the mounts are there. The mounts
    /// are the agent's own, in its mount namespace, which a restart of the agent ends: it makes
    /// them all again, so a node serves no wake before they are made (databases that run are not
    /// touched: their units have mounts of their own).
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
    /// applied: the gateway and the Tunnel start with them (plan 8). The revision also rises when
    /// only the operator shell's state changed; the gateway and the Tunnel restart for a change of
    /// their own secrets alone, because a restart ends every client connection of the node.
    async fn apply_credentials(&self, page: &Page) {
        let applied = self
            .credentials
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        if applied
            .as_ref()
            .is_some_and(|applied| applied.revision >= page.credentials_revision)
        {
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
        let secrets = gateway_secrets(&credentials);
        let restart = applied
            .as_ref()
            .is_some_and(|applied| applied.secrets != secrets);
        match self
            .machine
            .apply_credentials(self.link.node(), &credentials, restart)
            .await
        {
            Ok(()) => {
                *self
                    .credentials
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner) =
                    Some(AppliedCredentials { revision, secrets });
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
        self.answer_probes(&page);
        self.consider_update(&page.release);
    }

    /// The probes an administrator asked for (SEC-09): each request of the page that the agent has
    /// not answered and is not running starts now, in the background, and its result goes to
    /// Cloudflare. A page lists a request until Cloudflare has its result, so a result that did not
    /// arrive runs again with the next page.
    fn answer_probes(self: &Arc<Self>, page: &Page) {
        for request in &page.diagnostics {
            if !self.probes.begin(&request.id) {
                continue;
            }
            let (service, request) = (self.clone(), request.clone());
            self.spawn(async move {
                let result = probe::run(&*service.machine, &request).await;
                let sent = service.link.post_probe(&result).await;
                service.probes.end(&request.id, sent.is_ok());
                crate::timing::emit_event(match sent {
                    Ok(()) => json!({"event": "probe_answered", "probe": request.probe.name()}),
                    Err(error) => json!({
                        "event": "probe_not_sent", "probe": request.probe.name(),
                        "class": crate::diagnostics::error_code(&error),
                    }),
                });
            });
        }
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

    /// The release of the page: if the node does not run it, or does not hold its host files, it is
    /// installed, in the background.
    fn consider_update(self: &Arc<Self>, page_release: &Value) {
        let Some(release) = update::Release::parse(page_release) else {
            return;
        };
        *self.release.lock().unwrap_or_else(PoisonError::into_inner) = Some(release.clone());
        let bin = self.machine.layout().bin();
        let binaries = update::current_release(&bin).as_deref() == Some(release.id.as_str());
        let files = self
            .host_files_held
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .as_deref()
            == Some(release.host_files_digest().as_str());
        if (binaries && files)
            || self.superseded.load(Ordering::Acquire)
            || self.updating.swap(true, Ordering::AcqRel)
        {
            return;
        }
        let service = self.clone();
        self.spawn(async move {
            service.update(&release, &bin).await;
            service.updating.store(false, Ordering::Release);
        });
    }

    /// Brings the node to the release (plan 9.3). The order is one rule: the binaries first, the
    /// host files after them, and the files are written by the agent that runs the release's own
    /// binary. A release whose agent changed is therefore installed by the agent that runs before
    /// it, which then leaves; the agent that starts from the new link finds the binaries current
    /// and writes the files. The new agent knows what the new files are for (a unit that it makes
    /// links for, a socket it serves), and the old agent never writes a file for a release it does
    /// not run. A release whose agent did not change gets its files straight after its binaries.
    async fn update(&self, release: &update::Release, bin: &std::path::Path) {
        if update::current_release(bin).as_deref() != Some(release.id.as_str())
            && !self.install(release, bin).await
        {
            return;
        }
        self.host_files(release).await;
    }

    /// Whether the release key signed `release` (plan 8, 9.3): nothing of a release is downloaded,
    /// staged or installed, and no package of its lock is planned, before this says so. The signature
    /// is the file the API serves beside the binaries. The verdict on the release last checked is
    /// kept, so that the signature is read once however many pages name the release. The error
    /// names the class: a refusal of the contract (`RELEASE_REFUSALS`), reported once as the event
    /// `release_refused`, or `signature_not_read` when the API could not be asked, which is not
    /// kept and is tried again.
    async fn verified(&self, release: &update::Release) -> Result<(), &'static str> {
        if let Some((checked, verdict)) =
            &*self.verdict.lock().unwrap_or_else(PoisonError::into_inner)
            && checked == release
        {
            return verdict.map_err(update::ReleaseRefusal::code);
        }
        let verdict = match self.read_signature(release).await {
            Ok(Some(signature)) => update::verify(&self.release_key, release, &signature),
            Ok(None) => Err(update::ReleaseRefusal::SignatureMissing),
            Err(error) => {
                crate::timing::emit_event(json!({
                    "event": "release_not_installed", "release": release.id,
                    "class": crate::diagnostics::error_code(&error),
                }));
                return Err("signature_not_read");
            }
        };
        if let Err(refusal) = verdict {
            crate::timing::emit_event(json!({
                "event": "release_refused", "release": release.id, "class": refusal.code(),
            }));
        }
        *self.verdict.lock().unwrap_or_else(PoisonError::into_inner) =
            Some((release.clone(), verdict));
        verdict.map_err(update::ReleaseRefusal::code)
    }

    /// The signature the API serves for the release: `None` if it serves none (404, or no place to
    /// ask for it).
    async fn read_signature(&self, release: &update::Release) -> Result<Option<Vec<u8>>, Error> {
        let Some(url) = release.signature_url() else {
            return Ok(None);
        };
        match self
            .link
            .fetch_bytes(&url, update::SIGNATURE_MAX_BYTES)
            .await
        {
            Ok(signature) => Ok(Some(signature)),
            Err(error)
                if error
                    .downcast_ref::<crate::api::Refusal>()
                    .is_some_and(|refusal| refusal.status == 404) =>
            {
                Ok(None)
            }
            Err(error) => Err(error),
        }
    }

    /// Installs the release's binaries, and restarts what runs one that changed: the gateway
    /// (its sessions reconnect) and then the agent, which exits and is started by systemd from the
    /// new link. The databases keep running: they are units of their own. A release that the key
    /// did not sign is not touched: the node keeps what it runs. It answers whether the binaries
    /// are in place and this agent is the one that runs them, so that the host files may follow.
    async fn install(&self, release: &update::Release, bin: &std::path::Path) -> bool {
        if self.verified(release).await.is_err() {
            return false;
        }
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
                return false;
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
            self.superseded.store(true, Ordering::Release);
            self.restart.notify_one();
        }
        !switched.agent
    }

    /// Writes the release's host files (`hostfiles`, plan 9.3) once the binaries are in place and
    /// the release key has signed the release, and the agent's own rules have passed the list. The
    /// rules are held here, by the agent that writes, and not with the signature: an agent whose
    /// rules are older than the release (a unit it has no name for, a way to take effect it does
    /// not know) installs the binaries, which may carry the agent that knows them, and refuses the
    /// files with the class of the rule, once. Then the files are written, systemd is told what
    /// that needs (the tools of sysusers and tmpfiles, one reload, the restarts with the agent's
    /// own last), and the digest of what the disk holds is reported. What differs on the disk is
    /// written, nothing else: a second call, and a call after a crash at any point, ends in the
    /// same state. The agent's own unit stands in `/run` until the agent that runs it has read its
    /// first page (`hostfiles::promote`).
    async fn host_files(&self, release: &update::Release) {
        if self.superseded.load(Ordering::Acquire) || self.verified(release).await.is_err() {
            return;
        }
        if let Err(refusal) = hostfiles::check(&release.host_files) {
            let mut reported = self
                .refused_files
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            if reported.as_ref() != Some(release) {
                crate::timing::emit_event(json!({
                    "event": "release_refused", "release": release.id, "class": refusal.code(),
                }));
                *reported = Some(release.clone());
            }
            return;
        }
        let layout = self.machine.layout();
        let (root, path) = (layout.host_root.clone(), layout.host_files());
        let boot = self.machine.boot().map(|boot| boot.id).unwrap_or_default();
        let target = hostfiles::Target {
            root: &root,
            state: &path,
            boot_id: &boot,
        };
        let failed = |class: String| {
            crate::timing::emit_event(json!({
                "event": "host_files_not_applied", "release": release.id, "class": class,
            }));
        };
        let held = hostfiles::State::load(&path);
        let plan = match hostfiles::plan(&root, &held, &release.host_files) {
            Ok(plan) => plan,
            Err(error) => return failed(crate::diagnostics::error_code(&error.into())),
        };
        let recorded = held.files == release.host_files && held.release == release.id;
        let mut changed = !plan.is_empty() || !recorded;
        if changed {
            let bytes = match self.fetch_host_files(release, &plan).await {
                Ok(bytes) => bytes,
                Err(class) => return failed(class),
            };
            match hostfiles::apply(
                &target,
                &release.id,
                &release.host_files,
                &plan,
                &bytes,
                &mut |_| Ok(()),
            ) {
                Ok(applied) if applied.written + applied.removed > 0 => {
                    // New work for systemd is not held back by the wait that an old failure set.
                    self.retry().reset();
                    crate::timing::emit_event(json!({
                        "event": "host_files_applied", "release": release.id,
                        "written": applied.written, "removed": applied.removed,
                    }));
                }
                Ok(_) => {}
                Err(error) => return failed(crate::diagnostics::error_code(&error.into())),
            }
        }
        // The agent's own unit has stood in `/run` since before this process started if the plan
        // found it there, so this process runs it, has read this page and may let it stay through
        // a boot. Not while its own restart is still owed (a crash between the write and the
        // reload leaves this process on the old unit), and never in a process about to leave.
        // Whatever else is left for systemd does not hold it back: that is no proof against it.
        if let Some(file) = &plan.staged
            && !self.superseded.load(Ordering::Acquire)
            && !hostfiles::State::load(&path)
                .restarts
                .iter()
                .any(|unit| unit == hostfiles::AGENT_UNIT)
        {
            match hostfiles::promote(&target, file, &mut |_| Ok(())) {
                Ok(()) => {
                    crate::timing::emit_event(json!({
                        "event": "agent_unit_promoted", "release": release.id,
                    }));
                    changed = true;
                }
                Err(error) => return failed(crate::diagnostics::error_code(&error.into())),
            }
        }
        // What an earlier apply began and a crash or a failure left is finished here as well,
        // unless the last try failed a moment ago.
        let pending = hostfiles::State::load(&path).unfinished(&boot);
        if pending && !self.retry().due() {
            return;
        }
        changed |= pending;
        if let Err(class) = self.finish_host_files(&path, &boot).await {
            return failed(class);
        }
        if changed {
            self.report_os().await;
        }
        *self
            .host_files_held
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = Some(release.host_files_digest());
    }

    fn retry(&self) -> std::sync::MutexGuard<'_, Retry> {
        self.host_files_retry
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    /// The bytes of the files `plan` writes, each read from the API by its digest and checked
    /// against the size and the sha256 of the signed page, by their digest.
    async fn fetch_host_files(
        &self,
        release: &update::Release,
        plan: &hostfiles::Plan,
    ) -> Result<HashMap<String, Vec<u8>>, String> {
        let mut bytes = HashMap::new();
        let work = self.machine.layout().agent().join("host-files");
        let _ = std::fs::remove_dir_all(&work);
        if plan
            .writes
            .iter()
            .all(|file| file.kind != hostfiles::Kind::File)
        {
            return Ok(bytes);
        }
        crate::link::file::create_private_directory(&work)
            .map_err(|error| crate::diagnostics::error_code(&error.into()))?;
        for file in plan
            .writes
            .iter()
            .filter(|file| file.kind == hostfiles::Kind::File)
        {
            let url = release
                .host_file_url(&file.sha256)
                .ok_or("host_file_not_read")?;
            let path = work.join(&file.sha256);
            self.link
                .fetch(&url, file.size_bytes, &file.sha256, &path)
                .await
                .map_err(|_| "host_file_not_read")?;
            bytes.insert(
                file.sha256.clone(),
                std::fs::read(&path).map_err(|_| "host_file_not_read")?,
            );
        }
        let _ = std::fs::remove_dir_all(&work);
        Ok(bytes)
    }

    /// What systemd has to be told after host files were written, in the order the record keeps:
    /// the tools on the files that say so (the users and directories a unit may need), then one
    /// reload, then each unit that runs one that changed, the agent's own last, by leaving. The
    /// tools come first because a unit with `Restart=always` that crashes after the reload comes
    /// back under its new definition at once, and its user and directories must be there by then.
    /// Each step is taken out of the record when it is done, so a failure or a crash between two
    /// of them is picked up by the next call, and a later step never runs before an earlier one:
    /// the reload and the restarts wait for the tools. One unit that fails to restart does not
    /// keep the others from it: each is tried, the failures stay in the record, and the next try
    /// waits (`Retry`), so that a page does not repeat a restart that has just failed. What a boot
    /// has already done is dropped (`State::begin`).
    async fn finish_host_files(&self, path: &std::path::Path, boot: &str) -> Result<(), String> {
        let mut state = hostfiles::State::load(path);
        state.begin(boot);
        let timing = &self.core.timing;
        let class = |error: Error| crate::diagnostics::error_code(&error);
        let saved = |state: &hostfiles::State| {
            state
                .save(path)
                .map_err(|_| "host_files_not_finished".to_string())
        };
        let failed = |class: String| {
            self.retry()
                .failed(timing.host_files_retry, timing.host_files_retry_maximum);
            Err(class)
        };
        if !state.reload && state.runs.is_empty() && state.restarts.is_empty() {
            return Ok(());
        }
        let mut failure = None;
        for run in state.runs.clone() {
            let result = match run.tool {
                hostfiles::Tool::Sysusers => self.machine.run_sysusers(&run.path).await,
                hostfiles::Tool::Tmpfiles => self.machine.run_tmpfiles(&run.path).await,
            };
            match result {
                Ok(()) => {
                    state.runs.retain(|held| *held != run);
                    saved(&state)?;
                }
                Err(error) => {
                    failure.get_or_insert_with(|| class(error.into()));
                }
            }
        }
        if let Some(failure) = failure {
            return failed(failure);
        }
        if state.reload {
            if let Err(error) = self.machine.daemon_reload().await {
                return failed(class(error.into()));
            }
            state.reload = false;
            saved(&state)?;
        }
        let (units, agent) = hostfiles::restart_order(&state);
        for unit in units {
            match self.machine.restart_service(&unit).await {
                Ok(()) => {
                    state.restarts.retain(|restarted| *restarted != unit);
                    saved(&state)?;
                }
                Err(error) => {
                    failure.get_or_insert_with(|| class(error.into()));
                }
            }
        }
        if agent {
            state.restarts.retain(|unit| unit != hostfiles::AGENT_UNIT);
            saved(&state)?;
            // What is left for the release is for the agent that starts from the unit.
            self.superseded.store(true, Ordering::Release);
            self.restart.notify_one();
        }
        if let Some(failure) = failure {
            return failed(failure);
        }
        self.retry().reset();
        Ok(())
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
                let outcome = self.cycle().await;
                // A cycle that failed may have installed part of the set or all of it before the
                // reboot failed: only the boot of a node that reboots says what it holds.
                if !matches!(outcome, Ok(true)) {
                    self.report_os().await;
                }
                match outcome {
                    // The node reboots: the page lists the order until it is answered, and the
                    // agent that starts after the boot finds the packages in place, purges what
                    // the lock dropped, checks the node and answers.
                    Ok(true) => {}
                    Ok(false) => match self.machine.health_check().await {
                        Ok(()) => self.core.report_order(&operation, Ok(())),
                        Err(_) => self.core.report_order(&operation, Err("check_failed")),
                    },
                    Err(reason) => self.core.report_order(&operation, Err(reason)),
                }
            }
        }
    }

    /// After a boot, the tail of the previous boot's journal (SEC-05). A node that stopped
    /// answering has no shell to tell why. A report that Cloudflare could not take (the network, an
    /// API that is unavailable or limiting) is sent again with a doubling wait: the API keeps one
    /// report for a boot, so a report whose answer was lost is safe to send again. Any other
    /// failure ends the attempt for this start.
    async fn report_boot(&self) {
        let timing = &self.core.timing;
        let mut wait = timing.report_retry;
        loop {
            let Err(error) =
                crate::diagnostics::boot_report::report_boot(&*self.machine, &self.link).await
            else {
                return;
            };
            crate::timing::emit_event(json!({
                "event": "boot_report_not_sent", "class": crate::diagnostics::error_code(&error),
            }));
            if !crate::link::transient(&error) {
                return;
            }
            tokio::time::sleep(wait).await;
            wait = (wait * 2).min(timing.report_retry_maximum);
        }
    }

    /// The packages may have changed without a reboot, in a cycle that ended or failed: the next
    /// hello of the link names the digest of what is installed now (SEC-03). After a reboot the
    /// agent starts again and says it.
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
    /// another version is installed, and `true` is returned if the node reboots for it. What the
    /// lock no longer names is purged by the cycle that has nothing to install, so after the boot
    /// where there is one.
    async fn cycle(&self) -> Result<bool, &'static str> {
        let release = self
            .release
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
            .ok_or("release_missing")?;
        // The lock names what apt installs as root: the key must have signed the release first.
        self.verified(&release).await?;
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
        let mut installed = self
            .machine
            .installed_packages()
            .await
            .map_err(|_| "packages_not_read")?;
        let plan = update::plan(&lock, &installed);
        if !(plan.versions.is_empty() && plan.files.is_empty()) {
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
            // Nothing that can fail comes between the install of a kernel and its boot: the order
            // stays open, and the cycle that runs after the boot finds nothing to install, purges,
            // checks and answers.
            if plan.reboot {
                self.machine.reboot().await.map_err(|_| "reboot_failed")?;
                return Ok(true);
            }
            // Apt may have replaced or removed packages: the purge follows what is installed now.
            installed = self
                .machine
                .installed_packages()
                .await
                .map_err(|_| "packages_not_read")?;
        }
        let stale = update::purgeable(&lock, &installed);
        if !stale.is_empty() {
            self.machine
                .purge_packages(&stale)
                .await
                .map_err(|_| "packages_not_installed")?;
        }
        Ok(false)
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

    /// Posts what the core queued: the observations and results, and the events. The events of
    /// the agent's log wake it as well, so that a node whose databases do not change reports them.
    async fn report(&self) {
        let events = crate::events::global();
        let mut wait = self.intervals.batch;
        loop {
            tokio::select! {
                () = self.core.changed.notified() => {}
                () = events.due() => {}
            }
            tokio::time::sleep(self.intervals.batch).await;
            while let Some(report) = self.core.take_report(events) {
                match self.link.post_observation(&report).await {
                    Ok(()) => {
                        wait = self.intervals.batch;
                        self.core.report_posted();
                    }
                    Err(error) => {
                        crate::timing::emit_event(json!({
                            "event": "observation_not_posted",
                            "class": crate::diagnostics::error_code(&error),
                            "databases": report["databases"].as_array().map_or(0, Vec::len),
                            "status": error
                                .downcast_ref::<crate::api::Refusal>()
                                .map_or(0, |refusal| refusal.status),
                        }));
                        self.core.unsent(events, &report);
                        self.core.report_failed(&error);
                        tokio::time::sleep(wait).await;
                        wait = (wait * 2).min(Duration::from_secs(30));
                        break;
                    }
                }
            }
            let queued = self.core.take_events();
            if !queued.is_empty() {
                let _ = self.link.queue_events(&queued);
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
            credentials_revision: self
                .credentials
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .as_ref()
                .map(|applied| applied.revision),
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

    const SHELL_CA: &str =
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDNcY+bgo/xfpIZts7k+ekO/ruRsypcSnZW0qomRI8bp";

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
    #[test]
    fn a_change_of_the_shell_or_the_revision_alone_does_not_restart_the_gateway_and_a_change_of_its_secrets_does()
     {
        let credentials = |revision: u64, token: &str, key: &str, shell: Option<&str>| {
            let mut credentials = json!({
                "revision": revision,
                "tunnel_token": token,
                "route_keyring": {"active": "k1", "keys": {"k1": key}},
            });
            if let Some(shell) = shell {
                credentials["shell_ca_public_key"] = shell.into();
            }
            credentials
        };
        let base = gateway_secrets(&credentials(3, "token-a", "key-a", None));
        // The revision and the shell's key are not secrets of the gateway or the Tunnel.
        assert_eq!(
            base,
            gateway_secrets(&credentials(4, "token-a", "key-a", None))
        );
        assert_eq!(
            base,
            gateway_secrets(&credentials(
                5,
                "token-a",
                "key-a",
                Some("ssh-ed25519 AAAA")
            ))
        );
        // The Tunnel's token and any key of the route keyring are.
        assert_ne!(
            base,
            gateway_secrets(&credentials(3, "token-b", "key-a", None))
        );
        assert_ne!(
            base,
            gateway_secrets(&credentials(3, "token-a", "key-b", None))
        );
        let rotated = json!({
            "revision": 3, "tunnel_token": "token-a",
            "route_keyring": {"active": "k2", "keys": {"k1": "key-a", "k2": "key-b"}},
        });
        assert_ne!(base, gateway_secrets(&rotated));
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
                release_key: test_release_key(),
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
        // The operator shell is turned on: the revision rises and the credentials carry the CA's
        // key, and the gateway and the Tunnel are not restarted. A new Tunnel token restarts them.
        let applied = |revision: u64, restart: bool| {
            (
                "eu-dev".to_string(),
                crate::link::test_server::NODE_ID.to_string(),
                revision,
                restart,
            )
        };
        let mut credentials = crate::link::test_server::vector("NodeCredentials", "credentials");
        credentials["revision"] = 4.into();
        credentials["shell_ca_public_key"] = SHELL_CA.into();
        cloud.with(|inner| inner.credentials = Some(credentials.clone()));
        cloud.push(serde_json::json!({"type": "desired", "ids": [id]}));
        eventually(30, "the credentials of the shell", || {
            machine.credentials_applied().len() == 2
        })
        .await;
        assert_eq!(machine.credentials_applied()[1], applied(4, false));
        credentials["revision"] = 5.into();
        credentials["tunnel_token"] = "eyJ".repeat(40).into();
        cloud.with(|inner| inner.credentials = Some(credentials.clone()));
        cloud.push(serde_json::json!({"type": "desired", "ids": [id]}));
        eventually(30, "the credentials of a new Tunnel token", || {
            machine.credentials_applied().len() == 3
        })
        .await;
        assert_eq!(machine.credentials_applied()[2], applied(5, true));
        // The shell turned off again: a revision and no key, and again nothing restarts.
        credentials["revision"] = 6.into();
        credentials
            .as_object_mut()
            .unwrap()
            .remove("shell_ca_public_key");
        cloud.with(|inner| inner.credentials = Some(credentials.clone()));
        cloud.push(serde_json::json!({"type": "desired", "ids": [id]}));
        eventually(30, "the credentials without the shell", || {
            machine.credentials_applied().len() == 4
        })
        .await;
        assert_eq!(machine.credentials_applied()[3], applied(6, false));
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
            release_key: test_release_key(),
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
    /// A key pair for the signatures of a test; nothing of the private half is kept.
    fn throwaway_key() -> ring::signature::Ed25519KeyPair {
        let pkcs8 =
            ring::signature::Ed25519KeyPair::generate_pkcs8(&ring::rand::SystemRandom::new())
                .unwrap();
        ring::signature::Ed25519KeyPair::from_pkcs8(pkcs8.as_ref()).unwrap()
    }
    /// The release key of the tests: made once for the test process, which the agents of the
    /// tests are built with (`ServiceConfig::release_key`) and which signs the releases of
    /// `release_of`.
    fn test_key() -> &'static ring::signature::Ed25519KeyPair {
        static KEY: std::sync::LazyLock<ring::signature::Ed25519KeyPair> =
            std::sync::LazyLock::new(throwaway_key);
        &KEY
    }
    fn test_release_key() -> [u8; 32] {
        use ring::signature::KeyPair;
        test_key().public_key().as_ref().try_into().unwrap()
    }
    /// The URL path under which the double serves the signature of `release` (a page's release).
    fn signature_path(cloud: &Cloud, release: &Value) -> String {
        let url = update::Release::parse(release)
            .unwrap()
            .signature_url()
            .unwrap();
        url.strip_prefix(&cloud.url("")).unwrap().to_string()
    }
    /// Serves the signature that `key` makes of the release, where the agent reads it.
    fn sign_release(cloud: &Cloud, release: &Value, key: &ring::signature::Ed25519KeyPair) {
        let manifest = update::Release::parse(release).unwrap().manifest();
        cloud.serve_file(
            &signature_path(cloud, release),
            update::hex(key.sign(&manifest).as_ref()),
        );
    }
    /// A host file of a release as the tests state it: its path, its content (`None` for a mask),
    /// its mode and how it takes effect.
    type Host<'a> = (&'a str, Option<&'a str>, &'a str, &'a str);
    /// What a release carries when a test is not about host files: one file that needs a reload.
    const DEFAULT_HOST: [Host<'static>; 1] = [(
        "/etc/sysctl.d/90-test.conf",
        Some("kernel.panic = 10\n"),
        "0644",
        "daemon_reload",
    )];
    /// The release `id` as the page names it: its binaries served by the double, and the package
    /// lock, which is `lock` (served too), and its signature by the key of the tests.
    fn release_of(cloud: &Cloud, id: &str, files: &[(&str, &[u8])], lock: &[u8]) -> Value {
        release_with(cloud, id, files, lock, &DEFAULT_HOST)
    }
    /// The same with the host files of the release, ascending by path, each served by its digest
    /// beside the binaries, where the agent reads it.
    fn release_with(
        cloud: &Cloud,
        id: &str,
        files: &[(&str, &[u8])],
        lock: &[u8],
        host: &[Host],
    ) -> Value {
        let pin = |name: &str, bytes: &[u8]| {
            let url = cloud.serve_file(&format!("/files/{id}/{name}"), bytes.to_vec());
            json!({"url": url, "sha256": digest(bytes), "size_bytes": bytes.len()})
        };
        let binaries: serde_json::Map<String, Value> = files
            .iter()
            .map(|(name, bytes)| (name.to_string(), pin(name, bytes)))
            .collect();
        let host_files: Vec<Value> = host
            .iter()
            .map(|(path, content, mode, apply)| match content {
                Some(text) => {
                    let sha256 = digest(text.as_bytes());
                    cloud.serve_file(
                        &format!("/files/{id}/host-files/{sha256}"),
                        text.as_bytes().to_vec(),
                    );
                    json!({"path": path, "kind": "file", "mode": mode, "sha256": sha256,
                           "size_bytes": text.len(), "apply": apply})
                }
                None => json!({"path": path, "kind": "symlink-to-dev-null", "apply": apply}),
            })
            .collect();
        let release = json!({
            "id": id, "binaries": binaries,
            "os": {"image_version": "25", "debian_snapshot": "20261016T000000Z",
                   "package_lock": pin("packages.lock.json", lock), "host_files": host_files}
        });
        sign_release(cloud, &release, test_key());
        release
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
                release_key: test_release_key(),
            },
        )
        .await
        .unwrap()
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn an_agent_that_starts_after_a_reboot_posts_the_journal_of_the_boot_before() {
        let Some((machine, _fixture, _root)) =
            site("boot-journal", &|root| root.join("r/agent/archive.sock"))
        else {
            return;
        };
        let cloud = Cloud::start().await;
        let base = tempdir();
        let reports = || cloud.acknowledged("/node/v1/diagnostics");
        // The first start of the node: no boot before it, and the agent remembers this one.
        let first = serve(&machine, &cloud, &base).await;
        let before = machine.boot().unwrap().id;
        eventually(30, "the first boot to be remembered", || {
            machine.layout().agent().join("boot-id").exists()
        })
        .await;
        first.stop();
        drop(first);
        assert!(reports().is_empty());
        // The node reboots and the agent starts again: it says which boot the lines are of.
        machine.reboot().await.unwrap();
        let second = serve(&machine, &cloud, &base).await;
        eventually(30, "the report of the previous boot", || {
            !reports().is_empty()
        })
        .await;
        let [report] = &reports()[..] else {
            panic!("one report: {:?}", reports());
        };
        assert_eq!(report["previous_boot_id"], before);
        assert_eq!(report["boot_id"], machine.boot().unwrap().id);
        assert!(!report["entries"].as_array().unwrap().is_empty());
        second.stop();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_boot_report_that_cloudflare_refuses_is_sent_again_within_the_boot() {
        let Some((machine, _fixture, _root)) = site("boot-journal-retry", &|root| {
            root.join("r/agent/archive.sock")
        }) else {
            return;
        };
        let cloud = Cloud::start().await;
        let base = tempdir();
        let first = serve(&machine, &cloud, &base).await;
        eventually(30, "the first boot to be remembered", || {
            machine.layout().agent().join("boot-id").exists()
        })
        .await;
        first.stop();
        drop(first);
        // The node reboots, and Cloudflare refuses the report twice: the agent keeps asking, with
        // no restart, until the third attempt is answered.
        machine.reboot().await.unwrap();
        cloud.with(|inner| inner.boot_failures = 2);
        let second = serve(&machine, &cloud, &base).await;
        eventually(30, "the report of the previous boot", || {
            !cloud.acknowledged("/node/v1/diagnostics").is_empty()
        })
        .await;
        assert_eq!(cloud.posted("/node/v1/diagnostics").len(), 3);
        assert_eq!(cloud.acknowledged("/node/v1/diagnostics").len(), 1);
        eventually(30, "the boot to be remembered", || {
            std::fs::read_to_string(machine.layout().agent().join("boot-id"))
                .is_ok_and(|id| id.trim() == machine.boot().unwrap().id)
        })
        .await;
        second.stop();
    }

    /// `count` asleep observations of the contract's example, each under an identifier of its own.
    fn asleep_observations(count: usize) -> Vec<Value> {
        use crate::link::test_server::{database_id, vector};
        let example = vector("NodeObservationReport", "asleep")["databases"][0].clone();
        (0..count)
            .map(|index| {
                let mut observation = example.clone();
                observation["id"] = database_id(index).into();
                observation
            })
            .collect()
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn the_report_loop_posts_half_the_batch_after_a_refused_report_and_a_whole_one_after_an_accepted_report()
     {
        let Some((machine, _fixture, _root)) =
            site("report-batches", &|root| root.join("r/agent/archive.sock"))
        else {
            return;
        };
        let cloud = Cloud::start().await;
        let base = tempdir();
        let service = serve(&machine, &cloud, &base).await;
        let path = crate::node_link::constant("NODE_API_PATHS")["observations"]
            .as_str()
            .unwrap()
            .to_string();
        // The reports that name databases, in the order they were posted: how many each named, and
        // how Cloudflare answered it.
        let posted = || -> Vec<(usize, u16)> {
            cloud
                .requests()
                .into_iter()
                .filter(|seen| seen.path() == path)
                .filter_map(|seen| {
                    let named = seen.body["databases"].as_array().map_or(0, Vec::len);
                    (named > 0).then_some((named, seen.status))
                })
                .collect()
        };
        // Cloudflare refuses the first report of databases, as when it ran out of time on it.
        cloud.with(|inner| inner.observation_failures = 1);
        for observation in asleep_observations(100) {
            service.core().queue_observation(observation);
        }
        eventually(30, "every observation to be accepted", || {
            posted()
                .iter()
                .filter(|(_, status)| *status == 200)
                .map(|(named, _)| named)
                .sum::<usize>()
                == 100
        })
        .await;
        // The refused report held a whole batch and went back whole; the one after it was half as
        // large; the accepted one restored the batch, and the last report held what was left.
        let batch = crate::agent::report::DATABASES_PER_REPORT;
        assert_eq!(
            posted(),
            [
                (batch, 503),
                (batch / 2, 200),
                (batch, 200),
                (100 - batch / 2 - batch, 200)
            ]
        );
        service.stop();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_probe_on_the_page_runs_once_its_result_is_posted_and_a_result_that_did_not_arrive_runs_it_again()
     {
        let Some((machine, _fixture, _root)) =
            site("probe", &|root| root.join("r/agent/archive.sock"))
        else {
            return;
        };
        let cloud = Cloud::start().await;
        let base = tempdir();
        let listeners = "5b1f0c2e-7d34-4a8b-9e61-0c3d2a4f6b81";
        let boots = "6c2a1d3f-8e45-4b9c-af72-1d4e3b5a7c92";
        let request = |id: &str, probe: &str| json!({"id": id, "probe": probe, "boot": 0, "since_seconds": 3600, "lines": 200});
        let results = |id: &str| -> Vec<Value> {
            cloud
                .acknowledged("/node/v1/diagnostics")
                .into_iter()
                .filter(|body| body["diagnostic_id"] == id)
                .collect()
        };
        let ran = |program: &str| {
            machine
                .calls()
                .iter()
                .filter(|call| call.starts_with(&format!("diagnostic {program} ")))
                .count()
        };
        let pulls = || {
            cloud
                .requests()
                .iter()
                .filter(|seen| seen.method == "GET" && seen.path() == "/node/v1/desired")
                .count()
        };
        // The first page lists the request: the probe runs, and the result is posted, signed.
        cloud.with(|inner| inner.diagnostics = vec![request(listeners, "listeners")]);
        let service = serve(&machine, &cloud, &base).await;
        eventually(30, "the result of the probe", || {
            results(listeners).len() == 1
        })
        .await;
        let result = &results(listeners)[0];
        assert_eq!(result["probe"], "listeners");
        assert_eq!(result["status"], "ok");
        assert!(result["text"].as_str().unwrap().contains("127.0.0.1:8443"));
        assert!(contract_valid("NodeProbeResult", result));
        // The page lists it still, as one pulled while the result was on its way does: it does not
        // run again, for the pages the link asks for, nor for the agent that starts again.
        for _ in 0..3 {
            let before = pulls();
            cloud.push(json!({"type": "desired"}));
            eventually(30, "a pull", || pulls() > before).await;
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!((ran("ss"), results(listeners).len()), (1, 1));
        service.stop();
        drop(service);
        let service = serve(&machine, &cloud, &base).await;
        let before = pulls();
        eventually(30, "a page after the start", || pulls() > before).await;
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!((ran("ss"), results(listeners).len()), (1, 1));
        // A result that Cloudflare did not take: the request is on the next page, and runs again.
        cloud.with(|inner| {
            inner.probe_failures = 1;
            inner.diagnostics.push(request(boots, "boots"));
        });
        cloud.push(json!({"type": "desired"}));
        eventually(30, "the first try of the probe", || ran("journalctl") == 1).await;
        eventually(30, "the second try", || {
            cloud.push(json!({"type": "desired"}));
            ran("journalctl") == 2 && results(boots).len() == 1
        })
        .await;
        assert_eq!(results(boots)[0]["probe"], "boots");
        assert_eq!(ran("ss"), 1);
        service.stop();
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

    // ---- host files (plan 9.3)

    const MASK: &str = "/etc/systemd/system/modprobe@loop.service";
    const AGENT_UNIT: &str = "/usr/lib/systemd/system/pgcf-agent.service";
    const RUNTIME_AGENT_UNIT: &str = "/run/systemd/system/pgcf-agent.service";
    const GATEWAY_UNIT: &str = "/usr/lib/systemd/system/pgcf-gateway.service";
    const DATABASE_UNIT: &str = "/usr/lib/systemd/system/pgcf-pg@.service";
    const SYSUSERS: &str = "/usr/lib/sysusers.d/pgcf.conf";
    const TMPFILES: &str = "/usr/lib/tmpfiles.d/pgcf.conf";
    const SSH_CONFIG: &str = "/etc/ssh/sshd_config.d/10-test.conf";
    const JOURNALD_CONFIG: &str = "/usr/lib/systemd/journald.conf.d/pgcf-test.conf";
    /// What the host files of a release say, ascending by path.
    const UNITS: [Host<'static>; 4] = [
        (MASK, None, "", "daemon_reload"),
        (
            AGENT_UNIT,
            Some("[Service]\n# agent 2\n"),
            "0644",
            "restart_unit:pgcf-agent.service",
        ),
        (
            GATEWAY_UNIT,
            Some("[Service]\n# gateway 2\n"),
            "0644",
            "restart_unit:pgcf-gateway.service",
        ),
        (
            DATABASE_UNIT,
            Some("[Service]\n# database 2\n"),
            "0755",
            "next_start",
        ),
    ];
    fn on_disk(machine: &crate::machine::local::Local, path: &str) -> std::path::PathBuf {
        machine
            .layout()
            .host_root
            .join(path.trim_start_matches('/'))
    }
    /// The calls that systemd saw, in order: the reloads and the restarts.
    fn systemd_calls(machine: &crate::machine::local::Local) -> Vec<String> {
        machine
            .calls()
            .into_iter()
            .filter(|call| call == "daemon-reload" || call.starts_with("restart "))
            .collect()
    }
    /// What systemd and its tools saw, in order: the reloads, the runs of sysusers and tmpfiles and
    /// the restarts.
    fn host_calls(machine: &crate::machine::local::Local) -> Vec<String> {
        machine
            .calls()
            .into_iter()
            .filter(|call| {
                call == "daemon-reload"
                    || call.starts_with("restart ")
                    || call.starts_with("sysusers ")
                    || call.starts_with("tmpfiles ")
            })
            .collect()
    }
    /// What the node said of the host files it holds in its hello.
    fn said_host_files(cloud: &Cloud) -> Vec<String> {
        cloud.with(|inner| {
            inner
                .hellos
                .iter()
                .map(|hello| {
                    hello["os"]["host_files_sha256"]
                        .as_str()
                        .unwrap()
                        .to_string()
                })
                .collect()
        })
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn host_files_follow_the_binaries_and_the_agent_that_runs_them_writes_them() {
        let Some((machine, _fixture, _root)) = site("host-files-order", &|root| {
            root.join("r/agent/archive.sock")
        }) else {
            return;
        };
        runs(&machine, "r0", &same(b"old"));
        let cloud = Cloud::start().await;
        // r1 changes the agent and the gateway, and its units: the gateway's, the database's, the
        // agent's own and a mask.
        let mut files = same(b"old");
        files[0].1 = b"new agent";
        files[1].1 = b"new gateway";
        let release = release_with(&cloud, "r1-order", &files, b"{}", &UNITS);
        cloud.with(|inner| inner.release = Some(release));
        let base = tempdir();
        let first = serve(&machine, &cloud, &base).await;
        let bin = machine.layout().state.join("bin");
        eventually(30, "the link to move to r1", || {
            crate::update::current_release(&bin).as_deref() == Some("r1-order")
        })
        .await;
        tokio::time::timeout(Duration::from_secs(10), first.restart_requested())
            .await
            .expect("the agent asks to be restarted");
        // The old agent has installed the binaries and left: it wrote no file of a release whose
        // agent it does not run, and told systemd nothing about them.
        let before = std::fs::read_to_string(on_disk(&machine, GATEWAY_UNIT)).unwrap();
        assert_eq!(before, "[Service]\n# pgcf-gateway.service of the image\n");
        assert!(!on_disk(&machine, DATABASE_UNIT).exists());
        assert!(std::fs::symlink_metadata(on_disk(&machine, MASK)).is_err());
        assert!(!machine.layout().host_files().exists());
        assert!(!systemd_calls(&machine).contains(&"daemon-reload".to_string()));
        // Not by a later page either, while the old agent is still there to read it.
        cloud.push(json!({"type": "desired"}));
        tokio::time::sleep(Duration::from_millis(600)).await;
        assert!(!machine.layout().host_files().exists());
        assert!(!on_disk(&machine, DATABASE_UNIT).exists());
        first.stop();
        drop(first);
        machine.clear_calls();

        // The agent that starts from the new link finds the binaries current and writes the files.
        let second = serve(&machine, &cloud, &base).await;
        tokio::time::timeout(Duration::from_secs(30), second.restart_requested())
            .await
            .expect("the agent leaves for its own unit, last");
        // One reload, then the gateway; the agent's own unit is never restarted through systemd
        // but by the agent leaving, and the database's unit and the mask need no restart.
        assert_eq!(
            systemd_calls(&machine),
            ["daemon-reload", "restart pgcf-gateway.service"]
        );
        for (path, content, mode) in [
            (GATEWAY_UNIT, "[Service]\n# gateway 2\n", 0o644),
            (DATABASE_UNIT, "[Service]\n# database 2\n", 0o755),
        ] {
            use std::os::unix::fs::PermissionsExt;
            let file = on_disk(&machine, path);
            assert_eq!(std::fs::read_to_string(&file).unwrap(), content);
            assert_eq!(
                std::fs::metadata(&file).unwrap().permissions().mode() & 0o777,
                mode
            );
        }
        assert_eq!(
            std::fs::read_link(on_disk(&machine, MASK)).unwrap(),
            std::path::PathBuf::from("/dev/null")
        );
        // The reload came before the restart: the gateway runs the unit as the release wrote it.
        assert_eq!(
            machine
                .running_definition("pgcf-gateway.service")
                .as_deref(),
            Some("[Service]\n# gateway 2\n")
        );
        // The agent's own unit stands in /run, where systemd reads it before the image's file, and
        // the image's file is the unit the agent ran with: the last good one.
        assert_eq!(
            std::fs::read_to_string(on_disk(&machine, RUNTIME_AGENT_UNIT)).unwrap(),
            "[Service]\n# agent 2\n"
        );
        assert_eq!(
            std::fs::read_to_string(on_disk(&machine, AGENT_UNIT)).unwrap(),
            "[Service]\n# pgcf-agent.service of the image\n"
        );
        // What was left to do is done, and the record holds the list.
        let boot = machine.boot().unwrap().id;
        let state = crate::hostfiles::State::load(&machine.layout().host_files());
        assert!(!state.unfinished(&boot));
        assert_eq!(state.release, "r1-order");
        assert_eq!(state.files.len(), 4);
        // The node does not say that it holds the release's files: the agent's unit is not yet in
        // its place.
        let wanted = update::Release::parse(&cloud.with(|inner| inner.release.clone().unwrap()))
            .unwrap()
            .host_files_digest();
        assert!(!said_host_files(&cloud).contains(&wanted));
        second.stop();
        drop(second);
        machine.clear_calls();

        // systemd starts the agent again with the unit it read, which is the new one; the agent
        // that runs it reads its first page and only then moves the unit to its place.
        machine.restart_service("pgcf-agent.service").await.unwrap();
        assert_eq!(
            machine.running_definition("pgcf-agent.service").as_deref(),
            Some("[Service]\n# agent 2\n")
        );
        machine.clear_calls();
        let third = serve(&machine, &cloud, &base).await;
        eventually(30, "the agent's unit to move to its place", || {
            !on_disk(&machine, RUNTIME_AGENT_UNIT).exists()
        })
        .await;
        assert_eq!(
            std::fs::read_to_string(on_disk(&machine, AGENT_UNIT)).unwrap(),
            "[Service]\n# agent 2\n"
        );
        // One reload made systemd let go of the copy; nothing was restarted for it.
        eventually(30, "the reload", || {
            systemd_calls(&machine) == ["daemon-reload"]
        })
        .await;
        // Now the hello says the digest of what the disk holds, which is the release's.
        eventually(30, "the digest of the host files to be said", || {
            said_host_files(&cloud).contains(&wanted)
        })
        .await;
        assert!(crate::events::seen().iter().any(|event| {
            event["event"] == "agent_unit_promoted" && event["fields"]["release"] == "r1-order"
        }));
        third.stop();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_release_that_changes_no_binary_gets_its_files_at_once_and_a_second_page_changes_nothing()
     {
        let Some((machine, _fixture, _root)) =
            site("host-files-only", &|root| root.join("r/agent/archive.sock"))
        else {
            return;
        };
        runs(&machine, "r1-files-only", &same(b"bin"));
        let cloud = Cloud::start().await;
        let host: [Host; 3] = [UNITS[0], UNITS[2], UNITS[3]];
        let release = release_with(&cloud, "r1-files-only", &same(b"bin"), b"{}", &host);
        let wanted = update::Release::parse(&release)
            .unwrap()
            .host_files_digest();
        cloud.with(|inner| inner.release = Some(release));
        let base = tempdir();
        let service = serve(&machine, &cloud, &base).await;
        eventually(30, "the digest of the host files to be said", || {
            said_host_files(&cloud).contains(&wanted)
        })
        .await;
        assert_eq!(
            systemd_calls(&machine),
            ["daemon-reload", "restart pgcf-gateway.service"]
        );
        assert_eq!(
            machine
                .running_definition("pgcf-gateway.service")
                .as_deref(),
            Some("[Service]\n# gateway 2\n")
        );
        // The same page again, and a full pull: the disk holds the list, so nothing is read from
        // the API, written or told to systemd.
        let requests = cloud.requests().len();
        cloud.push(json!({"type": "desired"}));
        tokio::time::sleep(Duration::from_millis(800)).await;
        assert_eq!(
            systemd_calls(&machine),
            ["daemon-reload", "restart pgcf-gateway.service"]
        );
        assert!(
            cloud.requests()[requests..]
                .iter()
                .all(|seen| !seen.path().contains("/host-files/")),
            "{:?}",
            cloud.requests()[requests..].to_vec()
        );
        // A file that was changed on the node is written again, and one change of a byte only.
        std::fs::write(on_disk(&machine, DATABASE_UNIT), "[Service]\n# tampered\n").unwrap();
        machine.clear_calls();
        service.stop();
        drop(service);
        let service = serve(&machine, &cloud, &base).await;
        eventually(30, "the changed file to be written again", || {
            std::fs::read_to_string(on_disk(&machine, DATABASE_UNIT)).unwrap()
                == "[Service]\n# database 2\n"
        })
        .await;
        // Only that file was fetched; nothing else is restarted for a file that needs no restart.
        eventually(30, "the reload", || {
            systemd_calls(&machine) == ["daemon-reload"]
        })
        .await;
        service.stop();
    }

    /// A change to the page of a release that the key did not sign.
    type Tamper = fn(&mut Value);

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_tampered_list_is_refused_before_anything_is_fetched_or_written() {
        let Some((machine, _fixture, _root)) = site("host-files-forged", &|root| {
            root.join("r/agent/archive.sock")
        }) else {
            return;
        };
        runs(&machine, "r0", &same(b"old"));
        let cloud = Cloud::start().await;
        let mut files = same(b"old");
        files[1].1 = b"new gateway";
        // The key signed the units as they are; the page that reaches the node says other things.
        let signed = release_with(&cloud, "r1-forged", &files, b"{}", &UNITS);
        let tampered: [(&str, Tamper); 4] = [
            ("apply", |release| {
                release["os"]["host_files"][3]["apply"] = "restart_unit:ssh.service".into()
            }),
            ("digest", |release| {
                release["os"]["host_files"][2]["sha256"] = "9".repeat(64).into()
            }),
            ("mode", |release| {
                release["os"]["host_files"][2]["mode"] = "0755".into()
            }),
            ("file", |release| {
                release["os"]["host_files"].as_array_mut().unwrap().pop();
            }),
        ];
        let refusals = || {
            crate::events::seen()
                .iter()
                .filter(|event| {
                    event["event"] == "release_refused"
                        && event["fields"]["release"] == "r1-forged"
                        && event["fields"]["class"] == "release_signature_invalid"
                })
                .count()
        };
        let base = tempdir();
        let mut service = None;
        for (what, change) in tampered {
            let before = refusals();
            let mut page = signed.clone();
            change(&mut page);
            cloud.with(|inner| inner.release = Some(page));
            if service.is_none() {
                service = Some(serve(&machine, &cloud, &base).await);
            } else {
                cloud.push(json!({"type": "desired"}));
            }
            // Each change of the page is a release of its own to the agent, and is refused.
            eventually(30, what, || refusals() > before).await;
        }
        let bin = machine.layout().state.join("bin");
        assert_eq!(crate::update::current_release(&bin).as_deref(), Some("r0"));
        // Nothing but the signature was read of the release.
        assert!(
            cloud
                .requests()
                .iter()
                .all(|seen| !seen.path().starts_with("/files/r1-forged/")
                    || seen.path().ends_with("/release.sig")),
            "{:?}",
            cloud.requests()
        );
        assert!(systemd_calls(&machine).is_empty(), "{:?}", machine.calls());
        assert!(!machine.layout().host_files().exists());
        assert!(!on_disk(&machine, DATABASE_UNIT).exists());
        service.unwrap().stop();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_release_whose_files_break_this_agents_rules_still_installs_its_binaries() {
        let Some((machine, _fixture, _root)) = site("host-files-rules", &|root| {
            root.join("r/agent/archive.sock")
        }) else {
            return;
        };
        runs(&machine, "r0", &same(b"old"));
        let cloud = Cloud::start().await;
        let mut files = same(b"old");
        files[1].1 = b"new gateway";
        // The key signed a list with a unit this agent has no name for: a later contract allows
        // it, and the binaries of the release may be the agent that knows it. An agent whose rules
        // are older must not refuse the page, and not the binaries either; it refuses the files.
        let unknown: [Host; 2] = [
            UNITS[2],
            (
                "/usr/lib/systemd/system/pgcf-new.service",
                Some("[Service]\n"),
                "0644",
                "restart_unit:pgcf-new.service",
            ),
        ];
        let release = release_with(&cloud, "r1-rules", &files, b"{}", &unknown);
        cloud.with(|inner| inner.release = Some(release));
        let base = tempdir();
        let service = serve(&machine, &cloud, &base).await;
        let bin = machine.layout().state.join("bin");
        eventually(30, "the binaries of the release to be installed", || {
            crate::update::current_release(&bin).as_deref() == Some("r1-rules")
        })
        .await;
        eventually(30, "the files to be refused with their class", || {
            refused("r1-rules", "host_file_apply_refused")
        })
        .await;
        // Once, however many pages name the release; and not a file written, nor a reload.
        for _ in 0..3 {
            cloud.push(json!({"type": "desired"}));
            tokio::time::sleep(Duration::from_millis(150)).await;
        }
        let count = |class: &str| {
            crate::events::seen()
                .iter()
                .filter(|event| {
                    event["event"] == "release_refused"
                        && event["fields"]["release"] == "r1-rules"
                        && event["fields"]["class"] == class
                })
                .count()
        };
        assert_eq!(count("host_file_apply_refused"), 1);
        assert_eq!(count("release_signature_invalid"), 0);
        assert!(!machine.layout().host_files().exists());
        assert_eq!(
            std::fs::read_to_string(on_disk(&machine, GATEWAY_UNIT)).unwrap(),
            "[Service]\n# pgcf-gateway.service of the image\n"
        );
        assert!(!systemd_calls(&machine).contains(&"daemon-reload".to_string()));
        // The node does not claim files it was not given.
        let wanted = update::Release::parse(&cloud.with(|inner| inner.release.clone().unwrap()))
            .unwrap()
            .host_files_digest();
        assert!(!said_host_files(&cloud).contains(&wanted));
        // The next release has a list the rules allow: its files are written.
        let next = release_with(&cloud, "r2-rules", &files, b"{}", &[UNITS[2]]);
        cloud.with(|inner| inner.release = Some(next));
        cloud.push(json!({"type": "desired"}));
        eventually(30, "the unit of the next release to run", || {
            machine
                .running_definition("pgcf-gateway.service")
                .as_deref()
                == Some("[Service]\n# gateway 2\n")
        })
        .await;
        service.stop();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_reload_that_failed_is_not_forgotten_and_the_restarts_wait_for_it() {
        let Some((machine, _fixture, _root)) = site("host-files-reload", &|root| {
            root.join("r/agent/archive.sock")
        }) else {
            return;
        };
        runs(&machine, "r1-reload", &same(b"bin"));
        let cloud = Cloud::start().await;
        let release = release_with(&cloud, "r1-reload", &same(b"bin"), b"{}", &[UNITS[2]]);
        cloud.with(|inner| inner.release = Some(release));
        machine.fail_next_reload();
        let base = tempdir();
        let service = serve(&machine, &cloud, &base).await;
        eventually(30, "the reload to fail", || {
            systemd_calls(&machine) == ["daemon-reload"]
        })
        .await;
        // The file is written and the record keeps what is left: the reload, and the restart that
        // must not come before it, or the unit would restart with the definition it had.
        let state = crate::hostfiles::State::load(&machine.layout().host_files());
        assert!(state.reload);
        assert_eq!(state.restarts, ["pgcf-gateway.service"]);
        assert_eq!(machine.running_definition("pgcf-gateway.service"), None);
        // A page after the wait finishes it.
        tokio::time::sleep(Duration::from_millis(700)).await;
        cloud.push(json!({"type": "desired"}));
        eventually(30, "the restart to be done", || {
            machine
                .running_definition("pgcf-gateway.service")
                .as_deref()
                == Some("[Service]\n# gateway 2\n")
        })
        .await;
        assert_eq!(
            systemd_calls(&machine),
            [
                "daemon-reload",
                "daemon-reload",
                "restart pgcf-gateway.service"
            ]
        );
        service.stop();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_restart_that_failed_is_not_forgotten_and_not_repeated_by_every_page() {
        let Some((machine, _fixture, _root)) = site("host-files-restart", &|root| {
            root.join("r/agent/archive.sock")
        }) else {
            return;
        };
        runs(&machine, "r1-restart", &same(b"bin"));
        let cloud = Cloud::start().await;
        let release = release_with(&cloud, "r1-restart", &same(b"bin"), b"{}", &[UNITS[2]]);
        cloud.with(|inner| inner.release = Some(release));
        machine.fail_next_restart();
        let base = tempdir();
        let service = serve(&machine, &cloud, &base).await;
        // The file is written and systemd has read it, but the restart failed: the record keeps
        // the unit, the event names the class, and the node does not claim to be done.
        eventually(30, "the restart to fail", || {
            crate::events::seen().iter().any(|event| {
                event["event"] == "host_files_not_applied"
                    && event["fields"]["release"] == "r1-restart"
            })
        })
        .await;
        let state = crate::hostfiles::State::load(&machine.layout().host_files());
        assert_eq!(state.restarts, ["pgcf-gateway.service"]);
        assert!(!state.reload);
        assert_eq!(
            std::fs::read_to_string(on_disk(&machine, GATEWAY_UNIT)).unwrap(),
            "[Service]\n# gateway 2\n"
        );
        // Pages that come at once do not repeat it: the wait after a failure has not passed.
        for _ in 0..3 {
            cloud.push(json!({"type": "desired"}));
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
        assert_eq!(
            systemd_calls(&machine),
            ["daemon-reload", "restart pgcf-gateway.service"]
        );
        // The first page after the wait finishes it, without writing anything again.
        tokio::time::sleep(Duration::from_millis(600)).await;
        cloud.push(json!({"type": "desired"}));
        eventually(30, "the restart to be done", || {
            machine
                .running_definition("pgcf-gateway.service")
                .as_deref()
                == Some("[Service]\n# gateway 2\n")
        })
        .await;
        assert_eq!(
            systemd_calls(&machine),
            [
                "daemon-reload",
                "restart pgcf-gateway.service",
                "restart pgcf-gateway.service"
            ]
        );
        let boot = machine.boot().unwrap().id;
        assert!(!crate::hostfiles::State::load(&machine.layout().host_files()).unfinished(&boot));
        service.stop();
    }

    /// A package lock that names one package the node has: a maintenance cycle has nothing to do.
    const BASH_LOCK: &str = r#"{"packages": [{"name": "bash", "version": "5.2", "architecture": "amd64", "url": "https://snapshot.example/bash.deb", "size": 10, "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}], "extra": []}"#;

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn users_and_directories_are_made_by_their_tools_before_the_reload_and_the_restarts() {
        let Some((machine, _fixture, _root)) = site("host-files-tools", &|root| {
            root.join("r/agent/archive.sock")
        }) else {
            return;
        };
        runs(&machine, "r1-tools", &same(b"bin"));
        machine.set_packages(&[("bash", "5.2")]);
        let cloud = Cloud::start().await;
        let host: [Host; 3] = [
            UNITS[2],
            (
                SYSUSERS,
                Some("u pgcf-gateway - \"PGCF gateway\" /nonexistent\n"),
                "0644",
                "sysusers",
            ),
            (
                TMPFILES,
                Some("d /var/lib/pgcf/new 0750 root root -\n"),
                "0644",
                "tmpfiles",
            ),
        ];
        let release = release_with(
            &cloud,
            "r1-tools",
            &same(b"bin"),
            BASH_LOCK.as_bytes(),
            &host,
        );
        let wanted = update::Release::parse(&release)
            .unwrap()
            .host_files_digest();
        cloud.with(|inner| inner.release = Some(release));
        let base = tempdir();
        let service = serve(&machine, &cloud, &base).await;
        // No reboot: the node says at once that it holds the release's files, which a boot would
        // not have made true (systemd makes users at a boot only when /usr is newer than
        // /etc/.updated, which a file in /usr/lib/sysusers.d does not make it).
        eventually(30, "the digest of the host files to be said", || {
            said_host_files(&cloud).contains(&wanted)
        })
        .await;
        // The tools first (users before directories, which may name them), so that a unit that
        // crashes and comes back under the new definition once it is loaded finds its user and
        // its directory; then the reload, then the restart of the unit that may need them.
        assert_eq!(
            host_calls(&machine),
            [
                format!("sysusers {SYSUSERS}"),
                format!("tmpfiles {TMPFILES}"),
                "daemon-reload".to_string(),
                "restart pgcf-gateway.service".to_string(),
            ]
        );
        assert_eq!(machine.created_users(), ["pgcf-gateway"]);
        assert_eq!(
            machine.created_directories().get("/var/lib/pgcf/new"),
            Some(&"0750".to_string())
        );
        let boot = machine.boot().unwrap().id;
        assert!(!crate::hostfiles::State::load(&machine.layout().host_files()).unfinished(&boot));
        // The maintenance cycle has nothing to install and nothing to reboot for: no host file
        // waits for a boot, and the order is answered.
        let operation = "op_rrrrrrrrrrrrrrrrrrrr";
        cloud.with(|inner| {
            inner.orders = vec![json!({"type": "maintenance", "operation": operation})]
        });
        cloud.push(json!({"type": "desired"}));
        eventually(60, "the order to be done", || {
            cloud
                .acknowledged("/node/v1/observations")
                .iter()
                .flat_map(|report| report["orders"].as_array().cloned().unwrap_or_default())
                .any(|order| order["operation"] == operation && order["status"] == "done")
        })
        .await;
        assert!(
            !machine.calls().contains(&"reboot".to_string()),
            "{:?}",
            machine.calls()
        );
        service.stop();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_run_that_failed_holds_the_reload_and_the_restarts_back_until_it_has_been_done() {
        let Some((machine, _fixture, _root)) =
            site("host-files-run", &|root| root.join("r/agent/archive.sock"))
        else {
            return;
        };
        runs(&machine, "r1-run", &same(b"bin"));
        let cloud = Cloud::start().await;
        let host: [Host; 2] = [
            UNITS[2],
            (
                SYSUSERS,
                Some("u pgcf-gateway - \"PGCF gateway\" /nonexistent\n"),
                "0644",
                "sysusers",
            ),
        ];
        let release = release_with(&cloud, "r1-run", &same(b"bin"), b"{}", &host);
        let wanted = update::Release::parse(&release)
            .unwrap()
            .host_files_digest();
        cloud.with(|inner| inner.release = Some(release));
        machine.fail_next_run();
        let base = tempdir();
        let service = serve(&machine, &cloud, &base).await;
        eventually(30, "the run to fail", || !host_calls(&machine).is_empty()).await;
        // No unit is loaded under its new definition before the user exists (a unit that crashes
        // in between would come back under it), nor restarted, and the node does not claim to
        // hold the files.
        assert_eq!(host_calls(&machine), [format!("sysusers {SYSUSERS}")]);
        let boot = machine.boot().unwrap().id;
        let state = crate::hostfiles::State::load(&machine.layout().host_files());
        assert!(state.reload);
        assert_eq!(state.restarts, ["pgcf-gateway.service"]);
        assert_eq!(state.runs.len(), 1);
        assert!(machine.created_users().is_empty());
        let said = crate::machine::os_report(&*machine).await.unwrap();
        assert_ne!(said["host_files_sha256"], wanted.as_str());
        assert!(state.unfinished(&boot));
        // A page after the wait does the run, and then the reload and the restart.
        tokio::time::sleep(Duration::from_millis(700)).await;
        cloud.push(json!({"type": "desired"}));
        eventually(30, "the restart to be done", || {
            machine
                .running_definition("pgcf-gateway.service")
                .as_deref()
                == Some("[Service]\n# gateway 2\n")
        })
        .await;
        assert_eq!(
            host_calls(&machine),
            [
                format!("sysusers {SYSUSERS}"),
                format!("sysusers {SYSUSERS}"),
                "daemon-reload".to_string(),
                "restart pgcf-gateway.service".to_string(),
            ]
        );
        assert_eq!(machine.created_users(), ["pgcf-gateway"]);
        eventually(30, "the digest of the host files to be said", || {
            said_host_files(&cloud).contains(&wanted)
        })
        .await;
        service.stop();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_unit_that_cannot_restart_keeps_neither_the_others_nor_the_agent_from_theirs() {
        let Some((machine, _fixture, _root)) = site("host-files-one-fails", &|root| {
            root.join("r/agent/archive.sock")
        }) else {
            return;
        };
        runs(&machine, "r1-one-fails", &same(b"bin"));
        let cloud = Cloud::start().await;
        let host: [Host; 4] = [
            (
                SSH_CONFIG,
                Some("PasswordAuthentication no\n"),
                "0644",
                "restart_unit:ssh.service",
            ),
            (
                JOURNALD_CONFIG,
                Some("[Journal]\nSyncIntervalSec=15s\n"),
                "0644",
                "restart_unit:systemd-journald.service",
            ),
            UNITS[1],
            UNITS[2],
        ];
        let release = release_with(&cloud, "r1-one-fails", &same(b"bin"), b"{}", &host);
        cloud.with(|inner| inner.release = Some(release));
        machine.fail_restarts_of("ssh.service");
        let base = tempdir();
        let first = serve(&machine, &cloud, &base).await;
        // The agent leaves for its own unit all the same, and the units after the one that failed
        // were restarted; each was tried, the one that failed stays in the record.
        tokio::time::timeout(Duration::from_secs(30), first.restart_requested())
            .await
            .expect("the agent leaves for its own unit");
        assert_eq!(
            host_calls(&machine),
            [
                "daemon-reload",
                "restart pgcf-gateway.service",
                "restart ssh.service",
                "restart systemd-journald.service",
            ]
        );
        let state = crate::hostfiles::State::load(&machine.layout().host_files());
        assert_eq!(state.restarts, ["ssh.service"]);
        assert!(crate::events::seen().iter().any(|event| {
            event["event"] == "host_files_not_applied"
                && event["fields"]["release"] == "r1-one-fails"
        }));
        // Pages that come at once do not try the unit again.
        first.stop();
        drop(first);
        machine.clear_calls();
        machine.mend_restarts_of("ssh.service");
        let second = serve(&machine, &cloud, &base).await;
        eventually(30, "the restart of ssh", || {
            machine.running_definition("ssh.service").is_some()
        })
        .await;
        let boot = machine.boot().unwrap().id;
        assert!(!crate::hostfiles::State::load(&machine.layout().host_files()).unfinished(&boot));
        second.stop();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn an_agent_that_has_not_left_for_its_new_unit_does_not_move_it_to_its_place() {
        let Some((machine, _fixture, _root)) = site("host-files-not-yet", &|root| {
            root.join("r/agent/archive.sock")
        }) else {
            return;
        };
        runs(&machine, "r1-not-yet", &same(b"bin"));
        let cloud = Cloud::start().await;
        let release = release_with(
            &cloud,
            "r1-not-yet",
            &same(b"bin"),
            b"{}",
            &[UNITS[1], UNITS[2]],
        );
        cloud.with(|inner| inner.release = Some(release));
        // The reload fails: the unit stands in /run, systemd has not read it, and this process
        // still runs the unit of the image, so a promotion would make the unit that did not start
        // the node's last good one.
        machine.fail_next_reload();
        let base = tempdir();
        let first = serve(&machine, &cloud, &base).await;
        eventually(30, "the reload to fail", || {
            host_calls(&machine) == ["daemon-reload"]
        })
        .await;
        for _ in 0..2 {
            cloud.push(json!({"type": "desired"}));
            tokio::time::sleep(Duration::from_millis(300)).await;
        }
        assert!(on_disk(&machine, RUNTIME_AGENT_UNIT).exists());
        assert_eq!(
            std::fs::read_to_string(on_disk(&machine, AGENT_UNIT)).unwrap(),
            "[Service]\n# pgcf-agent.service of the image\n"
        );
        // After the wait the reload is done, the agent leaves, and the agent that runs the unit
        // moves it.
        tokio::time::sleep(Duration::from_millis(500)).await;
        cloud.push(json!({"type": "desired"}));
        tokio::time::timeout(Duration::from_secs(30), first.restart_requested())
            .await
            .expect("the agent leaves for its unit");
        assert_eq!(
            std::fs::read_to_string(on_disk(&machine, AGENT_UNIT)).unwrap(),
            "[Service]\n# pgcf-agent.service of the image\n"
        );
        first.stop();
        drop(first);
        machine.restart_service("pgcf-agent.service").await.unwrap();
        let second = serve(&machine, &cloud, &base).await;
        eventually(30, "the unit to move", || {
            !on_disk(&machine, RUNTIME_AGENT_UNIT).exists()
        })
        .await;
        assert_eq!(
            std::fs::read_to_string(on_disk(&machine, AGENT_UNIT)).unwrap(),
            "[Service]\n# agent 2\n"
        );
        second.stop();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_restart_that_failed_does_not_make_the_node_claim_its_files_after_the_agent_restarts()
    {
        let Some((machine, _fixture, _root)) = site("host-files-claim", &|root| {
            root.join("r/agent/archive.sock")
        }) else {
            return;
        };
        runs(&machine, "r1-claim", &same(b"bin"));
        let cloud = Cloud::start().await;
        let release = release_with(&cloud, "r1-claim", &same(b"bin"), b"{}", &[UNITS[2]]);
        let wanted = update::Release::parse(&release)
            .unwrap()
            .host_files_digest();
        cloud.with(|inner| inner.release = Some(release));
        machine.fail_restarts_of("pgcf-gateway.service");
        let base = tempdir();
        let first = serve(&machine, &cloud, &base).await;
        eventually(30, "the restart to fail", || {
            host_calls(&machine).len() == 2
        })
        .await;
        // The agent restarts (any restart of it will do): the unit still runs the old definition,
        // and the hello of the new process does not say that the files are held.
        first.stop();
        drop(first);
        let second = serve(&machine, &cloud, &base).await;
        eventually(30, "the hello of the new agent", || {
            said_host_files(&cloud).len() >= 2
        })
        .await;
        assert!(!said_host_files(&cloud).contains(&wanted));
        second.stop();
        drop(second);
        // The node reboots: systemd read the unit again and started it with the file, so what was
        // left for the earlier boot is moot and the node holds the release's files.
        machine.reboot().await.unwrap();
        machine.mend_restarts_of("pgcf-gateway.service");
        let third = serve(&machine, &cloud, &base).await;
        eventually(30, "the release's digest to be said", || {
            said_host_files(&cloud).last() == Some(&wanted)
        })
        .await;
        assert!(
            !crate::hostfiles::State::load(&machine.layout().host_files())
                .unfinished(&machine.boot().unwrap().id)
        );
        third.stop();
    }

    /// The node reported refusing the release with this class (the event `release_refused`).
    fn refused(release: &str, class: &str) -> bool {
        crate::events::seen().iter().any(|event| {
            event["event"] == "release_refused"
                && event["fields"]["release"] == release
                && event["fields"]["class"] == class
        })
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_release_the_key_did_not_sign_is_refused_with_its_class_and_nothing_of_it_is_downloaded()
     {
        let Some((machine, _fixture, _root)) =
            site("update-unsigned", &|root| root.join("r/agent/archive.sock"))
        else {
            return;
        };
        runs(&machine, "r0", &same(b"old"));
        let cloud = Cloud::start().await;
        let mut files = same(b"old");
        files[0].1 = b"new agent";
        files[1].1 = b"new gateway";
        // The API serves no signature for the first release.
        let unsigned = release_of(&cloud, "r1-unsigned", &files, b"{}");
        cloud.with(|inner| {
            inner.files.remove(&signature_path(&cloud, &unsigned));
            inner.release = Some(unsigned);
        });
        let base = tempdir();
        let service = serve(&machine, &cloud, &base).await;
        eventually(30, "the release to be refused as unsigned", || {
            refused("r1-unsigned", "release_signature_missing")
        })
        .await;

        // A signature of another key is no better: a new page names the second release.
        let forged = release_of(&cloud, "r2-forged", &files, b"{}");
        sign_release(&cloud, &forged, &throwaway_key());
        cloud.with(|inner| inner.release = Some(forged));
        cloud.push(json!({"type": "desired"}));
        eventually(30, "the release to be refused as forged", || {
            refused("r2-forged", "release_signature_invalid")
        })
        .await;

        // Nothing of either was downloaded or staged, and the node still runs what it ran.
        let bin = machine.layout().state.join("bin");
        for id in ["r1-unsigned", "r2-forged"] {
            assert!(
                cloud.requests().iter().all(|seen| !seen
                    .path()
                    .starts_with(&format!("/files/{id}/pgcf-"))
                    && !seen.path().starts_with(&format!("/files/{id}/packages"))),
                "{id}"
            );
            assert!(!bin.join(id).exists(), "{id}");
        }
        assert_eq!(crate::update::current_release(&bin).as_deref(), Some("r0"));
        assert!(
            machine.calls().iter().all(|call| !call.contains("restart")),
            "{:?}",
            machine.calls()
        );

        // A release that the key signed is installed on the same node: a refusal is not a stop.
        let signed = release_of(&cloud, "r3-signed", &files, b"{}");
        cloud.with(|inner| inner.release = Some(signed));
        cloud.push(json!({"type": "desired"}));
        eventually(30, "the signed release to be installed", || {
            crate::update::current_release(&bin).as_deref() == Some("r3-signed")
        })
        .await;
        service.stop();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_maintenance_order_of_a_release_the_key_did_not_sign_installs_nothing_and_fails_with_the_class()
     {
        let Some((machine, _fixture, _root)) = site("maintenance-unsigned", &|root| {
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
        // The page names the release the node runs, so no install is tried, and its lock would
        // put packages on the node as root: the signature is another key's.
        let release = release_of(&cloud, "r1", &same(b"bin"), lock.as_bytes());
        sign_release(&cloud, &release, &throwaway_key());
        let operation = "op_mmmmmmmmmmmmmmmmmmmm";
        cloud.with(|inner| {
            inner.release = Some(release);
            inner.orders = vec![json!({"type": "maintenance", "operation": operation})];
        });
        let base = tempdir();
        let service = serve(&machine, &cloud, &base).await;
        eventually(60, "the order to fail as unsigned", || {
            cloud
                .acknowledged("/node/v1/observations")
                .iter()
                .flat_map(|report| report["orders"].as_array().cloned().unwrap_or_default())
                .any(|order| {
                    order["operation"] == operation
                        && order["status"] == "failed"
                        && order["reason"] == "release_signature_invalid"
                })
        })
        .await;
        assert!(refused("r1", "release_signature_invalid"));
        assert!(
            cloud
                .requests()
                .iter()
                .all(|seen| !seen.path().ends_with("packages.lock.json")),
            "the lock is not even read"
        );
        assert!(
            machine
                .calls()
                .iter()
                .all(|call| !call.starts_with("install") && !call.starts_with("purge")),
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
                {"name": "cloudflared", "version": "2026.10.1", "architecture": "amd64", "url": url, "size": deb.len(), "sha256": digest(&deb)},
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
        // file it downloaded (a real lock lists it among its packages too), and the node is checked
        // afterwards. No reboot: no kernel changed.
        let calls = machine.calls();
        let at = |what: &str| calls.iter().position(|call| call.starts_with(what));
        assert!(
            calls.contains(
                &"install 20261016T000000Z postgresql-18=18.7-1 cloudflared=2026.10.1 + cloudflared.deb"
                    .to_string()
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
        let installed = machine.installed_packages().await.unwrap();
        assert_eq!(installed["cloudflared"], "2026.10.1");
        let after = crate::update::packages_digest(&installed);
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
    async fn a_release_that_drops_a_package_leaves_the_node_with_the_digest_of_its_lock() {
        let Some((machine, _fixture, _root)) = site("maintenance-purge", &|root| {
            root.join("r/agent/archive.sock")
        }) else {
            return;
        };
        runs(&machine, "r1", &same(b"bin"));
        // The node runs lock A. Lock B changes PostgreSQL and drops `libdropped1`; the running
        // kernel is B's too, and the kernel before it stays on the node, as Debian keeps it.
        machine.set_packages(&[
            ("bash", "5.2"),
            ("libdropped1", "1.0"),
            ("postgresql-18", "18.6-1"),
            ("linux-image-6.12.111+deb13-amd64", "6.12.111-1"),
            ("linux-image-6.12.88+deb13-amd64", "6.12.88-1"),
        ]);
        let cloud = Cloud::start().await;
        let package = |name: &str, version: &str| json!({"name": name, "version": version, "architecture": "amd64", "url": format!("https://snapshot.example/{name}.deb"), "size": 10, "sha256": "a".repeat(64)});
        let lock = json!({
            "packages": [
                package("bash", "5.2"),
                package("postgresql-18", "18.7-1"),
                package("linux-image-6.12.111+deb13-amd64", "6.12.111-1"),
            ],
            "extra": [],
        });
        let wanted: std::collections::BTreeMap<String, String> = lock["packages"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| {
                (
                    p["name"].as_str().unwrap().to_string(),
                    p["version"].as_str().unwrap().to_string(),
                )
            })
            .collect();
        let release = release_of(&cloud, "r1", &same(b"bin"), lock.to_string().as_bytes());
        let operation = "op_pppppppppppppppppppp";
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
        // The purge follows the install, and the check follows both. No reboot.
        let calls = machine.calls();
        let at = |what: &str| calls.iter().position(|call| call.starts_with(what));
        assert!(
            at("install").unwrap() < at("purge").unwrap()
                && at("purge").unwrap() < at("health_check").unwrap(),
            "{calls:?}"
        );
        assert!(
            calls.contains(&"purge libdropped1".to_string()),
            "{calls:?}"
        );
        assert!(at("reboot").is_none(), "{calls:?}");
        // Of the kernel images only the running one counts, and the other is still installed: the
        // digest the hello says is the lock's.
        let installed = machine.installed_packages().await.unwrap();
        assert!(installed.contains_key("linux-image-6.12.88+deb13-amd64"));
        assert!(!installed.contains_key("libdropped1"));
        let said = crate::machine::os_report(&*machine).await.unwrap();
        assert_eq!(
            said["packages_sha256"],
            crate::update::packages_digest(&wanted).as_str()
        );
        eventually(30, "the lock's digest to be said", || {
            cloud.with(|inner| inner.hellos.iter().any(|hello| hello["os"] == said))
        })
        .await;
        service.stop();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_kernel_reboots_the_node_before_a_purge_that_dpkg_may_refuse() {
        let Some((machine, _fixture, _root)) = site("maintenance-purge-refused", &|root| {
            root.join("r/agent/archive.sock")
        }) else {
            return;
        };
        runs(&machine, "r1", &same(b"bin"));
        // The node runs lock A with the kernel 6.12.111; lock B has the kernel 6.12.113 and drops
        // `libdropped1`, and dpkg refuses to purge it once.
        machine.set_packages(&[
            ("bash", "5.2"),
            ("libdropped1", "1.0"),
            ("linux-image-6.12.111+deb13-amd64", "6.12.111-1"),
        ]);
        machine.fail_next_purge();
        let cloud = Cloud::start().await;
        let lock = json!({
            "packages": [
                {"name": "bash", "version": "5.2", "architecture": "amd64", "url": "https://snapshot.example/bash.deb", "size": 10, "sha256": "a".repeat(64)},
                {"name": "linux-image-6.12.113+deb13-amd64", "version": "6.12.113-1", "architecture": "amd64", "url": "https://snapshot.example/k.deb", "size": 10, "sha256": "c".repeat(64)},
            ],
            "extra": [],
        })
        .to_string();
        let release = release_of(&cloud, "r1", &same(b"bin"), lock.as_bytes());
        let order = |operation: &str| {
            cloud.with(|inner| {
                inner.release = Some(release.clone());
                inner.orders = vec![json!({"type": "maintenance", "operation": operation})];
            })
        };
        let answer = |operation: &str| {
            cloud
                .acknowledged("/node/v1/observations")
                .iter()
                .flat_map(|report| report["orders"].as_array().cloned().unwrap_or_default())
                .find(|order| order["operation"] == operation)
        };
        order("op_rrrrrrrrrrrrrrrrrrrr");
        let base = tempdir();
        let service = serve(&machine, &cloud, &base).await;
        // The kernel is installed and the node reboots: nothing that can fail comes between.
        eventually(60, "the node to reboot", || {
            machine.calls().contains(&"reboot".to_string())
        })
        .await;
        service.stop();
        let calls = machine.calls();
        assert!(
            calls.iter().all(|call| !call.starts_with("purge")),
            "{calls:?}"
        );
        assert_eq!(
            machine.boot().unwrap().kernel_release,
            "6.12.113+deb13-amd64"
        );

        // After the boot the order is still open. Nothing is left to install; the purge is
        // refused, and the order fails with the node on the new kernel.
        machine.clear_calls();
        let service = serve(&machine, &cloud, &base).await;
        eventually(60, "the order to fail", || {
            answer("op_rrrrrrrrrrrrrrrrrrrr").is_some()
        })
        .await;
        let failed = answer("op_rrrrrrrrrrrrrrrrrrrr").unwrap();
        assert_eq!(failed["status"], "failed", "{failed}");
        assert_eq!(failed["reason"], "packages_not_installed", "{failed}");
        let calls = machine.calls();
        assert!(
            calls.contains(&"purge libdropped1".to_string()),
            "{calls:?}"
        );
        assert!(
            calls
                .iter()
                .all(|call| !call.starts_with("install") && call != "reboot"),
            "{calls:?}"
        );
        service.stop();

        // The order is submitted again: the purge goes through and the node answers done.
        machine.clear_calls();
        order("op_ssssssssssssssssssss");
        let service = serve(&machine, &cloud, &base).await;
        eventually(60, "the order to be done", || {
            answer("op_ssssssssssssssssssss").is_some()
        })
        .await;
        assert_eq!(answer("op_ssssssssssssssssssss").unwrap()["status"], "done");
        assert!(
            !machine
                .installed_packages()
                .await
                .unwrap()
                .contains_key("libdropped1")
        );
        service.stop();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_cycle_whose_reboot_fails_still_says_the_packages_it_installed() {
        let Some((machine, _fixture, _root)) = site("maintenance-reboot-fails", &|root| {
            root.join("r/agent/archive.sock")
        }) else {
            return;
        };
        runs(&machine, "r1", &same(b"bin"));
        machine.set_packages(&[
            ("bash", "5.2"),
            ("linux-image-6.12.111+deb13-amd64", "6.12.111-1"),
        ]);
        let before = crate::machine::os_report(&*machine).await.unwrap();
        machine.fail_next_reboot();
        let cloud = Cloud::start().await;
        let lock = json!({
            "packages": [
                {"name": "bash", "version": "5.3", "architecture": "amd64", "url": "https://snapshot.example/bash.deb", "size": 10, "sha256": "a".repeat(64)},
                {"name": "linux-image-6.12.113+deb13-amd64", "version": "6.12.113-1", "architecture": "amd64", "url": "https://snapshot.example/k.deb", "size": 10, "sha256": "c".repeat(64)},
            ],
            "extra": [],
        })
        .to_string();
        let release = release_of(&cloud, "r1", &same(b"bin"), lock.as_bytes());
        let operation = "op_ffffffffffffffffffff";
        cloud.with(|inner| {
            inner.release = Some(release);
            inner.orders = vec![json!({"type": "maintenance", "operation": operation})];
        });
        let base = tempdir();
        let service = serve(&machine, &cloud, &base).await;
        eventually(60, "the order to fail", || {
            cloud
                .acknowledged("/node/v1/observations")
                .iter()
                .flat_map(|report| report["orders"].as_array().cloned().unwrap_or_default())
                .any(|order| {
                    order["operation"] == operation
                        && order["status"] == "failed"
                        && order["reason"] == "reboot_failed"
                })
        })
        .await;
        // The packages are installed and the node did not boot again. Of the two kernels only the
        // running one counts, so the digest changed with bash alone, and the hello says it: a
        // rollback to the release that was running must not find the old digest.
        let after = crate::machine::os_report(&*machine).await.unwrap();
        assert_ne!(after["packages_sha256"], before["packages_sha256"]);
        assert_eq!(after["boot_id"], before["boot_id"]);
        assert_eq!(after["kernel_release"], "6.12.111+deb13-amd64");
        eventually(30, "the new packages to be said", || {
            cloud.with(|inner| inner.hellos.iter().any(|hello| hello["os"] == after))
        })
        .await;
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
                release_key: test_release_key(),
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
