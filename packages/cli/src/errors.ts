// SPDX-License-Identifier: Apache-2.0

/**
 * What the CLI says about each failure it reports: the cause and what to change. The texts are fixed,
 * so no argument, credential or upstream text can reach the output. The failures of a database
 * connection itself are answered by PostgreSQL's own error message in the client (psql), which names a
 * reason as `(pgcf: <reason>)`; docs/errors.md lists them.
 */
const EXPLANATIONS: Readonly<Record<string, string>> = {
  connect_command_required:
    "the first argument must be `connect`; run `pgcf connect --help`",
  invalid_arguments:
    "use only --endpoint, --database, --user and --port, each once with a value; run `pgcf connect --help`",
  invalid_endpoint:
    "--endpoint must be a wss://<host> URL without a path, query, credentials or fragment, for example wss://db.example.com",
  invalid_database:
    "--database must be the database ID the API returns (20 lowercase letters and digits, starting with a letter)",
  invalid_user:
    "--user must be a role name of the database; postgres, pgcf_backup, public, none and pg_* are not role names",
  invalid_port:
    "--port must be a whole number from 0 to 65535 (0 or omitted picks a free local port)",
  listener_failed:
    "the local port could not be opened; it may be in use, so choose another --port or omit it",
  connect_failed:
    "the bridge could not start; check the arguments with `pgcf connect --help` and retry",
};

/** The line the CLI prints for a failure, with the code first and the fix after it. */
export function describeFailure(error: unknown): string {
  const code =
    error instanceof Error && /^[a-z][a-z0-9_]{0,50}$/.test(error.message)
      ? error.message
      : "connect_failed";
  const explanation = EXPLANATIONS[code] ?? EXPLANATIONS["connect_failed"]!;
  return `pgcf: ${code}: ${explanation}\n`;
}
