import type { ProviderInstanceId, ServerProviderUsageLimits } from "@t3tools/contracts";
import type * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import type * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import { makeUnavailableUsageLimits } from "./providerUsageLimits.ts";

export const USAGE_LIMITS_POLL_INTERVAL = "45 seconds" as const;

export class ProviderUsageLimitsReadError extends Schema.TaggedError<ProviderUsageLimitsReadError>()(
  "ProviderUsageLimitsReadError",
  {
    message: Schema.String,
  },
) {}

export const pollProviderUsageLimits = Effect.fn("pollProviderUsageLimits")(function* (input: {
  readonly instanceId: ProviderInstanceId;
  readonly publishUsageLimits: (limits: ServerProviderUsageLimits) => Effect.Effect<void>;
  readonly pollImmediately?: boolean;
  readonly read: Effect.Effect<ServerProviderUsageLimits, ProviderUsageLimitsReadError>;
  readonly backgroundPolicy: Context.Service.Shape<typeof BackgroundPolicy.BackgroundPolicy>;
}) {
  if (input.pollImmediately === false) yield* Effect.sleep(USAGE_LIMITS_POLL_INTERVAL);
  return yield* Effect.forever(
    Effect.gen(function* () {
      const [genericDemand, instanceDemand] = yield* Effect.all([
        input.backgroundPolicy.shouldRunScopeWork({ type: "provider-status" }),
        input.backgroundPolicy.shouldRunScopeWork({
          type: "provider-status",
          instanceId: input.instanceId,
        }),
      ]);
      if (genericDemand || instanceDemand) {
        const result = yield* input.read.pipe(Effect.result);
        const checkedAt = DateTime.formatIso(yield* DateTime.now);
        const probed = Result.isSuccess(result)
          ? result.success
          : makeUnavailableUsageLimits({
              checkedAt,
              reason: "probeFailed",
              message: result.failure.message,
            });
        yield* input.publishUsageLimits(probed);
      }
      yield* Effect.sleep(USAGE_LIMITS_POLL_INTERVAL);
    }),
  );
});
