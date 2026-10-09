// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ComputePoolPolicyState,
  ComputePoolObservation,
} from "@pgcf/contracts/compute-pool";
import type { FleetPatchInput } from "@pgcf/contracts/fleet-patches";
import { sandboxRuntimeAdmission } from "../../../infra/talos/sandbox/runtime-admission.ts";
import { quantity, assertWorkloadReady } from "./platform.ts";
import { BootstrapError, canonical, digest } from "./bootstrap.ts";
import { patchObject as object } from "./fleet-patch-observations.ts";

export interface RuntimeAdmissionCommands {
  kube(args: string[], stdin?: string): Promise<string>;
  authorize(): Promise<void>;
}
export type RuntimeAdmissionInput = Pick<
  FleetPatchInput,
  "status" | "spec" | "k8s_node_name" | "host_configuration"
> & {
  compute_pool: ComputePoolPolicyState;
  compute_pool_observation: ComputePoolObservation;
};
const fail = (): never => {
  throw new BootstrapError("patch_runtime_admission_conflict");
};
function imagePin(value: unknown) {
  if (typeof value !== "string") return undefined;
  const match = /^([^\s@]+)@sha256:([a-f0-9]{64})$/.exec(value);
  if (!match) return undefined;
  let repository = match[1]!;
  const colon = repository.lastIndexOf(":");
  if (colon > repository.lastIndexOf("/"))
    repository = repository.slice(0, colon);
  return repository + "@sha256:" + match[2];
}
const resources = [
  "runtimeclass.node.k8s.io",
  "mutatingadmissionpolicy.admissionregistration.k8s.io",
  "mutatingadmissionpolicybinding.admissionregistration.k8s.io",
] as const;
function verified(input: RuntimeAdmissionInput) {
  const state = ComputePoolPolicyState.parse(input.compute_pool),
    seen = ComputePoolObservation.parse(input.compute_pool_observation),
    host = input.host_configuration?.status,
    at = Date.parse(seen.observed_at),
    now = Date.now();
  if (
    !host ||
    state.node_id !== input.status.node_id ||
    state.node_uid !== input.status.node_uid ||
    state.region_id !== input.status.region_id ||
    state.policy.profile.release_id !== input.status.release_id ||
    host.node_id !== input.status.node_id ||
    host.region_id !== input.status.region_id ||
    host.cluster_uid !== input.status.cluster_uid ||
    host.release_id !== input.status.release_id ||
    host.node_uid !== state.node_uid ||
    seen.node_id !== state.node_id ||
    seen.node_uid !== state.node_uid ||
    seen.policy_revision !== state.revision ||
    seen.material_revision !== host.material_revision ||
    canonical(seen.profile) !== canonical(state.policy.profile) ||
    at < now - 120000 ||
    at > now + 5000 ||
    digest(canonical(state.policy.profile)) !== host.profile_sha256 ||
    seen.slots.filter((slot) => slot.sandbox_id === null && slot.live).length <
      state.policy.target_slots
  )
    return fail();
  const image = input.spec.components.find(
    (component) =>
      component.name === "image/cloudnative-pg/cloudnative-pg" &&
      component.kind === "image",
  );
  if (!image) return fail();
  return {
    state,
    host,
    image,
    rendered: sandboxRuntimeAdmission({
      operatorNamespace: "cnpg-system",
      operatorServiceAccount: "cloudnative-pg",
      profileSha256: host.profile_sha256,
      perSlotCpuMillicores: state.policy.per_slot_cpu_millicores,
      perSlotMemoryMiB: state.policy.per_slot_memory_mib,
    }),
  };
}
async function read(
  commands: RuntimeAdmissionCommands,
  input: RuntimeAdmissionInput,
) {
  const selected = verified(input),
    node = object(
      JSON.parse(
        await commands.kube([
          "get",
          "node",
          input.k8s_node_name,
          "--output=json",
        ]),
      ),
    ),
    metadata = object(node.metadata),
    labels = object(metadata.labels),
    status = object(node.status);
  if (
    metadata.uid !== input.status.node_uid ||
    labels["pgcf.io/node-id"] !== input.status.node_id ||
    (labels["pgcf.io/region"] !== undefined &&
      labels["pgcf.io/region"] !== input.status.region_id) ||
    !Array.isArray(status.conditions) ||
    !status.conditions.some(
      (value) =>
        object(value).type === "Ready" && object(value).status === "True",
    )
  )
    return fail();
  const label = selected.rendered.nodeLabel;
  if (
    labels[label.key] !== undefined &&
    !/^r-[a-f0-9]{40}$/.test(String(labels[label.key]))
  )
    return fail();
  const deployment = object(
      JSON.parse(
        await commands.kube([
          "get",
          "deployment",
          "cloudnative-pg",
          "--namespace=cnpg-system",
          "--output=json",
        ]),
      ),
    ),
    dmeta = object(deployment.metadata),
    dspec = object(deployment.spec),
    template = object(object(dspec.template).spec),
    dstatus = object(deployment.status);
  if (
    object(dmeta.annotations)["meta.helm.sh/release-name"] !==
      "cloudnative-pg" ||
    object(dmeta.annotations)["meta.helm.sh/release-namespace"] !==
      "cnpg-system" ||
    template.serviceAccountName !== "cloudnative-pg" ||
    !Array.isArray(template.containers) ||
    template.containers.filter(
      (value) =>
        imagePin(object(value).image) === imagePin(selected.image.reference),
    ).length !== 1 ||
    !Number.isInteger(dmeta.generation) ||
    dstatus.observedGeneration !== dmeta.generation
  )
    return fail();
  try {
    assertWorkloadReady("Deployment", deployment);
  } catch {
    return fail();
  }
  const present: boolean[] = [],
    actuals: (Record<string, unknown> | null)[] = [];
  for (let index = 0; index < resources.length; index++) {
    const wanted = selected.rendered.objects[index]!,
      raw = await commands.kube([
        "get",
        resources[index]!,
        wanted.metadata.name,
        "--ignore-not-found",
        "--output=json",
      ]);
    if (!raw.trim()) {
      present.push(false);
      actuals.push(null);
      continue;
    }
    const actual = object(JSON.parse(raw)),
      meta = object(actual.metadata),
      annotations = object(meta.annotations);
    const oldProfile = annotations["pgcf.io/compute-profile-sha256"];
    if (
      object(meta.labels)["pgcf.io/managed-by"] !== "node-bootstrap" ||
      annotations["pgcf.io/runtime-admission"] !== "1" ||
      typeof oldProfile !== "string" ||
      !/^[a-f0-9]{64}$/.test(oldProfile)
    )
      return fail();
    let matches = oldProfile === selected.host.profile_sha256;
    if (wanted.kind === "RuntimeClass") {
      const fixed = object(object(actual.overhead).podFixed),
        selector = object(object(actual.scheduling).nodeSelector);
      const bounded = (value: unknown, min: number, max: number, scale = 1) => {
        try {
          const [n, d] = quantity(value);
          return (
            n * BigInt(scale) >= BigInt(min) * d &&
            n * BigInt(scale) <= BigInt(max) * d
          );
        } catch {
          return false;
        }
      };
      if (
        actual.handler !== wanted.handler ||
        Object.keys(fixed).sort().join(",") !== "cpu,memory" ||
        !bounded(fixed.cpu, 1, 500, 1000) ||
        !bounded(fixed.memory, 16 * 1024 * 1024, 512 * 1024 * 1024) ||
        selector[label.key] !== "r-" + oldProfile.slice(0, 40)
      )
        return fail();
      const expected = object(wanted.overhead).podFixed;
      const equal = (a: unknown, b: unknown) => {
        const [n, d] = quantity(a),
          [x, y] = quantity(b);
        return n * y === x * d;
      };
      matches =
        matches &&
        equal(fixed.cpu, object(expected).cpu) &&
        equal(fixed.memory, object(expected).memory) &&
        selector[label.key] === label.value;
    } else if (canonical(actual.spec) !== canonical(wanted.spec)) return fail();
    present.push(matches);
    actuals.push(actual);
  }
  return {
    ...selected,
    node,
    labels,
    present,
    actuals,
    confirmed:
      present.every(Boolean) &&
      labels[label.key] === label.value &&
      labels["pgcf.io/region"] === input.status.region_id,
  };
}
export async function readRuntimeAdmission(
  commands: RuntimeAdmissionCommands,
  input: RuntimeAdmissionInput,
) {
  const current = await read(commands, input);
  return {
    confirmed: current.confirmed,
    profile_sha256: current.host.profile_sha256,
  };
}
/** Resume starts with exact owned/absent object reads. SSA and a labels-only Node CAS preserve unrelated fields. */
export async function applyRuntimeAdmission(
  commands: RuntimeAdmissionCommands,
  input: RuntimeAdmissionInput,
) {
  let current = await read(commands, input);
  for (let index = 0; index < resources.length; index++) {
    if (current.present[index]) continue;
    const wanted = current.rendered.objects[index]!;
    const existing = current.actuals[index];
    if (existing) {
      const meta = object(existing.metadata),
        priorAnnotations = object(meta.annotations),
        fields =
          wanted.kind === "RuntimeClass"
            ? {
                handler: existing.handler,
                overhead: existing.overhead,
                scheduling: existing.scheduling,
              }
            : { spec: existing.spec };
      if (typeof meta.uid !== "string") return fail();
      const nextFields =
        wanted.kind === "RuntimeClass"
          ? {
              handler: wanted.handler,
              overhead: wanted.overhead,
              scheduling: {
                ...object(existing.scheduling),
                nodeSelector: {
                  ...object(object(existing.scheduling).nodeSelector),
                  [current.rendered.nodeLabel.key]:
                    current.rendered.nodeLabel.value,
                },
              },
            }
          : { spec: wanted.spec };
      const patch = [
        { op: "test", path: "/metadata/uid", value: meta.uid },
        { op: "test", path: "/metadata/labels", value: meta.labels },
        { op: "test", path: "/metadata/annotations", value: priorAnnotations },
        ...Object.entries(fields).map(([key, value]) => ({
          op: "test",
          path: "/" + key,
          value,
        })),
        {
          op: "replace",
          path: "/metadata/annotations",
          value: { ...priorAnnotations, ...wanted.metadata.annotations },
        },
        ...Object.entries(nextFields).map(([key, value]) => ({
          op: "replace",
          path: "/" + key,
          value,
        })),
      ];
      const directory = await mkdtemp(
          join(tmpdir(), "pgcf-runtime-transition-"),
        ),
        path = join(directory, "owned.json");
      try {
        await writeFile(path, JSON.stringify(patch), {
          mode: 0o600,
          flag: "wx",
        });
        const args = [
          "patch",
          resources[index]!,
          wanted.metadata.name,
          "--type=json",
          `--patch-file=${path}`,
          "--output=json",
        ];
        await commands.kube([...args, "--dry-run=server"]);
        await commands.authorize();
        current = await read(commands, input);
        if (current.present[index]) continue;
        const owned = (value: Record<string, unknown> | null | undefined) =>
          value
            ? {
                uid: object(value.metadata).uid,
                labels: object(value.metadata).labels,
                annotations: object(value.metadata).annotations,
                ...(wanted.kind === "RuntimeClass"
                  ? {
                      handler: value.handler,
                      overhead: value.overhead,
                      scheduling: value.scheduling,
                    }
                  : { spec: value.spec }),
              }
            : null;
        if (
          canonical(owned(current.actuals[index])) !==
          canonical(owned(existing))
        )
          return;
        try {
          await commands.kube(args);
        } catch {
          return;
        }
        current = await read(commands, input);
        if (!current.present[index]) return;
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
      continue;
    }
    const body = JSON.stringify(wanted),
      args = [
        "apply",
        "--server-side",
        "--field-manager=pgcf-runtime-admission",
        "--filename=-",
        "--output=json",
      ];
    await commands.kube([...args, "--dry-run=server"], body);
    await commands.authorize();
    current = await read(commands, input);
    if (current.present[index]) continue;
    try {
      await commands.kube(args, body);
    } catch {
      return;
    }
    current = await read(commands, input);
    if (!current.present[index]) return;
  }
  const label = current.rendered.nodeLabel;
  if (
    current.labels[label.key] === label.value &&
    current.labels["pgcf.io/region"] === input.status.region_id
  )
    return;
  await commands.authorize();
  current = await read(commands, input);
  if (
    current.labels[label.key] === label.value &&
    current.labels["pgcf.io/region"] === input.status.region_id
  )
    return;
  const patch = [
    { op: "test", path: "/metadata/uid", value: input.status.node_uid },
    { op: "test", path: "/metadata/labels", value: current.labels },
    {
      op: "replace",
      path: "/metadata/labels",
      value: {
        ...current.labels,
        [label.key]: label.value,
        "pgcf.io/region": input.status.region_id,
      },
    },
  ];
  const directory = await mkdtemp(join(tmpdir(), "pgcf-runtime-label-")),
    path = join(directory, "node.json");
  try {
    await writeFile(path, JSON.stringify(patch), { mode: 0o600, flag: "wx" });
    const args = [
      "patch",
      "node",
      input.k8s_node_name,
      "--type=json",
      `--patch-file=${path}`,
      "--output=json",
    ];
    await commands.kube([...args, "--dry-run=server"]);
    await commands.authorize();
    await commands.kube(args).catch(() => undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
