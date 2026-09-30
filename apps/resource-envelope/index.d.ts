// SPDX-License-Identifier: Apache-2.0
export interface ComputeResources {
  cpuMilli: number;
  memoryMiB: number;
}
export interface ResourceEnvelopeInput {
  instances: number;
  compute: ComputeResources;
  volumeGiB: number;
  pooling?: {
    compute: {
      requests: ComputeResources;
      limits: ComputeResources;
    };
  };
}
export interface QuotaHard {
  "requests.cpu": string;
  "limits.cpu": string;
  "requests.memory": string;
  "limits.memory": string;
  "requests.storage": string;
  persistentvolumeclaims: string;
  pods: string;
}
export interface ProvisioningUnits {
  cpu_millicore_ms: string;
  memory_byte_ms: string;
  data_storage_byte_ms: string;
}
export interface ProvisioningResourceEnvelope {
  version: 1;
  instanceSlots: number;
  quotaHard: QuotaHard;
  rates: ProvisioningUnits;
}
export const BARMAN_COMPUTE: {
  readonly requests: Readonly<ComputeResources>;
  readonly limits: Readonly<ComputeResources>;
};
export const BARMAN_RESOURCES: {
  readonly requests: {
    readonly cpu: string;
    readonly memory: string;
  };
  readonly limits: {
    readonly cpu: string;
    readonly memory: string;
  };
};
export function cpuQuantity(milli: number): string;
export function binaryQuantity(mebibytes: number): string;
export function provisioningResourceEnvelope(
  input: ResourceEnvelopeInput,
): ProvisioningResourceEnvelope;
export function provisioningAllowanceUnits(
  input: ResourceEnvelopeInput,
  leaseSeconds: number,
): ProvisioningUnits;
