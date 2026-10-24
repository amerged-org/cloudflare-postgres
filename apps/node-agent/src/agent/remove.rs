// SPDX-License-Identifier: Apache-2.0
//! What a delete does to the machine (plan 5.10): the database's PostgreSQL ends, by force where
//! a clean stop fails, and its volumes go. The agent's flow (`Core::delete`) calls these in this
//! order and adds its own bookkeeping; the real-stack lab calls them on a node's machine, with a
//! real PostgreSQL on a full filesystem.
use crate::{
    machine::Machine,
    storage::{Removal, VolumeId},
    units,
};
use serde_json::json;

/// Ends the database's PostgreSQL: a clean stop, which archives what is left of its WAL for the
/// retention, and by force when that fails (a PANIC at the shutdown checkpoint of a full
/// filesystem, a stop job that does not end). Whatever the unit holds is gone when this returns
/// `Ok`; while it returns an error PostgreSQL may still run, and nothing is taken from under it.
pub(crate) async fn end_unit<M: Machine>(machine: &M, id: &str) -> Result<(), units::Error> {
    let Err(error) = machine.stop(id).await else {
        return Ok(());
    };
    crate::timing::emit_event(json!({
        "event": "delete_unit_killed", "database_id": id,
        "class": crate::diagnostics::units_code(&error),
    }));
    machine.kill(id).await
}

/// Removes the volumes the deletion releases: every generation of the database up to
/// `generation`, which is what the persisted desired state names (`Removal::DatabaseDeleted`).
/// `current` is the volume of the entry's generation, removed (finding nothing, which cleans up
/// its link) when the node lists none. `true` when a volume of a later generation remains: it
/// belongs to a move or an order of its own, and keeps its owner. An error names the step and the
/// class of the first volume that did not go; the others are tried all the same.
pub(crate) async fn remove_volumes<M: Machine>(
    machine: &M,
    id: &str,
    generation: u64,
    current: Option<VolumeId>,
) -> Result<bool, (&'static str, String)> {
    let failed = |step, error: crate::Error| (step, crate::diagnostics::error_code(&error));
    let inventory = machine
        .inventory()
        .await
        .map_err(|error| failed("inventory", error.into()))?;
    let mut volumes: Vec<VolumeId> = inventory
        .volumes
        .iter()
        .filter(|volume| volume.id.database() == id && volume.id.generation() <= generation)
        .map(|volume| volume.id.clone())
        .collect();
    if volumes.is_empty() {
        volumes.extend(current);
    }
    let mut result = Ok(());
    for volume in volumes {
        let removed = machine
            .remove_volume(
                &volume,
                Removal::DatabaseDeleted {
                    storage_generation: generation,
                },
            )
            .await;
        if let Err(error) = removed {
            result = result.and(Err(failed("volume", error.into())));
        }
    }
    result?;
    Ok(inventory
        .volumes
        .iter()
        .any(|volume| volume.id.database() == id && volume.id.generation() > generation))
}
