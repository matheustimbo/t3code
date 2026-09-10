import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import * as DesktopBackendManager from "./DesktopBackendManager.ts";
import * as DesktopBackendPool from "./DesktopBackendPool.ts";

const ATTACHED_ORIGIN = new URL("http://127.0.0.1:3773");

const makeAttached = (events: string[]) =>
  DesktopBackendManager.makeAttachedBackendInstance({
    id: DesktopBackendManager.PRIMARY_INSTANCE_ID,
    label: Effect.succeed("Attached server"),
    httpBaseUrl: ATTACHED_ORIGIN,
    onReady: (url) =>
      Effect.sync(() => {
        events.push(`ready:${url.href}`);
      }),
    onShutdown: () =>
      Effect.sync(() => {
        events.push("shutdown");
      }),
  });

/** Stands in for a backend this app spawned, recording whether it was stopped. */
const makeManagedStub = (
  id: string,
  stopped: Ref.Ref<readonly string[]>,
): DesktopBackendManager.DesktopBackendInstance => ({
  id: DesktopBackendManager.BackendInstanceId(id),
  label: Effect.succeed(id),
  ownership: "managed",
  start: Effect.void,
  stop: () => Ref.update(stopped, (current) => [...current, id]),
  currentConfig: Effect.succeed(Option.none()),
  httpBaseUrl: Effect.succeed(Option.none()),
  snapshot: Effect.succeed({
    desiredRunning: true,
    ready: true,
    activePid: Option.some(1234),
    restartAttempt: 0,
    restartScheduled: false,
  }),
  waitForReady: () => Effect.succeed(true),
});

describe("attached backend instance", () => {
  it.effect("reports ready without spawning anything", () =>
    Effect.gen(function* () {
      const events: string[] = [];
      const instance = yield* makeAttached(events);

      assert.equal(instance.ownership, "attached");
      const before = yield* instance.snapshot;
      assert.isFalse(before.ready);

      yield* instance.start;

      assert.deepEqual(events, [`ready:${ATTACHED_ORIGIN.href}`]);
      const after = yield* instance.snapshot;
      assert.isTrue(after.ready);
      assert.isTrue(after.desiredRunning);
      // The pid belongs to another owner and must never surface as ours.
      assert.isTrue(Option.isNone(after.activePid));
      assert.isTrue(yield* instance.waitForReady(Duration.seconds(1)));
    }).pipe(Effect.scoped),
  );

  it.effect("exposes its endpoint but never a start config", () =>
    Effect.gen(function* () {
      const instance = yield* makeAttached([]);
      const endpoint = yield* instance.httpBaseUrl;
      assert.isTrue(Option.isSome(endpoint));
      assert.equal(Option.getOrThrow(endpoint).href, ATTACHED_ORIGIN.href);
      // We never resolved a start config for a process we did not start.
      assert.isTrue(Option.isNone(yield* instance.currentConfig));
    }).pipe(Effect.scoped),
  );

  it.effect("drops only local readiness when stopped", () =>
    Effect.gen(function* () {
      const events: string[] = [];
      const instance = yield* makeAttached(events);
      yield* instance.start;
      yield* instance.stop();

      assert.deepEqual(events, [`ready:${ATTACHED_ORIGIN.href}`, "shutdown"]);
      const after = yield* instance.snapshot;
      assert.isFalse(after.ready);
      assert.isFalse(after.desiredRunning);
    }).pipe(Effect.scoped),
  );
});

describe("pool ownership", () => {
  it.effect("keeps an attached backend out of the managed set", () =>
    Effect.gen(function* () {
      const stopped = yield* Ref.make<readonly string[]>([]);
      const attached = yield* makeAttached([]);
      const managedStub = makeManagedStub("wsl:ubuntu", stopped);

      yield* Effect.gen(function* () {
        const pool = yield* DesktopBackendPool.DesktopBackendPool;

        const all = yield* pool.list;
        assert.deepEqual(all.map((instance) => instance.id as string).sort(), [
          "primary",
          "wsl:ubuntu",
        ]);

        // This is the guard that matters: the quit and update paths iterate
        // `managed`, so an attached server never receives a stop.
        const managed = yield* pool.managed;
        assert.deepEqual(
          managed.map((instance) => instance.id as string),
          ["wsl:ubuntu"],
        );

        yield* Effect.forEach(managed, (instance) => instance.stop());
        assert.deepEqual(yield* Ref.get(stopped), ["wsl:ubuntu"]);
      }).pipe(Effect.provide(DesktopBackendPool.layerTest([attached, managedStub])));
    }).pipe(Effect.scoped),
  );
});
