// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { newNodeId } from "../../packages/contracts/src/ids.ts";
import {
  CERTIFICATE_OPTIONS,
  CERTIFICATE_VALIDITY,
  SHELL_PRINCIPAL,
  certificateKeyId,
  checkCaKeyFile,
  parseOptions,
  run,
  shellHostname,
  signingArguments,
  sshArguments,
  type Options,
} from "./node-shell.ts";

const NODE = newNodeId();
const DOMAIN = "nodes.example.org";
const NOW = new Date("2026-10-19T12:00:00.000Z");
const TOKEN_ID = "client-id-for-the-test.access";
const TOKEN_SECRET = "s".repeat(64);

const options = (...extra: string[]): Options =>
  parseOptions([
    "--node",
    NODE,
    "--domain",
    DOMAIN,
    "--label",
    "sebastian",
    ...extra,
  ]);

/** A directory only its owner can enter, removed after the test. */
async function directory(t: {
  after: (cleanup: () => Promise<void>) => void;
}): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "pgcf-node-shell-test-"));
  await chmod(path, 0o700);
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

/** A CA key pair made with the real ssh-keygen; the private key is mode 0600. */
function authority(where: string, name: string) {
  const key = join(where, name);
  execFileSync("ssh-keygen", [
    "-q",
    "-t",
    "ed25519",
    "-N",
    "",
    "-C",
    name,
    "-f",
    key,
  ]);
  const fingerprint = execFileSync("ssh-keygen", ["-l", "-f", `${key}.pub`])
    .toString()
    .split(" ")[1]!;
  return { key, publicKey: `${key}.pub`, fingerprint };
}

/**
 * A program that stands in for ssh: it records what it was given and what it could see, then
 * exits with `status`. The certificate it was handed is read with the real `ssh-keygen -L`.
 */
async function recorder(where: string, status = 0, name = "ssh") {
  const log = join(where, `${name}.log`);
  const program = join(where, `fake-${name}`);
  await writeFile(
    program,
    `#!/bin/sh
{
  for argument in "$@"; do printf 'arg:%s\\n' "$argument"; done
  printf 'token-id:%s\\n' "$TUNNEL_SERVICE_TOKEN_ID"
  printf 'token-secret:%s\\n' "$TUNNEL_SERVICE_TOKEN_SECRET"
  env | grep -E '^PGCF_SHELL_(CA_KEY|ACCESS_CLIENT_ID|ACCESS_CLIENT_SECRET)=' | sed 's/=.*//; s/^/leaked:/'
} > "${log}"
for argument in "$@"; do
  case "$argument" in
    IdentityFile=*) key="\${argument#IdentityFile=}" ;;
    CertificateFile=*) certificate="\${argument#CertificateFile=}" ;;
  esac
done
[ -f "$key" ] && echo "key-present" >> "${log}"
case "$(ls -l "$key")" in -rw-------*) echo "key-private" >> "${log}" ;; esac
ssh-keygen -L -f "$certificate" >> "${log}"
exit ${status}
`,
    { mode: 0o755 },
  );
  return { program, log };
}

const ENVIRONMENT = (ca: string) => ({
  PGCF_SHELL_CA_KEY: ca,
  PGCF_SHELL_ACCESS_CLIENT_ID: TOKEN_ID,
  PGCF_SHELL_ACCESS_CLIENT_SECRET: TOKEN_SECRET,
});

