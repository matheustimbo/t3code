import { assert, describe, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  ClaudeSettings,
  MessageId,
  NodeId,
  ProjectId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ProviderEventLoggers from "../../provider/Layers/ProviderEventLoggers.ts";
import { readThreadProcessClaims } from "../../resourceTelemetry/ThreadProcessRegistry.ts";
import * as ClaudeAdapter from "./ClaudeAdapterV2.ts";
import * as IdAllocator from "../IdAllocator.ts";

const sdk = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@anthropic-ai/claude-agent-sdk")>()),
  query: sdk.query,
}));

const runnerLayer = ClaudeAdapter.claudeAgentSdkQueryRunnerLiveLayer.pipe(
  Layer.provide(NodeServices.layer),
  Layer.provide(
    Layer.succeed(
      ProviderEventLoggers.ProviderEventLoggers,
      ProviderEventLoggers.NoOpProviderEventLoggers,
    ),
  ),
);
const settings = Schema.decodeSync(ClaudeSettings)({});
const tokensFor = (threadId: string) =>
  readThreadProcessClaims()
    .filter((claim) => claim.threadId === threadId)
    .map((claim) => claim.commandToken);

function fakeQuery(idle = false) {
  const cleanupStarted = Promise.withResolvers<void>();
  const cleanupGate = Promise.withResolvers<void>();
  let cleanup: Promise<IteratorResult<SDKMessage, void>> | undefined;
  const done = (): IteratorResult<SDKMessage, void> => ({ done: true, value: undefined });
  const runtime = {
    next: async () => {
      if (idle) await cleanupGate.promise;
      return done();
    },
    return: () =>
      (cleanup ??= (async () => {
        cleanupStarted.resolve();
        await cleanupGate.promise;
        return done();
      })()),
    [Symbol.asyncIterator]() {
      return this;
    },
    close: () => {
      cleanupStarted.resolve();
    },
  } as unknown as Query;
  return { runtime, cleanupStarted, cleanupGate };
}

const openInput = (
  threadId: ThreadId,
  token: string,
): ClaudeAdapter.ClaudeAgentSdkQueryOpenInput => ({
  threadId,
  providerSessionId: ProviderSessionId.make(`${threadId}-session`),
  options: {
    model: "claude-sonnet",
    tools: [],
    permissionMode: "bypassPermissions",
    sessionId: token,
  },
});

