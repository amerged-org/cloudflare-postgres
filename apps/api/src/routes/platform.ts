// SPDX-License-Identifier: Apache-2.0
import type { ApiApp } from "../app.ts";

export function registerPlatform(app: ApiApp): void {
  // Track T2 owns platform route registration.
  void app;
}