test("the command line names the node, the domain and the operator, and takes a command after --", () => {
  const interactive = options();
  assert.deepEqual(interactive, {
    node: NODE,
    domain: DOMAIN,
    label: "sebastian",
    caKeyEnv: "PGCF_SHELL_CA_KEY",
    tokenIdEnv: "PGCF_SHELL_ACCESS_CLIENT_ID",
    tokenSecretEnv: "PGCF_SHELL_ACCESS_CLIENT_SECRET",
    command: [],
  });
  assert.equal(
    shellHostname(interactive),
    `pgcf-shell-${NODE.slice(4)}.${DOMAIN}`,
  );
  assert.deepEqual(options("--", "journalctl", "-u", "ssh").command, [
    "journalctl",
    "-u",
    "ssh",
  ]);
  // What follows -- is the command's, whatever it looks like.
  assert.deepEqual(options("--", "--node", "x").command, ["--node", "x"]);
  const named = options(
    "--ca-key-env",
    "MY_CA",
    "--token-id-env",
    "MY_ID",
    "--token-secret-env",
    "MY_SECRET",
  );
  assert.deepEqual(
    [named.caKeyEnv, named.tokenIdEnv, named.tokenSecretEnv],
    ["MY_CA", "MY_ID", "MY_SECRET"],
  );
  for (const bad of [
    ["--node", "nod_short"],
    ["--domain", "Nodes.Example.Org"],
    ["--label", "Seb"],
    ["--label", "-x"],
    ["--label", "x".repeat(33)],
    ["--ca-key-env", "lower"],
    ["--ca-key-env", "A=B"],
    ["--token-secret-env", "$(id)"],
  ])
    assert.throws(() => options(...bad), /--/, bad.join(" "));
  assert.throws(() => options("stray"), /usage/);
  assert.throws(
    () => parseOptions(["--domain", DOMAIN, "--label", "x"]),
    /--node/,
  );
  // Nothing secret has an option of its own: only names of variables.
  assert.throws(() => options("--ca-key", "/tmp/ca"), /unknown option/i);
  assert.throws(() => options("--token-secret", "x"), /unknown option/i);
});

test("the certificate is for the one principal, for the operator and the day, for 15 minutes and for a terminal only", () => {
  assert.equal(SHELL_PRINCIPAL, "pgcf-break-glass");
  assert.equal(
    certificateKeyId("sebastian", NOW),
    "pgcf-shell-2026-10-19-sebastian",
  );
  assert.deepEqual(
    signingArguments("/ca/key", "pgcf-shell-2026-10-19-sebastian", "/t/id.pub"),
    [
      "-q",
      "-s",
      "/ca/key",
      "-I",
      "pgcf-shell-2026-10-19-sebastian",
      "-n",
      "pgcf-break-glass",
      "-V",
      "-1m:+15m",
      "-O",
      "clear",
      "-O",
      "permit-pty",
      "/t/id.pub",
    ],
  );
  assert.equal(CERTIFICATE_VALIDITY, "-1m:+15m");
  assert.deepEqual([...CERTIFICATE_OPTIONS], ["clear", "permit-pty"]);
});

test("ssh reads no configuration, offers one key and goes through cloudflared, and no secret is on its command line", () => {
  const files = { key: "/t/id", certificate: "/t/id-cert.pub" };
  const where = {
    cloudflared: "cloudflared",
    user: "root",
    knownHosts: undefined,
  };
  const args = sshArguments(options(), files, where);
  assert.deepEqual(args, [
    "-F",
    "/dev/null",
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "IdentityFile=/t/id",
    "-o",
    "CertificateFile=/t/id-cert.pub",
    "-o",
    "PreferredAuthentications=publickey",
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    "ServerAliveInterval=30",
    "-o",
    "ProxyCommand=cloudflared access ssh --hostname %h",
    `root@pgcf-shell-${NODE.slice(4)}.${DOMAIN}`,
  ]);
  // A command follows the destination after --, as separate arguments.
  assert.deepEqual(
    sshArguments(options("--", "ls", "-l"), files, where).slice(-4),
    [`root@pgcf-shell-${NODE.slice(4)}.${DOMAIN}`, "--", "ls", "-l"],
  );
  assert.throws(
    () =>
      sshArguments(options(), files, {
        ...where,
        cloudflared: "/a b/cloudflared",
      }),
    /ProxyCommand/,
  );
});

