// SPDX-License-Identifier: Apache-2.0
import { posix } from "node:path";
import { preparePostgresExpectedManifest } from "./execution-manifest.ts";
import { canonicalCohort } from "./node-cohort.ts";
import {
  binary,
  fields,
  hash,
  challengeFor,
} from "./node-delivery-protocol.ts";
import { validDeliveryConfiguration } from "./node-delivery-profile.ts";
import type {
  ExecutionBrokerDependencies,
  ExecutionAttemptHint,
} from "./execution-broker.ts";
import type { NodeDeliveryInitialization } from "./node-delivery.ts";
import type { Claim } from "./types.ts";

const fail = () => new Error("execution_broker_target_unproven");
function object(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw fail();
  return v as Record<string, unknown>;
}
const label = /^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/;
export function checkBrokerConfiguration(deps: ExecutionBrokerDependencies) {
  const c = deps.configuration;
  if (
    c.version !== 1 ||
    !validDeliveryConfiguration(c.delivery) ||
    !fields(c.publicKeyPin, ["version", "keyId", "publicKey"]) ||
    c.publicKeyPin.version !== 2 ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(c.publicKeyPin.keyId) ||
    !binary(c.publicKeyPin.publicKey, 32) ||
    hash(canonicalCohort(c.publicKeyPin)) !== c.publicKeyPinHash ||
    !Number.isSafeInteger(c.guardUid) ||
    c.guardUid < 1 ||
    c.guardUid > 4294967294 ||
    !Number.isSafeInteger(c.guardGid) ||
    c.guardGid < 0 ||
    c.guardGid > 4294967294 ||
    (!/^sha256:[a-f0-9]{64}$/.test(c.runtimeImageId) &&
      c.runtimeImageId !== c.recipe.image)
  )
    throw fail();
  for (const location of [c.inputs, c.ipc])
    if (
      !fields(location, ["volumeName", "mountPath", "privateDirectory"]) ||
      !label.test(location.volumeName) ||
      !label.test(location.privateDirectory) ||
      !posix.isAbsolute(location.mountPath) ||
      posix.normalize(location.mountPath) !== location.mountPath ||
      location.mountPath === "/"
    )
      throw fail();
  if (
    c.inputs.volumeName === c.ipc.volumeName ||
    c.inputs.mountPath === c.ipc.mountPath ||
    c.inputs.mountPath.startsWith(c.ipc.mountPath + "/") ||
    c.ipc.mountPath.startsWith(c.inputs.mountPath + "/")
  )
    throw fail();
}
export async function deriveBrokerInitialization(
  input: { claim: Claim; podUid: string; attemptHint: ExecutionAttemptHint },
  deps: ExecutionBrokerDependencies,
  requestId: string,
): Promise<NodeDeliveryInitialization> {
  const { claim, attemptHint } = input,
    c = deps.configuration;
  const check = () => {
    deps.authority.check();
    deps.funding.assert();
    if (
      Date.now() >=
      Math.min(
        deps.authority.expiresAt(),
        deps.funding.dispatchAuthority().expiresAt(),
      )
    )
      throw fail();
  };
  check();
  if (
    claim.kind !== "environment.create" ||
    !binary(attemptHint.nonce, 32) ||
    !/^([a-f0-9]{64})$/.test(attemptHint.containerId) ||
    !Number.isSafeInteger(attemptHint.attempt) ||
    attemptHint.attempt < 0 ||
    attemptHint.attempt > 4294967295
  )
    throw fail();
  const expected = await preparePostgresExpectedManifest({
    claim,
    funding: deps.fundingIdentity,
    journal: deps.capacity,
    runtime: deps.runtime,
    podUid: input.podUid,
    recipe: c.recipe,
    authority: {
      check,
      expiresAt: () =>
        Math.min(
          deps.authority.expiresAt(),
          deps.funding.dispatchAuthority().expiresAt(),
        ),
    },
  });
  check();
  const snapshot = deps.capacity.snapshot(),
    slot = snapshot.slots.find((s) =>
      s.consumers.some((p) => p.uid === input.podUid),
    );
  if (
    !slot ||
    slot.computeReleased ||
    slot.consumers.some(
      (p) =>
        p.uid !== input.podUid &&
        !slot.retirements.some((r) => r.podUid === p.uid),
    )
  )
    throw fail();
  const original = slot.consumers.find((p) => p.uid === input.podUid)!;
  const pod = await deps.runtime.read(
    "Pod",
    snapshot.plan.namespace,
    original.name,
  );
  check();
  if (
    !pod ||
    pod.metadata.uid !== original.uid ||
    hash(canonicalCohort(pod.spec)) !== original.specHash ||
    pod.metadata.deletionTimestamp
  )
    throw fail();
  const spec = object(pod.spec),
    containers = spec.containers;
  if (!Array.isArray(containers)) throw fail();
  const container = object(
      containers.find((x) => object(x).name === "postgres"),
    ),
    security = object(container.securityContext),
    podSecurity = object(spec.securityContext);
  if (
    (security.runAsUser ?? podSecurity.runAsUser) !== c.guardUid ||
    (security.runAsGroup ?? podSecurity.runAsGroup) !== c.guardGid ||
    (security.runAsNonRoot ?? podSecurity.runAsNonRoot) !== true ||
    security.allowPrivilegeEscalation !== false ||
    security.privileged === true ||
    security.readOnlyRootFilesystem !== true ||
    canonicalCohort(object(security.capabilities).drop) !== '["ALL"]' ||
    (object(security.capabilities).add !== undefined &&
      canonicalCohort(object(security.capabilities).add) !== "[]") ||
    spec.hostPID === true ||
    spec.hostIPC === true ||
    spec.hostNetwork === true ||
    spec.shareProcessNamespace === true ||
    object(security.seccompProfile ?? podSecurity.seccompProfile).type !==
      "RuntimeDefault"
  )
    throw fail();
  const volumes = spec.volumes,
    mounts = container.volumeMounts;
  if (!Array.isArray(volumes) || !Array.isArray(mounts)) throw fail();
  if (volumes.some((v) => object(v).hostPath !== undefined)) throw fail();
  for (const sibling of [
    ...containers,
    ...(Array.isArray(spec.initContainers) ? spec.initContainers : []),
    ...(Array.isArray(spec.ephemeralContainers)
      ? spec.ephemeralContainers
      : []),
  ]) {
    const other = object(sibling);
    if (other.name === "postgres") continue;
    const sec = object(other.securityContext);
    if (
      sec.privileged === true ||
      sec.allowPrivilegeEscalation !== false ||
      canonicalCohort(object(sec.capabilities).drop) !== '["ALL"]' ||
      (object(sec.capabilities).add !== undefined &&
        canonicalCohort(object(sec.capabilities).add) !== "[]")
    )
      throw fail();
  }
  for (const [location, readOnly] of [
    [c.inputs, true],
    [c.ipc, false],
  ] as const) {
    const selected = volumes.filter(
        (v) => object(v).name === location.volumeName,
      ),
      selectedMounts = mounts.filter(
        (v) => object(v).name === location.volumeName,
      );
    if (
      selected.length !== 1 ||
      !fields(selected[0], ["name", "emptyDir"]) ||
      !fields(object(selected[0]).emptyDir, []) ||
      selectedMounts.length !== 1
    )
      throw fail();
    const mount = object(selectedMounts[0]);
    if (
      mount.mountPath !== location.mountPath ||
      (mount.readOnly === true) !== readOnly ||
      mount.subPath !== undefined ||
      mount.subPathExpr !== undefined ||
      (mount.mountPropagation !== undefined &&
        mount.mountPropagation !== "None")
    )
      throw fail();
    if (
      mounts.some((m) => {
        const path = object(m).mountPath;
        return (
          object(m).name !== location.volumeName &&
          typeof path === "string" &&
          (path === "/" ||
            location.mountPath.startsWith(path + "/") ||
            path.startsWith(location.mountPath + "/"))
        );
      })
    )
      throw fail();
    for (const other of [
      ...containers,
      ...(Array.isArray(spec.initContainers) ? spec.initContainers : []),
      ...(Array.isArray(spec.ephemeralContainers)
        ? spec.ephemeralContainers
        : []),
    ])
      if (
        object(other).name !== "postgres" &&
        Array.isArray(object(other).volumeMounts) &&
        (object(other).volumeMounts as unknown[]).some(
          (m) => object(m).name === location.volumeName,
        )
      )
        throw fail();
  }
  const command = container.command;
  if (!Array.isArray(command)) throw fail();
  const boundary = command.indexOf("--"),
    effective = new Map<string, string>();
  if (boundary < 2) throw fail();
  for (let index = 1; index < boundary; index++) {
    const token = command[index];
    if (typeof token !== "string") throw fail();
    const match = /^--?([a-z-]+)(?:=(.*))?$/.exec(token);
    if (
      !match ||
      ![
        "mode",
        "expected-file",
        "public-key-file",
        "ipc-directory",
        "startup-timeout",
        "input-wait",
        "grace",
        "permit-file",
        "run-epoch",
      ].includes(match[1]!) ||
      effective.has(match[1]!)
    )
      throw fail();
    const value = match[2] ?? command[++index];
    if (typeof value !== "string" || index >= boundary) throw fail();
    effective.set(match[1]!, value);
  }
  if (effective.get("mode") !== "signed-window") throw fail();
  for (const [flag, path] of [
    [
      "--expected-file",
      posix.join(
        c.inputs.mountPath,
        c.inputs.privateDirectory,
        "expected.json",
      ),
    ],
    [
      "--public-key-file",
      posix.join(c.inputs.mountPath, c.inputs.privateDirectory, "key.json"),
    ],
    ["--ipc-directory", posix.join(c.ipc.mountPath, c.ipc.privateDirectory)],
  ] as const) {
    if (effective.get(flag.slice(2)) !== path) throw fail();
  }
  const status = object(pod.status),
    statuses = status.containerStatuses;
  if (status.phase !== "Running" || !Array.isArray(statuses)) throw fail();
  const rows = statuses.filter((s) => object(s).name === "postgres");
  if (rows.length !== 1) throw fail();
  const runtime = object(rows[0]);
  if (
    runtime.containerID !== "containerd://" + attemptHint.containerId ||
    runtime.restartCount !== attemptHint.attempt ||
    runtime.imageID !== c.runtimeImageId ||
    !object(runtime.state).running
  )
    throw fail();
  const init: NodeDeliveryInitialization = {
    version: 1,
    requestId,
    scope: {
      installationId: expected.binding.installationId,
      regionId: expected.binding.regionId,
      nodeName: expected.binding.nodeName,
      nodeUid: expected.binding.nodeUid,
      expectedBootId: expected.binding.bootId,
    },
    pod: {
      podUid: original.uid,
      namespace: snapshot.plan.namespace,
      podName: original.name,
      containerName: "postgres",
      containerId: attemptHint.containerId,
      attempt: attemptHint.attempt,
      volumeName: c.ipc.volumeName,
      containerPath: c.ipc.mountPath,
      emptyDir: true,
      subPath: "",
      subPathExpr: "",
    },
    kubeletRoot: c.delivery.kubeletRoot,
    privateDirectory: c.ipc.privateDirectory,
    guardUid: c.guardUid,
    guardGid: c.guardGid,
    nonce: attemptHint.nonce,
    expected,
    publicKeyPin: structuredClone(c.publicKeyPin),
  };
  challengeFor(init);
  check();
  return init;
}
