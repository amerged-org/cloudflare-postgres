// SPDX-License-Identifier: Apache-2.0
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, parseAllDocuments, stringify } from "yaml";
import {
  FleetRegionMaterialRotationCheckpoint,
  FleetRegionMaterialRotationInput,
  REGION_AUTHORITY_PHASES,
  regionAuthorityPhaseMembers,
  RegionMaterialRotationVerification,
  type RegionAuthorityPhase,
} from "@pgcf/contracts/region-material-rotation";
import {
  BootstrapError,
  canonical,
  digest,
  runCommand,
  type CommandRunner,
} from "./bootstrap.ts";
import { openTalosOperator } from "./talos-operator.ts";
import {
  buildPhase,
  configurationEqual,
  configurationHash,
  type AuthorityDocuments,
} from "./region-authority-phases.ts";
import {
  verifyRegionAuthorityRetirement,
  verifyTalosAdministrationPair,
  verifyRotationSecretCiphertexts,
} from "./region-authority-probes.ts";
import {
  rewriteRotationSecrets,
  renewRotationConsumers,
  retireRotationBootstrapToken,
} from "./rotation-kubernetes.ts";

type Input = FleetRegionMaterialRotationInput;
type Checkpoint = FleetRegionMaterialRotationCheckpoint;
type ObjectValue = Record<string, unknown>;
const fail = (code: string): never => {
  throw new BootstrapError(`rotation_${code}`);
};
function object(value: unknown): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return fail("configuration_invalid");
  return value as ObjectValue;
}
function documents(text: string): AuthorityDocuments {
  const parsed = parseAllDocuments(text, { uniqueKeys: true });
  if (!parsed.length || parsed.some((d) => d.errors.length))
    return fail("configuration_invalid");
  return parsed.map((d) => object(d.toJS({ maxAliasCount: 50 })));
}
function one(rows: AuthorityDocuments, kind: string) {
  const found = rows.filter((d) =>
    kind === "legacy"
      ? d.version === "v1alpha1" && d.machine && !d.kind
      : d.kind === kind,
  );
  if (found.length !== 1) return fail("configuration_document_missing");
  return found[0]!;
}
function selectedTalos(value: ObjectValue) {
  const contexts = object(value.contexts),
    selected = contexts[String(value.context)];
  return object(selected);
}
function selectedKube(value: ObjectValue) {
  const contexts = value.contexts as ObjectValue[],
    clusters = value.clusters as ObjectValue[],
    users = value.users as ObjectValue[],
    context = object(
      contexts.find((c) => c.name === value["current-context"])?.context,
    ),
    cluster = clusters.find((c) => c.name === context.cluster),
    user = users.find((u) => u.name === context.user);
  if (!cluster || !user) return fail("client_context_missing");
  return { cluster: object(cluster.cluster), user: object(user.user) };
}
const pem = (value: unknown) =>
  Buffer.from(String(value), "base64").toString("utf8").trimEnd();
