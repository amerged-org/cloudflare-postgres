# PostgreSQL extension support implementation plan

**Goal** — Let a database owner opt into useful SQL capabilities and rely on their data, indexes and constraints after recovery.

**Architecture** — The signed Debian image supplies versioned extension files. PostgreSQL records activation in each database. Integrators admit reviewed extension declarations in their own migration systems. Use ordinary SQL wherever the supported release and authorized migration role permit it.

**Stack and specification** — Debian 13, PostgreSQL 18, signed node releases, Barman and R2. Read the [shared design and release constraints](2026-11-17-postgres-application-features.md). For task-by-task execution, use Superpowers executing-plans or subagent-driven-development.

## 1. Inventory and qualify the base set

**Files** — [Image recipe](../../infra/node-image/mkosi.conf), [package lock](../../infra/node-image/packages.lock.json), [lock tests](../../infra/node-image/lock.test.ts), [real PostgreSQL fixture](../../apps/node-agent/src/testpg.rs), [role setup](../../apps/node-agent/src/roles.rs) and [integrator handover](../operations/integrator-handover.md). Use the existing real-PostgreSQL test module in the role setup file for the focused role/extension case.

- [ ] Read the signed image's available versions and flags. On fresh disposable databases, also read the installed version and schema from `pg_extension` and `pg_namespace`. Record which extensions already exist before opt-in. The historical EU1 acceptance covers owner installation of `pgcrypto` and `btree_gist`. Qualify the remaining names and the adopter's actual migration login separately.

  ```sql
  SELECT name, version, superuser, trusted, relocatable, schema
  FROM pg_available_extension_versions
  WHERE name IN ('pg_trgm', 'unaccent', 'btree_gist', 'citext', 'pgcrypto',
                 'postgis', 'pg_jsonschema', 'ltree')
  ORDER BY name, version;
  ```

  A useful search fixture names the product `Schmidt`. In a fixture where `extensions` is the verified installation schema, exercise the installed operator class and operator by name:

  ```sql
  CREATE INDEX product_name_trgm ON products USING gin (name extensions.gin_trgm_ops);
  SELECT id FROM products WHERE name OPERATOR(extensions.%) 'Schmit' ORDER BY id;
  ```

- [ ] Write the search witness first. Activate `pg_trgm` as the database owner on a disposable fixture, then as the real migration login on a separate fresh fixture. Use a role-owned installation schema with controlled CREATE rights, qualify extension objects or set a trusted transaction-local search path. Create a GIN index with `gin_trgm_ops`, populate selective data and show that an indexed similarity query returns the seeded near-match. Where the role or package path fails, reproduce that failure before changing it. Keep the original result if the existing path already passes.
- [ ] Exercise the other four behaviors in the same fixture. Use `unaccent('García') = 'Garcia'`, verify a same-room overlapping booking is refused by a GiST exclusion constraint while a different room succeeds, check `UNIQUE` on `citext` rejects a case variant, and compare `digest('abc','sha256')` with the published SHA-256 test value. Qualify the actual collation for the case-insensitive witness. Verify a repeated migration retains the expected extension version and schema. A conflicting pre-existing installation requires a diagnostic.
- [ ] Change the image only for missing files or dependencies. Preserve unrelated package pins. For a packaging change, run `node --test infra/node-image/lock.test.ts` from the PGCF root and the existing signed-image boot job. For the SQL/role case, run `cargo test -p pgcf-node-agent --locked extension_owner_activation` after adding the named test. Require one executed real-PostgreSQL test with the pinned binaries available. A skipped or empty run supplies no evidence.
- [ ] Qualify the application migration path. For example, ohmyho.st currently admits `pgcrypto`, `btree_gist` and `unaccent` in `packages/contracts/src/database-migration-admission.ts`. In that repository extend its exact-name admission and converter only for qualified additions. Preserve old migrations and baseline behavior. A newly supported module is emitted only when selected or required by the imported schema. Test the allowed declaration, the unknown-extension refusal and the actual migrator's ability to create the index. Publish the verified names, SQL identifiers, schemas, roles and release floor in the integrator handover.

## 2. Qualify optional modules independently

| SQL name | Scenario | Acceptance on the actual target |
| --- | --- | --- |
| `postgis` | Nearby stores and delivery areas | Seed known coordinates, run an indexed geography-radius search and check the expected inside/outside results for a service polygon. Qualify the core geometry/geography package and its actual transitive dependencies. |
| `pg_jsonschema` | Customer-defined form fields | Add a JSONB constraint using the packaged release's documented validator. Accept a conforming document, reject a wrong-typed required field and read the original valid document after restore. |
| `ltree` | Folder or catalog hierarchies | Seed two independent trees, create the GiST path index and verify a subtree scan returns the descendants and excludes the sibling tree. Check the signed image first because this is a PostgreSQL-supplied extension. |

- [ ] Select one optional scenario at a time. Identify a PostgreSQL-18-compatible build for the supported Debian architecture. Verify source, binary digest, ABI, direct and transitive packages, and license obligations before adding it to the image. Update [third-party notices](../../THIRD_PARTY.md) for new components. If a reproducible distributable build cannot be established, leave that module unpublished and continue with the independent tracks.
- [ ] Check the actual control file and installation privileges. For a module requiring privileged installation, first verify its install scripts and writable-schema assumptions. If it is supportable, implement an exact-name opt-in order through Cloudflare desired state, tied to database ID, storage generation and a qualified release. The Rust agent executes fixed, reviewed SQL in a protected schema before reporting the installed version. Exercise duplicate orders, a mismatched existing installation and an ordinary runtime role attempting activation. Do not expose a general privileged SQL executor.

## 3. Prove recovery before advertising support

- [ ] After costed approval, repeat the selected witness over the normal EU1 connection with an operator-owned database. Restore it into a fresh target using the [recovery procedure](../operations/recovery.md). Verify the extension version, row result, constraint or index and actual function execution on the restored target. The [physical restore](../../apps/node-agent/src/archive/restore.rs) restores database files while the node release supplies the libraries. For adopters offering portable SQL exports, also import the witness into an independently initialized database.
- [ ] A release rollback must retain every library required by installed or restorable databases and compatible extension catalog versions. Gate placement, recovery and any image downgrade on that property before widening a mixed-release fleet. If compatibility cannot be maintained, stop new activations and use the prior compatible release or a forward fix. Preserve customer data and existing extension objects.

Upstream references cover the [PostgreSQL modules](https://www.postgresql.org/docs/18/contrib.html), [extension installation contract](https://www.postgresql.org/docs/18/sql-createextension.html), [PostGIS](https://postgis.net/documentation/getting_started/) and [pg_jsonschema](https://github.com/supabase/pg_jsonschema).
