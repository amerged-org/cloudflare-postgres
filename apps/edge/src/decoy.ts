// SPDX-License-Identifier: Apache-2.0
import {
  StartupReader,
  STARTUP_MAX_LENGTH,
  encodeEncryptionDeclined,
  encodeErrorResponse,
} from "@pgcf/contracts/pg-wire";
import { parseRouteKeyring } from "@pgcf/contracts/route-token";

export const DECOY_DEADLINE_MS = 10_000;
export const DECOY_MAX_BYTES = 64 * 1024;
export const DECOY_MAX_FRAMES = 128;
const AUTH_MAX_BYTES = 4096;
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const encoder = new TextEncoder();
function authentication(code: number, text: string): Uint8Array {
  const body = encoder.encode(text),
    out = new Uint8Array(9 + body.length),
    view = new DataView(out.buffer);
  out[0] = 0x52;
  view.setUint32(1, out.length - 1);
  view.setUint32(5, code);
  out.set(body, 9);
  return out;
}
function base64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}
async function salt(
  secret: string,
  database: string,
  user: string,
): Promise<string> {
  const ring = parseRouteKeyring(secret),
    master = ring.keys.get(ring.active)!;
  const key = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(master),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const derived = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(
      "pgcf.edge.decoy-scram-salt/v1\n" + JSON.stringify([database, user]),
    ),
  );
  return base64(new Uint8Array(derived).subarray(0, 16));
}

