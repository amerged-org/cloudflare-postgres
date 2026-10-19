-- SPDX-License-Identifier: Apache-2.0
-- Contract: what a node's credentials say of the operator shell (plan 8): `off`, `on` (the shell
-- hostname without a CA key) or `on <ssh-ed25519 key line>`. A node learns of a change of the
-- Worker variables NODE_SHELL_HOSTNAME and NODE_SSH_USER_CA_PUBLIC_KEY only by reading its
-- credentials again, and it reads them again only when the revision rises. The desired page
-- compares this column with what the Worker's variables say now and, when they differ, writes the
-- new state and raises `credentials_revision` once.
ALTER TABLE nodes ADD COLUMN shell_state TEXT NOT NULL DEFAULT 'off'
  CHECK(shell_state='off' OR shell_state='on' OR (length(shell_state)=83 AND shell_state GLOB 'on ssh-ed25519 *'));
