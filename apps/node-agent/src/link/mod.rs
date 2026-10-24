// SPDX-License-Identifier: Apache-2.0
//! The node's link to Cloudflare (ULTRA plan 5.3, 5.6 job 1, 8, 9.2). A node enrolls once with the
//! seed the installer wrote and a key it generated, then signs every request with that key. The
//! link keeps the outbound WebSocket to the node's NodeActor, pulls the desired page, posts
//! observations and volume reports, and delivers usage rows and events from a bounded outbox.
//!
//! The contract is `packages/contracts/src/node-link.ts`; `node_link.rs` reads its schemas.
//! Responses other than the enrollment, the desired page and the credentials carry no data the
//! node needs: a success is the acknowledgement.
mod backoff;
mod desired;
mod events;
pub(crate) mod file;
mod identity;
mod outbox;
mod request;
mod socket;
#[cfg(test)]
pub(crate) mod test_server;

pub use desired::{Desired, Order};
pub use events::LinkEvent;
pub(crate) use identity::transient;
pub use identity::{NodeIdentity, Paths};
pub use outbox::Flushed;
pub use request::{Fenced, Transport};

use crate::{
    Error,
    api::Refusal,
    node_link::{constant, contract_valid, schema_valid},
};
use events::Events;
use request::Api;
use serde_json::{Value, json};
use std::sync::Arc;
use tokio::{sync::watch, task::JoinHandle};
use tokio_tungstenite::tungstenite;

use std::time::Duration;

/// The waits and bounds of the link. The defaults are the product's; tests shorten them.
#[derive(Clone, Debug)]
pub struct Timing {
    /// The wait before a second attempt, and the ceiling it doubles to.
    pub backoff_minimum: Duration,
    pub backoff_maximum: Duration,
    /// A connection that lasted this long was a good one: the next reconnect starts from the
    /// minimum again.
    pub stable_after: Duration,
    /// How long the connection and the `welcome` of a new link may take.
    pub handshake: Duration,
    /// The cadence of the link's pings and of the retries of the outbox. A link that has been
    /// silent for three of them is dead.
    pub interval: Duration,
    /// How long the enrollment is retried: the lifetime of the installer's token.
    pub enrollment_window: Duration,
}
impl Default for Timing {
    fn default() -> Self {
        Self {
            backoff_minimum: Duration::from_secs(1),
            backoff_maximum: Duration::from_secs(60),
            stable_after: Duration::from_secs(30),
            handshake: Duration::from_secs(10),
            interval: Duration::from_millis(
                crate::node_link::constant("NODE_SAMPLE_INTERVAL_MS")
                    .as_u64()
                    .expect("generated interval"),
            ),
            enrollment_window: Duration::from_secs(
                crate::node_link::constant("ENROLLMENT_TOKEN_LIFETIME_SECONDS")
                    .as_u64()
                    .expect("generated lifetime"),
            ),
        }
    }
}

/// One line on the agent's log: the class of a failure, never its text, which can carry an address.
fn log(event: &str, error: &Error) {
    crate::timing::emit_event(line(event, error));
}
/// The line of `log`. Cloudflare's refusal, of a request or of the upgrade, is named by its HTTP
/// status, which tells a rejected signature (401) from a limit (429) and an outage (503), and
/// by its error code when that is a plain word of the API's own.
fn line(event: &str, error: &Error) -> Value {
    let mut line = json!({"event": event, "class": crate::diagnostics::error_code(error)});
    if let Some(refusal) = error.downcast_ref::<Refusal>() {
        line["class"] = format!("http_{}", refusal.status).into();
        if let Some(code) = refusal.code.as_deref().filter(|code| plain(code)) {
            line["code"] = code.into();
        }
    } else if let Some(tungstenite::Error::Http(response)) = error.downcast_ref() {
        line["class"] = format!("http_{}", response.status().as_u16()).into();
    }
    line
}
/// A code the API names itself, like `unauthorized`; anything else is a server's own text.
fn plain(code: &str) -> bool {
    (1..=40).contains(&code.len()) && code.bytes().all(|b| b.is_ascii_lowercase() || b == b'_')
}

