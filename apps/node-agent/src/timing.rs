// SPDX-License-Identifier: Apache-2.0
//! The agent's log: one JSON line per event on stderr, which journald collects. An event names a
//! class of what happened and never the text of an error, which can carry an address or a path.
use serde_json::Value;

/// Writes one event line to the agent's log.
pub fn emit_event(value: Value) {
    eprintln!("{value}");
}
