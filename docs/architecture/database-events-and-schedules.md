# Database events, schedules and webhooks (proposal)

Status: accepted by the owner on 2026-10-30 with the defaults of section 10 (cron-to-webhook is out of
PGCF). Implementation follows the tasks of section 8; the ULTRA plan (11.1) records what is built and
accepted. Based on `origin/main` at `5a9aaf27`.

## 1. Goal

Supabase pairs a database with triggers: change webhooks (`pg_net`), cron (`pg_cron`) and queues
(`pgmq`). PGCF adopts the **trigger sources** (time, data change, platform state) and leaves the
**targets** (functions, storage, auth) to integrators. An integrator turns PGCF's execution metrics
into its own prices and credits.

| Source | Fires when | Needs the database awake |
| --- | --- | --- |
| Platform event | PGCF's own state changes (ready, woke, slept, backup failing, operation done) | No |
| Schedule | A time expression is due; the job is SQL sent through the normal HTTP `/sql` path | Yes, the schedule wakes it |
| Data event | A transaction that wrote an event commits | Yes, it is already awake |

## 2. Facts this builds on

- A database has no network at all, only a Unix socket (ULTRA 5.5). `pg_net`, `http`, `dblink` and
  FDW therefore cannot work. A cold database has no process (ULTRA 1.2), so `pg_cron` could not fire.
- `wal_level=replica`, no replication slots, no WAL senders, no `REPLICATION` role; the tenant role
  `app` is not a superuser (ULTRA Appendix C, 8).
- **Access.** HTTP `/sql` is the path for agents, automation tools and this plan (decision E9). One
  request or one `transaction()` of up to 256 statements; it waits for a wake for at most 60 s; a lost
  answer is `08007` and the request is never sent twice (handover 3.7). Clients other than the Neon
  driver send `Neon-Connection-String`, `Neon-Raw-Text-Output: true` and `Neon-Array-Mode: true`.
- There is no PostgreSQL TCP endpoint. A `postgres://` URI is a credential carrier, so the PostgreSQL
  nodes of automation tools and desktop SQL clients cannot connect (handover 1.1, 3.1).
- The control plane can already read a role's password (`connection-uri`, handover 2.3), so it can
  run a job as an ordinary database role over the same path without a new credential.
- A manually suspended database is not woken by connections (handover 2.4).
- Integrators poll operations. There is "no event stream or webhook (open work)", and integrator
  alert subscriptions are explicitly not introduced (handover 2.2, 6).
- Operator alerts have their own durable D1 outbox (handover 6). It stays as it is.
- Worker cron triggers were not delivered on time for stretches of minutes on 2026-10-23, which is why
  the CronWatchdog runs on Durable Object alarms (`apps/api/src/cron-watchdog.ts`).
- The Edge counts a service-binding caller in its own limiter (handover 3.7).
- AGENTS.md keeps Durable Objects, Workflows and the management API in TypeScript.

## 3. Principles

1. **Sources, not targets.** PGCF delivers an HTTPS request or runs SQL. It runs no functions and
   stores no files.
2. **Cloudflare owns the configuration.** Schedules, subscriptions and signing secrets live in D1 and
   Durable Objects, never in the database or its backups. (Supabase stores URL and key in the trigger
   definition, which ends up in dumps.)
3. **Events are exactly as durable as the data.** A data event is written in the same transaction as
   the change: rollback means no event, commit means one event, and a lost commit loses its event too.
4. **Never replay an uncertain write.** An unknown outcome (`08007`) is recorded and never sent again.
   A schedule's next tick is a new run, not a replay.
5. **Metrics only.** PGCF counts executions. It has no prices, credits or budgets. An integrator that
   runs out of credits uses the existing suspend call; a suspended database is not woken by a schedule.
6. **Simple and scalable.** One new Durable Object class, one actor per database, everything driven by
   its own alarm. No Queues, no central pump, no job protocol on the nodes, no Rust. Add any of them
   only for a measured bottleneck (section 9).

## 4. Design

### 4.1 Overview

