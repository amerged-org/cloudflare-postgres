// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import {
  buildCustodyBridgeSource,
  buildCustodyExporterSource,
  buildCustodyMaintenanceWrapperSource,
  buildCustodyWrapperSource,
  custodyRecipientFingerprint,
  custodyRequestBody,
  CUSTODY_RUNTIME_SOURCE,
  type CustodyExportPolicy,
} from "./custody-export.ts";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const SOURCE = "01234567-89ab-4cde-8fab-0123456789ab";
const EXPORTER = "abcdef01-2345-4678-9abc-def012345678";
const TX = "11111111-2222-4333-8444-555555555555";
const CAPTURED = "nonsecret-fixture-value-that-must-only-be-sealed";
const UNSELECTED = "unselected-fixture-must-never-be-read-or-returned";
const encoder = new TextEncoder();

interface Runtime {
  authorize(request: Request): Promise<boolean>;
  capture(request: Request, env: Record<string, unknown>): Promise<Response>;
  coordinate(
    request: Request,
    dependencies: {
      serial<T>(run: () => Promise<T>): Promise<T>;
      get(): Promise<unknown>;
      put(value: unknown): Promise<void>;
      fetchTarget(request: Request): Promise<Response>;
    },
    version: string,
  ): Promise<Response>;
}

function runtime(policy: CustodyExportPolicy): Runtime {
  // Execute exactly the same JavaScript core embedded into both Worker sources.
  return new Function("policy", `return (${CUSTODY_RUNTIME_SOURCE})(policy);`)(
    policy,
  ) as Runtime;
}

let fixturePromise:
  | Promise<{
      policy: CustodyExportPolicy;
      recipient: webcrypto.CryptoKeyPair;
      operator: webcrypto.CryptoKeyPair;
    }>
  | undefined;
function fixture() {
  fixturePromise ??= (async () => {
    const recipient = (await webcrypto.subtle.generateKey(
      {
        name: "RSA-OAEP",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["encrypt", "decrypt"],
    )) as webcrypto.CryptoKeyPair;
    const operator = (await webcrypto.subtle.generateKey("Ed25519", true, [
      "sign",
      "verify",
    ])) as webcrypto.CryptoKeyPair;
    const recipientPublicJwk = (await webcrypto.subtle.exportKey(
      "jwk",
      recipient.publicKey,
    )) as CustodyExportPolicy["recipientPublicJwk"];
    const operatorPublicJwk = (await webcrypto.subtle.exportKey(
      "jwk",
      operator.publicKey,
    )) as CustodyExportPolicy["operatorPublicJwk"];
    const now = Date.now();
    const policy: CustodyExportPolicy = {
      accountId: ACCOUNT,
      scriptName: "pgcf-api-custody-test",
      environment: "development",
      transactionId: TX,
      sourceVersionId: SOURCE,
      notBefore: now - 1000,
      expiresAt: now + 300_000,
      bindingNames: ["CREDENTIAL_KEYS"],
      recipientPublicJwk,
      operatorPublicJwk,
      recipientFingerprint: custodyRecipientFingerprint(recipientPublicJwk),
    };
    return { policy, recipient, operator };
  })();
  return fixturePromise;
}

async function signedRequest(
  policy: CustodyExportPolicy,
  privateKey: webcrypto.CryptoKey,
  body = custodyRequestBody(policy),
) {
  const signature = await webcrypto.subtle.sign(
    "Ed25519",
    privateKey,
    encoder.encode(body),
  );
  return new Request("https://custody.invalid/custody/export", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-pgcf-custody-signature": Buffer.from(signature).toString("base64url"),
    },
    body,
  });
}

