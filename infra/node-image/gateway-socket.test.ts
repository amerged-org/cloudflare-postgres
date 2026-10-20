// SPDX-License-Identifier: Apache-2.0
// The gateway's listening socket belongs to systemd, so that a release that replaces the gateway
// refuses no connection: the old process drains and exits, and the connections that arrive until
// the new one starts wait in the socket (plan 9.3; the gateway's tests prove the gap).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { readHostFiles } from "./host-files.ts";

const units = new URL("mkosi.extra/usr/lib/systemd/system/", import.meta.url);
const unit = (name: string): string => readFileSync(new URL(name, units), "utf8");

// The values of every `Key=value` line, in file order.
function assignments(text: string, key: string): string[] {
  return text
    .split("\n")
    .filter((line) => line.startsWith(`${key}=`))
    .map((line) => line.slice(key.length + 1));
}

test("the socket listens on the loopback port the Tunnel's ingress names, and nowhere else", () => {
  const socket = unit("pgcf-gateway.socket");
  assert.deepEqual(assignments(socket, "ListenStream"), ["127.0.0.1:8080"]);
  const ingress = readFileSync(new URL("../../apps/api/src/domain/node-tunnel.ts", import.meta.url), "utf8");
  assert.match(ingress, /GATEWAY_SERVICE = "http:\/\/127\.0\.0\.1:8080"/);
  // One socket for the one service: no instance per connection.
  assert.deepEqual(assignments(socket, "Accept"), []);
  assert.deepEqual(assignments(socket, "IPAddressDeny"), ["any"]);
  assert.deepEqual(assignments(socket, "IPAddressAllow"), ["localhost"]);
});

test("the service requires the socket and the socket is started with it, so a release needs no preset", () => {
  const service = unit("pgcf-gateway.service");
  const socket = unit("pgcf-gateway.socket");
  assert.deepEqual(assignments(service, "Requires"), ["pgcf-gateway.socket"]);
  assert.ok(assignments(service, "After").join(" ").split(" ").includes("pgcf-gateway.socket"));
  // The socket waits for the same file as the service: before enrollment neither exists.
  assert.deepEqual(assignments(socket, "ConditionPathExists"), assignments(service, "ConditionPathExists"));
  // Never restarted by itself and never enabled on its own: stopping it stops the gateway.
  assert.doesNotMatch(socket, /^\[Install\]/m);
  // The service's own address policy stays: it still dials nothing but loopback.
  assert.deepEqual(assignments(service, "IPAddressDeny"), ["any"]);
});

test("the socket reaches a running node as a host file that needs only the reload", async () => {
  const { files } = await readHostFiles();
  const apply = new Map(files.map((file) => [file.path, file.apply]));
  assert.equal(apply.get("/usr/lib/systemd/system/pgcf-gateway.socket"), "daemon_reload");
  assert.equal(apply.get("/usr/lib/systemd/system/pgcf-gateway.service"), "restart_unit:pgcf-gateway.service");
});
