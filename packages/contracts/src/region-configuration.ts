// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { Region } from "./api.ts";

function gatewayUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/** Regional gateway server accepts PostgreSQL WebSocket upgrades only at /pg. */
export const RegionGatewayUrl = z
  .url({ protocol: /^https?$/ })
  .max(2048)
  .refine((value) => {
    const url = gatewayUrl(value);
    return (
      url !== null &&
      url.pathname === "/pg" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  }, "Gateway URL must end at /pg without credentials, query or fragment");

const GatewayConfiguration = z.strictObject({
  gateway_url: RegionGatewayUrl,
  gateway_binding: Region.shape.gateway_binding,
});
export const RegionGatewayConfiguration = GatewayConfiguration.refine(
  ({ gateway_url, gateway_binding }) =>
    gateway_binding !== null || gatewayUrl(gateway_url)?.protocol === "https:",
  "Public gateways require HTTPS; HTTP requires an explicit service binding",
);

/** Ordinary routing changes cannot replace provider identity or bootstrap/archive custody. */
export const RegionConfigurationUpdate = GatewayConfiguration.extend({
  expected_configuration_sha256: z.string().regex(/^[a-f0-9]{64}$/),
})
  .refine(
    ({ gateway_url, gateway_binding }) =>
      gateway_binding !== null ||
      gatewayUrl(gateway_url)?.protocol === "https:",
    "Public gateways require HTTPS; HTTP requires an explicit service binding",
  )
  .meta({ id: "RegionConfigurationUpdate" });
export type RegionConfigurationUpdate = z.infer<
  typeof RegionConfigurationUpdate
>;

/** Readable even for legacy malformed routing, so an administrator can repair it. */
export const RegionConfiguration = z
  .strictObject({
    region: Region,
    configuration_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .meta({ id: "RegionConfiguration" });
export type RegionConfiguration = z.infer<typeof RegionConfiguration>;
