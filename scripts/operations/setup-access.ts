// SPDX-License-Identifier: Apache-2.0
// Puts Cloudflare Access in front of the nodes' public hostnames (ULTRA plan 5.8, 8): the gateways,
// which only the Edge may reach, and optionally the operator shells. Idempotent: it reads what is
// there and changes only what differs, so a second run changes nothing.
//
//   node scripts/operations/setup-access.ts [plan|apply] --account ID --domain DOMAIN --service-token NAME
//        [--edge-worker NAME] [--rotate-service-token] [--grace 1h] [--refresh-service-token]
//        [--shell --operator-email EMAIL ... [--shell-service-token NAME [--shell-token-file FILE]]]
//        [--verify [--verify-hostname HOST]]
//   node scripts/operations/setup-access.ts [plan|apply] --account ID --remove
//
//   plan (default)  prints what would change and writes nothing. apply writes.
//   --account       the Cloudflare account of the Zero Trust organization (and of the Edge Worker).
//   --domain        NODE_GATEWAY_DOMAIN of the API Worker: the nodes' hostnames are made under it.
//   --service-token the name of the Access service token the Edge presents. It is created, with a
//                   duration of 8760h, when it is missing.
//   --edge-worker   the Edge Worker. The secret of a service token is shown by Cloudflare once, so
//                   a token is created or rotated only with this flag, and its client id and secret
//                   go straight into the Worker's secrets ACCESS_CLIENT_ID and
//                   ACCESS_CLIENT_SECRET: a secret nobody receives is worse than none. With a token
//                   that exists, the flag also checks that the Worker holds both secrets.
//   --rotate-service-token  rotates the secret of the existing token and sets it on the Worker. The
//                   token keeps its id and its expiry; the old secret stays valid for --grace
//                   (default 1h).
//   --refresh-service-token  renews the expiry of the existing token (Cloudflare adds one year); the
//                   secret stays, so no Edge Worker is needed. A token that has expired is refused
//                   without this flag, because Access would refuse the Edge everywhere, and one that
//                   expires within 30 days is reported. Cloudflare also sends the "Expiring Access
//                   Service Token" notification a week before.
//   --shell         also guards the shells, `pgcf-shell-*.DOMAIN`, for exactly the --operator-email
//                   addresses (repeatable; the list replaces the previous one) with a session of 1h,
//                   through the one-time PIN identity provider when the organization has one. The
//                   shell is an Access self-hosted application, which is what the native client
//                   (`cloudflared access ssh`) needs; the SSH application type is the browser-rendered
//                   terminal, which is not what an operator at a shell uses.
//   --shell-service-token  also lets one service token, made for the shells alone, through the
//                   shell application with a Service Auth policy of its own and a session of 15
//                   minutes: it is what `node-shell.ts` presents, so an operator's shell needs no
//                   login. It is a different token from the Edge's: the Edge's is never allowed
//                   on the shells and this one never on the gateways. Without the flag the policy
//                   is deleted again. The token lasts 720h.
//   --shell-token-file  where the new shell token's client id and secret go, as two lines of an
//                   environment file (PGCF_SHELL_ACCESS_CLIENT_ID and
//                   PGCF_SHELL_ACCESS_CLIENT_SECRET), written with mode 0600 into an existing
//                   directory that group and others cannot enter, and never over a file that is
//                   there. Cloudflare shows the secret once, so a token is created only with this
//                   flag, and a token that exists needs none: if its secret is lost, delete the
//                   token in the dashboard and run again.
//   --remove        deletes both applications (their policies go with them). The tokens stay.
//   --verify        sends an unauthenticated GET to https://pgcf-node-probe.DOMAIN/ (or
//                   --verify-hostname) and fails unless Cloudflare refuses it with 401 or 403. The
//                   hostname must resolve: use a node's gateway hostname where the zone has no
//                   wildcard record.
//
// The two applications cover two wildcard families that do not overlap: the documentation does not
// say which of two overlapping wildcard applications wins.
//
// The account API token comes from this environment variable, in memory only. Its value is never
// printed or written, and neither are the client id and secret of the service token:
//   PGCF_CLOUDFLARE_API_TOKEN  an account API token with Access: Apps and Policies Write, Access:
//                              Service Tokens Write, Access: Organizations, Identity Providers, and
//                              Groups Read (for --shell) and Workers Scripts Write (for --edge-worker)
import { constants } from "node:fs";
import { lstat, open, rm, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  NODE_GATEWAY_LABEL_PREFIX,
  NODE_SHELL_LABEL_PREFIX,
} from "../../packages/contracts/src/nodes.ts";

