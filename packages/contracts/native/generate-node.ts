// SPDX-License-Identifier: Apache-2.0
// The node agent, the gateway and the archive clients consume these exact schemas, constants and
// vectors of the node contracts (src/node-link.ts, src/node-local.ts). Check them in CI.
import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import { format } from "prettier";
import * as link from "../src/node-link.ts";
import * as local from "../src/node-local.ts";
import {
  OWNER_ROLE_NAME,
  RESERVED_ROLE_NAMES,
  RESERVED_ROLE_PREFIXES,
} from "../src/ids.ts";
import { MAINTENANCE_ROLE } from "../src/maintenance.ts";
import {
  archiveVectors,
  gatewayChannelVectors,
  nodeRequestVectors,
  nodeSchemas,
  nodeSchemaVectors,
  refusalVectors,
} from "./node-vectors.ts";

const files = {
  "node.generated.json": {
    version: 1,
    schemas: Object.fromEntries(
      Object.entries(nodeSchemas).map(([name, schema]) => [
        name,
        z.toJSONSchema(schema),
      ]),
    ),
    constants: {
      NODE_PROTOCOL_VERSION: link.NODE_PROTOCOL_VERSION,
      NODE_API_PATHS: link.NODE_API_PATHS,
      INSTALLER_PROGRESS_PATH: link.INSTALLER_PROGRESS_PATH,
      NODE_ENROLLMENT_SEED_PATH: link.NODE_ENROLLMENT_SEED_PATH,
      ENROLLMENT_TOKEN_LIFETIME_SECONDS: link.ENROLLMENT_TOKEN_LIFETIME_SECONDS,
      NODE_SAMPLE_INTERVAL_MS: link.NODE_SAMPLE_INTERVAL_MS,
      NODE_VOLUME_REPORT_INTERVAL_MS: link.NODE_VOLUME_REPORT_INTERVAL_MS,
      NODE_STALE_MS: link.NODE_STALE_MS,
      NODE_EVENT_RETRY_SECONDS: link.NODE_EVENT_RETRY_SECONDS,
      NODE_FENCED_PATHS: link.NODE_FENCED_PATHS,
      NODE_FENCED_ERROR: link.NODE_FENCED_ERROR,
      NODE_LINK_MESSAGE_MAX_BYTES: link.NODE_LINK_MESSAGE_MAX_BYTES,
      NODE_DESIRED_PAGE_LIMIT_MAX: link.NODE_DESIRED_PAGE_LIMIT_MAX,
      NODE_REQUEST_TOKEN_PREFIX: link.NODE_REQUEST_TOKEN_PREFIX,
      NODE_REQUEST_SIGNATURE_DOMAIN: link.NODE_REQUEST_SIGNATURE_DOMAIN,
      NODE_REQUEST_MAX_LIFETIME_SECONDS: link.NODE_REQUEST_MAX_LIFETIME_SECONDS,
      NODE_REQUEST_SKEW_SECONDS: link.NODE_REQUEST_SKEW_SECONDS,
      NODE_REQUEST_MAX_LENGTH: link.NODE_REQUEST_MAX_LENGTH,
      ARCHIVE_SERVER_NAME: link.ARCHIVE_SERVER_NAME,
      OWNER_ROLE_NAME,
      MAINTENANCE_ROLE,
      RESERVED_ROLE_NAMES: [...RESERVED_ROLE_NAMES],
      RESERVED_ROLE_PREFIXES,
      ADMISSION_STARTS: link.ADMISSION_STARTS,
      NODE_DATABASE_STATES: link.NODE_DATABASE_STATES,
      NODE_DATABASE_ERRORS: link.NODE_DATABASE_ERRORS,
      INSTALLER_CHECKPOINTS: link.INSTALLER_CHECKPOINTS,
    },
  },
  "node-vectors.generated.json": {
    schemas: nodeSchemaVectors(),
    requests: await nodeRequestVectors(),
  },
  "node-local.generated.json": {
    version: 1,
    constants: {
      AGENT_GATEWAY_SOCKET: local.AGENT_GATEWAY_SOCKET,
      AGENT_CHANNEL_MAX_LINE_BYTES: local.AGENT_CHANNEL_MAX_LINE_BYTES,
      AGENT_CHANNEL_MAX_DATABASES: local.AGENT_CHANNEL_MAX_DATABASES,
      UNIX_SOCKET_PATH_MAX_BYTES: local.UNIX_SOCKET_PATH_MAX_BYTES,
      WAKE_REDELIVER_MS: local.WAKE_REDELIVER_MS,
      WAKE_PHASES: local.WAKE_PHASES,
      WAKE_OUTCOMES: local.WAKE_OUTCOMES,
      WAKE_REASONS: local.WAKE_REASONS,
      WAKE_AGAIN_REASON: local.WAKE_AGAIN_REASON,
      ADMISSION_REFUSALS: local.ADMISSION_REFUSALS,
      ADMISSION_REFUSAL_DETAILS: local.ADMISSION_REFUSAL_DETAILS,
      AGENT_ARCHIVE_SOCKET: local.AGENT_ARCHIVE_SOCKET,
      ARCHIVE_SOCKET_ENVIRONMENT: local.ARCHIVE_SOCKET_ENVIRONMENT,
      ARCHIVE_PROTOCOL: local.ARCHIVE_PROTOCOL,
      ARCHIVE_MAX_LINE_BYTES: local.ARCHIVE_MAX_LINE_BYTES,
      ARCHIVE_AGENT_BOUND_MS: local.ARCHIVE_AGENT_BOUND_MS,
      ARCHIVE_CLIENT_BOUND_MS: local.ARCHIVE_CLIENT_BOUND_MS,
    },
    gateway_channel: gatewayChannelVectors(),
    refusals: refusalVectors(),
    archive: archiveVectors(),
  },
};
for (const [name, data] of Object.entries(files)) {
  const contents = await format(JSON.stringify(data), { parser: "json" }),
    path = new URL(name, import.meta.url);
  if (process.argv.includes("--check")) {
    if ((await readFile(path, "utf8")) !== contents)
      throw new Error(`${name} is stale`);
  } else await writeFile(path, contents);
}
