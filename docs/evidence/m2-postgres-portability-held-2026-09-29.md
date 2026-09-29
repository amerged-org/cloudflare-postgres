# Portable PostgreSQL candidate held at its second attempt

A separate `codex/postgres-portability` draft implements a generic native logical
export/import command using unmodified PostgreSQL 18 clients. Its intended outcome
is consistent custom-archive export and transactional import into a fresh
restricted-owner database. This is the approved portability requirement; it does
not replace physical backup, WAL or PITR. The source is not merged, packaged for
release or deployed.

## Bounded work and observed results

The baseline remains 65 automated cases. Exactly three new Node cases cover the
real TLS transfer, failed import/occupied-target protection and private artifacts/
credentials. Disposable local PostgreSQL 18.4 servers use an official digest-pinned
image, loopback ports, generated certificates and distinct restricted source and
target owners. Host client tools are PostgreSQL 18.4 and Node is 24.6.0 on macOS
arm64. No Cloudflare/Contabo credential or customer database is used.

The initial named run fails all three cases in 19.832 seconds. The first two
demonstrate the missing implementation. The CLI initially has a source import
harness error; one harness-only correction precedes its meaningful missing-feature
failure in 3.618 seconds. The three-case count is unchanged.

Implementation attempt one takes 9.335 seconds: two cases pass, while the roundtrip
fails because the SQL renderer lacks `pg_restore --file=-`. A pre-SQL failure must
not count as rollback evidence, so the same existing rollback case additionally
requires the executor's SQL-phase uncertainty marker. Attempt two corrects only
the renderer and the CLI's detached-child signal cancellation, then takes 8.010
seconds. Privacy/protection cases pass; the transfer still fails: the command
returns restored, but a fresh target SQL read cannot find the expected table.

Two static fixture reviews also strengthen the same intended cases before the
second attempt: source/target identities differ to prove ownership remapping, and
an omitted relation is referenced through a view rather than an unchecked SQL
function body. No matrix, speculative suite or additional top-level case is added.

## Stop, diagnosis and next step

The same transfer case remains red after two implementation attempts. The
mandatory stop applies: no third correction, renamed qualifier, full gate, runtime
publication or deployment follows. Sixteen draft source/test/config/document files
are retained with hashes in the ignored worktree.

The source fixture submits setup DDL, `BEGIN`, an insertion and `ROLLBACK` in one
`psql --command` request. PostgreSQL executes that message in one transaction;
without a setup `COMMIT` boundary the rollback also removes its setup objects.
This is a concrete fixture defect rather than proven data loss in the wrapper.
[PostgreSQL command transaction semantics](https://www.postgresql.org/docs/18/app-psql.html),
[multi-statement protocol semantics](https://www.postgresql.org/docs/18/protocol-flow.html#PROTOCOL-FLOW-MULTI-STATEMENT).

The smallest proposed next step separates committed fixture setup from its
rollback exercise and explicitly proves source rows before export. It remains
unapplied; repeating qualification requires an explicit exception to the current
two-attempt stop. Privacy checks and empty-target readback alone do not establish
a complete data roundtrip or that the intended failed restore reached its DDL.
Logical migration portability therefore remains unqualified.

The local environment and the held budget-history, Pod-birth and SDK drafts remain
unchanged. Test containers are removed after each invocation. Regional admission,
the Worker/D1 schema and customer database infrastructure are untouched. Native
provisioning/access, physical recovery, runtime budgets, sleep/wake, scaling,
operations and other v1 requirements remain open.
