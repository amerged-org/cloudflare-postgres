// SPDX-License-Identifier: Apache-2.0
//! The controller's intake of wakes (pool design 2026-10-16): one long-poll per gateway Pod on
//! the gateway's control port, signed with a `gw1` token for that Pod. The controller stays a
//! client: the gateway holds the client connection and queues the wake; the poll hands it over.
use crate::{Error, power::GatewayPod, power::PowerCoordinator};
use futures_util::{
    StreamExt,
    future::{AbortHandle, abortable},
    stream::FuturesUnordered,
};
use pgcf_native_protocol::wake::{WakeRequest, WakeResult};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::mpsc;

/// How often the set of gateway Pods is read again.
const PODS_EVERY: Duration = Duration::from_secs(5);
/// The pause after a poll that failed.
const RETRY_AFTER: Duration = Duration::from_secs(1);
/// How long a wake result may take; it is never waited for by a decision.
const RESULT_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Clone)]
pub struct Intake {
    pub(crate) http: reqwest::Client,
    /// Per gateway Pod UID, how its latest poll was answered since this controller started:
    /// `true` for a wake poll, `false` for a gateway that does not know the action.
    answered: Arc<Mutex<HashMap<String, bool>>>,
}
fn now_ms() -> u64 {
    u64::try_from(time::OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000).unwrap_or(0)
}
fn host(pod: &GatewayPod) -> String {
    if pod.ip.contains(':') {
        format!("[{}]", pod.ip)
    } else {
        pod.ip.clone()
    }
}
impl Intake {
    pub fn new() -> Result<Self, Error> {
        Ok(Self {
            http: crate::cluster_http(Duration::from_millis(
                pgcf_native_protocol::wake::POLL_HOLD_MS + 5_000,
            ))?,
            answered: Arc::default(),
        })
    }
    /// Whether every one of `pods` answered a wake poll since this controller started: only then
    /// may slots exist, as a gateway from before the pool breaks on slot Pods.
    pub fn ready(&self, pods: &[GatewayPod]) -> bool {
        let answered = self.answered.lock().unwrap();
        !pods.is_empty() && pods.iter().all(|pod| answered.get(&pod.uid) == Some(&true))
    }
    /// Polls every gateway Pod for wakes, one loop per Pod, and hands each wake to `wakes` with
    /// the Pod that delivered it. Runs until the receiver is gone.
    pub async fn run(
        &self,
        power: &PowerCoordinator,
        wakes: mpsc::Sender<(GatewayPod, WakeRequest)>,
    ) {
        let mut loops = FuturesUnordered::new();
        let mut running: HashMap<String, AbortHandle> = HashMap::new();
        let mut tick = tokio::time::interval(PODS_EVERY);
        loop {
            tokio::select! {
                _ = tick.tick() => {
                    let Ok(pods) = power.gateway_pods().await else {
                        continue;
                    };
                    running.retain(|uid, handle| {
                        let current = pods.iter().any(|pod| pod.uid == *uid);
                        if !current {
                            handle.abort();
                        }
                        current
                    });
                    self.answered
                        .lock()
                        .unwrap()
                        .retain(|uid, _| pods.iter().any(|pod| pod.uid == *uid));
                    for pod in pods {
                        if running.contains_key(&pod.uid) {
                            continue;
                        }
                        let (polling, handle) =
                            abortable(self.poll_loop(power, pod.clone(), wakes.clone()));
                        running.insert(pod.uid.clone(), handle);
                        loops.push(polling);
                    }
                },
                Some(_) = loops.next(), if !loops.is_empty() => {
                    if wakes.is_closed() {
                        return;
                    }
                },
            }
        }
    }
    /// Polls one gateway Pod until its handover channel closes.
    async fn poll_loop(
        &self,
        power: &PowerCoordinator,
        pod: GatewayPod,
        wakes: mpsc::Sender<(GatewayPod, WakeRequest)>,
    ) {
        while !wakes.is_closed() {
            match self.poll(power, &pod).await {
                Ok(delivered) => {
                    for wake in delivered {
                        if wakes.send((pod.clone(), wake)).await.is_err() {
                            return;
                        }
                    }
                }
                Err(_) => tokio::time::sleep(RETRY_AFTER).await,
            }
        }
    }
    /// One long-poll of `pod`: the wakes it delivered. A gateway that does not know the action
    /// is recorded as not ready, and the poll counts as failed.
    async fn poll(
        &self,
        power: &PowerCoordinator,
        pod: &GatewayPod,
    ) -> Result<Vec<WakeRequest>, Error> {
        use pgcf_native_protocol::wake::{
            POLL_ACTION, POLL_HEADER, POLL_HOLD_MS, POLL_PATH, POLL_RESPONSE_MAX_BYTES, WakePoll,
            sign_poll,
        };
        let (active, keys) = power.regional_keys().await?;
        let token = sign_poll(
            &keys,
            &active,
            power.region(),
            &pod.uid,
            POLL_ACTION,
            now_ms(),
        )?;
        let response = self
            .http
            .post(format!("http://{}:8080{POLL_PATH}", host(pod)))
            .header(POLL_HEADER, token)
            .timeout(Duration::from_millis(POLL_HOLD_MS + 5_000))
            .send()
            .await?;
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            self.answered.lock().unwrap().insert(pod.uid.clone(), false);
            return Err("gateway predates the wake poll".into());
        }
        if !response.status().is_success() {
            return Err("gateway wake poll refused".into());
        }
        let bytes = crate::kubernetes::bounded(response, POLL_RESPONSE_MAX_BYTES).await?;
        let answer: WakePoll = serde_json::from_slice(&bytes)?;
        if answer.pod != pod.uid || !answer.valid() {
            return Err("gateway wake poll invalid".into());
        }
        self.answered.lock().unwrap().insert(pod.uid.clone(), true);
        Ok(answer.wakes)
    }
    /// Sends `result` to the gateway Pod that delivered its wake, signed with the regional
    /// keyring `keys` (active key ID and keys) of `region`.
    pub async fn send_result(
        &self,
        (active, keys): &(String, HashMap<String, Vec<u8>>),
        region: &str,
        pod: &GatewayPod,
        result: &WakeResult,
    ) -> Result<(), Error> {
        use pgcf_native_protocol::wake::{
            POLL_HEADER, RESULT_ACTION, RESULT_MAX_BYTES, RESULT_PATH, sign_poll,
        };
        let body = serde_json::to_vec(result)?;
        if !result.valid() || body.len() > RESULT_MAX_BYTES {
            return Err("wake result invalid".into());
        }
        let token = sign_poll(keys, active, region, &pod.uid, RESULT_ACTION, now_ms())?;
        let response = self
            .http
            .post(format!("http://{}:8080{RESULT_PATH}", host(pod)))
            .header(POLL_HEADER, token)
            .header("content-type", "application/json")
            .body(body)
            .timeout(RESULT_TIMEOUT)
            .send()
            .await?;
        if !response.status().is_success() {
            return Err("gateway refused the wake result".into());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_world::{SYSTEM, World};
    use serde_json::json;

    fn second_gateway(w: &World) -> GatewayPod {
        let uid = crate::test_server::uid(22);
        w.server.put(json!({"apiVersion":"v1","kind":"Pod","metadata":{"name":"gateway-1","namespace":SYSTEM,"uid":uid,"labels":{"app.kubernetes.io/name":"pgcf-gateway"}},"spec":{"serviceAccountName":"pgcf-gateway"},"status":{"podIP":"10.0.0.2","containerStatuses":[{"name":"gateway","restartCount":0}]}}));
        w.gateway
            .wake
            .lock()
            .unwrap()
            .pods
            .insert("10.0.0.2".into(), uid.clone());
        GatewayPod {
            name: "gateway-1".into(),
            uid,
            ip: "10.0.0.2".into(),
            restarts: 0,
        }
    }
    fn wake(w: &World) -> WakeRequest {
        WakeRequest {
            database: w.id.clone(),
            operation: format!("op_{}", "w".repeat(20)),
            generation: 3,
            route_revision: 1,
            role_revision_hash: "a".repeat(64),
            queued_at_ms: 1,
        }
    }
    fn intake(w: &World) -> Intake {
        let mut intake = Intake::new().unwrap();
        intake.http = w.gateway.client.clone();
        intake
    }
    /// Runs the intake for `within`, and answers what it handed over.
    async fn run_for(
        w: &World,
        intake: &Intake,
        within: Duration,
    ) -> Vec<(GatewayPod, WakeRequest)> {
        let (sender, mut receiver) = mpsc::channel(16);
        let _ = tokio::time::timeout(within, intake.run(&w.reconciler.power, sender)).await;
        let mut handed = vec![];
        while let Ok(item) = receiver.try_recv() {
            handed.push(item);
        }
        handed
    }

    #[tokio::test]
    async fn one_poll_per_gateway_pod_signed_gw1_for_that_pod_turns_wakes_into_hints() {
        let w = World::awake().await;
        let second = second_gateway(&w);
        let request = wake(&w);
        w.gateway
            .wake
            .lock()
            .unwrap()
            .queued
            .insert("10.0.0.2".into(), vec![request.clone()]);
        let intake = intake(&w);
        let handed = run_for(&w, &intake, Duration::from_millis(400)).await;
        // The wake comes with the gateway Pod that queued it, once.
        assert_eq!(handed, vec![(second.clone(), request)]);
        // Each gateway is polled at its own address with a token for its own Pod: the double
        // verified it, and records the Pod it answered for.
        let polls = w.gateway.wake.lock().unwrap().polls.clone();
        for (address, pod) in [
            ("10.0.0.1", crate::test_world::gateway_uid()),
            ("10.0.0.2", second.uid.clone()),
        ] {
            assert!(
                polls.iter().any(|(a, p)| a == address && *p == pod),
                "{address} in {polls:?}"
            );
        }
        assert!(
            polls
                .iter()
                .all(|(a, _)| a == "10.0.0.1" || a == "10.0.0.2")
        );
        let pods = w.reconciler.power.gateway_pods().await.unwrap();
        assert!(intake.ready(&pods));
    }

    #[tokio::test]
    async fn a_wake_result_goes_only_to_the_gateway_that_delivered_the_wake() {
        let w = World::awake().await;
        let second = second_gateway(&w);
        let request = wake(&w);
        let reconciler = &w.reconciler;
        let steps = std::collections::BTreeMap::from([("decide".to_string(), 3_u64)]);
        // A pool whose intake speaks to the gateways through the double's proxy.
        let mut with_proxy =
            crate::pool::Pool::new(w.server.k8s.clone(), crate::test_world::IMAGE.into()).unwrap();
        with_proxy.intake = intake(&w);
        // Only the second gateway queued and delivered it.
        with_proxy.delivered(&second, &request);
        with_proxy
            .report(
                &reconciler.power,
                (&request.database, &request.operation, request.generation),
                (
                    pgcf_native_protocol::wake::Outcome::Miss,
                    Some("no_free_slot"),
                ),
                &steps,
            )
            .await;
        for _ in 0..100 {
            if !w.gateway.wake.lock().unwrap().results.is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
        let results = w.gateway.wake.lock().unwrap().results.clone();
        assert_eq!(results.len(), 1, "{results:?}");
        assert_eq!(results[0].0, "10.0.0.2");
        assert_eq!(
            results[0].1,
            json!({"database":w.id,"operation":request.operation,"generation":3,"outcome":"miss","reason":"no_free_slot","steps_ms":{"decide":3}})
        );
        // A wake no gateway delivered has nowhere to go.
        with_proxy
            .report(
                &reconciler.power,
                (&request.database, "op_xxxxxxxxxxxxxxxxxxxx", 9),
                (pgcf_native_protocol::wake::Outcome::Hit, None),
                &steps,
            )
            .await;
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(w.gateway.wake.lock().unwrap().results.len(), 1);
    }

    #[tokio::test]
    async fn a_404_poll_answer_marks_that_gateway_not_ready_for_refill() {
        let w = World::awake().await;
        second_gateway(&w);
        w.gateway.wake.lock().unwrap().old.insert("10.0.0.2".into());
        let intake = intake(&w);
        let pods = w.reconciler.power.gateway_pods().await.unwrap();
        assert!(!intake.ready(&pods), "no gateway answered yet");
        run_for(&w, &intake, Duration::from_millis(300)).await;
        assert!(!intake.ready(&pods), "an old gateway answered 404");
        // Once that gateway is replaced by one that polls, every gateway is ready.
        w.gateway.wake.lock().unwrap().old.clear();
        run_for(&w, &intake, Duration::from_millis(1500)).await;
        assert!(intake.ready(&pods));
    }
}
