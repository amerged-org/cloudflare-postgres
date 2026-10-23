// SPDX-License-Identifier: Apache-2.0
//! The repair of the volumes of sleeping databases after a pool that took no writes (plan 4.3).
//!
//! While the pool takes no writes, every volume that is open is tagged suspect
//! (`Storage::poll_pool`), and a sleeping database's volume stays mounted, so all of them are.
//! Nothing writes to the volume of a sleeping database: its unit is stopped, and the agent writes
//! below its mount point only for a configuration refresh, under the database's flow. The lab
//! (Debian 13, a pool with the agent's flags) took idle mounted volumes through a full data area
//! and a full metadata area: `e2fsck -p` found them clean and their data unchanged. The tag
//! outlives the agent and the node, and until the volume is repaired the wake path refused the
//! first wake of every sleeping database (`volume_suspended`), sent the database through
//! recovery, and a resize was refused (`storage_needs_repair`).
//!
//! So once the pool takes writes with room again, the volumes of the databases that sleep are
//! repaired in the background, a few at a time, each under its database's flow, which is the
//! one-writer rule: a wake, a sleep or a recovery of the database finishes first, and a wake that
//! arrives during the repair waits for the flow and finds a volume that needs none. A wake that
//! arrives before the pass has come to its database repairs the volume itself (`Core::try_wake`).
//! A database that is awake, starting or unproven keeps its own path: its unit stops, and its
//! recovery repairs the volume (`Core::recover_once`).
use super::{Core, Db, Desired, Phase, now_ms};
use crate::{machine::Machine, storage::VolumeId};
use serde_json::json;
use std::sync::{Arc, atomic::Ordering};
use tokio::sync::Semaphore;

/// How many volumes are repaired at once. `Storage::recover_volume` changes the volume and holds
/// the storage's change lock while `e2fsck` runs, so the number only decides how many databases
/// wait for their turn with their flow taken.
pub(crate) const REPAIRS_AT_ONCE: usize = 2;

/// What the repair of one database's volume came to.
pub(crate) enum Repair {
    Repaired,
    /// The database is not asleep, not current, or was tried too lately; or the volume needs no
    /// repair any more.
    Skipped,
    Failed(crate::Error),
}

impl<M: Machine> Core<M> {
    /// Starts a pass, unless one runs: a pass can take as long as the volumes it repairs, and the
    /// caller (the pool's poll every 5 s) must not wait for it.
    pub(crate) fn spawn_repairs(self: &Arc<Self>) {
        if self.repairing.swap(true, Ordering::AcqRel) {
            return;
        }
        let core = self.clone();
        tokio::spawn(async move {
            core.repair_sleeping().await;
            core.repairing.store(false, Ordering::Release);
        });
    }

    /// Repairs the volumes of the sleeping databases that the pool tagged, if the pool takes
    /// writes with room. The pass says what it did in one event.
    pub(crate) async fn repair_sleeping(self: &Arc<Self>) {
        // The repair writes: with the pool still without room, `recover_volume` would refuse it.
        if self.machine.room(&self.policy().storage).is_err() {
            return;
        }
        let Ok(suspects) = self.machine.suspect_volumes().await else {
            return;
        };
        let due: Vec<(Arc<Db>, VolumeId)> = suspects
            .into_iter()
            .filter_map(|volume| Some((self.find(volume.database())?, volume)))
            .collect();
        if due.is_empty() {
            return;
        }
        let turns = Arc::new(Semaphore::new(REPAIRS_AT_ONCE));
        let results = futures_util::future::join_all(due.iter().map(|(db, volume)| {
            let turns = turns.clone();
            async move {
                let _turn = turns.acquire().await.ok();
                self.repair_asleep(db, volume).await
            }
        }))
        .await;
        let repaired = results
            .iter()
            .filter(|result| matches!(result, Repair::Repaired))
            .count();
        let failures: Vec<&crate::Error> = results
            .iter()
            .filter_map(|result| match result {
                Repair::Failed(error) => Some(error),
                _ => None,
            })
            .collect();
        if repaired + failures.len() > 0 {
            let mut event = json!({
                "event": "sleeping_volumes_repaired",
                "repaired": repaired, "failed": failures.len(),
            });
            if let Some(error) = failures.first() {
                event["class"] = crate::diagnostics::error_code(error).into();
            }
            crate::timing::emit_event(event);
        }
    }

