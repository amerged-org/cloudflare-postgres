// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { newNodeId } from "../../packages/contracts/src/ids.ts";
import {
  nodeAdditionHostname,
  nodeShellHostname,
} from "../../packages/contracts/src/nodes.ts";
import {
  EDGE_SECRETS,
  GATEWAY_APPLICATION,
  GATEWAY_POLICY,
  SHELL_APPLICATION,
  SHELL_POLICY,
  durationSeconds,
  gatewayPattern,
  parseOptions,
  run,
  shellPattern,
  verifyRefusal,
} from "./setup-access.ts";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const DOMAIN = "nodes.example.org";
const API_TOKEN = "cf-api-token-" + "t".repeat(30);
const NOW = new Date("2026-10-18T12:00:00.000Z");
const TOKEN_NAME = "pgcf-edge-test";
const WORKER = "edge-worker";
const OTP = "00000000-0000-4000-8000-0000000000a1";

type Json = Record<string, unknown>;
interface Call {
  method: string;
  path: string;
  body: unknown;
}

/**
 * The part of the Cloudflare API this script uses, in memory: it answers by method and path like
 * the real one, assigns ids, replaces on PUT, and records every call. Secrets it issues are listed
 * in `issued`, so a test can look for them in what the script printed.
 */
function cloudflare(
  options: {
    workers?: string[];
    providers?: Json[];
    failSecretPut?: boolean;
  } = {},
) {
  const state = {
    tokens: [] as Json[],
    apps: [] as Json[],
    policies: new Map<string, Json[]>(),
    secrets: new Map<string, Map<string, string>>(
      (options.workers ?? [WORKER]).map((name) => [name, new Map()]),
    ),
    providers: options.providers ?? [
      { id: OTP, name: "One-time PIN", type: "onetimepin" },
    ],
  };
  const calls: Call[] = [];
  const issued: string[] = [];
  const rotations: unknown[] = [];
  let counter = 0;
  const id = () =>
    `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`;
  const secret = () => {
    const value = `issued-secret-${++counter}-${"s".repeat(24)}`;
    issued.push(value);
    return value;
  };
  const answer = (result: unknown, status = 200) =>
    Response.json(
      { success: true, errors: [], messages: [], result },
      { status },
    );
  const refuse = (status: number, code: number, message: string) =>
    Response.json(
      {
        success: false,
        errors: [{ code, message }],
        messages: [],
        result: null,
      },
      { status },
    );

  const fetchImpl = async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = new URL(String(input)),
      method = init?.method ?? "GET",
      body =
        init?.body === undefined ? undefined : JSON.parse(String(init.body));
    assert.equal(url.host, "api.cloudflare.com");
    assert.equal(
      new Headers(init?.headers).get("authorization"),
      `Bearer ${API_TOKEN}`,
    );
    assert.equal(init?.redirect, "manual");
    const path = url.pathname.replace("/client/v4", "");
    calls.push({ method, path: path + url.search, body });
    const base = `/accounts/${ACCOUNT}`;
    const named = (items: Json[]) =>
      items.filter((item) =>
        String(item.name).includes(url.searchParams.get("name") ?? ""),
      );
    let match: RegExpExecArray | null;

    if (
      (match = /^\/workers\/scripts\/([^/]+)\/secrets$/.exec(
        path.slice(base.length),
      ))
    ) {
      const held = state.secrets.get(match[1]!);
      if (held === undefined)
        return refuse(404, 10007, "workers.api.error.script_not_found");
      if (method === "GET")
        return answer(
          [...held.keys()].map((name) => ({ name, type: "secret_text" })),
        );
      if (options.failSecretPut)
        return refuse(500, 10013, "could not store the secret");
      held.set(body.name, body.text);
      return answer({ name: body.name, type: body.type });
    }
    const rest = path.startsWith(base) ? path.slice(base.length) : path;
    if (rest === "/access/service_tokens" && method === "GET")
      return answer(named(state.tokens));
    if (rest === "/access/service_tokens" && method === "POST") {
      const listed = {
        id: id(),
        name: body.name,
        duration: body.duration,
        enabled: true,
        expires_at: "2027-10-18T12:00:00Z",
        client_id: `${secret()}.access`,
      };
      state.tokens.push(listed);
      // The secret is in this answer only.
      return answer({ ...listed, client_secret: secret() }, 201);
    }
    if ((match = /^\/access\/service_tokens\/([^/]+)(\/rotate)?$/.exec(rest))) {
      const at = state.tokens.findIndex((token) => token.id === match![1]);
      if (at < 0) return refuse(404, 1001, "no such token");
      if (method === "DELETE") {
        state.tokens.splice(at, 1);
        return answer({ id: match[1] });
      }
      rotations.push(body);
      return answer({ ...state.tokens[at], client_secret: secret() });
    }
    if (rest === "/access/identity_providers" && method === "GET")
      return answer(state.providers);
    if (rest === "/access/apps" && method === "GET")
      return answer(named(state.apps));
    if (rest === "/access/apps" && method === "POST") {
      const app = { id: id(), ...body };
      state.apps.push(app);
      state.policies.set(app.id, []);
      return answer(app, 201);
    }
    if ((match = /^\/access\/apps\/([^/]+)$/.exec(rest))) {
      const at = state.apps.findIndex((app) => app.id === match![1]);
      if (at < 0) return refuse(404, 12100, "no such application");
      if (method === "DELETE") {
        state.apps.splice(at, 1);
        state.policies.delete(match[1]!);
        return answer({ id: match[1] });
      }
      state.apps[at] = { id: match[1], ...body };
      return answer(state.apps[at]);
    }
    if (
      (match = /^\/access\/apps\/([^/]+)\/policies(?:\/([^/]+))?$/.exec(rest))
    ) {
      const policies = state.policies.get(match[1]!);
      if (policies === undefined)
        return refuse(404, 12100, "no such application");
      if (match[2] === undefined && method === "GET")
        return answer([...policies]);
      if (match[2] === undefined && method === "POST") {
        const policy = { id: id(), ...body };
        policies.push(policy);
        return answer(policy, 201);
      }
      const at = policies.findIndex((policy) => policy.id === match![2]);
      if (at < 0) return refuse(404, 12101, "no such policy");
      if (method === "DELETE") policies.splice(at, 1);
      else policies[at] = { id: match[2], ...body };
      return answer({ id: match[2] });
    }
    return refuse(404, 7003, "no route");
  };
  const writes = () => calls.filter((call) => call.method !== "GET");
  return { state, calls, issued, rotations, fetch: fetchImpl, writes };
}

