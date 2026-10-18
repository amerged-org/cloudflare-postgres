// SPDX-License-Identifier: Apache-2.0

/**
 * The requests of the Barman Cloud sidecar of the Kubernetes runtime. Placement and admission no
 * longer charge them; only the `reserved_*` figures of a woke or resized snapshot still add them,
 * and they go with those usage metrics.
 */
export const SIDECAR = {
  requestCpuMillicores: 100,
  requestMemoryMib: 128,
} as const;
