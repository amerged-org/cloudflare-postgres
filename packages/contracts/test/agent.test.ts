// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DesiredDatabase,
  DesiredSize,
  DesiredResponse,
  ObservationRequest,
  ServerLinkMessage,
  AgentLinkMessage,
  archiveDestinationPath,
  newDatabaseId,
  newOperationId,
  newNodeId,
  newRolePassword,
  OWNER_ROLE_NAME,
  NodeObservation,
  MAINTENANCE_ROLE,
} from "../src/index.ts";

const id = newDatabaseId();
const opId = newOperationId();
const backupEndpoint = new URL(
  "/",
  `https://${["r2", "example", "com"].join(".")}`,
).origin;

it("validates separate scheduling CPU without changing legacy desired sizes", () => {
  const size = desired().size as Record<string, unknown>;
  expect(DesiredSize.parse(size)).toEqual(size);
  expect(
    DesiredSize.parse({
      ...size,
      cpu_millicores: 250,
      cpu_request_millicores: 25,
    }).cpu_request_millicores,
  ).toBe(25);
  for (const request of [0, -1, 0.5, 251]) {
    expect(
      DesiredSize.safeParse({
        ...size,
        cpu_millicores: 250,
        cpu_request_millicores: request,
      }).success,
    ).toBe(false);
  }
});

function desired(): Record<string, unknown> {
  return {
    id,
    generation: 1,
    desired_state: "running",
    node: "talos-lab-1",
    pg_major: 18,
    size: {
      memory_mib: 512,
      cpu_millicores: 500,
      storage_gib: 10,
      max_connections: 100,
      archive_timeout_seconds: 60,
      backup_retention_days: 7,
    },
    roles: [
      { name: "app", owner: true, password: newRolePassword(), revision: 1 },
    ],
    archive: {
      destination_path: archiveDestinationPath(
        "pgcf-backups",
        "eu-1",
        id,
        1,
        opId,
      ),
      server_name: "database",
    },
  };
}

function observation(): Record<string, unknown> {
  return {
    observed_at: "2026-10-02T10:46:00.000Z",
    nodes: [
      {
        name: "talos-lab-1",
        ready: true,
        allocatable_memory_mib: 7600,
        allocatable_cpu_millicores: 3900,
        storage_gib_total: 96,
        platform_reserved_memory_mib: 1500,
      },
    ],
    databases: [
      {
        id,
        generation: 1,
        state: "ready",
        archive: { continuous: true, ready_wal_files: 0 },
      },
    ],
    orphans: [],
  };
}

it("explicit actual-RAM scheduling binds startup requests and rejects oversized running classes without changing legacy pages", () => {
  const database = desired();
  const region = {
    id: "eu-1",
    backup: {
      bucket: "pgcf-backups",
      endpoint_url: backupEndpoint,
      region: "auto",
    },
  };
  const body = { region, databases: [database], next: null };
  expect(DesiredResponse.safeParse(body).success).toBe(true);
  expect(
    DesiredResponse.safeParse({
      ...body,
      databases: [
        {
          ...database,
          size: { ...(database.size as object), memory_mib: 300 },
        },
      ],
    }).success,
  ).toBe(true);
  const scheduled = {
    ...body,
    region: {
      ...region,
      scheduling: {
        placement_mode: "actual_ram",
        maximum_database_memory_mib: 4096,
        postgres_memory_request_mib: 256,
      },
    },
    databases: [
      {
        ...database,
        size: { ...(database.size as object), memory_request_mib: 256 },
      },
    ],
  };
  expect(DesiredResponse.safeParse(scheduled).success).toBe(true);
  expect(
    DesiredResponse.safeParse({
      ...scheduled,
      databases: [
        {
          ...database,
          size: {
            ...(database.size as object),
            memory_mib: 300,
            memory_request_mib: 256,
          },
        },
      ],
    }).success,
  ).toBe(false);
  expect(
    DesiredResponse.safeParse({
      ...scheduled,
      region: {
        ...region,
        scheduling: {
          placement_mode: "actual_ram",
          maximum_database_memory_mib: 4096,
        },
      },
    }).success,
  ).toBe(false);
  expect(
    DesiredResponse.safeParse({ ...body, databases: scheduled.databases })
      .success,
  ).toBe(false);
  expect(
    DesiredResponse.safeParse({
      ...scheduled,
      databases: [
        {
          ...database,
          size: { ...(database.size as object), memory_request_mib: 128 },
        },
      ],
    }).success,
  ).toBe(false);
  const oversized = {
    ...database,
    size: {
      ...(database.size as object),
      memory_mib: 4352,
      memory_request_mib: 256,
    },
  };
  expect(
    DesiredResponse.safeParse({ ...scheduled, databases: [oversized] }).success,
  ).toBe(false);
  expect(
    DesiredResponse.safeParse({
      ...scheduled,
      databases: [{ ...oversized, desired_state: "deleted", roles: [] }],
    }).success,
  ).toBe(true);
  expect(
    DesiredResponse.safeParse({
      ...scheduled,
      region: {
        ...region,
        scheduling: {
          placement_mode: "actual_ram",
          maximum_database_memory_mib: 4096,
          postgres_memory_request_mib: 128,
        },
      },
      databases: [{ ...oversized, desired_state: "deleted", roles: [] }],
    }).success,
  ).toBe(true);
  expect(
    DesiredResponse.safeParse({
      ...scheduled,
      databases: [
        {
          ...oversized,
          desired_state: "suspended",
          power: {
            operation: opId,
            revision: 1,
            mode: "quiesce",
            reason: "manual",
          },
          size: { ...(database.size as object), memory_mib: 4352 },
        },
      ],
    }).success,
  ).toBe(true);
  expect(
    DesiredResponse.safeParse({
      ...scheduled,
      databases: [
        {
          ...database,
          size: { ...(database.size as object), memory_request_mib: 768 },
        },
      ],
    }).success,
  ).toBe(false);
});

