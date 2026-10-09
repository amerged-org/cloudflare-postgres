// SPDX-License-Identifier: Apache-2.0
// Behavioral fixtures are evaluated by the deployed TypeScript implementations.
import { PostgresActivity } from "../../../apps/regional/src/gateway/activity.ts";
import {
  GatewayMeasurements,
  type MeasurementSession,
} from "../../../apps/regional/src/gateway/telemetry.ts";

function frame(tag: string, body = Buffer.alloc(0)): Buffer {
  const bytes = Buffer.alloc(5 + body.length);
  bytes[0] = tag.charCodeAt(0);
  bytes.writeUInt32BE(body.length + 4, 1);
  body.copy(bytes, 5);
  return bytes;
}
interface ActivityInput {
  direction: "frontend" | "backend";
  bytes: Buffer;
  repeat?: number;
}
const backend = (bytes: Buffer): ActivityInput => ({
  direction: "backend",
  bytes,
});
const frontend = (bytes: Buffer, repeat?: number): ActivityInput => ({
  direction: "frontend",
  bytes,
  ...(repeat === undefined ? {} : { repeat }),
});
const ok = frame("R", Buffer.alloc(4));
const ready = (state = "I") => frame("Z", Buffer.from(state));
const query = frame("Q", Buffer.from("SELECT 1\0"));
const authenticated = [backend(ok), backend(ready())];
function activityCase(name: string, input: ActivityInput[]) {
  const state = new PostgresActivity();
  const initial = { authenticated: state.authenticated, busy: state.busy };
  const steps = input.map(({ direction, bytes, repeat }) => {
    for (let i = 0; i < (repeat ?? 1); i++) {
      if (direction === "frontend") state.observeFrontend(bytes);
      else state.observeBackend(bytes);
    }
    return {
      direction,
      hex: bytes.toString("hex"),
      ...(repeat === undefined ? {} : { repeat }),
      expected: { authenticated: state.authenticated, busy: state.busy },
    };
  });
  return { name, initial, steps };
}
export function activityVectors() {
  return [
    activityCase("fragmented authentication and simple query", [
      ...[...ok].map((byte) => backend(Buffer.from([byte]))),
      backend(ready()),
      ...[...query].map((byte) => frontend(Buffer.from([byte]))),
      backend(ready()),
    ]),
    activityCase("pipelining requires one readiness per full request", [
      ...authenticated,
      frontend(Buffer.concat([query, query])),
      backend(ready()),
      backend(ready()),
    ]),
    activityCase(
      "premature readiness cannot acknowledge an incomplete frontend",
      [
        ...authenticated,
        frontend(query.subarray(0, -1)),
        backend(ready()),
        frontend(query.subarray(-1)),
        backend(ready()),
      ],
    ),
    activityCase("extended and copy work retain transaction and error state", [
      ...authenticated,
      frontend(frame("P", Buffer.alloc(4))),
      frontend(frame("S")),
      backend(ready("T")),
      frontend(query),
      backend(ready("E")),
      frontend(query),
      backend(ready()),
      frontend(query),
      backend(frame("G", Buffer.alloc(3))),
      frontend(frame("d", Buffer.alloc(32, 1))),
      frontend(frame("c")),
      backend(ready()),
    ]),
    activityCase("authentication challenge is not authentication success", [
      backend(frame("R", Buffer.from([0, 0, 0, 10]))),
      frontend(frame("p", Buffer.from("response"))),
      backend(ok),
      backend(ready()),
    ]),
    activityCase("duplicate readiness is permanently uncertain", [
      ...authenticated,
      backend(ready()),
      frontend(query),
      backend(ready()),
    ]),
    activityCase("invalid frontend length is permanently busy", [
      ...authenticated,
      frontend(Buffer.from([81, 0, 0, 0, 3])),
      backend(ready()),
    ]),
    activityCase("oversized length is permanently busy", [
      ...authenticated,
      frontend(Buffer.from([81, 128, 0, 0, 0])),
      backend(ready()),
    ]),
    activityCase("ambiguous message type cannot become idle", [
      ...authenticated,
      frontend(frame("F")),
      backend(ready()),
    ]),
    activityCase("malformed ready state cannot become idle", [
      ...authenticated,
      frontend(query),
      backend(ready("x")),
      backend(ready()),
    ]),
    activityCase("partial backend body stays busy", [
      ...authenticated,
      backend(frame("N", Buffer.alloc(8)).subarray(0, 7)),
    ]),
    activityCase("malformed AuthenticationOk and duplicate authentication", [
      backend(frame("R", Buffer.alloc(3))),
      backend(ok),
      backend(ready()),
      backend(ok),
      backend(ready()),
    ]),
    activityCase("invalid Sync body cannot clear uncertainty", [
      ...authenticated,
      frontend(frame("S", Buffer.from([0]))),
      backend(ready()),
    ]),
    activityCase("ready-cycle limit is conservative", [
      ...authenticated,
      frontend(frame("Q"), 65537),
      backend(ready()),
    ]),
  ];
}

type Command =
  | { action: "time"; now: number }
  | { action: "begin"; database: string; id: string }
  | { action: "ingress" | "egress"; id: string; bytes: number }
  | { action: "authenticate" | "activity" | "close"; id: string }
  | { action: "read"; database: string };
