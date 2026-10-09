// SPDX-License-Identifier: Apache-2.0
const dns = (value: string) =>
  typeof value === "string" &&
  value.length <= 63 &&
  /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/.test(value);
export const COMPUTE_PROFILE_NODE_LABEL = "pgcf.io/compute-profile";
/** Activated only after the selected physical node's installed host runtime passes qualification. */
export function sandboxRuntimeAdmission(input: {
  operatorNamespace: string;
  operatorServiceAccount: string;
  profileSha256: string;
  perSlotCpuMillicores: number;
  perSlotMemoryMiB: number;
}) {
  if (
    ![
      input.operatorNamespace,
      input.operatorServiceAccount,
    ].every(dns) ||
    !/^[a-f0-9]{64}$/.test(input.profileSha256) ||
    !Number.isInteger(input.perSlotCpuMillicores) ||
    input.perSlotCpuMillicores < 1 ||
    input.perSlotCpuMillicores > 500 ||
    !Number.isInteger(input.perSlotMemoryMiB) ||
    input.perSlotMemoryMiB < 16 ||
    input.perSlotMemoryMiB > 512
  )
    throw Error("runtime_admission_scope_invalid");
  const name = "pgcf-prestarted",
    policyName = "pgcf-cnpg-prestarted",
    profileLabel = "r-" + input.profileSha256.slice(0, 40),
    principal = `system:serviceaccount:${input.operatorNamespace}:${input.operatorServiceAccount}`;
  const match = {
    matchPolicy: "Exact",
    namespaceSelector: {
      matchExpressions: [{ key: "pgcf.io/database-id", operator: "Exists" }],
    },
    objectSelector: {
      matchLabels: {
        "cnpg.io/podRole": "instance",
      },
      matchExpressions: [{ key: "cnpg.io/cluster", operator: "Exists" }],
    },
    resourceRules: [
      {
        apiGroups: [""],
        apiVersions: ["v1"],
        operations: ["CREATE"],
        resources: ["pods"],
        scope: "Namespaced",
      },
    ],
  };
  return {
    runtimeClassName: name,
    nodeLabel: { key: COMPUTE_PROFILE_NODE_LABEL, value: profileLabel },
    objects: [
      {
        apiVersion: "node.k8s.io/v1",
        kind: "RuntimeClass",
        metadata: {
          name,
          labels:{"pgcf.io/managed-by":"node-bootstrap"},
          annotations: {
            "pgcf.io/compute-profile-sha256": input.profileSha256,
            "pgcf.io/runtime-admission":"1",
          },
        },
        handler: "pgcf",
        overhead: {
          podFixed: {
            cpu: `${input.perSlotCpuMillicores}m`,
            memory: `${input.perSlotMemoryMiB}Mi`,
          },
        },
        scheduling: {
          nodeSelector: { [COMPUTE_PROFILE_NODE_LABEL]: profileLabel },
        },
      },
      {
        apiVersion: "admissionregistration.k8s.io/v1",
        kind: "MutatingAdmissionPolicy",
        metadata: { name: policyName,labels:{"pgcf.io/managed-by":"node-bootstrap"},annotations:{"pgcf.io/compute-profile-sha256":input.profileSha256,"pgcf.io/runtime-admission":"1"} },
        spec: {
          matchConstraints: match,
          matchConditions: [
            {
              name: "exact-cnpg-operator",
              expression: `request.userInfo.username == ${JSON.stringify(principal)}`,
            },
          ],
          failurePolicy: "Fail",
          reinvocationPolicy: "IfNeeded",
          mutations: [
            {
              patchType: "JSONPatch",
              jsonPatch: {
                expression: `[JSONPatch{op: "add", path: "/spec/runtimeClassName", value: ${JSON.stringify(name)}}]`,
              },
            },
          ],
        },
      },
      {
        apiVersion: "admissionregistration.k8s.io/v1",
        kind: "MutatingAdmissionPolicyBinding",
        metadata: { name: policyName,labels:{"pgcf.io/managed-by":"node-bootstrap"},annotations:{"pgcf.io/compute-profile-sha256":input.profileSha256,"pgcf.io/runtime-admission":"1"} },
        spec: {
          policyName,
          matchResources: {
            namespaceSelector: match.namespaceSelector,
            objectSelector: match.objectSelector,
          },
        },
      },
    ],
  } as const;
}