/** Unknown routes only. Never authenticate, retain a password, or forward frontend bytes. */
export function decoyResponse(
  hints: { database: string; user: string },
  secret: string,
  signal: AbortSignal,
  ctx: ExecutionContext,
): Response {
  const pair = new WebSocketPair(),
    socket = pair[1];
  socket.binaryType = "arraybuffer";
  socket.accept();
  let reader: StartupReader | undefined = new StartupReader(STARTUP_MAX_LENGTH);
  let buffer = new Uint8Array(0),
    phase: "startup" | "first" | "final" = "startup",
    nonce = "",
    binding = "",
    closed = false,
    busy = false,
    bytes = 0,
    frames = 0;
  let complete!: () => void;
  const done = new Promise<void>((resolve) => {
    complete = resolve;
  });
  ctx.waitUntil(done);
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    reader = undefined;
    buffer = new Uint8Array(0);
    nonce = "";
    binding = "";
    signal.removeEventListener("abort", abort);
    socket.removeEventListener("message", message);
    socket.removeEventListener("close", close);
    socket.removeEventListener("error", close);
    complete();
  };
  const finish = (code?: string) => {
    if (closed) return;
    try {
      if (code)
        socket.send(
          encodeErrorResponse(
            code,
            code === "28P01"
              ? "password authentication failed"
              : "connection rejected",
          ),
        );
      socket.close(1000, "connection refused");
    } catch {
      /* Peer already closed. */
    } finally {
      cleanup();
    }
  };
  const abort = () => finish();
  const close = () => {
    try {
      socket.close();
    } catch {
      /* Peer already closed. */
    }
    cleanup();
  };
  const timer = setTimeout(() => finish("28P01"), DECOY_DEADLINE_MS);
  async function drain(): Promise<void> {
    if (busy || closed) return;
    busy = true;
    try {
      while (!closed) {
        if (phase === "startup") {
          const input = buffer;
          buffer = new Uint8Array(0);
          const event = reader!.push(input);
          if (event.kind === "need-more") break;
          if (event.kind === "ssl" || event.kind === "gss") {
            socket.send(encodeEncryptionDeclined());
            continue;
          }
          if (event.kind === "cancel") {
            finish();
            break;
          }
          if (event.kind === "error") {
            finish(event.sqlstate);
            break;
          }
          if (event.database !== hints.database || event.user !== hints.user) {
            finish("28000");
            break;
          }
          reader = undefined;
          buffer = new Uint8Array(event.rest);
          phase = "first";
          if (buffer.length > AUTH_MAX_BYTES + 1) {
            finish("28P01");
            break;
          }
          socket.send(
            authentication(10, "SCRAM-SHA-256-PLUS\0SCRAM-SHA-256\0\0"),
          );
        }
        if (buffer.length < 5) break;
        const length = new DataView(
          buffer.buffer,
          buffer.byteOffset,
          buffer.byteLength,
        ).getUint32(1);
        if (buffer[0] !== 0x70 || length < 4 || length > AUTH_MAX_BYTES) {
          finish("28P01");
          break;
        }
        if (buffer.length < length + 1) break;
        const body = buffer.slice(5, length + 1);
        buffer = buffer.slice(length + 1);
        if (phase === "first") {
          const end = body.indexOf(0);
          if (
            end < 0 ||
            utf8.decode(body.subarray(0, end)) !== "SCRAM-SHA-256" ||
            body.length < end + 5
          ) {
            finish("28P01");
            break;
          }
          const size = new DataView(body.buffer).getInt32(end + 1);
          if (size < 0 || size !== body.length - end - 5) {
            finish("28P01");
            break;
          }
          const first = utf8.decode(body.subarray(end + 5));
          if (!first.startsWith("n,,") && !first.startsWith("y,,")) {
            finish("28P01");
            break;
          }
          binding = base64(encoder.encode(first.slice(0, 3)));
          const parts = first.slice(3).split(",");
          if (
            parts.length !== 2 ||
            !parts[0]!.startsWith("n=") ||
            !parts[1]!.startsWith("r=") ||
            /[=,]/.test(parts[0]!.slice(2).replace(/=2C|=3D/g, "")) ||
            [...parts[0]!.slice(2)].some(
              (char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127,
            )
          ) {
            finish("28P01");
            break;
          }
          const clientNonce = parts[1]!.slice(2);
          if (!/^[\x21-\x2b\x2d-\x7e]{1,1024}$/.test(clientNonce)) {
            finish("28P01");
            break;
          }
          nonce =
            clientNonce + base64(crypto.getRandomValues(new Uint8Array(18)));
          const derived = await salt(secret, hints.database, hints.user);
          if (closed) break;
          phase = "final";
          socket.send(authentication(11, `r=${nonce},s=${derived},i=4096`));
        } else {
          const final = utf8.decode(body),
            parts = final.split(",");
          if (
            parts.length !== 3 ||
            parts[0] !== `c=${binding}` ||
            parts[1] !== `r=${nonce}` ||
            !/^p=[A-Za-z0-9+/]{43}=$/.test(parts[2]!)
          ) {
            finish("28P01");
            break;
          }
          const proof = parts[2]!.slice(2);
          if (
            base64(
              Uint8Array.from(atob(proof), (char) => char.charCodeAt(0)),
            ) !== proof
          ) {
            finish("28P01");
            break;
          }
          // Even a structurally valid proof always fails. No verifier or AuthenticationOk exists here.
          finish("28P01");
        }
      }
    } catch {
      finish("28P01");
    } finally {
      busy = false;
    }
  }
  function message(event: MessageEvent): void {
    if (closed) return;
    if (
      !(event.data instanceof ArrayBuffer) ||
      ++frames > DECOY_MAX_FRAMES ||
      event.data.byteLength > DECOY_MAX_BYTES - bytes
    ) {
      finish("28P01");
      return;
    }
    const retained =
      phase === "startup"
        ? STARTUP_MAX_LENGTH - (reader?.bufferedBytes ?? 0)
        : AUTH_MAX_BYTES + 1;
    if (event.data.byteLength > retained - buffer.length) {
      finish("28P01");
      return;
    }
    bytes += event.data.byteLength;
    const chunk = new Uint8Array(event.data),
      joined = new Uint8Array(buffer.length + chunk.length);
    joined.set(buffer);
    joined.set(chunk, buffer.length);
    buffer = joined;
    ctx.waitUntil(drain());
  }
  socket.addEventListener("message", message);
  socket.addEventListener("close", close);
  socket.addEventListener("error", close);
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  return new Response(null, { status: 101, webSocket: pair[0] });
}