/// What the link needs to know about its node.
pub struct LinkConfig {
    pub paths: Paths,
    /// The image version the enrollment token is bound to.
    pub image_version: String,
    pub agent_version: String,
    /// The release the agent runs, for the hello of the link.
    pub release_id: Option<String>,
    /// The boot and operating system of the node (`NodeOs`), for the hello of the link.
    pub os: Value,
    pub timing: Timing,
}

/// The node's link to Cloudflare. Clones share one link.
#[derive(Clone)]
pub struct Link {
    inner: Arc<Inner>,
}
struct Inner {
    api: Arc<Api>,
    outbox: Arc<outbox::Outbox>,
    events: Arc<Events>,
    samples: watch::Sender<Option<String>>,
    /// The hello every new connection of the link starts with.
    hello: watch::Sender<Value>,
    tasks: Vec<JoinHandle<()>>,
}
impl Drop for Inner {
    fn drop(&mut self) {
        for task in &self.tasks {
            task.abort();
        }
        self.events.close();
    }
}

/// What Cloudflare asks of the agent, in order. It ends when the link does: after a fence, or
/// when every clone of the `Link` is dropped.
pub struct LinkEvents {
    events: Arc<Events>,
}
impl LinkEvents {
    pub async fn next(&mut self) -> Option<LinkEvent> {
        self.events.next().await
    }
}

impl Link {
    /// Enrolls the node if it is not enrolled yet, then starts the link. The WebSocket connects in
    /// the background, and reconnects with backoff.
    pub async fn start(
        config: LinkConfig,
        transport: Transport,
    ) -> Result<(Link, LinkEvents), Error> {
        let identity = identity::establish(
            &config.paths,
            &transport,
            &config.image_version,
            &config.timing,
        )
        .await?;
        let events = Arc::new(Events::default());
        let api = Arc::new(Api::new(transport, Arc::new(identity), events.clone()));
        let hello = json!({
            "type": "hello",
            "protocol": constant("NODE_PROTOCOL_VERSION"),
            "agent_version": config.agent_version,
            "release_id": config.release_id,
            "capabilities": ["restore_in_place_v1"],
            "os": config.os,
        });
        if !schema_valid("AgentLinkMessage", &hello) {
            return Err("native link hello invalid".into());
        }
        let outbox = Arc::new(outbox::Outbox::new(
            api.clone(),
            config.paths.link().join("usage-outbox.json"),
        ));
        let (samples, latest) = watch::channel(None);
        let (hello, greeting) = watch::channel(hello);
        let tasks = vec![
            tokio::spawn(socket::run(
                api.clone(),
                events.clone(),
                latest,
                greeting,
                config.timing.clone(),
            )),
            tokio::spawn(deliver(
                outbox.clone(),
                events.clone(),
                config.timing.interval,
            )),
        ];
        let inner = Inner {
            api,
            outbox,
            events: events.clone(),
            samples,
            hello,
            tasks,
        };
        Ok((
            Link {
                inner: Arc::new(inner),
            },
            LinkEvents { events },
        ))
    }

    /// Changes the boot and operating system the hello reports, when the packages changed in a
    /// maintenance cycle that did not reboot. The link says hello again on a new connection; the
    /// same `os` changes nothing. Nothing is taken that the contract refuses.
    pub fn set_os(&self, os: &Value) -> Result<(), Error> {
        let mut hello = self.inner.hello.borrow().clone();
        hello["os"] = os.clone();
        if !schema_valid("AgentLinkMessage", &hello) {
            return Err("native link hello invalid".into());
        }
        self.inner.hello.send_if_modified(|current| {
            let changed = *current != hello;
            if changed {
                *current = hello;
            }
            changed
        });
        Ok(())
    }

