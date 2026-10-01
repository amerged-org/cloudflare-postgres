// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { posix } from "node:path";
import { provisioningResourceEnvelope } from "@cloudflare-postgres/resource-envelope";
import { canonicalCohort } from "./node-cohort.ts";
import type { Claim, Resource } from "./types.ts";
import type { ProvisioningFunding } from "./provisioning-funding.ts";
import type { CapacityJournal } from "./capacity-journal.ts";
import type { CapacityRuntime } from "./capacity-types.ts";

export interface PostgresExecutionRecipe {
  image: string;
  command: string[];
  // Current preparation supports a catalog-pinned image containing the guard
  // in its read-only image root. Volume-delivered binaries need their own proof.
  guard: { executable: string; image: string };
}
export interface PostgresExpectedManifest {
  version: 2;
  command: string[];
  binding: {
    installationId: string;
    organizationId: string;
    projectId: string;
    regionId: string;
    reservationId: string;
    reservationRevision: string;
    reservationEpoch: string;
    operationId: string;
    environmentId: string;
    specRevision: 1;
    specHash: string;
    runEpoch: "1";
    namespace: string;
    namespaceUid: string;
    podUid: string;
    containerName: "postgres";
    nodeName: string;
    nodeUid: string;
    bootId: string;
    imageHash: string;
    commandHash: string;
    resourceEnvelopeHash: string;
  };
}
const fail = () => new Error("execution_manifest_identity_unproven");
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw fail();
  return value as Record<string, unknown>;
}
function argvHash(command: string[]): string {
  if (
    !Array.isArray(command) ||
    command.length < 1 ||
    command.length > 64 ||
    typeof command[0] !== "string" ||
    !posix.isAbsolute(command[0]) ||
    posix.normalize(command[0]) !== command[0]
  )
    throw fail();
  const digest = createHash("sha256");
  digest.update("cloudflare-postgres/execution-command/v2\0");
  const frame = Buffer.alloc(4);
  frame.writeUInt32BE(command.length);
  digest.update(frame);
  let length = 0;
  for (const argument of command) {
    if (typeof argument !== "string" || argument.includes("\0")) throw fail();
    const bytes = Buffer.from(argument, "utf8");
    if (
      bytes.toString("utf8") !== argument ||
      (length += bytes.length) > 16_384
    )
      throw fail();
    frame.writeUInt32BE(bytes.length);
    digest.update(frame);
    digest.update(bytes);
  }
  return digest.digest("hex");
}