test("a CA key that group or others can read, or that is not a file of yours, is refused by the variable's name", async (t) => {
  const where = await directory(t);
  const path = join(where, "ca");
  await writeFile(path, "not a key", { mode: 0o600 });
  await checkCaKeyFile(path, "PGCF_SHELL_CA_KEY");
  for (const mode of [0o640, 0o604, 0o644, 0o660, 0o666, 0o707]) {
    await chmod(path, mode);
    await assert.rejects(
      checkCaKeyFile(path, "PGCF_SHELL_CA_KEY"),
      (error: Error) =>
        /PGCF_SHELL_CA_KEY.*group or others/.test(error.message) &&
        !error.message.includes(path),
      mode.toString(8),
    );
  }
  await assert.rejects(
    checkCaKeyFile(where, "PGCF_SHELL_CA_KEY"),
    /does not name a file/,
  );
  await assert.rejects(
    checkCaKeyFile(join(where, "missing"), "PGCF_SHELL_CA_KEY"),
    (error: Error) => !error.message.includes(where),
  );
});

test("a certificate for the node is signed by the CA with the principal, the key id and 15 minutes, and handed to ssh with the token in its environment only", async (t) => {
  const where = await directory(t),
    scratch = join(where, "scratch");
  await mkdir(scratch, { mode: 0o700 });
  const ca = authority(where, "ca");
  const fake = await recorder(where);
  // The variables are in this process's environment, as they are for the operator: ssh must not inherit them.
  Object.assign(process.env, ENVIRONMENT(ca.key));
  t.after(() => {
    for (const name of Object.keys(ENVIRONMENT(ca.key)))
      delete process.env[name];
  });
  const status = await run(options("--", "uptime"), process.env, {
    ssh: fake.program,
    tmpdir: scratch,
    now: () => NOW,
    knownHosts: join(where, "known_hosts"),
  });
  assert.equal(status, 0);
  const log = await readFile(fake.log, "utf8");
  const args = log
    .split("\n")
    .filter((line) => line.startsWith("arg:"))
    .map((line) => line.slice(4));
  assert.deepEqual(args.slice(-3), [
    `root@pgcf-shell-${NODE.slice(4)}.${DOMAIN}`,
    "--",
    "uptime",
  ]);
  // ssh was started while the throwaway key was there, mode 0600, and the CA's certificate on it.
  assert.ok(log.includes("key-present\n") && log.includes("key-private\n"));
  assert.match(log, /Type: ssh-ed25519-cert-v01@openssh\.com user certificate/);
  assert.ok(log.includes(`Signing CA: ED25519 ${ca.fingerprint}`));
  assert.ok(log.includes('Key ID: "pgcf-shell-2026-10-19-sebastian"'));
  assert.match(log, /Principals:\s*\n\s+pgcf-break-glass\n/);
  assert.match(log, /Critical Options: \(none\)/);
  assert.match(log, /Extensions:\s*\n\s+permit-pty\n/);
  // 15 minutes from signing (and a minute of skew before it), by the clock of this test.
  const valid = /Valid: from (\S+) to (\S+)/.exec(log)!;
  const [from, to] = [valid[1]!, valid[2]!].map((time) =>
    new Date(`${time}`).getTime(),
  );
  assert.ok(
    Math.abs(to! - Date.now() - 15 * 60_000) < 90_000,
    "expires about 15 minutes after signing",
  );
  assert.ok(
    Math.abs(to! - from! - 16 * 60_000) <= 1_000,
    "valid from a minute earlier",
  );
  // The token is in the environment of ssh, under the names cloudflared reads, and nowhere else.
  assert.ok(log.includes(`token-id:${TOKEN_ID}\n`));
  assert.ok(log.includes(`token-secret:${TOKEN_SECRET}\n`));
  assert.ok(
    !args.some(
      (argument) =>
        argument.includes(TOKEN_SECRET) ||
        argument.includes(TOKEN_ID) ||
        argument.includes(ca.key),
    ),
  );
  assert.ok(
    !log.includes("leaked:"),
    "the variables that held the CA key and the token do not reach ssh",
  );
  // The directory of the throwaway key is gone, and nothing else was left.
  assert.deepEqual(await readdir(scratch), []);
});

