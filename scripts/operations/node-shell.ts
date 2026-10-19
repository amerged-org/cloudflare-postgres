// SPDX-License-Identifier: Apache-2.0
// Opens the operator shell of a node (ULTRA plan 8): a real root shell for the fix-until-it-works
// loop, for acceptance tests that inject faults, and for an exceptional manual update. The shell
// is off unless the API Worker's NODE_SHELL_HOSTNAME is "true" and the Worker holds your CA's
// public key (docs/operations/operator-installation.md, "Using the shell").
//
//   node scripts/operations/node-shell.ts --node nod_... --domain DOMAIN --label NAME [-- COMMAND ...]
//        [--ca-key-env VARIABLE] [--token-id-env VARIABLE] [--token-secret-env VARIABLE]
//
//   --node, --domain  the node and NODE_GATEWAY_DOMAIN: the shell is pgcf-shell-<id>.DOMAIN.
//   --label           who is asking, `[a-z0-9._-]` up to 32 characters. The certificate's key id is
//                     pgcf-shell-<UTC date>-<label>, which sshd writes to the node's journal.
//   -- COMMAND ...    one command, which ssh joins with spaces and the node's shell parses: give
//                     it as one quoted string. Without it, an interactive session.
//
// Nothing secret is an argument. The three variables below (or the ones the --*-env options name)
// hold what is needed, and an error names a variable, never what it held:
//   PGCF_SHELL_CA_KEY               the path of the private key of the CA whose public key the
//                                   Worker holds. The file must be yours alone (mode 0600): a CA
//                                   key that group or others can read is refused. A key with a
//                                   passphrase is asked for on your terminal by ssh-keygen itself.
//   PGCF_SHELL_ACCESS_CLIENT_ID     the client id and secret of the shell's Access service token
//   PGCF_SHELL_ACCESS_CLIENT_SECRET (`setup-access.ts --shell-service-token` writes both to a file
//                                   that `set -a; . FILE; set +a` loads).
//
// What it does: a throwaway ed25519 key pair in a directory only you can enter; ssh-keygen signs
// its public key with the CA for the principal pgcf-break-glass, a key id of the date and your
// label, and 15 minutes (one minute earlier at the start, for clock skew), with no permission but
// a terminal; ssh then goes through `cloudflared access ssh`, which presents the service token
// through its environment (never a command line), as root. The directory is deleted when ssh ends,
// however it ends, and a signal ends what runs and the directory goes too. Without a certificate nothing logs in, and this one is useless after 15 minutes.
//
// The node's host key is made at its first boot, so ssh trusts it on first use
// (StrictHostKeyChecking=accept-new, in your known_hosts): after a reinstall, remove the old line.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { NODE_ID_PATTERN } from "../../packages/contracts/src/ids.ts";
import { nodeShellHostname } from "../../packages/contracts/src/nodes.ts";

/** The one principal `/etc/ssh/principals/root` of the node image lists. */
export const SHELL_PRINCIPAL = "pgcf-break-glass";
/** From a minute ago, for clocks that differ, to 15 minutes after signing. */
export const CERTIFICATE_VALIDITY = "-1m:+15m";
/** No permission but a terminal: no forwarding, no `~/.ssh/rc`. */
export const CERTIFICATE_OPTIONS = ["clear", "permit-pty"] as const;
export const DEFAULTS = {
  caKeyEnv: "PGCF_SHELL_CA_KEY",
  tokenIdEnv: "PGCF_SHELL_ACCESS_CLIENT_ID",
  tokenSecretEnv: "PGCF_SHELL_ACCESS_CLIENT_SECRET",
} as const;

const DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;
const LABEL = /^[a-z0-9][a-z0-9._-]{0,31}$/;
const VARIABLE = /^[A-Z_][A-Z0-9_]{0,63}$/;
const CREDENTIAL = /^[A-Za-z0-9._-]{1,256}$/;
const PROGRAM = /^[A-Za-z0-9_./-]+$/;
const USAGE =
  "usage: node-shell.ts --node nod_... --domain DOMAIN --label NAME [--ca-key-env VARIABLE] " +
  "[--token-id-env VARIABLE] [--token-secret-env VARIABLE] [-- COMMAND ...]";

export interface Options {
  node: string;
  domain: string;
  label: string;
  caKeyEnv: string;
  tokenIdEnv: string;
  tokenSecretEnv: string;
  /** What runs on the node; empty is an interactive session. */
  command: string[];
}