// Produces the exact input required by the existing guard. This read-only
// preparation neither writes protection files nor authorizes process startup.
export async function preparePostgresExpectedManifest(input: {
  claim: Claim;
  funding: ProvisioningFunding;
  journal: CapacityJournal;
  runtime: CapacityRuntime;
  podUid: string;
  recipe: PostgresExecutionRecipe;
  authority: { check: () => void; expiresAt: () => number };
}): Promise<PostgresExpectedManifest> {
  const { claim, funding, journal, runtime, recipe, authority } = input;
  const receiptDeadline = Date.parse(funding.reservation.expiresAt);
  const deadline = Math.min(
    Date.now() + 10_000,
    authority.expiresAt(),
    receiptDeadline,
  );
  const check = () => {
    authority.check();
    const current = journal.snapshot();
    const receipt = funding.reservation;
    if (
      receipt.environmentId !== claim.environmentId ||
      receipt.regionId !== claim.regionId ||
      receipt.specRevision !== claim.specRevision ||
      receipt.specHash !== claim.specHash ||
      receipt.status !== "issued" ||
      receipt.gapCount !== "0" ||
      receipt.stoppedAt !== null ||
      !Number.isSafeInteger(receiptDeadline) ||
      !Number.isSafeInteger(Date.parse(receipt.issuedAt)) ||
      Date.parse(receipt.issuedAt) > Date.now() ||
      Date.now() >= receiptDeadline
    )
      throw fail();
    if (
      !["materializing", "active"].includes(current.phase) ||
      !Number.isSafeInteger(deadline) ||
      Date.now() >= Math.min(deadline, authority.expiresAt())
    )
      throw fail();
  };
  check();
  const state = journal.snapshot();
  const slot = state.slots.find((v) =>
    v.consumers.some((c) => c.uid === input.podUid),
  );
  const consumer = slot?.consumers.find((c) => c.uid === input.podUid);
  if (
    !slot ||
    !consumer ||
    slot.plan.kind !== "database" ||
    slot.retirements.some((v) => v.podUid === consumer.uid) ||
    !slot.node ||
    !slot.targetPvc ||
    slot.handoffPhase !== "rebound" ||
    !state.namespaceUid ||
    !state.clusterUid ||
    state.plan.binding.runEpoch !== "1" ||
    claim.runEpoch !== "1" ||
    claim.specRevision !== 1 ||
    claim.environmentId !== state.plan.binding.environmentId ||
    claim.regionId !== state.plan.binding.regionId ||
    claim.operationId !== state.plan.binding.operationId ||
    claim.specHash !== state.plan.binding.specHash ||
    hash(JSON.stringify(claim.spec)) !== claim.specHash ||
    funding.operationId !== claim.operationId ||
    funding.environmentId !== claim.environmentId ||
    funding.regionId !== claim.regionId ||
    funding.specHash !== claim.specHash ||
    funding.specRevision !== 1 ||
    funding.runEpoch !== "1" ||
    funding.projectId !== state.projectId ||
    funding.organizationId !== state.organizationId ||
    funding.reservation.status !== "issued" ||
    Date.parse(funding.reservation.expiresAt) <= Date.now() ||
    recipe.image !== claim.spec.profile.postgresImage
  )
    throw fail();
  const read = async (
    kind: string,
    namespace: string,
    name: string,
  ): Promise<Resource> => {
    check();
    const r = await runtime.read(kind, namespace, name);
    check();
    if (
      !r ||
      r.kind !== kind ||
      r.metadata.name !== name ||
      (r.metadata.namespace ?? "") !== namespace ||
      r.metadata.deletionTimestamp
    )
      throw fail();
    return r;
  };
  const namespace = await read("Namespace", "", state.plan.namespace);
  const cluster = await read("Cluster", state.plan.namespace, "database");
  const pod = await read("Pod", state.plan.namespace, consumer.name);
  const node = await read("Node", "", slot.node.name);
  const owner = pod.metadata.ownerReferences?.[0];
  if (
    namespace.metadata.uid !== state.namespaceUid ||
    cluster.metadata.uid !== state.clusterUid ||
    pod.metadata.uid !== consumer.uid ||
    pod.metadata.labels?.["cnpg.io/podRole"] !== "instance" ||
    pod.metadata.ownerReferences?.length !== 1 ||
    !owner ||
    owner.apiVersion !== "postgresql.cnpg.io/v1" ||
    owner.kind !== "Cluster" ||
    owner.name !== "database" ||
    owner.uid !== state.clusterUid ||
    owner.controller !== true ||
    node.metadata.uid !== slot.node.uid ||
    object(object(node.status).nodeInfo).bootID !== slot.node.bootId ||
    object(pod.spec).nodeName !== slot.node.name ||
    hash(canonicalCohort(pod.spec)) !== consumer.specHash ||
    object(pod.spec).shareProcessNamespace === true ||
    !pod.metadata.finalizers?.includes("pgcf.io/capacity-" + claim.operationId)
  )
    throw fail();
  const containers = object(pod.spec).containers;
  if (!Array.isArray(containers)) throw fail();
  const selected = containers.filter((c) => object(c).name === "postgres");
  if (selected.length !== 1) throw fail();
  const container = object(selected[0]);
  if (
    !recipe.guard ||
    recipe.guard.image !== recipe.image ||
    !posix.isAbsolute(recipe.guard.executable) ||
    posix.normalize(recipe.guard.executable) !== recipe.guard.executable ||
    object(container.securityContext).readOnlyRootFilesystem !== true
  )
    throw fail();
  const mounts = container.volumeMounts ?? [];
  if (
    !Array.isArray(mounts) ||
    mounts.some((value) => {
      const mount = object(value);
      if (
        typeof mount.mountPath !== "string" ||
        !posix.isAbsolute(mount.mountPath)
      )
        return true;
      const path = posix.normalize(mount.mountPath);
      return (
        path === "/" ||
        path === recipe.guard.executable ||
        recipe.guard.executable.startsWith(path + "/")
      );
    })
  )
    throw fail();
  if (
    container.image !== recipe.image ||
    !Array.isArray(container.command) ||
    !container.command.every((v) => typeof v === "string")
  )
    throw fail();
  if (
    container.args !== undefined &&
    (!Array.isArray(container.args) ||
      !container.args.every((v) => typeof v === "string"))
  )
    throw fail();
  const command = container.command as string[];
  const boundary = command.indexOf("--");
  const mode = command.indexOf("--mode");
  if (
    command[0] !== recipe.guard.executable ||
    !posix.isAbsolute(command[0] ?? "") ||
    posix.normalize(command[0] ?? "") !== command[0] ||
    posix.basename(command[0] ?? "") !== "execution-guard" ||
    mode < 1 ||
    command[mode + 1] !== "signed-window" ||
    command.filter((v) => v === "--mode").length !== 1 ||
    boundary <= mode + 1 ||
    canonicalCohort([
      ...command.slice(boundary + 1),
      ...(container.args === undefined ? [] : (container.args as string[])),
    ]) !== canonicalCohort(recipe.command)
  )
    throw fail();
  const imageHash = /@sha256:([a-f0-9]{64})$/.exec(recipe.image)?.[1];
  if (!imageHash) throw fail();
  const envelope = provisioningResourceEnvelope({
    ...claim.spec.profile,
    volumeGiB: claim.spec.volumeGiB,
  });
  check();
  const latest = journal.snapshot();
  if (
    latest.namespaceUid !== state.namespaceUid ||
    latest.clusterUid !== state.clusterUid ||
    latest.slots
      .find((s) => s.plan.id === slot.plan.id)
      ?.retirements.some((r) => r.podUid === consumer.uid)
  )
    throw fail();
  return {
    version: 2,
    command: [...recipe.command],
    binding: {
      installationId: state.plan.binding.installationId,
      organizationId: funding.organizationId,
      projectId: funding.projectId,
      regionId: claim.regionId,
      reservationId: funding.reservation.id,
      reservationRevision: funding.reservation.revision,
      reservationEpoch: funding.reservation.epoch,
      operationId: claim.operationId,
      environmentId: claim.environmentId,
      specRevision: 1,
      specHash: claim.specHash,
      runEpoch: "1",
      namespace: state.plan.namespace,
      namespaceUid: state.namespaceUid,
      podUid: consumer.uid,
      containerName: "postgres",
      nodeName: slot.node.name,
      nodeUid: slot.node.uid,
      bootId: slot.node.bootId,
      imageHash,
      commandHash: argvHash(recipe.command),
      resourceEnvelopeHash: hash(canonicalCohort(envelope)),
    },
  };
}
