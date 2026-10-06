// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

const Bytes = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const LvmUuid = z.string().regex(/^[A-Za-z0-9-]{1,128}$/);
const At = z.iso.datetime({ precision: 3 });
export const NodeStorageVgReadback = z.strictObject({
  observed_at: At,
  node_uid: z.uuid(),
  lvmnode_uid: z.uuid(),
  resource_version: z.string().regex(/^[0-9]+$/),
  vg_uuid: LvmUuid,
  size: Bytes,
  free: Bytes,
});
export type NodeStorageVgReadback = z.infer<typeof NodeStorageVgReadback>;
export const NodeStorageTrialStage = z.enum([
  "intent",
  "allocated",
  "written",
  "cleanup",
  "reclaimed",
  "published",
]);
const Run = z
  .strictObject({
    namespace_name: z.string().regex(/^pgcf-storage-[a-f0-9]{20}-[1-9][0-9]?$/),
    trial_sha256: Hash,
    image: z
      .string()
      .max(512)
      .regex(/^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/),
    data_sha256: Hash,
    volume_bytes: z.literal(1024 ** 3),
    stage: NodeStorageTrialStage,
    namespace_uid: z.uuid().nullable(),
    pvc_uid: z.uuid().nullable(),
    pod_uid: z.uuid().nullable(),
    pv_name: z
      .string()
      .regex(/^pvc-[a-f0-9-]{36}$/)
      .nullable(),
    pv_uid: z.uuid().nullable(),
    volume_handle: z
      .string()
      .regex(/^pvc-[a-f0-9-]{36}$/)
      .nullable(),
    lvmvolume_uid: z.uuid().nullable(),
    lv_uuid: LvmUuid.nullable(),
    before: NodeStorageVgReadback,
    allocated: NodeStorageVgReadback.nullable(),
    after: NodeStorageVgReadback.nullable(),
    written_at: At.nullable(),
    published_at: At.nullable(),
  })
  .superRefine((run, ctx) => {
    if (
      ["allocated", "written", "published"].includes(run.stage) &&
      [
        run.namespace_uid,
        run.pvc_uid,
        run.pod_uid,
        run.pv_uid,
        run.pv_name,
        run.volume_handle,
        run.lvmvolume_uid,
        run.lv_uuid,
        run.allocated,
      ].some((value) => value === null)
    )
      ctx.addIssue({
        code: "custom",
        message:
          "allocated storage requires recorded physical and Kubernetes identities",
      });
    if (["written", "published"].includes(run.stage) && run.written_at === null)
      ctx.addIssue({
        code: "custom",
        message: "storage write proof is missing",
      });
    if (["reclaimed", "published"].includes(run.stage) && run.after === null)
      ctx.addIssue({
        code: "custom",
        message: "storage reclamation is not observed",
      });
    if ((run.stage === "published") !== (run.published_at !== null))
      ctx.addIssue({
        code: "custom",
        message: "storage publication time differs from state",
      });
  });
export const NodeStorageTrial = z.strictObject({
  version: z.literal(1),
  input_hash: Hash,
  node_uid: z.uuid(),
  cluster_uid: z.uuid(),
  storage_namespace_uid: z.uuid(),
  lvmnode_uid: z.uuid(),
  vg_uuid: LvmUuid,
  pv_uuid: LvmUuid,
  device: z.string().regex(/^\/dev\/[a-z0-9]+$/),
  partition_uuid: z.uuid(),
  total_bytes: Bytes.refine((n) => n >= 1024 ** 3),
  extent_size_bytes: Bytes.refine((n) => n > 0),
  runs: z.array(Run).min(1).max(16),
});
export type NodeStorageTrial = z.infer<typeof NodeStorageTrial>;
export type NodeStorageTrialRun = NodeStorageTrial["runs"][number];

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

/** Retain old trials and set each learned UID/handle once; a resume cannot replace ownership. */
export function nodeStorageTrialTransition(
  previous: NodeStorageTrial | null | undefined,
  next: NodeStorageTrial | null | undefined,
  inputHash: string,
): boolean {
  if (!next) return !previous;
  if (next.input_hash !== inputHash) return false;
  for (let i = 0; i < next.runs.length; i++) {
    const run = next.runs[i]!;
    if (
      run.namespace_name !== `pgcf-storage-${inputHash.slice(0, 20)}-${i + 1}`
    )
      return false;
    for (const sample of [run.before, run.allocated, run.after]) {
      if (
        sample &&
        (sample.node_uid !== next.node_uid ||
          sample.lvmnode_uid !== next.lvmnode_uid ||
          sample.vg_uuid !== next.vg_uuid ||
          sample.size !== next.total_bytes ||
          sample.free > sample.size)
      )
        return false;
    }
  }
  if (!previous)
    return next.runs.length === 1 && next.runs[0]!.stage === "intent";
  const { runs: oldRuns, ...oldBinding } = previous;
  const { runs: newRuns, ...newBinding } = next;
  if (
    canonical(oldBinding) !== canonical(newBinding) ||
    newRuns.length < oldRuns.length ||
    newRuns.length > oldRuns.length + 1
  )
    return false;
  for (let i = 0; i < oldRuns.length - 1; i++)
    if (canonical(oldRuns[i]) !== canonical(newRuns[i])) return false;
  const old = oldRuns.at(-1)!,
    current = newRuns[oldRuns.length - 1]!;
  if (newRuns.length > oldRuns.length)
    return (
      ["reclaimed", "published"].includes(old.stage) &&
      canonical(old) === canonical(current) &&
      newRuns.at(-1)!.stage === "intent"
    );
  for (const key of [
    "namespace_name",
    "trial_sha256",
    "image",
    "data_sha256",
    "volume_bytes",
    "before",
  ] as const)
    if (canonical(old[key]) !== canonical(current[key])) return false;
  for (const key of [
    "namespace_uid",
    "pvc_uid",
    "pod_uid",
    "pv_name",
    "pv_uid",
    "volume_handle",
    "lvmvolume_uid",
    "lv_uuid",
    "allocated",
    "after",
    "written_at",
    "published_at",
  ] as const)
    if (old[key] !== null && canonical(old[key]) !== canonical(current[key]))
      return false;
  return (
    NodeStorageTrialStage.options.indexOf(current.stage) >=
    NodeStorageTrialStage.options.indexOf(old.stage)
  );
}
