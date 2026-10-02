// SPDX-License-Identifier: Apache-2.0
// The first PostgreSQL frontend message, as seen by the edge before routing.
// Pure Uint8Array code so it runs in Workers and Node.
//
// The edge forwards a StartupMessage byte for byte (`raw`). The only other
// form that may ever be sent is `encodeStartup(params)`, the canonical
// serialization: protocol 3.<minor>, then each key\0value\0 in order, then \0.

export const SSL_REQUEST_CODE = 80877103;
export const GSSENC_REQUEST_CODE = 80877104;
export const CANCEL_REQUEST_CODE = 80877102;
export const STARTUP_MIN_LENGTH = 8;
export const STARTUP_MAX_LENGTH = 10000;
export const MAX_PRELUDES = 2;
export const DEFAULT_MAX_BUFFERED = 64 * 1024;
// Protocol 3.0 sends a 4-byte secret; 3.2 allows up to 256 bytes.
const CANCEL_MIN_LENGTH = 16;
const CANCEL_MAX_LENGTH = 12 + 256;

/** SSLRequest: 00 00 00 08 04 d2 16 2f. Returns a fresh copy. */
export function encodeSslRequest(): Uint8Array {
  return Uint8Array.of(0x00, 0x00, 0x00, 0x08, 0x04, 0xd2, 0x16, 0x2f);
}

/** The single byte `N` that declines an SSLRequest or GSSENCRequest. */
export function encodeEncryptionDeclined(): Uint8Array {
  return Uint8Array.of(0x4e);
}

export type StartupEvent =
  | { readonly kind: "need-more" }
  | { readonly kind: "ssl" }
  | { readonly kind: "gss" }
  | { readonly kind: "cancel" }
  | {
      readonly kind: "startup";
      readonly protocol: { readonly major: 3; readonly minor: number };
      /** Every parameter in wire order, `options` and `_pq_.*` verbatim. */
      readonly params: ReadonlyMap<string, string>;
      readonly user: string;
      /** `database`, or `user` when `database` is absent or empty. */
      readonly database: string;
      /** The exact StartupMessage bytes. */
      readonly raw: Uint8Array;
      /** Bytes received after the StartupMessage, in order. */
      readonly rest: Uint8Array;
    }
  | {
      readonly kind: "error";
      readonly sqlstate: string;
      readonly message: string;
    };

/**
 * Accumulates client bytes until the first meaningful message. `push` returns
 * one event at a time; after `ssl` or `gss` the caller answers with
 * `encodeEncryptionDeclined()` and calls `push(new Uint8Array(0))` to process
 * bytes that were already buffered. `startup`, `cancel` and `error` are final.
 * Buffering never exceeds `maxBuffered` bytes, and `push` never throws.
 */
export class StartupReader {
  readonly #maxBuffered: number;
  #buffer = new Uint8Array(0);
  #length = 0;
  #ssl = false;
  #gss = false;
  #final: StartupEvent | null = null;

  constructor(maxBuffered: number = DEFAULT_MAX_BUFFERED) {
    if (!Number.isInteger(maxBuffered) || maxBuffered < STARTUP_MAX_LENGTH)
      throw new RangeError(`maxBuffered must be >= ${STARTUP_MAX_LENGTH}`);
    this.#maxBuffered = maxBuffered;
  }

  get bufferedBytes(): number {
    return this.#length;
  }

