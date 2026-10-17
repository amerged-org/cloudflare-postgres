// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  SIDECAR,
  databaseMemoryReservationMib,
  databaseCpuReservationMillicores,
} from "../src/index.ts";

const small = {
  memory_mib: 512,
  cpu_millicores: 500,
  storage_gib: 10,
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
    expect(databaseCpuReservationMillicores(small)).toBe(600);
  });

  it("reserves a separate CPU request plus the sidecar request", () => {
    const size = { ...small, cpu_millicores: 250, cpu_request_millicores: 25 };
    expect(databaseCpuReservationMillicores(size)).toBe(125);
  });
});