    pub fn node(&self) -> &NodeIdentity {
        &self.inner.api.identity().node
    }

    /// Pulls the desired page: all of it (`None`), or the databases named. The orders are on it.
    pub async fn desired_page(&self, ids: Option<&[String]>) -> Result<Desired, Error> {
        desired::pull(&self.inner.api, ids).await
    }

    /// Reads the node's credentials (`NodeCredentials`): the Tunnel token and the route keyring.
    /// Read them when the page's `credentials_revision` is above the revision applied.
    pub async fn credentials(&self) -> Result<Value, Error> {
        let credentials = self.inner.api.get(path("credentials")?).await?;
        if !schema_valid("NodeCredentials", &credentials) {
            return Err("Cloudflare credentials invalid".into());
        }
        Ok(credentials)
    }

    /// Reads the temporary R2 credential `id` (`ArchiveCredential`) that a database of the desired
    /// page names. It is scoped to one archive path and never deletes.
    pub async fn archive_credential(&self, id: &str) -> Result<Value, Error> {
        let valid = id.strip_prefix("crd_").is_some_and(|rest| {
            rest.len() == 20
                && rest
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        });
        if !valid {
            return Err("invalid archive credential identifier".into());
        }
        let target = format!("{}{id}", path("archiveCredentials")?);
        let credential = self.inner.api.get(&target).await?;
        if !schema_valid("ArchiveCredential", &credential) || credential["id"] != id {
            return Err("Cloudflare archive credential invalid".into());
        }
        Ok(credential)
    }

    /// Posts what the node observed of its databases and how its orders ended
    /// (`NodeObservationReport`). Returns the databases whose observation Cloudflare took (the
    /// verdict `accept`), which it holds from then on; the others, `stale` or in `conflict`, it
    /// does not hold, and the node reports them again from the page it pulls next. The agent builds
    /// a new report from its state when this fails.
    pub async fn post_observation(&self, report: &Value) -> Result<Vec<String>, Error> {
        if !contract_valid("NodeObservationReport", report) {
            return Err("native observations report invalid".into());
        }
        let answer = self
            .inner
            .api
            .post_answer(path("observations")?, report)
            .await?;
        if !contract_valid("NodeObservationAnswer", &answer) {
            return Err("native observations answer invalid".into());
        }
        Ok(answer["databases"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|database| database["verdict"] == "accept")
            .filter_map(|database| database["id"].as_str().map(str::to_string))
            .collect())
    }

    /// Posts the journal of the previous boot (`NodeBootReport`), once after a reboot.
    pub async fn post_diagnostics(&self, report: &Value) -> Result<(), Error> {
        self.post("diagnostics", "NodeBootReport", report).await
    }

    /// Posts the result of a probe an administrator asked for (`NodeProbeResult`), once.
    pub async fn post_probe(&self, result: &Value) -> Result<(), Error> {
        self.post("diagnostics", "NodeProbeResult", result).await
    }

    /// Posts every thin volume of the node (`NodeVolumeReport`), sampled every 60 s.
    pub async fn post_volumes(&self, report: &Value) -> Result<(), Error> {
        self.post("volumes", "NodeVolumeReport", report).await
    }

    /// Hands the node's latest sample (`NodeSample`) to the link, which sends it to the NodeActor
    /// at once, and again after a reconnect until a newer one replaces it. Sample every 15 s.
    pub async fn post_samples(&self, sample: &Value) -> Result<(), Error> {
        let message = json!({"type": "sample", "sample": sample});
        if !contract_valid("AgentLinkMessage", &message) {
            return Err("native sample invalid".into());
        }
        self.inner.samples.send_replace(Some(message.to_string()));
        Ok(())
    }

