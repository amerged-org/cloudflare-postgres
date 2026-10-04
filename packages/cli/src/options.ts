// SPDX-License-Identifier: Apache-2.0
import { isDatabaseId, isRoleName } from "@pgcf/contracts";

export interface ConnectOptions {
  endpoint: string;
  database: string;
  user: string;
  port: number;
}

export function validateOptions(value: ConnectOptions): ConnectOptions {
  let endpoint: URL;
  try {
    endpoint = new URL(value.endpoint);
  } catch {
    throw new Error("invalid_endpoint");
  }
  if (
    endpoint.protocol !== "wss:" ||
    !endpoint.hostname ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.pathname !== "/" ||
    value.endpoint.length > 2048 ||
    /[\s\\?#@]/.test(value.endpoint)
  )
    throw new Error("invalid_endpoint");
  if (!isDatabaseId(value.database)) throw new Error("invalid_database");
  if (!isRoleName(value.user)) throw new Error("invalid_user");
  if (!Number.isInteger(value.port) || value.port < 0 || value.port > 65535)
    throw new Error("invalid_port");
  return {
    endpoint: endpoint.href,
    database: value.database,
    user: value.user,
    port: value.port,
  };
}

export function parseArgs(args: readonly string[]): ConnectOptions | "help" {
  if (args.length === 1 && ["--help", "-h"].includes(args[0]!)) return "help";
  if (args[0] !== "connect") throw new Error("connect_command_required");
  if (args.length === 2 && ["--help", "-h"].includes(args[1]!)) return "help";
  const values = new Map<string, string>();
  for (let index = 1; index < args.length; index += 2) {
    const flag = args[index]!;
    const value = args[index + 1];
    if (
      !["--endpoint", "--database", "--user", "--port"].includes(flag) ||
      values.has(flag) ||
      value === undefined ||
      value.startsWith("--")
    )
      throw new Error("invalid_arguments");
    values.set(flag, value);
  }
  const port = values.get("--port");
  if (port !== undefined && !/^(?:0|[1-9][0-9]{0,4})$/.test(port))
    throw new Error("invalid_port");
  return validateOptions({
    endpoint: values.get("--endpoint") ?? "",
    database: values.get("--database") ?? "",
    user: values.get("--user") ?? "",
    port: port === undefined ? 0 : Number(port),
  });
}

export function upstreamUrl(options: ConnectOptions): string {
  const url = new URL(options.endpoint);
  url.pathname = "/v2";
  url.searchParams.set("database", options.database);
  url.searchParams.set("user", options.user);
  return url.href;
}

export function instructions(port: number): string {
  return `Listening on 127.0.0.1:${port}. Use psql with host=127.0.0.1 port=${port} sslmode=disable and your database/user settings.\nLoopback is plaintext; the public connection uses verified WSS.\n`;
}
