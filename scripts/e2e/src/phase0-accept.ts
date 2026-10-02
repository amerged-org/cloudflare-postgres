// SPDX-License-Identifier: Apache-2.0
import { pathToFileURL } from "node:url";
import { Cloudflare, Kubernetes, command } from "./clients.ts";
import {
  HarnessError,
  assertOwned,
  evidence,
  items,
  objectName,
  record,
  requireEnv,
  string,
} from "./core.ts";
import { assertClusterNodeIdentity, parseUidMap } from "./identity.ts";

export interface Check {
  name: string;
  pass: boolean;
  names: string[];
  count: number;
}
export interface InventoryItem {
  kind: string;
  name: string;
}

const TARGET_PREFIXES = [
  "apps/api/",
  "apps/edge/",
  "apps/regional/",
  "apps/node-bootstrap/",
  "packages/contracts/",
  "scripts/e2e/",
  "infra/talos/",
  "infra/platform/",
  "infra/backups/",
  "docs/operations/",
  ".github/",
];
const TARGET_FILES = new Set([
  "AGENTS.md",
  "PLAN.md",
  "README.md",
  "THIRD_PARTY.md",
  "LICENSE",
  "NOTICE",
  ".gitignore",
  ".prettierignore",
  "eslint.config.mjs",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.base.json",
  "infra/README.md",
  "infra/versions.lock.json",
]);

export function checkLayout(files: readonly string[]): Check {
  const invalid = files.filter(
    (file) =>
      (!TARGET_FILES.has(file) &&
        !TARGET_PREFIXES.some((prefix) => file.startsWith(prefix))) ||
      /(?:^|\/)\.env|\.dev\.vars|\.private\.|(?:kubeconfig|talosconfig)$|\.(?:pem|key)$/.test(
        file,
      ),
  );
  return {
    name: "layout",
    pass: invalid.length === 0,
    names: invalid,
    count: files.length,
  };
}

export function checkGitTopology(worktrees: string, branches: string): Check {
  const paths = worktrees
    .split("\n")
    .filter((line) => line.startsWith("worktree "));
  const branchRefs = worktrees
    .split("\n")
    .filter((line) => line.startsWith("branch "));
  const localBranches = branches.trim().split("\n").filter(Boolean);
  return {
    name: "git_topology",
    pass:
      paths.length === 1 &&
      branchRefs.length === 1 &&
      branchRefs[0] === "branch refs/heads/main" &&
      localBranches.length === 1 &&
      localBranches[0] === "main",
    names: localBranches,
    count: paths.length,
  };
}

export function checkCloudflareInventory(
  inventory: readonly InventoryItem[],
  allowed: readonly InventoryItem[],
): Check {
  for (const item of allowed) assertOwned(item.name);
  const keys = new Set(allowed.map((i) => `${i.kind}:${i.name}`));
  const stale = inventory.filter(
    (i) => i.name.startsWith("pgcf-") && !keys.has(`${i.kind}:${i.name}`),
  );
  return {
    name: "cloudflare_inventory",
    pass: stale.length === 0,
    names: stale.map((i) => i.name),
    count: inventory.filter((i) => i.name.startsWith("pgcf-")).length,
  };
}

export function checkReady(
  value: unknown,
  kind: "nodes" | "releases",
  expected: readonly string[],
): Check {
  const rows = items(value).filter((row) => expected.includes(objectName(row)));
  const ready = rows.filter((row) => {
    const status = record(row.status);
    return (
      Array.isArray(status.conditions) &&
      status.conditions
        .map(record)
        .some((c) => c.type === "Ready" && c.status === "True") &&
      (kind === "nodes" ||
        status.observedGeneration === record(row.metadata).generation)
    );
  });
  return {
    name: kind,
    pass:
      expected.length > 0 &&
      rows.length === expected.length &&
      ready.length === expected.length &&
      new Set(rows.map(objectName)).size === expected.length,
    names: ready.map(objectName),
    count: ready.length,
  };
}

export async function cloudflareInventory(
  cf: Cloudflare,
): Promise<InventoryItem[]> {
  const [
    workers,
    databases,
    buckets,
    euBuckets,
    tunnels,
    hyperdrives,
    vpcServices,
    virtualNetworks,
  ] = await Promise.all([
    cf.list("/workers/scripts"),
    cf.list("/d1/database"),
    cf.buckets("default"),
    cf.buckets("eu"),
    cf.list("/cfd_tunnel?is_deleted=false"),
    cf.list("/hyperdrive/configs"),
    cf.list("/connectivity/directory/services"),
    cf.list("/teamnet/virtual_networks?is_deleted=false"),
  ]);
  return [
    ...workers.map((row) => ({ kind: "worker", name: string(row.id) })),
    ...databases.map((row) => ({ kind: "d1", name: string(row.name) })),
    ...buckets.map((row) => ({ kind: "r2", name: string(row.name) })),
    ...euBuckets.map((row) => ({ kind: "r2-eu", name: string(row.name) })),
    ...tunnels.map((row) => ({ kind: "tunnel", name: string(row.name) })),
    ...hyperdrives.map((row) => ({
      kind: "hyperdrive",
      name: string(row.name),
    })),
    ...vpcServices.map((row) => ({
      kind: "vpc-service",
      name: string(row.name),
    })),
    ...virtualNetworks.map((row) => ({
      kind: "virtual-network",
      name: string(row.name),
    })),
  ];
}