export const GATEWAY_APPLICATION = "pgcf node gateways";
export const SHELL_APPLICATION = "pgcf node shells";
export const GATEWAY_POLICY = "edge service token";
export const SHELL_POLICY = "operators";
export const SHELL_TOKEN_POLICY = "shell service token";
/** The names of the two lines `--shell-token-file` holds and `node-shell.ts` reads by default. */
export const SHELL_TOKEN_VARIABLES = {
  id: "PGCF_SHELL_ACCESS_CLIENT_ID",
  secret: "PGCF_SHELL_ACCESS_CLIENT_SECRET",
} as const;
export const EDGE_SECRETS = {
  id: "ACCESS_CLIENT_ID",
  secret: "ACCESS_CLIENT_SECRET",
} as const;
const TOKEN_DURATION = "8760h";
const EXPIRY_WARNING_DAYS = 30;
const SHELL_TOKEN_DURATION = "720h";
const GATEWAY_SESSION = "24h";
const SHELL_SESSION = "1h";
/** The session of the shell token's policy: as long as the certificate `node-shell.ts` signs. */
const SHELL_TOKEN_SESSION = "15m";
const API = "https://api.cloudflare.com/client/v4";

export const gatewayPattern = (domain: string) =>
  `${NODE_GATEWAY_LABEL_PREFIX}*.${domain}`;
export const shellPattern = (domain: string) =>
  `${NODE_SHELL_LABEL_PREFIX}*.${domain}`;

type Fetch = (
  url: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;
type Json = Record<string, unknown>;
export type Call = (
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
) => Promise<unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown) =>
  typeof value === "string" ? value : undefined;

// ---------- Options ----------

export type Options =
  | { remove: true; mode: "plan" | "apply"; account: string }
  | {
      remove: false;
      mode: "plan" | "apply";
      account: string;
      domain: string;
      serviceToken: string;
      edgeWorker: string | undefined;
      rotate: boolean;
      refresh: boolean;
      graceSeconds: number;
      /** The operators of the shells; undefined leaves the shells alone. */
      operators: string[] | undefined;
      /** The service token of the shells; undefined has none, and removes the policy of one. */
      shellServiceToken: string | undefined;
      shellTokenFile: string | undefined;
      verify: boolean;
      verifyHostname: string | undefined;
    };

const ACCOUNT = /^[0-9a-f]{32}$/;
const DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;
const WORKER = /^[A-Za-z0-9_-]{1,63}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The seconds of a duration such as `1h`, `45m` or `2h45m30s`; undefined for anything else. */
export function durationSeconds(duration: string): number | undefined {
  if (!/^(?:\d+(?:\.\d+)?[hms])+$/.test(duration)) return undefined;
  let seconds = 0;
  for (const [, amount, unit] of duration.matchAll(/(\d+(?:\.\d+)?)([hms])/g))
    seconds +=
      Number(amount) * { h: 3600, m: 60, s: 1 }[unit as "h" | "m" | "s"];
  return seconds;
}
const sameDuration = (a: unknown, b: string) => {
  const left = typeof a === "string" ? durationSeconds(a) : undefined;
  return left !== undefined ? left === durationSeconds(b) : a === b;
};

const USAGE =
  "usage: setup-access.ts [plan|apply] --account ID --domain DOMAIN --service-token NAME [--edge-worker NAME] " +
  "[--rotate-service-token] [--grace 1h] [--refresh-service-token] [--shell --operator-email EMAIL ... [--shell-service-token NAME [--shell-token-file FILE]]] " +
  "[--verify [--verify-hostname HOST]]\n" +
  "       setup-access.ts [plan|apply] --account ID --remove";

