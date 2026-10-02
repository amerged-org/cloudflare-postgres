// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  SIDECAR,
  databaseMemoryReservationMib,
  postgresParameters,
  resourceQuotaFor,
} from "../src/index.ts";

const small = {
  memory_mib: 512,
  cpu_millicores: 500,
  storage_gib: 10,
  max_connections: 100,
  archive_timeout_seconds: 60,
};

describe("sizing", () => {
  it("reserves size plus the sidecar request per database", () => {
    expect(SIDECAR).toEqual({
      requestCpuMillicores: 100,
      requestMemoryMib: 128,
      limitCpuMillicores: 500,
      limitMemoryMib: 512,
    });
    expect(databaseMemoryReservationMib(small)).toBe(640);
  });

  it("sizes the quota for two slots including the sidecar", () => {
    expect(resourceQuotaFor(small)).toEqual({
      requestsCpuMillicores: 2 * (500 + 100),
      limitsCpuMillicores: 2 * (500 + 500),
      requestsMemoryMib: 2 * (512 + 128),
      limitsMemoryMib: 2 * (512 + 512),
      requestsStorageGib: 10,
      persistentVolumeClaims: 1,
      pods: 2,
    });
  });

  it("derives PostgreSQL parameters from the size class", () => {
    expect(postgresParameters(small)).toEqual({
      shared_buffers: "128MB",
      effective_cache_size: "256MB",
      max_connections: "100",
      archive_timeout: "60s",
    });
    expect(
      postgresParameters({ ...small, memory_mib: 2050 }).shared_buffers,
    ).toBe("512MB");
  });
});
