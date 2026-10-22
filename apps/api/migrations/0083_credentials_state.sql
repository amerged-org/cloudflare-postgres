-- SPDX-License-Identifier: Apache-2.0
-- Contract: what D1 holds of the route keyring a node was last handed (plan 8), as a digest and never
-- the keys: of the keyring derived for the node (its key IDs, its active key and its keys). A node
-- learns of a change of it only by reading its credentials again, and it reads them again only when
-- `credentials_revision` rises. The desired page and the credentials read compare the digest with
-- the keyring the Worker holds now and, when they differ, write it and raise `credentials_revision`
-- in one statement, as for `shell_state`. NULL is no record yet: the first request records what it
-- holds and raises nothing.
ALTER TABLE nodes ADD COLUMN route_keyring_state TEXT
  CHECK(route_keyring_state IS NULL OR length(route_keyring_state)=64);
