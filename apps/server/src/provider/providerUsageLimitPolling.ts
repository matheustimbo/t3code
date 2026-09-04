/**
 * Polling scaffolding for providers whose usage limits only come from an HTTP
 * read, with no runtime notification to fold in.
 *
 * Claude and Codex push `account.rate-limits.updated` during a turn, so
 * `ProviderUsageLimitsIngestion` keeps them current for free. Cursor, Grok and
 * OpenCode have no such channel: the only way to know is to ask, so each
 * driver runs one of these loops beside its status probe.
 *
 * @module provider/providerUsageLimitPolling
 */
import type {
  ProviderInstanceId,
  ServerProvider,
  ServerProviderUsageLimits,
} from "@t3tools/contracts";
import type * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import type * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import { makeUnavailableUsageLimits, resolveUsageLimitsAfterProbe } from "./providerUsageLimits.ts";

export const USAGE_LIMITS_POLL_INTERVAL = "45 seconds" as const;

export class ProviderUsageLimitsReadError extends Schema.TaggedErrorClass<ProviderUsageLimitsReadError>()(
  "ProviderUsageLimitsReadError",
  {
    message: Schema.String,
  },
) {}

/**
 * Runs one lightweight limits reader per provider instance. BackgroundPolicy
 * keeps it dormant when no client needs provider status, so an idle app is not
 * hitting a billing endpoint every 45 seconds.
 *
 * A read that fails keeps the bars the last good read established:
 * `resolveUsageLimitsAfterProbe` treats `probeFailed` as "no new information",
 * which is the same rule the Claude and Codex status probes follow.
 */
export const pollProviderUsageLimits = Effect.fn("pollProviderUsageLimits")(function* (input: {
  readonly instanceId: ProviderInstanceId;
  readonly getSnapshot: Effect.Effect<ServerProvider>;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  readonly read: Effect.Effect<ServerProviderUsageLimits, ProviderUsageLimitsReadError>;
  readonly backgroundPolicy: Context.Service.Shape<typeof BackgroundPolicy.BackgroundPolicy>;
}) {
  return yield* Effect.forever(
    Effect.gen(function* () {
      const [genericDemand, instanceDemand] = yield* Effect.all([
        input.backgroundPolicy.hasDemand({ type: "provider-status" }),
        input.backgroundPolicy.hasDemand({
          type: "provider-status",
          instanceId: input.instanceId,
        }),
      ]);
      if (genericDemand || instanceDemand) {
        const result = yield* input.read.pipe(Effect.result);
        const snapshot = yield* input.getSnapshot;
        const checkedAt = DateTime.formatIso(yield* DateTime.now);
        const probed = Result.isSuccess(result)
          ? result.success
          : makeUnavailableUsageLimits({
              checkedAt,
              reason: "probeFailed",
              message: result.failure.message,
            });
        const usageLimits = resolveUsageLimitsAfterProbe({
          published: snapshot.usageLimits,
          probed,
        });
        yield* input.publishSnapshot({
          ...snapshot,
          ...(usageLimits ? { usageLimits } : {}),
        });
      }
      yield* Effect.sleep(USAGE_LIMITS_POLL_INTERVAL);
    }),
  );
});