export function parseOptions(argv: string[]): Options {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      account: { type: "string" },
      domain: { type: "string" },
      "service-token": { type: "string" },
      "edge-worker": { type: "string" },
      "rotate-service-token": { type: "boolean", default: false },
      "refresh-service-token": { type: "boolean", default: false },
      grace: { type: "string" },
      shell: { type: "boolean", default: false },
      "operator-email": { type: "string", multiple: true },
      "shell-service-token": { type: "string" },
      "shell-token-file": { type: "string" },
      remove: { type: "boolean", default: false },
      verify: { type: "boolean", default: false },
      "verify-hostname": { type: "string" },
    },
  });
  const mode = positionals[0] ?? "plan";
  if (positionals.length > 1 || (mode !== "plan" && mode !== "apply"))
    throw new Error(USAGE);
  if (!values.account || !ACCOUNT.test(values.account))
    throw new Error(`--account must be a 32-digit hex account id. ${USAGE}`);
  if (values.remove) {
    const extra = Object.entries(values).find(
      ([name, value]) =>
        name !== "account" && name !== "remove" && value !== false,
    );
    if (extra !== undefined)
      throw new Error(`--remove takes only --account, not --${extra[0]}`);
    return { remove: true, mode, account: values.account };
  }
  const domain = values.domain;
  if (!domain || !DOMAIN.test(domain))
    throw new Error(`--domain must be a lower-case domain. ${USAGE}`);
  if (!values["service-token"])
    throw new Error(`--service-token is required. ${USAGE}`);
  if (
    values["edge-worker"] !== undefined &&
    !WORKER.test(values["edge-worker"])
  )
    throw new Error("--edge-worker must be a Worker name");
  const graceSeconds = durationSeconds(values.grace ?? "1h");
  if (graceSeconds === undefined)
    throw new Error("--grace must be a duration such as 1h or 30m");
  const emails = (values["operator-email"] ?? []).map((email) =>
    email.toLowerCase(),
  );
  if (values.shell !== emails.length > 0)
    throw new Error(
      "--shell and --operator-email go together: name the operators of the shell",
    );
  for (const email of emails)
    if (!EMAIL.test(email))
      throw new Error("--operator-email must be an email address");
  const shellToken = values["shell-service-token"],
    shellTokenFile = values["shell-token-file"];
  if (shellToken !== undefined) {
    if (!values.shell)
      throw new Error("--shell-service-token needs --shell and its operators");
    if (!shellToken || shellToken === values["service-token"])
      throw new Error(
        "--shell-service-token must name a token of its own, not the Edge's --service-token: one token on both applications would let the Edge onto the shells",
      );
  }
  if (shellTokenFile !== undefined && shellToken === undefined)
    throw new Error("--shell-token-file needs --shell-service-token");
  const verifyHostname = values["verify-hostname"];
  if (verifyHostname !== undefined) {
    if (!values.verify) throw new Error("--verify-hostname needs --verify");
    if (
      !verifyHostname.startsWith(NODE_GATEWAY_LABEL_PREFIX) ||
      !verifyHostname.endsWith(`.${domain}`)
    )
      throw new Error(`--verify-hostname must match ${gatewayPattern(domain)}`);
  }
  return {
    remove: false,
    mode,
    account: values.account,
    domain,
    serviceToken: values["service-token"],
    edgeWorker: values["edge-worker"],
    rotate: values["rotate-service-token"],
    refresh: values["refresh-service-token"],
    graceSeconds,
    operators: values.shell ? [...new Set(emails)].sort() : undefined,
    shellServiceToken: shellToken,
    shellTokenFile:
      shellTokenFile === undefined ? undefined : resolve(shellTokenFile),
    verify: values.verify,
    verifyHostname,
  };
}

// ---------- The Cloudflare API ----------

/**
 * The account API token of the environment. Cloudflare's tokens are letters, digits, `_` and `-`;
 * anything else (a second line from a file, a carriage return) is refused here by name, because the
 * runtime would quote it whole in the error for an invalid header value.
 */
export function cloudflareApiToken(
  environment: Record<string, string | undefined>,
): string {
  const token = environment.PGCF_CLOUDFLARE_API_TOKEN;
  if (!token) throw new Error("set PGCF_CLOUDFLARE_API_TOKEN");
  if (!/^[A-Za-z0-9_-]+$/.test(token))
    throw new Error("PGCF_CLOUDFLARE_API_TOKEN is not a Cloudflare API token");
  return token;
}