    /// Repairs the volume of one database if it sleeps and the volume is the one its entry
    /// names. A database that failed to repair is not tried again for the recovery backoff's
    /// longest wait: its next wake finds the volume suspect, and recovers it as before.
    async fn repair_asleep(&self, db: &Arc<Db>, volume: &VolumeId) -> Repair {
        // The database's flow: a wake, a sleep or a recovery finishes before the repair begins.
        let _flow = db.lock.lock().await;
        let tried_lately = {
            let view = db.view();
            let current = view.entry.as_ref().is_some_and(|entry| {
                entry.desired != Desired::Deleted
                    && Self::volume_id(entry).as_ref() == Some(volume)
                    && !self.fences.blocks(&db.id, entry.storage_generation)
            });
            if !(view.adopted && view.phase == Phase::Asleep && current) || self.fences.fenced() {
                return Repair::Skipped;
            }
            view.repair_failed_ms.is_some_and(|at| {
                now_ms() - at
                    < i64::try_from(self.timing.recovery_retry_maximum.as_millis())
                        .unwrap_or(i64::MAX)
            })
        };
        if tried_lately || !matches!(self.machine.needs_repair(volume).await, Ok(true)) {
            return Repair::Skipped;
        }
        match self
            .machine
            .recover_volume(volume, &self.policy().storage)
            .await
        {
            Ok(()) => {
                db.view().repair_failed_ms = None;
                Repair::Repaired
            }
            Err(error) => {
                db.view().repair_failed_ms = Some(now_ms());
                Repair::Failed(error.into())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::{
        power::{Slept, Why},
        testing::{Rig, eventually},
    };
    use pgcf_native_protocol::wake::Outcome;
    use std::time::{Duration, Instant};

    fn repairs(rig: &Rig, id: &str) -> usize {
        rig.machine
            .calls()
            .iter()
            .filter(|call| **call == format!("recover {id}"))
            .count()
    }
    fn passes(repaired: u64, failed: u64) -> Vec<serde_json::Value> {
        crate::events::seen()
            .into_iter()
            .filter(|event| {
                event["event"] == "sleeping_volumes_repaired"
                    && event["fields"]["repaired"] == repaired
                    && event["fields"]["failed"] == failed
            })
            .collect()
    }

    /// The finding of the code reading of 2026-10-23: every sleeping volume was tagged by a pool
    /// without writes and each database lost its first wake for it. Once the pool takes writes
    /// with room, the pass repairs the sleeping ones, starts no PostgreSQL, and leaves alone the
    /// database that runs: its own path stops the unit and repairs the volume.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn the_volumes_a_pool_without_writes_tagged_are_repaired_for_the_databases_that_sleep() {
        let Some(rig) = Rig::new("repair-sleeping").await else {
            return;
        };
        let mut volumes = Vec::new();
        let mut handles = Vec::new();
        for _ in 0..2 {
            let (entry, db) = rig.create().await;
            assert_eq!(rig.core.sleep(&db, Why::Idle).await, Slept::Proven);
            volumes.push(crate::storage::VolumeId::new(&entry.id, 1).unwrap());
            handles.push((entry, db));
        }
        let (awake, awake_db) = rig.create().await;
        let awake_volume = crate::storage::VolumeId::new(&awake.id, 1).unwrap();
        for volume in volumes.iter().chain([&awake_volume]) {
            rig.machine.mark_suspect(volume);
        }
        rig.machine.clear_calls();

        // The pool has no room yet: the repair writes, so nothing is tried.
        rig.machine.set_no_room(true);
        rig.core.repair_sleeping().await;
        assert!(rig.machine.calls().is_empty(), "{:?}", rig.machine.calls());

        rig.machine.set_no_room(false);
        rig.core.repair_sleeping().await;
        for ((entry, db), volume) in handles.iter().zip(&volumes) {
            assert_eq!(repairs(&rig, &entry.id), 1, "{:?}", rig.machine.calls());
            assert!(!rig.machine.is_suspect(volume));
            assert_eq!(db.phase(), Phase::Asleep);
            assert!(!rig.machine.running(&entry.id), "no PostgreSQL is started");
        }
        assert_eq!(repairs(&rig, &awake.id), 0);
        assert!(rig.machine.is_suspect(&awake_volume));
        assert_eq!(awake_db.phase(), Phase::Ready);
        assert!(!passes(2, 0).is_empty());

        // Their first wake is not refused for it, and asks for no repair.
        rig.machine.clear_calls();
        for (entry, db) in &handles {
            let result = rig.core.wake(&Rig::ticket(entry)).await;
            assert_eq!(result.outcome, Outcome::Started, "{result:?}");
            assert_eq!(db.phase(), Phase::Ready);
            assert_eq!(repairs(&rig, &entry.id), 0);
        }
        // A pass with nothing tagged that sleeps does nothing.
        rig.machine.clear_calls();
        rig.core.repair_sleeping().await;
        assert!(rig.machine.calls().is_empty(), "{:?}", rig.machine.calls());
    }

    /// A wake that arrives while the repair runs waits for the database's flow, finds a volume
    /// that needs no repair, and starts: it is not refused, and the volume is repaired once.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_wake_that_arrives_during_the_repair_waits_for_it_and_is_not_refused() {
        let Some(rig) = Rig::new("repair-wake").await else {
            return;
        };
        let (entry, db) = rig.create().await;
        let volume = crate::storage::VolumeId::new(&entry.id, 1).unwrap();
        assert_eq!(rig.core.sleep(&db, Why::Idle).await, Slept::Proven);
        rig.machine.mark_suspect(&volume);
        rig.machine.slow_repairs(Duration::from_millis(800));
        rig.machine.clear_calls();
        let pass = {
            let core = rig.core.clone();
            tokio::spawn(async move { core.repair_sleeping().await })
        };
        eventually(10, "the repair to begin", || repairs(&rig, &entry.id) == 1).await;
        let began = Instant::now();
        let result = rig.core.wake(&Rig::ticket(&entry)).await;
        assert_eq!(result.outcome, Outcome::Started, "{result:?}");
        assert!(
            began.elapsed() >= Duration::from_millis(300),
            "the wake waited for the repair: {:?}",
            began.elapsed()
        );
        pass.await.unwrap();
        assert_eq!(repairs(&rig, &entry.id), 1);
        assert!(!rig.machine.is_suspect(&volume));
        assert!(rig.machine.running(&entry.id));
    }

    /// A repair that fails (a job holds the volume) is said, leaves the database asleep and
    /// suspect, and is not tried at every pass: after the longest recovery wait it is, and goes
    /// through. A wake in between still gets today's path.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_repair_that_fails_is_said_and_tried_again_after_the_backoff() {
        let Some(rig) = Rig::new("repair-fails").await else {
            return;
        };
        let (entry, db) = rig.create().await;
        let volume = crate::storage::VolumeId::new(&entry.id, 1).unwrap();
        assert_eq!(rig.core.sleep(&db, Why::Idle).await, Slept::Proven);
        rig.machine.mark_suspect(&volume);
        rig.machine.hold_volume(&volume);
        rig.machine.clear_calls();
        rig.core.repair_sleeping().await;
        assert_eq!(repairs(&rig, &entry.id), 1);
        assert!(
            crate::events::seen().iter().any(|event| {
                event["event"] == "sleeping_volumes_repaired"
                    && event["fields"]["failed"] == 1
                    && event["fields"]["class"] == "storage_busy"
            }),
            "the failure is said"
        );
        assert_eq!(db.phase(), Phase::Asleep);
        assert!(rig.machine.is_suspect(&volume));
        // Not at every pass.
        rig.core.repair_sleeping().await;
        assert_eq!(repairs(&rig, &entry.id), 1);
        // After the longest wait of the recovery backoff, and once the job has let go.
        rig.machine.release_volume(&volume);
        tokio::time::sleep(rig.core.timing.recovery_retry_maximum + Duration::from_millis(100))
            .await;
        rig.core.repair_sleeping().await;
        assert_eq!(repairs(&rig, &entry.id), 2);
        assert!(!rig.machine.is_suspect(&volume));
        assert_eq!(db.phase(), Phase::Asleep);
    }
}