export function parseOptions(argv: string[]): Options {
  const end = argv.indexOf("--");
  const { values, positionals } = parseArgs({
    args: end < 0 ? argv : argv.slice(0, end),
    allowPositionals: true,
    options: {
      node: { type: "string" },
      domain: { type: "string" },
      label: { type: "string" },
      "ca-key-env": { type: "string", default: DEFAULTS.caKeyEnv },
      "token-id-env": { type: "string", default: DEFAULTS.tokenIdEnv },
      "token-secret-env": { type: "string", default: DEFAULTS.tokenSecretEnv },
    },
  });
  if (positionals.length > 0) throw new Error(USAGE);
  const { node, domain, label } = values;
  if (!node || !NODE_ID_PATTERN.test(node))
    throw new Error(`--node must be a node id. ${USAGE}`);
  if (!domain || !DOMAIN.test(domain))
    throw new Error(`--domain must be a lower-case domain. ${USAGE}`);
  if (!label || !LABEL.test(label))
    throw new Error(
      `--label must be 1 to 32 characters of a-z, 0-9, . _ -, starting with a letter or digit. ${USAGE}`,
    );
  const names = {
    caKeyEnv: values["ca-key-env"],
    tokenIdEnv: values["token-id-env"],
    tokenSecretEnv: values["token-secret-env"],
  };
  for (const [option, name] of Object.entries(names))
    if (!VARIABLE.test(name))
      throw new Error(
        `--${option} must be the name of an environment variable`,
      );
  return {
    node,
    domain,
    label,
    ...names,
    command: end < 0 ? [] : argv.slice(end + 1),
  };
}

export const shellHostname = (options: Pick<Options, "node" | "domain">) =>
  `${nodeShellHostname(options.node)}.${options.domain}`;

/** The certificate's key id: the UTC date and the operator's label, which land in the node's journal. */
export const certificateKeyId = (label: string, now: Date) =>
  `pgcf-shell-${now.toISOString().slice(0, 10)}-${label}`;

/** The arguments of the signing: the CA's key file, a key id, a public key. */
export function signingArguments(
  caKeyFile: string,
  keyId: string,
  publicKeyFile: string,
): string[] {
  return [
    "-q",
    "-s",
    caKeyFile,
    "-I",
    keyId,
    "-n",
    SHELL_PRINCIPAL,
    "-V",
    CERTIFICATE_VALIDITY,
    ...CERTIFICATE_OPTIONS.flatMap((option) => ["-O", option]),
    publicKeyFile,
  ];
}

/**
 * The arguments of ssh. The user's ssh configuration is not read, only the certificate's key is
 * offered (the node ends a login after two tries), and the connection goes through cloudflared.
 */
export function sshArguments(
  options: Options,
  files: { key: string; certificate: string },
  where: Pick<Setting, "cloudflared" | "user" | "knownHosts">,
): string[] {
  if (!PROGRAM.test(where.cloudflared))
    throw new Error(
      "cloudflared's path has characters the ProxyCommand cannot carry",
    );
  return [
    "-F",
    "/dev/null",
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    `IdentityFile=${files.key}`,
    "-o",
    `CertificateFile=${files.certificate}`,
    "-o",
    "PreferredAuthentications=publickey",
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    "ServerAliveInterval=30",
    ...(where.knownHosts === undefined
      ? []
      : ["-o", `UserKnownHostsFile=${where.knownHosts}`]),
    "-o",
    `ProxyCommand=${where.cloudflared} access ssh --hostname %h`,
    `${where.user}@${shellHostname(options)}`,
    ...(options.command.length === 0 ? [] : ["--", ...options.command]),
  ];
}

/** A CA key file only its owner can read: a regular file of yours, with no bit set for group or others. */
export async function checkCaKeyFile(
  path: string,
  variable: string,
): Promise<void> {
  const file = await stat(path).catch(() => undefined);
  if (file === undefined || !file.isFile())
    throw new Error(`${variable} does not name a file`);
  if ((file.mode & 0o077) !== 0)
    throw new Error(
      `${variable}: the CA key file is readable by group or others; make it yours alone (chmod 600)`,
    );
  if (process.getuid !== undefined && file.uid !== process.getuid())
    throw new Error(`${variable}: the CA key file is not yours`);
}

/** What the run uses of the machine and of the node; a test points these elsewhere. */
export interface Setting {
  sshKeygen: string;
  ssh: string;
  cloudflared: string;
  /** The user sshd logs in: root on a node. */
  user: string;
  /** The known_hosts file ssh uses; its default is the user's own. */
  knownHosts: string | undefined;
  /** The directory the throwaway directory is made in. */
  tmpdir: string;
  now: () => Date;
}
const SYSTEM: Setting = {
  sshKeygen: "ssh-keygen",
  ssh: "ssh",
  cloudflared: "cloudflared",
  user: "root",
  knownHosts: undefined,
  tmpdir: tmpdir(),
  now: () => new Date(),
};