it("keeps maintenance separate and optional on desired pages", () => {
  const old = desired();
  expect(DesiredDatabase.parse(old).maintenance).toBeUndefined();
  const maintenance = {
    role: MAINTENANCE_ROLE,
    password: newRolePassword(),
    revision: 1,
  };
  expect(DesiredDatabase.parse({ ...old, maintenance }).maintenance).toEqual(
    maintenance,
  );
  expect(
    DesiredDatabase.safeParse({
      ...old,
      roles: [
        ...(old.roles as unknown[]),
        {
          name: MAINTENANCE_ROLE,
          password: maintenance.password,
          revision: 1,
          owner: false,
        },
      ],
    }).success,
  ).toBe(false);
});

describe("node observation identity", () => {
  it("accepts the actual node, provider and Kubernetes identity without changing legacy pages", () => {
    const old = (observation().nodes as Record<string, unknown>[])[0]!;
    expect(NodeObservation.parse(old)).toEqual(old);
    const identity = {
      node_id: newNodeId(),
      provider_instance_id: String(BigInt(Number.MAX_SAFE_INTEGER) + 2n),
      node_uid: randomUUID(),
    };
    const identified = { ...old, ...identity };
    expect(NodeObservation.parse(identified)).toEqual(identified);
    expect(
      ObservationRequest.parse({ ...observation(), nodes: [identified] }).nodes,
    ).toEqual([identified]);
  });

  it("refuses malformed identity and imprecise numeric provider IDs", () => {
    const node = (observation().nodes as Record<string, unknown>[])[0]!;
    expect(
      NodeObservation.safeParse({ ...node, node_id: "invalid" }).success,
    ).toBe(false);
    expect(
      NodeObservation.safeParse({ ...node, node_uid: "invalid" }).success,
    ).toBe(false);
    expect(
      NodeObservation.safeParse({
        ...node,
        provider_instance_id: Number.MAX_SAFE_INTEGER + 2,
      }).success,
    ).toBe(false);
    expect(
      NodeObservation.safeParse({ ...node, provider_instance_id: "01" })
        .success,
    ).toBe(false);
    expect(
      NodeObservation.safeParse({ ...node, provider_instance_id: "invalid" })
        .success,
    ).toBe(false);
    expect(
      NodeObservation.safeParse({
        ...node,
        provider_instance_id: String(2n ** 64n),
      }).success,
    ).toBe(false);
    expect(NodeObservation.safeParse({ ...node, extra: true }).success).toBe(
      false,
    );
  });
});

describe("platform CPU observation compatibility", () => {
  it("keeps absent measurements unknown while accepting measured zero and null", () => {
    const node = (observation().nodes as Record<string, unknown>[])[0]!;
    expect(
      NodeObservation.parse(node).platform_reserved_cpu_millicores,
    ).toBeUndefined();
    expect(
      NodeObservation.parse({ ...node, platform_reserved_cpu_millicores: null })
        .platform_reserved_cpu_millicores,
    ).toBeNull();
    expect(
      NodeObservation.parse({ ...node, platform_reserved_cpu_millicores: 0 })
        .platform_reserved_cpu_millicores,
    ).toBe(0);
    expect(
      NodeObservation.safeParse({
        ...node,
        platform_reserved_cpu_millicores: -1,
      }).success,
    ).toBe(false);
    expect(
      NodeObservation.safeParse({
        ...node,
        platform_reserved_cpu_millicores: 0.5,
      }).success,
    ).toBe(false);
  });
});