function argv(...extra: string[]) {
  return [
    "apply",
    "--account",
    ACCOUNT,
    "--domain",
    DOMAIN,
    "--service-token",
    TOKEN_NAME,
    ...extra,
  ];
}

async function go(api: ReturnType<typeof cloudflare>, args: string[]) {
  const lines: string[] = [];
  const result = await run(parseOptions(args), {
    token: API_TOKEN,
    fetch: api.fetch,
    log: (line) => lines.push(line),
    now: () => NOW,
  });
  return { ...result, lines };
}

const gatewayApp = (api: ReturnType<typeof cloudflare>) =>
  api.state.apps.find((app) => app.name === GATEWAY_APPLICATION)!;
const policiesOf = (api: ReturnType<typeof cloudflare>, app: Json) =>
  api.state.policies.get(app.id as string)!;
/** Nothing the script printed or threw contains a credential. */
function assertNoSecrets(api: ReturnType<typeof cloudflare>, text: string) {
  for (const secret of [API_TOKEN, ...api.issued])
    assert.ok(!text.includes(secret), "a credential was printed");
}

const wildcard = (pattern: string, hostname: string) =>
  new RegExp(`^${pattern.replaceAll(".", "\\.").replaceAll("*", ".*")}$`).test(
    hostname,
  );

