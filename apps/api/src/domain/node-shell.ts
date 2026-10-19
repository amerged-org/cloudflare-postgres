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
 * The credentials revision that goes with this Worker version's view of the shell, for the node's
 * page and for the credentials a node reads. A node reads its credentials again only when the
 * revision rises, and a change of the shell's variables changes nothing in D1, so the first
 * request after the change records the new state in D1 and raises the revision once. D1's state
 * and revision are one row, written in one statement, and the content a request hands out comes
 * from the variables it was given: so the revision a request names always belongs to D1 holding
 * the state of that content. While two Worker versions serve at once, each request writes the
 * state it has and the revision rises with every change of hands, which ends when the deploy has
 * spread: whichever version is left holds the last revision, with its own content.
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
  const held = await env.DB.prepare(
    `UPDATE nodes SET credentials_revision=credentials_revision+(shell_state IS NOT ?1),
       updated_at=CASE WHEN shell_state IS NOT ?1 THEN ?2 ELSE updated_at END,shell_state=?1
     WHERE id=?3 AND node_uid=?4 RETURNING credentials_revision`,
  )
    .bind(state, new Date().toISOString(), node.id, node.uid)
    .first<{ credentials_revision: number }>();
  return held?.credentials_revision ?? node.credentials_revision;
}
