// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";

/** Public, pinned deployment inputs. Neither private keys nor captured values belong here. */
export interface CustodyExportPolicy {
  accountId: string;
  scriptName: string;
  environment: string;
  transactionId: string;
  sourceVersionId: string;
  notBefore: number;
  expiresAt: number;
  bindingNames: readonly string[];
  recipientFingerprint: string;
  recipientPublicJwk: {
    kty: "RSA";
    n: string;
    e: string;
    alg?: "RSA-OAEP-256";
    ext?: boolean;
    key_ops?: readonly string[];
  };
  operatorPublicJwk: {
    kty: "OKP";
    crv: "Ed25519";
    x: string;
    alg?: "EdDSA" | "Ed25519";
    ext?: boolean;
    key_ops?: readonly string[];
  };
}

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const B64 = /^[A-Za-z0-9_-]+$/u;
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function publicFields(value: unknown, allowed: readonly string[]) {
  if (
    !object(value) ||
    Object.keys(value).some((key) => !allowed.includes(key))
  )
    throw new Error("Custody policy contains invalid public-key fields");
  if (value.ext !== undefined && value.ext !== true)
    throw new Error("Custody policy contains invalid public-key fields");
}

function canonicalBytes(value: unknown, min: number, max: number) {
  if (typeof value !== "string" || !B64.test(value)) return false;
  const bytes = Buffer.from(value, "base64url");
  return (
    bytes.length >= min &&
    bytes.length <= max &&
    bytes.toString("base64url") === value
  );
}

/** A public-key identity, not a hash of any secret. */
export function custodyRecipientFingerprint(
  key: CustodyExportPolicy["recipientPublicJwk"],
): string {
  publicFields(key, ["kty", "n", "e", "alg", "ext", "key_ops"]);
  if (
    key.kty !== "RSA" ||
    !canonicalBytes(key.n, 256, 512) ||
    key.e !== "AQAB" ||
    (key.alg !== undefined && key.alg !== "RSA-OAEP-256") ||
    (key.key_ops !== undefined &&
      (!Array.isArray(key.key_ops) ||
        key.key_ops.length !== 1 ||
        key.key_ops[0] !== "encrypt"))
  )
    throw new Error("Custody recipient public key is invalid");
  return createHash("sha256")
    .update(JSON.stringify({ kty: "RSA", n: key.n, e: key.e }))
    .digest("hex");
}

function normalizedPolicy(input: CustodyExportPolicy): CustodyExportPolicy {
  if (
    !object(input) ||
    Object.keys(input).some(
      (key) =>
        ![
          "accountId",
          "scriptName",
          "environment",
          "transactionId",
          "sourceVersionId",
          "notBefore",
          "expiresAt",
          "bindingNames",
          "recipientFingerprint",
          "recipientPublicJwk",
          "operatorPublicJwk",
        ].includes(key),
    ) ||
    !/^[a-f0-9]{32}$/u.test(input.accountId) ||
    !/^[a-z0-9][a-z0-9-]{0,62}$/u.test(input.scriptName) ||
    !/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(input.environment) ||
    !UUID.test(input.transactionId) ||
    !UUID.test(input.sourceVersionId) ||
    !Number.isSafeInteger(input.notBefore) ||
    !Number.isSafeInteger(input.expiresAt) ||
    input.notBefore < 0 ||
    input.expiresAt <= input.notBefore ||
    input.expiresAt - input.notBefore > 3_600_000 ||
    !Array.isArray(input.bindingNames) ||
    input.bindingNames.length < 1 ||
    input.bindingNames.length > 32 ||
    input.bindingNames.some(
      (name) =>
        typeof name !== "string" || !/^[A-Z][A-Z0-9_]{0,99}$/u.test(name),
    ) ||
    new Set(input.bindingNames).size !== input.bindingNames.length
  )
    throw new Error("Custody export policy is invalid");
  if (
    input.recipientFingerprint !==
    custodyRecipientFingerprint(input.recipientPublicJwk)
  )
    throw new Error("Custody recipient identity does not match");
  publicFields(input.operatorPublicJwk, [
    "kty",
    "crv",
    "x",
    "alg",
    "ext",
    "key_ops",
  ]);
  const operator = input.operatorPublicJwk;
  if (
    operator.kty !== "OKP" ||
    operator.crv !== "Ed25519" ||
    !canonicalBytes(operator.x, 32, 32) ||
    (operator.alg !== undefined &&
      !["EdDSA", "Ed25519"].includes(operator.alg)) ||
    (operator.key_ops !== undefined &&
      (!Array.isArray(operator.key_ops) ||
        operator.key_ops.length !== 1 ||
        operator.key_ops[0] !== "verify"))
  )
    throw new Error("Custody operator public key is invalid");
  return JSON.parse(
    JSON.stringify({ ...input, bindingNames: [...input.bindingNames].sort() }),
  ) as CustodyExportPolicy;
}