```
Platform state ─┐                            ┌─> signed HTTPS webhook ──> integrator
Node outbox ────┼─> TriggerActor (one per DB) ┤
Schedule alarm ─┘   schedules, event buffer,  └─> /sql through the Edge, as a DB role
                    deliveries, counters
```

### 4.2 The TriggerActor

- One Durable Object per database, created lazily by the first schedule or event. A database that never
  uses either has no actor.
- Its own storage holds: the database's schedules, the buffered events, the deliveries per
  subscription with their attempts, a bounded run history (last runs, failures kept longer) and the
  hourly counters.
- It sets one alarm for the earliest of the next fire and the next delivery attempt. Nothing polls.
- Subscriptions, signing secrets and role credentials live in D1, scoped by project. The actor reads
  them when it needs them and may cache them briefly.
- Counters are flushed to D1 once per hour, as the existing usage rollup does. There is no D1 row per
  event or per run.

### 4.3 Delivery

- A **subscription** has a project, an optional list of databases, event type patterns, an HTTPS URL
  and a signing secret that is shown once.
- A **delivery** is signed with HMAC and a timestamp and carries a stable `id`, `type`,
  `database_id`, `occurred_at` and, for data events, `seq`. A failed delivery is retried with backoff
  for 24 hours, then dead-lettered and replayable for seven days. The receiver deduplicates by `id`.
  A `429` or `503` with `Retry-After` sets the next attempt.
- A subscription may hold static request headers, stored like the signing secret. Many automation
  tools cannot verify an HMAC signature, but they can check a header or keep a secret URL.
- `POST /v1/webhooks/{id}/test` sends a sample event, because automation tools learn their field
  mapping from a first request.
- URLs must be HTTPS. Loopback, link-local, metadata and private addresses are refused (SSRF).

### 4.4 Platform events

`database.ready`, `database.woke`, `database.slept`, `database.suspended`, `operation.succeeded`,
`operation.failed`, `backup.failing`, `archive.failing`, `storage.warning`. The API and the node
intake already know each of them; they hand the event to the database's actor. The database is not
touched. This removes operation polling and is the smallest first step.

### 4.5 Data events (the webhooks)

- Every database gets a platform-owned schema `pgcf` at create and at restore, installed by the node
  agent: an `outbox` table that tenant roles cannot read, `pgcf.emit(topic, payload)` that tenant
  roles may execute, and an optional generic trigger function `pgcf.capture(columns)` that emits a flat
  `{schema, table, op, record, old_record}`. `columns` is an allowlist, so password hashes and personal
  data do not leave for a third-party tool by default.
- A trigger is one SQL statement. The integrator runs it through its migrations or through its own
  management role, and may wrap it in its own "watch this table" tool. An integrator whose migration
  policy refuses triggers on existing tables must admit this one form. PGCF adds no watch API.
- The node agent drains the outbox over the local socket. An internal `LISTEN` session is the
  wake-up call, the table is the truth. It sends a batch over the node link to the database's actor and
  deletes the rows only after the actor has durably stored them. A dead receiver therefore never fills
  the database's disk.
- `event_id` is `{database_id}:{epoch}:{seq}`. The epoch is the database's restore generation, so an
  in-place point-in-time restore cannot repeat an id.
- The sleep proof (ULTRA 7.9) gets one more guard: the outbox must be empty. Otherwise the sleep is
  refused with a reason like `power_outbox`, and the database stays awake and wakeable.
- Limits: payload size, outbox rows and emits per second are operator settings. When the actor refuses
  a batch because its buffer is full, the agent keeps the rows, the outbox reaches its cap and `emit`
  raises an error, so the application sees it ("fail loudly"). Nothing is dropped silently.
- Delivery is at-least-once, ordered by `seq` where possible; retries can reorder, so the payload
  carries `seq`.

### 4.6 Schedules

A schedule belongs to one database and has: a name, a cron expression or `every_seconds >= 60`, one
or more SQL statements (one transaction), an existing database `role` to run as, a timeout and
`enabled`. The minimum interval is one minute. Anything faster means an always-warm database.

How a run goes:

