-- SPDX-License-Identifier: Apache-2.0
-- Contract (ULTRA plan 9.3): a maintenance cycle closes placement on its node and reopens it when
-- the cycle is done. `placement_closed_at` is the close time the order is answerable for, the value
-- `nodes.database_placement_closed_at` must still hold for the order to reopen placement: NULL when
-- placement was closed by someone else, whom the cycle leaves in charge of it.
ALTER TABLE lifecycle_orders ADD COLUMN placement_closed_at TEXT
  CHECK (placement_closed_at IS NULL OR (length(placement_closed_at) = 24 AND placement_closed_at GLOB '????-??-??T??:??:??.???Z'));
