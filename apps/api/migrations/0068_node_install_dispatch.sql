-- SPDX-License-Identifier: Apache-2.0
-- Contract: AddNode starts the install of an audited server (plan 9.2). The rescue that carries
-- the installer is claimed before it is sent and never sent twice for the same tokens, and an
-- instance that did not leave rescue after the installer's reboot is restarted once.
ALTER TABLE node_installs ADD COLUMN rescue_requested_at TEXT;
ALTER TABLE node_installs ADD COLUMN restart_requested_at TEXT;
