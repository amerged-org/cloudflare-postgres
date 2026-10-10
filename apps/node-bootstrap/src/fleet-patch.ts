// SPDX-License-Identifier: Apache-2.0
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FleetPatchCheckpoint,
  FleetPatchFacts,
  FleetPatchInput,
  FleetPatchStatus,
  fleetPatchCheckpointAllowed,
  fleetPatchRuntimeMatches,
  fleetPatchKubernetesImagesMatch,
  fleetPatchHostServiceObserved,
  fleetPatchKubernetesConfigurationMatches,
  fleetPatchWritePreflightAllowed,
  supportedFleetPatchVersion,
  type FleetTalosUpgradeReceipt,
  FLEET_PATCH_STAGES,
  FleetPostgresPatchProgress,
  retainedTalosInstallationMatches,
} from "@pgcf/contracts/fleet-patches";
import { CONFIGURATION_SCHEMA_REVISION } from "@pgcf/contracts";
import { canonicalStorageAuthorityKeys } from "@pgcf/contracts/storage-write-authority";
import { NodeBootstrapTransport } from "@pgcf/contracts/node-bootstrap";
import {
  BootstrapError,
  canonical,
  digest,
  nativeTalosConfig,
  nativeKubeconfig,
  runCommand,
  type CommandRunner,
} from "./bootstrap.ts";
import {
  connectRelayTransport,
  startCapabilityProxy,
} from "./proxy-command.ts";
import { inspectionResponseBody } from "./inspection-proxy-command.ts";
import {
  collectFleetPatchRuntime,
  readFleetTalosExtensions,
  readFleetTalosServices,
  patchObject as object,
  patchSingleton as singleton,
  type ObjectValue,
} from "./fleet-patch-observations.ts";
import {
  talosDeploymentReceipt,
  readTalosLifecycleCompletion,
} from "./talos-upgrade-receipt.ts";
import {
  readFleetPlatformAssets,
  readFleetPlatformState,
  readFleetFluxIdentities,
  fleetPlatformReadback,
  reconcileFleetFlux,
  reconcileFleetPlatformSource,
  reconcileFleetRegional,
  type FleetPlatformAssets,
  type FleetPlatformState,
} from "./fleet-platform-patch.ts";

import { readFleetLegacyStorage } from "./fleet-legacy-storage.ts";
import {
  readHostConfiguration,
  readMachineConfiguration,
  applyHostConfiguration,
} from "./fleet-host-configuration.ts";

import {
  observeKubernetesImages,
  kubernetesConfigurationImages,
  applyKubernetesImages,
} from "./fleet-kubernetes-images.ts";

import {
  readRuntimeAdmission,
  applyRuntimeAdmission,
  type RuntimeAdmissionInput,
} from "./fleet-runtime-admission.ts";

export function validateFleetPatchInput(raw: unknown) {
  const input = FleetPatchInput.parse(raw),
    url = new URL(input.callback.url),
    cluster = new URL(input.cluster_endpoint);
  if (digest(canonical(input.spec)) !== input.status.spec_sha256)
    throw new BootstrapError("patch_release_hash_mismatch");
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !==
      `/internal/v1/fleet-patches/${input.status.operation_id}` ||
    cluster.protocol !== "https:" ||
    cluster.username ||
    cluster.password ||
    cluster.search ||
    cluster.hash ||
    cluster.pathname !== "/" ||
    cluster.port !== "6443"
  )
    throw new BootstrapError("patch_endpoint_invalid");
  if (
    input.storage_authority &&
    (input.storage_authority.sha256 !==
      input.spec.storage_authority_keys_sha256 ||
      digest(canonicalStorageAuthorityKeys(input.storage_authority.keys)) !==
        input.storage_authority.sha256)
  )
    throw new BootstrapError("patch_storage_authority_binding_invalid");
  if (input.spec.storage_authority_keys_sha256 && !input.storage_authority)
    throw new BootstrapError("patch_storage_authority_missing");
  if (
    input.spec.components.some((pin) => pin.name === "native-gateway") &&
    (!input.storage_authority || input.retained_thick_storage === undefined)
  )
    throw new BootstrapError("patch_gateway_storage_authority_missing");
  const host = input.host_configuration;
  if (
    host &&
    (host.status.node_id !== input.status.node_id ||
      host.status.node_uid !== input.status.node_uid ||
      host.status.cluster_uid !== input.status.cluster_uid ||
      host.status.release_id !== input.status.release_id ||
      host.status.revision !== input.status.host_configuration_revision ||
      host.status.sha256 !== input.status.host_configuration_sha256 ||
      digest(canonical(host.files)) !== host.status.sha256)
  )
    throw new BootstrapError("patch_host_configuration_binding_invalid");
  if (
    input.compute_pool &&
    (!host ||
      input.compute_pool.node_id !== input.status.node_id ||
      input.compute_pool.node_uid !== input.status.node_uid ||
      input.compute_pool.region_id !== input.status.region_id ||
      input.compute_pool.policy.profile.release_id !==
        input.status.release_id ||
      digest(canonical(input.compute_pool.policy.profile)) !==
        host.status.profile_sha256)
  )
    throw new BootstrapError("patch_compute_pool_binding_invalid");
  if (input.spec.roles[input.role].host_configuration_required && !host)
    throw new BootstrapError("patch_host_configuration_missing");
  return input;
}
export interface FleetPatchOptions {
  run?: CommandRunner;
  request?: typeof fetch;
  signal?: AbortSignal;
  proxy?: typeof startCapabilityProxy;
}