test("sealed export authenticates exact scope, pins recipient and never exposes binding plaintext", async () => {
  const { policy, recipient, operator } = await fixture();
  const core = runtime(policy);
  const env = {
    CREDENTIAL_KEYS: CAPTURED,
    get UNSELECTED() {
      throw new Error(UNSELECTED);
    },
  };
  const response = await core.capture(
    await signedRequest(policy, operator.privateKey),
    env,
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const text = await response.text();
  assert.ok(!text.includes(CAPTURED));
  assert.ok(!text.includes(UNSELECTED));
  const packet = JSON.parse(text) as Record<string, string>;
  assert.equal(packet.recipientFingerprint, policy.recipientFingerprint);
  assert.equal(packet.sourceVersionId, SOURCE);
  const rawKey = await webcrypto.subtle.decrypt(
    "RSA-OAEP",
    recipient.privateKey,
    Uint8Array.from(Buffer.from(packet.wrappedKey!, "base64url")),
  );
  const key = await webcrypto.subtle.importKey(
    "raw",
    rawKey,
    "AES-GCM",
    false,
    ["decrypt"],
  );
  const plaintext = await webcrypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: Uint8Array.from(Buffer.from(packet.nonce!, "base64url")),
      additionalData: Uint8Array.from(Buffer.from(packet.aad!, "base64url")),
      tagLength: 128,
    },
    key,
    Uint8Array.from(Buffer.from(packet.ciphertext!, "base64url")),
  );
  const opened = JSON.parse(new TextDecoder().decode(plaintext)) as {
    bindings: Record<string, string>;
    transactionId: string;
  };
  assert.deepEqual(opened.bindings, { CREDENTIAL_KEYS: CAPTURED });
  assert.equal(opened.transactionId, TX);
  const wrongRecipient = (await webcrypto.subtle.generateKey(
    {
      name: "RSA-OAEP",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["encrypt", "decrypt"],
  )) as webcrypto.CryptoKeyPair;
  await assert.rejects(
    webcrypto.subtle.decrypt(
      "RSA-OAEP",
      wrongRecipient.privateKey,
      Uint8Array.from(Buffer.from(packet.wrappedKey!, "base64url")),
    ),
  );
  const corrupted = Uint8Array.from(
    Buffer.from(packet.ciphertext!, "base64url"),
  );
  corrupted[0] = corrupted[0]! ^ 1;
  await assert.rejects(
    webcrypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: Uint8Array.from(Buffer.from(packet.nonce!, "base64url")),
        additionalData: Uint8Array.from(Buffer.from(packet.aad!, "base64url")),
      },
      key,
      corrupted,
    ),
  );

  const changed = JSON.parse(custodyRequestBody(policy)) as Record<
    string,
    unknown
  >;
  changed.environment = "production";
  const wrongScope = await core.capture(
    await signedRequest(policy, operator.privateKey, JSON.stringify(changed)),
    env,
  );
  assert.equal(wrongScope.status, 404);
  assert.equal(await wrongScope.text(), "Custody export unavailable");
  const changedRecipient = JSON.parse(custodyRequestBody(policy)) as Record<
    string,
    unknown
  >;
  changedRecipient.recipientFingerprint = "0".repeat(64);
  assert.equal(
    (
      await core.capture(
        await signedRequest(
          policy,
          operator.privateKey,
          JSON.stringify(changedRecipient),
        ),
        env,
      )
    ).status,
    404,
  );
  const wrongOperator = (await webcrypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ])) as webcrypto.CryptoKeyPair;
  assert.equal(
    (
      await core.capture(
        await signedRequest(policy, wrongOperator.privateKey),
        env,
      )
    ).status,
    404,
  );
  const expired = {
    ...policy,
    notBefore: Date.now() - 5000,
    expiresAt: Date.now() - 1000,
  };
  assert.equal(
    (
      await runtime(expired).capture(
        await signedRequest(expired, operator.privateKey),
        env,
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await core.capture(
        new Request("https://custody.invalid/custody/export", {
          method: "POST",
          headers: (await signedRequest(policy, operator.privateKey)).headers,
          body: "x".repeat(8193),
        }),
        env,
      )
    ).status,
    404,
  );
  const missing = await core.capture(
    await signedRequest(policy, operator.privateKey),
    {
      get CREDENTIAL_KEYS() {
        throw new Error(CAPTURED);
      },
    },
  );
  assert.equal(await missing.text(), "Custody export unavailable");
  assert.equal(
    (
      await core.capture(await signedRequest(policy, operator.privateKey), {
        CREDENTIAL_KEYS: "x".repeat(32769),
      })
    ).status,
    404,
  );
  let invalidPulls = 0;
  const invalidBody = new ReadableStream<Uint8Array>(
    {
      pull() {
        invalidPulls++;
        return new Promise<void>(() => {});
      },
    },
    { highWaterMark: 0 },
  );
  const invalidHeaders = new Headers({
    "content-type": "application/json",
    "x-pgcf-custody-signature": Buffer.alloc(64).toString("base64url"),
  });
  const invalidInit = {
    method: "POST",
    headers: invalidHeaders,
    body: invalidBody,
    duplex: "half" as const,
  };
  const unsignedStream = new Request(
    "https://custody.invalid/custody/export",
    invalidInit,
  );
  assert.equal((await core.capture(unsignedStream, env)).status, 404);
  assert.equal(
    invalidPulls,
    0,
    "an invalid signature must never pull its body",
  );
  await unsignedStream.body?.cancel();

  const shortPolicy = {
    ...policy,
    notBefore: Date.now() - 1000,
    expiresAt: Date.now() + 1000,
  };
  let validPulls = 0;
  const stalledBody = new ReadableStream<Uint8Array>(
    {
      pull() {
        validPulls++;
        return new Promise<void>(() => {});
      },
    },
    { highWaterMark: 0 },
  );
  const stalledInit = {
    method: "POST",
    headers: (await signedRequest(shortPolicy, operator.privateKey)).headers,
    body: stalledBody,
    duplex: "half" as const,
  };
  const stalled = await runtime(shortPolicy).capture(
    new Request("https://custody.invalid/custody/export", stalledInit),
    env,
  );
  assert.equal(stalled.status, 404);
  assert.equal(await stalled.text(), "Custody export unavailable");
  assert.ok(
    validPulls > 0,
    "valid authentication reaches the bounded body read",
  );
});

