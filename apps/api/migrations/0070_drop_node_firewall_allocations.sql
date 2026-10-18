-- SPDX-License-Identifier: Apache-2.0
-- The installation firewall was created per node by an allocation claim that nothing called. Every
-- node sits behind the operator's one Contabo firewall instead (`CONTABO_NODE_FIREWALL_ID`, plan 8),
-- which AddNode checks and assigns before the rescue. The table's trigger goes with it.
DROP TABLE node_firewall_allocations;