test("the directory of the throwaway key goes however ssh ends, and when signing fails", async (t) => {
  const where = await directory(t),
    scratch = join(where, "scratch");
  await mkdir(scratch, { mode: 0o700 });
  const ca = authority(where, "ca");
  // ssh ends with a status of its own: it is the result, and the key is gone.
  const failing = await recorder(where, 7, "failing");
  assert.equal(
    await run(options(), ENVIRONMENT(ca.key), {
      ssh: failing.program,
      tmpdir: scratch,
    }),
    7,
  );
  assert.deepEqual(await readdir(scratch), []);
  // ssh that cannot be started.
  await assert.rejects(
    run(options(), ENVIRONMENT(ca.key), {
      ssh: join(where, "no-such-ssh"),
      tmpdir: scratch,
    }),
    /ENOENT/,
  );
  assert.deepEqual(await readdir(scratch), []);
  // A file that is not a key: ssh-keygen refuses to sign, ssh never starts, and the message hides the file's path.
  const broken = join(where, "broken");
  await writeFile(broken, "not a key\n", { mode: 0o600 });
  const never = await recorder(where, 0, "never");
  await assert.rejects(
    run(options(), ENVIRONMENT(broken), {
      ssh: never.program,
      tmpdir: scratch,
    }),
    (error: Error) =>
      /ssh-keygen failed/.test(error.message) &&
      !error.message.includes(broken),
  );
  assert.equal(existsSync(never.log), false, "ssh was not started");
  assert.deepEqual(await readdir(scratch), []);
});

test("nothing starts without the three variables, and a CA key that others can read is refused before a key is made", async (t) => {
  const where = await directory(t),
    scratch = join(where, "scratch");
  await mkdir(scratch, { mode: 0o700 });
  const ca = authority(where, "ca");
  const fake = await recorder(where);
  const setting = { ssh: fake.program, tmpdir: scratch };
  for (const [missing, name] of [
    ["PGCF_SHELL_CA_KEY", "PGCF_SHELL_CA_KEY"],
    ["PGCF_SHELL_ACCESS_CLIENT_ID", "PGCF_SHELL_ACCESS_CLIENT_ID"],
    ["PGCF_SHELL_ACCESS_CLIENT_SECRET", "PGCF_SHELL_ACCESS_CLIENT_SECRET"],
  ] as const) {
    const environment: Record<string, string | undefined> = ENVIRONMENT(ca.key);
    delete environment[missing];
    await assert.rejects(
      run(options(), environment, setting),
      new RegExp(`set ${name}`),
    );
  }
  // A secret that is not what Cloudflare issues is refused without being quoted.
  await assert.rejects(
    run(
      options(),
      { ...ENVIRONMENT(ca.key), PGCF_SHELL_ACCESS_CLIENT_SECRET: "a b\nc" },
      setting,
    ),
    (error: Error) =>
      /PGCF_SHELL_ACCESS_CLIENT_SECRET does not hold/.test(error.message) &&
      !error.message.includes("a b"),
  );
  await chmod(ca.key, 0o640);
  await assert.rejects(
    run(options(), ENVIRONMENT(ca.key), setting),
    /group or others/,
  );
  assert.deepEqual(await readdir(scratch), []);
  assert.equal(existsSync(fake.log), false);
});

// ---------- A real sshd, set up as the node's drop-in does ----------

