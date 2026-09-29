// SPDX-License-Identifier: Apache-2.0
import type { RuntimeBinding } from "./allowance-types.ts";
import type { Resource } from "./types.ts";

export const RUN_EPOCH_ANNOTATION = "pgcf.io/run-epoch";
export const RUN_EPOCH_PATCH_PATH = "/metadata/annotations/pgcf.io~1run-epoch";

export function validRunEpoch(value: unknown): value is string {
  return typeof value === "string" && /^[1-9][0-9]{0,18}$/.test(value);
}

// Legacy bindings never acquire a fence from observations. Explicit bindings
// require the same canonical epoch on every required controlled resource.
export function runtimeEpochMatches(
  resources: readonly Resource[],
  binding: Pick<RuntimeBinding, "runEpoch">,
): boolean {
  if (resources.length === 0) return false;
  if (binding.runEpoch === undefined)
    return resources.every(
      (resource) =>
        !resource.metadata.annotations ||
        !Object.hasOwn(resource.metadata.annotations, RUN_EPOCH_ANNOTATION),
    );
  return (
    validRunEpoch(binding.runEpoch) &&
    resources.every(
      (resource) =>
        resource.metadata.annotations !== undefined &&
        Object.hasOwn(resource.metadata.annotations, RUN_EPOCH_ANNOTATION) &&
        resource.metadata.annotations[RUN_EPOCH_ANNOTATION] ===
          binding.runEpoch,
    )
  );
}