/** A call of the API: the `result` of a successful answer. A refusal names the status and the API's own codes, never a body that was sent. */
export function cloudflareCall(token: string, fetchImpl: Fetch): Call {
  return async (method, path, body) => {
    const response = await fetchImpl(`${API}${path}`, {
      method,
      redirect: "manual",
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const answer = (await response.json().catch(() => null)) as {
      success?: boolean;
      errors?: { code?: unknown; message?: unknown }[];
      result?: unknown;
    } | null;
    if (!response.ok || answer?.success !== true) {
      const reasons = (answer?.errors ?? [])
        .map((error) => `${String(error.code)} ${String(error.message)}`)
        .join("; ");
      throw new Error(
        `Cloudflare answered ${response.status} for ${method} ${path.split("?")[0]}${reasons ? `: ${reasons}` : ""}`,
      );
    }
    return answer.result;
  };
}

async function list(call: Call, path: string): Promise<Json[]> {
  const result = await call("GET", path);
  if (!Array.isArray(result))
    throw new Error(`Cloudflare answered ${path.split("?")[0]} without a list`);
  return result.filter(isObject);
}

// ---------- What Access should be ----------

interface PolicySpec {
  name: string;
  decision: "non_identity" | "allow";
  include: Json[];
  require: Json[];
  /** The policy's own session; without one the application's applies. */
  session?: string;
}
/** An application's policies are numbered in the order of its spec: Cloudflare wants each number once. */
const policyBody = (policy: PolicySpec, precedence: number) => ({
  name: policy.name,
  decision: policy.decision,
  include: policy.include,
  exclude: [],
  require: policy.require,
  precedence,
  ...(policy.session === undefined ? {} : { session_duration: policy.session }),
  approval_required: false,
  purpose_justification_required: false,
  isolation_required: false,
});

interface ApplicationSpec {
  name: string;
  domain: string;
  session: string;
  /** A request that a Service Auth policy refuses gets 401, whatever the organization's default is. */
  serviceAuth401: boolean;
  /** Every policy the application has; any other is deleted. */
  policies: PolicySpec[];
}
const applicationBody = (spec: ApplicationSpec) => ({
  name: spec.name,
  type: "self_hosted",
  domain: spec.domain,
  session_duration: spec.session,
  app_launcher_visible: false,
  http_only_cookie_attribute: true,
  options_preflight_bypass: false,
  ...(spec.serviceAuth401 ? { service_auth_401_redirect: true } : {}),
});

/** The settings of an application that differ from the spec's, named. No CORS headers are wanted. */
function applicationDrift(app: Json, spec: ApplicationSpec): string[] {
  const wanted = applicationBody(spec) as Json;
  const drift: string[] = [];
  if (app.type !== "self_hosted") drift.push("type");
  if (app.domain !== spec.domain) drift.push("domain");
  if (!sameDuration(app.session_duration, spec.session))
    drift.push("session_duration");
  // An absent setting is the API's default.
  const defaults: Json = {
    app_launcher_visible: true,
    http_only_cookie_attribute: true,
    options_preflight_bypass: false,
    service_auth_401_redirect: false,
  };
  for (const field of Object.keys(defaults))
    if (field in wanted && (app[field] ?? defaults[field]) !== wanted[field])
      drift.push(field);
  if (isObject(app.cors_headers) && Object.keys(app.cors_headers).length > 0)
    drift.push("cors_headers");
  return drift;
}

const sortKeys = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(sortKeys)
    : isObject(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, sortKeys(value[key])]),
        )
      : value;
/** Rules as a comparable set; an email is compared in lower case. */
function ruleSet(rules: unknown): string[] {
  return (Array.isArray(rules) ? rules : [])
    .map((rule) => {
      const email =
        isObject(rule) && isObject(rule.email)
          ? text(rule.email.email)
          : undefined;
      return JSON.stringify(
        sortKeys(
          email === undefined
            ? rule
            : { email: { email: email.toLowerCase() } },
        ),
      );
    })
    .sort();
}
function policyDrift(
  policy: Json,
  spec: PolicySpec,
  precedence: number,
): string[] {
  const drift: string[] = [];
  if (policy.decision !== spec.decision) drift.push("decision");
  if (typeof policy.precedence === "number" && policy.precedence !== precedence)
    drift.push("precedence");
  if (
    spec.session !== undefined &&
    !sameDuration(policy.session_duration, spec.session)
  )
    drift.push("session_duration");
  if (ruleSet(policy.include).join() !== ruleSet(spec.include).join())
    drift.push("include");
  if (ruleSet(policy.exclude).length > 0) drift.push("exclude");
  if (ruleSet(policy.require).join() !== ruleSet(spec.require).join())
    drift.push("require");
  for (const field of [
    "approval_required",
    "purpose_justification_required",
    "isolation_required",
  ])
    if (policy[field] === true) drift.push(field);
  return drift;
}

// ---------- The run ----------

export interface Dependencies {
  token: string;
  fetch: Fetch;
  log: (line: string) => void;
  now: () => Date;
  /** Where the shell token's secret goes; the file writer below unless a test replaces it. */
  writeSecret?: (path: string, content: string) => Promise<void>;
}
export interface Verification {
  ok: boolean;
  line: string;
}
export interface Result {
  /** The writes made (apply) or that would be made (plan). */
  changes: number;
  verification?: Verification;
}

/**
 * An unauthenticated GET to a hostname of the gateways' family. Only a refusal by Access, 401 or
 * 403, is protection: a redirect is a login page, which the gateways must not have, and anything
 * else, a 404 included, came from a node or its Tunnel, past Access.
 */
