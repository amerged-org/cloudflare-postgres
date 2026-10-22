// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { gunzipSync } from "node:zlib";
import { bootCredentials, parseResults, passed, smbiosBudget, smbiosCredential, smbiosSize } from "./boot-test.ts";

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

test("the credentials of the boot test fit the SMBIOS space QEMU gives them", async () => {
  const guest = await readFile(join(import.meta.dirname, "boot-test", "guest.sh"), "utf8");
  const size = smbiosSize(bootCredentials(guest));
  assert.ok(size <= smbiosBudget, `the credentials take ${size} bytes of SMBIOS, the budget is ${smbiosBudget}`);
});

test("the guest gets the test script whole: the credential is its gzip, which the unit decompresses", async () => {
  const guest = await readFile(join(import.meta.dirname, "boot-test", "guest.sh"), "utf8");
  const credential = bootCredentials(guest).find((candidate) => candidate.startsWith("io.systemd.credential.binary:pgcf.boot-test="));
  assert.ok(credential);
  const bytes = Buffer.from(credential.slice(credential.indexOf("=") + 1), "base64");
  assert.equal(gunzipSync(bytes).toString("utf8"), guest);
  const unit = bootCredentials(guest).find((candidate) => candidate.includes("systemd.extra-unit.pgcf-boot-test.service="));
  assert.ok(unit);
  const text = Buffer.from(unit.slice(unit.indexOf("=") + 1), "base64").toString("utf8");
  assert.match(text, /^ExecStart=.*gzip --decompress --stdout %d\/pgcf\.boot-test /m);
});
