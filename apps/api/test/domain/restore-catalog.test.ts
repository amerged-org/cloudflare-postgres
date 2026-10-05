// SPDX-License-Identifier: Apache-2.0
import { expect, it } from "vitest";
import { parseBackupInfo } from "../../src/domain/restore-catalog.ts";
it("reads actual Barman backup.info without a serialized backup ID", () => {
  const id = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15),
    time = new Date(Date.now() - 10000).toISOString(),
    wal = "00000001" + "0".repeat(15) + "1";
  const text = `status=DONE\nbegin_time=${time}\nend_time=${time}\nbegin_wal=${wal}\nend_wal=${wal}\nxlog_segment_size=16777216\n`;
  expect(parseBackupInfo(text, id)).not.toBeNull();
  expect(parseBackupInfo(text + "status=DONE\n", id)).toBeNull();
});
