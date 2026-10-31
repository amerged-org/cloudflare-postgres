-- SPDX-License-Identifier: Apache-2.0
-- When a webhook was last tested: a test sends a real request to a third party, so it is throttled.
ALTER TABLE webhook_subscriptions ADD COLUMN last_tested_at TEXT;
