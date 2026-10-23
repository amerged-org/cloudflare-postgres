// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { gunzipSync } from "node:zlib";
import { bootCredentials, guestCredential, parseResults, passed, smbiosBudget, smbiosCredential, smbiosSize, testUnit } from "./boot-test.ts";

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

test("the guest script travels compressed: the SMBIOS table holds 65,535 bytes in all, and the script's base64 alone was cut at about 49 KiB of script", () => {
  const script = readFileSync(new URL("./boot-test/guest.sh", import.meta.url), "utf8");
  const credential = guestCredential(script);
  const encoded = credential.slice(credential.indexOf("=") + 1);
  assert.equal(gunzipSync(Buffer.from(encoded, "base64")).toString("utf8"), script);
  // Far below what one table holds, with room for the script to grow and for the other strings.
  assert.ok(credential.length < 32_000, `the credential of the guest script is ${credential.length} characters`);
  assert.match(testUnit, /gzip -dc "%d\/pgcf\.boot-test"/);
});

test("all the credentials of the boot test fit the SMBIOS space QEMU gives them", () => {
  const script = readFileSync(new URL("./boot-test/guest.sh", import.meta.url), "utf8");
  const size = smbiosSize(bootCredentials(script));
  assert.ok(size <= smbiosBudget, `the credentials take ${size} bytes of SMBIOS, the budget is ${smbiosBudget}`);
  // Each string takes its bytes and its NUL, so the runner's guard counts what the table holds.
  assert.equal(smbiosSize(["ab", "c"]), 5);
});

test("the journal probe logs as a user it makes itself, with a uid of the agent's database range", () => {
  const script = readFileSync(new URL("./boot-test/guest.sh", import.meta.url), "utf8");
  const users = readFileSync(new URL("../../apps/node-agent/src/units/users.rs", import.meta.url), "utf8");
  const first = Number(users.match(/pub const FIRST_UID: u32 = ([\d_]+);/)?.[1]?.replaceAll("_", ""));
  const count = Number(users.match(/pub const UID_COUNT: u32 = ([\d_]+);/)?.[1]?.replaceAll("_", ""));
  assert.ok(first > 65_535 && count > 0, "the agent's range was not found in units/users.rs");
  const uid = Number(script.match(/^journal_probe_uid=(\d+)$/m)?.[1]);
  // journald splits a uid from 65536 up to the container range at 524288 and keeps the system uids,
  // systemd's dynamic range and nobody in the system journal whatever SplitMode is: a uid of the
  // agent's range is split, so a line that stays in the system journal came from the configuration.
  assert.ok(uid >= first && uid < first + count, `the probe's uid ${uid} is outside ${first}-${first + count - 1}`);
  assert.ok(uid > 65_535 && uid < 524_288);
  // The scratch database's user is a system account (uid 987 in CI), which journald never splits.
  const probe = script.slice(script.indexOf("database_log_stays_in_the_system_journal() {"));
  const body = probe.slice(0, probe.indexOf("\n}\n"));
  assert.doesNotMatch(body, /\/proc\/\$pid|MainPID|pgcf-pg@/, "the probe must not take its uid from the scratch database");
  assert.match(body, /useradd -u "?\$uid"?/);
  assert.match(body, /userdel /);
});
