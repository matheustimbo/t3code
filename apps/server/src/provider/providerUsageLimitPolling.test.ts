import { expect, it } from "@effect/vitest";
import { ProviderInstanceId, type ServerProviderUsageLimits } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import { pollProviderUsageLimits } from "./providerUsageLimitPolling.ts";

it.effect("waits after a status probe and reads only when provider status work is allowed", () =>
  Effect.suspend(() => {
    let demand = false;
    return Effect.scoped(
      Effect.gen(function* () {
        let readCount = 0;
        const published: Array<ServerProviderUsageLimits> = [];
        const polled = yield* Deferred.make<void>();
        const policy = yield* BackgroundPolicy.BackgroundPolicy;
        const limits = { checkedAt: "2026-10-02T00:00:00Z", windows: [] };
        yield* pollProviderUsageLimits({
          instanceId: ProviderInstanceId.make("opencode-test"),
          pollImmediately: false,
          backgroundPolicy: policy,
          read: Effect.sync(() => {
            readCount += 1;
            return limits;
          }),
          publishUsageLimits: (value) =>
            Effect.sync(() => published.push(value)).pipe(
              Effect.andThen(Deferred.succeed(polled, undefined)),
              Effect.asVoid,
            ),
        }).pipe(Effect.forkScoped);
        yield* Effect.yieldNow;
        expect(readCount).toBe(0);
        yield* TestClock.adjust("45 seconds");
        expect(readCount).toBe(0);
        demand = true;
        yield* TestClock.adjust("45 seconds");
        yield* Deferred.await(polled);
        expect(readCount).toBe(1);
        expect(published).toEqual([limits]);
      }),
    ).pipe(
      Effect.provide(
        Layer.merge(
          TestClock.layer(),
          Layer.mock(BackgroundPolicy.BackgroundPolicy)({
            shouldRunScopeWork: () => Effect.sync(() => demand),
          }),
        ),
      ),
    );
  }),
);
