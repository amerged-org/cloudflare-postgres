// SPDX-License-Identifier: Apache-2.0
// Test-only: the harness cannot route a Worker's global fetch to a fixture, so this entry sends what
// the Edge fetches over the public network to the fixture gateway behind `GATEWAY`, as an outbound
// service does. A route to a gateway with no service binding is then observable. No admission logic.
import rust from "../build/worker/shim.mjs";
export default class PublicGateway extends rust {
  async fetch(request: Request) {
    const gateway = (this.env as { GATEWAY: Fetcher }).GATEWAY;
    globalThis.fetch = ((outgoing: Request) =>
      gateway.fetch(outgoing)) as typeof fetch;
    return super.fetch(request);
  }
}