/** Existing prepared client keys only. Trust overlap is transient and removed after activation. */
export function rotationClients(input: Input, phase: string) {
  const index = REGION_AUTHORITY_PHASES.indexOf(phase as RegionAuthorityPhase),
    newTalos = index >= 2 || ["verify", "activate", "complete"].includes(phase),
    newKube = index >= 5 || ["verify", "activate", "complete"].includes(phase),
    talos = object(parse(input.current_join.talos_admin_config)),
    replacementTalos = object(parse(input.target_join.talos_admin_config)),
    oldContext = selectedTalos(talos),
    replacementContext = selectedTalos(replacementTalos);
  oldContext.ca = Buffer.from(
    pem(oldContext.ca) + "\n" + pem(replacementContext.ca) + "\n",
  ).toString("base64");
  if (newTalos) {
    oldContext.crt = replacementContext.crt;
    oldContext.key = replacementContext.key;
  }
  delete oldContext["proxy-url"];
  const kube = object(parse(input.current_join.kubeconfig)),
    replacementKube = object(parse(input.target_join.kubeconfig)),
    oldKube = selectedKube(kube),
    nextKube = selectedKube(replacementKube);
  if (oldKube.cluster.server !== nextKube.cluster.server)
    return fail("client_endpoint_changed");
  oldKube.cluster["certificate-authority-data"] = Buffer.from(
    pem(oldKube.cluster["certificate-authority-data"]) +
      "\n" +
      pem(nextKube.cluster["certificate-authority-data"]) +
      "\n",
  ).toString("base64");
  delete oldKube.cluster["proxy-url"];
  if (newKube) {
    Object.assign(oldKube.user, nextKube.user);
    for (const key of ["token", "exec", "auth-provider"])
      delete oldKube.user[key];
  }
  return {
    talosconfig: stringify(talos, { lineWidth: 0 }),
    kubeconfig: JSON.stringify(kube),
  };
}
export function phaseNodes(input: Input, phase: RegionAuthorityPhase) {
  return regionAuthorityPhaseMembers(phase, input.nodes);
}
function validate(raw: unknown) {
  const input = FleetRegionMaterialRotationInput.parse(raw),
    url = new URL(input.callback.url);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !==
      `/internal/v1/fleet-rollouts/${input.rollout_id}/regions/${input.region_id}/rotation` ||
    Date.parse(input.callback.expires_at) <= Date.now()
  )
    return fail("callback_invalid");
  return input;
}
type Options = {
  run?: CommandRunner;
  request?: typeof fetch;
  signal?: AbortSignal;
  openOperator?: typeof openTalosOperator;
};

async function reference(
  input: Input,
  role: "controlplane" | "worker",
  replacement: boolean,
  directory: string,
  run: CommandRunner,
  signal: AbortSignal,
) {
  const seed = replacement ? input.target_seed : input.current_seed,
    out = join(directory, (replacement ? "next-" : "prior-") + role),
    secrets = out + "-secrets.yaml",
    config = out + ".yaml";
  await writeFile(secrets, seed.talos_machine_secrets_yaml, {
    mode: 0o600,
    flag: "wx",
  });
  const result = await run({
    executable: "/usr/local/bin/talosctl",
    args: [
      "gen",
      "config",
      seed.cluster_name,
      seed.cluster_endpoint,
      "--kubernetes-version",
      seed.kubernetes_version,
      "--with-secrets",
      secrets,
      "--output-types",
      role,
      "--output",
      config,
    ],
    signal,
    timeout_ms: 30_000,
    env: process.env,
  });
  if (result.exit_code !== 0) return fail("configuration_render_failed");
  await chmod(config, 0o600);
  const rows = documents(await readFile(config, "utf8"));
  await rm(secrets);
  await rm(config);
  return rows;
}
function checkpointClient(
  input: Input,
  request: typeof fetch,
  signal: AbortSignal,
) {
  let current = input.checkpoint,
    bearer = input.callback.bearer;
  const headers = { Authorization: `Bearer ${bearer}` };
  const commit = async (next: Checkpoint) => {
    const response = await request(input.callback.url, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        expected_revision: current.revision,
        checkpoint: next,
      }),
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    });
    if (!response.ok) return fail("checkpoint_refused");
    const raw = object(await response.json()),
      checkpoint = FleetRegionMaterialRotationCheckpoint.parse(raw.checkpoint);
    if (
      checkpoint.revision !== current.revision + 1 ||
      typeof raw.bearer !== "string"
    )
      return fail("checkpoint_response_invalid");
    current = checkpoint;
    bearer = raw.bearer;
    headers.Authorization = `Bearer ${bearer}`;
    return current;
  };
  return { headers, current: () => current, commit };
}

