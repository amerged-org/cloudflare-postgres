// SPDX-License-Identifier: Apache-2.0
//! What the core tells the usage meter (`usage.rs`): when a database is served, and the ticks that
//! close the intervals.
use super::{Core, Phase, now_ms};
use crate::{Error, machine::Machine, usage::Counters};
use futures_util::StreamExt;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet, HashSet};

/// How many databases' counters are asked of the gateway at once.
const READINGS_AT_ONCE: usize = 32;

/// A database is metered awake from its release to the gateway until its unit stops: a start that
/// waits for admission, a build and a recovery are the node's own work and nobody's use.
pub(super) fn is_served(phase: Phase) -> bool {
    matches!(phase, Phase::Ready | Phase::Quiesce)
}

impl<M: Machine> Core<M> {
    /// Closes the intervals at now: `deliver` takes the rows, and the meter moves on only when it
    /// does. Returns how many rows there were.
    pub(crate) async fn meter_tick(
        &self,
        deliver: impl FnOnce(&[Value]) -> Result<(), Error>,
    ) -> Result<usize, Error> {
        let (mut served, mut known) = (HashSet::new(), HashSet::new());
        for db in self.all() {
            match db.phase() {
                Phase::Deleted | Phase::Retired => {}
                phase => {
                    known.insert(db.id.clone());
                    if is_served(phase) {
                        served.insert(db.id.clone());
                    }
                }
            }
        }
        let ids: BTreeSet<String> = known
            .iter()
            .cloned()
            .chain(self.meter.databases())
            .collect();
        let readings: BTreeMap<String, Option<Counters>> = futures_util::stream::iter(ids)
            .map(|id| async move {
                let reading = self
                    .gateway
                    .activity(&id)
                    .await
                    .and_then(|activity| Counters::of(&activity));
                (id, reading)
            })
            .buffer_unordered(READINGS_AT_ONCE)
            .collect()
            .await;
        self.meter
            .tick(now_ms(), &served, &known, &readings, deliver)
    }
}
