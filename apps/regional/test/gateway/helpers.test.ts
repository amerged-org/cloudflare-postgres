// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createPrivateKey, X509Certificate } from "node:crypto";
import { createConnection } from "node:net";
import { test } from "node:test";
import { newDatabaseId } from "@pgcf/contracts";
import { DatabaseCaCache } from "../../src/gateway/ca.ts";
import {
  createPostgresDial,
  databaseTarget,
} from "../../src/gateway/postgres.ts";
import { certificate, loopback, postgresServer } from "./helpers.ts";

test("generates a matching CA key and hostname that verify during a real TLS handshake", async (t) => {
  const target = databaseTarget(newDatabaseId());
  const credentials = certificate(target.host);
  const issued = new X509Certificate(credentials.cert);
  assert.equal(issued.checkPrivateKey(createPrivateKey(credentials.key)), true);
  assert.equal(issued.ca, true);
  assert.equal(issued.checkHost(target.host), target.host);
  assert.equal(
    issued.checkHost(databaseTarget(newDatabaseId()).host),
    undefined,
  );
  assert.equal(issued.verify(issued.publicKey), true);

  const postgres = await postgresServer(credentials);
  t.after(() => postgres.close());
  const dial = createPostgresDial(
    new DatabaseCaCache(async () => credentials.cert),
    {
      tcpConnect: () =>
        createConnection({ host: loopback, port: postgres.port }),
      timeoutMs: 5_000,
    },
  );
  const socket = await dial(target, AbortSignal.timeout(5_000));
  t.after(() => socket.destroy());
  assert.equal(socket.authorized, true);
  assert.equal(postgres.handshakes(), 1);
});
