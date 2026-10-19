# Proposal: the DatabaseActor off the serial cold path

**Status:** design proposal for the owner, 2026-10-19. Nothing here is built. It changes nothing in the [ULTRA plan](cloudflare-convergence-and-serverless-plan.md); a decision on it is recorded there (11.5) and its measurements in 11.1.

**Question.** A cold DatabaseActor sits in series in front of every first connect after a quiet period. Can the Edge reach the node in parallel with the actor (Option A), or can the actor start the node earlier (Option B), without breaking the invariants of plan 3.3?

**Short answer.**
- **Option A can be made safe**, but only in a form stricter than the research sketch: the Edge may open the gateway connection before the actor answers, the node may start PostgreSQL on it, and **no client byte moves until the actor's answer is exactly equal to what the node bound the connection to**. That needs a deterministic wake operation, a new route token version, a binding header from the gateway and a placement hint at the Edge.
- **Its gain is capped by the node path, not by the actor.** It hides the shorter of the two: about 40–250 ms on a cold idle sleeper and 70–110 ms on an awake database, only when the actor is cold *and* the Edge already knows the database's node (*estimate*, section 6). It moves the p95 only if at least 95 % of cold connects find that hint, and for databases idle for hours or days only a durable placement record (a new KV namespace) can promise that. Its own read latency is not measured.
- **Option B is safe** (it is today's ticket on a second path) but keeps the cold actor's start in series. It saves at most the actor's way back plus the Edge-to-gateway leg, about 0–50 ms, and nothing when NodeActor is cold itself (*estimate*).
- **Recommendation:** build neither yet. First measure whether an alarm keeps a DatabaseActor warm, and at what price (section 8). A warm actor admits in 18–37 ms instead of 112–633 ms, with no protocol change and no new node behaviour. Option A is the fallback if keep-warm fails or is refused, and only after the model test of section 7 exists.

---

## 1. The problem

### 1.1 The serial path today (code on main `c46d838c`)

1. The client opens `GET /v2?database=<id>&user=<role>` on the Edge (`apps/edge/src/index.ts`).
2. The Edge runs the rate limiters and `DatabaseActor.admitWake` together and awaits both (`apps/edge/src/admission.ts`, `admitRoute`). The Edge knows nothing about the database before the actor answers: not its region, its node, its gateway URL, its generation or whether it sleeps.
3. The actor answers from its own SQLite state (`apps/api/src/database-actor.ts`, `#admitWake`):
   - for an awake database, the verified target (generation, route revision, unit invocation ID): the Edge signs route **v6**;
   - for an idle sleeper, a wake ticket: a fresh random operation (`newOperationId()`), generation + 1, route revision and role revision hash. The actor stores it, so every connect of the same wake gets the same ticket. The Edge signs route **v5**. The D1 claim of the ticket runs after the answer, in the actor's `waitUntil`;
   - or a refusal: `3D000` and `28P01` (answered by the decoy), `57P03`, `53300`, `08006`.
4. Only then does the Edge dial the node's gateway through Access and the Tunnel (`apps/edge/src/gateway.ts`, `connectGateway`).
5. The gateway verifies the token (`packages/native-protocol/src/wake.rs`, `verify_wake`), checks the replay cache, and for a v5 queues the wake for the agent **before** it answers the upgrade (`apps/native-gateway/src/transport.rs`, `serve_held`; `hold.rs`).
6. The agent checks the ticket against its desired page and its volume, then starts the unit (`apps/node-agent/src/agent/power.rs`, `try_wake`).
7. The Edge hands the gateway's socket to the client unopened (`index.ts`). The client sends its StartupMessage and password. The gateway holds them until the agent's table shows the unit at the ticket's generation, then logs in and forwards.

So the node starts only after the actor has answered, and the actor's whole cold start is in series with the node path.

### 1.2 Measured numbers

| Part | Value | Basis |
| --- | --- | --- |
| `admitWake` seen by the Edge, warm actor | 18–37 ms | *measured (EU1)*, plan 11.1 row "Stage 5.3 cold first request" |
| `admitWake` seen by the Edge, cold actor | 230–549 ms in that row; 112–633 ms across the live Edge logs of 2026-10-18 summarised for this proposal | *measured (EU1)* |
| Cold minimal Durable Object, same SQL (the Cloudflare floor) | 105 / 230 ms (p50 / p95) | *measured (Dev)*, row "Cold DatabaseActor measured" |
| Cold actor in the Worker as then deployed (1.96 MB) | 184–254 / 317–449 ms; 173 of its 198 ms pass before `admitWake` starts; the way back is 26 ms | *measured (Dev)*, same row |
| Lighter Worker, merged in `c46d838c` | −25 ms (−74..−15) and −28 ms (−57..−12) at the median; p95 369 → 324 and 351 → 301 ms | *measured (Dev)*, same row |
| Separate actor script (not done) | a further −10 to −20 ms; the 105 ms floor stays | *measured (Dev)*, same row |
| Gateway upgrade (Edge → Tunnel → gateway → Edge) | 70–110 ms | *measured (EU1)*, Stage 5.3 row |
| Node path before `wake-node-path` | admission p50 130 / p95 203 ms, start p50 183 / p95 362 / max 539 ms, sum p50 320 / p95 518 ms | *measured (EU1)*, Stage 5.3 row (node power-cut 30 min before) |
| Node path after `wake-node-path` (merged `f025bf7a`) | the two volume checks 0.02–0.03 ms; start 99–245 ms (p50–p95 range across units) | *measured (lab)* and *measured (EU1, Stage 1)*, plan 5.9 steps 3 and 5 |

The plan's targets (3.1): Cloudflare's connect p95 ≤ 250 ms, and Cloudflare's own processing at most about 150 ms at p95. A cold actor alone uses 112–633 ms.

### 1.3 Who pays it

The metric (plan 3.1) counts only databases idle for at least one hour. The measurement found an object idle for 100 s already cold, so **every sample of the metric meets a cold actor**. So does the first connect, after a quiet minute or two, to any database that is still awake: an always-warm database, or one whose idle time is long. The second group is outside the metric but in every user's first request.

### 1.4 What only the actor knows

This list is the core of the safety question. When the Edge goes to the node before the actor answers, these facts are not checked yet:

1. **The mutation barrier.** A suspend, delete, resize, role change, move or scope fence closes the actor's admission *before* D1 commits (plan 5.3). The node learns of the change only when it pulls its page afterwards.
2. **D1 state newer than the node's page:** a committed delete, role removal, password rotation or resize that the node has not pulled yet. Role changes advance the database's generation (`apps/api/src/domain/roles.ts`) and change the role revision hash.
3. **The actor's own per-database admission counter** (`DATABASE_CONNECTION_LIMIT_PER_MINUTE`). The Edge limiters (120 per database per 60 s) are tighter and stay.
4. **The wake claim:** the generation D1 commits for the wake, and its operation.

The node, in turn, knows facts the actor does not: its RAM and disk, whether the volume exists and is intact, `pg_control` against the proven-sleep record, fences and superseded generations, moves, maintenance. It already checks all of them on every wake (`try_wake`).

---

## 2. The options and their message flows

Notation: **E** Edge, **DA** DatabaseActor, **GW** gateway, **AG** node agent, **NA** NodeActor, **D1**. *g* is D1's generation and *op_g* its operation; *p* is the generation on the node's page. A wake ticket *T* = (generation, operation, route revision, role hash).

### 2.1 Pieces Option A needs

1. **A deterministic wake operation.** Today the ticket's operation is random, so nothing outside the actor can produce the ticket the actor will answer. Proposed: `wakeOperation(db, g + 1, op_g)` = `op_` + the first 20 hex characters of SHA-256(`"pgcf-wake\n" + db + "\n" + (g + 1) + "\n" + op_g`). There is a precedent: `fenceOperation` in `apps/api/src/domain/node-desired.ts` is built the same way. Because *op_g* is random, the result cannot be guessed from outside. Because (*db*, *g + 1*) is unique, it is unique too.
2. **A speculative route, v7:** {`v: 7`, `db`, `user`, `cid`, `rg`, `kid`, `iat`, `exp`, `node`}, signed with the node's derived key under its own signature domain. It names no generation and no operation: the node supplies them.
3. **A binding header on the gateway's 101**, `X-PGCF-Bound`. It carries what the gateway bound the connection to: a wake ticket {v5 form: `gen`, `op`, `route_revision`, `rh`} or a running unit {v6 form: `rev`, `route_revision`, `inst`}.
4. **A placement hint at the Edge:** database → region, node, gateway URL. It changes only at placement and moves. Either the Edge fills it in isolate memory from every answer the actor gives (free, but likely empty for a database idle for hours), or the API writes it to a KV namespace at every placement change (durable, a new resource, read latency not measured).
5. **The hand-over rule:** the Edge gives the client the speculative socket only if the actor's answer names the same node and is field-for-field equal to the binding. Anything else closes it, and the Edge dials as today with a new `cid`. The gateway's replay cache would refuse the same `cid` twice.

**Why the node binds the ticket, not the Edge.** The research sketch had the Edge sign the deterministic v5 itself. For that, the Edge would need the actor's whole snapshot (*g*, *op_g*, route revision, role hash, node, gateway). The generation moves at every wake and every sleep, so a snapshot the Edge saw while the database was awake is already wrong once it sleeps. The API would then have to write the snapshot to KV at every publish, and the cache would still be stale exactly after a recent sleep. In the node-bound form, the gateway builds *T* from its own table: the node's page, the source the node will act on anyway. The Edge needs only placement. The safety argument (section 3) is the same for both forms, because both depend only on the exact-match rule.

### 2.2 Option A, cold idle sleeper

| # | Step | Time from the Edge's start |
| --- | --- | --- |
| 1 | E starts the limiters and `DA.admitWake`, as today, and looks up the placement hint | 0 |
| 2 | The limiters allow, the hint hits, DA has not answered yet: E signs v7 (`cid₁`) and opens the WebSocket to the hinted node's gateway with the Access headers | L + c (limiters, lookup) |
| 3 | GW verifies v7 (signature with its node key, region, node, lifetime, replay of `cid₁`). Its table shows the database asleep at (*p*, *op_p*, rr, rh): GW builds *T* = (*p* + 1, `wakeOperation(db, p + 1, op_p)`, rr, rh) with the token's user and holds the connection through the existing wake queue, which delivers *T* to AG | + d (one way, about 35–55 ms, *estimate*: half the measured upgrade) |
| 4 | AG runs `try_wake(T)` with every existing check, plus a new one: the role is on the page and not expired. It starts the unit | node path N |
| 5 | GW answers 101 with `X-PGCF-Bound: T` and waits for the StartupMessage (the existing `serve_held` loop) | + d back |
| 6 | DA answers *T'* = (*g* + 1, `wakeOperation(db, g + 1, op_g)`, rr, rh) and starts its D1 claim after the answer, as today | cold: 112–633 ms |
| 7 | *T* = *T'* and the nodes are the same: E returns the 101 to the client with the speculative socket. Otherwise E closes it and dials v5 *T'* with `cid₂`, exactly as today | max(actor, step 5) |
| 8 | The client sends its StartupMessage and password. GW releases them when the table shows the unit at *T*. SCRAM, first statement | |
| 9 | The D1 claim commits (*g* + 1, op). The page catches up with AG's claim, and observations are accepted | after the answer |

**A1, the smaller form ("pre-wake only").** Step 2 becomes a `POST /wake` with the v7 token, which the gateway answers 202 at once. The client connection is always today's v5 dial with *T'*, and it finds the unit starting or running at the same ticket. There is no speculative socket, no binding header and no hand-over rule; the deterministic operation and the node checks stay. It gains less (section 6), and it is the only form usable for HTTP `/sql`, whose request body is client data.

### 2.3 Option B, cold idle sleeper

| # | Step |
| --- | --- |
| 1 | E starts the limiters and `DA.admitWake`, as today |
| 2 | DA, at the moment it stores a new pending ticket *T'*, calls `NA(node).prewake(T')` without awaiting it (`waitUntil`), then answers E |
| 3 | NA sends {`type: "wake"`, ticket} on the agent's link (a hibernatable WebSocket) |
| 4 | AG runs `wake(T')`, the same function the gateway's delivery runs, and publishes its table entry when the unit is up |
| 5 | E signs v5 *T'* and dials, as today. GW finds the table released (`WakeState::Released`) or holds and delivers *T'*. AG answers that delivery with `wake_in_progress` or releases a running unit at the ticket (`release_running`). The table change releases the held connection |

The ticket is the actor's. Only its route to the node changes: actor → NodeActor → link instead of actor → Edge → Tunnel → gateway. The actor's cold start before `admitWake` stays in series.

### 2.4 The cases

Each case lists today, A (node-bound) and B. "Close" means the Edge closes the speculative socket, which never carried a client byte.

**a. Cold idle sleeper.** Sections 2.2 and 2.3.

**b. Awake database.**
- Today: DA answers the target (*g*, rr, inst). E signs v6 and dials. GW admits it on its table and dials PostgreSQL early, sending no byte before the StartupMessage is checked.
- A: GW's table shows the unit running at (*p*, rr, inst). GW admits v7 as the v6 route of that unit and dials early as for a v6. The 101 carries {`rev`: *p*, rr, inst}. DA answers the same target: hand-over. The gateway round trip is hidden behind the cold actor.
- B: no wake, nothing to push.

**c. Manually suspended or deleted database.**
- Today: DA refuses (`57P03`, or `3D000` answered by the decoy).
- A, suspended: a manual suspend needs a ready database, and the node itself sleeps it under the suspend order, so its page already says suspended. AG refuses `suspended`, GW ends the speculative connection with `57P03`, DA refuses, and E closes. Nothing starts.
- A, deleted, page current: the gateway's table entry is gone or retired, GW refuses (503 `target_unavailable`) and nothing starts.
- A, deleted, page not pulled yet: AG starts the database with no claim. DA answers `3D000` and E answers with the decoy. The page then arrives, and the delete stops the unit and removes the volume. The start had no client.
- B: DA refuses, so nothing is pushed.

**d. Role removed or password rotated.** Either change advances D1 to *g* + 1 and changes the role hash.
- Today: DA refuses a removed role (`28P01`, decoy). For a rotated password, the ticket carries the new hash; a node whose page is older refuses `desired_stale` and the client retries.
- A, page current: a removed role is refused by the new role check on the node and nothing starts. A rotated password: *T* = *T'* (both carry the new hash), hand-over, and PostgreSQL has the new verifier, because AG writes the page's roles before release (`refresh_roles`).
- A, page stale: a removed role is still on the old page, so AG starts the database with no claim. DA refuses and E closes. A rotated password: *T* = (*p* + 1, …, old hash), while *T'* = (*p* + 2, …, new hash). They differ, so E closes and dials *T'*, and AG refuses `desired_stale` until its page arrives. Then the page's generation wins over the unclaimed one, and the roles are written into the running database. **No client ever logs in against the old verifier,** because the hand-over requires the same role hash.
- B: as today.

**e. Fenced or lost node.**
- Today: a node declared lost is fenced first: Tunnel deleted, Tunnel token revoked, key restricted, power off (plan 7.11, 9.4). DA's snapshot no longer offers it (`lost_at`).
- A: a placement hint that names a fenced node cannot reach it, because the Tunnel is gone and the fetch fails at Cloudflare. E falls back at once. A fenced agent that comes back refuses every wake with `fenced` once it has read the order. A node that is only silent is not declared lost from staleness (plan 7.11); it stays the database's node in D1 and behaves as today.
- B: DA's snapshot names the node, a lost node is not wakeable, and a push to a link that is down is lost harmlessly.

**f. Stale snapshot.** Three kinds:
1. *Edge placement hint stale* (moved or deleted): the hinted node has no entry, or a retired or superseded one, and refuses. E falls back.
2. *Node page behind D1* (the hint was lost, or a pull is in flight): *T* ≠ *T'*, so E closes and dials *T'* (today's path, `desired_stale` until the page arrives). The start was speculative and unclaimed. The next page wins: a newer generation, or the same generation with another operation, is applied.
3. *Actor snapshot behind D1* (a publish is pending): DA refuses behind its barrier, or answers a ticket whose D1 claim is then refused and refuted. A changes nothing here: the hand-over happens only on DA's own ticket, exactly as today, where the node also releases a wake before the claim commits (`observationVerdict`, `pendingTicket`).
- B: as today in all three.

**g. Two concurrent connects.**
- Today: DA stores one ticket and answers both with it, and GW coalesces them on one ticket and one start.
- A: both speculative connections (same or different isolates) get the same *T*, because the operation is deterministic. The wake queue coalesces on (generation, operation). DA answers both with the same *T'* (the second reuses the stored ticket). Both are handed over and released by one table change. A connect without a hint takes today's path with *T'* and coalesces as well. **This is why the operation must be deterministic:** with today's random operation, *T* and *T'* differ at the same generation, the later replaces the earlier in the wake queue, and the replaced connections end as `route_stale`.
- B: DA pushes once, when it first stores the ticket, not on reuse.

**h. Edge isolate dies between dial and claim.**
- Today: once `admitWake` has reached DA, the claim runs in DA's own `waitUntil` and does not depend on the Edge.
- A, the isolate dies after the speculative dial but before `admitWake` reached DA (both leave in the same turn, so this needs an isolate killed in that window or a lost RPC): GW sees the socket close (`client_closed`), the delivered wake goes on, and the database runs at (*p* + 1, `wakeOperation`) with no claim. Its reports are `conflict` (no pending ticket) and are recorded, never applied. It ends in one of two ways. The next connect's ticket is the same *T* and is released at once (AG: claimed, running), and its D1 claim commits. Or nobody comes, and the node sleeps it at its idle time with the full proof at *p* + 1: the recovery point is recorded (`recordRecoveryPoints` accepts a generation at or above D1's), and the next ticket (*p* + 1) finds its own claim.
- A, the isolate dies after DA received the call: as today, plus a database that is awake with no client until its idle sleep.
- B: the push and the claim come from the same DA call, so the node and D1 agree.

---

## 3. Safety argument

### 3.1 The reduction

**Lemma.** Under the hand-over rule, every client session that Option A creates runs on a connection whose binding equals, field for field, the answer DA gave for that connect: node, generation, operation, route revision and role hash for a wake; generation, route revision and instance for a running unit. Today's path would have made a connection with the same binding to the same node.

So, for client traffic, A differs from today in timing only. Everything it adds is a **speculative start**: an ordinary wake, through the same `try_wake`, of a ticket the node built from its own page, which DA may not issue. The invariants therefore reduce to: is a start without DA's consent safe? And what does it cost?

### 3.2 Per invariant

| Invariant (plan 3.3, 7.9–7.11) | Option A | Option B |
| --- | --- | --- |
| 1. Never lose an acknowledged commit | No client commit before the hand-over. An unclaimed start writes only the server's own WAL (checkpoints, autovacuum), which is archived as usual; it ends in the normal sleep proof at the claim's generation (`sleep_locked` uses the claim). Nothing in commit, archive or proof changes | Unchanged |
| 2. Never replay an uncertain write | The speculative socket carries no client byte before the hand-over, and a closed one carried none. After the hand-over the client's bytes travel once, on one socket, as today | Unchanged |
| 3. One writer per database | On a node: the unit name, `postmaster.pid` and the agent's serialized flow are unchanged, and the speculative start uses the same flow. Across nodes: it happens only on a node whose page holds the database at a generation that is neither superseded, moving nor fenced. A move cannot pass its first step without the source's own proof, and the source then holds its wakes (`moving`) until the move ends, so no page lags a move. A placement hint naming another node meets a refusal there. D1 stays the generation authority: an unclaimed generation is never applied (`conflict`), and the deterministic operation makes the later claim name exactly what runs | Unchanged: the ticket is DA's |
| Fencing | A fenced node has no Tunnel, so no dial reaches it, and its agent refuses `fenced`. Fencing precedes every move of a generation (plan 9.4) | Unchanged |
| Unproven databases | `try_wake` refuses `unproven` and checks `pg_control` against the proven-sleep record. A speculative start passes the same checks | Unchanged |
| 7. Only explicit orders stop a database | No new stop. An unclaimed database stops only by idle sleep, which is the node's existing decision, or by a page order | Unchanged |
| 8. A refused sleep leaves it wakeable | No change | No change |

### 3.3 Authentication

The requirement: the Edge must not let a connection reach a node for a database or role the actor would have refused.

- **What the node verifies on its own** for a v7: the signature with its derived node key (only the Edge holds the master keys, and keys are per node, so a token for another node fails); region, node and lifetime (≤ 30 s); a single-use `cid`. Before the Tunnel, Access checks the Edge's service token. From its page, the agent checks that the database is there, desired running, not moving, not in maintenance, not fenced or superseded, and, new, that the role is on the page and not expired. It also checks the volume and `pg_control`, and the bounds of 32 held connections per database and 512 in total.
- **What the ticket proves:** that the Edge asked, within these 30 s, for this database and role on this node, after its limiters allowed it. It proves neither DA's consent, nor the client's password, nor anything D1 decided after the node's page.
- **What is checked after DA answers:** exact equality of DA's answer with the gateway's binding (section 2.1, item 5). Only then does the client get the socket. Then, as today: the gateway checks the StartupMessage's database and user against the token (`28000`), and PostgreSQL checks the password with SCRAM against the verifiers of the role hash that both sides agreed on.
- **Client data before DA's answer: none.** The client has no socket before the Edge returns the 101. The v7 token carries only what today's token carries: the database ID and role name hints, both syntax-checked, plus a `cid`. HTTP `/sql` can use only A1, because its body is client data.

**What A gives up, stated plainly.** No *session* reaches a node for a database or role that DA refuses. But a *request* does, and it can start PostgreSQL:
- for a database whose delete, role removal or barrier the node has not pulled yet;
- without DA's per-database counter (the Edge limiters and the gateway bounds still apply).

If the owner reads the requirement as "no request at all before the actor agrees", Option A is ruled out by its design, and only B or keep-warm remain. Two facts put this in proportion:
- **Today, anyone who knows a database ID and a role name can already wake that database.** The wake begins before the password is checked. A does not widen who can wake a database. It only lets the node decide, for connects that come while a page change is still in flight.
- **The decoy's timing.** Today an unknown database answers without a gateway round trip, and a known one with it. A narrows that difference; it does not widen it.

**The cost of speculative starts DA would refuse.** Awake seconds that the metering reports truthfully but that no client used, and RAM taken from real wakes. Under D2, an unclaimed awake database with no client activity for 30 s is a candidate for early sleep.

### 3.4 Option B

The ticket is DA's, created at the same moment and under the same barrier as today's answer. B adds a second delivery of the same ticket. The agent already makes delivery idempotent (`wake_in_progress`, `release_running`), and the gateway releases held connections from the table, not from the agent's answer. No invariant changes.

---

## 4. What changes

### 4.1 Option A (node-bound)

**Contracts**
- `packages/contracts/src/route-token.ts`: route v7 (claims, signature domain `pgcf-route/v7\n`, sign and verify), with the binding header's name and schema.
- `packages/contracts/src/database-admission.ts`: `wakeOperation(db, generation, previousOperation)`.
- `apps/api/src/domain/admission-state.ts`: the snapshot gains `operation`, the operation of its generation.
- `packages/contracts/src/node-local.ts`:
  - the gateway's table record gains `role_hash`;
  - the wake request gains `role` and `speculative`;
  - a new wake reason, `role_refused`.
- Rust twins:
  - `packages/native-protocol/src/route.rs`, `wake.rs` (`WakeRequest`, `REASONS`), `agent.rs` (`Database`);
  - `constants.generated.rs`, regenerated;
  - conformance vectors in `tests/conformance.rs` for v7, the binding header and `wakeOperation`.

**Edge** (`apps/edge/src`; `apps/edge-rust` follows if D12 keeps it)
- `admission.ts`:
  - a bounded isolate cache of placement, filled from every positive answer (or a KV read, section 8);
  - after the limiters allow and on a hit, sign v7 and dial in parallel with DA;
  - the exact-match rule;
  - close on a mismatch, a refusal or an abort;
  - fall back with a new `cid`;
  - hand over only if DA answered within a bound of the speculative 101 (section 5, row 9).
- `gateway.ts`: return the 101's binding header with the socket.
- `index.ts`: log `speculative` (`none`, `miss`, `matched`, `mismatch`, `refused`, `failed`, `late`), `speculative_connect_ms`, and the two bindings' generation and operation on a mismatch. No token and no secret is logged.
- `sql.ts`: at most the A1 pre-wake.

**DatabaseActor** (`apps/api/src/database-actor.ts`): the ticket's operation becomes `wakeOperation(db, g + 1, snapshot.operation)` instead of `newOperationId()`. Nothing else changes: the actor remains the only authority for the hand-over, and its claim, refutation and barrier stay as they are.

**API**
- `apps/api/src/domain/database-admission-snapshot.ts`: publish the operation of the generation.
- With KV (section 8), the API writes `placement:<db>` (region, node, gateway URL) at create, move, delete and gateway changes. That is a new binding, in the private configuration too.
- Optional, and only if the logs show unclaimed starts piling up: `observationVerdict` accepts (*g* + 1, `wakeOperation(db, g + 1, op_g)`) for an idle sleeper by committing the wake claim itself.

**Gateway** (`apps/native-gateway/src`)
- `transport.rs`, `serve_socket`: accept v7.
  - Running: admit it as the v6 route of the table's unit.
  - Sleeping: build `WakeClaims` from the table record and go through `serve_held`.
  - Retired or absent: 503.
  - Answer the upgrade with the binding header, through a handshake callback instead of `accept_async_with_config`.
- `hold.rs`: unchanged. With a deterministic operation, coalescing by generation and operation already does the right thing.
- `local.rs`: carry `role_hash`.

**Agent** (`apps/node-agent/src`)
- `agent/mod.rs`, `table_entry`: publish the entry's role hash.
- `agent/power.rs`, `try_wake`: when the request names a role, refuse `role_refused` unless the page holds it unexpired. The wake event carries `speculative`.
- Sleep, proof, recovery and fencing do not change.

### 4.2 Option B

- `packages/contracts/src/node-link.ts`: a server link message {`type: "wake"`, ticket}, with its Rust twin in `apps/node-agent/src/link`.
- `apps/api/src/node-actor.ts`: `prewake(ticket)` sends it on the agent's socket.
- `apps/api/src/database-actor.ts`: when a new ticket is stored, call `NA(current.node).prewake` in `waitUntil`. It needs no D1 read, because the snapshot names the node.
- `apps/node-agent/src/link/socket.rs` and `agent/power.rs`: run `wake` for a link-delivered ticket and log it with its source.

---

## 5. Failure modes (Option A)

| # | Failure | Effect | Detected by | Logged as |
| --- | --- | --- | --- | --- |
| 1 | Placement hint stale (moved, deleted) | Speculative connection refused, none started | GW 503 or agent `desired_stale` / `superseded` | Edge `speculative: "refused"` with the status; the hint is dropped |
| 2 | Node page behind DA | Mismatch; today's dial follows, so no loss on the critical path | Edge comparison | `speculative: "mismatch"` with both generations and operations |
| 3 | DA refuses | Closed; refusal or decoy | DA answer | `speculative: "refused_by_actor"` plus DA's `admission_refused` |
| 4 | Unclaimed start (case h, or a mismatch after a start) | Awake with no claim until the next connect or idle sleep | API verdict `conflict` at *g* + 1 with the derived operation | API event for an unclaimed wake; agent `wake` event with `speculative: true`; true `awake_seconds` |
| 5 | Speculative 101 later than DA (warm actor) | E waits for it, since it is never behind a fresh dial; on a node mismatch E closes at once | Timing | `speculative: "late"`, `speculative_connect_ms` |
| 6 | Dial fails (Tunnel down, Access 401/403, Cloudflare error) | Fallback at once | Fetch status | `speculative: "failed"` with the status |
| 7 | Node refuses the wake after the 101 (`no_headroom`, `unproven`, `moving`, `role_refused`) | With equal tickets, DA's own ticket would be refused alike: the client gets today's 57P03 with the same detail and hint | Agent `wake` event | Reason in the event; Edge `matched` |
| 8 | Fallback reuses `cid₁` | Gateway replay cache answers 403 | Gateway | Prevented by design: a new `cid₂`, both logged |
| 9 | DA answers after the held connection hit its 25 s bound | The handed-over socket would only say "did not wake in time" | Edge clock | E hands over only within a bound of the speculative 101, else falls back: `speculative: "expired"` |
| 10 | `wakeOperation` differs between TypeScript and Rust | Every speculative wake mismatches (safe, no gain) | Mismatch rate | Conformance vectors in CI; mismatch counter in the Edge log |
| 11 | Speculative flood (wrong passwords, one database) | Starts bounded by the Edge limiters, the gateway's 32 / 512 holds and admission | Node rollups | Existing queue-wait and refusal counts |
| 12 | Binding header missing or malformed | Treated as a mismatch | Edge parse | `speculative: "mismatch"` |
| 13 | Isolate dies | Case h | GW `client_closed` | Gateway `conn_stages`, then row 4 |

Option B: a cold NodeActor or a link that is down makes the push late or lost, which is harmless (logged as the push's outcome and delay). A duplicate delivery is answered `wake_in_progress`.

---

## 6. Expected gain

Symbols: actor time *a* (112–633 ms cold, 18–37 warm); node path *N* (about 100–250 ms after `wake-node-path`, up to 362 / 539 ms with a cold page cache); one-way Edge–gateway *d* (35–55 ms); client–Edge one-way *e* (a few ms on a service binding, tens from a laptop, not measured); limiters *L* and lookup *c* (not measured). Today, the first byte reaches PostgreSQL after *a* + *d* + *N* when *N* exceeds the client's round trip (*estimate*).

| Case | A (speculative socket) | A1 (pre-wake only) | B |
| --- | --- | --- | --- |
| Cold idle sleeper, cold actor | ≈ min(*a* − *L* − *c*, *N* − 2*e*): **about 40–250 ms**, capped by the node path | ≈ min(*a* − *L* − *c*, *N* − 2*d* − 2*e*): **about 0–180 ms** | ≈ 26 ms + signing + *d* − (DA→NA RPC + NA→agent): **about 0–50 ms**, nothing if NA is cold |
| Awake database, cold actor | ≈ min(*a* − *L* − *c*, 2*d*): **about 70–110 ms** | 0 | 0 |
| Warm actor | ≈ *a* − *L* − *c*: at most 15–30 ms | ≈ 0 | ≈ 0 |

*All estimates*, from the measured parts in 1.2.

Limits:
- **Capped by the node path.** The faster the node gets, the less A buys. `wake-node-path` already removed about 130 ms of agent admission.
- **Only with a placement hit.** The go-live gate is a p95, so A moves it only if at least 95 % of cold connects take the fast path. An isolate cache will rarely know a database idle for hours. A KV record would, but its cold read *c* is not measured, and *c* ≥ *a* means no gain.
- **Only with a cold actor.** With a warm actor everything above is at most 15–30 ms.
- **Not the largest Cloudflare lever measured.** Stage 5.3 found the public hostname about 300 ms slower than a service binding for a Worker client; that choice belongs to the integrator.

---

## 7. Tests that must exist first

1. **A model test of the state machine** (TypeScript, one file, for example `packages/contracts/src/parallel-wake.model.test.ts`; one property test, not a matrix).
   - **State:**
     - D1's row: generation, operation, desired state, power;
     - DA: snapshot, barrier, stored ticket;
     - the Edge's placement hint;
     - the node: page, phase, claim, fences, `moving`;
     - the gateway: table and held connections;
     - the messages in flight.
   - **Events:** connect, `admitWake` answer, speculative dial, claim commit or loss, publish, page pull, hint loss, the steps of delete, suspend, role change and move, fence, Edge death, actor eviction, node refusal.
   - **Exploration:** bounded exhaustive search of interleavings for one database and two nodes, plus seeded random walks.
   - **The model calls the real pure decisions:** `observationVerdict`, `wakeOperation`, the Edge's match rule, and the agent's check order mirrored from `try_wake`. That order is pinned by shared vectors that the Rust tests also run.
   - **Properties after every step:**
     - P1: a client byte reaches a unit only on a connection whose binding equals DA's answer for it;
     - P2: no session for a connect that DA refused (barrier, deleted, unknown or expired role, suspended);
     - P3: no two nodes run the database with a client session; no node runs a fenced or superseded generation;
     - P4: no wake starts an unproven database;
     - P5: every client write reaches PostgreSQL at most once;
     - P6: a database D1 counts as cold has a proven-sleep record that matches its last stop;
     - P7 (liveness, fair schedule): every unclaimed start ends claimed or proven asleep, and every connect is answered before its deadline.
   - **Failing first:** the same model run with today's random operation must fail at case g, and with the match rule removed must fail P1 and P2. That shows the test can see what it guards.
2. **Unit and conformance tests, red first:**
   - v7 sign and verify vectors, and `wakeOperation` vectors, in TypeScript and Rust;
   - the gateway: v7 on a running database binds the table's unit; v7 on a sleeper holds with the derived ticket and sends the header; a role not on the page is refused; replay;
   - the Edge: hand-over only on full equality, field by field; a mismatch closes and redials with a new `cid`; a DA refusal closes and answers the refusal or decoy; the dial waits for the limiters; the 25 s bound;
   - the agent: `role_refused` for an absent or expired role; a speculative ticket equal to DA's is claimed by DA's ticket without a second start.
3. **Live acceptance on EU1** (plan 3.1 rules): at least 30 cold first requests per arm, databases idle for at least one hour, speculation on and off interleaved. Report the Edge's `speculative` outcomes and the count of unclaimed starts.

---

## 8. Recommendation and the owner's decision

### 8.1 Cheaper alternatives

| Alternative | Removes | Numbers | Cost and risk |
| --- | --- | --- | --- |
| Lighter actor Worker (merged, `c46d838c`) | Part of the module load | −25 / −28 ms at the median; p95 369 → 324 and 351 → 301 ms (*measured (Dev)*) | Done |
| Separate actor script (the split) | The rest of the script | A further −10 to −20 ms; the 105 / 230 ms floor stays (*measured (Dev)*) | `migrations` become `exports` for good; four ordered deploys, no gradual rollout, a production write |
| **Keep the actor warm** with an alarm, for every live database or those with a connect in the last N days (the metric needs days, since its databases are idle at least one hour) | The whole cold start, for awake and asleep databases alike | Admission 18–37 ms instead of 112–633 ms on each connect it covers (*measured (EU1)*) | Alarm invocations are billed as Durable Object requests: USD 0.15 per million on the Workers Paid plan (Cloudflare's pricing page, 2026-10-19). Per 1,000 databases per month, before the included million: every 60 s, 43.2 million alarms, about USD 6.5; every 30 s, about USD 13; every 10 s, about USD 39 (*estimate*). Duration is not estimated. Whether it works is not measured: Cloudflare hibernates an object that meets its conditions (no timer, no pending I/O) after 10 s of inactivity and discards its in-memory state (its constructor runs again), and it does not document whether the module stays evaluated, which is the measured cost |
| Option B | The way back and the Edge–gateway leg | About 0–50 ms (*estimate*) | A second wake path; NodeActor (sampled every 15 s, hibernatable) may be cold itself |
| Option A | The shorter of actor and node path | About 40–250 ms, only on a placement hit (*estimate*) | Protocol change, a new node behaviour, a KV namespace for the hit rate |

### 8.2 What I would do

1. **Measure before building anything,** with scratch Workers on the Dev account, deleted afterwards, as the cold-actor measurement did:
   - keep-warm with at least 100 objects: alarms every 10, 30 and 60 s; `admitWake` latency after one hour and after 24 hours without a connect; the share of answers that stay warm; and the bill;
   - for A's fallback case: the latency of a cold KV read from the Edge for a key unread for one hour and for 24 hours.
   These two numbers decide between the options. Nothing else does.
2. **If keep-warm keeps at least 95 % of first connects warm at a price the owner accepts, build it:** an alarm in `DatabaseActor`, re-armed while the database exists, is not deleted and is in the scope the owner sets. It changes no protocol, no invariant and no node behaviour, it helps every connect, and it brings Cloudflare's own share of the connect towards the 150 ms target.
3. **Do not build Option B.** It leaves the actor's cold start in series, and its gain depends on NodeActor being warm: the same problem one hop further.
4. **Build Option A only if keep-warm fails or is refused,** in the node-bound form with a KV placement record, only after the model test of section 7 passes and its mutants fail, and only if the measured KV read p95 is clearly below the cold actor's. Start with the exact-match rule in place from the first commit; never ship a form that hands a socket over without it.

### 8.3 The decision the owner has to take (proposed D13)

| # | Decision | Proposed default |
| --- | --- | --- |
| D13a | Approve the Dev measurement of keep-warm and of KV cold reads (scratch Workers, deleted afterwards) | Yes |
| D13b | On its result: a costed go for keeping actors warm, and its scope (every live database, or only those with a connect in the last N days) | Every live database, if 8.2 step 2 holds |
| D13c | Only if keep-warm is out: accept **speculative starts**. A node may start a sleeping database on an Edge request that the DatabaseActor has not yet authorized, under every node check, with no client byte before the actor's exact match. This amends plan 1.6 and 5.2, adds a KV namespace (a new resource, costed go), and accepts unclaimed starts as a logged, self-healing state | No, unless keep-warm fails |

If neither keep-warm nor speculative starts is accepted, the cold actor stays on the path, at the floor of a cold Durable Object (105 / 230 ms at p50 / p95) once the split is done. The rest of the connect budget then has to come from the client's path to the Edge and from the node.

---

## Sources

- Code on main `c46d838c`:
  - `apps/edge/src/index.ts`, `admission.ts`, `gateway.ts`, `decoy.ts`;
  - `apps/api/src/database-actor.ts`, `node-actor.ts`, `domain/database-admission-snapshot.ts`, `domain/node-desired.ts`, `domain/node-observations.ts`, `domain/roles.ts`;
  - `packages/contracts/src/route-token.ts`, `database-admission.ts`, `node-link.ts`;
  - `packages/native-protocol/src/wake.rs`, `agent.rs`;
  - `apps/native-gateway/src/transport.rs`, `hold.rs`, `local.rs`;
  - `apps/node-agent/src/agent/power.rs`, `mod.rs`, `link/socket.rs`.
- [ULTRA plan](cloudflare-convergence-and-serverless-plan.md): sections 3.1, 3.3, 4.6, 5.3, 5.7–5.9, 7.9–7.11, 8, 9.4, 9.5, 11.1 (rows "Stage 5.3 cold first request" and "Cold DatabaseActor measured"), 11.5.
- Cloudflare, Durable Objects [pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) and [lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/), read 2026-10-19.
