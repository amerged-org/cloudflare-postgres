-- SPDX-License-Identifier: Apache-2.0
-- Contract: an administrator asks a node for one of eight read-only probes (SEC-09), the node's
-- desired page lists the request until the node answers, and the answer is kept with it. A request
-- is a row of its own and not a lifecycle order: an order is a state the node must reach, and its
-- type CHECK would need a table rebuild. `requested_by_key_id` is the API key that asked, for the
-- audit; it is no foreign key, because a key row is not the record of who asked. `received_at` and
-- `body` (the node's `NodeProbeResult`, at most 1 MiB, `NODE_PROBE_RESULT_MAX_BYTES`) are NULL
-- together until the answer arrives. A request that is unanswered 10 minutes after `requested_at`
-- (`NODE_PROBE_EXPIRY_SECONDS`) is expired: it leaves the desired page, and the API reads it as
-- such. A row older than 30 days is deleted by the next request for a probe, of any node: the
-- minute cron has no statement to spare.
CREATE TABLE node_diagnostic_requests (
  id TEXT PRIMARY KEY NOT NULL CHECK(length(id)=36),
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  probe TEXT NOT NULL CHECK(probe IN('journal','kernel','boots','failed_units','sockets','listeners','pressure','pool')),
  boot INTEGER NOT NULL CHECK(boot IN(0,-1)),
  since_seconds INTEGER NOT NULL CHECK(since_seconds BETWEEN 60 AND 86400),
  lines INTEGER NOT NULL CHECK(lines BETWEEN 1 AND 2000),
  requested_by_key_id TEXT NOT NULL CHECK(length(requested_by_key_id)=24 AND substr(requested_by_key_id,1,4)='key_'),
  requested_at TEXT NOT NULL CHECK(length(requested_at)=24 AND requested_at GLOB '????-??-??T??:??:??.???Z'),
  received_at TEXT CHECK(received_at IS NULL OR (length(received_at)=24 AND received_at GLOB '????-??-??T??:??:??.???Z')),
  body TEXT CHECK(body IS NULL OR (json_valid(body) AND length(body)<=1048576)),
  CHECK((received_at IS NULL)=(body IS NULL))
) STRICT;
CREATE INDEX node_diagnostic_requests_open_idx ON node_diagnostic_requests(node_id, requested_at, id) WHERE received_at IS NULL;
CREATE INDEX node_diagnostic_requests_age_idx ON node_diagnostic_requests(requested_at);