/** One bounded observed-state turn. Dispatch intent is durably acknowledged before the only write attempt. */
export async function runFleetPatch(
  raw: unknown,
  options: FleetPatchOptions = {},
): Promise<FleetPatchStatus> {
  const input = validateFleetPatchInput(raw),
    request = options.request ?? fetch,
    run = options.run ?? runCommand;
  const abort = new AbortController(),
    signal = AbortSignal.any([
      abort.signal,
      ...(options.signal ? [options.signal] : []),
      AbortSignal.timeout(600_000),
    ]),
    directory = await mkdtemp(join(tmpdir(), "pgcf-patch-"));
  await chmod(directory, 0o700);
  let proxy: Awaited<ReturnType<typeof startCapabilityProxy>> | undefined;
  let current = input.status;
  const call = async (body: unknown) => {
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      response = await request(input.callback.url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${input.callback.bearer}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: bounded,
        redirect: "error",
      });
    if (!response.ok) {
      void response.body?.cancel();
      throw new BootstrapError("patch_authority_refused");
    }
    return JSON.parse(
      await inspectionResponseBody(response, 128 * 1024, bounded),
    ) as unknown;
  };
  try {
    const clusterAddress = new URL(input.cluster_endpoint).hostname;
    proxy = await (options.proxy ?? startCapabilityProxy)(
      (authority) =>
        authority === `${input.address}:50000` ||
        (current.stage === "kubernetes" &&
          authority === `${clusterAddress}:50000`)
          ? "talos_api"
          : authority === `${clusterAddress}:6443`
            ? "kubernetes_api"
            : undefined,
      async (capability, authority) => {
        const target =
          capability === "talos_api" &&
          authority === `${clusterAddress}:50000` &&
          clusterAddress !== input.address
            ? "control"
            : "node";
        const transport = NodeBootstrapTransport.parse(
            await call({ kind: "transport", capability, target }),
          ),
          expected =
            capability === "talos_api"
              ? {
                  ip: target === "control" ? clusterAddress : input.address,
                  port: 50000,
                }
              : { ip: clusterAddress, port: 6443 };
        if (
          transport.expectedTarget.ip !== expected.ip ||
          transport.expectedTarget.port !== expected.port ||
          transport.websocket_url !==
            input.callback.url.replace(/^https:/, "wss:") + "/relay"
        )
          throw new BootstrapError("patch_transport_mismatch");
        return connectRelayTransport(transport, input.callback.bearer, signal);
      },
      signal,
    );
    await writeFile(
      join(directory, "talosconfig"),
      nativeTalosConfig(input.talos_admin_config, input.address, proxy.url),
      {
        mode: 0o600,
      },
    );
    await writeFile(
      join(directory, "kubeconfig"),
      nativeKubeconfig(input.kubeconfig, input.cluster_endpoint, proxy.url),
      {
        mode: 0o600,
      },
    );
    const env = {
      ...process.env,
      HTTPS_PROXY: proxy.url,
      HTTP_PROXY: proxy.url,
      NO_PROXY: "",
    };
    const command = async (
      executable: string,
      args: string[],
      timeout_ms = 30_000,
      stdin?: string,
    ) => {
      signal.throwIfAborted();
      const result = await run({
        executable,
        args,
        timeout_ms,
        signal,
        env,
        ...(stdin === undefined ? {} : { stdin }),
      });
      if (result.exit_code !== 0)
        throw new BootstrapError("patch_command_failed");
      return result.stdout;
    };
    const talosAt = (
      args: string[],
      address: string,
      timeout?: number,
      stdin?: string,
    ) =>
      command(
        "talosctl",
        [
          "--talosconfig",
          join(directory, "talosconfig"),
          "--nodes",
          address,
          "--endpoints",
          address,
          ...args,
        ],
        timeout,
        stdin,
      );
    const talos = (args: string[], timeout?: number, stdin?: string) =>
      talosAt(args, input.address, timeout, stdin);
    const hostCommands = {
      talos: (args: string[], stdin?: string) => talos(args, 30_000, stdin),
    };
    let controlNode: ObjectValue | undefined;
    const kube = (args: string[], stdin?: string) =>
      command(
        "kubectl",
        [
          "--kubeconfig",
          join(directory, "kubeconfig"),
          "--request-timeout=30s",
          ...args,
        ],
        30_000,
        stdin,
      );
    let assets: FleetPlatformAssets | undefined,
      platformState: FleetPlatformState | undefined,
      platformReadback: ReturnType<typeof fleetPlatformReadback> | undefined;
    const authorize = async () => {
      const next = FleetPatchStatus.parse(
        await call({
          kind: "status",
          ...(["runtime_admission", "release_verify"].includes(current.stage) &&
          input.compute_pool
            ? { expected_compute_pool_revision: input.compute_pool.revision }
            : {}),
        }),
      );
      if (
        next.operation_id !== current.operation_id ||
        next.revision !== current.revision ||
        next.node_uid !== current.node_uid ||
        next.cluster_uid !== current.cluster_uid ||
        next.spec_sha256 !== current.spec_sha256
      )
        throw new BootstrapError("patch_input_stale");
    };
    const fresh = async (): Promise<FleetPatchFacts> => {
      const observed = await collectFleetPatchRuntime(input, current, {
        kube,
        talos,
      });
      controlNode = observed.controlNode;
      const facts = observed.facts;
      facts.kubernetes_control_plane =
        object(observed.controlNode.metadata).uid === facts.node_uid;
      const observeImages =
        !!input.spec.roles[input.role].kubernetes_images &&
        (FLEET_PATCH_STAGES as readonly string[]).indexOf(current.stage) >=
          FLEET_PATCH_STAGES.indexOf("kubernetes_images");
      const machineConfiguration =
        input.host_configuration || observeImages
          ? await readMachineConfiguration(hostCommands)
          : undefined;
      if (observeImages) {
        facts.kubernetes_image_configuration = kubernetesConfigurationImages(
          machineConfiguration!.active,
          "v1alpha1",
          facts.kubernetes_control_plane,
        );
        const prior = current.observed,
          retained = input.retained_talos_installation,
          proof = retained?.kubernetes_image_provenance;
        if (fleetPatchKubernetesConfigurationMatches(input, facts)) {
          if (
            prior?.kubernetes_configuration_boot_id &&
            prior.kubernetes_configuration_observed_at &&
            canonical(prior.kubernetes_image_configuration) ===
              canonical(facts.kubernetes_image_configuration)
          ) {
            facts.kubernetes_configuration_boot_id =
              prior.kubernetes_configuration_boot_id;
            facts.kubernetes_configuration_observed_at =
              prior.kubernetes_configuration_observed_at;
          } else if (
            retained &&
            retained.boot_id === facts.boot_id &&
            retainedTalosInstallationMatches(input, facts) &&
            proof?.method === "pinned_configuration_boot" &&
            proof.configuration_boot_id &&
            proof.configuration_observed_at &&
            proof.kubelet_version.replace(/^v/, "") ===
              facts.kubelet_version.replace(/^v/, "") &&
            proof.control_plane === facts.kubernetes_control_plane &&
            Object.entries(proof.images).every(
              ([key, value]) =>
                facts.kubernetes_image_configuration?.[
                  key as keyof typeof facts.kubernetes_image_configuration
                ] === value.configuration,
            )
          ) {
            facts.kubernetes_configuration_boot_id =
              proof.configuration_boot_id;
            facts.kubernetes_configuration_observed_at =
              proof.configuration_observed_at;
          }
        }
        facts.kubernetes_images = await observeKubernetesImages(
          input,
          facts.kubernetes_control_plane,
          { ...hostCommands, kube },
          machineConfiguration,
          facts.kubernetes_configuration_boot_id
            ? {
                boot_id: facts.boot_id,
                configuration_boot_id: facts.kubernetes_configuration_boot_id,
              }
            : undefined,
        );
      }

      if (
        input.retained_thick_storage !== undefined &&
        ((current.stage === "preflight" && !current.baseline) ||
          ["regional", "release_verify"].includes(current.stage))
      ) {
        const bindings = await readFleetLegacyStorage(input, kube),
          bound = new Map(
            current.baseline?.legacy_storage_bindings?.map((binding) => [
              binding.database_id,
              binding,
            ]) ?? [],
          );
        if (current.baseline)
          for (const binding of bindings)
            if (
              canonical(bound.get(binding.database_id)) !== canonical(binding)
            )
              throw new BootstrapError("patch_legacy_storage_baseline_changed");
        facts.legacy_storage_bindings = bindings;
      }

      if (
        input.host_configuration &&
        (current.stage !== "preflight" || current.baseline)
      ) {
        const host = await readHostConfiguration(
          hostCommands,
          input.host_configuration,
          machineConfiguration,
          !!input.spec.thin_storage_qualification,
        );
        if (host.matches)
          facts.host_configuration_sha256 =
            input.host_configuration.status.sha256;
      }
      if (input.spec.platform_source_commit) {
        assets ??= await readFleetPlatformAssets(input, signal, request);
        platformState = await readFleetPlatformState({ kube });
        platformReadback = fleetPlatformReadback(
          input,
          platformState,
          assets,
          facts.legacy_storage_bindings ??
            current.baseline?.legacy_storage_bindings,
        );
        const identities = {
          ...current.observed?.platform_resource_uids,
          ...current.baseline?.platform_resource_uids,
        };
        const fluxKeys = new Set(
          assets.flux.map((value) => {
            const metadata = object(value.metadata);
            return `${value.kind}/${metadata.namespace ?? ""}/${metadata.name}`;
          }),
        );
        const fluxIdentities =
          !current.baseline ||
          ["flux", "release_verify"].includes(current.stage)
            ? await readFleetFluxIdentities(
                assets,
                { kube },
                current.baseline
                  ? {
                      operation_id: current.operation_id,
                      bound_uids: identities,
                    }
                  : undefined,
              )
            : {};
        for (const [key, uid] of Object.entries(platformState.uids))
          if (identities[key] && identities[key] !== uid)
            throw new BootstrapError("patch_platform_identity_changed");
        facts.platform_resource_uids = {
          ...identities,
          ...Object.fromEntries(
            Object.entries(platformState.uids).filter(
              ([key]) =>
                !current.baseline || !fluxKeys.has(key) || identities[key],
            ),
          ),
          ...fluxIdentities,
        };
        const receipt = current.talos_upgrade_receipt,
          postReboot =
            receipt &&
            facts.boot_id !== receipt.pre_reboot_boot_id &&
            fleetPatchRuntimeMatches(input, facts).talos;
        const extensionFacts = [];
        if (input.spec.roles[input.role].talos_extensions.length) {
          const loaded = readFleetTalosExtensions(
            await talos(["get", "extensionstatuses", "--output=json"]),
          );
          const sandboxService = input.spec.roles[
            input.role
          ].talos_extensions.includes("pgcf-sandbox-controller")
            ? readFleetTalosServices(
                await talos(["get", "services", "--output=json"]),
              ).get("ext-pgcf-sandbox-controller")
            : undefined;
          facts.sandbox_service_running =
            !!sandboxService?.running &&
            !!(sandboxService.healthy || sandboxService.unknown);
          if (postReboot)
            for (const name of input.spec.roles[input.role].talos_extensions) {
              const pin = input.spec.components.find(
                (component) => component.name === name,
              )!;
              if (
                loaded.get(name) === pin.version &&
                (name !== "pgcf-sandbox-controller" ||
                  (sandboxService?.running === true &&
                    (sandboxService.healthy || sandboxService.unknown)))
              )
                extensionFacts.push({
                  name,
                  version: pin.version,
                  sha256: pin.sha256,
                });
            }
        }
        facts.release_facts = {
          boot_id: facts.boot_id,
          talos_version: facts.talos_version,
          talos_schematic_sha256: facts.talos_schematic_sha256,
          kubernetes_version: facts.kubernetes_version,
          kubelet_version: facts.kubelet_version,
          kubernetes_control_plane: facts.kubernetes_control_plane,
          ...(facts.kubernetes_images &&
          fleetPatchKubernetesImagesMatch(input, facts)
            ? {
                kubernetes_image_provenance: {
                  method: "pinned_configuration_boot" as const,
                  configuration_boot_id: facts.kubernetes_configuration_boot_id,
                  configuration_observed_at:
                    facts.kubernetes_configuration_observed_at,
                  observed_at: facts.observed_at,
                  kubelet_version: facts.kubelet_version,
                  control_plane: facts.kubernetes_control_plane,
                  images: facts.kubernetes_images,
                },
                ...(facts.kubernetes_control_plane
                  ? {
                      kubernetes_static_images: Object.fromEntries(
                        Object.entries(facts.kubernetes_images)
                          .filter(([name]) => name !== "kubelet")
                          .map(([name, value]) => [name, value.runtime_sha256]),
                      ),
                    }
                  : {}),
              }
            : {}),
          components: [...platformReadback.components, ...extensionFacts],
          ...(platformReadback.platform_ready && platformReadback.regional_ready
            ? { platform_source_commit: input.spec.platform_source_commit }
            : {}),
          ...(platformReadback.components.some(
            (v) =>
              ["regional", "native-controller"].includes(v.name) &&
              v.sha256 ===
                input.spec.components.find((c) => c.name === v.name)?.sha256,
          ) &&
          input.spec.configuration_schema_revision ===
            CONFIGURATION_SCHEMA_REVISION
            ? { configuration_schema_revision: CONFIGURATION_SCHEMA_REVISION }
            : {}),
          ...(postReboot
            ? {
                talos_installer: receipt.installer,
                talos_provenance: {
                  method: "deploymentreceipt" as const,
                  installer: receipt.installer,
                  node_uid: facts.node_uid,
                  cluster_uid: facts.cluster_uid,
                  boot_id: facts.boot_id,
                },
              }
            : {}),
        };
      }
      return facts;
    };
    const checkpoint = async (
      stage: FleetPatchStatus["stage"],
      state: FleetPatchStatus["state"],
      facts: FleetPatchFacts,
      error_code: string | null = null,
      receipt?: FleetTalosUpgradeReceipt,
      postgresProgress?: ReturnType<typeof FleetPostgresPatchProgress.parse>,
    ) => {
      const value = FleetPatchCheckpoint.parse({
        expected_revision: current.revision,
        stage,
        state,
        facts,
        error_code,
        ...(receipt ? { talos_upgrade_receipt: receipt } : {}),
        ...(postgresProgress ? { postgres_progress: postgresProgress } : {}),
      });
      if (!fleetPatchCheckpointAllowed({ ...input, status: current }, value))
        throw new BootstrapError("patch_checkpoint_invalid");
      let raw: unknown;
      try {
        raw = await call({ kind: "checkpoint", ...value });
      } catch {
        raw = await call({ kind: "status" });
      }
      const result = FleetPatchStatus.parse(raw);
      if (
        result.operation_id !== current.operation_id ||
        result.node_uid !== current.node_uid ||
        result.cluster_uid !== current.cluster_uid ||
        result.spec_sha256 !== current.spec_sha256 ||
        result.assignment_revision !== current.assignment_revision ||
        result.revision !== current.revision + 1 ||
        result.stage !== stage ||
        result.state !== state ||
        canonical(result.observed) !== canonical(value.facts) ||
        (receipt &&
          canonical(result.talos_upgrade_receipt) !== canonical(receipt))
      )
        throw new BootstrapError("patch_checkpoint_unconfirmed");
      current = result;
    };
    const latePreflight = async (
      before: FleetPatchFacts,
    ): Promise<FleetPatchFacts | null> => {
      let latest: FleetPatchFacts;
      try {
        latest = await fresh();
      } catch {
        await checkpoint(
          current.stage,
          "pending",
          before,
          "patch_write_not_attempted",
        );
        return null;
      }
      if (
        !fleetPatchWritePreflightAllowed(
          { ...input, status: current },
          before,
          latest,
        )
      ) {
        await checkpoint(
          current.stage,
          "pending",
          latest,
          "patch_write_not_attempted",
        );
        return null;
      }
      return latest;
    };
    // Refresh authority before any target access. A stale input cannot substitute for current CF state.
    const authority = FleetPatchStatus.parse(await call({ kind: "status" }));
    if (
      authority.operation_id !== current.operation_id ||
      authority.revision !== current.revision ||
      authority.spec_sha256 !== current.spec_sha256 ||
      authority.node_uid !== current.node_uid ||
      authority.cluster_uid !== current.cluster_uid
    )
      throw new BootstrapError("patch_input_stale");
    const facts = await fresh(),
      matches = fleetPatchRuntimeMatches(input, facts),
      target = input.spec.roles[input.role];
    if (current.state === "confirmed") {
      if (input.host_configuration_only && current.stage === "host_service") {
        await checkpoint("runtime_admission", "pending", facts);
        return current;
      }
      const index = (FLEET_PATCH_STAGES as readonly string[]).indexOf(
        current.stage,
      );
      if (index >= 0 && index < FLEET_PATCH_STAGES.length - 1)
        await checkpoint(FLEET_PATCH_STAGES[index + 1]!, "pending", facts);
      return current;
    }
    if (current.stage === "preflight") {
      if (!facts.node_ready || !facts.databases_ready)
        throw new BootstrapError("patch_preflight_unhealthy");
      await checkpoint("preflight", "confirmed", facts);
    } else if (current.stage === "host_config") {
      if (
        !target.host_configuration_required ||
        facts.host_configuration_sha256 ===
          input.host_configuration?.status.sha256
      )
        await checkpoint("host_config", "confirmed", facts);
      else if (current.state === "pending") {
        const host = input.host_configuration!;
        const before = await readHostConfiguration(
          hostCommands,
          host,
          undefined,
          !!input.spec.thin_storage_qualification,
        );
        await checkpoint("host_config", "dispatched", facts);
        const latest = await latePreflight(facts);
        if (!latest) return current;
        await authorize();
        try {
          await applyHostConfiguration(hostCommands, host, before);
        } catch {
          await checkpoint(
            "host_config",
            "pending",
            latest,
            "patch_write_not_attempted",
          );
          return current;
        }
        const after = await fresh();
        if (after.host_configuration_sha256 === host.status.sha256)
          await checkpoint("host_config", "confirmed", after);
      }
    } else if (current.stage === "host_service") {
      if (
        !input.host_configuration_only ||
        (facts.sandbox_service_running === true &&
          fleetPatchHostServiceObserved(input))
      )
        await checkpoint("host_service", "confirmed", facts);
    } else if (current.stage === "talos") {
      if (
        current.state === "pending" &&
        retainedTalosInstallationMatches(input, facts)
      )
        await checkpoint(
          "talos",
          "confirmed",
          facts,
          null,
          input.retained_talos_installation!.receipt,
        );
      else if (current.state === "dispatched") {
        const receipt = readTalosLifecycleCompletion(
          await talos(["logs", "machined", "--tail=1024"]),
          { ...input, status: current },
          facts,
        );
        if (receipt)
          await checkpoint("talos", "confirmed", facts, null, receipt);
      } else if (current.state === "pending") {
        if (
          !supportedFleetPatchVersion(facts.talos_version, target.talos_version)
        )
          throw new BootstrapError("patch_talos_compatibility_required");
        await checkpoint("talos", "dispatched", facts);
        // The pre-write read verifies fresh Talos/Kubernetes identity again after the durable CAS.
        const latest = await latePreflight(facts);
        if (!latest) return current;
        let receipt: FleetTalosUpgradeReceipt | null = null;
        try {
          await talos(
            [
              "upgrade",
              "--image",
              target.talos_installer,
              "--no-reboot",
              "--progress=plain",
            ],
            540_000,
          );
          receipt = talosDeploymentReceipt(input, latest, "cli_exit_0");
        } catch {
          receipt = readTalosLifecycleCompletion(
            await talos(["logs", "machined", "--tail=1024"]).catch(() => ""),
            { ...input, status: current },
            latest,
          );
        }
        if (receipt)
          await checkpoint("talos", "confirmed", await fresh(), null, receipt);
      }
    } else if (current.stage === "talos_reboot") {
      if (
        matches.talos &&
        current.talos_upgrade_receipt &&
        facts.boot_id !==
          (target.kubernetes_images
            ? facts.kubernetes_configuration_boot_id
            : current.talos_upgrade_receipt.pre_reboot_boot_id) &&
        fleetPatchKubernetesImagesMatch(input, facts)
      )
        await checkpoint("talos_reboot", "confirmed", facts);
      else if (current.state === "pending") {
        await checkpoint("talos_reboot", "dispatched", facts);
        const latest = await latePreflight(facts);
        if (!latest) return current;
        await talos(
          ["reboot", "--wait=false", "--progress=plain"],
          60_000,
        ).catch(() => undefined);
      }
    } else if (current.stage === "kubernetes") {
      if (
        supportedFleetPatchVersion(facts.talos_version, target.talos_version) &&
        matches.kubernetes
      )
        await checkpoint("kubernetes", "confirmed", facts);
      else if (current.state === "pending") {
        if (
          !supportedFleetPatchVersion(
            facts.talos_version,
            target.talos_version,
          ) ||
          !supportedFleetPatchVersion(
            facts.kubernetes_version,
            target.kubernetes_version,
          ) ||
          !supportedFleetPatchVersion(
            facts.kubelet_version,
            target.kubernetes_version,
          )
        )
          throw new BootstrapError("patch_kubernetes_compatibility_required");
        await checkpoint("kubernetes", "dispatched", facts);
        const latest = await latePreflight(facts);
        if (!latest) return current;
        if (!controlNode)
          throw new BootstrapError("patch_control_identity_changed");
        const controlInfo = object(object(controlNode.status).nodeInfo),
          controlSystem = singleton(
            await talosAt(
              [
                "get",
                "systeminformation",
                "--namespace",
                "hardware",
                "--output",
                "json",
              ],
              clusterAddress,
            ),
            "SystemInformations.hardware.talos.dev",
            "systeminformation",
          ),
          controlBoot = singleton(
            await talosAt(
              ["get", "bootid", "--namespace", "runtime", "--output", "json"],
              clusterAddress,
            ),
            "BootIDs.runtime.talos.dev",
            "boot-id",
          );
        if (
          String(controlInfo.systemUUID).toLowerCase() !==
            String(controlSystem.uuid).toLowerCase() ||
          controlInfo.bootID !== controlBoot.bootID
        )
          throw new BootstrapError("patch_control_identity_changed");
        await talosAt(
          [
            "upgrade-k8s",
            "--from",
            facts.kubernetes_version.replace(/^v/, ""),
            "--to",
            target.kubernetes_version.replace(/^v/, ""),
            "--endpoint",
            input.cluster_endpoint,
            "--manifests-reconcile-timeout=5m",
          ],
          clusterAddress,
          540_000,
        ).catch(() => undefined);
      }
    } else if (current.stage === "kubernetes_images") {
      const configured = (observed: FleetPatchFacts) => ({
        ...observed,
        ...(target.kubernetes_images
          ? {
              kubernetes_configuration_boot_id:
                observed.kubernetes_configuration_boot_id ?? observed.boot_id,
              kubernetes_configuration_observed_at:
                observed.kubernetes_configuration_observed_at ??
                observed.observed_at,
            }
          : {}),
      });
      if (fleetPatchKubernetesConfigurationMatches(input, facts))
        await checkpoint("kubernetes_images", "confirmed", configured(facts));
      else if (current.state === "pending") {
        const before = await readMachineConfiguration(hostCommands);
        await checkpoint("kubernetes_images", "dispatched", facts);
        const latest = await latePreflight(facts);
        if (!latest) return current;
        await authorize();
        try {
          await applyKubernetesImages(
            input,
            facts.kubernetes_control_plane!,
            hostCommands,
            before,
          );
        } catch {
          await checkpoint(
            "kubernetes_images",
            "pending",
            latest,
            "patch_write_not_attempted",
          );
          return current;
        }
        const after = await fresh();
        if (fleetPatchKubernetesConfigurationMatches(input, after))
          await checkpoint("kubernetes_images", "confirmed", configured(after));
      }
    } else if (
      current.stage === "verify" &&
      matches.talos &&
      matches.kubernetes &&
      fleetPatchKubernetesImagesMatch(input, facts) &&
      facts.node_ready &&
      facts.databases_ready
    )
      await checkpoint("runtime_verified", "confirmed", facts);
    else if (["flux", "platform", "regional"].includes(current.stage)) {
      if (
        !assets ||
        !platformState ||
        !platformReadback ||
        !current.baseline?.platform_resource_uids
      )
        throw new BootstrapError("patch_platform_source_missing");
      const stage = current.stage,
        complete =
          stage === "flux"
            ? platformReadback.flux_ready
            : stage === "platform"
              ? platformReadback.platform_ready
              : platformReadback.regional_ready;
      if (complete) await checkpoint(stage, "confirmed", facts);
      else {
        if (current.state === "pending")
          await checkpoint(stage, "dispatched", facts);
        await authorize();
        const commands = { kube, authorize },
          baseline = {
            ...(stage === "flux"
              ? current.observed?.platform_resource_uids
              : facts.platform_resource_uids),
            ...current.baseline.platform_resource_uids,
          };
        if (stage === "flux")
          await reconcileFleetFlux(
            input,
            assets,
            baseline,
            commands,
            async (bindings) => {
              const after = await fresh();
              if (
                Object.entries(bindings).some(
                  ([key, uid]) => after.platform_resource_uids?.[key] !== uid,
                )
              )
                throw new BootstrapError("patch_platform_identity_changed");
              await checkpoint("flux", "dispatched", after);
            },
          );
        else if (stage === "platform")
          await reconcileFleetPlatformSource(
            input,
            platformState,
            assets,
            baseline,
            commands,
          );
        else
          await reconcileFleetRegional(
            input,
            platformState,
            assets,
            baseline,
            commands,
            facts.legacy_storage_bindings,
          );
      }
    } else if (current.stage === "runtime_admission") {
      if (!input.regional_hosts_ready && current.state === "pending") {
        await checkpoint("host_ready", "confirmed", facts);
        return current;
      }
      if (!target.host_configuration_required)
        await checkpoint("runtime_admission", "confirmed", facts);
      else {
        if (!input.compute_pool || !input.compute_pool_observation)
          return current;
        const runtimeInput = {
          ...input,
          compute_pool: input.compute_pool,
          compute_pool_observation: input.compute_pool_observation,
        } as RuntimeAdmissionInput;
        const loaded = facts.release_facts?.components.some(
          (component) =>
            component.name === "pgcf-sandbox-controller" &&
            component.sha256 ===
              input.spec.components.find((pin) => pin.name === component.name)
                ?.sha256,
        );
        if (!loaded) return current;
        const state = await readRuntimeAdmission(
          { kube, authorize },
          runtimeInput,
        );
        if (state.confirmed)
          await checkpoint("runtime_admission", "confirmed", {
            ...facts,
            runtime_admission_sha256: state.profile_sha256,
            runtime_admission_policy_revision: input.compute_pool.revision,
          });
        else {
          if (current.state === "pending")
            await checkpoint("runtime_admission", "dispatched", {
              ...facts,
              runtime_admission_policy_revision: input.compute_pool.revision,
            });
          await authorize();
          await applyRuntimeAdmission({ kube, authorize }, runtimeInput);
        }
      }
    } else if (current.stage === "postgres") {
      if (current.state === "pending")
        await checkpoint("postgres", "dispatched", facts);
      const progress = FleetPostgresPatchProgress.parse(
        await call({ kind: "postgres_rollout" }),
      );
      if (progress.errors.length)
        throw new BootstrapError("patch_postgres_rollout_failed");
      if (progress.pending === 0)
        await checkpoint(
          "postgres",
          "confirmed",
          await fresh(),
          null,
          undefined,
          progress,
        );
    } else if (current.stage === "release_verify") {
      if (
        !platformReadback?.flux_ready ||
        !platformReadback.platform_ready ||
        !platformReadback.regional_ready ||
        !facts.release_facts?.talos_provenance
      )
        throw new BootstrapError("patch_release_unobserved");
      if (target.host_configuration_required) {
        if (!input.compute_pool || !input.compute_pool_observation)
          throw new BootstrapError("patch_runtime_admission_unobserved");
        const state = await readRuntimeAdmission(
          { kube, authorize },
          {
            ...input,
            compute_pool: input.compute_pool,
            compute_pool_observation: input.compute_pool_observation,
          },
        );
        if (!state.confirmed)
          throw new BootstrapError("patch_runtime_admission_unobserved");
        facts.runtime_admission_sha256 = state.profile_sha256;
        facts.runtime_admission_policy_revision = input.compute_pool.revision;
      }
      await checkpoint("complete", "confirmed", facts);
    }
    return current;
  } finally {
    abort.abort();
    await proxy?.close();
    await rm(directory, { recursive: true, force: true });
  }
}
