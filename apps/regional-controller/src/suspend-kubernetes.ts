// SPDX-License-Identifier: Apache-2.0
import { CoreV1Api, KubeConfig, Observable } from "@kubernetes/client-node";
import type { ConfigurationOptions } from "@kubernetes/client-node";
import { isAbsolute } from "node:path";
import { allowanceKubernetesFromConfig } from "./allowance-kubernetes.ts";
import { validRuntimeBinding } from "./allowance-journal.ts";
import type { AllowanceRuntime, RuntimeBinding } from "./allowance-types.ts";
import { validSuspendClaim } from "./suspend-types.ts";
import type { SuspendClaim } from "./suspend-types.ts";
import type { Resource } from "./types.ts";
import { RUN_EPOCH_ANNOTATION } from "./run-epoch.ts";

function owned(resource: Resource, claim: SuspendClaim): boolean {
  return (
    !resource.metadata.deletionTimestamp &&
    resource.metadata.labels?.["app.kubernetes.io/managed-by"] ===
      "cloudflare-postgres" &&
    resource.metadata.labels?.["pgcf.io/environment-id"] ===
      claim.environmentId &&
    resource.metadata.labels?.["pgcf.io/region-id"] === claim.regionId &&
    resource.metadata.annotations?.["pgcf.io/spec-hash"] === claim.specHash &&
    (claim.runEpoch === undefined
      ? !Object.hasOwn(
          resource.metadata.annotations ?? {},
          RUN_EPOCH_ANNOTATION,
        )
      : Object.hasOwn(
          resource.metadata.annotations ?? {},
          RUN_EPOCH_ANNOTATION,
        ) &&
        resource.metadata.annotations?.[RUN_EPOCH_ANNOTATION] ===
          claim.runEpoch)
  );
}

export async function suspendKubernetesFromConfig(
  file: string,
  context: string,
  claim: SuspendClaim,
  sealedBinding?: RuntimeBinding,
  authorized: () => void = () => {},
): Promise<AllowanceRuntime> {
  if (!isAbsolute(file) || !context || !validSuspendClaim(claim))
    throw new Error("suspend_kubernetes_configuration_invalid");
  const config = new KubeConfig();
  config.loadFromFile(file);
  if (!config.getContexts().some((value) => value.name === context))
    throw new Error("suspend_kubernetes_context_invalid");
  config.setCurrentContext(context);
  const core = config.makeApiClient(CoreV1Api);
  const options: ConfigurationOptions = {
    middlewareMergeStrategy: "append",
    middleware: [
      {
        pre(request) {
          authorized();
          request.setSignal(AbortSignal.timeout(20_000));
          return new Observable(Promise.resolve(request));
        },
        post(response) {
          return new Observable(Promise.resolve(response));
        },
      },
    ],
  };
  const namespace = `pgcf-${claim.environmentId.replaceAll("-", "")}`;
  const [namespaceResponse, quotaResponse] = await Promise.all([
    core.readNamespace({ name: namespace }, options),
    core.readNamespacedResourceQuota(
      { namespace, name: "database-resources" },
      options,
    ),
  ]);
  const namespaceResource = {
    ...namespaceResponse,
    kind: "Namespace",
    apiVersion: "v1",
  } as unknown as Resource;
  const quotaResource = {
    ...quotaResponse,
    kind: "ResourceQuota",
    apiVersion: "v1",
  } as unknown as Resource;
  if (
    namespaceResource.metadata.name !== namespace ||
    quotaResource.metadata.name !== "database-resources" ||
    quotaResource.metadata.namespace !== namespace ||
    !owned(namespaceResource, claim) ||
    !owned(quotaResource, claim) ||
    !namespaceResource.metadata.uid ||
    !quotaResource.metadata.uid
  )
    throw new Error("suspend_kubernetes_identity_unproven");
  const discovered: RuntimeBinding = {
    regionId: claim.regionId,
    environmentId: claim.environmentId,
    projectId: claim.projectId,
    specRevision: claim.specRevision,
    specHash: claim.specHash,
    namespace,
    namespaceUid: namespaceResource.metadata.uid,
    clusterUid: claim.clusterUid,
    quotaUid: quotaResource.metadata.uid,
    ...(claim.pooler ? { pooler: { ...claim.pooler } } : {}),
    ...(claim.runEpoch === undefined ? {} : { runEpoch: claim.runEpoch }),
  };
  if (!validRuntimeBinding(discovered))
    throw new Error("suspend_kubernetes_identity_unproven");
  if (
    sealedBinding &&
    (!validRuntimeBinding(sealedBinding) ||
      sealedBinding.regionId !== discovered.regionId ||
      sealedBinding.environmentId !== discovered.environmentId ||
      sealedBinding.projectId !== discovered.projectId ||
      sealedBinding.specRevision !== discovered.specRevision ||
      sealedBinding.specHash !== discovered.specHash ||
      sealedBinding.namespace !== discovered.namespace ||
      sealedBinding.namespaceUid !== discovered.namespaceUid ||
      sealedBinding.clusterUid !== discovered.clusterUid ||
      sealedBinding.quotaUid !== discovered.quotaUid ||
      sealedBinding.runEpoch !== discovered.runEpoch ||
      sealedBinding.pooler?.uid !== discovered.pooler?.uid ||
      sealedBinding.pooler?.deploymentUid !== discovered.pooler?.deploymentUid)
  )
    throw new Error("suspend_kubernetes_sealed_identity_changed");
  // Discovery never changes a journal seal. Restart keeps the previously sealed
  // identities; the reconciler independently authorizes and seals inventory.
  return allowanceKubernetesFromConfig(
    file,
    context,
    sealedBinding ?? discovered,
    authorized,
  );
}