test("coordinator serializes one capture, persists only ciphertext and never blindly retries uncertain capture", async () => {
  const { policy, operator } = await fixture();
  const core = runtime(policy);
  let state: unknown;
  let tail = Promise.resolve();
  let calls = 0;
  const dependencies = {
    serial<T>(run: () => Promise<T>) {
      const next = tail.then(run);
      tail = next.then(
        () => undefined,
        () => undefined,
      );
      return next;
    },
    async get() {
      return state;
    },
    async put(value: unknown) {
      state = structuredClone(value);
    },
    async fetchTarget(request: Request) {
      calls++;
      assert.equal(
        request.headers.get("Cloudflare-Workers-Version-Overrides"),
        `${policy.scriptName}="${EXPORTER}"`,
      );
      return core.capture(request, { CREDENTIAL_KEYS: CAPTURED });
    },
  };
  const replies = await Promise.all(
    Array.from({ length: 4 }, async () => {
      const response = await core.coordinate(
        await signedRequest(policy, operator.privateKey),
        dependencies,
        EXPORTER,
      );
      assert.equal(response.status, 200);
      return response.text();
    }),
  );
  assert.equal(calls, 1);
  assert.equal(new Set(replies).size, 1);
  assert.ok(!JSON.stringify(state).includes(CAPTURED));
  const afterEviction = await runtime(policy).coordinate(
    await signedRequest(policy, operator.privateKey),
    dependencies,
    EXPORTER,
  );
  assert.equal(await afterEviction.text(), replies[0]);
  assert.equal(calls, 1);

  state = undefined;
  calls = 0;
  const uncertain = {
    ...dependencies,
    async fetchTarget(request: Request): Promise<Response> {
      calls++;
      await core.capture(request, { CREDENTIAL_KEYS: CAPTURED });
      throw new Error(CAPTURED);
    },
  };
  for (let retry = 0; retry < 2; retry++) {
    const response = await core.coordinate(
      await signedRequest(policy, operator.privateKey),
      uncertain,
      EXPORTER,
    );
    assert.equal(response.status, 409);
    assert.equal(await response.text(), "Custody export unavailable");
  }
  assert.equal(calls, 1);
  assert.deepEqual(state, { phase: "requested" });

  state = undefined;
  const plaintextUpstream = {
    ...dependencies,
    async fetchTarget() {
      return Response.json({ CREDENTIAL_KEYS: CAPTURED });
    },
  };
  const refused = await core.coordinate(
    await signedRequest(policy, operator.privateKey),
    plaintextUpstream,
    EXPORTER,
  );
  assert.equal(refused.status, 409);
  assert.ok(!(await refused.text()).includes(CAPTURED));
  assert.deepEqual(state, { phase: "requested" });

  state = undefined;
  const fetchDeadlinePolicy = {
    ...policy,
    notBefore: Date.now() - 1000,
    expiresAt: Date.now() + 1000,
  };
  let aborted = false;
  const fetchStall = {
    ...dependencies,
    fetchTarget(request: Request): Promise<Response> {
      request.signal.addEventListener("abort", () => {
        aborted = true;
      });
      return new Promise<Response>(() => {});
    },
  };
  const fetchTimedOut = await runtime(fetchDeadlinePolicy).coordinate(
    await signedRequest(fetchDeadlinePolicy, operator.privateKey),
    fetchStall,
    EXPORTER,
  );
  assert.equal(fetchTimedOut.status, 409);
  assert.equal(await fetchTimedOut.text(), "Custody export unavailable");
  assert.ok(aborted);
  assert.deepEqual(state, { phase: "requested" });

  state = undefined;
  const packetDeadlinePolicy = {
    ...policy,
    notBefore: Date.now() - 1000,
    expiresAt: Date.now() + 1000,
  };
  let packetPulls = 0;
  const packetStall = {
    ...dependencies,
    async fetchTarget() {
      return new Response(
        new ReadableStream<Uint8Array>(
          {
            pull() {
              packetPulls++;
              return new Promise<void>(() => {});
            },
          },
          { highWaterMark: 0 },
        ),
      );
    },
  };
  const packetTimedOut = await runtime(packetDeadlinePolicy).coordinate(
    await signedRequest(packetDeadlinePolicy, operator.privateKey),
    packetStall,
    EXPORTER,
  );
  assert.equal(packetTimedOut.status, 409);
  assert.equal(await packetTimedOut.text(), "Custody export unavailable");
  assert.ok(packetPulls > 0);
  assert.deepEqual(state, { phase: "requested" });
});