export async function verifyRefusal(
  hostname: string,
  fetchImpl: Fetch,
): Promise<Verification> {
  const url = `https://${hostname}/`;
  let response: Response;
  try {
    response = await fetchImpl(url, { method: "GET", redirect: "manual" });
  } catch (error) {
    const cause = (error as { cause?: { code?: unknown } }).cause?.code;
    return {
      ok: false,
      line: `verify FAILED: ${url} could not be reached (${typeof cause === "string" ? cause : "network error"}); the name must resolve, so pass --verify-hostname with the hostname of a node`,
    };
  }
  const answered = `verify ${response.status === 401 || response.status === 403 ? "ok" : "FAILED"}: ${url} without credentials answered ${response.status}`;
  if (response.status === 401 || response.status === 403)
    return { ok: true, line: answered };
  const location = response.headers.get("location");
  return {
    ok: false,
    line: `${answered}${location === null ? "" : ` (a redirect to ${hostOf(location, url)}: a login page, not a refusal)`}; expected 401 or 403`,
  };
}
const hostOf = (location: string, base: string) => {
  try {
    return new URL(location, base).host;
  } catch {
    return "another page";
  }
};

interface Context {
  call: Call;
  accountPath: string;
  appsPath: string;
  say: (line: string) => void;
  /** One write: shown, counted and, on apply, made. */
  act: <T>(what: string, write: () => Promise<T>) => Promise<T | undefined>;
  findByName: (
    what: string,
    path: string,
    name: string,
  ) => Promise<Json | undefined>;
}

export async function run(
  options: Options,
  deps: Dependencies,
): Promise<Result> {
  const apply = options.mode === "apply";
  let changes = 0;
  const accountPath = `/accounts/${options.account}`;
  const call = cloudflareCall(deps.token, deps.fetch);
  const context: Context = {
    call,
    accountPath,
    appsPath: `${accountPath}/access/apps`,
    say: deps.log,
    act: async (what, write) => {
      changes++;
      deps.log(`  change: ${what}`);
      return apply ? await write() : undefined;
    },
    findByName: async (what, path, name) => {
      const found = (await list(call, path)).filter(
        (item) => item.name === name,
      );
      if (found.length > 1)
        throw new Error(
          `there are ${found.length} ${what} named "${name}"; delete the extra ones in the dashboard`,
        );
      return found[0];
    },
  };
  const summary = () =>
    apply
      ? `apply: ${changes} change${changes === 1 ? "" : "s"} made`
      : `plan: ${changes} change${changes === 1 ? "" : "s"} would be made; nothing was written`;
  context.say(apply ? "apply" : "plan (nothing is written)");

  if (options.remove) {
    for (const name of [GATEWAY_APPLICATION, SHELL_APPLICATION]) {
      const app = await findApplication(context, name);
      if (app === undefined) context.say(`application "${name}": not there`);
      else {
        context.say(`application "${name}":`);
        await context.act("delete the application and its policy", () =>
          call("DELETE", `${context.appsPath}/${String(app.id)}`),
        );
      }
    }
    context.say(
      "the gateways have their route token alone from now on; turn NODE_SHELL_HOSTNAME off before the shell application goes, or the shell hostnames are open",
    );
    context.say(summary());
    return { changes };
  }

  // The shell's policies are read first: they can refuse a run, and nothing is written yet.
  let operatorPolicy: PolicySpec | undefined;
  if (options.operators !== undefined) {
    const providers = await list(
      call,
      `${accountPath}/access/identity_providers`,
    );
    // The type, not the name, which the organization may have changed.
    const pin = providers.find((provider) => provider.type === "onetimepin");
    if (pin === undefined)
      context.say(
        "the organization has no one-time PIN identity provider: the operators policy names no login method",
      );
    operatorPolicy = {
      name: SHELL_POLICY,
      decision: "allow",
      include: options.operators.map((email) => ({ email: { email } })),
      require: pin === undefined ? [] : [{ login_method: { id: pin.id } }],
    };
  }
  // What can refuse the run is read before the first write: the shell token's too.
  const shellToken =
    options.shellServiceToken === undefined
      ? undefined
      : await readShellToken(context, options, deps);
  const tokenId = await ensureServiceToken(context, options, deps.now());
  const shellTokenId = await shellToken?.();
  await ensureApplication(context, {
    name: GATEWAY_APPLICATION,
    domain: gatewayPattern(options.domain),
    session: GATEWAY_SESSION,
    serviceAuth401: true,
    policies: [
      {
        name: GATEWAY_POLICY,
        decision: "non_identity",
        include: [{ service_token: { token_id: tokenId } }],
        require: [],
      },
    ],
  });
  if (operatorPolicy !== undefined)
    await ensureApplication(context, {
      name: SHELL_APPLICATION,
      domain: shellPattern(options.domain),
      session: SHELL_SESSION,
      serviceAuth401: false,
      policies: [
        operatorPolicy,
        ...(shellTokenId === undefined
          ? []
          : [
              {
                name: SHELL_TOKEN_POLICY,
                decision: "non_identity" as const,
                include: [{ service_token: { token_id: shellTokenId } }],
                require: [],
                session: SHELL_TOKEN_SESSION,
              },
            ]),
      ],
    });
  context.say(summary());
  if (!options.verify) return { changes };
  const verification = await verifyRefusal(
    options.verifyHostname ??
      `${NODE_GATEWAY_LABEL_PREFIX}probe.${options.domain}`,
    deps.fetch,
  );
  context.say(verification.line);
  return { changes, verification };
}