test("the two wildcard families do not overlap, and each covers what the API makes for a node", () => {
  const node = newNodeId();
  const gateway = `${nodeAdditionHostname(node)}.${DOMAIN}`;
  const shell = `${nodeShellHostname(node)}.${DOMAIN}`;
  assert.equal(gatewayPattern(DOMAIN), `pgcf-node-*.${DOMAIN}`);
  assert.equal(shellPattern(DOMAIN), `pgcf-shell-*.${DOMAIN}`);
  assert.ok(wildcard(gatewayPattern(DOMAIN), gateway));
  assert.ok(wildcard(shellPattern(DOMAIN), shell));
  assert.ok(!wildcard(gatewayPattern(DOMAIN), shell));
  assert.ok(!wildcard(shellPattern(DOMAIN), gateway));
  // The reason for the rename: the shell's former name was inside the gateways' family.
  assert.ok(
    wildcard(
      gatewayPattern(DOMAIN),
      `${nodeAdditionHostname(node)}-ssh.${DOMAIN}`,
    ),
  );
});

test("the command line is checked before anything is read", () => {
  assert.equal(parseOptions(argv().slice(1)).mode, "plan");
  assert.throws(() => parseOptions(argv("--shell")), /--operator-email/);
  assert.throws(
    () => parseOptions(argv("--operator-email", "a@example.org")),
    /--shell/,
  );
  assert.throws(
    () => parseOptions(argv("--shell", "--operator-email", "not-an-email")),
    /email/,
  );
  assert.throws(() => parseOptions(argv("--grace", "soon")), /--grace/);
  assert.throws(
    () => parseOptions(argv("--verify-hostname", `pgcf-node-x.${DOMAIN}`)),
    /--verify/,
  );
  assert.throws(
    () =>
      parseOptions(
        argv("--verify", "--verify-hostname", `pgcf-shell-x.${DOMAIN}`),
      ),
    /pgcf-node-\*/,
  );
  assert.throws(
    () => parseOptions(["apply", "--account", ACCOUNT, "--domain", DOMAIN]),
    /--service-token/,
  );
  assert.throws(
    () => parseOptions(["apply", "--account", "nope", "--remove"]),
    /--account/,
  );
  assert.throws(
    () => parseOptions(["apply", "--account", ACCOUNT, "--remove", "--verify"]),
    /--remove takes only --account/,
  );
  assert.deepEqual(parseOptions(["--account", ACCOUNT, "--remove"]), {
    remove: true,
    mode: "plan",
    account: ACCOUNT,
  });
  const shell = parseOptions(
    argv(
      "--shell",
      "--operator-email",
      "B@Example.org",
      "--operator-email",
      "a@example.org",
      "--operator-email",
      "b@example.org",
    ),
  );
  assert.ok(!shell.remove);
  assert.deepEqual(shell.operators, ["a@example.org", "b@example.org"]);
  assert.equal(durationSeconds("2h45m"), 9900);
  assert.equal(durationSeconds("24h0m0s"), 86400);
  assert.equal(durationSeconds("soon"), undefined);
});