    /// Persists usage rows (`NodeUsageRow`) to be delivered. They stay, unchanged, until Cloudflare
    /// answered them. None are taken when this fails, and the caller keeps its counters.
    pub fn queue_usage(&self, rows: &[Value]) -> Result<(), Error> {
        self.inner.outbox.queue_usage(rows)
    }

    /// Queues events (`NodeEvent`): admissions, early sleeps and wake timings.
    pub fn queue_events(&self, events: &[Value]) -> Result<(), Error> {
        self.inner.outbox.queue_events(events)
    }

    /// Delivers the queued rows and events now. The link also does so by itself.
    pub async fn flush(&self) -> Result<Flushed, Error> {
        self.inner.outbox.flush().await
    }

    /// Brings a file a release pins to `destination` if it has exactly the pinned size and digest
    /// (plan 9.3); a file that does not is removed.
    pub async fn fetch(
        &self,
        url: &str,
        size: u64,
        sha256: &str,
        destination: &std::path::Path,
    ) -> Result<(), Error> {
        self.inner
            .api
            .transport()
            .fetch(url, size, sha256, destination)
            .await
    }

    /// The bytes at `url`, at most `maximum` of them: what a release serves without a pin, such as
    /// its signature, which proves itself.
    pub async fn fetch_bytes(&self, url: &str, maximum: usize) -> Result<Vec<u8>, Error> {
        self.inner.api.transport().fetch_bytes(url, maximum).await
    }

    async fn post(&self, name: &str, schema: &str, report: &Value) -> Result<(), Error> {
        if !contract_valid(schema, report) {
            return Err(format!("native {name} report invalid").into());
        }
        self.inner.api.post(path(name)?, report).await
    }
}

/// A path of the node API.
fn path(name: &str) -> Result<&'static str, Error> {
    constant("NODE_API_PATHS")[name]
        .as_str()
        .ok_or_else(|| "unknown node API path".into())
}

