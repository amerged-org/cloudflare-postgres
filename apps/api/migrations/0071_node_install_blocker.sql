-- SPDX-License-Identifier: Apache-2.0
-- Contract: why an audited server has not been sent its installer yet (plan 9.2). AddNode checks
-- the node firewall before the rescue and records `node_firewall_unconfirmed` while it is not
-- confirmed; the next pass asks again, and the start of the installation, a failure and a
-- cancellation clear it. The column stands apart from `failure_code`, which ends the addition and
-- whose CHECK cannot grow without rebuilding a table that others reference.
ALTER TABLE node_additions ADD COLUMN install_blocker TEXT
  CHECK (install_blocker IS NULL OR install_blocker IN('node_firewall_unconfirmed'));
