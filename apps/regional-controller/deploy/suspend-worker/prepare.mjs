// SPDX-License-Identifier: Apache-2.0
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { isIP } from "node:net";
import { dirname, join } from "node:path";

const privateDirectory = "/private/pgcf";
const journalDirectory = "/var/lib/pgcf/suspend";
const configurationPath = `${privateDirectory}/suspend.json`;
const kubeconfigPath = `${privateDirectory}/kubeconfig.json`;
const tokenPath = "/var/run/pgcf-kubernetes/token";
const caPath = "/var/run/pgcf-kubernetes/ca.crt";
const expectedConfiguration = {
  schemaVersion: 1,
  kubeconfigFile: kubeconfigPath,
  kubeconfigContext: "pgcf-suspend-worker",
  journalDirectory,
};

function fail() {
  throw new Error("suspend_worker_initialization_failed");
}
function missing(error) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
function privateEntry(info, directory) {
  if (
    info.isSymbolicLink() ||
    (directory ? !info.isDirectory() : !info.isFile()) ||
    (info.mode & 0o777) !== (directory ? 0o700 : 0o600) ||
    info.uid !== process.getuid()
  )
    fail();
}
function syncDirectory(path) {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}
function ensurePrivateDirectory(path) {
  try {
    privateEntry(lstatSync(path), true);
    return;
  } catch (error) {
    if (!missing(error)) throw error;
  }
  const parent = lstatSync(dirname(path));
  // Only this Pod's isolated memory emptyDir has a kubelet-owned sticky root.
  // Trusted sequential init creates the child; the worker mounts it read-only.
  // This exception never applies to persistent journal storage.
  const isolatedBootstrapParent =
    path === privateDirectory &&
    dirname(path) === "/private" &&
    parent.uid === 0 &&
    parent.gid === 1000 &&
    (parent.mode & 0o7777) === 0o3777;
  if (
    parent.isSymbolicLink() ||
    !parent.isDirectory() ||
    ((parent.mode & 0o002) !== 0 && !isolatedBootstrapParent) ||
    ![0, process.getuid()].includes(parent.uid) ||
    ((parent.mode & 0o020) !== 0 && parent.gid !== process.getgid())
  )
    fail();
  mkdirSync(path, { mode: 0o700 });
  privateEntry(lstatSync(path), true);
  syncDirectory(dirname(path));
}
function writePrivateFile(path, bytes) {
  let descriptor;
  try {
    descriptor = openSync(
      path,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      0o600,
    );
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "EEXIST"
    )
      throw error;
    privateEntry(lstatSync(path), false);
    const existing = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = fstatSync(existing);
      privateEntry(info, false);
      if (
        info.size !== bytes.byteLength ||
        !readFileSync(existing).equals(bytes)
      )
        fail();
    } finally {
      closeSync(existing);
    }
    return;
  }
  try {
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
    privateEntry(fstatSync(descriptor), false);
  } finally {
    closeSync(descriptor);
  }
  syncDirectory(dirname(path));
}
function trustedConfiguration() {
  // Projected bootstrap inputs intentionally follow kubelet-owned symlinks.
  // Only the separately written output is accepted as a private regular file.
  const descriptor = openSync(
    "/bootstrap/suspend-config.json",
    constants.O_RDONLY,
  );
  let bytes;
  try {
    const info = fstatSync(descriptor);
    if (!info.isFile() || info.size > 65_536) fail();
    bytes = readFileSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  if (bytes.byteLength > 65_536) fail();
  const input = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
  );
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).length !== Object.keys(expectedConfiguration).length ||
    !Object.entries(expectedConfiguration).every(
      ([key, value]) => input[key] === value,
    )
  )
    fail();
  return bytes;
}
function serverFromKubernetesEnvironment() {
  const host = process.env.KUBERNETES_SERVICE_HOST;
  const port = process.env.KUBERNETES_SERVICE_PORT_HTTPS;
  const address =
    typeof host === "string" &&
    host.length <= 253 &&
    (isIP(host) !== 0 ||
      host
        .split(".")
        .every((label) =>
          /^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/i.test(label),
        ));
  if (
    !address ||
    typeof port !== "string" ||
    !/^[1-9][0-9]{0,4}$/.test(port) ||
    Number(port) > 65_535
  )
    fail();
  return `https://${isIP(host) === 6 ? `[${host}]` : host}:${port}`;
}
function inspectExistingJournals() {
  const names = readdirSync(journalDirectory);
  if (names.length > 100_000) fail();
  const journalName =
    /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}(?:\.retirement)?\.sqlite(?:-wal|-shm)?$/;
  for (const name of names) {
    if (!journalName.test(name)) fail();
    privateEntry(lstatSync(join(journalDirectory, name)), false);
  }
}

try {
  if (process.getuid() !== 1000 || process.getgid() !== 1000) fail();
  process.umask(0o077);
  const configuration = trustedConfiguration();
  const kubeconfig = {
    apiVersion: "v1",
    kind: "Config",
    clusters: [
      {
        name: "installation",
        cluster: {
          server: serverFromKubernetesEnvironment(),
          "certificate-authority": caPath,
          "insecure-skip-tls-verify": false,
        },
      },
    ],
    users: [
      {
        name: "suspend-worker",
        user: {
          // The pinned Kubernetes Node SDK refreshes its native file provider.
          // The generated kubeconfig contains no token or client-key contents.
          "auth-provider": {
            name: "tokenFile",
            config: { tokenFile: tokenPath },
          },
        },
      },
    ],
    contexts: [
      {
        name: expectedConfiguration.kubeconfigContext,
        context: {
          cluster: "installation",
          user: "suspend-worker",
          namespace: "pgcf-system",
        },
      },
    ],
    "current-context": expectedConfiguration.kubeconfigContext,
  };
  ensurePrivateDirectory(privateDirectory);
  ensurePrivateDirectory(journalDirectory);
  inspectExistingJournals();
  writePrivateFile(configurationPath, configuration);
  writePrivateFile(
    kubeconfigPath,
    Buffer.from(`${JSON.stringify(kubeconfig)}\n`),
  );
  process.stdout.write('{"mode":"suspend-worker-init","status":"ready"}\n');
} catch {
  // Never print input bytes, filesystem paths, raw errors or credential contents.
  process.stderr.write("suspend_worker_initialization_failed\n");
  process.exitCode = 1;
}
