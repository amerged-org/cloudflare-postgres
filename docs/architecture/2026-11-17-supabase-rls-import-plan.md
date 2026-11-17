# Policy-preserving Supabase import implementation plan

**Goal** — Show an application owner which source policies transfer, then prove equivalent access decisions on PostgreSQL served by PGCF.

**Architecture** — A local importer translates the supported policy grammar and reports unsupported dependencies before generating migrations. The adopter authenticates application users and supplies verified transaction-local claims. PostgreSQL enforces the translated policies. Generic PGCF supplies SQL, roles and recovery. Identity-provider choices stay with the application.

**Stack and specification** — PostgreSQL policies, a schema-only dump, an adopter-owned TypeScript runtime and local migration tooling. Read the [shared design](2026-11-17-postgres-application-features.md) and [PGCF role and transport contract](../operations/integrator-handover.md). For execution, use Superpowers executing-plans or subagent-driven-development.

## 1. Add a read-only compatibility report

**Existing implementation reference** — In the ohmyho.st adopter, extend `skills/ohmyhost-migrate-supabase-postgres/scripts/create-portable-baseline.mjs`, its policy parser `portable-rls.mjs` and the adjacent `create-portable-baseline.test.mjs`. Other adopters may implement the same outcome with their own migration tools.

- [ ] Add the proposed `--report-only` option to the existing `preserve-rls` mode. Start with a CLI regression for a schema containing one translatable owner policy and one unsupported custom policy function. Expect a nonzero blocked result, both policies accounted for, and zero migration files. Refuse simultaneous output and report-only options. Existing generation invocations retain their behavior.
- [ ] Reuse generation's lexer, policy translator and extension dependency checks for the report. Report source table/policy identifiers, policy command, status, stable reason code, required extension names and unresolved identity assumptions. Use one of `preserved`, `translated` or `blocked` for each policy. A parse failure that prevents discovery of the full inventory marks the report incomplete and blocks generation. Keep identifiers and the report local, avoid raw SQL bodies, claim values and customer rows in logs.

  ```text
  sourcePolicies = preserved + translated + blocked
  canGenerate = completeInventory && blocked == 0 && allDependenciesResolved
  ```

  The following is the planned CLI contract. A compatible input exits successfully and writes the local summary to standard output. A blocked input emits a redacted summary and exits unsuccessfully.

  ```sh
  node skills/ohmyhost-migrate-supabase-postgres/scripts/create-portable-baseline.mjs \
    --input schema.sql --authorization-mode preserve-rls --rls-options reviewed-claims.json --report-only
  ```

- [ ] Fail closed on incompatible user IDs, unreviewed JWT claim mappings, service-role branches, unsupported role/function semantics or missing target extensions. Distinguish an installed extension from one admitted by the target migrator. Preserve permissive/restrictive composition, role applicability and implicit USING/WITH CHECK semantics. Report-only makes no role, schema or data change. An existing separately selected server-authorization migration mode remains an explicit alternative workflow.
- [ ] Run `node --test skills/ohmyhost-migrate-supabase-postgres/scripts/create-portable-baseline.test.mjs` in the adopter repo with real PostgreSQL binaries available. Extend the existing original-versus-converted fixture. Require the blocked report to generate nothing and the passing report to agree with the generated migration. Update the adopter's migration guide and public comparison to distinguish the preservation mode from modes that omit policies.

## 2. Prove access decisions through the application

**Existing implementation reference** — Reuse the adopter's `packages/customer-runtime/src/database-rls.ts`, `apps/project-database-runtime/test/customer-rls-auth.integration.test.ts`, and `apps/neon-management/test/database-rls-migrations.integration.test.ts`. The checked-in October release evidence for the original end-to-end conversion used Neon. It does not qualify the current EU1 path. Change runtime code only if the comparison reveals a discrepancy.

- [ ] Build one source fixture with two organizations, two users and anonymous access, including one shared readable row, one private row per user, and a write policy. Capture a deterministic baseline from the original policies using realistic caller privileges. Compare allowed row IDs, affected-row counts and SQLSTATEs. Carry the transaction to commit or confirmed rollback before comparing persisted state.
- [ ] On an isolated target, apply the generated schema with the migration role. Load only the explicitly selected fixture rows. Verify the backend session before beginning the RLS transaction. Populate only mapped, server-trusted claims, preserve the original subject IDs when the policies require UUIDs, and use the restricted runtime role. Exercise an allowed update, invisible rows, a cross-tenant insert, an update that would transfer ownership and consecutive users on a reused connection. For example, the forbidden update of an invisible row may affect zero rows, while violation of WITH CHECK on an otherwise reachable row should produce the same policy error as on the source.
- [ ] Run `pnpm exec vitest run apps/project-database-runtime/test/customer-rls-auth.integration.test.ts` when the identity/runtime path changes. Verify both anonymous and authenticated calls through the normal application endpoint. The operator path and the database owner are unsuitable substitutes for this check.
- [ ] With costed approval and security patch P1 verified, compare the source fixture with the deployed EU1 application path. Gate promotion on equal decisions, equal retained data and confirmed rejection of untrusted claims. If Dev shares physical data with Prod, first use a separately authorized isolated fixture. Make every live consumer and rollback artifact identity-aware before enforcing policies on shared tables. Promote reviewed schema changes only. Moving real user rows, auth identities or files is a separately scoped migration.
- [ ] On a mismatch, keep the current serving application and policies, record the specific operation and expected/observed decision, and rerun only the corrected case. A rollback app must still supply the verified identity required by the enforced policies. Record the accepted PGCF release, database/role configuration and redacted comparison counts in the canonical plan.
