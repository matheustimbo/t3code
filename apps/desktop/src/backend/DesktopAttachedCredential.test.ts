import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as DesktopAttachedCredential from "./DesktopAttachedCredential.ts";

const encoder = new TextEncoder();

const spawnerLayer = (
  respond: (command: { readonly command: string; readonly args: readonly string[] }) => {
    readonly stdout: string;
    readonly stderr?: string;
    readonly exitCode: number;
  },
  observed?: { current?: readonly string[] },
) =>
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const args = (command as unknown as { args: readonly string[] }).args;
      if (observed) observed.current = args;
      const result = respond({
        command: (command as unknown as { command: string }).command,
        args,
      });
      return Effect.succeed({
        pid: 999,
        stdout: Stream.make(encoder.encode(result.stdout)),
        stderr: Stream.make(encoder.encode(result.stderr ?? "")),
        exitCode: Effect.succeed(result.exitCode),
        kill: () => Effect.void,
        stdin: Sink.drain,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      } as never);
    }),
  );

const issue = (stateDir: string) =>
  DesktopAttachedCredential.issueAttachedBearerToken({
    executablePath: "/Applications/T3 Code.app/Contents/MacOS/T3 Code",
    entryPath: "/Applications/T3 Code.app/Contents/Resources/server/bin.js",
    stateDir,
  });

describe("resolveAuthBaseDir", () => {
  it("names the base dir the CLI would derive the state dir from", () => {
    assert.equal(
      DesktopAttachedCredential.resolveAuthBaseDir("/home/u/.t3/userdata"),
      "/home/u/.t3",
    );
    assert.equal(
      DesktopAttachedCredential.resolveAuthBaseDir("/home/u/.t3/userdata/"),
      "/home/u/.t3",
    );
  });

  it("refuses a dev state dir that no auth flag can name", () => {
    // `--base-dir X` always derives X/userdata, so a `<base>/dev` shell has no
    // way to point the mint at its own database.
    assert.isNull(DesktopAttachedCredential.resolveAuthBaseDir("/home/u/.t3/dev"));
  });
});

describe("issueAttachedBearerToken", () => {
  it.effect("mints through the shipped auth CLI against the shared state dir", () =>
    Effect.gen(function* () {
      const observed: { current?: readonly string[] } = {};
      const token = yield* issue("/home/u/.t3/userdata").pipe(
        Effect.provide(spawnerLayer(() => ({ stdout: "t3s_abc123\n", exitCode: 0 }), observed)),
      );
      assert.equal(token, "t3s_abc123");
      assert.deepEqual(observed.current?.slice(1, 6), [
        "auth",
        "session",
        "issue",
        "--base-dir",
        "/home/u/.t3",
      ]);
      assert.include(observed.current ?? [], "--token-only");
    }),
  );

  it.effect("fails loudly instead of minting into the wrong database", () =>
    Effect.gen(function* () {
      const outcome = yield* issue("/home/u/.t3/dev").pipe(
        Effect.provide(
          spawnerLayer(() => {
            throw new Error("the CLI must not be reached for an unnameable state dir");
          }),
        ),
        Effect.result,
      );
      assert.equal(outcome._tag, "Failure");
    }),
  );

  it.effect("reports a non-zero exit with the CLI's own message", () =>
    Effect.gen(function* () {
      const outcome = yield* issue("/home/u/.t3/userdata").pipe(
        Effect.provide(
          spawnerLayer(() => ({ stdout: "", stderr: "database is locked", exitCode: 1 })),
        ),
        Effect.result,
      );
      assert.equal(outcome._tag, "Failure");
      if (outcome._tag !== "Failure") return;
      assert.include(String(outcome.failure.message), "database is locked");
    }),
  );

  it.effect("rejects an empty token rather than handing back a blank bearer", () =>
    Effect.gen(function* () {
      const outcome = yield* issue("/home/u/.t3/userdata").pipe(
        Effect.provide(spawnerLayer(() => ({ stdout: "\n \n", exitCode: 0 }))),
        Effect.result,
      );
      assert.equal(outcome._tag, "Failure");
    }),
  );
});

describe("issueAttachedBearerToken spawn failures", () => {
  it.effect("surfaces a spawn failure as an error rather than a blank token", () =>
    Effect.gen(function* () {
      const failingSpawner = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() =>
          Effect.fail(
            PlatformError.systemError({
              _tag: "NotFound",
              module: "ChildProcess",
              method: "spawn",
              description: "ENOENT: no such server entry",
            }),
          ),
        ),
      );
      const outcome = yield* issue("/home/u/.t3/userdata").pipe(
        Effect.provide(failingSpawner),
        Effect.result,
      );
      assert.equal(outcome._tag, "Failure");
      if (outcome._tag !== "Failure") return;
      assert.include(String(outcome.failure.message), "ENOENT");
    }),
  );
});