/** Sign these exact UTF-8 bytes with the operator Ed25519 private key. */
export function custodyRequestBody(input: CustodyExportPolicy): string {
  const policy = normalizedPolicy(input);
  return JSON.stringify({
    protocol: "pgcf-custody-request-v1",
    accountId: policy.accountId,
    scriptName: policy.scriptName,
    environment: policy.environment,
    transactionId: policy.transactionId,
    sourceVersionId: policy.sourceVersionId,
    recipientFingerprint: policy.recipientFingerprint,
    bindingNames: policy.bindingNames,
    notBefore: policy.notBefore,
    expiresAt: policy.expiresAt,
  });
}

/**
 * The exact dependency-free Worker core. Keeping it as JavaScript source lets Node's real
 * WebCrypto exercise the same bytes as the generated Workers, without cloudflare builtins.
 */
export const CUSTODY_RUNTIME_SOURCE = String.raw`function createCustodyRuntime(policy) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const signatureHeader = "x-pgcf-custody-signature";
  const requestBody = JSON.stringify({
    protocol: "pgcf-custody-request-v1", accountId: policy.accountId,
    scriptName: policy.scriptName, environment: policy.environment,
    transactionId: policy.transactionId, sourceVersionId: policy.sourceVersionId,
    recipientFingerprint: policy.recipientFingerprint,
    bindingNames: policy.bindingNames, notBefore: policy.notBefore, expiresAt: policy.expiresAt
  });
  const scope = {
    accountId: policy.accountId, scriptName: policy.scriptName,
    environment: policy.environment, transactionId: policy.transactionId,
    sourceVersionId: policy.sourceVersionId
  };
  const aadText = JSON.stringify({
    protocol: "pgcf-custody-sealed-v1", algorithm: "RSA-OAEP-256+A256GCM",
    ...scope, recipientFingerprint: policy.recipientFingerprint,
    notBefore: policy.notBefore, expiresAt: policy.expiresAt,
    bindingNames: policy.bindingNames
  });
  const aad = encoder.encode(aadText);
  const closed = (status = 404) => new Response("Custody export unavailable", {
    status, headers: { "cache-control": "no-store", "content-type": "text/plain" }
  });
  const encoded = (bytes) => {
    let text = "";
    for (let offset = 0; offset < bytes.length; offset += 8192)
      text += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    return btoa(text).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  };
  const decoded = (value) => {
    if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("closed");
    const text = atob(value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - value.length % 4) % 4));
    const bytes = Uint8Array.from(text, (character) => character.charCodeAt(0));
    if (encoded(bytes) !== value) throw new Error("closed");
    return bytes;
  };
  async function beforeDeadline(run, stopAt, onTimeout = () => {}) {
    const remaining = stopAt - Date.now();
    if (remaining <= 0) throw new Error("closed");
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(run),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error("closed"));
            try { onTimeout(); } catch {}
          }, remaining);
        })
      ]);
    } finally { clearTimeout(timer); }
  }
  async function boundedText(body, maximum, stopAt = Math.min(policy.expiresAt, Date.now() + 10000)) {
    if (!body) throw new Error("closed");
    const reader = body.getReader();
    const chunks = [];
    let count = 0;
    try {
      await beforeDeadline(async () => {
        for (;;) {
          const item = await reader.read();
          if (item.done) break;
          count += item.value.length;
          if (count > maximum) {
            void reader.cancel().catch(() => {});
            throw new Error("closed");
          }
          chunks.push(item.value);
        }
      }, stopAt, () => { void reader.cancel().catch(() => {}); });
    } finally { try { reader.releaseLock(); } catch {} }
    const bytes = new Uint8Array(count);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    try { return decoder.decode(bytes); } finally { bytes.fill(0); }
  }
  const inWindow = () => Date.now() >= policy.notBefore && Date.now() < policy.expiresAt;
  let verificationKey;
  async function authorize(request) {
    try {
      if (!inWindow() || request.method !== "POST") return false;
      const url = new URL(request.url);
      if (url.pathname !== "/custody/export" || url.search || url.hash) return false;
      if (request.headers.get("content-type") !== "application/json") return false;
      const signature = request.headers.get(signatureHeader);
      if (!signature || signature.length !== 86) return false;
      const claimed = request.headers.get("content-length");
      if (claimed !== null && (!/^\d+$/.test(claimed) || Number(claimed) > 8192)) return false;
      verificationKey ??= crypto.subtle.importKey("jwk", policy.operatorPublicJwk, { name: "Ed25519" }, false, ["verify"]);
      const valid = await crypto.subtle.verify("Ed25519", await verificationKey, decoded(signature), encoder.encode(requestBody));
      if (!valid || !inWindow()) return false;
      const body = await boundedText(request.body, 8192);
      return body === requestBody && inWindow();
    } catch { return false; }
  }
  function forwardedRequest(request, targetVersionId, signal) {
    const headers = {
      "content-type": "application/json",
      [signatureHeader]: request.headers.get(signatureHeader) ?? ""
    };
    if (targetVersionId)
      headers["Cloudflare-Workers-Version-Overrides"] = policy.scriptName + '=\"' + targetVersionId + '\"';
    return new Request("https://custody.invalid/custody/export", {
      method: "POST", headers, body: requestBody, ...(signal ? { signal } : {})
    });
  }
  const json = (body) => new Response(body, {
    status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" }
  });
  async function capture(request, env) {
    if (!(await authorize(request))) return closed();
    let plaintext;
    let keyBytes;
    try {
      const bindings = Object.create(null);
      for (const name of policy.bindingNames) {
        if (!Object.prototype.hasOwnProperty.call(env, name)) throw new Error("closed");
        const value = env[name];
        if (typeof value !== "string" || value.length === 0 || encoder.encode(value).length > 32768)
          throw new Error("closed");
        bindings[name] = value;
      }
      plaintext = encoder.encode(JSON.stringify({ protocol: "pgcf-custody-plaintext-v1", ...scope, bindings }));
      if (plaintext.length > 524288) throw new Error("closed");
      keyBytes = crypto.getRandomValues(new Uint8Array(32));
      const nonce = crypto.getRandomValues(new Uint8Array(12));
      const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt"]);
      const recipient = await crypto.subtle.importKey("jwk", policy.recipientPublicJwk, { name: "RSA-OAEP", hash: "SHA-256" }, false, ["encrypt"]);
      const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: aad, tagLength: 128 }, key, plaintext));
      const wrappedKey = new Uint8Array(await crypto.subtle.encrypt({ name: "RSA-OAEP" }, recipient, keyBytes));
      if (!inWindow()) throw new Error("closed");
      return json(JSON.stringify({
        protocol: "pgcf-custody-sealed-v1", algorithm: "RSA-OAEP-256+A256GCM",
        ...scope, recipientFingerprint: policy.recipientFingerprint,
        aad: encoded(aad), nonce: encoded(nonce), wrappedKey: encoded(wrappedKey),
        ciphertext: encoded(ciphertext)
      }));
    } catch { return closed(); }
    finally { if (plaintext) plaintext.fill(0); if (keyBytes) keyBytes.fill(0); }
  }
  function checkedPacket(text) {
    if (typeof text !== "string" || encoder.encode(text).length > 1048576) throw new Error("closed");
    const packet = JSON.parse(text);
    const fields = ["protocol", "algorithm", "accountId", "scriptName", "environment", "transactionId", "sourceVersionId", "recipientFingerprint", "aad", "nonce", "wrappedKey", "ciphertext"];
    if (!packet || typeof packet !== "object" || Array.isArray(packet) || Object.keys(packet).length !== fields.length || Object.keys(packet).some((key) => !fields.includes(key))) throw new Error("closed");
    if (packet.protocol !== "pgcf-custody-sealed-v1" || packet.algorithm !== "RSA-OAEP-256+A256GCM" || packet.recipientFingerprint !== policy.recipientFingerprint || packet.aad !== encoded(aad)) throw new Error("closed");
    for (const [name, value] of Object.entries(scope)) if (packet[name] !== value) throw new Error("closed");
    if (decoded(packet.nonce).length !== 12 || decoded(packet.wrappedKey).length !== decoded(policy.recipientPublicJwk.n).length || decoded(packet.ciphertext).length < 17 || decoded(packet.ciphertext).length > 524304) throw new Error("closed");
    return JSON.stringify(packet);
  }
  async function coordinate(request, dependencies, targetVersionId) {
    if (!(await authorize(request))) return closed();
    try {
      return await dependencies.serial(async () => {
        try {
        if (!inWindow()) return closed();
        const current = await dependencies.get();
        if (current !== undefined) {
          if (current && current.phase === "sealed") return json(checkedPacket(current.packet));
          return closed(409);
        }
        // Persist admission BEFORE the call. A lost reply is uncertain, never a second capture.
        await dependencies.put({ phase: "requested" });
        const stopAt = Math.min(policy.expiresAt, Date.now() + 15000);
        const controller = new AbortController();
        const response = await beforeDeadline(
          () => dependencies.fetchTarget(forwardedRequest(request, targetVersionId, controller.signal)),
          stopAt,
          () => controller.abort()
        );
        if (response.status !== 200) return closed(409);
        const packet = checkedPacket(await boundedText(response.body, 1048576, stopAt));
        await dependencies.put({ phase: "sealed", packet });
        return json(packet);
        } catch { return closed(409); }
      });
    } catch { return closed(409); }
  }
  return { authorize, capture, coordinate, forwardedRequest, closed };
}`;

