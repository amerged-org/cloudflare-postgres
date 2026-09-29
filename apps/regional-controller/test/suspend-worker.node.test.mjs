// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

function installation(t) {
  const directory = mkdtempSync(join(tmpdir(), "pgcf-suspend-worker-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const configFile = join(directory, "suspend.json");
  const configuration = {
    schemaVersion: 1,
    kubeconfigFile: join(directory, "kubeconfig"),
    kubeconfigContext: "fixture-context",
    journalDirectory: join(directory, "operations"),
  };
  writeFileSync(configFile, JSON.stringify(configuration), { mode: 0o600 });
  return { directory, configFile, configuration };
}
const environment = {
  PGCF_CONTROL_ORIGIN: "https://control.example.test",
  PGCF_REGION_ID: "22222222-2222-4222-8222-222222222222",
  PGCF_REGION_TOKEN_FILE: "/private/installation/region-token",
  CLOUDFLARE_API_TOKEN: "fixture-provider-secret-must-not-be-inherited",
  CONTABO_API_PASSWORD: "fixture-provider-password-must-not-be-inherited",
  NODE_OPTIONS: "--throw-deprecation",
};
const fixtureFile = fileURLToPath(
  new URL("./fixtures/suspend-worker-child.mjs", import.meta.url),
);

test("serially supervises the fixed suspend entry point through no-work and truthful deferred stop, preserves its private seal, and refuses config replacement", async (t) => {
  const api = await import("../src/suspend-worker.ts").catch(() => null);
  assert.equal(
    typeof api?.serveSuspendWorker,
    "function",
    "persistent ordinary stop worker is missing",
  );
  const f = installation(t);
  let launches = 0,
    active = 0;
  const events = [];
  const result = await api.serveSuspendWorker(
    f.configFile,
    {
      pollMilliseconds: 1000,
      signal: new AbortController().signal,
      environment,
      log(event) {
        events.push(event);
        if (event === "suspend_worker_deferred") {
          writeFileSync(
            f.configFile,
            JSON.stringify({
              ...f.configuration,
              kubeconfigContext: "changed-backend",
            }),
            { mode: 0o600 },
          );
        }
      },
    },
    {
      spawnChild(executable, arguments_, options) {
        assert.equal(executable, process.execPath);
        assert.equal(
          arguments_[0],
          fileURLToPath(new URL("../src/main.ts", import.meta.url)),
        );
        assert.deepEqual(arguments_.slice(1), [
          "run-suspend",
          "--config",
          f.configFile,
        ]);
        assert.equal(options.detached, true);
        assert.deepEqual(options.stdio, ["ignore", "pipe", "pipe"]);
        assert.equal(options.shell, false);
        assert.deepEqual(options.env, {
          PGCF_CONTROL_ORIGIN: environment.PGCF_CONTROL_ORIGIN,
          PGCF_REGION_ID: environment.PGCF_REGION_ID,
          PGCF_REGION_TOKEN_FILE: environment.PGCF_REGION_TOKEN_FILE,
          LANG: "C.UTF-8",
          TZ: "UTC",
        });
        assert.equal(active, 0, "new work overlapped a still-running child");
        active += 1;
        launches += 1;
        const child = spawn(
          executable,
          [
            fixtureFile,
            launches === 1 ? "no-work" : "stop",
            f.configuration.journalDirectory,
          ],
          options,
        );
        child.once("close", () => {
          active -= 1;
        });
        return child;
      },
    },
  );
  assert.equal(result, 2);
  assert.equal(launches, 2);
  assert.equal(active, 0);
  assert.deepEqual(events, [
    "suspend_worker_no_work",
    "suspend_worker_deferred",
    "suspend_worker_configuration_changed",
  ]);
  assert.equal(statSync(f.configuration.journalDirectory).mode & 0o777, 0o700);
  const journalFile = join(
    f.configuration.journalDirectory,
    "88888888-8888-4888-8888-888888888888.sqlite",
  );
  assert.equal(statSync(journalFile).mode & 0o777, 0o600);
  const journal = new DatabaseSync(journalFile, { readOnly: true });
  try {
    assert.equal(
      JSON.parse(
        journal
          .prepare("SELECT payload_json FROM suspend_state WHERE name='stage'")
          .get().payload_json,
      ),
      "stopping",
    );
    assert.ok(
      journal
        .prepare("SELECT payload_json FROM suspend_state WHERE name='seal'")
        .get(),
    );
    assert.equal(
      journal
        .prepare(
          "SELECT payload_json FROM suspend_state WHERE name='observation'",
        )
        .get(),
      undefined,
    );
  } finally {
    journal.close();
  }
  assert(!JSON.stringify(events).includes("changed-backend"));
  assert.equal(
    readFileSync(f.configFile, "utf8").includes("changed-backend"),
    true,
  );
});

test("bounds raw child output and shutdown, kills its process group, and waits for actual close before returning without another child", async (t) => {
  const api = await import("../src/suspend-worker.ts").catch(() => null);
  assert.equal(
    typeof api?.serveSuspendWorker,
    "function",
    "persistent ordinary stop worker is missing",
  );
  const f = installation(t);
  const shutdown = new AbortController();
  const events = [];
  let launches = 0,
    closed = false,
    childSignal = null;
  const result = await api.serveSuspendWorker(
    f.configFile,
    {
      pollMilliseconds: 1000,
      signal: shutdown.signal,
      environment,
      log(event) {
        events.push(event);
      },
    },
    {
      spawnChild(executable, _arguments, options) {
        launches += 1;
        const child = spawn(
          executable,
          [fixtureFile, "bounded-output", f.configuration.journalDirectory],
          options,
        );
        child.stdout.once("data", () => shutdown.abort());
        void once(child, "close").then(([, signal]) => {
          closed = true;
          childSignal = signal;
        });
        return child;
      },
    },
  );
  assert.equal(result, 2);
  assert.equal(launches, 1);
  assert.equal(
    closed,
    true,
    "parent returned while submitted child was still live",
  );
  assert.equal(childSignal, "SIGKILL");
  assert(events.includes("suspend_worker_output_bound"));
  assert(!JSON.stringify(events).includes("private-child-payload"));
  assert(!JSON.stringify(events).includes("provider"));
  assert.equal(statSync(f.configuration.journalDirectory).mode & 0o777, 0o700);
});
