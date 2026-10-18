// SPDX-License-Identifier: Apache-2.0
//! The outbound WebSocket to the node's NodeActor (plan 4.9, 5.6 job 1): it carries the node's
//! sample every 15 s, and Cloudflare's request to pull the desired page.
use super::{
    Timing,
    backoff::Backoff,
    events::Events,
    request::{Api, Fenced},
};
use crate::{
    Error,
    node_link::{constant, schema_valid},
};
use futures_util::{SinkExt, StreamExt};
use reqwest::header::{AUTHORIZATION, HeaderValue};
use rustls_pki_types::ServerName;
use serde_json::Value;
use std::{sync::Arc, time::Duration};
use tokio::{
    net::TcpStream,
    sync::watch,
    time::{Instant, MissedTickBehavior, interval_at, timeout},
};
use tokio_rustls::{TlsConnector, client::TlsStream};
use tokio_tungstenite::{
    WebSocketStream, client_async_with_config,
    tungstenite::{self, Message, client::IntoClientRequest, protocol::WebSocketConfig},
};

type Socket = WebSocketStream<TlsStream<TcpStream>>;

fn message_bound() -> usize {
    constant("NODE_LINK_MESSAGE_MAX_BYTES")
        .as_u64()
        .and_then(|bytes| usize::try_from(bytes).ok())
        .expect("generated message bound")
}

/// Keeps the link up until the node is fenced: connects, says hello, sends the latest sample
/// whenever there is a new one, turns the server's messages into events and reconnects with
/// backoff. `hello` is the `AgentLinkMessage` hello, which a new connection says again when it
/// changes; `samples` holds the serialized samples.
pub(super) async fn run(
    api: Arc<Api>,
    events: Arc<Events>,
    mut samples: watch::Receiver<Option<String>>,
    mut hello: watch::Receiver<Value>,
    timing: Timing,
) {
    let mut backoff = Backoff::new(timing.backoff_minimum, timing.backoff_maximum);
    loop {
        let started = Instant::now();
        match serve(&api, &events, &mut samples, &mut hello, &timing).await {
            // A fence ends only with a reinstall: the link never comes back (plan 9.4).
            Err(error) if error.is::<Fenced>() => {
                events.fence();
                events.close();
                return;
            }
            Err(error) => super::log("link_down", &error),
            Ok(()) => {}
        }
        tokio::time::sleep(wait_after(
            &mut backoff,
            started.elapsed(),
            timing.stable_after,
        ))
        .await;
    }
}

/// The wait before the next attempt: a connection that lasted `stable_after` was a good one, so
/// the wait starts from the minimum again.
fn wait_after(backoff: &mut Backoff, lasted: Duration, stable_after: Duration) -> Duration {
    if lasted >= stable_after {
        backoff.reset();
    }
    backoff.wait()
}

/// One connection, from the upgrade to its end.
async fn serve(
    api: &Api,
    events: &Events,
    samples: &mut watch::Receiver<Option<String>>,
    hello: &mut watch::Receiver<Value>,
    timing: &Timing,
) -> Result<(), Error> {
    let mut socket = timeout(timing.handshake, open(api)).await??;
    let greeting = hello.borrow_and_update().to_string();
    send(&mut socket, Message::text(greeting), timing.handshake).await?;
    let welcome = timeout(timing.handshake, welcome(&mut socket)).await??;
    if welcome["type"] != "welcome" {
        return Err("link did not welcome the node".into());
    }
    // Pushes that came while the link was down are lost: pull the whole page.
    events.pull(None);
    let latest = samples.borrow_and_update().clone();
    if let Some(sample) = latest {
        send(&mut socket, Message::text(sample), timing.handshake).await?;
    }
    let mut heard = Instant::now();
    let mut ping = interval_at(Instant::now() + timing.interval, timing.interval);
    ping.set_missed_tick_behavior(MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            message = socket.next() => {
                heard = Instant::now();
                match message {
                    None | Some(Ok(Message::Close(_))) => return Ok(()),
                    Some(Err(error)) => return Err(error.into()),
                    Some(Ok(Message::Text(text))) => server_message(text.as_str(), events)?,
                    Some(Ok(Message::Ping(_) | Message::Pong(_))) => {}
                    Some(Ok(_)) => return Err("link message is not text".into()),
                }
            }
            // A hello that changed is said on a new connection: a link says hello once.
            changed = hello.changed() => {
                changed?;
                return Ok(());
            }
            changed = samples.changed() => {
                changed?;
                let latest = samples.borrow_and_update().clone();
                if let Some(sample) = latest {
                    send(&mut socket, Message::text(sample), timing.handshake).await?;
                }
            }
            _ = ping.tick() => {
                // Nothing came for three intervals, not even a pong: the peer is gone.
                if heard.elapsed() > timing.interval * 3 {
                    return Err("link silent".into());
                }
                send(&mut socket, Message::Ping(Default::default()), timing.handshake).await?;
            }
        }
    }
}