describe("Claude query process claims", () => {
  it.effect("binds a live query to its provider session beyond the startTurn caller scope", () =>
    Effect.gen(function* () {
      const runner = yield* ClaudeAdapter.ClaudeAgentSdkQueryRunner;
      const threadId = ThreadId.make("claude-query-turn-scope");
      const fake = fakeQuery(true);
      sdk.query.mockReturnValueOnce(fake.runtime);
      const fs = yield* FileSystem.FileSystem;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "claude-query-scope-" });
      const sessionScope = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(sessionScope, Exit.void));
      const modelSelection = {
        instanceId: ClaudeAdapter.CLAUDE_DEFAULT_INSTANCE_ID,
        model: "claude-sonnet-4-6",
      };
      const runtimePolicy = {
        cwd,
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
      };
      const adapter = ClaudeAdapter.makeClaudeAdapterV2({
        instanceId: ClaudeAdapter.CLAUDE_DEFAULT_INSTANCE_ID,
        settings,
        environment: {},
        attachmentsDir: cwd,
        fileSystem: fs,
        path: yield* Path.Path,
        idAllocator: yield* IdAllocator.IdAllocatorV2,
        queryRunner: runner,
      });
      const runtime = yield* adapter
        .openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("claude-query-turn-scope-session"),
          modelSelection,
          runtimePolicy,
        })
        .pipe(Effect.provideService(Scope.Scope, sessionScope));
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      const now = yield* DateTime.now;
      yield* runtime
        .startTurn({
          appThread: {
            createdBy: "user",
            creationSource: "web",
            id: threadId,
            projectId: ProjectId.make("claude-query-turn-scope-project"),
            title: "Query scope test",
            providerInstanceId: modelSelection.instanceId,
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            activeProviderThreadId: providerThread.id,
            lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            lastVisitedAt: null,
            deletedAt: null,
          },
          threadId,
          runId: RunId.make("claude-query-turn-scope-run"),
          runOrdinal: 1,
          providerTurnOrdinal: 1,
          attemptId: RunAttemptId.make("claude-query-turn-scope-attempt"),
          rootNodeId: NodeId.make("claude-query-turn-scope-node"),
          providerThread,
          message: {
            createdBy: "user",
            creationSource: "web",
            messageId: MessageId.make("claude-query-turn-scope-message"),
            text: "Run",
            attachments: [],
          },
          modelSelection,
          runtimePolicy,
        })
        .pipe(Effect.scoped);
      assert.deepEqual(tokensFor(threadId), [providerThread.nativeThreadRef?.nativeId]);
      const close = yield* Scope.close(sessionScope, Exit.void).pipe(Effect.forkScoped);
      yield* Effect.promise(() => fake.cleanupStarted.promise);
      assert.equal(tokensFor(threadId).length, 1);
      fake.cleanupGate.resolve();
      yield* Fiber.join(close);
      assert.deepEqual(tokensFor(threadId), []);
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.mergeAll(runnerLayer, NodeServices.layer, IdAllocator.layer)),
    ),
  );

  it.effect("closes an interrupted open before its caller scope is released", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("claude-query-interrupted-open");
      const entered = yield* Deferred.make<void>();
      const fake = fakeQuery();
      sdk.query.mockReturnValueOnce(fake.runtime);
      const runner = yield* ClaudeAdapter.ClaudeAgentSdkQueryRunner.pipe(
        Effect.provide(ClaudeAdapter.claudeAgentSdkQueryRunnerLiveLayer),
        Effect.provideService(ProviderEventLoggers.ProviderEventLoggers, {
          canonical: undefined,
          native: {
            filePath: "unused",
            write: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
            close: () => Effect.void,
          },
        }),
      );
      const open = yield* runner
        .open(openInput(threadId, "interrupted-query-token"))
        .pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      const interrupt = yield* Fiber.interrupt(open).pipe(Effect.forkScoped);
      yield* Effect.promise(() => fake.cleanupStarted.promise);
      assert.deepEqual(tokensFor(threadId), ["interrupted-query-token"]);
      fake.cleanupGate.resolve();
      yield* Fiber.join(interrupt);
      assert.deepEqual(tokensFor(threadId), []);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "keeps separate queries until each SDK cleanup completes, even without reading messages",
    () =>
      Effect.gen(function* () {
        const runner = yield* ClaudeAdapter.ClaudeAgentSdkQueryRunner;
        const threadId = ThreadId.make("claude-query-claims");
        const first = fakeQuery();
        const second = fakeQuery();
        sdk.query.mockReturnValueOnce(first.runtime).mockReturnValueOnce(second.runtime);
        const firstSession = yield* runner.open(openInput(threadId, "first-query-token"));
        const secondSession = yield* runner.open(openInput(threadId, "second-query-token"));
        assert.deepEqual(tokensFor(threadId), ["first-query-token", "second-query-token"]);
        const closing = yield* firstSession.close.pipe(Effect.forkScoped);
        yield* Effect.promise(() => first.cleanupStarted.promise);
        assert.deepEqual(tokensFor(threadId), ["first-query-token", "second-query-token"]);
        first.cleanupGate.resolve();
        yield* Fiber.join(closing);
        assert.deepEqual(tokensFor(threadId), ["second-query-token"]);
        second.cleanupGate.resolve();
        yield* secondSession.close;
        assert.deepEqual(tokensFor(threadId), []);
      }).pipe(Effect.scoped, Effect.provide(runnerLayer)),
  );

  it.effect("waits for SDK cleanup at EOF before releasing its token", () =>
    Effect.gen(function* () {
      const runner = yield* ClaudeAdapter.ClaudeAgentSdkQueryRunner;
      const threadId = ThreadId.make("claude-query-eof");
      const fake = fakeQuery();
      sdk.query.mockReturnValueOnce(fake.runtime);
      const session = yield* runner.open(openInput(threadId, "eof-query-token"));
      const drain = yield* session.messages.pipe(Stream.runDrain, Effect.forkScoped);
      yield* Effect.promise(() => fake.cleanupStarted.promise);
      assert.deepEqual(tokensFor(threadId), ["eof-query-token"]);
      fake.cleanupGate.resolve();
      yield* Fiber.join(drain);
      assert.deepEqual(tokensFor(threadId), []);
    }).pipe(Effect.scoped, Effect.provide(runnerLayer)),
  );

  it.effect("cleans an unread query when its caller scope closes", () =>
    Effect.gen(function* () {
      const runner = yield* ClaudeAdapter.ClaudeAgentSdkQueryRunner;
      const threadId = ThreadId.make("claude-query-parent-close");
      const fake = fakeQuery();
      sdk.query.mockReturnValueOnce(fake.runtime);
      const scope = yield* Scope.make();
      yield* runner
        .open(openInput(threadId, "unread-query-token"))
        .pipe(Effect.provideService(Scope.Scope, scope));
      const close = yield* Scope.close(scope, Exit.void).pipe(Effect.forkScoped);
      yield* Effect.promise(() => fake.cleanupStarted.promise);
      assert.deepEqual(tokensFor(threadId), ["unread-query-token"]);
      fake.cleanupGate.resolve();
      yield* Fiber.join(close);
      assert.deepEqual(tokensFor(threadId), []);
    }).pipe(Effect.scoped, Effect.provide(runnerLayer)),
  );
});