const findApplication = (context: Context, name: string) =>
  context.findByName(
    "applications",
    `${context.appsPath}?name=${encodeURIComponent(name)}&per_page=1000`,
    name,
  );

/** What the plan shows for a service token that apply would create. */
const NEW_TOKEN = "(the service token to be created)";

/**
 * The service token the Edge presents. A secret is shown once by Cloudflare, so a token is created
 * or rotated only when the Edge Worker is named, and its client id and secret go from the answer
 * straight into the Worker's secrets: they are in no output line and in no file. Everything that can
 * refuse the run is read before the first write.
 */
async function ensureServiceToken(
  { call, accountPath, say, act, findByName }: Context,
  options: Extract<Options, { remove: false }>,
  now: Date,
): Promise<string> {
  const edge =
    options.edgeWorker === undefined
      ? undefined
      : {
          name: options.edgeWorker,
          path: `${accountPath}/workers/scripts/${encodeURIComponent(options.edgeWorker)}/secrets`,
        };
  const held =
    edge === undefined
      ? undefined
      : new Set(
          (await list(call, edge.path)).map((secret) => text(secret.name)),
        );
  const name = options.serviceToken;
  const token = await findByName(
    "service tokens",
    `${accountPath}/access/service_tokens?name=${encodeURIComponent(name)}&per_page=1000`,
    name,
  );
  const requireEdge = (verb: "create" | "rotate") => {
    if (edge === undefined)
      throw new Error(
        `refusing to ${verb} the service token "${name}" without --edge-worker: Cloudflare shows its secret once, and a secret nobody receives is worse than none`,
      );
    return edge;
  };
  const deliver = async (target: { path: string }, issued: unknown) => {
    for (const field of [
      [EDGE_SECRETS.id, "client_id"],
      [EDGE_SECRETS.secret, "client_secret"],
    ] as const) {
      const value = isObject(issued) ? text(issued[field[1]]) : undefined;
      if (!value)
        throw new Error("Cloudflare answered without the client credentials");
      await call("PUT", target.path, {
        name: field[0],
        text: value,
        type: "secret_text",
      });
    }
  };

  if (token === undefined) {
    const target = requireEdge("create");
    say(`service token "${name}": missing`);
    const id = await act(
      `create it (duration ${TOKEN_DURATION}) and set its client id and secret as ${EDGE_SECRETS.id} and ${EDGE_SECRETS.secret} of Worker "${target.name}"`,
      async () => {
        const made = await call(
          "POST",
          `${accountPath}/access/service_tokens`,
          {
            name,
            duration: TOKEN_DURATION,
          },
        );
        const id = isObject(made) ? text(made.id) : undefined;
        if (id === undefined)
          throw new Error("Cloudflare answered without the service token");
        try {
          await deliver(target, made);
        } catch (error) {
          // A token whose secret nobody holds is deleted again.
          const reason = error instanceof Error ? error.message : "failed";
          const undone = await call(
            "DELETE",
            `${accountPath}/access/service_tokens/${id}`,
          ).then(
            () => "the token was deleted again",
            () => `delete the service token "${name}" in the dashboard`,
          );
          throw new Error(
            `the secrets could not be set on the Edge Worker (${reason}); ${undone}`,
          );
        }
        return id;
      },
    );
    return id ?? NEW_TOKEN;
  }

  const id = text(token.id);
  if (id === undefined)
    throw new Error("Cloudflare answered a service token without an id");
  if (token.enabled === false)
    throw new Error(
      `the service token "${name}" is disabled; enable it in the dashboard, or delete it to have a new one made`,
    );
  // Everything that can refuse the run is checked before the first write. Rotating replaces the
  // secret and leaves the expiry alone, so an expired token needs a refresh in any case.
  const expires = text(token.expires_at);
  const daysLeft =
    expires === undefined
      ? Number.NaN
      : (Date.parse(expires) - now.getTime()) / 86_400_000;
  if (daysLeft <= 0 && !options.refresh)
    throw new Error(
      `the service token "${name}" expired on ${expires}, so Access refuses the Edge at every gateway; renew it with --refresh-service-token`,
    );
  say(
    `service token "${name}": exists${expires ? `, expires ${expires}` : ""}`,
  );
  if (daysLeft < EXPIRY_WARNING_DAYS && !options.refresh)
    say(
      `warning: the service token "${name}" expires in ${Math.floor(daysLeft)} days; renew it with --refresh-service-token, because rotating does not`,
    );
  const rotation = options.rotate ? requireEdge("rotate") : undefined;
  if (rotation === undefined)
    for (const secret of Object.values(EDGE_SECRETS))
      if (held !== undefined && !held.has(secret))
        throw new Error(
          `the Edge Worker "${edge?.name}" has no secret ${secret}, so Access would lock the Edge out; set both with --rotate-service-token`,
        );

  if (options.refresh)
    await act("refresh its expiry (Cloudflare adds one year)", () =>
      call("POST", `${accountPath}/access/service_tokens/${id}/refresh`),
    );
  if (rotation !== undefined)
    await act(
      `rotate its secret (the old one stays valid for ${options.graceSeconds} s) and set it as ${EDGE_SECRETS.secret} of Worker "${rotation.name}"`,
      async () => {
        const rotated = await call(
          "POST",
          `${accountPath}/access/service_tokens/${id}/rotate`,
          {
            previous_client_secret_expires_at: new Date(
              now.getTime() + options.graceSeconds * 1000,
            ).toISOString(),
          },
        );
        try {
          await deliver(rotation, rotated);
        } catch (error) {
          const reason = error instanceof Error ? error.message : "failed";
          throw new Error(
            `the new secret could not be set on the Edge Worker (${reason}); the old secret stays valid for ${options.graceSeconds} s: rotate again`,
          );
        }
      },
    );
  return id;
}

