// SPDX-License-Identifier: Apache-2.0
//! The guard's lease intake: fetch, accept, hand off.
//!
//! Between a lease arriving and its entries governing the guard there is the guard's own lock and
//! nothing else: no disk, no controller lock, no other database's work. Persisting the signed
//! scopes of what was accepted happens afterwards, on a thread of its own, latest wins. The
//! intake itself runs on a thread of its own, so nothing that blocks elsewhere can stall it.
use crate::{
    policy::Client,
    storage::{Guard, HostStorageLease, RuntimeScope, now, same_physical_scope},
};
use pgcf_native_protocol::storage::{StorageTrust, StorageWriteClaims, VerifiedStorageAuthority};
use std::{
    collections::{BTreeMap, BTreeSet},
    future::Future,
    sync::{Arc, Mutex, PoisonError},
    time::{Duration, Instant},
};
use tokio::sync::{Mutex as AsyncMutex, Notify, mpsc, watch};
use tonic::Status;

/// One fetch starts every second. A token lives ten seconds and is served with six to eight left.
pub const FETCH_PERIOD: Duration = Duration::from_secs(1);
/// Fetches in flight at once. The client gives up on a request after five seconds; the next one
/// must not wait for that.
pub const IN_FLIGHT: usize = 3;
/// A request or a record write slower than this is reported, so that a stall names its cause.
const SLOW: Duration = Duration::from_millis(1500);

/// The durable private owner records that retain each Pod's signed physical scope.
pub trait ScopeRecords: Clone + Send + Sync + 'static {
    /// Make `token` the Pod's retained scope. `NotFound` when the sandbox runtime has no such Pod.
    fn remember(
        &self,
        pod_uid: &str,
        token: &str,
    ) -> impl Future<Output = Result<(), Status>> + Send;
    /// Private scopes of Pods whose sandboxes were removed, by Pod UID.
    fn retired(&self) -> impl Future<Output = Vec<(String, String)>> + Send;
    fn forget_retired(&self, pod_uid: &str) -> impl Future<Output = Result<(), Status>> + Send;
}

/// Each distinct message at most once per interval. A failing loop must not flood the journal,
/// and a silent one is worse.
pub struct Reported {
    last: BTreeMap<String, Instant>,
    every: Duration,
}
impl Reported {
    pub fn new(every: Duration) -> Self {
        Self {
            last: BTreeMap::new(),
            every,
        }
    }
    pub fn due(&mut self, key: &str) -> bool {
        let now = Instant::now();
        if self.last.len() > 256 {
            let every = self.every;
            self.last.retain(|_, at| now.duration_since(*at) < every);
        }
        if self
            .last
            .get(key)
            .is_some_and(|at| now.duration_since(*at) < self.every)
        {
            return false;
        }
        self.last.insert(key.to_owned(), now);
        true
    }
}

/// Scopes accepted but not yet recorded: one slot per Pod, the newest token wins, so the writer's
/// backlog is bounded by the number of Pods however long it is stalled.
#[derive(Default)]
pub struct Pending {
    scopes: Mutex<BTreeMap<String, RuntimeScope>>,
    wake: Notify,
}
impl Pending {
    pub fn offer(&self, scopes: Vec<RuntimeScope>) {
        if scopes.is_empty() {
            return;
        }
        {
            let mut pending = self.scopes.lock().unwrap_or_else(PoisonError::into_inner);
            for scope in scopes {
                pending.insert(scope.pod_uid.clone(), scope);
            }
        }
        self.wake.notify_one();
    }
    async fn take(&self) -> BTreeMap<String, RuntimeScope> {
        loop {
            {
                let mut pending = self.scopes.lock().unwrap_or_else(PoisonError::into_inner);
                if !pending.is_empty() {
                    return std::mem::take(&mut *pending);
                }
            }
            self.wake.notified().await;
        }
    }
}

/// Accept at once, then hand the signed scopes to the writer. Only the guard's own lock is awaited.
pub async fn deliver(
    guard: &AsyncMutex<Guard>,
    pending: &Pending,
    lease: HostStorageLease,
) -> Result<(), Status> {
    let scopes = {
        let mut state = guard.lock().await;
        state.accept(lease, now())?;
        state.runtime_scopes()
    };
    pending.offer(scopes);
    Ok(())
}