export function buildCustodyExporterSource(input: CustodyExportPolicy): string {
  const policy = normalizedPolicy(input);
  return `import { WorkerEntrypoint } from "cloudflare:workers";\nconst core = (${CUSTODY_RUNTIME_SOURCE})(${JSON.stringify(policy)});\nexport class CustodyExportService extends WorkerEntrypoint {\n  async fetch(request) { return core.capture(request, this.env); }\n}\n`;
}

function safeModuleImport(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\.\/(?:[A-Za-z0-9_@-][A-Za-z0-9._@-]*\/)*[A-Za-z0-9_@-][A-Za-z0-9._@-]*$/u.test(
      value,
    ) &&
    !value
      .slice(2)
      .split("/")
      .some((part) => part === ".." || part === ".")
  );
}

/** Add only the private entrypoint, leaving the original main and every export intact. */
export function buildCustodyWrapperSource(input: {
  originalImport: string;
  exporterImport: string;
  existingExports: readonly string[];
}): string {
  if (
    !safeModuleImport(input.originalImport) ||
    !safeModuleImport(input.exporterImport) ||
    input.originalImport === input.exporterImport ||
    !Array.isArray(input.existingExports) ||
    input.existingExports.includes("CustodyExportService")
  )
    throw new Error("Custody wrapper imports or existing exports are invalid");
  return `export * from ${JSON.stringify(input.originalImport)};\nexport { default } from ${JSON.stringify(input.originalImport)};\nexport { CustodyExportService } from ${JSON.stringify(input.exporterImport)};\n`;
}