/** Called only within the control node's existing durable Golden reboot window. No Kubernetes call follows apply. */
export async function applyPreparedEtcdAuthority(
  raw: unknown,
  commands: {
    talos: (
      args: string[],
      timeout?: number,
      stdin?: string,
    ) => Promise<string>;
    run?: CommandRunner;
    request?: typeof fetch;
    signal?: AbortSignal;
  },
) {
  const input = validate(raw),
    signal = commands.signal ?? AbortSignal.timeout(120_000),
    directory = await mkdtemp(join(tmpdir(), "pgcf-etcd-authority-"));
  await chmod(directory, 0o700);
  process.umask(0o077);
  const progress = checkpointClient(input, commands.request ?? fetch, signal);
  try {
    const control = input.nodes.find((n) => n.role === "controlplane");
    if (
      !control ||
      input.nodes.filter((n) => n.role === "controlplane").length !== 1
    )
      return fail("control_plane_topology_unsupported");
    const run = commands.run ?? runCommand,
      [old, next] = await Promise.all([
        reference(input, "controlplane", false, directory, run, signal),
        reference(input, "controlplane", true, directory, run, signal),
      ]),
      read = async () => {
        const row = object(
          JSON.parse(
            await commands.talos(
              ["get", "machineconfig", "v1alpha1", "--output=json"],
              30_000,
            ),
          ),
        );
        if (row.node !== control.address || typeof row.spec !== "string")
          return fail("configuration_node_changed");
        return documents(row.spec);
      },
      actual = await read(),
      target = buildPhase(actual, old, next, "etcd-ca").documents,
      before = configurationHash(actual),
      expected = configurationHash(target);
    const prior = progress.current();
    if (prior.phase === "etcd-ca" && prior.state === "dispatched") {
      if (configurationHash(actual) !== prior.target_sha256)
        return fail("etcd_apply_unresolved_no_replay");
    } else if (configurationEqual(actual, target)) {
      if (prior.phase !== "etcd-ca" || prior.target_sha256 !== expected)
        return fail("etcd_configuration_changed_without_intent");
    } else {
      if (
        prior.phase !== "discovery-secret" ||
        prior.state !== "confirmed" ||
        prior.node_index !== input.nodes.length - 1
      )
        return fail("etcd_phase_order_changed");
      const file = join(directory, "etcd-candidate.yaml");
      await writeFile(
        file,
        target.map((d) => stringify(d, { lineWidth: 0 })).join("---\n"),
        { mode: 0o600, flag: "wx" },
      );
      const validation = await run({
        executable: "/usr/local/bin/talosctl",
        args: ["validate", "--strict", "--mode", "metal", "--config", file],
        signal,
        timeout_ms: 30_000,
        env: process.env,
      });
      if (validation.exit_code !== 0)
        return fail("candidate_validation_failed");
      await progress.commit({
        ...prior,
        revision: prior.revision + 1,
        phase: "etcd-ca",
        node_index: 0,
        state: "dispatched",
        before_sha256: before,
        target_sha256: expected,
        prior_boot_id: (
          await commands.talos(
            ["read", "/proc/sys/kernel/random/boot_id"],
            20_000,
          )
        ).trim(),
      });
      // One attempt. An error never permits replay; the exact target is read back over this retained Talos channel.
      await commands
        .talos(["apply-config", "--mode=no-reboot", "--file", file], 90_000)
        .catch(() => undefined);
      if (!configurationEqual(await read(), target))
        return fail("etcd_apply_unresolved_no_replay");
    }
    const current = progress.current();
    await progress.commit({
      ...current,
      revision: current.revision + 1,
      phase: "etcd-ca",
      state: "confirmed",
      target_sha256: expected,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** One observed phase/member turn; Cloudflare owns dispatch and restart progress. */
export async function runRegionAuthorityRotation(
  raw: unknown,
  options: Options = {},
) {
  const input = validate(raw),
    phase = input.checkpoint.phase,
    signal = AbortSignal.any([
      ...(options.signal ? [options.signal] : []),
      AbortSignal.timeout(600_000),
    ]),
    request = options.request ?? fetch,
    run = options.run ?? runCommand,
    directory = await mkdtemp(join(tmpdir(), "pgcf-region-authority-"));
  await chmod(directory, 0o700);
  process.umask(0o077);
  const progress = checkpointClient(input, request, signal);
  let session: Awaited<ReturnType<typeof openTalosOperator>> | undefined;
  try {
    if (
      !REGION_AUTHORITY_PHASES.includes(phase as RegionAuthorityPhase) &&
      phase !== "verify"
    )
      return fail("phase_invalid");
    if (phase === "etcd-ca")
      return fail("etcd_requires_existing_golden_reboot_window");
    const selected =
        phase === "verify"
          ? input.nodes.filter((n) => n.role === "controlplane")
          : phaseNodes(input, phase as RegionAuthorityPhase),
      node = selected[input.checkpoint.node_index];
    if (!node) return fail("phase_node_invalid");
    const clients = rotationClients(input, phase),
      talosconfig = join(directory, "talosconfig.yaml"),
      kubeconfig = join(directory, "kubeconfig.json");
    await writeFile(talosconfig, clients.talosconfig, {
      mode: 0o600,
      flag: "wx",
    });
    await writeFile(kubeconfig, clients.kubeconfig, {
      mode: 0o600,
      flag: "wx",
    });
    const operatorURL = new URL(
      input.callback.url + `/kubernetes/${node.node_id}`,
    );
    operatorURL.protocol = "wss:";
    session = await (options.openOperator ?? openTalosOperator)({
      nodeId: node.node_id,
      nodeUid: node.node_uid,
      nodeAddress: node.address,
      kubeconfig,
      talosconfig,
      ciliumImage: node.cilium_image,
      ciliumImageID: node.cilium_image_id,
      outputDir: join(directory, "operator"),
      kubectl: "/usr/local/bin/kubectl",
      talosctl: "/usr/local/bin/talosctl",
      timeoutSeconds: 600,
      kubernetesRequest: { url: operatorURL.href, headers: progress.headers },
      signal,
      expectedBinding: {
        node_uid: node.node_uid,
        node_name: node.node_name,
        cluster_uid: input.cluster_uid,
        material_revision: input.current_revision,
      },
    });
    const [old, next] = await Promise.all([
      reference(input, node.role, false, directory, run, signal),
      reference(input, node.role, true, directory, run, signal),
    ]);
    const talos = async (args: string[], timeout = 30_000) => {
        const result = await run({
          executable: "/usr/local/bin/talosctl",
          args: ["--talosconfig", session!.talosPath, ...args],
          signal,
          timeout_ms: timeout,
          env: process.env,
        });
        if (result.exit_code !== 0) return fail("talos_command_failed");
        return result.stdout;
      },
      read = async () => {
        const row = object(
          JSON.parse(
            await talos(["get", "machineconfig", "v1alpha1", "--output=json"]),
          ),
        );
        if (row.node !== node.address || typeof row.spec !== "string")
          return fail("configuration_node_changed");
        return documents(row.spec);
      };
    const kube = async (args: string[], payload?: string) => {
        const result = await run({
          executable: "/usr/local/bin/kubectl",
          args: [
            "--kubeconfig",
            join(session!.outputDir, "kubeconfig.private.json"),
            "--request-timeout=20s",
            ...args,
          ],
          signal,
          timeout_ms: 30_000,
          env: process.env,
          ...(payload === undefined ? {} : { stdin: payload }),
        });
        if (result.exit_code !== 0) return fail("kubernetes_command_failed");
        return result.stdout;
      },
      commands = {
        kube,
        authorize: async () => {
          await session!.verify();
        },
        checkpoint: async (cursor: NonNullable<Checkpoint["cursor"]>) => {
          const current = progress.current();
          await progress.commit({
            ...current,
            revision: current.revision + 1,
            cursor,
          });
        },
      };
    if (phase === "verify") {
      if (
        !input.checkpoint.prior_boot_id ||
        session.carrier.physical.bootId === input.checkpoint.prior_boot_id
      )
        return fail("golden_reboot_not_observed");
      const proof = await verifyRegionAuthorityRetirement({
        session,
        oldDocuments: old,
        newDocuments: next,
        oldTalosconfig: input.current_join.talos_admin_config,
        newTalosconfig: input.target_join.talos_admin_config,
        oldKubeconfig: input.current_join.kubeconfig,
        newKubeconfig: input.target_join.kubeconfig,
        talosctl: "/usr/local/bin/talosctl",
        kubectl: "/usr/local/bin/kubectl",
        outputDir: join(directory, "verification"),
        signal,
      });
      const topology = [];
      for (const member of input.nodes) {
        const rawNode = JSON.parse(
          await run({
            executable: "/usr/local/bin/kubectl",
            args: [
              "--kubeconfig",
              join(session.outputDir, "kubeconfig.private.json"),
              "--request-timeout=20s",
              "get",
              "node",
              member.node_name,
              "-o",
              "json",
            ],
            signal,
            timeout_ms: 30_000,
            env: process.env,
          }).then((r) => {
            if (r.exit_code !== 0) return fail("topology_read_failed");
            return r.stdout;
          }),
        );
        if (
          rawNode.metadata?.uid !== member.node_uid ||
          !rawNode.status?.conditions?.some(
            (c: ObjectValue) => c.type === "Ready" && c.status === "True",
          )
        )
          return fail("topology_changed");
        topology.push({
          node_id: member.node_id,
          node_uid: member.node_uid,
          k8s_node_name: member.node_name,
          provider_instance_id: member.provider_instance_id,
        });
        if (member.role === "worker") {
          const work = join(directory, "verify-" + member.node_id);
          await mkdir(work, { mode: 0o700 });
          const workerURL = new URL(
            input.callback.url + `/kubernetes/${member.node_id}`,
          );
          workerURL.protocol = "wss:";
          const workerSession = await (
            options.openOperator ?? openTalosOperator
          )({
            nodeId: member.node_id,
            nodeUid: member.node_uid,
            nodeAddress: member.address,
            kubeconfig,
            talosconfig,
            ciliumImage: member.cilium_image,
            ciliumImageID: member.cilium_image_id,
            outputDir: join(work, "operator"),
            kubectl: "/usr/local/bin/kubectl",
            talosctl: "/usr/local/bin/talosctl",
            timeoutSeconds: 180,
            kubernetesRequest: {
              url: workerURL.href,
              headers: progress.headers,
            },
            signal,
            expectedBinding: {
              node_uid: member.node_uid,
              node_name: member.node_name,
              cluster_uid: input.cluster_uid,
              material_revision: input.current_revision,
            },
          });
          try {
            const workerNext = await reference(
              input,
              "worker",
              true,
              work,
              run,
              signal,
            );
            await verifyTalosAdministrationPair({
              session: workerSession,
              newDocuments: workerNext,
              oldTalosconfig: input.current_join.talos_admin_config,
              newTalosconfig: input.target_join.talos_admin_config,
              talosctl: "/usr/local/bin/talosctl",
              kubectl: "/usr/local/bin/kubectl",
              outputDir: join(work, "retirement"),
              signal,
            });
          } finally {
            await workerSession.close();
          }
        }
      }
      const current = progress.current();
      const liveTalos = object(
          object(JSON.parse(await talos(["version", "--json"]))).version,
        ).tag,
        liveKubernetes = JSON.parse(
          await run({
            executable: "/usr/local/bin/kubectl",
            args: [
              "--kubeconfig",
              join(session.outputDir, "kubeconfig.private.json"),
              "--request-timeout=20s",
              "get",
              "--raw",
              "/version",
            ],
            signal,
            timeout_ms: 30_000,
            env: process.env,
          }).then((r) => {
            if (r.exit_code !== 0)
              return fail("kubernetes_version_read_failed");
            return r.stdout;
          }),
        ).gitVersion;
      if (typeof liveTalos !== "string" || typeof liveKubernetes !== "string")
        return fail("live_versions_invalid");
      await progress.commit({
        ...current,
        revision: current.revision + 1,
        state: "confirmed",
        verified: RegionMaterialRotationVerification.parse({
          source: "trusted_native",
          seed_sha256: digest(canonical(input.target_seed)),
          join_sha256: digest(canonical(input.target_join)),
          transcript_sha256: proof.transcript_sha256,
          retired_authorities: proof.retired_authorities,
          observed_at: new Date().toISOString(),
          kube_system_uid: input.cluster_uid,
          talos_version: liveTalos.replace(/^v/, ""),
          kubernetes_version: liveKubernetes.replace(/^v/, ""),
          nodes: topology,
        }),
      });
      return;
    }
    const actual = await read(),
      target = buildPhase(
        actual,
        old,
        next,
        phase as RegionAuthorityPhase,
      ).documents,
      before = configurationHash(actual),
      expected = configurationHash(target),
      prior = progress.current();
    if (prior.state === "dispatched") {
      if (before !== prior.target_sha256)
        return fail("apply_unresolved_no_replay");
    } else {
      let file: string | undefined;
      if (!configurationEqual(actual, target)) {
        file = join(directory, "candidate.yaml");
        await writeFile(
          file,
          target.map((d) => stringify(d, { lineWidth: 0 })).join("---\n"),
          { mode: 0o600, flag: "wx" },
        );
        const validation = await run({
          executable: "/usr/local/bin/talosctl",
          args: ["validate", "--strict", "--mode", "metal", "--config", file],
          signal,
          timeout_ms: 30_000,
          env: process.env,
        });
        if (validation.exit_code !== 0)
          return fail("candidate_validation_failed");
      }
      await session.verify();
      await progress.commit({
        ...prior,
        revision: prior.revision + 1,
        state: "dispatched",
        before_sha256: before,
        target_sha256: expected,
      });
      if (file) {
        await talos(
          ["apply-config", "--mode=no-reboot", "--file", file],
          90_000,
        ).catch(() => undefined);
        if (!configurationEqual(await read(), target))
          return fail("apply_unresolved_no_replay");
      }
    }
    if (phase === "service-account-issue") {
      const issuer = object(one(next, "KubeServiceAccountConfig").issuer);
      await renewRotationConsumers(
        {
          issuer_private_key: String(issuer.privateKey),
          issuer_url: String(issuer.issuerURL),
          annotation_value: `${input.rollout_id}:${input.target_revision}`,
          cursor: progress.current().cursor,
        },
        commands,
      );
    }
    if (phase === "bootstrap-token" && node.role === "controlplane") {
      await retireRotationBootstrapToken(
        {
          old_token: String(object(one(old, "legacy").cluster).token),
          new_token: String(object(one(next, "legacy").cluster).token),
          cursor: progress.current().cursor,
        },
        commands,
      );
    }
    if (phase === "encryption-issue" || phase === "encryption-name-issue") {
      const encryption = object(one(target, "KubeEtcdEncryptionConfig").config),
        resources = encryption.resources as ObjectValue[],
        resource = resources.find((r) =>
          (r.resources as string[])?.includes("secrets"),
        ),
        provider = (resource?.providers as ObjectValue[])?.find(
          (p) => p.secretbox,
        ),
        keys = object(provider?.secretbox).keys as ObjectValue[],
        keyName = String(keys[0]?.name);
      const rendered = await talos([
          "read",
          "/system/secrets/kubernetes/kube-apiserver/encryptionconfig.yaml",
        ]),
        renderedConfig = object(parse(rendered)),
        renderedHash = "sha256:" + digest(rendered);
      if (
        canonical(renderedConfig.resources) !== canonical(encryption.resources)
      )
        return fail("rendered_encryption_configuration_differs");
      const until = Date.now() + 120_000;
      let loaded = false;
      while (Date.now() < until) {
        const metrics = await kube(["get", "--raw", "/metrics"]),
          rows = metrics
            .split("\n")
            .filter((line) =>
              line.startsWith(
                "apiserver_encryption_config_controller_last_config_info{",
              ),
            );
        if (
          rows.some(
            (line) =>
              line.includes(`hash="${renderedHash}"`) &&
              /\}\s+1(?:\.0+)?(?:\s|$)/.test(line),
          )
        ) {
          loaded = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
        signal.throwIfAborted();
      }
      if (!loaded) return fail("loaded_encryption_hash_stale_no_rewrite");
      await rewriteRotationSecrets(
        { key_name: keyName, cursor: progress.current().cursor },
        commands,
      );
      await verifyRotationSecretCiphertexts({
        session,
        newDocuments: next,
        newTalosconfig: input.target_join.talos_admin_config,
        kubectl: "/usr/local/bin/kubectl",
        outputDir: join(directory, "ciphertext"),
        expected_key_name: keyName,
        signal,
      });
    }
    await session.verify();
    const current = progress.current();
    await progress.commit({
      ...current,
      revision: current.revision + 1,
      state: "confirmed",
      target_sha256: expected,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "",
      code = /^[a-z][a-z0-9_]{0,127}$/.test(message)
        ? message
        : "rotation_native_failed",
      current = progress.current();
    await progress
      .commit({ ...current, revision: current.revision + 1, error_code: code })
      .catch(() => undefined);
    throw new BootstrapError(code);
  } finally {
    await session?.close();
    await rm(directory, { recursive: true, force: true });
  }
}
