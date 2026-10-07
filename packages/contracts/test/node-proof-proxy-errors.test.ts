// SPDX-License-Identifier: Apache-2.0
import { expect, it } from "vitest";
import { NodeProofErrorCode, NodeProofStatus } from "../src/node-proof.ts";

it("accepts the finite proxy and imported packet diagnostics while rejecting unrelated codes", () => {
  const codes = [
    "node_proof_capability_refused",
    "node_proof_cluster_endpoint_invalid",
    "node_proof_input_binding_changed",
    "node_proof_input_invalid",
    "node_proof_input_limit",
    "node_proof_maintenance_binding_changed",
    "node_proof_proxy_failed",
    "node_proof_session_expired",
    "node_proof_session_invalid",
    "node_proof_transport_endpoint_changed",
    "node_proof_transport_invalid",
    "node_proof_transport_refused",
    "node_proof_transport_target_changed",
    "postjoin_address_invalid",
    "postjoin_capture_bytes",
    "postjoin_capture_encapsulation_inconclusive",
    "postjoin_capture_encapsulation_unsupported",
    "postjoin_capture_format_unsupported",
    "postjoin_capture_invalid",
    "postjoin_capture_ip_inconclusive",
    "postjoin_capture_link_unsupported",
    "postjoin_capture_loss_or_unproven",
    "postjoin_capture_stale",
    "postjoin_capture_truncated",
    "postjoin_encrypted_traffic_missing",
    "postjoin_plaintext_pod_traffic",
    "postjoin_wireguard_bytes",
    "postjoin_wireguard_endpoint_binding",
    "postjoin_wireguard_handshake_missing",
    "postjoin_wireguard_interface_missing",
  ];
  expect(codes).toHaveLength(30);
  expect(new Set(codes).size).toBe(30);
  expect(
    codes.filter((code) => !NodeProofErrorCode.safeParse(code).success),
  ).toEqual([]);
  expect(
    [
      "node_proof_binary_required",
      "node_proof_relay_failed",
      "node_proof_proxy_input_invalid",
      "node_proof_proxy_input_required",
      "node_proof_transport_invented",
      "postjoin_capture_invented",
      "outside_scan_control_invalid",
      "image_gpt_invalid",
      "node_proof_private_input_https_example_secret",
    ].filter((code) => NodeProofErrorCode.safeParse(code).success),
  ).toEqual([]);
});

it("preserves the exact native five-field and administrative eight-field failed status", () => {
  const nativeSchema = NodeProofStatus.pick({
    operation_id: true,
    mode: true,
    session_id: true,
    status: true,
    error_code: true,
  });
  const native = nativeSchema.parse({
    operation_id: "op_aaaaaaaaaaaaaaaaaaaa",
    mode: "preparation",
    session_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    status: "failed",
    error_code: "node_proof_transport_refused",
  });
  const admin = NodeProofStatus.parse({
    ...native,
    binding_sha256: "a".repeat(64),
    plan_sha256: "b".repeat(64),
    input_hash: "c".repeat(64),
  });
  expect(Object.keys(native).sort()).toEqual(
    ["operation_id", "mode", "session_id", "status", "error_code"].sort(),
  );
  expect(Object.keys(admin).sort()).toEqual(
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
    nativeSchema.safeParse({ ...native, message: "private input" }).success,
  ).toBe(false);
  expect(
    NodeProofStatus.safeParse({ ...admin, session_bearer: "private input" })
      .success,
  ).toBe(false);
  expect(
    NodeProofStatus.safeParse({
      ...admin,
      error_code: "node_proof_private_input_https_example_secret",
    }).success,
  ).toBe(false);
});
