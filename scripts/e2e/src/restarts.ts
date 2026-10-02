// SPDX-License-Identifier: Apache-2.0
import { HarnessError, assertRunId, record } from "./core.ts";

export function restartSummary(
  ledgers: readonly unknown[],
  identity: string,
): Record<string, number> {
  if (ledgers.length !== 5)
    throw new HarnessError("five_restart_runs_required");
  const ids = new Set<string>();
  for (const value of ledgers) {
    const run = record(value);
    if (typeof run.run_id !== "string")
      throw new HarnessError("invalid_run_ledger");
    assertRunId(run.run_id);
    ids.add(run.run_id);
    if (
      run.version !== 1 ||
      run.identity !== identity ||
      !Array.isArray(run.completed) ||
      !["E1", "E5", "agent-restarted-create", "agent-restarted-delete"].every(
        (step) => (run.completed as unknown[]).includes(step),
      )
    )
      throw new HarnessError("restart_run_incomplete");
  }
  if (ids.size !== 5)
    throw new HarnessError("five_distinct_restart_runs_required");
  return { completed_create_delete_runs: 5, agent_restarts: 10 };
}
