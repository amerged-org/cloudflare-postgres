// SPDX-License-Identifier: Apache-2.0
// Node-side test transport: identity responses come from the real relay HTTP server.
import { once } from "node:events";
import { get, type IncomingMessage, type ServerResponse } from "node:http";
import { createBootstrapRelay } from "../../regional/src/bootstrap-relay.ts";
import { importBootstrapVerificationKeys } from "@pgcf/contracts/bootstrap-relay";

export function thinRelayRuntime(publicKeys: Record<string, string>) {
  const runtimes = new Map<
    string,
    Promise<{
      relay: ReturnType<typeof createBootstrapRelay>;
      port: number;
      requests: number;
      waiting: boolean;
      hold?: Promise<void>;
      release?: () => void;
    }>
  >();
  async function runtime(region: string) {
    let pending = runtimes.get(region);
    if (!pending) {
      pending = (async () => {
        const relay = createBootstrapRelay({
          region,
          issuerRegion: region,
          allowedTargetRegions: [region],
          host: "127.0.0.1",
          port: 0,
          keys: await importBootstrapVerificationKeys(publicKeys),
        });
        relay.server.listen(0, "127.0.0.1");
        await once(relay.server, "listening");
        const address = relay.server.address();
        if (!address || typeof address === "string")
          throw new Error("relay_address");
        return { relay, port: address.port, requests: 0, waiting: false };
      })();
      runtimes.set(region, pending);
    }
    return pending;
  }
  return {
    node: async (request: IncomingMessage, response: ServerResponse) => {
      try {
        const url = new URL(request.url!, "http://relay.test"),
          region = request.headers.host!.split(".")[0]!,
          state = await runtime(region);
        if (url.pathname === "/fixture/hold") {
          state.hold = new Promise<void>((resolve) => {
            state.release = resolve;
          });
        } else if (url.pathname === "/fixture/release") {
          state.release?.();
          delete state.hold;
          delete state.release;
        } else if (url.pathname === "/fixture/close") {
          state.release?.();
          await state.relay.close();
          runtimes.delete(region);
        } else if (url.pathname !== "/fixture/status") {
          const result = await new Promise<{ status: number; body: Buffer }>(
            (resolve, reject) => {
              const forwarded = get(
                { hostname: "127.0.0.1", port: state.port, path: url.pathname },
                (upstream) => {
                  const chunks: Buffer[] = [];
                  upstream.on("data", (chunk: Buffer) => chunks.push(chunk));
                  upstream.once("error", reject);
                  upstream.once("end", () =>
                    resolve({
                      status: upstream.statusCode!,
                      body: Buffer.concat(chunks),
                    }),
                  );
                },
              );
              forwarded.once("error", reject);
            },
          );
          state.requests++;
          if (state.hold) {
            state.waiting = true;
            await state.hold;
            state.waiting = false;
          }
          response.writeHead(result.status, {
            "Content-Type": "application/json",
          });
          response.end(result.body);
          return;
        }
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            requests: state.requests,
            waiting: state.waiting,
            identity: state.relay.identity,
          }),
        );
      } catch {
        response.writeHead(500);
        response.end();
      }
    },
  };
}
