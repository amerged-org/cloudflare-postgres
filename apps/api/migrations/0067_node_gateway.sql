-- SPDX-License-Identifier: Apache-2.0
-- Contract: a node has its own gateway (plan 5.3, 5.8). Routes are signed with the key derived for
-- one node, so the Edge must dial the gateway of the node that serves the database; the region's
-- gateway stays the default for a node that has none. The API writes the node's when it makes the
-- node's Tunnel, at the first read of the node's credentials.
ALTER TABLE nodes ADD COLUMN gateway_url TEXT
  CHECK(gateway_url IS NULL OR (length(gateway_url) <= 2048 AND gateway_url LIKE 'https://%'));
