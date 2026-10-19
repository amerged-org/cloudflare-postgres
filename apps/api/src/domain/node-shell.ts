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

/**
 * The credentials revision a node's page names. A node reads its credentials again only when the
 * revision rises, and a change of the shell's variables changes nothing in D1, so the first page
 * built after the change records the new state and raises the revision once. A request that finds
 * the state already moved reads the revision the other one wrote.
 */
export async function shellCredentialsRevision(
  env: Env,
  node: {
    id: string;
    uid: string;
    credentials_revision: number;
    shell_state: string;
  },
): Promise<number> {
  const { state } = nodeShell(env);
  if (node.shell_state === state) return node.credentials_revision;
  const raised = await env.DB.prepare(
    `UPDATE nodes SET credentials_revision=credentials_revision+1,shell_state=?,updated_at=?
     WHERE id=? AND node_uid=? AND shell_state=? RETURNING credentials_revision`,
  )
    .bind(state, new Date().toISOString(), node.id, node.uid, node.shell_state)
    .first<{ credentials_revision: number }>();
  if (raised !== null) return raised.credentials_revision;
  const current = await env.DB.prepare(
    "SELECT credentials_revision FROM nodes WHERE id=? AND node_uid=?",
  )
    .bind(node.id, node.uid)
    .first<{ credentials_revision: number }>();
  return current?.credentials_revision ?? node.credentials_revision;
}