describe("archive path", () => {
  it("builds s3://<bucket>/<region>/<id>/g<generation>-<operation>", () => {
    expect(archiveDestinationPath("pgcf-backups", "eu-1", id, 3, opId)).toBe(
      `s3://pgcf-backups/eu-1/${id}/g3-${opId}`,
    );
  });

  it("rejects bad parts", () => {
    expect(() =>
      archiveDestinationPath("Bad_Bucket", "eu-1", id, 1, opId),
    ).toThrow();
    expect(() =>
      archiveDestinationPath("pgcf-backups", "eu/1", id, 1, opId),
    ).toThrow();
    expect(() =>
      archiveDestinationPath("pgcf-backups", "eu-1", "../x", 1, opId),
    ).toThrow();
    expect(() =>
      archiveDestinationPath("pgcf-backups", "eu-1", id, 0, opId),
    ).toThrow();
    expect(() =>
      archiveDestinationPath("pgcf-backups", "eu-1", id, 1.5, opId),
    ).toThrow();
    expect(() =>
      archiveDestinationPath("pgcf-backups", "eu-1", id, 1, "op_x"),
    ).toThrow();
  });
});

describe("DesiredDatabase", () => {
  it("accepts a complete database", () => {
    expect(DesiredDatabase.safeParse(desired()).success).toBe(true);
    expect(
      DesiredDatabase.safeParse({ ...desired(), desired_state: "deleted" })
        .success,
    ).toBe(true);
  });

  it("rejects a missing field, a wrong enum and an extra field", () => {
    const missing = desired();
    delete missing.archive;
    expect(DesiredDatabase.safeParse(missing).success).toBe(false);
    expect(
      DesiredDatabase.safeParse({ ...desired(), desired_state: "suspended" })
        .success,
    ).toBe(false);
    expect(
      DesiredDatabase.safeParse({ ...desired(), pg_major: 17 }).success,
    ).toBe(false);
    expect(
      DesiredDatabase.safeParse({ ...desired(), extra: true }).success,
    ).toBe(false);
    const size = { ...(desired().size as object), extra: 1 };
    expect(DesiredDatabase.safeParse({ ...desired(), size }).success).toBe(
      false,
    );
  });

  it("rejects reserved roles, duplicate roles and two owners", () => {
    const password = newRolePassword();
    const role = (name: string, owner = false) => ({
      name,
      owner,
      password,
      revision: 1,
    });
    expect(
      DesiredDatabase.safeParse({ ...desired(), roles: [role("postgres")] })
        .success,
    ).toBe(false);
    expect(
      DesiredDatabase.safeParse({
        ...desired(),
        roles: [role("reader"), role("reader")],
      }).success,
    ).toBe(false);
    expect(
      DesiredDatabase.safeParse({
        ...desired(),
        roles: [role("app", true), role("other", true)],
      }).success,
    ).toBe(false);
  });

  it("requires exactly one app owner for running databases", () => {
    const role = (name: string, owner: boolean) => ({
      name,
      owner,
      password: newRolePassword(),
      revision: 1,
    });
    expect(DesiredDatabase.safeParse({ ...desired(), roles: [] }).success).toBe(
      false,
    );
    expect(
      DesiredDatabase.safeParse({
        ...desired(),
        roles: [role(OWNER_ROLE_NAME, false)],
      }).success,
    ).toBe(false);
    expect(
      DesiredDatabase.safeParse({ ...desired(), roles: [role("other", true)] })
        .success,
    ).toBe(false);
    expect(
      DesiredDatabase.safeParse({
        ...desired(),
        roles: [role(OWNER_ROLE_NAME, true), role("reader", false)],
      }).success,
    ).toBe(true);
    expect(
      DesiredDatabase.safeParse({
        ...desired(),
        desired_state: "deleted",
        roles: [],
      }).success,
    ).toBe(true);
    const tombstone: Record<string, unknown> = {
      ...desired(),
      desired_state: "deleted",
    };
    delete tombstone.roles;
    expect(DesiredDatabase.safeParse(tombstone).success).toBe(true);
  });

  it("accepts an unchanged archive after a role update", () => {
    expect(
      DesiredDatabase.safeParse({ ...desired(), generation: 2 }).success,
    ).toBe(true);
  });

  it("accepts original creation history independently of the desired revision", () => {
    const creation = {
      operation_id: opId,
      generation: 1,
      status: "running",
      ever_ready: false,
    };
    const parsed = DesiredDatabase.parse({
      ...desired(),
      generation: 3,
      creation,
    });
    expect(parsed.creation).toEqual(creation);
    expect(
      DesiredDatabase.parse({ ...desired(), creation: null }).creation,
    ).toBeNull();
    expect(DesiredDatabase.parse(desired()).creation).toBeUndefined();
  });

  it("binds creation history to the archive operation and an existing revision", () => {
    const creation = {
      operation_id: opId,
      generation: 1,
      status: "pending",
      ever_ready: false,
    };
    expect(
      DesiredDatabase.safeParse({
        ...desired(),
        creation: { ...creation, operation_id: newOperationId() },
      }).success,
    ).toBe(false);
    expect(
      DesiredDatabase.safeParse({
        ...desired(),
        creation: { ...creation, generation: 2 },
      }).success,
    ).toBe(false);
  });

  it("requires complete creation history with a valid operation status", () => {
    const creation = {
      operation_id: opId,
      generation: 1,
      status: "failed",
      ever_ready: false,
    };
    expect(DesiredDatabase.safeParse({ ...desired(), creation }).success).toBe(
      true,
    );
    expect(
      DesiredDatabase.safeParse({
        ...desired(),
        creation: { ...creation, status: "succeeded", ever_ready: true },
      }).success,
    ).toBe(true);
    expect(
      DesiredDatabase.safeParse({
        ...desired(),
        creation: { ...creation, status: "ready" },
      }).success,
    ).toBe(false);
    expect(
      DesiredDatabase.safeParse({
        ...desired(),
        creation: { ...creation, generation: 0 },
      }).success,
    ).toBe(false);
    expect(
      DesiredDatabase.safeParse({
        ...desired(),
        creation: {
          operation_id: opId,
          generation: 1,
          status: "pending",
        },
      }).success,
    ).toBe(false);
  });

  it("accepts an unchanged archive for a deletion tombstone", () => {
    expect(
      DesiredDatabase.safeParse({
        ...desired(),
        generation: 2,
        desired_state: "deleted",
        roles: [],
      }).success,
    ).toBe(true);
  });

  it("rejects an archive path for another database or future generation", () => {
    const other = archiveDestinationPath(
      "pgcf-backups",
      "eu-1",
      newDatabaseId(),
      1,
      opId,
    );
    expect(
      DesiredDatabase.safeParse({
        ...desired(),
        archive: { destination_path: other, server_name: "database" },
      }).success,
    ).toBe(false);
    expect(
      DesiredDatabase.safeParse({
        ...desired(),
        generation: 2,
        archive: {
          destination_path: archiveDestinationPath(
            "pgcf-backups",
            "eu-1",
            id,
            3,
            opId,
          ),
          server_name: "database",
        },
      }).success,
    ).toBe(false);
  });

  it("fits in a desired response page", () => {
    const response = {
      region: {
        id: "eu-1",
        backup: {
          bucket: "pgcf-backups",
          endpoint_url: backupEndpoint,
          region: "auto",
        },
      },
      databases: [desired()],
      next: null,
    };
    expect(DesiredResponse.safeParse(response).success).toBe(true);
    expect(
      DesiredResponse.safeParse({ ...response, next: "../" }).success,
    ).toBe(false);
    expect(
      DesiredResponse.safeParse({
        ...response,
        region: { ...response.region, id: "us-1" },
      }).success,
    ).toBe(false);
    expect(
      DesiredResponse.safeParse({
        ...response,
        region: {
          ...response.region,
          backup: { ...response.region.backup, bucket: "other-backups" },
        },
      }).success,
    ).toBe(false);
  });
});