/// Start one fetch per `period`, whether or not earlier ones returned, and deliver each lease
/// the moment it arrives. A request that hangs until the client's timeout therefore costs one
/// slot of `limit`, never a renewal: the next request goes out on a connection of its own.
pub async fn poll<F, Fut>(
    mut fetch: F,
    period: Duration,
    limit: usize,
    guard: Arc<AsyncMutex<Guard>>,
    pending: Arc<Pending>,
) where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<HostStorageLease, Status>> + Send + 'static,
{
    let mut reported = Reported::new(Duration::from_secs(10));
    let mut ticker = tokio::time::interval(period);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut flights = tokio::task::JoinSet::new();
    let mut newest = 0;
    loop {
        tokio::select! {
            _ = ticker.tick() => {
                if flights.len() < limit {
                    let started = Instant::now();
                    let request = fetch();
                    flights.spawn(async move { (request.await, started.elapsed()) });
                }
            }
            Some(finished) = flights.join_next() => {
                let (outcome, elapsed) = finished.unwrap_or_else(|_| {
                    (
                        Err(Status::internal("storage_guard_fetch_task_failed")),
                        Duration::ZERO,
                    )
                });
                if elapsed > SLOW && reported.due("storage_guard_fetch_slow") {
                    eprintln!("storage_guard_fetch_slow {} ms", elapsed.as_millis());
                }
                match outcome {
                    // A slow request can finish after a newer one; the guard has moved on.
                    Ok(lease) if lease.issued_at < newest => {}
                    Ok(lease) => {
                        let issued_at = lease.issued_at;
                        match deliver(&guard, &pending, lease).await {
                            Ok(()) => newest = issued_at,
                            Err(error) => {
                                if reported.due(error.message()) {
                                    eprintln!("{}", error.message());
                                }
                            }
                        }
                    }
                    Err(error) => {
                        if reported.due(error.message()) {
                            eprintln!("{}", error.message());
                        }
                    }
                }
            }
        }
    }
}

/// Production intake: an isolated HTTP client of its own, fed by the sealed configuration.
pub async fn run_http(
    client: Client,
    updates: watch::Receiver<Client>,
    guard: Arc<AsyncMutex<Guard>>,
    pending: Arc<Pending>,
) {
    let current = match client.isolated() {
        Ok(client) => client,
        Err(error) => {
            eprintln!("{}", error.message());
            return;
        }
    };
    let (isolated, clients) = watch::channel(current);
    let fetch = move || {
        let client = clients.borrow().clone();
        async move { client.storage_lease().await }
    };
    tokio::select! {
        () = follow(updates, guard.clone(), isolated) => {}
        () = poll(fetch, FETCH_PERIOD, IN_FLIGHT, guard, pending) => {}
    }
}

/// A material-revision change moves the guard and the client together, before the next fetch.
async fn follow(
    mut updates: watch::Receiver<Client>,
    guard: Arc<AsyncMutex<Guard>>,
    isolated: watch::Sender<Client>,
) {
    while updates.changed().await.is_ok() {
        let next = updates.borrow_and_update().clone();
        let local = next.local();
        let legacy = local
            .storage_authority
            .as_ref()
            .map(|trust| trust.legacy_database_ids.clone())
            .unwrap_or_default();
        if let Err(error) = guard
            .lock()
            .await
            .rebind_material_revision(u64::from(local.material_revision), &legacy)
        {
            eprintln!("{}", error.message());
            return;
        }
        match next.isolated() {
            Ok(client) => {
                isolated.send_replace(client);
            }
            Err(error) => {
                eprintln!("{}", error.message());
                return;
            }
        }
    }
}

/// Channel-fed intake for the isolated proof: the leases are the caller's.
pub async fn run_channel(
    mut leases: mpsc::Receiver<HostStorageLease>,
    guard: Arc<AsyncMutex<Guard>>,
    pending: Arc<Pending>,
) {
    let mut reported = Reported::new(Duration::from_secs(10));
    while let Some(lease) = leases.recv().await {
        if let Err(error) = deliver(&guard, &pending, lease).await
            && reported.due(error.message())
        {
            eprintln!("{}", error.message());
        }
    }
}

/// Two scopes protect the volume equally: same Pod, same generation, same physical volume.
fn protects_the_same(a: &StorageWriteClaims, b: &StorageWriteClaims) -> bool {
    a.pod_uid == b.pod_uid && a.generation == b.generation && same_physical_scope(a, b)
}

