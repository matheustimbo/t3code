import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { PublishingObserverClient, spawnPublishingObserver } from "./publishingObserverClient.ts";

const REFRESH_INTERVAL_MS = 5_000;
const SNAPSHOT_VALIDITY_MS = 10_000;

interface Refresh {
  readonly generation: number;
  readonly refreshStartedAt: number;
  readonly validUntil: number;
}

/** Only a derived public hint is retained; publisher and auth still read their authority. */
export class PublishingCapabilitySnapshot {
  private generation = 0;
  private activeMutations = 0;
  private dirty = true;
  private flight: Refresh | undefined;
  private snapshot: (Refresh & { readonly active: boolean }) | undefined;

  getActive(now: number): boolean {
    return (
      this.activeMutations === 0 && this.snapshot?.active === true && now < this.snapshot.validUntil
    );
  }

  mutation(state: ServerSecretStore.PublishingMutationState): void {
    this.generation = state.generation;
    this.activeMutations = state.activeMutations;
    this.snapshot = undefined;
    this.dirty = true;
  }

  requestRefresh(): void {
    this.dirty = true;
  }

  beginRefresh(now: number): Refresh | undefined {
    if (this.flight !== undefined || this.activeMutations > 0 || !this.dirty) return;
    this.dirty = false;
    return (this.flight = {
      generation: this.generation,
      refreshStartedAt: now,
      validUntil: now + SNAPSHOT_VALIDITY_MS,
    });
  }

  settleRefresh(refresh: Refresh, active: boolean, now: number): void {
    if (this.flight !== refresh) return;
    this.flight = undefined;
    if (refresh.generation === this.generation && this.activeMutations === 0) {
      this.snapshot = { ...refresh, active: active && now < refresh.validUntil };
    }
  }
}

export class PublishingCapability extends Context.Service<
  PublishingCapability,
  { readonly getActive: Effect.Effect<boolean> }
>()("t3/environment/PublishingCapability") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  if (secrets.subscribePublishingMutations === undefined || secrets.directory === undefined) {
    return PublishingCapability.of({ getActive: Effect.succeed(false) });
  }
  const directory = secrets.directory;
  const client = yield* Effect.acquireRelease(
    Effect.sync(() => new PublishingObserverClient(() => spawnPublishingObserver(directory))),
    (client) => Effect.sync(() => client.close()),
  );
  const clock = yield* Clock.Clock;
  const now = () => Number(clock.monotonicTimeNanosUnsafe()) / 1_000_000;
  const snapshot = new PublishingCapabilitySnapshot();
  const refreshes = yield* Queue.dropping<void>(1);
  const requestRefresh = () => {
    snapshot.requestRefresh();
    Queue.offerUnsafe(refreshes, undefined);
  };
  yield* Effect.acquireRelease(
    Effect.sync(() =>
      secrets.subscribePublishingMutations?.((state) => {
        snapshot.mutation(state);
        Queue.offerUnsafe(refreshes, undefined);
      }),
    ),
    (unsubscribe) => Effect.sync(() => unsubscribe?.()),
  );

  const refresh = Effect.gen(function* () {
    while (true) {
      const flight = snapshot.beginRefresh(now());
      if (flight === undefined) return;
      const active = yield* Effect.promise(() => client.observe());
      snapshot.settleRefresh(flight, active, now());
    }
  });
  yield* Effect.forever(Queue.take(refreshes).pipe(Effect.andThen(refresh))).pipe(
    Effect.forkScoped,
  );
  yield* Effect.forever(
    Effect.sleep(REFRESH_INTERVAL_MS).pipe(Effect.andThen(Effect.sync(requestRefresh))),
  ).pipe(Effect.forkScoped);
  requestRefresh();

  return PublishingCapability.of({ getActive: Effect.sync(() => snapshot.getActive(now())) });
});

export const layer = Layer.effect(PublishingCapability, make);
