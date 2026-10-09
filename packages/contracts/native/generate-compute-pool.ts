// SPDX-License-Identifier: Apache-2.0
import { readFile, writeFile } from "node:fs/promises";
import { format } from "prettier";
import { z } from "zod";
import {
  COMPUTE_POOL_LIMITS,
  ComputePoolLease,
  ComputePoolPolicy,
} from "../src/compute-pool.ts";
const policy = {
  version: 1,
  target_slots: 2,
  max_idle_cpu_millicores: 100,
  max_idle_memory_mib: 128,
  per_slot_cpu_millicores: 25,
  per_slot_memory_mib: 32,
  max_age_seconds: 120,
  profile: {
    release_id: "qualified-release",
    image: "registry.invalid/controller@sha256:" + "a".repeat(64),
    holder_sha256: "b".repeat(64),
    controller_sha256: "c".repeat(64),
    containerd_version: "2.3.6",
    runc_version: "1.5.2",
    architecture: "amd64",
  },
};
const lease = ComputePoolLease.parse({
  purpose: "pgcf-compute-pool/v1",
  node_id: "nod_" + "a".repeat(20),
  node_uid: "01234567-89ab-4def-8123-0123456789ab",
  region_id: "eu-test",
  revision: 1,
  policy,
  updated_at: "2026-10-09T00:00:00.000Z",
  material_revision: 1,
  assignment_revision: 1,
  region_revision: 1,
  node_observed_at: "2026-10-09T00:00:00.000Z",
  issued_at: "2026-10-09T00:00:00.000Z",
  expires_at: "2026-10-09T00:00:30.000Z",
});
const invalid = { ...policy, target_slots: 16 };
const document = {
  limits: COMPUTE_POOL_LIMITS,
  policy_schema: z.toJSONSchema(ComputePoolPolicy),
  lease,
  invalid_budget_policy: invalid,
  valid_policy: ComputePoolPolicy.safeParse(policy).success,
  invalid_budget_accepted: ComputePoolPolicy.safeParse(invalid).success,
};
const path = new URL("compute-pool.generated.json", import.meta.url),
  bytes = await format(JSON.stringify(document), { parser: "json" });
if (process.argv.includes("--check")) {
  if ((await readFile(path, "utf8")) !== bytes)
    throw Error("Regenerate compute-pool.generated.json");
} else await writeFile(path, bytes);