test("a plan reads and writes nothing; apply makes the token, the Edge's secrets, the application and its one policy", async () => {
  const api = cloudflare();
  const plan = await go(api, [
    "plan",
    ...argv("--edge-worker", WORKER).slice(1),
  ]);
  assert.equal(plan.changes, 3);
  assert.deepEqual(api.writes(), []);
  assert.ok(
    plan.lines.some((line) => line.includes("plan (nothing is written)")),
  );

  const applied = await go(api, argv("--edge-worker", WORKER));
  assert.equal(applied.changes, 3);
  const [token] = api.state.tokens;
  assert.equal(api.state.tokens.length, 1);
  assert.equal(token!.name, TOKEN_NAME);
  assert.equal(token!.duration, "8760h");
  // The credentials went from Cloudflare's answer into the Worker's secrets and nowhere else.
  const held = api.state.secrets.get(WORKER)!;
  assert.deepEqual([...held.keys()].sort(), [
    EDGE_SECRETS.id,
    EDGE_SECRETS.secret,
  ]);
  assert.equal(held.get(EDGE_SECRETS.id), `${api.issued[0]}.access`);
  assert.equal(held.get(EDGE_SECRETS.secret), api.issued[1]);
  assert.equal(api.calls.filter((call) => call.method === "PUT").length, 2);

  assert.equal(api.state.apps.length, 1);
  assert.deepEqual(gatewayApp(api), {
    id: gatewayApp(api).id,
    name: "pgcf node gateways",
    type: "self_hosted",
    domain: `pgcf-node-*.${DOMAIN}`,
    session_duration: "24h",
    app_launcher_visible: false,
    http_only_cookie_attribute: true,
    options_preflight_bypass: false,
    service_auth_401_redirect: true,
  });
  // One policy: Service Auth for the token, no login, no email.
  const policies = policiesOf(api, gatewayApp(api));
  assert.equal(policies.length, 1);
  assert.equal(policies[0]!.name, GATEWAY_POLICY);
  assert.equal(policies[0]!.decision, "non_identity");
  assert.deepEqual(policies[0]!.include, [
    { service_token: { token_id: token!.id } },
  ]);
  assert.deepEqual(policies[0]!.require, []);
  assert.deepEqual(policies[0]!.exclude, []);
  // The shell is off unless asked for: no application, and the identity providers were not even read.
  assert.ok(!api.state.apps.some((app) => app.name === SHELL_APPLICATION));
  assert.ok(
    !api.calls.some((call) => call.path.includes("identity_providers")),
  );
  assertNoSecrets(api, [...plan.lines, ...applied.lines].join("\n"));
});

test("a second apply changes nothing: its request log holds only GETs", async () => {
  const api = cloudflare();
  await go(api, argv("--edge-worker", WORKER));
  const before = api.calls.length;
  const second = await go(api, argv("--edge-worker", WORKER));
  assert.equal(second.changes, 0);
  assert.deepEqual(
    api.calls.slice(before).filter((call) => call.method !== "GET"),
    [],
  );
  // Without the Worker named, an existing token needs nothing from it.
  const third = await go(api, argv());
  assert.equal(third.changes, 0);
  assert.deepEqual(
    api.calls.slice(before).filter((call) => call.method !== "GET"),
    [],
  );
});

test("what was edited by hand is put back, and what the API writes differently is not a difference", async () => {
  const api = cloudflare();
  await go(api, argv("--edge-worker", WORKER));
  const app = gatewayApp(api);
  Object.assign(app, {
    session_duration: "720h",
    app_launcher_visible: true,
    cors_headers: { allow_all_origins: true },
    service_auth_401_redirect: false,
  });
  const policies = policiesOf(api, app);
  Object.assign(policies[0]!, {
    include: [
      ...(policies[0]!.include as Json[]),
      { any_valid_service_token: {} },
    ],
    approval_required: true,
  });
  // Another way in, put there by hand.
  policies.push({
    id: "extra",
    name: "everyone",
    decision: "bypass",
    include: [{ everyone: {} }],
  });
  const repaired = await go(api, argv("--edge-worker", WORKER));
  assert.equal(repaired.changes, 3);
  assert.equal(gatewayApp(api).session_duration, "24h");
  assert.equal(gatewayApp(api).cors_headers, undefined);
  assert.equal(gatewayApp(api).app_launcher_visible, false);
  assert.equal(gatewayApp(api).service_auth_401_redirect, true);
  const now = policiesOf(api, gatewayApp(api));
  assert.equal(now.length, 1);
  assert.equal(now[0]!.name, GATEWAY_POLICY);
  assert.equal(now[0]!.approval_required, false);
  assert.equal((now[0]!.include as Json[]).length, 1);
  // A policy deleted by hand comes back.
  now.length = 0;
  assert.equal((await go(api, argv())).changes, 1);
  assert.equal(policiesOf(api, gatewayApp(api)).length, 1);
  // The API may answer a duration its own way.
  gatewayApp(api).session_duration = "24h0m0s";
  const before = api.calls.length;
  assert.equal((await go(api, argv())).changes, 0);
  assert.deepEqual(
    api.calls.slice(before).filter((call) => call.method !== "GET"),
    [],
  );
});