  push(chunk: Uint8Array): StartupEvent {
    if (this.#final !== null) return protocolError("startup already processed");
    if (chunk.length > this.#maxBuffered - this.#length)
      return this.#finish(protocolError("too much data before startup"));
    this.#append(chunk);
    return this.#next();
  }

  #append(chunk: Uint8Array): void {
    const needed = this.#length + chunk.length;
    if (needed > this.#buffer.length) {
      let capacity = Math.max(256, this.#buffer.length);
      while (capacity < needed) capacity *= 2;
      const grown = new Uint8Array(Math.min(capacity, this.#maxBuffered));
      grown.set(this.#buffer.subarray(0, this.#length));
      this.#buffer = grown;
    }
    this.#buffer.set(chunk, this.#length);
    this.#length = needed;
  }

  #next(): StartupEvent {
    if (this.#length < 4) return { kind: "need-more" };
    const length = readUint32(this.#buffer, 0);
    if (length < STARTUP_MIN_LENGTH || length > STARTUP_MAX_LENGTH)
      return this.#finish(protocolError("invalid length of startup packet"));
    if (this.#length < 8) return { kind: "need-more" };
    const code = readUint32(this.#buffer, 4);

    if (code === SSL_REQUEST_CODE || code === GSSENC_REQUEST_CODE) {
      const ssl = code === SSL_REQUEST_CODE;
      if (length !== 8)
        return this.#finish(protocolError("invalid length of startup packet"));
      if ((ssl ? this.#ssl : this.#gss) || this.#preludes() >= MAX_PRELUDES)
        return this.#finish(protocolError("too many encryption requests"));
      if (ssl) this.#ssl = true;
      else this.#gss = true;
      this.#consume(8);
      return { kind: ssl ? "ssl" : "gss" };
    }
    if (code === CANCEL_REQUEST_CODE) {
      if (length < CANCEL_MIN_LENGTH || length > CANCEL_MAX_LENGTH)
        return this.#finish(protocolError("invalid length of cancel request"));
      if (this.#length < length) return { kind: "need-more" };
      return this.#finish({ kind: "cancel" });
    }
    const major = code >>> 16;
    const minor = code & 0xffff;
    if (major !== 3)
      return this.#finish({
        kind: "error",
        sqlstate: "0A000",
        message: `unsupported frontend protocol ${major}.${minor}: server supports 3.0 to 3.x`,
      });
    if (this.#length < length) return { kind: "need-more" };
    const raw = this.#buffer.slice(0, length);
    const rest = this.#buffer.slice(length, this.#length);
    return this.#finish(parseStartup(raw, minor, rest));
  }

  #preludes(): number {
    return (this.#ssl ? 1 : 0) + (this.#gss ? 1 : 0);
  }

  #consume(bytes: number): void {
    this.#buffer.copyWithin(0, bytes, this.#length);
    this.#length -= bytes;
  }

  #finish(event: StartupEvent): StartupEvent {
    this.#final = event;
    this.#buffer = new Uint8Array(0);
    this.#length = 0;
    return event;
  }
}

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function parseStartup(
  raw: Uint8Array,
  minor: number,
  rest: Uint8Array,
): StartupEvent {
  const params = new Map<string, string>();
  let position = 8;
  for (;;) {
    if (position >= raw.length)
      return protocolError("invalid startup packet layout: missing terminator");
    if (raw[position] === 0) {
      position += 1;
      break;
    }
    const keyEnd = raw.indexOf(0, position);
    const valueEnd = keyEnd < 0 ? -1 : raw.indexOf(0, keyEnd + 1);
    if (valueEnd < 0)
      return protocolError("invalid startup packet layout: unterminated field");
    let key: string;
    let value: string;
    try {
      key = utf8.decode(raw.subarray(position, keyEnd));
      value = utf8.decode(raw.subarray(keyEnd + 1, valueEnd));
    } catch {
      return protocolError("invalid UTF-8 in startup packet");
    }
    // PostgreSQL lets the last duplicate win; rejecting keeps the edge and the
    // server from ever reading different values out of the same bytes.
    if (params.has(key)) return protocolError("duplicate startup parameter");
    params.set(key, value);
    position = valueEnd + 1;
  }
  if (position !== raw.length)
    return protocolError(
      "invalid startup packet layout: expected terminator as last byte",
    );
  if (params.has("replication"))
    return {
      kind: "error",
      sqlstate: "0A000",
      message: "replication connections are not supported",
    };
  const user = params.get("user");
  if (user === undefined || user === "")
    return {
      kind: "error",
      sqlstate: "28000",
      message: "no PostgreSQL user name specified in startup packet",
    };
  const database = params.get("database");
  return {
    kind: "startup",
    protocol: { major: 3, minor },
    params,
    user,
    database: database === undefined || database === "" ? user : database,
    raw,
    rest,
  };
}

/** Canonical StartupMessage for protocol 3.<minor>. Throws on invalid input. */
export function encodeStartup(
  params: ReadonlyMap<string, string> | Readonly<Record<string, string>>,
  minor = 0,
): Uint8Array {
  if (!Number.isInteger(minor) || minor < 0 || minor > 0xffff)
    throw new RangeError("invalid protocol minor version");
  const entries =
    params instanceof Map
      ? [...(params as ReadonlyMap<string, string>)]
      : Object.entries(params);
  // UTF-16 code-unit count is a lower bound on UTF-8 bytes.
  let sourceLength = 9;
  for (const [key, value] of entries) {
    sourceLength += key.length + value.length + 2;
    if (sourceLength > STARTUP_MAX_LENGTH)
      throw new RangeError("startup too large");
    if (key === "" || key.includes("\0") || value.includes("\0"))
      throw new RangeError("invalid startup parameter");
  }
  const parts: Uint8Array[] = [];
  let length = 9;
  for (const [key, value] of entries) {
    for (const text of [key, value]) {
      const bytes = encoder.encode(text);
      length += bytes.length + 1;
      if (length > STARTUP_MAX_LENGTH)
        throw new RangeError("startup too large");
      parts.push(bytes);
    }
  }
  const out = new Uint8Array(length);
  writeUint32(out, 0, length);
  writeUint32(out, 4, (3 << 16) | minor);
  let position = 8;
  for (const part of parts) {
    out.set(part, position);
    position += part.length + 1;
  }
  return out;
}

/** A FATAL ErrorResponse ('E') with severity, code and message fields. */
export function encodeErrorResponse(
  sqlstate: string,
  message: string,
): Uint8Array {
  if (!/^[0-9A-Z]{5}$/.test(sqlstate)) throw new RangeError("invalid SQLSTATE");
  const fields: [number, string][] = [
    [0x53, "FATAL"], // S: localized severity
    [0x56, "FATAL"], // V: severity
    [0x43, sqlstate], // C
    [0x4d, message.replaceAll("\0", "")], // M
  ];
  const encoded = fields.map(
    ([type, text]) => [type, encoder.encode(text)] as const,
  );
  const bodyLength = encoded.reduce((n, [, b]) => n + 2 + b.length, 0) + 1;
  const out = new Uint8Array(1 + 4 + bodyLength);
  out[0] = 0x45;
  writeUint32(out, 1, 4 + bodyLength);
  let position = 5;
  for (const [type, bytes] of encoded) {
    out[position] = type;
    out.set(bytes, position + 1);
    position += bytes.length + 2;
  }
  return out;
}

const encoder = new TextEncoder();

function protocolError(message: string): StartupEvent {
  return { kind: "error", sqlstate: "08P01", message };
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return (
    (((bytes[offset] as number) << 24) |
      ((bytes[offset + 1] as number) << 16) |
      ((bytes[offset + 2] as number) << 8) |
      (bytes[offset + 3] as number)) >>>
    0
  );
}

function writeUint32(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value >>> 24;
  bytes[offset + 1] = (value >>> 16) & 0xff;
  bytes[offset + 2] = (value >>> 8) & 0xff;
  bytes[offset + 3] = value & 0xff;
}
