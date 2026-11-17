# Authorized browser change notifications implementation plan

**Goal** — A viewer of one bounded board receives a refresh signal after a committed change to their visible view. Changes confined to someone else's view produce no browser message.

**Architecture** — PGCF delivers its existing signed, at-least-once data webhooks. An adopter-owned receiver uses each event to mark a fixed application view dirty. An authenticated browser stream receives only a refresh signal after the adopter checks current viewing rights and confirms the visible result changed.

**Stack and specification** — PGCF outbox, TriggerActor, signed webhooks, the adopter's session verifier and RLS data access, same-origin server-sent events (SSE). See the [shared design](2026-11-17-postgres-application-features.md) and [PGCF event contract](database-events-and-schedules.md). For execution, use Superpowers executing-plans or subagent-driven-development.

## 1. Establish the first application and event path

**Files** — Existing PGCF [node intake](../../apps/api/src/domain/data-events.ts), [webhook signing](../../apps/api/src/domain/webhook-signing.ts), [delivery](../../apps/api/src/domain/webhook-delivery.ts) and [EU1 exercise](../../scripts/e2e/src/data-events.ts). An existing adopter watch implementation is `apps/neon-management/src/pgcf-database-watches.ts` in ohmyho.st. The browser handler and application authorization belong to the chosen adopter.

- [ ] Select one actual board with a stable sort, bounded visible projection and explicit board-membership checks. Define which tables can change that projection, including grants or ownership, and validate every dependency. If delivery, session invalidation or ingress streaming cannot support this board, stop the pilot at that boundary. For an ohmyho.st pilot, trace the previously reported missing watch delivery and verify the open foreign-tenant denial case.
- [ ] Demonstrate a committed update through an existing minimally scoped watch and a verified HTTPS receiver. Bind its secret to the expected project, physical database and current data assignment. Check the exact raw-body signature/timestamp and event subscription before accepting the hint. An authenticated `data.*` event can originate from tenant SQL, so its payload is never evidence of a real row change or a recipient's access.
- [ ] Use the existing intake/signing suites for any PGCF regression. Run `pnpm --filter @pgcf/api exec vitest run test/domain/node-data-events.test.ts test/domain/webhook-signing.test.ts` if those paths change. A missing upstream delivery is tracked as a delivery failure, independently of browser fan-out.

## 2. Ship one private, bounded browser stream in the adopter

**Proposed files in the selected application** — `src/live/board-stream.ts` for the two HTTP handlers and view comparison, and `src/live/board-stream.test.ts` for the first regression. Mount these under its existing authenticated routing and verified webhook entrypoints. If separate Worker instances serve the browser and receiver, use an adopter-owned per-board delivery coordinator reachable by both. Never depend on an isolate-local listener map across requests. Prove SSE delivery through the deployed ingress before offering the contract.

- [ ] Write the denial case first. Connect viewer A to board A, then commit a change visible only to B. A receives zero event frames attributable to that change. A committed change to A's own visible projection yields one or more coalesced `changed` signals. Establish a stable, authorized initial snapshot at subscription with a registration-before-read or dirty-during-read handoff so a commit between baseline and listening is reconciled. The client obtains its initial data after the subscription is ready.
- [ ] Implement a same-origin, authenticated subscription for a server-owned view. Resolve the database, board scope and allowed projection from trusted state. Reject foreign board access at subscription. On delivery, revalidate the current session, exact assignment and board access, then recompute the ordered projection under that viewer's fresh RLS claims. Compare its digest with that viewer's previous digest. Include only fields that the same authorized read exposes. Use a bounded view such as the first 50 visible orders ordered by updated time and primary key, applying RLS before the limit.

  ```text
  verify incoming event and mark the subscribed view dirty
  for each active viewer of that view:
      if session, data assignment or board grant has expired: close stream
      else read the current authorized projection and compare its digest
      if it changed: remember the digest and send "changed"
  ```

- [ ] The client refetches via the normal authorized route. A delete or visibility transfer can remove an item from the view, while loss of board membership closes the stream silently. Send no row data, hidden IDs, webhook metadata, sequence numbers, secret material or tenant-provided strings to clients. Expire the stream with its session and recheck rights on each delivery. If session or view authorization cannot be verified, close and require a new baseline.
- [ ] Bound subscribers and work at the coordinator. Start the pilot with a configurable cap of 16 open streams per board, one active projection check per viewer and one coalesced dirty flag during that check. Refuse excess subscriptions with HTTP 429 before registration. Process viewers with bounded concurrency compatible with the adopter's DB limits. Maintain no unbounded event history. Duplicate, reordered or retried callbacks converge on the current view. Never treat a higher sequence as proof that lower events cannot arrive. On disconnect, coordinator restart, generation or assignment change, establish current authorization and a fresh baseline. Snapshot failure closes the affected stream.
- [ ] No subscribers means no view queries. Heartbeats maintain only the browser transport. They must not open or retain PostgreSQL connections, prevent idle sleep, or wake an explicitly suspended database. Record accepted, denied and coalesced counts without user values. Run the adopter's focused board-stream test and its existing RLS integration case.

## 3. Accept and roll back the pilot

- [ ] With costed approval, use a disposable EU1 board through the public application path. Observe two differently authorized viewers and an unrelated tenant. Check a visible edit, a hidden edit, delete, rollback, duplicate delivery, a manually emitted hint with no change, grant revocation on an open connection and reconnect across a storage generation change. Verify authorized browser state converges and the unrelated viewer receives zero change signals. With a quiet board and an open browser, verify ordinary database sleep and absence of heartbeat-driven wakes.
- [ ] Measure commit-to-refresh latency, active subscribers, authorized DB reads per committed edit and maximum observed queue depth. Record the pilot limits and measurements before general availability. For rollback, disable new streams, close existing ones, and remove only the pilot's subscription/watch after verifying ownership. The ordinary authorized HTTP read remains usable throughout.