test("a token is created or rotated only when the Edge Worker is named, and nothing is written before the refusal", async () => {
  const api = cloudflare();
  await assert.rejects(go(api, argv()), /--edge-worker/);
  assert.deepEqual(api.writes(), []);
  await go(api, argv("--edge-worker", WORKER));
  const before = api.calls.length;
  await assert.rejects(
    go(api, argv("--rotate-service-token")),
    /rotate.*--edge-worker/,
  );
  assert.deepEqual(
    api.calls.slice(before).filter((call) => call.method !== "GET"),
    [],
  );
  // A Worker that does not exist stops a run before the token is made.
  const empty = cloudflare();
  await assert.rejects(
    go(empty, argv("--edge-worker", "no-such-worker")),
    /script_not_found/,
  );
  assert.deepEqual(empty.writes(), []);
});

test("an existing token whose Edge Worker lacks the secrets is refused: Access would lock the Edge out", async () => {
  const api = cloudflare();
  await go(api, argv("--edge-worker", WORKER));
  api.state.secrets.get(WORKER)!.delete(EDGE_SECRETS.secret);
  const before = api.calls.length;
  await assert.rejects(
    go(api, argv("--edge-worker", WORKER)),
    /ACCESS_CLIENT_SECRET/,
  );
  assert.deepEqual(
    api.calls.slice(before).filter((call) => call.method !== "GET"),
    [],
  );
  // Rotating sets both again.
  await go(api, argv("--edge-worker", WORKER, "--rotate-service-token"));
  assert.equal(api.state.secrets.get(WORKER)!.size, 2);
});

test("a rotation sets the new secret on the Edge Worker, keeps the old one valid for the grace period and touches no application", async () => {
  const api = cloudflare();
  await go(api, argv("--edge-worker", WORKER));
  const clientId = api.state.secrets.get(WORKER)!.get(EDGE_SECRETS.id);
  const before = api.calls.length;
  const rotated = await go(
    api,
    argv("--edge-worker", WORKER, "--rotate-service-token", "--grace", "30m"),
  );
  assert.equal(rotated.changes, 1);
  assert.deepEqual(api.rotations, [
    { previous_client_secret_expires_at: "2026-10-18T12:30:00.000Z" },
  ]);
  const held = api.state.secrets.get(WORKER)!;
  assert.equal(held.get(EDGE_SECRETS.id), clientId);
  assert.equal(held.get(EDGE_SECRETS.secret), api.issued.at(-1));
  assert.notEqual(held.get(EDGE_SECRETS.secret), api.issued[1]);
  assert.deepEqual(
    api.calls
      .slice(before)
      .filter(
        (call) =>
          call.method !== "GET" &&
          !call.path.includes("/secrets") &&
          !call.path.endsWith("/rotate"),
      ),
    [],
  );
  assertNoSecrets(api, rotated.lines.join("\n"));
});

test("a token whose secret could not be delivered is deleted again, and the failure shows no credential", async () => {
  const api = cloudflare({ failSecretPut: true });
  const failure = await go(api, argv("--edge-worker", WORKER)).then(
    () => assert.fail("it must fail"),
    (error: Error) => error,
  );
  assert.match(
    failure.message,
    /could not be set on the Edge Worker.*10013.*deleted again/,
  );
  assert.deepEqual(api.state.tokens, []);
  assert.deepEqual(api.state.apps, []);
  assertNoSecrets(api, failure.message);
});

test("a disabled token, two tokens or two applications of one name are refused", async () => {
  const api = cloudflare();
  await go(api, argv("--edge-worker", WORKER));
  api.state.tokens[0]!.enabled = false;
  await assert.rejects(go(api, argv()), /disabled/);
  api.state.tokens[0]!.enabled = true;
  api.state.tokens.push({ ...api.state.tokens[0]!, id: "second" });
  await assert.rejects(go(api, argv()), /2 service tokens named/);
  api.state.tokens.pop();
  api.state.apps.push({ ...gatewayApp(api), id: "second" });
  await assert.rejects(go(api, argv()), /2 applications named/);
});