/**
 * A verified-entrypoint maintenance fence, not a drain barrier. The caller must identify every
 * mutating entrypoint and separately drain in-flight work. Selected named WorkerEntrypoints
 * become empty platform-base classes, not subclasses of the original writers. Other named
 * exports and original module initialization remain; this wrapper never invokes the original
 * default constructor or handlers. Module initialization must itself be checked for side effects.
 */
export function buildCustodyMaintenanceWrapperSource(
  input: { originalImport: string } & (
    | {
        verifiedDefaultOnly: true;
        verifiedCompleteWriteEntrypoints?: never;
        closedNamedWorkerEntrypoints?: never;
      }
    | {
        verifiedDefaultOnly?: never;
        verifiedCompleteWriteEntrypoints: true;
        closedNamedWorkerEntrypoints: readonly string[];
      }
  ),
): string {
  const named = input.closedNamedWorkerEntrypoints;
  const defaultOnly =
    input.verifiedDefaultOnly === true &&
    input.verifiedCompleteWriteEntrypoints === undefined &&
    named === undefined;
  const complete =
    input.verifiedCompleteWriteEntrypoints === true &&
    input.verifiedDefaultOnly === undefined &&
    Array.isArray(named) &&
    named.length <= 32 &&
    named.every(
      (name) =>
        typeof name === "string" && /^[A-Z][A-Za-z0-9_]{0,99}$/u.test(name),
    ) &&
    new Set(named).size === named.length;
  if ((!defaultOnly && !complete) || !safeModuleImport(input.originalImport))
    throw new Error("Custody maintenance fence scope or import is invalid");
  const closed = complete ? [...named!].sort() : [];
  const platformImport = closed.length
    ? 'import { WorkerEntrypoint as __CustodyClosedWorkerEntrypoint } from "cloudflare:workers";\n'
    : "";
  const replacements = closed
    .map(
      (name) =>
        `export class ${name} extends __CustodyClosedWorkerEntrypoint {}\n`,
    )
    .join("");
  return `${platformImport}export * from ${JSON.stringify(input.originalImport)};\n${replacements}const reject = () => { throw new Error("Credential maintenance in progress"); };\nexport default {\n  fetch() { return new Response("Credential maintenance in progress", { status: 503, headers: { "cache-control": "no-store", "content-type": "text/plain" } }); },\n  scheduled: reject,\n  queue: reject\n};\n`;
}

