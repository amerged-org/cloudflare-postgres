// SPDX-License-Identifier: Apache-2.0
import { createApp } from "./app.ts";
import type { Env } from "./env.ts";

const app = createApp();

export default {
  fetch: app.fetch,
} satisfies ExportedHandler<Env>;
