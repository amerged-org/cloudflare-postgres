// SPDX-License-Identifier: Apache-2.0
import { nodeShellCaPublicKey } from "@pgcf/contracts";
import type { Env } from "../env.ts";

/** What the Worker's variables say of the operator shell (ULTRA plan 8). */
export interface NodeShell {
  /** The node has a shell hostname: NODE_SHELL_HOSTNAME is exactly the string `true`. */
  hostname: boolean;
  /** The CA key nodes trust for it: only with the hostname, and only when the variable is one valid key. */
  caPublicKey: string | null;
  /** `off`, `on` or `on <key>`: what `nodes.shell_state` holds for a node that has applied it. */
  state: string;
}

export function nodeShell(
  env: Pick<Env, "NODE_SHELL_HOSTNAME" | "NODE_SSH_USER_CA_PUBLIC_KEY">,
): NodeShell {
  const hostname = env.NODE_SHELL_HOSTNAME === "true";
  const caPublicKey = hostname
    ? nodeShellCaPublicKey(env.NODE_SSH_USER_CA_PUBLIC_KEY)
    : null;
  return {
    hostname,
    caPublicKey,
    state: !hostname
      ? "off"
      : caPublicKey === null
        ? "on"
        : `on ${caPublicKey}`,
  };
}