1. The alarm fires at `scheduled_time` plus a deterministic per-database jitter inside the interval.
2. The actor sends the statements as one HTTP `/sql` transaction through a service binding into the
   Edge, authenticated as the schedule's role, after a `SET LOCAL statement_timeout`. The Edge wakes
   the database like for any request. Scheduled traffic has its own limiter bucket, so it cannot use
   up the buckets of user traffic.
3. The result is recorded in the run history and counted. The actor sets the next alarm.

Rules, all deliberately small:

- **Capacity refusal (`57P03` with a retry hint):** the actor re-arms its alarm at the hint, until half
  the interval has passed, then records `skipped_capacity`.
- **Unknown outcome (`08007`):** recorded as `outcome_unknown`, never sent again. The next tick is a
  new run. Jobs should be idempotent, as cron jobs always have to be.
- **Missed run** (database suspended, node down, actor late): skipped and recorded, never made up.
- **Overlap:** one fire per schedule at a time. A run still going makes the next `skipped_overlap`.
- **Activity:** a run is an ordinary request, so the idle clock restarts after it.
- A manual `POST .../run` exists for tests and operations.

There is no job role, no ledger and no new order on the node link. A schedule is "an HTTP `/sql`
request that PGCF sends at a time".

### 4.7 Queues

Two meanings, handled separately:

- **Push queue** (a message that must reach a consumer with retries): this is a data event with a
  subscription. No extra component.
- **Pull queue inside the database** (`pgmq`): a pure SQL extension that can be added to the node image
  on demand. PGCF does not meter its messages; the database's awake time already carries the cost.

A Cloudflare-side pull queue API is not proposed.

### 4.8 Metering and the credit boundary

New hourly and daily counts per database, in a separate endpoint (`GET /v1/execution-usage`) so that
the strictly parsed `GET /v1/usage` does not change; rows are final two hours after the period:

| Metric | Counted when |
| --- | --- |
| `schedule_runs` with `succeeded`, `failed`, `timed_out`, `outcome_unknown`, `skipped` | The run reaches its terminal state, once per `{schedule, scheduled_time}` |
| `events_emitted`, `event_bytes` | The actor stores the drained batch |
| `webhook_deliveries` with `delivered`, `failed`, `dead_lettered`, plus `webhook_attempts` | The delivery reaches its terminal state; attempts are counted separately |

The integrator decides what costs credits. A scheduled wake also appears in `awake_seconds`, as every
wake does. A reference cost per million executions is measured in section 9, so integrators can set a
price floor.

Technical caps are operator settings, like size classes: schedules per database, minimum interval,
maximum timeout and statements, subscriptions per project, emit rate and payload size. They are abuse
limits, not budget enforcement.

### 4.9 Security

- Subscription secrets are stored encrypted with a Worker secret and never logged. The signature is
  verifiable by the receiver without a callback.
- Tenant roles cannot read or change the outbox. They can only call `emit`. A tenant that forges events
  for its own database harms only itself.
- A job runs as the integrator's own role with its own grants. PGCF adds no privileged job identity and
  no new node surface.
- All access still enters through Cloudflare, and nodes get no new inbound port.

### 4.10 Lifecycle semantics

| Case | Behavior |
| --- | --- |
| Restore (new database id) | Schedules and subscriptions are keyed by database id, so the copy has none. The agent truncates the restored outbox on create, so the copy cannot resend the source's pending events. Needs its own live test. |
| In-place point-in-time restore | Same id: schedules stay; the epoch increases; the outbox is truncated. |
| Move to another node | Same id and data. Schedules continue; pending outbox rows move with the volume. |
| Manual suspend | Schedules do not wake it; the run is `skipped`. |
| Delete | The actor is removed. Undelivered events are dead-lettered for the retention period, not delivered after deletion. |
| Node loss | Outbox rows not yet in R2 are lost together with their transactions, which stays consistent. |

### 4.11 Agents and automation tools

The use case is: "give my agent the SQL address" and "notify my agent, Make, Zapier or n8n by webhook".

