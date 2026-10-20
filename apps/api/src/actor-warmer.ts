// SPDX-License-Identifier: Apache-2.0
import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env.ts";
import type { WarmCache } from "./domain/actor-warm.ts";

/** What one warmer does: shard `shard` of `shards`, one cycle every `interval_ms`, while the lease lasts. */
export interface ActorWarmerShape {
  shard: number;
  shards: number;
  interval_ms: number;
}
interface ActorWarmerConfig extends ActorWarmerShape {
  lease_until: number;
}

/**
 * Keeps the DatabaseActors of one shard of the databases warm. A DatabaseActor whose isolate is
 * idle for more than a few seconds is evicted, and the next admission then pays 200 to 600 ms to
 * load it again; a call every ten seconds or faster prevents that (ULTRA plan 11.1, "Keep-warm
 * for the DatabaseActor"). Each alarm of this object visits the actors of its shard with a no-op
 * call (`DatabaseActor.warm`) and sets the next alarm first, so that a failing or slow cycle
 * cannot end the loop. The loop belongs to the minute cron's lease: `arm` renews it, and a warmer
 * the cron no longer arms (the interval is 0, or the shards became fewer) stops itself.
 *
 * Like every Durable Object class, this one is evaluated by each cold object of the Worker, so it
 * imports no more than a Durable Object needs; the cycle loads with the first alarm.
 */
export class ActorWarmer extends DurableObject<Env> {
  private config: ActorWarmerConfig | undefined;
  private readonly cache: WarmCache = {};

  /**
   * Idempotent: stores the shape with a lease of `leaseMs` from now, and starts the alarm loop
   * when no alarm is pending (the first cycle runs one interval from now).
   */
  async arm(shape: ActorWarmerShape, leaseMs: number): Promise<void> {
    const config = { ...shape, lease_until: Date.now() + leaseMs };
    this.config = config;
    await this.ctx.storage.put("config", config);
    if ((await this.ctx.storage.getAlarm()) === null)
      await this.ctx.storage.setAlarm(Date.now() + config.interval_ms);
  }

  override async alarm(): Promise<void> {
    const started = Date.now();
    const config = (this.config ??=
      await this.ctx.storage.get<ActorWarmerConfig>("config"));
    if (!config || started >= config.lease_until) {
      this.config = undefined;
      await this.ctx.storage.delete("config");
      console.log(
        JSON.stringify({
          event: "actor_warm_stopped",
          shard: config?.shard ?? null,
        }),
      );
      return;
    }
    // Scheduled first: whatever the cycle does, the loop goes on.
    await this.ctx.storage.setAlarm(started + config.interval_ms);
    try {
      const { warmCycle } = await import("./domain/actor-warm.ts");
      await warmCycle(this.env, config, this.cache, started);
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "actor_warm_failed",
          shard: config.shard,
          error_class: error instanceof Error ? error.name : "unknown",
        }),
      );
    }
  }
}
