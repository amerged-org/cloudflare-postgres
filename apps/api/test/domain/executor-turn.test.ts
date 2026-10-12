// SPDX-License-Identifier: Apache-2.0
import { expect, it } from "vitest";
import { newOperationId } from "@pgcf/contracts";
import { executorTurnObservation } from "../../src/bootstrap-container.ts";

it("only the container's own record of no turn or another turn proves that a turn is not running", () => {
  const turn = {
      kind: "thin_qualification",
      operation_id: newOperationId(),
      revision: 4,
    } as const,
    record = (change: Record<string, unknown>) => ({
      state: "running",
      ...turn,
      error_code: null,
      ...change,
    });
  expect(executorTurnObservation({ state: "idle" }, turn)).toEqual({
    state: "absent",
  });
  expect(executorTurnObservation(record({ revision: 3 }), turn)).toEqual({
    state: "absent",
  });
  expect(
    executorTurnObservation(
      record({ state: "succeeded", kind: "thin_storage" }),
      turn,
    ),
  ).toEqual({ state: "absent" });
  expect(executorTurnObservation(record({}), turn)).toEqual(record({}));
  // A body still arriving, an executor without the record and an invalid record prove nothing.
  for (const unknown of [
    { state: "receiving" },
    { error_code: "route_unknown" },
    record({ state: "failed" }),
    null,
  ])
    expect(executorTurnObservation(unknown, turn)).toEqual({
      state: "unknown",
    });
});
