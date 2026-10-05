// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes, randomUUID, generateKeyPairSync } from "node:crypto";
import { newNodeId, newOperationId } from "@pgcf/contracts";
import { hash, signed } from "../src/node-network-native.ts";
import type { CommonConfig, Measurement } from "../src/node-network-proof.ts";
import {
  encryptHostedReport,
  decryptHostedReport,
  assertHostedReport,
  parseHostedConfig,
} from "../src/node-network-hosted.ts";
const context = {
  repository: "test/repository",
  commit: "a".repeat(40),
  run_id: "123",
  run_attempt: "1",
};
test("hosted native evidence publishes encrypted bytes and binds exact run and nonce", () => {
  const key = randomBytes(32).toString("base64url"),
    nonce = randomBytes(32).toString("hex"),
    report = {
      source: "private-network-source",
      marker: randomBytes(24).toString("hex"),
    },
    encrypted = encryptHostedReport(report, key, nonce, context);
  assert.equal(JSON.stringify(encrypted).includes(report.source), false);
  assert.equal(JSON.stringify(encrypted).includes(report.marker), false);
  assert.deepEqual(decryptHostedReport(encrypted, key, nonce, context), report);
  assert.throws(
    () =>
      decryptHostedReport(
        encrypted,
        randomBytes(32).toString("base64url"),
        nonce,
        context,
      ),
    /encrypted_artifact_invalid/,
  );
  assert.throws(
    () =>
      decryptHostedReport(
        encrypted,
        key,
        randomBytes(32).toString("hex"),
        context,
      ),
    /encrypted_artifact_invalid/,
  );
  assert.throws(
    () =>
      decryptHostedReport(encrypted, key, nonce, {
        ...context,
        run_attempt: "2",
      }),
    /encrypted_artifact_invalid/,
  );
  const changed = { ...encrypted, tag: randomBytes(16).toString("base64url") };
  assert.throws(
    () => decryptHostedReport(changed, key, nonce, context),
    /encrypted_artifact_invalid/,
  );
});

test("hosted report consumption keeps plan, run, pool, complete coverage and freshness guards", () => {
  const now = Date.now(),
    at = (offset: number) => new Date(now + offset).toISOString(),
    keys = generateKeyPairSync("ed25519"),
    nonce = randomBytes(32).toString("hex"),
    trusted = {
      measurement: keys.publicKey
        .export({ format: "der", type: "spki" })
        .toString("base64url"),
    },
    source = "203.0.113.9",
    control = "198.51.100.5",
    target = "198.51.100.2",
    relay = "198.51.100.3",
    pool = ["203.0.113.0/24"],
    node_id = newNodeId(),
    rule = {
      protocol: "tcp" as const,
      destPorts: ["22"],
      srcCidr: { ipv4: [relay + "/32"] },
      action: "accept" as const,
      status: "active" as const,
    };
  const plan = {
    version: 1 as const,
    operation_id: newOperationId(),
    node_id,
    region_id: "eu-test",
    provider_instance_id: "123",
    intent_hash: hash(nonce),
    operators: { ipv4: [], ipv6: [] },
    relay: {
      provider_instance_id: "124",
      addresses: { ipv4: [relay], ipv6: [] },
    },
    scan_control: { ipv4: control, ipv6: "2001:db8::5", port: 443 },
    members: [
      {
        node_id,
        provider_instance_id: "123",
        firewall_id: randomUUID(),
        addresses: { ipv4: [target], ipv6: [] },
        primary: { ipv4: [target], ipv6: [] },
        ownership_sha256: hash(nonce),
        rules: {
          rules: {
            inbound: [{ ...rule, displayName: "Approved test source" }],
          },
        },
        rules_sha256: hash([
          { ...rule, srcCidr: { ...rule.srcCidr, ipv6: [] } },
        ]),
      },
    ],
  };
  const network: CommonConfig = {
    plan,
    binding: {
      plan_sha256: hash(plan),
      readback_at: at(-1000),
      verification: null,
    },
    kid: "measurement",
    measurement_keys: trusted,
    control_keys: trusted,
    scan: {
      https_control: {
        origin: "https://probe.example.com",
        bearer: "private-test-bearer",
        expires_at: at(60000),
      },
      tcp25_control: "8.8.8.8",
    },
  };
  const configuration = parseHostedConfig(
    JSON.stringify({
      version: 1,
      nonce,
      created_at: at(-2000),
      expires_at: at(60000),
      encryption_key: randomBytes(32).toString("base64url"),
      signing_jwk: keys.privateKey.export({ format: "jwk" }),
      network,
    }),
  );
  const before = {
      address: control,
      port: 443,
      source,
      observed_at: at(-500),
      nonce: randomBytes(32).toString("hex"),
    },
    after = {
      ...before,
      observed_at: at(0),
      nonce: randomBytes(32).toString("hex"),
    };
  const payload: Measurement = {
    purpose: "pgcf-node-measurement/v1",
    kind: "scan",
    binding_sha256: hash(network.binding),
    observed_at: at(0),
    family: "ipv4",
    source,
    scans: [
      {
        provider_instance_id: "123",
        address: target,
        protocol: "tcp",
        first_port: 1,
        last_port: 65535,
        scanned_ports: 65535,
        open_ports: [],
        started_at: at(-250),
        observed_at: at(0),
        before,
        after,
      },
    ],
  };
  const report = {
    version: 1 as const,
    nonce,
    context,
    config_sha256: hash(network),
    source_pool: pool,
    pool_observed_at: at(-800),
    started_at: at(-750),
    finished_at: at(0),
    measurement: signed(
      "pgcf-node-measurement/v1\n",
      payload,
      "measurement",
      keys.privateKey,
    ),
  };
  assert.equal(
    assertHostedReport(report, configuration, context, pool, now),
    report.measurement,
  );
  assert.throws(
    () =>
      assertHostedReport(
        report,
        configuration,
        context,
        ["203.0.114.0/24"],
        now,
      ),
    /hosted_report_invalid/,
  );
  assert.throws(
    () =>
      assertHostedReport(
        report,
        configuration,
        { ...context, run_attempt: "2" },
        pool,
        now,
      ),
    /hosted_report_invalid/,
  );
  assert.throws(
    () =>
      assertHostedReport(
        { ...report, config_sha256: hash(randomUUID()) },
        configuration,
        context,
        pool,
        now,
      ),
    /hosted_report_invalid/,
  );
  assert.throws(
    () =>
      assertHostedReport(report, configuration, context, pool, now + 130000),
    /hosted_report_invalid/,
  );
  if (payload.kind !== "scan") assert.fail();
  payload.scans[0]!.scanned_ports = 65534 as 65535;
  report.measurement = signed(
    "pgcf-node-measurement/v1\n",
    payload,
    "measurement",
    keys.privateKey,
  );
  assert.throws(
    () => assertHostedReport(report, configuration, context, pool, now),
    /scan_coverage/,
  );
});
