// SPDX-License-Identifier: Apache-2.0
// Build as the ordinary CI user; only the exact owned filesystem proofs execute as root.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

const root = realpathSync(process.cwd());
const manifest = resolve(root, "apps/sandbox-controller/Cargo.toml");
const groups = [
  {
    target: "pgcf_sandbox_controller",
    kind: "lib",
    cases: [
      "pool_runtime::recovery_tests::real_host_process_restart_selects_only_prior_durable_bindings",
      "pool_runtime::recovery_tests::terminal_report_and_ack_survive_restart_and_cannot_be_rewritten",
    ],
    helpers: ["pool_runtime::recovery_tests::restart_selection_process"],
  },
  {
    target: "pool_gate",
    kind: "test",
    cases: [
      "host_start_provisions_missing_custody_before_first_csi_publish",
      "durable_denial_outlives_owner_and_queued_publish_checks_after_lock",
      "malformed_record_and_symlink_are_denials",
      "owner_sigkill_does_not_remove_durable_denial",
      "owned_waiter_has_finite_deadline_without_erasing_custody",
      "accepted_signed_qualification_hands_the_same_durable_deny_to_the_exact_binding",
    ],
    helpers: [
      "queued_publish_process",
      "claim_process",
      "bounded_wait_process",
    ],
  },
];
const output = execFileSync(
  "cargo",
  [
    "test",
    "--locked",
    "-p",
    "pgcf-sandbox-controller",
    "--lib",
    "--test",
    "pool_gate",
    "--no-run",
    "--message-format=json",
  ],
  {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    maxBuffer: 64 * 1024 * 1024,
  },
);
const artifacts = output
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line));
for (const group of groups) {
  const matches = artifacts.filter(
    (item) =>
      item.reason === "compiler-artifact" &&
      item.manifest_path === manifest &&
      item.target.name === group.target &&
      item.target.kind.includes(group.kind) &&
      item.profile.test === true &&
      typeof item.executable === "string",
  );
  assert.equal(
    matches.length,
    1,
    `Expected one exact ${group.target} test artifact`,
  );
  const executable = realpathSync(matches[0].executable);
  assert.ok(statSync(executable).isFile());
  const ignored = execFileSync(executable, ["--list", "--ignored"], {
    encoding: "utf8",
  })
    .split("\n")
    .filter((line) => line.endsWith(": test"))
    .map((line) => line.slice(0, -6));
  assert.deepEqual(ignored.sort(), [...group.cases, ...group.helpers].sort());
  for (const name of group.cases) {
    execFileSync(
      "sudo",
      ["--", executable, "--exact", name, "--ignored", "--nocapture"],
      {
        cwd: root,
        stdio: "inherit",
      },
    );
  }
}