/// The record writer. Renewals of a scope that is already recorded change nothing a restart
/// needs, so only a new Pod, a new generation or a different volume is written.
pub async fn persist<R: ScopeRecords>(records: R, trust: StorageTrust, pending: Arc<Pending>) {
    let mut written: BTreeMap<String, VerifiedStorageAuthority> = BTreeMap::new();
    let mut unassigned: BTreeSet<String> = BTreeSet::new();
    let mut reported = Reported::new(Duration::from_secs(30));
    loop {
        let batch = pending.take().await;
        written.retain(|uid, _| batch.contains_key(uid));
        unassigned.retain(|uid| batch.contains_key(uid));
        for (pod_uid, scope) in batch {
            if written
                .get(&pod_uid)
                .is_some_and(|old| protects_the_same(old.claims(), scope.authority.claims()))
            {
                continue;
            }
            let started = Instant::now();
            let recorded = records.remember(&pod_uid, &scope.token).await;
            if started.elapsed() > SLOW && reported.due("storage_scope_record_slow") {
                eprintln!(
                    "storage_scope_record_slow {} ms {pod_uid}",
                    started.elapsed().as_millis()
                );
            }
            match recorded {
                Ok(()) => {
                    unassigned.remove(&pod_uid);
                    retire_superseded(&records, &trust, &scope).await;
                    written.insert(pod_uid, scope.authority);
                }
                Err(error) => {
                    if error.code() == tonic::Code::NotFound {
                        if unassigned.insert(pod_uid.clone()) {
                            eprintln!("storage_scope_not_recorded pod_not_assigned {pod_uid}");
                        }
                    } else if reported.due(&format!("{pod_uid} {}", error.message())) {
                        eprintln!("storage_scope_not_recorded {} {pod_uid}", error.message());
                    }
                }
            }
        }
    }
}

/// Old private scope remains until its replacement signed physical scope is durable.
async fn retire_superseded<R: ScopeRecords>(
    records: &R,
    trust: &StorageTrust,
    durable: &RuntimeScope,
) {
    for (old_uid, old_token) in records.retired().await {
        if let Ok(old) = trust.verify_for_protection(&old_token)
            && same_physical_scope(durable.authority.claims(), old.claims())
            && durable.authority.claims().generation > old.claims().generation
            && let Err(error) = records.forget_retired(&old_uid).await
        {
            eprintln!("{}", error.message());
        }
    }
}

