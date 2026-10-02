// SPDX-License-Identifier: Apache-2.0
import { DATABASE_ID_PATTERN } from "@pgcf/contracts";
import { createConnection, type Socket } from "node:net";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import type { DatabaseCaProvider } from "./ca.ts";

export interface DatabaseTarget {
  readonly database: string;
  readonly host: string;
  readonly port: 5432;
}
export type PostgresDial = (
  target: DatabaseTarget,
  signal: AbortSignal,
) => Promise<TLSSocket>;
export type TcpConnect = (target: DatabaseTarget) => Socket;

const sslRequest = Buffer.from([0, 0, 0, 8, 4, 210, 22, 47]);
const certificateErrors = new Set([
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "CERT_SIGNATURE_FAILURE",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

export function databaseTarget(database: string): DatabaseTarget {
  if (!DATABASE_ID_PATTERN.test(database))
    throw new Error("invalid database ID");
  return { database, host: `database-rw.pgcf-db-${database}.svc`, port: 5432 };
}

export function createPostgresDial(
  ca: DatabaseCaProvider,
  options: { tcpConnect?: TcpConnect; timeoutMs?: number } = {},
): PostgresDial {
  const tcpConnect =
    options.tcpConnect ?? ((target) => createConnection(target));
  const timeoutMs = options.timeoutMs ?? 10_000;
  return async (target, signal) => {
    const timeout = AbortSignal.timeout(timeoutMs);
    const deadline = AbortSignal.any([signal, timeout]);
    for (let attempt = 0; attempt < 2; attempt++) {
      deadline.throwIfAborted();
      const trustedCa = await abortable(
        ca.get(target.database, attempt === 1),
        deadline,
      );
      try {
        return await negotiateTls(target, trustedCa, tcpConnect, deadline);
      } catch (error) {
        if (
          attempt !== 0 ||
          !certificateErrors.has((error as NodeJS.ErrnoException).code ?? "")
        )
          throw error;
      }
    }
    throw new Error("PostgreSQL TLS negotiation failed");
  };
}

async function abortable<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", aborted));
  });
}

function negotiateTls(
  target: DatabaseTarget,
  ca: string,
  tcpConnect: TcpConnect,
  signal: AbortSignal,
): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    let socket: Socket;
    let tls: TLSSocket | undefined;
    let finished = false;
    try {
      socket = tcpConnect(target);
    } catch (error) {
      reject(error);
      return;
    }
    const cleanup = () => {
      signal.removeEventListener("abort", aborted);
      socket.removeListener("connect", connected);
      socket.removeListener("data", response);
      socket.removeListener("error", fail);
      socket.removeListener("close", closed);
      tls?.removeListener("error", fail);
      tls?.removeListener("close", closed);
    };
    const fail = (error: Error) => {
      if (finished) return;
      finished = true;
      cleanup();
      socket.destroy();
      tls?.destroy();
      reject(error);
    };
    const aborted = () => fail(new Error("PostgreSQL connection aborted"));
    const closed = () =>
      fail(new Error("PostgreSQL closed during TLS negotiation"));
    const connected = () => socket.write(sslRequest);
    const response = (chunk: Buffer) => {
      if (chunk.length !== 1 || chunk[0] !== 83) {
        fail(new Error("PostgreSQL refused TLS"));
        return;
      }
      socket.pause();
      socket.removeListener("data", response);
      try {
        tls = tlsConnect({
          socket,
          ca,
          servername: target.host,
          rejectUnauthorized: true,
          minVersion: "TLSv1.2",
        });
        tls.once("error", fail);
        tls.once("close", closed);
        tls.once("secureConnect", () => {
          if (finished) return;
          if (!tls?.authorized) {
            fail(new Error("PostgreSQL certificate verification failed"));
            return;
          }
          finished = true;
          cleanup();
          tls.pause();
          resolve(tls);
        });
      } catch (error) {
        fail(error as Error);
      }
    };
    socket.once("error", fail);
    socket.once("close", closed);
    socket.once("connect", connected);
    socket.once("data", response);
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
  });
}