const SSHD = [
  "/usr/sbin/sshd",
  "/usr/local/sbin/sshd",
  "/opt/homebrew/sbin/sshd",
].find(existsSync);

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as { port: number };
  await new Promise((done) => server.close(done));
  return port;
}
async function listening(port: number, child: ChildProcess): Promise<boolean> {
  for (let attempt = 0; attempt < 100 && child.exitCode === null; attempt++) {
    const open = await new Promise<boolean>((done) => {
      const socket = connect(port, "127.0.0.1");
      socket.once("connect", () => socket.destroy() && done(true));
      socket.once("error", () => done(false));
    });
    if (open) return true;
    await new Promise((done) => setTimeout(done, 50));
  }
  return false;
}

test(
  "a real sshd that trusts the CA lets the certificate in, writes its key id and the CA's fingerprint to the log, and refuses another CA's",
  {
    skip: SSHD === undefined ? "no sshd on this machine" : false,
  },
  async (t) => {
    const where = await directory(t);
    const ca = authority(where, "ca"),
      stranger = authority(where, "stranger");
    execFileSync("ssh-keygen", [
      "-q",
      "-t",
      "ed25519",
      "-N",
      "",
      "-f",
      join(where, "host"),
    ]);
    await writeFile(
      join(where, "principals"),
      `# SPDX-License-Identifier: Apache-2.0\n${SHELL_PRINCIPAL}\n`,
    );
    const port = await freePort();
    // The directives of infra/node-image's drop-in that decide a login, run as the current user.
    await writeFile(
      join(where, "sshd_config"),
      [
        `ListenAddress 127.0.0.1`,
        `Port ${port}`,
        `HostKey ${join(where, "host")}`,
        `PidFile ${join(where, "sshd.pid")}`,
        `UsePAM no`,
        `StrictModes no`,
        `PasswordAuthentication no`,
        `KbdInteractiveAuthentication no`,
        `AuthenticationMethods publickey`,
        `AuthorizedKeysFile none`,
        `TrustedUserCAKeys ${ca.publicKey}`,
        `AuthorizedPrincipalsFile ${join(where, "principals")}`,
        `MaxAuthTries 2`,
        `LogLevel VERBOSE`,
        ``,
      ].join("\n"),
    );
    const log = join(where, "sshd.log");
    const sshd = spawn(
      SSHD!,
      ["-D", "-f", join(where, "sshd_config"), "-E", log],
      { stdio: "ignore" },
    );
    t.after(() => void sshd.kill());
    if (!(await listening(port, sshd)))
      return t.skip("sshd could not be started here");
    // The stand-in for cloudflared carries the connection to the sshd above.
    const cloudflared = join(where, "fake-cloudflared");
    await writeFile(
      cloudflared,
      `#!${process.execPath}
const socket = require("node:net").connect(${port}, "127.0.0.1");
process.stdin.pipe(socket);
socket.pipe(process.stdout);
socket.on("close", () => process.exit(0));
socket.on("error", () => process.exit(1));
`,
      { mode: 0o755 },
    );
    const user = execFileSync("id", ["-un"]).toString().trim();
    const setting = {
      cloudflared,
      user,
      knownHosts: join(where, "known_hosts"),
      now: () => NOW,
    };
    const marker = join(where, "marker");

    const accepted = await run(
      options("--", "touch", marker),
      ENVIRONMENT(ca.key),
      setting,
    );
    assert.equal(accepted, 0);
    assert.ok(existsSync(marker), "the command ran on the node");
    const journal = await readFile(log, "utf8");
    assert.ok(
      journal.includes("pgcf-shell-2026-10-19-sebastian"),
      "the key id is in the log",
    );
    assert.ok(
      journal.includes(ca.fingerprint),
      "the CA's fingerprint is in the log",
    );

    await rm(marker);
    const refused = await run(
      options("--", "touch", marker),
      ENVIRONMENT(stranger.key),
      setting,
    );
    assert.notEqual(refused, 0);
    assert.equal(existsSync(marker), false);
  },
);