test("a reusable policy attached to the application is not deleted: the operator detaches it", async () => {
  const api = cloudflare();
  await go(api, argv("--edge-worker", WORKER));
  policiesOf(api, gatewayApp(api)).push({
    id: "shared",
    name: "shared policy",
    reusable: true,
  });
  const before = api.calls.length;
  await assert.rejects(go(api, argv()), /reusable policy "shared policy"/);
  assert.deepEqual(
    api.calls.slice(before).filter((call) => call.method !== "GET"),
    [],
  );
});

test("the shell is guarded for exactly the named operators, with a short session and the one-time PIN", async () => {
  const api = cloudflare();
  const args = argv(
    "--edge-worker",
    WORKER,
    "--shell",
    "--operator-email",
    "Ops@Example.org",
    "--operator-email",
    "dev@example.org",
  );
  const first = await go(api, args);
  assert.equal(first.changes, 5);
  const shell = api.state.apps.find((app) => app.name === SHELL_APPLICATION)!;
  assert.deepEqual(shell, {
    id: shell.id,
    name: "pgcf node shells",
    type: "self_hosted",
    domain: `pgcf-shell-*.${DOMAIN}`,
    session_duration: "1h",
    app_launcher_visible: false,
    http_only_cookie_attribute: true,
    options_preflight_bypass: false,
  });
  const [policy, ...others] = policiesOf(api, shell);
  assert.deepEqual(others, []);
  assert.equal(policy!.name, SHELL_POLICY);
  assert.equal(policy!.decision, "allow");
  assert.deepEqual(policy!.include, [
    { email: { email: "dev@example.org" } },
    { email: { email: "ops@example.org" } },
  ]);
  assert.deepEqual(policy!.require, [{ login_method: { id: OTP } }]);
  // The two applications cover families that do not overlap.
  assert.ok(!wildcard(gatewayPattern(DOMAIN), `pgcf-shell-x.${DOMAIN}`));
  // Idempotent; the list of operators is the whole list.
  const before = api.calls.length;
  assert.equal((await go(api, args)).changes, 0);
  assert.deepEqual(
    api.calls.slice(before).filter((call) => call.method !== "GET"),
    [],
  );
  const fewer = await go(
    api,
    argv("--shell", "--operator-email", "dev@example.org"),
  );
  assert.equal(fewer.changes, 1);
  assert.deepEqual(policiesOf(api, shell)[0]!.include, [
    { email: { email: "dev@example.org" } },
  ]);
  // Hand edits to the shell application are put back too.
  shell.session_duration = "720h";
  assert.equal(
    (await go(api, argv("--shell", "--operator-email", "dev@example.org")))
      .changes,
    1,
  );
  assert.equal(
    api.state.apps.find((app) => app.name === SHELL_APPLICATION)!
      .session_duration,
    "1h",
  );
});

test("without a one-time PIN provider the operators policy names no login method, and says so", async () => {
  const api = cloudflare({
    providers: [{ id: "github", name: "GitHub", type: "github" }],
  });
  const done = await go(
    api,
    argv(
      "--edge-worker",
      WORKER,
      "--shell",
      "--operator-email",
      "ops@example.org",
    ),
  );
  const shell = api.state.apps.find((app) => app.name === SHELL_APPLICATION)!;
  assert.deepEqual(policiesOf(api, shell)[0]!.require, []);
  assert.ok(
    done.lines.some((line) =>
      line.includes("no one-time PIN identity provider"),
    ),
  );
});

test("--remove deletes both applications and keeps the token; a second run, and a plan, write nothing", async () => {
  const api = cloudflare();
  await go(
    api,
    argv(
      "--edge-worker",
      WORKER,
      "--shell",
      "--operator-email",
      "ops@example.org",
    ),
  );
  const before = api.calls.length;
  const plan = await go(api, ["plan", "--account", ACCOUNT, "--remove"]);
  assert.equal(plan.changes, 2);
  assert.deepEqual(
    api.calls.slice(before).filter((call) => call.method !== "GET"),
    [],
  );
  const removed = await go(api, ["apply", "--account", ACCOUNT, "--remove"]);
  assert.equal(removed.changes, 2);
  assert.deepEqual(api.state.apps, []);
  assert.equal(api.state.tokens.length, 1);
  assert.ok(removed.lines.some((line) => line.includes("NODE_SHELL_HOSTNAME")));
  const again = api.calls.length;
  assert.equal(
    (await go(api, ["apply", "--account", ACCOUNT, "--remove"])).changes,
    0,
  );
  assert.deepEqual(
    api.calls.slice(again).filter((call) => call.method !== "GET"),
    [],
  );
});