const origin = Date.parse("2026-10-08T00:00:00.000Z");
const ids = ["a".repeat(20), "b".repeat(20), "c".repeat(20)];
const begin = (database: string, id: string): Command => ({
  action: "begin",
  database,
  id,
});
const read = (database: string): Command => ({ action: "read", database });
const auth = (id: string): Command => ({ action: "authenticate", id });
const close = (id: string): Command => ({ action: "close", id });
const tick = (elapsed: number): Command => ({
  action: "time",
  now: origin + elapsed,
});
function telemetryCase(name: string, maxRecords: number, commands: Command[]) {
  let now = origin;
  const measurements = new GatewayMeasurements({ maxRecords, now: () => now });
  const sessions = new Map<string, MeasurementSession>();
  const steps = commands.map((command) => {
    switch (command.action) {
      case "time":
        now = command.now;
        break;
      case "begin":
        sessions.set(command.id, measurements.begin(command.database));
        break;
      case "ingress":
        sessions.get(command.id)!.ingress(command.bytes);
        break;
      case "egress":
        sessions.get(command.id)!.egress(command.bytes);
        break;
      case "authenticate":
        sessions.get(command.id)!.authenticate();
        break;
      case "activity":
        sessions.get(command.id)!.clientActivity();
        break;
      case "close":
        sessions.get(command.id)!.close();
        break;
      case "read":
        return {
          ...command,
          expected: Object.fromEntries(
            Object.entries(measurements.read(command.database)).filter(
              ([key]) => !["processEpoch", "epoch", "startedAt"].includes(key),
            ),
          ),
          size: measurements.size,
        };
    }
    return command;
  });
  return { name, maxRecords, initialNow: origin, steps };
}
export function telemetryVectors() {
  const [a, b, c] = ids as [string, string, string];
  return [
    telemetryCase(
      "unauthenticated transport never allocates records or usage",
      2,
      [
        read(a),
        begin(a, "unauth"),
        { action: "ingress", id: "unauth", bytes: 100 },
        { action: "egress", id: "unauth", bytes: 200 },
        { action: "activity", id: "unauth" },
        tick(10000),
        read(a),
        close("unauth"),
        read(a),
      ],
    ),
    telemetryCase(
      "authenticated counters and close are exact and idempotent",
      2,
      [
        begin(a, "one"),
        { action: "ingress", id: "one", bytes: 10 },
        { action: "egress", id: "one", bytes: 20 },
        read(a),
        auth("one"),
        { action: "ingress", id: "one", bytes: 7 },
        { action: "egress", id: "one", bytes: 11 },
        { action: "activity", id: "one" },
        tick(1000),
        read(a),
        read(a),
        auth("one"),
        close("one"),
        close("one"),
        { action: "activity", id: "one" },
        auth("one"),
        tick(2000),
        read(a),
      ],
    ),
    telemetryCase(
      "bounded eviction and recreation never invent complete history",
      2,
      [
        begin(a, "a"),
        auth("a"),
        close("a"),
        begin(b, "b"),
        auth("b"),
        close("b"),
        tick(1000),
        begin(c, "c"),
        auth("c"),
        close("c"),
        read(a),
        read(b),
        read(c),
        begin(a, "a2"),
        auth("a2"),
        close("a2"),
        read(a),
        read(b),
      ],
    ),
    telemetryCase("saturation never evicts active records", 1, [
      begin(a, "a"),
      auth("a"),
      { action: "ingress", id: "a", bytes: 11 },
      begin(b, "b"),
      auth("b"),
      { action: "ingress", id: "b", bytes: 22 },
      read(a),
      read(b),
      close("a"),
      close("b"),
      read(b),
      begin(b, "b2"),
      auth("b2"),
      close("b2"),
      read(b),
    ]),
    telemetryCase(
      "unauthenticated attempts cannot evict or touch authenticated history",
      1,
      [
        begin(a, "a"),
        auth("a"),
        { action: "ingress", id: "a", bytes: 17 },
        close("a"),
        read(a),
        tick(60000),
        begin(b, "unauth"),
        { action: "ingress", id: "unauth", bytes: 100 },
        { action: "activity", id: "unauth" },
        close("unauth"),
        read(a),
      ],
    ),
    telemetryCase("authenticated touch controls eviction but reads do not", 2, [
      begin(a, "a"),
      auth("a"),
      begin(b, "b"),
      auth("b"),
      close("b"),
      tick(1000),
      { action: "activity", id: "a" },
      close("a"),
      read(b),
      begin(c, "c"),
      auth("c"),
      close("c"),
      read(a),
      read(b),
      read(c),
    ]),
    telemetryCase(
      "parallel authenticated lifetime and backward clock are bounded",
      2,
      [
        begin(a, "a1"),
        auth("a1"),
        tick(1000),
        begin(a, "a2"),
        auth("a2"),
        tick(2000),
        read(a),
        close("a1"),
        tick(3000),
        read(a),
        tick(500),
        read(a),
        close("a2"),
        read(a),
      ],
    ),
    telemetryCase("counter overflow is unknown instead of wrapping", 1, [
      begin(a, "a"),
      auth("a"),
      { action: "ingress", id: "a", bytes: Number.MAX_SAFE_INTEGER },
      read(a),
      { action: "ingress", id: "a", bytes: 1 },
      read(a),
      close("a"),
      read(a),
    ]),
    telemetryCase(
      "pre-auth overflow cannot become known on authentication",
      1,
      [
        begin(a, "a"),
        { action: "ingress", id: "a", bytes: Number.MAX_SAFE_INTEGER },
        { action: "ingress", id: "a", bytes: 1 },
        read(a),
        auth("a"),
        read(a),
      ],
    ),
  ];
}