/// Delivers what is queued when something is queued, and again every interval until it is
/// answered. A fenced node delivers nothing but keeps what it has.
async fn deliver(outbox: Arc<outbox::Outbox>, events: Arc<Events>, interval: Duration) {
    loop {
        tokio::select! {
            () = outbox.queued() => {}
            () = tokio::time::sleep(interval) => {}
        }
        if events.fenced() {
            return;
        }
        if let Err(error) = outbox.flush().await {
            log("outbox_flush_failed", &error);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use test_server::{Cloud, Failure, database, database_id, eventually, tempdir, vector};

    fn quick() -> Timing {
        Timing {
            backoff_minimum: Duration::from_millis(5),
            backoff_maximum: Duration::from_millis(20),
            interval: Duration::from_millis(40),
            ..Timing::default()
        }
    }
    async fn start(cloud: &Cloud, base: &std::path::Path) -> (Link, LinkEvents) {
        Link::start(
            LinkConfig {
                paths: Paths::new(base),
                image_version: "25".into(),
                agent_version: "0.1.0".into(),
                release_id: Some("release-25".into()),
                os: os(),
                timing: quick(),
            },
            Transport::new(cloud.roots()).unwrap(),
        )
        .await
        .unwrap()
    }
    /// The boot and operating system of the contract's example hello.
    fn os() -> Value {
        vector("AgentLinkMessage", "hello")["os"].clone()
    }
    async fn next(events: &mut LinkEvents) -> Option<LinkEvent> {
        tokio::time::timeout(Duration::from_secs(10), events.next())
            .await
            .expect("no event came")
    }
    fn class(error: &Error) -> Value {
        line("outbox_flush_failed", error)["class"].clone()
    }
    fn usage() -> Vec<Value> {
        vector("NodeUsageReport", "usage")["rows"]
            .as_array()
            .unwrap()
            .clone()
    }

    #[tokio::test]
    async fn an_enrolled_node_pulls_posts_and_delivers_through_its_link() {
        let cloud = Cloud::start().await;
        let base = tempdir();
        cloud.seed(&base);
        cloud.with(|inner| {
            inner.databases = vec![database(&database_id(1)), database(&database_id(2))]
        });
        let (link, mut events) = start(&cloud, &base).await;
        assert_eq!(link.node().id, test_server::NODE_ID);
        assert_eq!(next(&mut events).await, Some(LinkEvent::Desired(None)));
        // Pulls.
        let desired = link.desired_page(None).await.unwrap();
        assert_eq!(desired.databases.len(), 2);
        let credentials = link.credentials().await.unwrap();
        assert_eq!(credentials["revision"], 3);
        let archive = link
            .archive_credential("crd_kkkkkkkkkkkkkkkkkkkk")
            .await
            .unwrap();
        assert_eq!(archive["id"], "crd_kkkkkkkkkkkkkkkkkkkk");
        // Posts, the sample over the link.
        let observation = vector("NodeObservationReport", "asleep");
        let id = observation["databases"][0]["id"].as_str().unwrap();
        // Cloudflare's verdict on each database of the report: the node holds what it accepted.
        assert_eq!(link.post_observation(&observation).await.unwrap(), [id]);
        cloud.with(|inner| {
            inner.verdicts.insert(id.to_string(), "conflict");
        });
        assert!(
            link.post_observation(&observation)
                .await
                .unwrap()
                .is_empty()
        );
        cloud.with(|inner| {
            inner.verdicts.insert(id.to_string(), "stale");
        });
        assert!(
            link.post_observation(&observation)
                .await
                .unwrap()
                .is_empty()
        );
        cloud.with(|inner| inner.verdicts.clear());
        let volumes = vector("NodeVolumeReport", "volumes");
        link.post_volumes(&volumes).await.unwrap();
        assert_eq!(
            cloud.acknowledged("/node/v1/observations"),
            vec![observation.clone(); 3]
        );
        assert_eq!(cloud.acknowledged("/node/v1/volumes"), [volumes]);
        let sample = vector("NodeSample", "sample");
        link.post_samples(&sample).await.unwrap();
        eventually(|| cloud.with(|inner| inner.samples.clone()) == [sample.clone()]).await;
        // Usage and events are delivered without a flush.
        link.queue_usage(&usage()).unwrap();
        let wake_events = vector("NodeEventReport", "events")["events"]
            .as_array()
            .unwrap()
            .clone();
        link.queue_events(&wake_events).unwrap();
        eventually(|| {
            !cloud.acknowledged("/node/v1/usage").is_empty()
                && !cloud.acknowledged("/node/v1/events").is_empty()
        })
        .await;
        assert_eq!(
            cloud.acknowledged("/node/v1/usage")[0]["rows"],
            json!(usage())
        );
        assert_eq!(
            cloud.acknowledged("/node/v1/events")[0]["events"],
            json!(wake_events)
        );
        // Every request after the enrollment was signed by the node's key.
        assert!(
            cloud
                .requests()
                .iter()
                .skip(1)
                .all(|seen| seen.signed == Some(Ok(())))
        );
        // Nothing that breaks the contract leaves the node.
        let before = cloud.requests().len();
        assert!(
            link.post_observation(&json!({"observed_at":"now"}))
                .await
                .is_err()
        );
        assert!(link.post_volumes(&json!({})).await.is_err());
        assert!(link.post_samples(&json!({"memory":1})).await.is_err());
        assert!(link.archive_credential("../credentials").await.is_err());
        assert_eq!(cloud.requests().len(), before);
    }

    /// An API of a later release adds a property to every document it sends. The node enrolls,
    /// links, pulls and reads exactly as it does without it, and the property changes nothing it
    /// does (plan 9.3, "Changing the page").
    #[tokio::test]
    async fn an_api_of_a_later_release_adds_properties_and_the_node_works_as_before() {
        let cloud = Cloud::start().await;
        let base = tempdir();
        // The seed of an installer of a later release carries one too.
        std::fs::create_dir_all(base.join("enrollment")).unwrap();
        std::fs::write(
            base.join("enrollment/seed.json"),
            json!({"node_id":test_server::NODE_ID,"region":"eu-dev","api_url":cloud.origin,
                "enrollment_token":test_server::TOKEN,test_server::UNKNOWN_PROPERTY:1})
            .to_string(),
        )
        .unwrap();
        cloud.with(|inner| {
            inner.unknown_properties = true;
            inner.databases = vec![database(&database_id(1)), database(&database_id(2))];
            inner.orders =
                vec![json!({"type":"maintenance","operation":"op_tttttttttttttttttttt"})];
        });
        let (link, mut events) = start(&cloud, &base).await;
        assert_eq!(link.node().id, test_server::NODE_ID);
        // The welcome has one, and so has a hint to pull.
        assert_eq!(next(&mut events).await, Some(LinkEvent::Desired(None)));
        cloud
            .push(json!({"type":"desired","ids":[database_id(2)],test_server::UNKNOWN_PROPERTY:1}));
        assert_eq!(
            next(&mut events).await,
            Some(LinkEvent::Desired(Some(vec![database_id(2)])))
        );
        let desired = link.desired_page(None).await.unwrap();
        assert_eq!(desired.databases.len(), 2);
        assert_eq!(desired.orders.len(), 1);
        assert_eq!(link.credentials().await.unwrap()["revision"], 3);
        let archive = link
            .archive_credential("crd_kkkkkkkkkkkkkkkkkkkk")
            .await
            .unwrap();
        assert_eq!(archive["id"], "crd_kkkkkkkkkkkkkkkkkkkk");
        let observation = vector("NodeObservationReport", "asleep");
        let id = observation["databases"][0]["id"].as_str().unwrap();
        assert_eq!(link.post_observation(&observation).await.unwrap(), [id]);
        // A node it declared lost is still known as lost.
        cloud.with(|inner| inner.fenced = true);
        cloud.drop_links();
        assert_eq!(next(&mut events).await, Some(LinkEvent::Fenced));
    }

    #[tokio::test]
    async fn the_hello_names_the_boot_and_the_os_and_a_changed_os_is_said_on_a_new_link() {
        let cloud = Cloud::start().await;
        let base = tempdir();
        cloud.seed(&base);
        let (link, mut events) = start(&cloud, &base).await;
        assert_eq!(next(&mut events).await, Some(LinkEvent::Desired(None)));
        let hellos = || cloud.with(|inner| inner.hellos.clone());
        assert_eq!(
            hellos(),
            [vector("AgentLinkMessage", "hello-with-in-place-restore")]
        );
        // The packages changed in a maintenance cycle: the next hello says so, on a new link.
        let mut installed = os();
        installed["packages_sha256"] = "b".repeat(64).into();
        link.set_os(&installed).unwrap();
        assert_eq!(next(&mut events).await, Some(LinkEvent::Desired(None)));
        eventually(|| hellos().len() == 2).await;
        assert_eq!(hellos()[1]["os"], installed);
        assert_eq!(hellos()[1]["release_id"], "release-25");
        // The same os opens no new link, and an os the contract refuses is not taken.
        link.set_os(&installed).unwrap();
        assert!(link.set_os(&json!({"boot_id": "boot"})).is_err());
        assert!(link.set_os(&Value::Null).is_err());
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(hellos().len(), 2);
    }

    #[tokio::test]
    async fn a_refusal_is_logged_by_its_status_and_a_plain_code_never_by_its_text() {
        let cloud = Cloud::start().await;
        let (api, _) = request::tests::enrolled(&cloud).await;
        // A rejected signature, rate limiting and an outage are three different classes.
        let key = cloud.with(|inner| inner.public_key.take());
        let rejected = api.get("/node/v1/desired").await.unwrap_err();
        cloud.with(|inner| inner.public_key = key);
        cloud.fail_next([Failure::Status(429), Failure::Status(503)]);
        let limited = api.post("/node/v1/volumes", &json!({})).await.unwrap_err();
        let unavailable = api.post("/node/v1/volumes", &json!({})).await.unwrap_err();
        assert_eq!(
            line("outbox_flush_failed", &rejected),
            json!({"event":"outbox_flush_failed","class":"http_401","code":"unauthorized"})
        );
        assert_eq!(class(&limited), "http_429");
        assert_eq!(class(&unavailable), "http_503");
        // A code that is no plain word of the API's is not logged: it is the server's text.
        for code in [
            "10.0.0.7 refused",
            "Bearer abc",
            "x".repeat(200).as_str(),
            "",
        ] {
            let refusal = Refusal {
                status: 502,
                code: Some(code.into()),
            };
            assert_eq!(
                line("link_down", &refusal.into()),
                json!({"event":"link_down","class":"http_502"}),
                "{code}"
            );
        }
        // A fence and a failure of the agent's own keep the names they had.
        assert_eq!(class(&Fenced.into()), "node_fenced");
        assert_eq!(class(&"link silent".into()), "link_silent");
    }

    #[tokio::test]
    async fn a_restart_keeps_the_identity_and_the_rows_that_were_not_answered() {
        let cloud = Cloud::start().await;
        let base = tempdir();
        cloud.seed(&base);
        let (link, mut events) = start(&cloud, &base).await;
        next(&mut events).await;
        // Cloudflare is unavailable for the rows; the agent stops before they are answered.
        cloud.fail_next(std::iter::repeat_n(Failure::Status(503), 100));
        link.queue_usage(&usage()).unwrap();
        eventually(|| !cloud.posted("/node/v1/usage").is_empty()).await;
        assert!(cloud.acknowledged("/node/v1/usage").is_empty());
        drop(link);
        // With every clone dropped, the events end, after the pulls that were pending: a link
        // that was starved for three intervals came back with a pull of its own.
        while next(&mut events).await.is_some() {}
        cloud.with(|inner| inner.failures.clear());
        let (restarted, mut events) = start(&cloud, &base).await;
        assert_eq!(restarted.node().id, test_server::NODE_ID);
        assert_eq!(
            cloud.posted("/node/v1/enroll").len(),
            1,
            "no second enrollment"
        );
        assert_eq!(next(&mut events).await, Some(LinkEvent::Desired(None)));
        eventually(|| !cloud.acknowledged("/node/v1/usage").is_empty()).await;
        assert_eq!(
            cloud.acknowledged("/node/v1/usage")[0]["rows"],
            json!(usage())
        );
    }

    #[tokio::test]
    async fn a_fenced_node_still_pulls_its_page_and_reports_its_observations() {
        let cloud = Cloud::start().await;
        let base = tempdir();
        cloud.seed(&base);
        let (link, mut events) = start(&cloud, &base).await;
        next(&mut events).await;
        let fenced = vector("NodeDesiredPage", "fenced-page");
        cloud.with(|inner| {
            inner.fenced = true;
            inner.orders = fenced["orders"].as_array().unwrap().clone();
        });
        cloud.drop_links();
        assert_eq!(next(&mut events).await, Some(LinkEvent::Fenced));
        assert_eq!(next(&mut events).await, Some(LinkEvent::Desired(None)));
        let desired = link.desired_page(None).await.unwrap();
        assert!(matches!(desired.orders[0], Order::Fence { .. }));
        // The observations of a fenced node are read for its orders alone: no database is taken.
        assert!(
            link.post_observation(&vector("NodeObservationReport", "asleep"))
                .await
                .unwrap()
                .is_empty()
        );
        assert!(
            link.post_volumes(&vector("NodeVolumeReport", "volumes"))
                .await
                .unwrap_err()
                .is::<Fenced>()
        );
        assert_eq!(next(&mut events).await, None, "the link does not come back");
    }
}
