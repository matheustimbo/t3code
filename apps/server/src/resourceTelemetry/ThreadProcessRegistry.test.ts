import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";

import { claimAgentProcessScoped, readThreadProcessClaims } from "./ThreadProcessRegistry.ts";

const claimsFor = (threadId: string) =>
  readThreadProcessClaims().filter((claim) => claim.threadId === threadId);

describe("scoped agent process claims", () => {
  it.effect("keeps overlapping roots when an old scope closes", () =>
    Effect.gen(function* () {
      const threadId = "registry-overlap";
      const first = yield* Scope.make();
      const second = yield* Scope.make();
      yield* claimAgentProcessScoped({ scope: first, threadId, pid: 101 });
      yield* claimAgentProcessScoped({ scope: second, threadId, pid: 102 });
      assert.deepEqual(
        claimsFor(threadId).map((claim) => claim.pid),
        [101, 102],
      );
      yield* Scope.close(first, Exit.void);
      yield* Scope.close(first, Exit.void);
      assert.deepEqual(
        claimsFor(threadId).map((claim) => claim.pid),
        [102],
      );
      yield* Scope.close(second, Exit.void);
      assert.deepEqual(claimsFor(threadId), []);
    }),
  );

  it.effect("keeps independent query tokens and falls back from invalid pid", () =>
    Effect.gen(function* () {
      const threadId = "registry-query-overlap";
      const first = yield* Scope.make();
      const second = yield* Scope.make();
      yield* claimAgentProcessScoped({
        scope: first,
        threadId,
        pid: NaN,
        commandToken: "first-query-token",
      });
      yield* claimAgentProcessScoped({
        scope: second,
        threadId,
        commandToken: "second-query-token",
      });
      assert.deepEqual(claimsFor(threadId), [
        { threadId, kind: "agent", commandToken: "first-query-token" },
        { threadId, kind: "agent", commandToken: "second-query-token" },
      ]);
      yield* Scope.close(first, Exit.void);
      assert.equal(claimsFor(threadId)[0]?.commandToken, "second-query-token");
      yield* Scope.close(second, Exit.void);
    }),
  );

  it.effect("does not acquire claims until its effect executes", () =>
    Effect.gen(function* () {
      const threadId = "registry-lazy";
      const scope = yield* Scope.make();
      const acquire = claimAgentProcessScoped({ scope, threadId, pid: 103 });
      assert.deepEqual(claimsFor(threadId), []);
      yield* acquire;
      assert.equal(claimsFor(threadId)[0]?.pid, 103);
      yield* Scope.close(scope, Exit.void);
      assert.deepEqual(claimsFor(threadId), []);
    }),
  );

  it.effect("does not leak invalid evidence or acquisition into a closed scope", () =>
    Effect.gen(function* () {
      const threadId = "registry-closed";
      const scope = yield* Scope.make();
      yield* claimAgentProcessScoped({ scope, threadId, pid: 0, commandToken: "" });
      assert.deepEqual(claimsFor(threadId), []);
      yield* Scope.close(scope, Exit.void);
      yield* claimAgentProcessScoped({ scope, threadId, pid: 104 });
      assert.deepEqual(claimsFor(threadId), []);
    }),
  );

  it.effect("releases an acquired claim after its owning fiber is interrupted", () =>
    Effect.gen(function* () {
      const threadId = "registry-interrupted";
      const fiber = yield* Effect.gen(function* () {
        yield* claimAgentProcessScoped({ scope: yield* Effect.scope, threadId, pid: 105 });
        yield* Effect.never;
      }).pipe(Effect.scoped, Effect.forkScoped({ startImmediately: true }));
      assert.equal(claimsFor(threadId)[0]?.pid, 105);
      yield* Fiber.interrupt(fiber);
      assert.deepEqual(claimsFor(threadId), []);
    }),
  );
});
