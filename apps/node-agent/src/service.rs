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
};
use pgcf_native_protocol::wake::WakeRequest;
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    sync::{Arc, Mutex, PoisonError},
    time::Duration,
};
use tokio::{sync::mpsc, task::JoinSet};

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
    /// the service is dropped.
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
        });

        // The two sockets of the agent: the archive socket for the databases' units, and the
        // gateway's channel, which only the gateway's user may reach.
        let archive = Arc::new(Server::new(table, jobs, credentials));
        let listener = bind_archive(&layout.archive_socket())?;
        let channel = bind_gateway(&layout.gateway_socket(), 0o600, config.gateway)?;
        let (wake_sender, wakes) = mpsc::unbounded_channel();
        {
            let mut tasks = service.tasks.lock().unwrap_or_else(PoisonError::into_inner);
            tasks.spawn(async move {
                archive.serve(listener).await;
            });
            let feed = gateway.clone();
            let owner = config.gateway.map(|(uid, _)| uid);
            tasks.spawn(async move {
                feed.serve(channel, wake_sender, owner).await;
            });
        }
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

        let s = service.clone();
        service.spawn(async move { s.follow(&mut events).await });
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
        service.spawn(async move { s.early_sleeps(early).await });
        Ok(service)
    }

    pub fn core(&self) -> &Arc<Core<M>> {
        &self.core
    }

    fn spawn(&self, task: impl std::future::Future<Output = ()> + Send + 'static) {
        self.tasks
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .spawn(task);
    }

    /// What a boot does (plan 5.6 job 4, 4.3): the memory ceiling of all databases, the CPU quota
    /// of every stopped unit lifted, the volumes of the page's databases mounted, and the socket
    /// directory of every database the node has made, which `/run` lost.
    async fn boot(&self, page: &Page) {
        let budget = self.core.policy().admission.admission.awake_budget_mib;
        let _ = self.machine.set_slice_memory(budget).await;
        if let Ok(units) = self.machine.units().await {
            for unit in units.iter().filter(|unit| !unit.active.awake()) {
                let _ = self.machine.set_cpu_quota(&unit.database, None).await;
            }
        }
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
        if let Ok(inventory) = self.machine.inventory().await {
            for volume in inventory.volumes {
                if let Some(account) = self.machine.account(volume.id.database()) {
                    let _ = self
                        .machine
                        .prepare_socket_directory(volume.id.database(), &account);
                }
            }
        }
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
        let region = self.link.node().region_id.clone();
        match self
            .machine
            .apply_credentials(&region, &credentials, applied.is_some())
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

    async fn pull_page(&self, page: Page) {
        self.deliver_credentials(&page).await;
        self.apply_credentials(&page).await;
        self.core.apply(&page).await;
    }

    async fn pull(&self, ids: Option<&[String]>) {
        match self.link.desired_page(ids).await {
            Ok(page) => self.pull_page(page).await,
            Err(error) => crate::timing::emit_event(json!({
                "event": "desired_pull_failed", "class": crate::diagnostics::error_code(&error),
            })),
        }
    }

    /// What Cloudflare asks: a pull of the page, or the fence (after which the page holds the
    /// fence order and the link ends).
    async fn follow(&self, events: &mut LinkEvents) {
        while let Some(event) = events.next().await {
            match event {
                LinkEvent::Desired(ids) => self.pull(ids.as_deref()).await,
                LinkEvent::Fenced => {}
            }
        }
    }

    /// The whole page again at an interval: a message the link lost is made up for.
    async fn full_pulls(&self) {
        let mut tick = tokio::time::interval(self.intervals.full_pull);
        tick.tick().await;
        loop {
            tick.tick().await;
            self.pull(None).await;
        }
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

    /// The units that ended on their own, and the databases nobody uses.
    async fn watches(&self) {
        let (watch, idle) = (self.core.timing.watch, self.core.timing.idle_poll);
        let mut watching = tokio::time::interval(watch);
        let mut idling = tokio::time::interval(idle);
        loop {
            tokio::select! {
                _ = watching.tick() => self.core.watch_pass().await,
                _ = idling.tick() => self.core.idle_pass().await,
            }
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
        node_link::schema_valid,
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
            schema_valid("NodeSample", &sample["sample"]) || schema_valid("NodeSample", &sample)
        );
        assert_eq!(
            machine.credentials_applied(),
            [("eu-dev".to_string(), 3, false)]
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
}