| Need | Path | Note |
| --- | --- | --- |
| An agent or tool sends SQL | HTTP `POST /sql` | Any HTTP client works. The address is `https://<host>/sql` with the host of the `postgres://` URI. |
| A PostgreSQL node or desktop client connects | Not possible | No TCP endpoint. The tool uses its HTTP module, or calls an integrator-hosted endpoint. |
| A long-running automation needs a credential | An ordinary role with `valid_until` | PGCF has no lifetime limit of its own. Whether a tool gets a lasting credential, or calls a stable endpoint of the integrator instead, is the integrator's policy. |
| A tool is notified of a row change | Data event and subscription | Its catch-hook URL is the subscription target. It should answer at once, because a slow answer is a failed attempt and causes a duplicate. |
| A chat agent is notified | Not possible directly | It has no URL. A hosted workflow or function receives the webhook and acts for it. |

Direct SQL from a third-party tool bypasses whatever the integrator's own application layer enforces,
so a read-only role is the sensible default for it.

## 5. Scale: 1,000,000 schedules

The question is whether the minute tick needs a fast central pump, for example in Rust. It does not,
because there is no central tick.

- **The unit of scale is one actor per database.** Each actor wakes itself by alarm at its own next
  due time, so the load spreads over Cloudflare's machines by itself. There is no shared index, no
  queue and no D1 row per run on the fire path.
- **What is shared on the fire path:** one D1 read for the role credential (and subscriptions, for
  events), the Edge limiter bucket of scheduled traffic and the node's wake admission. The first is
  cached briefly in the actor if measurement 2 shows it is hot.
- **I/O, not CPU.** A fire reads a few rows and makes one request. Rust would not make it faster, and
  Durable Objects stay TypeScript per AGENTS.md.
- **The limit is the node.** 1M schedules at one per minute would be 16.7k fires/s, at one per hour
  about 280/s, at one per day about 12/s. Every fire wakes a database, and a node carries tens of awake
  databases at once (ULTRA 4.5, 4.11). The executions per second a region can serve are its wake
  capacity. Jitter spreads the fires, the own limiter bucket protects user traffic and the retry
  hint re-arms the alarm instead of piling up. `regional_node_capacity_refusals` already alerts on
  pressure.
- **Frequent schedules defeat sleep.** A schedule whose interval is shorter than the idle time keeps
  the database awake. The run metric and `awake_seconds` make that visible, and the integrator prices
  it.
- **When to add machinery.** If measurement 3 shows that scheduled wakes delay user wakes, the wake
  ticket gets a `scheduled` flag and the node's start queue serves user wakes first. If measurement 1
  shows a bottleneck in the actors, the answer is chosen from that evidence (for example Queues for
  burst buffering), not before.

## 6. API sketch (generic, versioned like the rest of `/v1`)

- `POST/GET /v1/webhooks`, `GET/PATCH/DELETE /v1/webhooks/{id}`, `POST /v1/webhooks/{id}/test`,
  `GET /v1/webhooks/{id}/deliveries`, `POST /v1/webhook-deliveries/{id}/replay`.
- `PUT/GET/DELETE /v1/databases/{id}/schedules/{name}`, `GET .../schedules`,
  `GET .../schedules/{name}/runs`, `POST .../schedules/{name}/run`.
- `GET /v1/usage` gains the metrics of 4.8. Writes take an `Idempotency-Key` as everywhere.
- CLI: `pgcf webhook ...`, `pgcf schedule ...`. The OpenAPI document and the handover are updated in
  the same change as each task below.
- An integrator exposes these calls through its own REST, CLI and MCP tools, scoped to its tenants, and
  prices them from the metrics of 4.8.

## 7. Not proposed

`pg_cron` and `pg_net` in the database, sub-minute schedules, HTTP-call schedules (an integrator's own
scheduler does that; a SQL job can `emit`, and the webhook path then delivers), Cloudflare Queues,
a job protocol or job role on the nodes, a run ledger, a central schedule pump, a node start-queue
priority (until measured), logical decoding and `REPLICATION` for tenants, Realtime with per-subscriber
RLS, Edge Functions, Auth, Storage, PostgREST, credit logic and budget enforcement. Realtime could
later fan out the same event stream through Durable Object WebSockets; that is a separate proposal.

## 8. Tasks

