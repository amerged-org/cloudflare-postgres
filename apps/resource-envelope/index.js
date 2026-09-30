// SPDX-License-Identifier: Apache-2.0

/** @param {unknown} value @param {number} maximum */
function positive(value, maximum) {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= maximum
  );
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function object(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @param {number} milli */
export function cpuQuantity(milli) {
  if (!positive(milli, Number.MAX_SAFE_INTEGER))
    throw new RangeError("invalid_resource_quantity");
  if (milli % 1000 !== 0) return `${milli}m`;
  let value = milli / 1000;
  let unit = 0;
  const units = ["", "k", "M"];
  while (value % 1000 === 0 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${value}${units[unit]}`;
}

/** @param {number} mebibytes */
export function binaryQuantity(mebibytes) {
  if (!positive(mebibytes, Number.MAX_SAFE_INTEGER))
    throw new RangeError("invalid_resource_quantity");
  let value = mebibytes;
  let unit = 0;
  const units = ["Mi", "Gi", "Ti", "Pi"];
  while (value % 1024 === 0 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value}${units[unit]}`;
}

export const BARMAN_COMPUTE = Object.freeze({
  requests: Object.freeze({ cpuMilli: 25, memoryMiB: 64 }),
  limits: Object.freeze({ cpuMilli: 100, memoryMiB: 128 }),
});

export const BARMAN_RESOURCES = Object.freeze({
  requests: Object.freeze({
    cpu: cpuQuantity(BARMAN_COMPUTE.requests.cpuMilli),
    memory: binaryQuantity(BARMAN_COMPUTE.requests.memoryMiB),
  }),
  limits: Object.freeze({
    cpu: cpuQuantity(BARMAN_COMPUTE.limits.cpuMilli),
    memory: binaryQuantity(BARMAN_COMPUTE.limits.memoryMiB),
  }),
});

/** @param {unknown} value */
function validCompute(value) {
  return (
    object(value) &&
    positive(value.cpuMilli, 1_000_000) &&
    positive(value.memoryMiB, 1_048_576)
  );
}

/**
 * Preserve the current namespace ceiling, including one CNPG maintenance slot.
 * This is reservation policy, not observed allocation or spare fleet capacity.
 * @param {import("./index.d.ts").ResourceEnvelopeInput} input
 * @returns {import("./index.d.ts").ProvisioningResourceEnvelope}
 */
export function provisioningResourceEnvelope(input) {
  if (
    !object(input) ||
    !positive(input.instances, 32) ||
    !validCompute(input.compute) ||
    !positive(input.volumeGiB, 1_048_576) ||
    (input.pooling !== undefined &&
      (!object(input.pooling) ||
        !object(input.pooling.compute) ||
        !validCompute(input.pooling.compute.requests) ||
        !validCompute(input.pooling.compute.limits) ||
        input.pooling.compute.requests.cpuMilli >
          input.pooling.compute.limits.cpuMilli ||
        input.pooling.compute.requests.memoryMiB >
          input.pooling.compute.limits.memoryMiB))
  )
    throw new RangeError("invalid_resource_envelope");

  const instanceSlots = input.instances + 1;
  const pool = input.pooling?.compute;
  const cpuRequest =
    instanceSlots *
      (input.compute.cpuMilli + BARMAN_COMPUTE.requests.cpuMilli) +
    (pool?.requests.cpuMilli ?? 0);
  const cpuLimit =
    instanceSlots * (input.compute.cpuMilli + BARMAN_COMPUTE.limits.cpuMilli) +
    (pool?.limits.cpuMilli ?? 0);
  const memoryRequest =
    instanceSlots *
      (input.compute.memoryMiB + BARMAN_COMPUTE.requests.memoryMiB) +
    (pool?.requests.memoryMiB ?? 0);
  const memoryLimit =
    instanceSlots *
      (input.compute.memoryMiB + BARMAN_COMPUTE.limits.memoryMiB) +
    (pool?.limits.memoryMiB ?? 0);
  const storageMiB = instanceSlots * input.volumeGiB * 1024;
  return {
    version: 1,
    instanceSlots,
    quotaHard: {
      "requests.cpu": cpuQuantity(cpuRequest),
      "limits.cpu": cpuQuantity(cpuLimit),
      "requests.memory": binaryQuantity(memoryRequest),
      "limits.memory": binaryQuantity(memoryLimit),
      "requests.storage": binaryQuantity(storageMiB),
      persistentvolumeclaims: String(instanceSlots),
      pods: String(instanceSlots + (input.pooling ? 1 : 0)),
    },
    rates: {
      cpu_millicore_ms: BigInt(cpuRequest).toString(),
      memory_byte_ms: (BigInt(memoryRequest) * 1_048_576n).toString(),
      data_storage_byte_ms: (BigInt(storageMiB) * 1_048_576n).toString(),
    },
  };
}

/**
 * Derive exact integer units from trusted resource inputs, never caller rates.
 * Backup, WAL and transfer dimensions require separate, proven envelopes.
 * @param {import("./index.d.ts").ResourceEnvelopeInput} input
 * @param {number} leaseSeconds
 * @returns {import("./index.d.ts").ProvisioningUnits}
 */
export function provisioningAllowanceUnits(input, leaseSeconds) {
  if (!positive(leaseSeconds, 300) || leaseSeconds < 30)
    throw new RangeError("invalid_funding_horizon");
  const { rates } = provisioningResourceEnvelope(input);
  const milliseconds = BigInt(leaseSeconds) * 1000n;
  return {
    cpu_millicore_ms: (
      BigInt(rates.cpu_millicore_ms) * milliseconds
    ).toString(),
    memory_byte_ms: (BigInt(rates.memory_byte_ms) * milliseconds).toString(),
    data_storage_byte_ms: (
      BigInt(rates.data_storage_byte_ms) * milliseconds
    ).toString(),
  };
}