test("an API refusal is named by status and code and never shows what was sent", async () => {
  const api = cloudflare();
  const failing: typeof api.fetch = async (input, init) =>
    String(input).includes("/access/apps") && init?.method === "POST"
      ? Response.json(
          { success: false, errors: [{ code: 12130, message: "denied" }] },
          { status: 403 },
        )
      : api.fetch(input, init);
  const failure = await run(parseOptions(argv("--edge-worker", WORKER)), {
    token: API_TOKEN,
    fetch: failing,
    log: () => undefined,
    now: () => NOW,
  }).then(
    () => assert.fail("it must fail"),
    (error: Error) => error,
  );
  assert.equal(
    failure.message,
    "Cloudflare answered 403 for POST /accounts/" +
      ACCOUNT +
      "/access/apps: 12130 denied",
  );
  assertNoSecrets(api, failure.message);
});

test("the verification passes only on a refusal by Access, and sends no credentials", async () => {
  const sent: RequestInit[] = [];
  const answering =
    (status: number, headers: Record<string, string> = {}): typeof fetch =>
    async (_input, init) => {
      sent.push(init ?? {});
      return new Response(null, { status, headers });
    };
  const host = `pgcf-node-probe.${DOMAIN}`;
  for (const status of [401, 403]) {
    const verdict = await verifyRefusal(host, answering(status));
    assert.equal(verdict.ok, true);
    assert.match(verdict.line, new RegExp(`answered ${status}`));
  }
  assert.equal((await verifyRefusal(host, answering(200))).ok, false);
  // A node's own 404 means the request got past Access.
  assert.equal((await verifyRefusal(host, answering(404))).ok, false);
  const redirect = await verifyRefusal(
    host,
    answering(302, {
      location: "https://team.cloudflareaccess.com/cdn-cgi/access/login/x",
    }),
  );
  assert.equal(redirect.ok, false);
  assert.match(
    redirect.line,
    /redirect to team\.cloudflareaccess\.com.*login page/,
  );
  const unreachable = await verifyRefusal(host, async () => {
    throw new TypeError("fetch failed", { cause: { code: "ENOTFOUND" } });
  });
  assert.equal(unreachable.ok, false);
  assert.match(unreachable.line, /ENOTFOUND.*--verify-hostname/);
  for (const init of sent) {
    assert.equal(init.headers, undefined);
    assert.equal(init.redirect, "manual");
  }
});

test("--verify probes a hostname of the gateways' family after the run and reports its verdict", async () => {
  const api = cloudflare();
  const probed: string[] = [];
  const both: typeof api.fetch = async (input, init) => {
    if (new URL(String(input)).host === "api.cloudflare.com")
      return api.fetch(input, init);
    probed.push(String(input));
    return new Response(null, { status: 403 });
  };
  const lines: string[] = [];
  const result = await run(
    parseOptions(argv("--edge-worker", WORKER, "--verify")),
    {
      token: API_TOKEN,
      fetch: both,
      log: (line) => lines.push(line),
      now: () => NOW,
    },
  );
  assert.deepEqual(probed, [`https://pgcf-node-probe.${DOMAIN}/`]);
  assert.equal(result.verification?.ok, true);
  assert.ok(lines.at(-1)!.startsWith("verify ok"));
  // Without the flag, nothing outside the API is requested.
  const quiet = cloudflare();
  await go(quiet, argv("--edge-worker", WORKER));
  assert.ok(quiet.calls.every((call) => !call.path.includes("probe")));
});