async fn send(socket: &mut Socket, message: Message, bound: Duration) -> Result<(), Error> {
    timeout(bound, socket.send(message)).await??;
    Ok(())
}

/// The first message of the server, which must be valid: the `welcome`.
async fn welcome(socket: &mut Socket) -> Result<Value, Error> {
    loop {
        match socket.next().await {
            Some(Ok(Message::Text(text))) => {
                let message: Value = serde_json::from_str(text.as_str())?;
                if !schema_valid("ServerLinkMessage", &message) {
                    return Err("link message invalid".into());
                }
                return Ok(message);
            }
            Some(Ok(Message::Ping(_) | Message::Pong(_))) => {}
            Some(Err(error)) => return Err(error.into()),
            _ => return Err("link closed before it welcomed the node".into()),
        }
    }
}

/// A message after the welcome: Cloudflare asks for a pull of the desired page.
fn server_message(text: &str, events: &Events) -> Result<(), Error> {
    let message: Value = serde_json::from_str(text)?;
    if !schema_valid("ServerLinkMessage", &message) {
        return Err("link message invalid".into());
    }
    if message["type"] != "desired" {
        return Err("unexpected link message".into());
    }
    let ids: Option<Vec<String>> = message["ids"].as_array().map(|ids| {
        ids.iter()
            .filter_map(|id| id.as_str().map(str::to_string))
            .collect()
    });
    events.pull(ids.as_deref());
    Ok(())
}

