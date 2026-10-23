// SPDX-License-Identifier: Apache-2.0
/**
 * The closed sets of the documents the node receives (`native/node.generated.json`): the values of
 * every enum and constant of the schemas in `nodeReceives`, by the path of the place that holds
 * them (the paths are explained in `node-schema-walk.ts`; a `|type=wake` variant is a type of order,
 * a `|kind=move` variant a kind of origin or of host file). `node-compat.test.ts` fails when a
 * schema has a value or a variant that is not listed here, or a listed one that is gone, so that a
 * new value is a decision of the author and a line in this file.
 *
 * The order of releases for a new value (a type of order, a kind of origin or host file, an enum
 * value, a message) is the table in the plan, 9.3 "Changing the page", written there once. This
 * list only makes the new value a deliberate line: the node refuses a page with a value outside
 * these sets, and the API deploys before the nodes.
 */
export const NODE_CLOSED_SETS: Record<string, (string | number | boolean)[]> = {
  // Emitted only for an advertised restore_in_place_v1 capability.
  "NodeDesiredPage.databases[].origin|kind=replace.kind": ["replace"],
  "ArchiveCredential.access": ["read_only", "read_write"],
  "NodeDesiredPage.release|0.os.host_files[]|kind=file.kind": ["file"],
  "NodeDesiredPage.release|0.os.host_files[]|kind=symlink-to-dev-null.kind": [
    "symlink-to-dev-null",
  ],
  "NodeDesiredPage.policy.admission.memory_rule": ["measured", "reserved"],
  "NodeDesiredPage.orders[]|type=wake.type": ["wake"],
  "NodeDesiredPage.orders[]|type=move.type": ["move"],
  "NodeDesiredPage.orders[]|type=superseded.type": ["superseded"],
  "NodeDesiredPage.orders[]|type=fence.type": ["fence"],
  "NodeDesiredPage.orders[]|type=maintenance.type": ["maintenance"],
  "NodeDesiredPage.diagnostics[].probe": [
    "boots",
    "failed_units",
    "journal",
    "kernel",
    "listeners",
    "pool",
    "pressure",
    "sockets",
  ],
  "NodeDesiredPage.diagnostics[].boot|0": [0],
  "NodeDesiredPage.diagnostics[].boot|1": [-1],
  "NodeDesiredPage.databases[].desired_state": [
    "deleted",
    "running",
    "suspended",
  ],
  "NodeDesiredPage.databases[].pg_major": [18],
  "NodeDesiredPage.databases[].roles[]|0.bypass_rls": [true],
  "NodeDesiredPage.databases[].roles[]|1.state": ["absent"],
  "NodeDesiredPage.databases[].origin|kind=create.kind": ["create"],
  "NodeDesiredPage.databases[].origin|kind=restore.kind": ["restore"],
  "NodeDesiredPage.databases[].origin|kind=move.kind": ["move"],
  "NodeObservationAnswer.databases[].verdict": ["accept", "conflict", "stale"],
  "NodeFencedResponse.error": ["node_fenced"],
  "ServerLinkMessage|type=welcome.type": ["welcome"],
  "ServerLinkMessage|type=welcome.protocol": [1],
  "ServerLinkMessage|type=desired.type": ["desired"],
};