/** A temporary operator-only bridge; its Durable Object stores sealed packet/phase metadata. */
export function buildCustodyBridgeSource(input: {
  policy: CustodyExportPolicy;
  targetVersionId: string;
}): string {
  const policy = normalizedPolicy(input.policy);
  if (!UUID.test(input.targetVersionId))
    throw new Error("Custody target version is invalid");
  return `import { DurableObject } from "cloudflare:workers";\nconst policy = ${JSON.stringify(policy)};\nconst core = (${CUSTODY_RUNTIME_SOURCE})(policy);\nconst targetVersionId = ${JSON.stringify(input.targetVersionId)};\nexport class CustodyCoordinator extends DurableObject {\n  async fetch(request) {\n    return core.coordinate(request, {\n      serial: (run) => this.ctx.blockConcurrencyWhile(run),\n      get: () => this.ctx.storage.get("custody"),\n      put: (value) => this.ctx.storage.put("custody", value),\n      fetchTarget: (value) => this.env.CUSTODY_TARGET.fetch(value)\n    }, targetVersionId);\n  }\n}\nexport default {\n  async fetch(request, env) {\n    if (!(await core.authorize(request))) return core.closed();\n    const identity = [policy.accountId, policy.scriptName, policy.environment, policy.transactionId].join("/");\n    const stub = env.CUSTODY_COORDINATOR.get(env.CUSTODY_COORDINATOR.idFromName(identity));\n    return stub.fetch(core.forwardedRequest(request));\n  }\n};\n`;
}