/// Run `work` on an OS thread of its own, with a current-thread runtime nothing else shares.
/// `stopped` receives the thread's name when it ends, however it ends.
pub fn spawn_isolated<F>(
    name: &'static str,
    stopped: mpsc::UnboundedSender<&'static str>,
    work: F,
) -> std::io::Result<()>
where
    F: Future<Output = ()> + Send + 'static,
{
    struct Ended(&'static str, mpsc::UnboundedSender<&'static str>);
    impl Drop for Ended {
        fn drop(&mut self) {
            let _ = self.1.send(self.0);
        }
    }
    std::thread::Builder::new()
        .name(name.into())
        .spawn(move || {
            let _ended = Ended(name, stopped);
            match tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            {
                Ok(runtime) => runtime.block_on(work),
                Err(error) => eprintln!("{name} runtime unavailable: {error}"),
            }
        })
        .map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::test_support::{Issuer, claims, database, guard, lease, pod, running};
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// What the controller's records do, minus the disk: it can hang, and it can refuse a Pod it
    /// does not have.
    #[derive(Clone, Default)]
    struct Records {
        hang: bool,
        unassigned: BTreeSet<String>,
        remembered: Arc<Mutex<Vec<(String, String)>>>,
    }
    impl ScopeRecords for Records {
        async fn remember(&self, pod_uid: &str, token: &str) -> Result<(), Status> {
            if self.hang {
                std::future::pending::<()>().await;
            }
            if self.unassigned.contains(pod_uid) {
                return Err(Status::not_found("assigned_pod_not_found"));
            }
            self.remembered
                .lock()
                .unwrap()
                .push((pod_uid.to_owned(), token.to_owned()));
            Ok(())
        }
        async fn retired(&self) -> Vec<(String, String)> {
            Vec::new()
        }
        async fn forget_retired(&self, _: &str) -> Result<(), Status> {
            Ok(())
        }
    }
    fn clock() -> u64 {
        u64::try_from(crate::policy::now_ms()).unwrap()
    }
    async fn eventually(what: &str, mut condition: impl AsyncFnMut() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(3);
        while !condition().await {
            assert!(Instant::now() < deadline, "{what}");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    #[tokio::test]
    async fn a_writer_that_never_returns_delays_neither_the_next_fetch_nor_acceptance() {
        let issuer = Issuer::new();
        let state = Arc::new(AsyncMutex::new(guard(&issuer)));
        let pending = Arc::new(Pending::default());
        let trust = state.lock().await.trust();
        tokio::spawn(persist(
            Records {
                hang: true,
                ..Records::default()
            },
            trust,
            pending.clone(),
        ));
        let (database, pod) = (database(1), pod(1));
        let fetches = Arc::new(AtomicUsize::new(0));
        let counted = fetches.clone();
        let (db, pd, signer) = (database.clone(), pod.clone(), Arc::new(issuer));
        let fetch = move || {
            let n = counted.fetch_add(1, Ordering::SeqCst) as u64;
            let now = clock();
            let entry = running(&signer, &claims(&db, &pd, 1, 1 + n, now));
            let next = lease(vec![entry], now);
            async move { Ok(next) }
        };
        let poller = tokio::spawn(poll(
            fetch,
            Duration::from_millis(20),
            IN_FLIGHT,
            state.clone(),
            pending,
        ));
        tokio::time::sleep(Duration::from_millis(500)).await;
        poller.abort();
        assert!(
            fetches.load(Ordering::SeqCst) >= 10,
            "the fetcher waited for the stalled writer: {} fetches",
            fetches.load(Ordering::SeqCst)
        );
        let namespace = format!("pgcf-db-{database}");
        assert!(
            state.lock().await.permits(&namespace, &pod, clock()),
            "an accepted token waited for the stalled writer"
        );
    }

    #[tokio::test]
    async fn a_pod_the_runtime_does_not_have_does_not_hold_back_the_records_of_the_others() {
        let issuer = Issuer::new();
        let pending = Arc::new(Pending::default());
        let state = guard(&issuer);
        let records = Records {
            unassigned: BTreeSet::from([pod(2)]),
            ..Records::default()
        };
        let remembered = records.remembered.clone();
        tokio::spawn(persist(records, state.trust(), pending.clone()));
        let now = clock();
        let scope = |n: u8| {
            let claims = claims(&database(n), &pod(n), 1, 1, now);
            RuntimeScope {
                pod_uid: pod(n),
                token: issuer.token(&claims),
                authority: state.trust().verify(&issuer.token(&claims), now).unwrap(),
            }
        };
        pending.offer(vec![scope(1), scope(2), scope(3)]);
        eventually("the records of the other Pods were held back", async || {
            remembered.lock().unwrap().len() == 2
        })
        .await;
        let recorded: BTreeSet<String> = remembered
            .lock()
            .unwrap()
            .iter()
            .map(|(pod, _)| pod.clone())
            .collect();
        assert_eq!(recorded, BTreeSet::from([pod(1), pod(3)]));
    }

    #[tokio::test]
    async fn a_guard_thread_that_dies_is_reported_so_that_the_service_restarts() {
        let (stopped, mut stops) = mpsc::unbounded_channel();
        spawn_isolated("pgcf-guard-test", stopped, async {
            panic!("the intake thread died");
        })
        .unwrap();
        let ended = tokio::time::timeout(Duration::from_secs(3), stops.recv()).await;
        assert_eq!(ended.ok().flatten(), Some("pgcf-guard-test"));
    }

    #[tokio::test]
    async fn a_request_that_never_returns_does_not_hold_back_the_next_one() {
        let issuer = Issuer::new();
        let state = Arc::new(AsyncMutex::new(guard(&issuer)));
        let pending = Arc::new(Pending::default());
        let (database, pod) = (database(2), pod(2));
        let calls = Arc::new(AtomicUsize::new(0));
        let counted = calls.clone();
        let (db, pd, signer) = (database.clone(), pod.clone(), Arc::new(issuer));
        let fetch = move || {
            let n = counted.fetch_add(1, Ordering::SeqCst) as u64;
            let now = clock();
            let entry = running(&signer, &claims(&db, &pd, 1, 1 + n, now));
            let next = lease(vec![entry], now);
            async move {
                if n == 0 {
                    std::future::pending::<()>().await;
                }
                Ok(next)
            }
        };
        let poller = tokio::spawn(poll(
            fetch,
            Duration::from_millis(20),
            IN_FLIGHT,
            state.clone(),
            pending,
        ));
        let namespace = format!("pgcf-db-{database}");
        eventually("the first request held every later one", async || {
            state.lock().await.permits(&namespace, &pod, clock())
        })
        .await;
        poller.abort();
    }
}