Each task is accepted only by live Dev evidence. Order follows dependencies.

**T1. TriggerActor, delivery and platform events.**
Outcome: an integrator creates a subscription and receives signed platform events.
Owned: `apps/api` (TriggerActor, subscriptions, delivery), `packages/contracts`, OpenAPI, migration, CLI.
Depends on: none.
Live acceptance: create a database and receive a signed `database.ready`; stop the receiver and see
retries, then the dead letter and a replay; duplicates carry the same `id`; operation polling is no
longer needed; SSRF targets are refused; a real n8n webhook and a real Make or Zapier catch hook
receive the test event, and a static header reaches them.
Done when: the handover's "no event stream or webhook" statement is replaced by the contract.

**T2. Schedules.** Control plane only; no node change.
Outcome: a cold database runs a scheduled SQL transaction and sleeps again.
Owned: `apps/api` (schedules in the TriggerActor, the service-binding call into the Edge, the limiter
bucket), contracts, CLI.
Depends on: T1.
Live acceptance: a cold database wakes at the due time with jitter, runs the job once and sleeps
afterwards; a forced lost answer (`08007`) ends as `outcome_unknown` and is not sent again, and the
next tick runs normally; a suspended database is skipped; a capacity refusal re-arms and ends as
`skipped_capacity` after half the interval; many databases with the same expression do not delay user
requests (measurement 3); a restored copy has no schedules.

**T3. Data events.** The only task that touches the node.
Outcome: a commit produces exactly one signed delivery.
Owned: `apps/node-agent` (`pgcf` schema install, drain, sleep guard), `apps/api`, contracts.
Depends on: T1.
Live acceptance: commit gives one delivery, rollback none; a receiver offline for one hour gets
everything in `seq` order afterwards; a kill of PostgreSQL during a drain delivers at least once and
loses nothing; a sleep with a pending outbox is refused and the database stays wakeable; an in-place
point-in-time restore does not repeat an `id`; a restored copy emits nothing; the cap makes `emit`
fail loudly; a row inserted through `/sql` reaches a real n8n workflow with only the allowed columns.

**T4. Metering and limits.**
Outcome: the metrics of 4.8 are final, the caps are operator settings, a reference cost is documented.
Depends on: T1–T3 as each lands (the metric of a source ships with that source).

**T5. On demand only.** `pgmq`, PostGIS or other extensions, and a Realtime fan-out, each as its own
proposal when an integrator asks.

## 9. Measurements before more machinery

1. Cost and latency of 100,000 TriggerActors with alarms on scratch Workers in Dev (create, fire,
   delete), deleted afterwards and checked by listing. Decides whether the actor needs help at all.
2. D1 reads per fire at the target rate, and whether a short cache in the actor is needed.
3. Start rate of one node while scheduled and user wakes run together (reuses the cold gate setup).
   Decides the `scheduled` flag and start-queue priority.
4. Cost of one million executions end to end, for the integrator's price floor.

## 10. Decisions for the owner, with defaults

| # | Decision | Default |
| --- | --- | --- |
| E1 | Overturn "no integrator alert subscriptions" for platform events | Yes |
| E2 | Minimum schedule interval | 60 s |
| E3 | What a full outbox does | `emit` fails loudly |
| E4 | Job identity | An existing database role through the `/sql` path; no node change |
| E5 | HTTP-call schedules | Decided by the owner, 2026-10-30: not in PGCF; the integrator builds it |
| E6 | Substrate for events and runs | The per-database actor only; no Queues until a measurement asks |
| E7 | Missed and unknown runs | Skip and record; never replay; next tick is a new run |
| E8 | Extension policy | Add only on request |
| E9 | Access paths | `/sql` is the path for agents and automation and for this plan. Keep WebSocket `/v2`: integrators use it for psql bridges and session runtimes, and interactive transactions, `COPY`, `LISTEN` and session state need it |
| E10 | Static headers on subscriptions | Yes, beside the HMAC signature |
| E11 | Explicit `sql_url` in the connection answer | No (decided while building): the address is `https://<host>/sql`, derived from the host that every credential already carries; a new field would break the integrator's strict parser before it is updated |