/** What an environment variable holds, or an error that names the variable. */
function variable(
  environment: Record<string, string | undefined>,
  name: string,
  pattern?: RegExp,
): string {
  const value = environment[name];
  if (!value) throw new Error(`set ${name}`);
  if (pattern !== undefined && !pattern.test(value))
    throw new Error(`${name} does not hold what it should`);
  return value;
}

/**
 * ssh-keygen to its end; a failure says its status and its message without the CA key's path.
 * Signing reads the CA key through this process's terminal, so that ssh-keygen can ask for the
 * passphrase of a key that has one; making the throwaway key asks nothing.
 */
async function keygen(
  program: string,
  args: string[],
  track: (child: ChildProcess) => void,
  { hide = [], terminal = false }: { hide?: string[]; terminal?: boolean } = {},
): Promise<void> {
  const child = spawn(program, args, {
    stdio: [terminal ? "inherit" : "ignore", "ignore", "pipe"],
    windowsHide: true,
  });
  track(child);
  let said = "";
  child.stderr.on("data", (chunk: Buffer) => {
    if (said.length < 1 << 14) said += chunk.toString("utf8");
  });
  const status = await new Promise<number | null>((done, fail) => {
    child.once("error", fail);
    child.once("close", done);
  });
  if (status === 0) return;
  let message = said.trim();
  for (const secret of hide) message = message.split(secret).join("<hidden>");
  throw new Error(
    `ssh-keygen failed${status === null ? "" : ` with status ${status}`}${message ? `: ${message}` : ""}`,
  );
}

/**
 * Signs a throwaway key and opens the shell. The result is ssh's exit status. The directory with
 * the throwaway key and its certificate is deleted when this returns or throws.
 */
export async function run(
  options: Options,
  environment: Record<string, string | undefined>,
  setting: Partial<Setting> = {},
): Promise<number> {
  const p = { ...SYSTEM, ...setting };
  const caKey = resolve(variable(environment, options.caKeyEnv));
  await checkCaKeyFile(caKey, options.caKeyEnv);
  const tokenId = variable(environment, options.tokenIdEnv, CREDENTIAL);
  const tokenSecret = variable(environment, options.tokenSecretEnv, CREDENTIAL);
  const directory = await mkdtemp(join(p.tmpdir, "pgcf-shell-"));
  // A signal for this process ends the child that runs, and the directory still goes below. One
  // that comes between two children ends the next one as it starts, so that it is never lost.
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  let running: ChildProcess | undefined;
  let signalled: NodeJS.Signals | undefined;
  const track = (child: ChildProcess) => {
    running = child;
    if (signalled !== undefined) child.kill(signalled);
  };
  const forward = (signal: NodeJS.Signals) => {
    signalled = signal;
    running?.kill(signal);
  };
  for (const signal of signals) process.on(signal, forward);
  try {
    const key = join(directory, "id");
    await keygen(
      p.sshKeygen,
      ["-q", "-t", "ed25519", "-N", "", "-C", "", "-f", key],
      track,
    );
    const keyId = certificateKeyId(options.label, p.now());
    await keygen(
      p.sshKeygen,
      signingArguments(caKey, keyId, `${key}.pub`),
      track,
      { hide: [caKey], terminal: true },
    );
    process.stderr.write(
      `node-shell: certificate ${keyId} valid 15 minutes; connecting to ${shellHostname(options)}\n`,
    );
    const childEnvironment: NodeJS.ProcessEnv = { ...process.env };
    for (const name of [
      options.caKeyEnv,
      options.tokenIdEnv,
      options.tokenSecretEnv,
    ])
      delete childEnvironment[name];
    childEnvironment.TUNNEL_SERVICE_TOKEN_ID = tokenId;
    childEnvironment.TUNNEL_SERVICE_TOKEN_SECRET = tokenSecret;
    const ssh = spawn(
      p.ssh,
      sshArguments(options, { key, certificate: `${key}-cert.pub` }, p),
      { stdio: "inherit", env: childEnvironment },
    );
    track(ssh);
    return await new Promise<number>((done, fail) => {
      ssh.once("error", fail);
      ssh.once("close", (code, signal) =>
        done(code ?? (signal === null ? 1 : 128)),
      );
    });
  } finally {
    for (const signal of signals) process.off(signal, forward);
    await rm(directory, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  (async () => {
    process.exitCode = await run(
      parseOptions(process.argv.slice(2)),
      process.env,
    );
  })().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "failed");
    process.exitCode = 1;
  });
}
