// SPDX-License-Identifier: Apache-2.0
import { CAPACITY_NODE_UID } from "../../src/capacity-types.ts";
export function seedCapacityInstallation({
  save,
  nodeUid,
  bootId,
  marginUid,
  config,
}) {
  save({
    apiVersion: "v1",
    kind: "Node",
    metadata: {
      name: "node-a",
      uid: nodeUid,
      labels: {
        [CAPACITY_NODE_UID]: nodeUid,
        "openebs.io/nodename": "node-a",
      },
    },
    spec: {},
    status: {
      allocatable: { cpu: "450m", memory: "4Gi", pods: "30" },
      nodeInfo: { bootID: bootId },
      conditions: [
        { type: "Ready", status: "True" },
        { type: "MemoryPressure", status: "False" },
        { type: "DiskPressure", status: "False" },
        { type: "PIDPressure", status: "False" },
      ],
    },
  });
  // Native occupied resources and installation-owned headroom replace the
  // unexplained 325m counter. The scheduler includes both in all dimensions.
  save({
    apiVersion: "v1",
    kind: "Pod",
    metadata: { name: "existing-platform", namespace: "pgcf-system" },
    spec: {
      nodeName: "node-a",
      containers: [
        {
          name: "existing",
          resources: { requests: { cpu: "25m", memory: "64Mi" } },
        },
      ],
    },
    status: { phase: "Running" },
  });
  save({
    apiVersion: "scheduling.koordinator.sh/v1alpha1",
    kind: "Reservation",
    metadata: { name: "platform-margin", uid: marginUid },
    spec: {
      ttl: "0s",
      allocateOnce: false,
      allocatePolicy: "Restricted",
      template: {
        spec: {
          nodeName: "node-a",
          schedulerName: "koord-scheduler",
          containers: [
            {
              name: "margin",
              image: config.schedulerDeployment.image,
              resources: { requests: { cpu: "100m", memory: "128Mi" } },
            },
          ],
        },
      },
      owners: [
        {
          object: {
            apiVersion: "v1",
            kind: "Pod",
            namespace: "pgcf-system",
            name: "unassigned-margin",
            uid: "00000000-0000-4000-8000-000000000000",
          },
        },
      ],
    },
    status: {
      phase: "Available",
      nodeName: "node-a",
      allocatable: { cpu: "100m", memory: "128Mi" },
      conditions: [
        { type: "Ready", status: "True" },
        { type: "Scheduled", status: "True" },
      ],
    },
  });
  save({
    apiVersion: "storage.k8s.io/v1",
    kind: "StorageClass",
    metadata: { name: "pgcf-lvm" },
    provisioner: "local.csi.openebs.io",
    parameters: {
      storage: "lvm",
      vgpattern: "^pgcf$",
      thinProvision: "no",
      fsType: "ext4",
    },
    volumeBindingMode: "WaitForFirstConsumer",
    allowVolumeExpansion: true,
    reclaimPolicy: "Retain",
  });
  // Match the installed v1.10.1 CRD, including integer writable permissions
  // and every required VolumeGroup field. These are public fixture facts.
  save({
    apiVersion: "local.openebs.io/v1alpha1",
    kind: "LVMNode",
    metadata: {
      name: "node-a",
      namespace: "openebs",
      ownerReferences: [
        { apiVersion: "v1", kind: "Node", name: "node-a", uid: nodeUid },
      ],
    },
    volumeGroups: [
      {
        name: "pgcf",
        uuid: "vg-fixture",
        free: "96636764160",
        size: "107374182400",
        missingPvCount: 0,
        permissions: 0,
        allocationPolicy: 0,
        lvCount: 0,
        maxLv: 0,
        maxPv: 0,
        metadataCount: 1,
        metadataFree: "1048576",
        metadataSize: "4194304",
        metadataUsedCount: 1,
        pvCount: 1,
        snapCount: 0,
      },
    ],
  });
  save({
    apiVersion: "storage.k8s.io/v1",
    kind: "CSINode",
    metadata: {
      name: "node-a",
      ownerReferences: [
        { apiVersion: "v1", kind: "Node", name: "node-a", uid: nodeUid },
      ],
    },
    spec: {
      drivers: [
        {
          name: "local.csi.openebs.io",
          nodeID: "node-a",
          topologyKeys: ["openebs.io/nodename"],
        },
      ],
    },
  });
  save({
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: {
      name: "koord-scheduler",
      namespace: "koordinator-system",
      generation: 1,
    },
    spec: {
      replicas: 1,
      template: {
        spec: {
          containers: [
            { name: "scheduler", image: config.schedulerDeployment.image },
          ],
        },
      },
    },
    status: { observedGeneration: 1, readyReplicas: 1, availableReplicas: 1 },
  });
  for (const [kind, name, hookPath] of [
    [
      "MutatingWebhookConfiguration",
      config.admission.mutatingConfiguration,
      "/mutate",
    ],
    [
      "ValidatingWebhookConfiguration",
      config.admission.validatingConfiguration,
      "/validate",
    ],
  ])
    save({
      apiVersion: "admissionregistration.k8s.io/v1",
      kind,
      metadata: { name },
      webhooks: [
        {
          name: "capacity.pgcf.io",
          failurePolicy: "Fail",
          namespaceSelector: {},
          objectSelector: {},
          matchPolicy: "Equivalent",
          sideEffects: "NoneOnDryRun",
          admissionReviewVersions: ["v1"],
          clientConfig: {
            caBundle: "fixture-ca",
            service: {
              namespace: "pgcf-system",
              name: "capacity-admission",
              path: hookPath,
              port: 443,
            },
          },
          rules: [
            {
              operations: ["CREATE", "UPDATE"],
              apiGroups: ["*"],
              apiVersions: ["*"],
              resources: ["*", "pods/binding"],
              scope: "*",
            },
          ],
        },
      ],
    });
}