test("source builders preserve original exports, reject private keys and emit a fetch-only pinned bridge", async () => {
  const { policy } = await fixture();
  const exporter = buildCustodyExporterSource(policy);
  const bridge = buildCustodyBridgeSource({
    policy,
    targetVersionId: EXPORTER,
  });
  assert.ok(exporter.includes("extends WorkerEntrypoint"));
  assert.ok(bridge.includes("extends DurableObject"));
  assert.ok(bridge.includes("blockConcurrencyWhile"));
  assert.ok(bridge.includes("this.env.CUSTODY_TARGET.fetch(value)"));
  assert.ok(bridge.includes(EXPORTER));
  assert.ok(!exporter.includes("console."));
  assert.ok(!bridge.includes("console."));
  assert.ok(!exporter.includes(CAPTURED));
  assert.throws(() =>
    buildCustodyExporterSource({
      ...policy,
      recipientPublicJwk: { ...policy.recipientPublicJwk, d: "private" },
    } as CustodyExportPolicy),
  );
  assert.throws(() =>
    buildCustodyExporterSource({
      ...policy,
      recipientFingerprint: "0".repeat(64),
    }),
  );
  assert.throws(() =>
    buildCustodyBridgeSource({ policy, targetVersionId: "latest" }),
  );
  assert.throws(() =>
    buildCustodyExporterSource({
      ...policy,
      bindingNames: ["CREDENTIAL_KEYS", "CREDENTIAL_KEYS"],
    }),
  );

  const input = {
    originalImport: "./original.mjs",
    exporterImport: "./exporter.mjs",
    existingExports: ["DatabaseActor", "InfrastructureBackup"],
  };
  const wrapper = buildCustodyWrapperSource(input);
  assert.throws(() =>
    buildCustodyWrapperSource({ ...input, originalImport: "../other.mjs" }),
  );
  assert.throws(() =>
    buildCustodyWrapperSource({
      ...input,
      existingExports: ["CustodyExportService"],
    }),
  );
  const directory = await mkdtemp(join(tmpdir(), "custody-wrapper-"));
  try {
    await writeFile(
      join(directory, "original.mjs"),
      'export class DatabaseActor {}\nexport class InfrastructureBackup {}\nexport default { fetch() { return new Response("original"); }, scheduled() {} };\n',
    );
    await writeFile(
      join(directory, "exporter.mjs"),
      "export class CustodyExportService {}\n",
    );
    await writeFile(join(directory, "wrapper.mjs"), wrapper);
    const original = await import(
      pathToFileURL(join(directory, "original.mjs")).href
    );
    const overlaid = await import(
      pathToFileURL(join(directory, "wrapper.mjs")).href
    );
    assert.equal(overlaid.default, original.default);
    assert.equal(overlaid.DatabaseActor, original.DatabaseActor);
    assert.equal(overlaid.InfrastructureBackup, original.InfrastructureBackup);
    assert.equal(typeof overlaid.CustodyExportService, "function");
    assert.equal(await overlaid.default.fetch().text(), "original");

    const objectImport = "./object-default.mjs";
    const objectFence = buildCustodyMaintenanceWrapperSource({
      originalImport: objectImport,
      verifiedDefaultOnly: true,
    });
    await writeFile(
      join(directory, "object-default.mjs"),
      'export const calls = { constructor: 0, fetch: 0, scheduled: 0, queue: 0, write: 0 };\nexport class RetainedObject {}\nexport default { fetch() { calls.fetch++; return new Response("unfenced"); }, scheduled() { calls.scheduled++; }, queue() { calls.queue++; }, write() { calls.write++; } };\n',
    );
    await writeFile(join(directory, "object-fence.mjs"), objectFence);
    const objectOriginal = await import(
      pathToFileURL(join(directory, "object-default.mjs")).href
    );
    const objectFenced = await import(
      pathToFileURL(join(directory, "object-fence.mjs")).href
    );
    let keyReads = 0;
    const unreadableEnv = new Proxy(
      {},
      {
        get() {
          keyReads++;
          throw new Error(CAPTURED);
        },
      },
    );
    const objectResponse = objectFenced.default.fetch(
      new Request("https://maintenance.invalid/write"),
      unreadableEnv,
      {},
    ) as Response;
    assert.equal(objectResponse.status, 503);
    assert.equal(objectResponse.headers.get("cache-control"), "no-store");
    assert.equal(
      await objectResponse.text(),
      "Credential maintenance in progress",
    );
    assert.throws(
      () => objectFenced.default.scheduled(),
      /Credential maintenance in progress/u,
    );
    assert.throws(
      () => objectFenced.default.queue(),
      /Credential maintenance in progress/u,
    );
    assert.equal(objectFenced.default.write, undefined);
    assert.deepEqual(Object.keys(objectFenced.default).sort(), [
      "fetch",
      "queue",
      "scheduled",
    ]);
    assert.equal(objectFenced.RetainedObject, objectOriginal.RetainedObject);
    assert.deepEqual(objectOriginal.calls, {
      constructor: 0,
      fetch: 0,
      scheduled: 0,
      queue: 0,
      write: 0,
    });

    await writeFile(
      join(directory, "class-default.mjs"),
      "export const calls = { constructor: 0, fetch: 0, scheduled: 0, queue: 0, write: 0 };\nexport class RetainedObject {}\nexport default class OriginalDefault { constructor() { calls.constructor++; } fetch() { calls.fetch++; } scheduled() { calls.scheduled++; } queue() { calls.queue++; } write() { calls.write++; } }\n",
    );
    await writeFile(
      join(directory, "class-fence.mjs"),
      buildCustodyMaintenanceWrapperSource({
        originalImport: "./class-default.mjs",
        verifiedDefaultOnly: true,
      }),
    );
    const classOriginal = await import(
      pathToFileURL(join(directory, "class-default.mjs")).href
    );
    const classFenced = await import(
      pathToFileURL(join(directory, "class-fence.mjs")).href
    );
    const classResponse = classFenced.default.fetch(
      new Request("https://maintenance.invalid/write"),
      unreadableEnv,
      {},
    ) as Response;
    assert.equal(classResponse.status, 503);
    assert.equal(classResponse.headers.get("cache-control"), "no-store");
    assert.throws(
      () => classFenced.default.scheduled(),
      /Credential maintenance in progress/u,
    );
    assert.throws(
      () => classFenced.default.queue(),
      /Credential maintenance in progress/u,
    );
    assert.equal(classFenced.default.write, undefined);
    assert.equal(classFenced.RetainedObject, classOriginal.RetainedObject);
    assert.deepEqual(classOriginal.calls, {
      constructor: 0,
      fetch: 0,
      scheduled: 0,
      queue: 0,
      write: 0,
    });
    assert.equal(keyReads, 0);

    await writeFile(
      join(directory, "named-original.mjs"),
      "export const calls = { namedConstructor: 0, namedWrite: 0, defaultWrite: 0 };\nexport class CloudflareDomainManagementService { constructor() { calls.namedConstructor++; } write() { calls.namedWrite++; } }\nexport class RetainedObject {}\nexport class RetainedWorkflow {}\nexport default { write() { calls.defaultWrite++; } };\n",
    );
    await writeFile(
      join(directory, "platform-fixture.mjs"),
      "export class WorkerEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }\n",
    );
    const namedFence = buildCustodyMaintenanceWrapperSource({
      originalImport: "./named-original.mjs",
      verifiedCompleteWriteEntrypoints: true,
      closedNamedWorkerEntrypoints: ["CloudflareDomainManagementService"],
    });
    assert.ok(
      !namedFence.includes("extends CloudflareDomainManagementService"),
    );
    // Only the platform builtin is replaced in this Node fixture; generated fence logic is intact.
    await writeFile(
      join(directory, "named-fence.mjs"),
      namedFence.replace('"cloudflare:workers"', '"./platform-fixture.mjs"'),
    );
    const namedOriginal = await import(
      pathToFileURL(join(directory, "named-original.mjs")).href
    );
    const namedFenced = await import(
      pathToFileURL(join(directory, "named-fence.mjs")).href
    );
    assert.notEqual(
      namedFenced.CloudflareDomainManagementService,
      namedOriginal.CloudflareDomainManagementService,
    );
    const closedNamed = new namedFenced.CloudflareDomainManagementService(
      {},
      unreadableEnv,
    );
    assert.equal(closedNamed.write, undefined);
    assert.throws(() => closedNamed.write());
    assert.equal(namedFenced.default.write, undefined);
    assert.equal(namedFenced.default.fetch().status, 503);
    assert.equal(namedFenced.RetainedObject, namedOriginal.RetainedObject);
    assert.equal(namedFenced.RetainedWorkflow, namedOriginal.RetainedWorkflow);
    assert.deepEqual(namedOriginal.calls, {
      namedConstructor: 0,
      namedWrite: 0,
      defaultWrite: 0,
    });
    assert.equal(keyReads, 0);
    assert.throws(() =>
      buildCustodyMaintenanceWrapperSource({
        originalImport: "./named-original.mjs",
        verifiedCompleteWriteEntrypoints: true,
        closedNamedWorkerEntrypoints: ["default"],
      }),
    );
    assert.throws(() =>
      buildCustodyMaintenanceWrapperSource({
        originalImport: "./named-original.mjs",
        verifiedCompleteWriteEntrypoints: true,
        closedNamedWorkerEntrypoints: ["NamedWriter", "NamedWriter"],
      }),
    );
    assert.throws(() =>
      buildCustodyMaintenanceWrapperSource({
        originalImport: "./named-original.mjs",
        verifiedCompleteWriteEntrypoints: true,
        closedNamedWorkerEntrypoints: ["NamedWriter;inject()"],
      }),
    );
    assert.throws(() =>
      buildCustodyMaintenanceWrapperSource({
        originalImport: "./named-original.mjs",
        closedNamedWorkerEntrypoints: ["NamedWriter"],
      } as unknown as Parameters<
        typeof buildCustodyMaintenanceWrapperSource
      >[0]),
    );
    assert.throws(() =>
      buildCustodyMaintenanceWrapperSource({
        originalImport: objectImport,
        verifiedDefaultOnly: false as true,
      }),
    );
    assert.throws(() =>
      buildCustodyMaintenanceWrapperSource({
        originalImport: "../outside.mjs",
        verifiedDefaultOnly: true,
      }),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
