// SPDX-License-Identifier: Apache-2.0
import { expect, it } from "vitest";
import {
  NODE_PROOF_CLEANUP_ERROR_CODES,
  NodeProofCleanupOperation,
  NodeProofCleanupAbortOrigin,
  NodeProofCleanupErrorCode,
  nodeProofCleanupErrorCode,
  NodeProofErrorCode,
  NodeProofStatus,
} from "../src/node-proof.ts";

it("accepts a scoped namespace inventory command deadline without changing proof status fields", () => {
  const code = "proof_source_cleanup_namespace_inventory_command_deadline";
  expect(
    nodeProofCleanupErrorCode("namespace_inventory", "command_deadline"),
  ).toBe(code);
  expect(NodeProofCleanupErrorCode.safeParse(code).success).toBe(true);
  expect(NodeProofErrorCode.safeParse(code).success).toBe(true);
  const status = NodeProofStatus.parse({
    operation_id: "op_aaaaaaaaaaaaaaaaaaaa",
    mode: "preparation",
    session_id: null,
    binding_sha256: "a".repeat(64),
    plan_sha256: null,
    input_hash: null,
    status: "failed",
    error_code: code,
  });
  expect(Object.keys(status).sort()).toEqual(
    [
      "operation_id",
      "mode",
      "session_id",
      "binding_sha256",
      "plan_sha256",
      "input_hash",
      "status",
      "error_code",
    ].sort(),
  );
  expect(
    NodeProofStatus.safeParse({
      ...status,
      cleanup_operation: "namespace_inventory",
    }).success,
  ).toBe(false);
});

it("keeps cleanup diagnostics finite and rejects invented operations or abort origins", () => {
  expect(NODE_PROOF_CLEANUP_ERROR_CODES).toHaveLength(27);
  expect(new Set(NODE_PROOF_CLEANUP_ERROR_CODES).size).toBe(27);
  expect(NodeProofCleanupOperation.options).toHaveLength(9);
  expect(NodeProofCleanupAbortOrigin.options).toHaveLength(3);
  expect(() =>
    nodeProofCleanupErrorCode(
      "invented_operation" as NodeProofCleanupOperation,
      "command_deadline",
    ),
  ).toThrow();
  expect(() =>
    nodeProofCleanupErrorCode(
      "namespace_inventory",
      "invented_origin" as NodeProofCleanupAbortOrigin,
    ),
  ).toThrow();
  expect(
    NodeProofErrorCode.safeParse(
      "proof_source_cleanup_invented_operation_command_deadline",
    ).success,
  ).toBe(false);
  expect(
    NodeProofErrorCode.safeParse(
      "proof_source_cleanup_namespace_inventory_invented_origin",
    ).success,
  ).toBe(false);
});
