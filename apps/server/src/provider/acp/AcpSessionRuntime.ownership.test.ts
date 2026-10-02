import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as Crypto from "effect/Crypto";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
} from "@t3tools/contracts";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import { ChildProcessSpawner } from "effect/unstable/process";

import { readThreadProcessClaims } from "../../resourceTelemetry/ThreadProcessRegistry.ts";
import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";
import {
  AcpProviderCapabilitiesV2,
  makeAcpAdapterV2,
} from "../../orchestration-v2/Adapters/AcpAdapterV2.ts";
import * as IdAllocator from "../../orchestration-v2/IdAllocator.ts";
import * as ServerConfig from "../../config.ts";

describe("ACP runtime process claims", () => {
  it.effect("propagates a thread owner through the adapter to its captured process", () =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const captured = yield* Deferred.make<ChildProcessSpawner.ChildProcessHandle>();
      const captureSpawner = ChildProcessSpawner.make((command) =>
        spawner.spawn(command).pipe(Effect.tap((handle) => Deferred.succeed(captured, handle))),
      );
      const scope = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
      const threadId = ThreadId.make("acp-adapter-process-owner");
      const instanceId = ProviderInstanceId.make("acp-adapter-process-owner");
      const adapter = makeAcpAdapterV2({
        instanceId,
        crypto: yield* Crypto.Crypto,
        fileSystem: yield* FileSystem.FileSystem,
        idAllocator: yield* IdAllocator.IdAllocatorV2,
        serverConfig: yield* ServerConfig.ServerConfig,
        selfInvocation: yield* resolveSelfInvocation(),
        flavor: {
          driver: ProviderDriverKind.make("acpRegistry"),
          capabilities: AcpProviderCapabilitiesV2,
          makeRuntime: (input) =>
            AcpSessionRuntime.make({
              ...input,
              authMethodId: "test",
              spawn: {
                command: process.execPath,
                args: [
                  new URL(
                    "../../../../../packages/effect-acp/test/fixtures/acp-mock-peer.ts",
                    import.meta.url,
                  ).pathname,
                ],
                cwd: input.cwd,
              },
            }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, captureSpawner)),
        },
      });
      yield* adapter
        .openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("acp-adapter-process-owner-session"),
          modelSelection: { instanceId, model: "default" },
          runtimePolicy: {
            cwd: process.cwd(),
            runtimeMode: "full-access",
            interactionMode: "default",
          },
        })
        .pipe(Effect.provideService(Scope.Scope, scope));
      const handle = yield* Deferred.await(captured);
      const claims = () => readThreadProcessClaims().filter((claim) => claim.threadId === threadId);
      assert.deepEqual(claims(), [{ threadId, kind: "agent", pid: Number(handle.pid) }]);
      yield* Scope.close(scope, Exit.void);
      assert.isFalse(yield* handle.isRunning);
      assert.deepEqual(claims(), []);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          IdAllocator.layer,
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-acp-owner-" }).pipe(
            Layer.provide(NodeServices.layer),
          ),
        ),
      ),
    ),
  );

  for (const owned of [false, true]) {
    it.effect(
      `registers captured process ownership for ${owned ? "a thread runtime" : "an unowned probe"}`,
      () =>
        Effect.gen(function* () {
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
          const captured = yield* Deferred.make<ChildProcessSpawner.ChildProcessHandle>();
          const captureSpawner = ChildProcessSpawner.make((command) =>
            spawner.spawn(command).pipe(Effect.tap((handle) => Deferred.succeed(captured, handle))),
          );
          const scope = yield* Scope.make();
          yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
          const threadId = `acp-captured-${owned}`;
          const runtime = yield* AcpSessionRuntime.make({
            ...(owned ? { owner: { threadId } } : {}),
            cwd: process.cwd(),
            clientInfo: { name: "ownership-test", version: "0.0.0" },
            authMethodId: "test",
            spawn: {
              command: process.execPath,
              args: [
                new URL(
                  "../../../../../packages/effect-acp/test/fixtures/acp-mock-peer.ts",
                  import.meta.url,
                ).pathname,
              ],
              cwd: process.cwd(),
            },
          }).pipe(
            Effect.provideService(Scope.Scope, scope),
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, captureSpawner),
          );
          const handle = yield* Deferred.await(captured);
          const claims = () =>
            readThreadProcessClaims().filter((claim) => claim.threadId === threadId);
          assert.deepEqual(
            claims(),
            owned ? [{ threadId, kind: "agent", pid: Number(handle.pid) }] : [],
          );
          yield* runtime.start();
          yield* Scope.close(scope, Exit.void);
          assert.isFalse(yield* handle.isRunning);
          assert.deepEqual(claims(), []);
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  }
});