describe("ObservationRequest", () => {
  it("accepts truthful explicit archive health while retaining legacy observations", () => {
    const value = observation();
    value.databases = [
      {
        id,
        generation: 1,
        state: "ready",
        archive: {
          continuous: false,
          ready_wal_files: null,
          health: "unknown",
        },
      },
    ];
    expect(ObservationRequest.safeParse(value).success).toBe(true);
    value.databases = [
      {
        id,
        generation: 1,
        state: "ready",
        archive: { continuous: false, ready_wal_files: 4, health: "failing" },
      },
    ];
    expect(ObservationRequest.safeParse(value).success).toBe(true);
    value.databases = [
      {
        id,
        generation: 1,
        state: "ready",
        archive: { continuous: true, ready_wal_files: 0, health: "ok" },
      },
    ];
    expect(ObservationRequest.safeParse(value).success).toBe(true);
    expect(ObservationRequest.safeParse(observation()).success).toBe(true);
    value.databases = [
      {
        id,
        generation: 1,
        state: "ready",
        archive: { continuous: true, ready_wal_files: null, health: "unknown" },
      },
    ];
    expect(ObservationRequest.safeParse(value).success).toBe(false);
    value.databases = [
      {
        id,
        generation: 1,
        state: "ready",
        archive: { continuous: false, ready_wal_files: null, health: "ok" },
      },
    ];
    expect(ObservationRequest.safeParse(value).success).toBe(false);
  });
  it("records unavailable WAL samples as null and rejects invalid counts", () => {
    const value = observation();
    value.databases = [
      {
        id,
        generation: 1,
        state: "provisioning",
        archive: { continuous: false, ready_wal_files: null },
      },
    ];
    expect(ObservationRequest.safeParse(value).success).toBe(true);
    value.databases = [
      {
        id,
        generation: 1,
        state: "ready",
        archive: { continuous: true, ready_wal_files: -1 },
      },
    ];
    expect(ObservationRequest.safeParse(value).success).toBe(false);
    value.databases = [
      {
        id,
        generation: 1,
        state: "ready",
        archive: { continuous: true, ready_wal_files: 1.5 },
      },
    ];
    expect(ObservationRequest.safeParse(value).success).toBe(false);
  });

  it("accepts a full observation", () => {
    expect(ObservationRequest.safeParse(observation()).success).toBe(true);
  });

  it("rejects a missing field, a wrong enum and an extra field", () => {
    const missing = observation();
    delete missing.orphans;
    expect(ObservationRequest.safeParse(missing).success).toBe(false);
    const wrongState = observation();
    wrongState.databases = [
      {
        id,
        generation: 1,
        state: "sleeping",
        archive: { continuous: true, ready_wal_files: 0 },
      },
    ];
    expect(ObservationRequest.safeParse(wrongState).success).toBe(false);
    expect(
      ObservationRequest.safeParse({ ...observation(), extra: 1 }).success,
    ).toBe(false);
    const extraArchive = observation();
    extraArchive.databases = [
      {
        id,
        generation: 1,
        state: "ready",
        archive: { continuous: true, ready_wal_files: 0, lag: 1 },
      },
    ];
    expect(ObservationRequest.safeParse(extraArchive).success).toBe(false);
  });
});

