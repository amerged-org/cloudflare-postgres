// SPDX-License-Identifier: Apache-2.0
import { stringify } from "yaml";
import type {
  FleetPatchInput,
  FleetPatchFacts,
} from "@pgcf/contracts/fleet-patches";
import { BootstrapError, canonical, digest } from "./bootstrap.ts";
import { inspectionResponseBody } from "./inspection-proxy-command.ts";
import {
  machineConfigurationDocuments,
  readMachineConfiguration,
  type HostConfigurationCommands,
} from "./fleet-host-configuration.ts";
import {
  patchObject as object,
  patchObjects as objects,
  patchSingleton as singleton,
  readFleetTalosServices,
} from "./fleet-patch-observations.ts";
const kinds = {
  kubelet: "KubeletConfig",
  apiServer: "KubeAPIServerConfig",
  controllerManager: "KubeControllerManagerConfig",
  scheduler: "KubeSchedulerConfig",
} as const;
type ImageName = keyof typeof kinds;
export function kubernetesConfigurationImages(
  raw: string,
  id: string,
  control: boolean,
) {
  const values = machineConfigurationDocuments(raw, id).values,
    result: Partial<Record<ImageName, string>> = {};
  for (const [name, kind] of Object.entries(kinds) as [ImageName, string][]) {
    const docs = values.filter(
      (doc) => doc.kind === kind && doc.apiVersion === "v1alpha1",
    );
    if (
      docs.length > 1 ||
      ((name === "kubelet" || control) && docs.length !== 1) ||
      (docs.length === 1 && typeof docs[0]!.image !== "string")
    )
      throw new BootstrapError("patch_kubernetes_image_configuration_invalid");
    if (docs[0]) result[name] = String(docs[0].image);
  }
  return { ...result, kubelet: result.kubelet! };
}
export function mergeKubernetesImages(
  raw: string,
  input: FleetPatchInput,
  control: boolean,
) {
  const expected = input.spec.roles[input.role].kubernetes_images;
  if (!expected)
    throw new BootstrapError("patch_kubernetes_image_pins_missing");
  kubernetesConfigurationImages(raw, "v1alpha1", control);
  const values = machineConfigurationDocuments(raw, "v1alpha1").values;
  for (const [name, kind] of Object.entries(kinds) as [ImageName, string][])
    for (const doc of values)
      if (doc.kind === kind && doc.apiVersion === "v1alpha1")
        doc.image = expected[name];
  return values.map((value) => stringify(value)).join("---\n");
}
const repository = (value: string) => {
  const raw = value.split("@")[0]!,
    colon = raw.lastIndexOf(":"),
    slash = raw.lastIndexOf("/");
  return colon > slash ? raw.slice(0, colon) : raw;
};
const digestOf = (value: unknown) =>
  typeof value === "string"
    ? /(?:@sha256:|^sha256:|:\/\/sha256:)([a-f0-9]{64})$/.exec(value)?.[1]
    : undefined;
type ImageObservationCommands = HostConfigurationCommands & {
  kube(args: string[]): Promise<string>;
  request?: typeof fetch;
  signal?: AbortSignal;
};
type RuntimeImageCommands = Pick<
  ImageObservationCommands,
  "request" | "signal"
>;
const runtimeIndexes = new WeakMap<
  typeof fetch,
  Map<string, Promise<Record<string, unknown>>>