/// Opens the link: TCP, TLS and the upgrade, signed as a GET of `/node/v1/link` with no body. A
/// node that was declared lost is answered 403 `node_fenced`.
async fn open(api: &Api) -> Result<Socket, Error> {
    let (mut url, bearer) = api.signed("GET", "/node/v1/link", &[])?;
    url.set_scheme("wss").map_err(|()| "link scheme invalid")?;
    let host = url.host_str().ok_or("link host missing")?.to_string();
    let port = url.port_or_known_default().ok_or("link port missing")?;
    let tcp = TcpStream::connect((host.as_str(), port)).await?;
    tcp.set_nodelay(true)?;
    let tls = TlsConnector::from(api.transport().tls.clone())
        .connect(ServerName::try_from(host)?, tcp)
        .await?;
    let mut request = url.as_str().into_client_request()?;
    let mut authorization = HeaderValue::from_str(&format!("Bearer {bearer}"))?;
    authorization.set_sensitive(true);
    request.headers_mut().insert(AUTHORIZATION, authorization);
    let bound = Some(message_bound());
    let config = WebSocketConfig::default()
        .max_message_size(bound)
        .max_frame_size(bound);
    match client_async_with_config(request, tls, Some(config)).await {
        Ok((socket, _)) => Ok(socket),
        Err(tungstenite::Error::Http(response))
            if response.status() == 403
                && response
                    .body()
                    .as_deref()
                    .and_then(|body| serde_json::from_slice::<Value>(body).ok())
                    .is_some_and(|body| schema_valid("NodeFencedResponse", &body)) =>
        {
            Err(Box::new(Fenced))
        }
        Err(error) => Err(error.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::link::{
        events::LinkEvent,
        request::tests::enrolled,
        test_server::{Cloud, eventually},
    };
    use serde_json::{Value, json};
    use tokio::task::JoinHandle;

    fn quick() -> Timing {
        Timing {
            backoff_minimum: Duration::from_millis(5),
            backoff_maximum: Duration::from_millis(20),
            stable_after: Duration::from_secs(60),
            handshake: Duration::from_secs(5),
            interval: Duration::from_millis(40),
            ..Timing::default()
        }
    }
    fn hello() -> Value {
        crate::link::test_server::vector("AgentLinkMessage", "hello")
    }
    fn sample(available: u64) -> Value {
        let mut sample = crate::link::test_server::vector("NodeSample", "sample");
        sample["memory"]["available_bytes"] = available.into();
        sample
    }
    fn message(sample: &Value) -> String {
        json!({"type":"sample","sample":sample}).to_string()
    }

    /// The next event, or a failure of the test when none comes.
    async fn next(events: &Events) -> Option<LinkEvent> {
        tokio::time::timeout(Duration::from_secs(10), events.next())
            .await
            .expect("no event came")
    }

    struct Link {
        cloud: Cloud,
        events: Arc<Events>,
        samples: watch::Sender<Option<String>>,
        /// The link keeps saying this hello; kept so that the channel stays open.
        _hello: watch::Sender<Value>,
        task: JoinHandle<()>,
    }
    impl Drop for Link {
        fn drop(&mut self) {
            self.task.abort();
        }
    }
    async fn link(timing: Timing, prepare: impl FnOnce(&Cloud)) -> Link {
        let cloud = Cloud::start().await;
        let (api, events) = enrolled(&cloud).await;
        prepare(&cloud);
        let (samples, receiver) = watch::channel(None);
        let (_hello, hello_receiver) = watch::channel(hello());
        let task = tokio::spawn(run(
            Arc::new(api),
            events.clone(),
            receiver,
            hello_receiver,
            timing,
        ));
        Link {
            cloud,
            events,
            samples,
            _hello,
            task,
        }
    }

    #[tokio::test]
    async fn a_welcomed_link_has_said_hello_and_asks_for_a_full_pull() {
        let link = link(quick(), |_| {}).await;
        assert_eq!(next(&link.events).await, Some(LinkEvent::Desired(None)));
        let hellos = link.cloud.with(|inner| inner.hellos.clone());
        assert_eq!(hellos, [hello()]);
        // The upgrade was signed as a GET of the link with no body.
        let upgrade = link.cloud.requests().pop().unwrap();
        assert_eq!(
            (upgrade.method.as_str(), upgrade.path()),
            ("GET", "/node/v1/link")
        );
        assert_eq!(upgrade.signed, Some(Ok(())));
    }

    #[tokio::test]
    async fn what_cloudflare_asks_for_becomes_an_event_and_a_bad_message_ends_the_connection() {
        let link = link(quick(), |_| {}).await;
        assert_eq!(next(&link.events).await, Some(LinkEvent::Desired(None)));
        link.cloud
            .push(json!({"type":"desired","ids":["a0000000000000000003"]}));
        assert_eq!(
            next(&link.events).await,
            Some(LinkEvent::Desired(Some(vec![
                "a0000000000000000003".into()
            ])))
        );
        link.cloud.push(json!({"type":"desired"}));
        assert_eq!(next(&link.events).await, Some(LinkEvent::Desired(None)));
        // Anything the contract does not know ends the connection; the link comes back.
        for bad in [
            json!({"type":"reboot"}),
            json!({"type":"welcome","protocol":1}),
        ] {
            let before = link.cloud.with(|inner| inner.hellos.len());
            link.cloud.push(bad);
            eventually(|| link.cloud.with(|inner| inner.hellos.len()) > before).await;
            assert_eq!(next(&link.events).await, Some(LinkEvent::Desired(None)));
        }
    }

    #[tokio::test]
    async fn samples_reach_the_node_actor_and_the_latest_is_sent_again_after_a_reconnect() {
        let link = link(quick(), |_| {}).await;
        next(&link.events).await;
        link.samples.send_replace(Some(message(&sample(1))));
        eventually(|| link.cloud.with(|inner| inner.samples.len()) == 1).await;
        link.cloud.drop_links();
        eventually(|| link.cloud.with(|inner| inner.hellos.len()) == 2).await;
        eventually(|| link.cloud.with(|inner| inner.samples.len()) == 2).await;
        link.samples.send_replace(Some(message(&sample(2))));
        eventually(|| link.cloud.with(|inner| inner.samples.len()) == 3).await;
        assert_eq!(
            link.cloud.with(|inner| inner.samples.clone()),
            [sample(1), sample(1), sample(2)]
        );
        // The reconnect asked for a full pull again: pushes may have been missed meanwhile.
        assert_eq!(next(&link.events).await, Some(LinkEvent::Desired(None)));
    }

    #[tokio::test]
    async fn a_server_that_goes_silent_is_noticed_by_the_pings_it_does_not_answer() {
        let link = link(quick(), |_| {}).await;
        next(&link.events).await;
        link.cloud.stall_links();
        eventually(|| link.cloud.with(|inner| inner.hellos.len()) == 2).await;
    }

    #[tokio::test]
    async fn a_server_that_does_not_welcome_is_dropped_after_the_handshake_time() {
        let timing = Timing {
            handshake: Duration::from_millis(100),
            ..quick()
        };
        let link = link(timing, |cloud| {
            cloud.with(|inner| inner.silent_welcome = true)
        })
        .await;
        eventually(|| link.cloud.with(|inner| inner.hellos.len()) >= 2).await;
        assert!(futures_util::poll!(std::pin::pin!(link.events.next())).is_pending());
    }

    #[tokio::test]
    async fn a_fenced_node_is_told_once_and_its_link_stops() {
        let link = link(quick(), |cloud| cloud.with(|inner| inner.fenced = true)).await;
        assert_eq!(next(&link.events).await, Some(LinkEvent::Fenced));
        assert_eq!(next(&link.events).await, Some(LinkEvent::Desired(None)));
        assert_eq!(next(&link.events).await, None);
        tokio::time::sleep(Duration::from_millis(200)).await;
        let attempts = link
            .cloud
            .requests()
            .iter()
            .filter(|s| s.path() == "/node/v1/link")
            .count();
        assert_eq!((attempts, link.cloud.with(|inner| inner.upgrades)), (1, 0));
    }

    #[tokio::test]
    async fn an_upgrade_that_is_refused_is_logged_by_its_status() {
        let cloud = Cloud::start().await;
        let (api, _) = enrolled(&cloud).await;
        cloud.with(|inner| inner.public_key = Some(vec![1; 32]));
        let error = open(&api).await.err().unwrap();
        assert_eq!(super::super::line("link_down", &error)["class"], "http_401");
    }

    #[test]
    fn a_good_connection_restarts_the_backoff_and_a_short_one_does_not() {
        let mut backoff = Backoff::new(Duration::from_secs(1), Duration::from_secs(60));
        let short = Duration::from_secs(2);
        let waits: Vec<Duration> = (0..6)
            .map(|_| wait_after(&mut backoff, short, Duration::from_secs(30)))
            .collect();
        assert!(waits[5] > Duration::from_secs(8), "{waits:?}");
        let wait = wait_after(
            &mut backoff,
            Duration::from_secs(31),
            Duration::from_secs(30),
        );
        assert!(wait <= Duration::from_secs(1) && wait >= Duration::from_millis(500));
    }
}