/** One application and its policies. Anything else on the application is put back or deleted. */
async function ensureApplication(
  context: Context,
  spec: ApplicationSpec,
): Promise<void> {
  const { call, appsPath, say, act } = context;
  const app = await findApplication(context, spec.name);
  say(`application "${spec.name}" (${spec.domain}):`);
  let id = text(app?.id);
  if (app === undefined) {
    const created = await act("create the application", () =>
      call("POST", appsPath, applicationBody(spec)),
    );
    id = isObject(created) ? text(created.id) : undefined;
  } else {
    const drift = applicationDrift(app, spec);
    if (drift.length > 0)
      await act(`put the application back (${drift.join(", ")})`, () =>
        call("PUT", `${appsPath}/${id}`, applicationBody(spec)),
      );
  }
  // Read after the update, and never before the application exists (a plan has no id to read).
  const policies =
    id === undefined ? [] : await list(call, `${appsPath}/${id}/policies`);
  const names = new Set(spec.policies.map((policy) => policy.name));
  // Nothing else may stand beside them: another policy would be another way in.
  for (const policy of policies) {
    if (names.has(text(policy.name) ?? "")) continue;
    if (policy.reusable === true)
      throw new Error(
        `the reusable policy "${String(policy.name)}" is attached to "${spec.name}"; detach it in the dashboard`,
      );
    await act(`delete the policy "${String(policy.name)}"`, () =>
      call("DELETE", `${appsPath}/${id}/policies/${String(policy.id)}`),
    );
  }
  for (const [index, wanted] of spec.policies.entries()) {
    const precedence = index + 1;
    const ours = policies.find((policy) => policy.name === wanted.name);
    if (ours === undefined)
      await act(`create the policy "${wanted.name}"`, () =>
        call(
          "POST",
          `${appsPath}/${id}/policies`,
          policyBody(wanted, precedence),
        ),
      );
    else {
      const drift = policyDrift(ours, wanted, precedence);
      if (drift.length > 0)
        await act(
          `put the policy "${wanted.name}" back (${drift.join(", ")})`,
          () =>
            call(
              "PUT",
              `${appsPath}/${id}/policies/${String(ours.id)}`,
              policyBody(wanted, precedence),
            ),
        );
    }
  }
}

// ---------- The shell's service token ----------

/**
 * Where a secret may be written: a path that is not there yet, in a directory that exists, that
 * the caller owns and that group and others cannot enter.
 */
export async function checkSecretFileDestination(path: string): Promise<void> {
  const directory = await stat(dirname(path)).catch(() => undefined);
  if (directory === undefined || !directory.isDirectory())
    throw new Error("--shell-token-file: its directory must exist");
  if ((directory.mode & 0o077) !== 0)
    throw new Error(
      "--shell-token-file: its directory is open to group or others; use one only you can enter (chmod 700)",
    );
  if (process.getuid !== undefined && directory.uid !== process.getuid())
    throw new Error("--shell-token-file: its directory is not yours");
  if ((await lstat(path).catch(() => undefined)) !== undefined)
    throw new Error(
      "--shell-token-file: the file exists already; it is never overwritten",
    );
}