>();
/** Reuse inspection's immutable body/header and OCI schema proof for a reported runtime index. */
async function runtimeIndex(
  imageRepository: string,
  sha256: string,
  commands: RuntimeImageCommands,
) {
  const key = `${imageRepository}@sha256:${sha256}`,
    request = commands.request ?? fetch;
  let cache = runtimeIndexes.get(request);
  if (!cache) {
    cache = new Map();
    runtimeIndexes.set(request, cache);
  }
  let pending = cache.get(key);
  if (!pending) {
    pending = (async () => {
      if (
        !/^[a-z0-9][a-z0-9.-]*(?::[0-9]+)?\/[a-z0-9][a-z0-9._/-]*$/.test(
          imageRepository,
        ) ||
        imageRepository
          .split("/")
          .some((part) => !part || part === "." || part === "..")
      )
        throw new BootstrapError("patch_kubernetes_runtime_reference_invalid");
      const separator = imageRepository.indexOf("/"),
        signal = AbortSignal.any([
          ...(commands.signal ? [commands.signal] : []),
          AbortSignal.timeout(15_000),
        ]),
        repositoryName = imageRepository.slice(separator + 1);
      let url = new URL(
          `https://${imageRepository.slice(0, separator)}/v2/${repositoryName}/manifests/sha256:${sha256}`,
        ),
        redirects = 0,
        pullToken: string | undefined;
      const originalHost = url.hostname;
      for (let attempt = 0; attempt < 6; attempt++) {
        signal.throwIfAborted();
        const headers = new Headers({
          accept:
            "application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json",
        });
        const requestedRepository = url.pathname.match(
          /^\/v2\/(.+)\/manifests\/sha256:[a-f0-9]{64}$/,
        )?.[1];
        if (
          pullToken &&
          url.hostname === "ghcr.io" &&
          requestedRepository === repositoryName
        )
          headers.set("authorization", `Bearer ${pullToken}`);
        const response = await request(url.href, {
          redirect: "manual",
          signal,
          headers,
        });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get("location");
          await response.body?.cancel();
          if (!location || ++redirects > 3)
            throw new BootstrapError(
              "patch_kubernetes_runtime_redirect_invalid",
            );
          const next = new URL(location, url);
          if (
            next.protocol !== "https:" ||
            next.username ||
            next.password ||
            next.hash
          )
            throw new BootstrapError(
              "patch_kubernetes_runtime_redirect_invalid",
            );
          url = next;
          continue;
        }
        if (
          response.status === 401 &&
          originalHost === "ghcr.io" &&
          url.hostname === "ghcr.io" &&
          requestedRepository === repositoryName &&
          !pullToken
        ) {
          const challenge = response.headers.get("www-authenticate") ?? "";
          await response.body?.cancel();
          const realm = challenge.match(/\brealm="([^"]+)"/)?.[1],
            service = challenge.match(/\bservice="([^"]+)"/)?.[1],
            scope = challenge.match(/\bscope="([^"]+)"/)?.[1];
          if (
            !/^Bearer /i.test(challenge) ||
            realm !== "https://ghcr.io/token" ||
            service !== "ghcr.io" ||
            scope !== `repository:${repositoryName}:pull`
          )
            throw new BootstrapError(
              "patch_kubernetes_runtime_challenge_invalid",
            );
          const tokenURL = new URL(realm);
          tokenURL.searchParams.set("service", service);
          tokenURL.searchParams.set("scope", scope);
          const tokenResponse = await request(tokenURL.href, {
            redirect: "error",
            signal,
          });
          if (!tokenResponse.ok) {
            await tokenResponse.body?.cancel();
            throw new BootstrapError(
              "patch_kubernetes_runtime_metadata_unavailable",
            );
          }
          const tokenBody = object(
              JSON.parse(
                await inspectionResponseBody(tokenResponse, 64 * 1024, signal),
              ),
            ),
            token = tokenBody.token ?? tokenBody.access_token;
          if (
            typeof token !== "string" ||
            token.length < 1 ||
            token.length > 16_384 ||
            !/^[A-Za-z0-9._~+/=-]+$/.test(token)
          )
            throw new BootstrapError("patch_kubernetes_runtime_token_invalid");
          pullToken = token;
          continue;
        }
        if (!response.ok) {
          await response.body?.cancel();
          throw new BootstrapError(
            "patch_kubernetes_runtime_metadata_unavailable",
          );
        }
        const body = await inspectionResponseBody(response, 512 * 1024, signal);
        if (
          digest(body) !== sha256 ||
          response.headers.get("docker-content-digest") !== `sha256:${sha256}`
        )
          throw new BootstrapError("patch_kubernetes_runtime_digest_mismatch");
        const parsed = object(JSON.parse(body));
        if (
          parsed.schemaVersion !== 2 ||
          ![
            "application/vnd.oci.image.index.v1+json",
            "application/vnd.docker.distribution.manifest.list.v2+json",
          ].includes(String(parsed.mediaType))
        )
          throw new BootstrapError("patch_kubernetes_runtime_index_invalid");
        objects(parsed.manifests);
        return parsed;
      }
      throw new BootstrapError("patch_kubernetes_runtime_redirect_invalid");
    })();
    if (cache.size >= 32) cache.delete(cache.keys().next().value!);
    cache.set(key, pending);
  }
  try {
    return await pending;
  } catch {
    if (cache.get(key) === pending) cache.delete(key);
    return undefined;
  }
}
/** The caller binds actual Linux/AMD64 Node identity and boot; raw observations remain unchanged. */
export async function normalizeRuntimeImageManifest(
  reference: string,
  expectedSHA: string,
  reportedSHA: string,
  commands: RuntimeImageCommands,
): Promise<string | undefined> {
  if (
    !/^[a-f0-9]{64}$/.test(expectedSHA) ||
    !/^[a-f0-9]{64}$/.test(reportedSHA) ||
    !reference.endsWith(`@sha256:${expectedSHA}`)
  )
    return undefined;
  if (reportedSHA === expectedSHA) return expectedSHA;
  const index = await runtimeIndex(
    repository(reference),
    reportedSHA,
    commands,
  );
  if (!index) return undefined;
  const selected = objects(index.manifests).filter((entry) => {
      const platform = object(entry.platform ?? {});
      return platform.architecture === "amd64" && platform.os === "linux";
    }),
    child = selected[0];
  return selected.length === 1 &&
    child?.digest === `sha256:${expectedSHA}` &&
    Number.isSafeInteger(child.size) &&
    Number(child.size) > 0 &&
    [
      "application/vnd.oci.image.manifest.v1+json",
      "application/vnd.docker.distribution.manifest.v2+json",
    ].includes(String(child.mediaType))
    ? expectedSHA
    : undefined;
}
export async function observeKubernetesImages(
  input: FleetPatchInput,
  control: boolean,
  commands: ImageObservationCommands,
  configuration?: Awaited<ReturnType<typeof readMachineConfiguration>>,
  bootWitness?: Parameters<typeof readMachineConfiguration>[1],
): Promise<NonNullable<FleetPatchFacts["kubernetes_images"]> | undefined> {
  const expected = input.spec.roles[input.role].kubernetes_images;
  if (!expected) return undefined;
  const value =
      configuration ?? (await readMachineConfiguration(commands, bootWitness)),
    active = kubernetesConfigurationImages(value.active, "v1alpha1", control);
  if (value.persistent !== undefined) {
    const persistent = kubernetesConfigurationImages(
      value.persistent,
      "persistent",
      control,
    );
    if (canonical(active) !== canonical(persistent))
      throw new BootstrapError("patch_kubernetes_image_configuration_diverged");
  } else if (
    !bootWitness ||
    value.state_loaded?.boot_id !== bootWitness.boot_id ||
    value.state_loaded?.configuration_boot_id !==
      bootWitness.configuration_boot_id ||
    value.state_loaded?.configuration_sha256 !== value.sha256 ||
    bootWitness.boot_id === bootWitness.configuration_boot_id
  )
    throw new BootstrapError("patch_kubernetes_image_configuration_unproven");
  if (!bootWitness || bootWitness.boot_id === bootWitness.configuration_boot_id)
    return undefined;
  const [statusText, servicesText, podText] = await Promise.all([
    commands.talos(["get", "kubeletstatuses", "kubelet", "--output=json"]),
    commands.talos(["get", "services", "--output=json"]),
    control
      ? commands.kube([
          "get",
          "pods",
          "--namespace",
          "kube-system",
          "--output=json",
        ])
      : Promise.resolve('{"items":[]}'),
  ]);
  const status = singleton(
      statusText,
      "KubeletStatuses.kubernetes.talos.dev",
      "kubelet",
    ),
    service = readFleetTalosServices(servicesText).get("kubelet"),
    result: Partial<NonNullable<FleetPatchFacts["kubernetes_images"]>> = {};
  // Vendor startup resolves this exact pinned reference after the recorded configuration boot boundary.
  // This is boot-backed deployment provenance, not a fresh raw container hash.
  if (
    status.image === active.kubelet &&
    digestOf(status.image) &&
    service?.running === true &&
    service.healthy === true
  )
    result.kubelet = {
      configuration: active.kubelet!,
      runtime_sha256: digestOf(status.image)!,
    };
  if (control) {
    const pods = objects(object(JSON.parse(podText)).items),
      components = {
        apiServer: "kube-apiserver",
        controllerManager: "kube-controller-manager",
        scheduler: "kube-scheduler",
      } as const;
    let node: Promise<Record<string, unknown>> | undefined;
    for (const [name, component] of Object.entries(components) as [
      Exclude<ImageName, "kubelet">,
      string,
    ][]) {
      const selected = pods.filter(
        (pod) =>
          object(pod.spec).nodeName === input.k8s_node_name &&
          object(object(pod.metadata).labels).component === component &&
          !object(pod.metadata).deletionTimestamp &&
          !["Succeeded", "Failed"].includes(String(object(pod.status).phase)),
      );
      if (selected.length !== 1) continue;
      const pod = selected[0]!,
        owners = objects(object(pod.metadata).ownerReferences),
        containers = objects(object(pod.spec).containers),
        statuses = objects(object(pod.status).containerStatuses);
      if (
        !owners.some(
          (owner) =>
            owner.kind === "Node" && owner.uid === input.status.node_uid,
        ) ||
        containers.length !== 1 ||
        statuses.length !== 1
      )
        continue;
      const status = statuses[0]!,
        container = containers[0]!,
        sha = digestOf(status.imageID);
      if (
        typeof container.image === "string" &&
        repository(container.image) === repository(active[name]!) &&
        digestOf(container.image) === digestOf(active[name]) &&
        status.name === container.name &&
        status.ready === true &&
        object(object(status.state).running).startedAt &&
        sha
      ) {
        let observed = sha;
        if (sha !== digestOf(expected[name])) {
          node ??= commands
            .kube(["get", "node", input.k8s_node_name, "--output=json"])
            .then((text) => object(JSON.parse(text)));
          const actual = await node,
            metadata = object(actual.metadata),
            info = object(object(actual.status).nodeInfo);
          if (
            metadata.uid !== input.status.node_uid ||
            metadata.name !== input.k8s_node_name ||
            metadata.deletionTimestamp ||
            info.bootID !== bootWitness.boot_id
          )
            throw new BootstrapError(
              "patch_kubernetes_image_node_identity_changed",
            );
          if (info.architecture !== "amd64" || info.operatingSystem !== "linux")
            continue;
          const normalized = await normalizeRuntimeImageManifest(
            expected[name]!,
            digestOf(expected[name])!,
            sha,
            commands,
          );
          if (!normalized) continue;
          observed = normalized;
        }
        result[name] = {
          configuration: active[name]!,
          runtime_sha256: observed,
        };
      }
    }
  }
  return result.kubelet
    ? (result as NonNullable<FleetPatchFacts["kubernetes_images"]>)
    : undefined;
}
export async function applyKubernetesImages(
  input: FleetPatchInput,
  control: boolean,
  commands: HostConfigurationCommands,
  expected: Awaited<ReturnType<typeof readMachineConfiguration>>,
) {
  const latest = await readMachineConfiguration(
    commands,
    expected.state_loaded,
  );
  if (latest.sha256 !== expected.sha256)
    throw new BootstrapError(
      "patch_kubernetes_configuration_changed_before_write",
    );
  const merged = mergeKubernetesImages(latest.active, input, control);
  await commands
    .talos(["apply-config", "--mode=no-reboot", "--file=-"], merged)
    .catch(() => undefined);
}