describe("link messages", () => {
  it("parses hello, welcome and desired hints", () => {
    expect(
      AgentLinkMessage.safeParse({
        type: "hello",
        protocol: 1,
        agent_version: "0.0.0",
        instance_id: "agent-1",
      }).success,
    ).toBe(true);
    expect(
      AgentLinkMessage.safeParse({
        type: "hello",
        protocol: 2,
        agent_version: "0",
        instance_id: "a",
      }).success,
    ).toBe(false);
    expect(
      ServerLinkMessage.safeParse({ type: "welcome", protocol: 1 }).success,
    ).toBe(true);
    expect(ServerLinkMessage.safeParse({ type: "desired" }).success).toBe(true);
    expect(
      ServerLinkMessage.safeParse({ type: "desired", ids: [id] }).success,
    ).toBe(true);
    expect(ServerLinkMessage.safeParse({ type: "apply" }).success).toBe(false);
  });
});

it("carries an exact power intent while legacy desired pages stay awake", () => {
  const power = {
    operation: newOperationId(),
    revision: 2,
    mode: "quiesce",
    reason: "idle",
  };
  const value = {
    ...desired(),
    generation: 2,
    desired_state: "suspended",
    power,
  };
  expect(DesiredDatabase.parse(value).power).toEqual(power);
  expect(DesiredDatabase.parse(desired()).power).toBeUndefined();
  expect(
    DesiredDatabase.safeParse({ ...value, power: { ...power, revision: 1 } })
      .success,
  ).toBe(false);
  expect(
    DesiredDatabase.safeParse({
      ...value,
      power: { ...power, mode: "running" },
    }).success,
  ).toBe(false);
});

it("hibernation observations require an exact power identity and cannot claim ready", () => {
  const value = observation();
  const databases = value.databases as Record<string, unknown>[];
  databases[0] = {
    ...databases[0],
    state: "hibernated",
    power: { operation: newOperationId(), revision: 1, state: "hibernated" },
  };
  expect(ObservationRequest.safeParse(value).success).toBe(true);
  expect(
    ObservationRequest.safeParse({
      ...value,
      databases: [{ ...databases[0], power: undefined }],
    }).success,
  ).toBe(false);
  expect(
    ObservationRequest.safeParse({
      ...value,
      databases: [{ ...databases[0], state: "ready" }],
    }).success,
  ).toBe(false);
});