export async function phase0(
  env: NodeJS.ProcessEnv = process.env,
): Promise<Check[]> {
  const values = requireEnv(env, [
    "CLOUDFLARE_ACCOUNT_ID",
    "CLOUDFLARE_API_TOKEN",
    "PGCF_E2E_EXPECTED_ACCOUNT_NAME",
    "PGCF_E2E_KUBECONFIG",
    "PGCF_E2E_KUBE_CONTEXT",
    "PGCF_E2E_PHASE0_ALLOWED_RESOURCES",
    "PGCF_E2E_NODE_NAMES",
    "PGCF_E2E_HELM_RELEASE_NAMES",
    "PGCF_E2E_EXPECTED_CLUSTER_UID",
    "PGCF_E2E_EXPECTED_NODE_UIDS",
  ]);
  let allowed: InventoryItem[],
    nodes: string[],
    releases: string[],
    nodeUids: Record<string, string>;
  try {
    const rawAllowed: unknown = JSON.parse(
      values.PGCF_E2E_PHASE0_ALLOWED_RESOURCES!,
    );
    if (!Array.isArray(rawAllowed)) throw new HarnessError("invalid_config");
    allowed = rawAllowed.map((value) => {
      const row = record(value);
      return { kind: string(row.kind), name: string(row.name) };
    });
    nodes = JSON.parse(values.PGCF_E2E_NODE_NAMES!);
    releases = JSON.parse(values.PGCF_E2E_HELM_RELEASE_NAMES!);
    if (
      !Array.isArray(nodes) ||
      !nodes.length ||
      new Set(nodes).size !== nodes.length ||
      nodes.some((n) => typeof n !== "string") ||
      !Array.isArray(releases) ||
      releases.length !== 5 ||
      releases.some((n) => typeof n !== "string")
    )
      throw new HarnessError("invalid_config");
    nodeUids = parseUidMap(JSON.parse(values.PGCF_E2E_EXPECTED_NODE_UIDS!));
  } catch {
    throw new HarnessError("invalid_config");
  }
  if (
    JSON.stringify(Object.keys(nodeUids).sort()) !==
    JSON.stringify([...nodes].sort())
  )
    throw new HarnessError("expected_node_identity_mismatch");
  const cf = new Cloudflare(
    values.CLOUDFLARE_ACCOUNT_ID!,
    values.CLOUDFLARE_API_TOKEN!,
    values.PGCF_E2E_EXPECTED_ACCOUNT_NAME!,
  );
  await cf.verifyAccount();
  const kube = new Kubernetes(
    values.PGCF_E2E_KUBECONFIG!,
    values.PGCF_E2E_KUBE_CONTEXT!,
  );
  const [namespaceList, nodeList] = await Promise.all([
    kube.read("namespaces"),
    kube.read("nodes"),
  ]);
  const system = items(namespaceList).filter(
    (row) => objectName(row) === "kube-system",
  );
  if (system.length !== 1) throw new HarnessError("cluster_namespace_missing");
  assertClusterNodeIdentity(
    {
      cluster_uid: string(record(system[0]!.metadata).uid),
      nodes: Object.fromEntries(
        items(nodeList).map((node) => [
          objectName(node),
          string(record(node.metadata).uid),
        ]),
      ),
    },
    { cluster_uid: values.PGCF_E2E_EXPECTED_CLUSTER_UID!, nodes: nodeUids },
  );
  const [files, worktrees, branches, inventory, releaseList] =
    await Promise.all([
      command("git", ["ls-files"]),
      command("git", ["worktree", "list", "--porcelain"]),
      command("git", [
        "for-each-ref",
        "--format=%(refname:short)",
        "refs/heads",
      ]),
      cloudflareInventory(cf),
      kube.read("helmreleases.helm.toolkit.fluxcd.io"),
    ]);
  return [
    checkLayout(files.trim().split("\n")),
    checkGitTopology(worktrees, branches),
    checkCloudflareInventory(inventory, allowed),
    checkReady(nodeList, "nodes", nodes),
    checkReady(releaseList, "releases", releases),
  ];
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  phase0()
    .then((checks) => {
      const allowedNames = new Set(checks.flatMap((check) => check.names));
      for (const check of checks)
        console.log(
          JSON.stringify(
            evidence(
              {
                event: "phase0",
                pass: check.pass,
                names: check.names,
                counts: { [check.name]: check.count },
              },
              allowedNames,
            ),
          ),
        );
      if (checks.some((check) => !check.pass)) process.exitCode = 1;
    })
    .catch((error: unknown) => {
      console.error(
        JSON.stringify({
          code: error instanceof HarnessError ? error.code : "phase0_failed",
          ...(error instanceof HarnessError &&
          error.code === "missing_environment"
            ? { names: error.names }
            : {}),
        }),
      );
      process.exitCode = 1;
    });
}
