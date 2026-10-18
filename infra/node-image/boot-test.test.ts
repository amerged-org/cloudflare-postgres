// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { parseResults, passed, smbiosCredential } from "./boot-test.ts";

test("credentials travel as base64 system credentials", () => {
  assert.equal(smbiosCredential("pgcf.boot-test", "#!/bin/bash\n"), "io.systemd.credential.binary:pgcf.boot-test=IyEvYmluL2Jhc2gK");
  assert.throws(() => smbiosCredential("bad name", "x"), /invalid credential name/);
});

test("both boots must report ok and no check may fail", () => {
  const good = [
    "PGCF-BOOT-TEST check 1 ok loopback_only",
    "PGCF-BOOT-TEST phase 1 ok",
    "noise from the kernel",
    "PGCF-BOOT-TEST check 2 ok scratch_database",
    "PGCF-BOOT-TEST phase 2 ok",
  ].join("\n");
  assert.equal(passed(parseResults(good)), true);

  const secondBootMissing = "PGCF-BOOT-TEST phase 1 ok\n";
  assert.equal(passed(parseResults(secondBootMissing)), false);

  const failedCheck = parseResults(
    "PGCF-BOOT-TEST check 2 fail scratch_database\nPGCF-BOOT-TEST phase 1 ok\nPGCF-BOOT-TEST phase 2 fail 1\n",
  );
  assert.deepEqual(failedCheck.failedChecks, ["boot 2: scratch_database"]);
  assert.equal(passed(failedCheck), false);
});