/** The two lines of the shell token's file: an environment file, which holds no other text. */
export function shellTokenFileContent(id: string, secret: string): string {
  const plain = /^[A-Za-z0-9._-]{1,256}$/;
  if (!plain.test(id) || !plain.test(secret))
    throw new Error(
      "Cloudflare answered with client credentials of a shape this script does not write",
    );
  return `${SHELL_TOKEN_VARIABLES.id}=${id}\n${SHELL_TOKEN_VARIABLES.secret}=${secret}\n`;
}

/** A new file with mode 0600 that never replaces one, closed before it returns. */
export async function writeSecretFile(
  path: string,
  content: string,
): Promise<void> {
  const file = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o600,
  );
  try {
    await file.chmod(0o600);
    await file.writeFile(content);
    await file.sync();
  } finally {
    await file.close();
  }
}

/**
 * The service token of the shells, a token of its own: the Edge's is never allowed on the shells
 * and this one never on the gateways. This reads what can refuse the run, and returns what writes:
 * Cloudflare shows the secret once, so a missing token is made only when `--shell-token-file` says
 * where the secret goes, and it is deleted again when the file cannot be written. A token that
 * exists is used as it is, with its expiry shown; one that is disabled or has expired is refused.
 * Nothing but the file ever holds the client id or the secret.
 */
async function readShellToken(
  { call, accountPath, say, act, findByName }: Context,
  options: Extract<Options, { remove: false }>,
  deps: Dependencies,
): Promise<() => Promise<string>> {
  const name = options.shellServiceToken!;
  const token = await findByName(
    "service tokens",
    `${accountPath}/access/service_tokens?name=${encodeURIComponent(name)}&per_page=1000`,
    name,
  );
  if (token === undefined) {
    const file = options.shellTokenFile;
    if (file === undefined)
      throw new Error(
        `refusing to create the service token "${name}" without --shell-token-file: Cloudflare shows its secret once, and a secret nobody receives is worse than none`,
      );
    await checkSecretFileDestination(file);
    return async () => {
      say(`service token "${name}": missing`);
      const id = await act(
        `create it (duration ${SHELL_TOKEN_DURATION}) and write its client id and secret to ${file} (mode 0600)`,
        async () => {
          const made = await call(
            "POST",
            `${accountPath}/access/service_tokens`,
            { name, duration: SHELL_TOKEN_DURATION },
          );
          const id = isObject(made) ? text(made.id) : undefined;
          if (id === undefined)
            throw new Error("Cloudflare answered without the service token");
          try {
            const clientId = isObject(made) ? text(made.client_id) : undefined;
            const secret = isObject(made)
              ? text(made.client_secret)
              : undefined;
            if (!clientId || !secret)
              throw new Error(
                "Cloudflare answered without the client credentials",
              );
            await (deps.writeSecret ?? writeSecretFile)(
              file,
              shellTokenFileContent(clientId, secret),
            );
          } catch (error) {
            // A token whose secret nobody holds is deleted again, and so is a file that was begun.
            const reason = error instanceof Error ? error.message : "failed";
            await rm(file, { force: true }).catch(() => undefined);
            const undone = await call(
              "DELETE",
              `${accountPath}/access/service_tokens/${id}`,
            ).then(
              () => "the token was deleted again",
              () => `delete the service token "${name}" in the dashboard`,
            );
            throw new Error(
              `the secret of the shell token could not be written (${reason}); ${undone}`,
            );
          }
          say(
            `  the client id and secret are in ${file}; load them with: set -a; . ${file}; set +a`,
          );
          return id;
        },
      );
      return id ?? NEW_TOKEN;
    };
  }
  const id = text(token.id);
  if (id === undefined)
    throw new Error("Cloudflare answered a service token without an id");
  if (token.enabled === false)
    throw new Error(
      `the service token "${name}" is disabled; enable it in the dashboard, or delete it to have a new one made`,
    );
  const expires = text(token.expires_at);
  if (expires !== undefined && Date.parse(expires) <= deps.now().getTime())
    throw new Error(
      `the service token "${name}" expired on ${expires}; delete it in the dashboard and run again with --shell-token-file to have a new one made`,
    );
  return async () => {
    say(
      `service token "${name}": exists${expires ? `, expires ${expires}` : ""}${options.shellTokenFile === undefined ? "" : "; its secret is not shown again, so --shell-token-file is not used"}`,
    );
    return id;
  };
}

// ---------- The command ----------

async function main(
  argv: string[],
  environment: Record<string, string | undefined>,
) {
  const options = parseOptions(argv);
  const result = await run(options, {
    token: cloudflareApiToken(environment),
    fetch,
    log: (line) => console.log(line),
    now: () => new Date(),
  });
  if (result.verification?.ok === false) process.exitCode = 1;
}

if (import.meta.main) {
  main(process.argv.slice(2), process.env).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "failed");
    process.exitCode = 1;
  });
}
