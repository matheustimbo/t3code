import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { PublishingCapability, layer } from "./PublishingCapability.ts";
import { PublishingCapabilitySnapshot } from "./PublishingCapability.ts";

it("keeps unknown and expired capability false with validity measured from refresh start", () => {
  const snapshot = new PublishingCapabilitySnapshot();
  expect(snapshot.getActive(0)).toBe(false);
  const flight = snapshot.beginRefresh(100)!;
  snapshot.settleRefresh(flight, true, 900);
  expect(snapshot.getActive(10_099)).toBe(true);
  expect(snapshot.getActive(10_100)).toBe(false);
  snapshot.requestRefresh();
  const late = snapshot.beginRefresh(20_000)!;
  snapshot.settleRefresh(late, true, 30_000);
  expect(snapshot.getActive(30_000)).toBe(false);
});

it("invalidates before mutation I/O and waits for all concurrent mutations to settle", () => {
  const snapshot = new PublishingCapabilitySnapshot();
  const initial = snapshot.beginRefresh(0)!;
  snapshot.settleRefresh(initial, true, 1);
  expect(snapshot.getActive(2)).toBe(true);
  snapshot.mutation({ generation: 1, activeMutations: 1 });
  expect(snapshot.getActive(3)).toBe(false);
  expect(snapshot.beginRefresh(3)).toBeUndefined();
  snapshot.mutation({ generation: 2, activeMutations: 2 });
  snapshot.mutation({ generation: 3, activeMutations: 1 });
  expect(snapshot.beginRefresh(4)).toBeUndefined();
  snapshot.mutation({ generation: 4, activeMutations: 0 });
  const confirmed = snapshot.beginRefresh(5)!;
  snapshot.settleRefresh(confirmed, true, 6);
  expect(snapshot.getActive(7)).toBe(true);
});

it("fences a flight started before mutation and reruns dirty refresh after settlement", () => {
  const snapshot = new PublishingCapabilitySnapshot();
  const stale = snapshot.beginRefresh(0)!;
  snapshot.mutation({ generation: 1, activeMutations: 1 });
  snapshot.mutation({ generation: 2, activeMutations: 0 });
  expect(snapshot.beginRefresh(3)).toBeUndefined();
  snapshot.settleRefresh(stale, true, 4);
  expect(snapshot.getActive(4)).toBe(false);
  const current = snapshot.beginRefresh(5)!;
  snapshot.settleRefresh(current, false, 6);
  expect(snapshot.getActive(7)).toBe(false);
  snapshot.settleRefresh(stale, true, 8);
  expect(snapshot.getActive(8)).toBe(false);
});

it("does not publish from an old flight while a mutation remains active", () => {
  const snapshot = new PublishingCapabilitySnapshot();
  const stale = snapshot.beginRefresh(0)!;
  snapshot.mutation({ generation: 1, activeMutations: 1 });
  snapshot.settleRefresh(stale, true, 1);
  expect(snapshot.beginRefresh(2)).toBeUndefined();
  expect(snapshot.getActive(2)).toBe(false);
  snapshot.mutation({ generation: 2, activeMutations: 0 });
  expect(snapshot.beginRefresh(3)).toBeDefined();
});

it("coalesces periodic refresh during a flight and makes refresh failure false immediately", () => {
  const snapshot = new PublishingCapabilitySnapshot();
  const initial = snapshot.beginRefresh(0)!;
  snapshot.settleRefresh(initial, true, 1);
  snapshot.requestRefresh();
  const flight = snapshot.beginRefresh(5_000)!;
  expect(snapshot.getActive(5_001)).toBe(true);
  snapshot.requestRefresh();
  expect(snapshot.beginRefresh(5_002)).toBeUndefined();
  snapshot.settleRefresh(flight, false, 5_003);
  expect(snapshot.getActive(5_003)).toBe(false);
  const rerun = snapshot.beginRefresh(5_004)!;
  snapshot.settleRefresh(rerun, true, 5_005);
  expect(snapshot.beginRefresh(5_006)).toBeUndefined();
  expect(snapshot.getActive(5_006)).toBe(true);
});

it.effect(
  "acquires a resident false hint without touching secret reads for unsupported stores",
  () =>
    Effect.gen(function* () {
      const capability = yield* PublishingCapability;
      expect(yield* capability.getActive).toBe(false);
    }).pipe(
      Effect.provide(layer),
      Effect.provideService(ServerSecretStore.ServerSecretStore, {
        get: () => Effect.die("resident reads must never fetch secrets"),
        set: () => Effect.void,
        create: () => Effect.void,
        getOrCreateRandom: () => Effect.never,
        remove: () => Effect.void,
      }),
    ),
);
