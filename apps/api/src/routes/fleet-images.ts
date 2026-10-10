// SPDX-License-Identifier: Apache-2.0
import type { ApiApp } from "../app.ts";
import { serveFleetImage } from "../domain/fleet-images.ts";

export function registerFleetImages(app: ApiApp): void {
  app.on(
    ["GET", "HEAD"],
    "/v2/",
    (c) =>
      new Response(c.req.method === "HEAD" ? null : "{}", {
        headers: {
          "Docker-Distribution-Api-Version": "registry/2.0",
          "Content-Type": "application/json",
        },
      }),
  );
  for (const [path, kind] of [
    ["/v2/pgcf-talos-installer/manifests/:digest", "manifest"],
    ["/v2/pgcf-talos-installer/blobs/:digest", "blob"],
    ["/fleet-images/v1/raw/:digest", "raw"],
  ] as const) {
    app.on(["GET", "HEAD"], path, (c) =>
      serveFleetImage(c, kind, c.req.param("digest")),
    );
    app.all(
      path,
      () =>
        new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } }),
    );
  }
}
