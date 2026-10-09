// SPDX-License-Identifier: Apache-2.0
import {
  FleetTalosUpgradeReceipt,
  type FleetPatchInput,
  type FleetPatchFacts,
} from "@pgcf/contracts/fleet-patches";

export function talosDeploymentReceipt(
  input: FleetPatchInput,
  facts: FleetPatchFacts,
  source: FleetTalosUpgradeReceipt["source"],
  completedAt = new Date().toISOString(),
): FleetTalosUpgradeReceipt {
  return FleetTalosUpgradeReceipt.parse({
    method: "deploymentreceipt",
    installer: input.spec.roles[input.role].talos_installer,
    node_uid: facts.node_uid,
    cluster_uid: facts.cluster_uid,
    system_uuid: facts.system_uuid,
    pre_reboot_boot_id: facts.boot_id,
    completed_at: completedAt,
    source,
  });
}
/** Talos1.14 LifecycleService vendor records; absence, another upgrade, failure or an old boot cannot establish completion. */
export function readTalosLifecycleCompletion(
  stdout: string,
  input: FleetPatchInput,
  facts: FleetPatchFacts,
  now = Date.now(),
): FleetTalosUpgradeReceipt | null {
  const dispatched = input.status.observed,
    expected = input.spec.roles[input.role].talos_installer;
  if (
    !dispatched ||
    facts.boot_id !== dispatched.boot_id ||
    facts.node_uid !== input.status.node_uid ||
    facts.cluster_uid !== input.status.cluster_uid
  )
    return null;
  const since = Date.parse(dispatched.observed_at) - 5000;
  let started: number | null = null,
    completed: number | null = null;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.startsWith(`${input.address}: `)) continue;
    // Pinned Talos1.14 machined uses zap's development console encoder, not JSON logs.
    // Its scoped fields are a JSON suffix; ANSI color is added only to the level.
    const body = line
        .slice(input.address.length + 2)
        .replace(new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "g"), ""),
      frame =
        /^(\S+)\s+(?:DEBUG|INFO|WARN|ERROR)\s+(starting upgrade|upgrade completed|upgrade failed)\s+(\{.*\})$/.exec(
          body,
        );
    if (!frame) continue;
    let value: Record<string, unknown>;
    try {
      value = JSON.parse(frame[3]!);
    } catch {
      continue;
    }
    const timestamp = Date.parse(frame[1]!);
    value.msg = frame[2];
    if (value.service !== "lifecycle") continue;
    if (
      !Number.isFinite(timestamp) ||
      timestamp < since ||
      timestamp > now + 5000
    )
      continue;
    if (value.msg === "starting upgrade") {
      started = value.installer_image === expected ? timestamp : null;
      completed = null;
    } else if (value.msg === "upgrade failed") {
      started = null;
      completed = null;
    } else if (
      value.msg === "upgrade completed" &&
      value.exit_code === 0 &&
      started !== null &&
      timestamp >= started
    )
      completed = timestamp;
  }
  return completed === null
    ? null
    : talosDeploymentReceipt(
        input,
        facts,
        "lifecycle_log_exit_0",
        new Date(completed).toISOString(),
      );
}
