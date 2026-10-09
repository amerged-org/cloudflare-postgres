// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  sandboxRuntimeAdmission,
  COMPUTE_PROFILE_NODE_LABEL,
} from "./runtime-admission.ts";
test("runtime selection targets all managed CNPG instance cohorts from the exact operator and preserves its ordinary process and volumes", () => {
  const input = {
      operatorNamespace: "cnpg-system",
      operatorServiceAccount: "cloudnative-pg",
      profileSha256: "a".repeat(64),
      perSlotCpuMillicores: 25,
      perSlotMemoryMiB: 32,
    },
    result = sandboxRuntimeAdmission(input),
    [runtime, policy, binding] = result.objects;
  assert.equal(runtime.handler, "pgcf");
  assert.equal(
    runtime.scheduling.nodeSelector[COMPUTE_PROFILE_NODE_LABEL],
    result.nodeLabel.value,
  );
  assert.equal(runtime.overhead.podFixed.memory, "32Mi");
  assert.deepEqual(policy.spec.matchConstraints.namespaceSelector.matchExpressions, [{key:"pgcf.io/database-id",operator:"Exists"}]);
  assert.deepEqual(policy.spec.matchConstraints.objectSelector.matchLabels, {"cnpg.io/podRole":"instance"});
  assert.deepEqual(policy.spec.matchConstraints.objectSelector.matchExpressions, [{key:"cnpg.io/cluster",operator:"Exists"}]);
  assert.deepEqual(policy.spec.matchConstraints.resourceRules[0].operations, [
    "CREATE",
  ]);
  assert.match(
    policy.spec.matchConditions[0].expression,
    /system:serviceaccount:cnpg-system:cloudnative-pg/,
  );
  assert.equal(binding.spec.policyName, policy.metadata.name);
  const mutation = policy.spec.mutations[0].jsonPatch.expression;
  assert.match(mutation, /path: "\/spec\/runtimeClassName"/);
  assert.doesNotMatch(mutation, /containers|volumes|PGDATA|ownerReferences/);
  assert.equal(policy.spec.failurePolicy, "Fail");
  assert.equal(result.runtimeClassName,"pgcf-prestarted");
  const updated=sandboxRuntimeAdmission({...input,perSlotMemoryMiB:64,profileSha256:"b".repeat(64)});
  assert.equal(updated.runtimeClassName,result.runtimeClassName);
  assert.equal(updated.objects[1].metadata.name,policy.metadata.name);
  assert.equal(updated.objects[0].overhead.podFixed.memory,"64Mi");
  assert.notEqual(updated.nodeLabel.value,result.nodeLabel.value);
  assert.throws(() =>
    sandboxRuntimeAdmission({ ...input, operatorServiceAccount: "' || true" }),
  );
});
