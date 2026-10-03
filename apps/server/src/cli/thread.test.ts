// @effect-diagnostics nodeBuiltinImport:off - Only synthetic credential and prompt files are opened.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  OrchestrationV2Command as ClientOrchestrationCommand,
  EnvironmentId,
  OrchestrationV2ShellSnapshot as OrchestrationShellSnapshot,
  OrchestrationV2ThreadBoundedSnapshot,
  ProjectId,
  ThreadId,
  type AuthEnvironmentScope,
  type OrchestrationV2ThreadShell as OrchestrationThreadShell,
} from "@t3tools/contracts";
import * as NetService from "@t3tools/shared/Net";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/unstable/cli";
import { FetchHttpClient } from "effect/unstable/http";

import { cli } from "../binCli.ts";
import { readCredential, validateServerOrigin } from "./remoteClient.ts";

const decodeBounded = Schema.decodeUnknownSync(
  Schema.toCodecJson(OrchestrationV2ThreadBoundedSnapshot),
);
const encodeBounded = Schema.encodeSync(Schema.toCodecJson(OrchestrationV2ThreadBoundedSnapshot));
const decodeShellJson = Schema.decodeUnknownSync(Schema.toCodecJson(OrchestrationShellSnapshot));
const encodeShellJson = Schema.encodeSync(Schema.toCodecJson(OrchestrationShellSnapshot));
const decodeShell = (input: unknown) => decodeShellJson(JSON.parse(JSON.stringify(input)));
const decodeCommandJson = Schema.decodeUnknownSync(
  Schema.fromJsonString(ClientOrchestrationCommand),
);
const encodeTestJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const stamp = "2026-10-02T10:00:00.000Z";
const environmentId = EnvironmentId.make("environment-fixture");
const projectId = ProjectId.make("project-fixture");
const threadId = ThreadId.make("thread-fixture");
const modelSelection = { instanceId: "codex", model: "fixture-model" };
const descriptor = {
  environmentId,
  label: "Fixture server",
  platform: { os: "linux", arch: "x64" },
  serverVersion: "fixture-version",
  orchestrationProtocolVersion: 2,
  capabilities: {
    repositoryIdentity: false,
    threadCommandPreconditions: true,
    threadTurnMessageCorrelation: true,
  },
};
const shell = decodeShell({
  schemaVersion: 1,
  snapshotSequence: 1,
  archivedThreads: [],
  projects: [
    {
      id: projectId,
      title: "Fixture",
      workspaceRoot: "/fixture/project",
      defaultModelSelection: modelSelection,
      scripts: [],
      createdAt: stamp,
      updatedAt: stamp,
    },
  ],
  threads: [
    {
      id: threadId,
      projectId,
      title: "Fixture thread",
      modelSelection,
      runtimeMode: "approval-required",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "server",
      providerInstanceId: "codex",
      interactionMode: "default",
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      activeProviderThreadId: null,
      latestRunId: null,
      activeRunId: null,
      status: "idle",
      pendingRuntimeRequest: null,
      latestVisibleMessage: null,
      itemCount: 0,
      visibleItemCount: 0,
      settledOverride: null,
      settledAt: null,
      deletedAt: null,
      createdAt: stamp,
      updatedAt: stamp,
      archivedAt: null,
      latestUserMessageAt: null,
      hasActionableProposedPlan: false,
    },
  ],
});

const fixture = (
  options: {
    readonly scopes?: ReadonlyArray<AuthEnvironmentScope>;
    readonly snapshot?: OrchestrationShellSnapshot;
    readonly metadata?: unknown;
    readonly authenticated?: boolean;
    readonly failDispatch?: boolean;
    readonly detail?: unknown;
    readonly sessionMethod?: "bearer-access-token" | "browser-session-cookie" | "dpop-access-token";
    readonly policy?: "remote-reachable" | "unsafe-no-auth";
    readonly finalSnapshot?: OrchestrationShellSnapshot;
  } = {},
) => {
  const requests: Array<{ path: string; method: string; authorization: string | null }> = [];
  const commands: Array<ClientOrchestrationCommand> = [];
  const snapshot = options.snapshot ?? shell;
  let shellReads = 0;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "https://fixture.invalid");
    assert.equal(init?.redirect, "error");
    assert.equal(init?.credentials, "omit");
    const authorization = new Headers(init?.headers).get("authorization");
    requests.push({ path: url.pathname, method: init?.method ?? "GET", authorization });
    switch (url.pathname) {
      case "/.well-known/t3/environment":
        assert.equal(authorization, null);
        return Response.json(options.metadata ?? descriptor);
      case "/api/auth/session":
        assert.equal(authorization, "Bearer synthetic-fixture-credential");
        return Response.json({
          authenticated: options.authenticated ?? true,
          auth: {
            policy: options.policy ?? "remote-reachable",
            bootstrapMethods: [],
            sessionMethods: ["bearer-access-token"],
            sessionCookieName: "fixture-session",
          },
          scopes: options.scopes ?? ["orchestration:read", "orchestration:operate"],
          sessionMethod: options.sessionMethod ?? "bearer-access-token",
        });
      case "/api/orchestration/shell":
        return Response.json(
          encodeShellJson(shellReads++ === 0 ? snapshot : (options.finalSnapshot ?? snapshot)),
        );
      case `/api/orchestration/threads/${threadId}/bounded`: {
        return Response.json(options.detail);
      }
      case "/api/orchestration/dispatch": {
        assert.equal(init?.method, "POST");
        const body = init?.body;
        const text =
          typeof body === "string"
            ? body
            : body instanceof Uint8Array
              ? new TextDecoder().decode(body)
              : undefined;
        if (text === undefined) throw new Error("Expected a JSON body");
        commands.push(decodeCommandJson(text));
        if (options.failDispatch)
          throw new Error("synthetic-fixture-credential should never appear in output");
        return Response.json({ sequence: 2 });
      }
      default:
        throw new Error("No real network is permitted in this fixture");
    }
  };
  return { fetch, requests, commands };
};

const withFiles = <A, E, R>(
  run: (files: { fd: number; prompt: string }) => Effect.Effect<A, E, R>,
  credential = "synthetic-fixture-credential\n",
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-thread-cli-"));
      const tokenPath = NodePath.join(dir, "fixture-credential");
      const prompt = NodePath.join(dir, "prompt.txt");
      NodeFS.writeFileSync(tokenPath, credential, { mode: 0o600 });
      NodeFS.writeFileSync(prompt, "Synthetic prompt contents, never logged.");
      return { dir, prompt, fd: NodeFS.openSync(tokenPath, "r") };
    }),
    run,
    ({ fd, dir }) =>
      Effect.sync(() => {
        NodeFS.closeSync(fd);
        NodeFS.rmSync(dir, { recursive: true });
      }),
  );

const runCli = (args: ReadonlyArray<string>, server: ReturnType<typeof fixture>, fd: number) =>
  Command.runWith(cli, { version: "fixture" })([
    ...args,
    "--server",
    "https://fixture.invalid",
    "--token-fd",
    String(fd),
    "--json",
  ]).pipe(
    Effect.provideService(FetchHttpClient.Fetch, server.fetch),
    Effect.provide(Layer.mergeAll(NodeServices.layer, NetService.layer)),
  );

const mutationFlags = [
  "--environment-id",
  environmentId,
  "--project",
  projectId,
  "--workspace",
  "/fixture/project",
];

describe("remote thread CLI", () => {
  it.effect("lists projects with a read-only credential and no mutating requests", () =>
    withFiles(({ fd }) =>
      Effect.gen(function* () {
        const server = fixture({ scopes: ["orchestration:read"] });
        yield* runCli(["project", "list"], server, fd);
        const output = yield* TestConsole.logLines;
        assert.include(String(output), projectId);
        assert.include(String(output), environmentId);
        assert.notInclude(String(output), "synthetic-fixture-credential");
        assert.deepEqual(
          server.requests.map((r) => r.method),
          ["GET", "GET", "GET"],
        );
      }).pipe(Effect.provide(TestConsole.layer)),
    ),
  );

  it.effect("lists thread metadata without requesting a conversation body", () =>
    withFiles(({ fd }) =>
      Effect.gen(function* () {
        const server = fixture({ scopes: ["orchestration:read"] });
        yield* runCli(["thread", "list", "--project", projectId], server, fd);
        assert.equal(server.requests.length, 3);
        assert.deepEqual(server.commands, []);
        assert.include(String(yield* TestConsole.logLines), threadId);
      }).pipe(Effect.provide(TestConsole.layer)),
    ),
  );

  it.effect("previews creation with read scope and dispatches nothing", () =>
    withFiles(({ fd }) =>
      Effect.gen(function* () {
        const server = fixture({ scopes: ["orchestration:read"] });
        yield* runCli(
          ["thread", "create", ...mutationFlags, "--title", "Fixture creation"],
          server,
          fd,
        );
        const output = String(yield* TestConsole.logLines);
        assert.include(output, '"executed":false');
        assert.include(output, '"runtimeMode":"approval-required"');
        assert.deepEqual(server.commands, []);
      }).pipe(Effect.provide(TestConsole.layer)),
    ),
  );

  it.effect(
    "creates only an empty thread when execution and the exact destination are supplied",
    () =>
      withFiles(({ fd }) =>
        Effect.gen(function* () {
          const server = fixture();
          yield* runCli(
            ["thread", "create", ...mutationFlags, "--title", "Fixture creation", "--execute"],
            server,
            fd,
          );
          assert.equal(server.commands.length, 1);
          const command = server.commands[0];
          assert.equal(command?.type, "thread.create");
          if (command?.type === "thread.create") {
            assert.equal(command.projectId, projectId);
            assert.equal(command.runtimeMode, "approval-required");
            assert.equal(command.worktreePath, null);
            assert.equal(command.preconditions?.snapshotSequence, 1);
          }
        }).pipe(Effect.provide(TestConsole.layer)),
      ),
  );

  it.effect("requires operate scope before any executed mutation", () =>
    withFiles(({ fd }) =>
      Effect.gen(function* () {
        const server = fixture({ scopes: ["orchestration:read"] });
        const error = yield* runCli(
          ["thread", "create", ...mutationFlags, "--title", "Fixture", "--execute"],
          server,
          fd,
        ).pipe(Effect.flip);
        assert.include(String(error), "orchestration:operate");
        assert.equal(server.requests.length, 2);
        assert.deepEqual(server.commands, []);
      }).pipe(Effect.provide(TestConsole.layer)),
    ),
  );

  it.effect("refuses environment mismatch before sending the credential", () =>
    withFiles(({ fd }) =>
      Effect.gen(function* () {
        const server = fixture({
          metadata: { ...descriptor, environmentId: "different-environment" },
        });
        yield* runCli(
          ["thread", "create", ...mutationFlags, "--title", "Fixture", "--execute"],
          server,
          fd,
        ).pipe(Effect.flip);
        assert.equal(server.requests.length, 1);
        assert.deepEqual(server.commands, []);
      }).pipe(Effect.provide(TestConsole.layer)),
    ),
  );

  it.effect("refuses incompatible protocol before sending the credential", () =>
    withFiles(({ fd }) =>
      Effect.gen(function* () {
        const server = fixture({ metadata: { ...descriptor, orchestrationProtocolVersion: 999 } });
        yield* runCli(["project", "list"], server, fd).pipe(Effect.flip);
        assert.equal(server.requests.length, 1);
      }).pipe(Effect.provide(TestConsole.layer)),
    ),
  );

  it.effect("does not use unauthenticated or unscoped sessions", () =>
    withFiles(({ fd }) =>
      Effect.gen(function* () {
        const server = fixture({ scopes: [], authenticated: false });
        yield* runCli(["project", "list"], server, fd).pipe(Effect.flip);
        assert.equal(server.requests.length, 2);
      }).pipe(Effect.provide(TestConsole.layer)),
    ),
  );

  it.effect("previews prompts without leaking their contents or dispatching", () =>
    withFiles(({ fd, prompt }) =>
      Effect.gen(function* () {
        const server = fixture({ scopes: ["orchestration:read"] });
        yield* runCli(
          [
            "thread",
            "send",
            threadId,
            ...mutationFlags,
            "--runtime-mode",
            "approval-required",
            "--prompt-file",
            prompt,
          ],
          server,
          fd,
        );
        assert.deepEqual(server.commands, []);
        assert.notInclude(String(yield* TestConsole.logLines), "Synthetic prompt contents");
      }).pipe(Effect.provide(TestConsole.layer)),
    ),
  );

  it.effect("sends one prompt and reports a receipt without claiming completion", () =>
    withFiles(({ fd, prompt }) =>
      Effect.gen(function* () {
        const server = fixture();
        yield* runCli(
          [
            "thread",
            "send",
            threadId,
            ...mutationFlags,
            "--runtime-mode",
            "approval-required",
            "--prompt-file",
            prompt,
            "--execute",
          ],
          server,
          fd,
        );
        const command = server.commands[0];
        assert.equal(server.commands.length, 1);
        assert.equal(command?.type, "message.dispatch");
        if (command?.type === "message.dispatch") {
          assert.equal(command.threadId, threadId);
          assert.equal(command.text, "Synthetic prompt contents, never logged.");
          assert.deepEqual(command.attachments, []);
          assert.equal(command.preconditions?.snapshotSequence, 1);
        }
        const output = String(yield* TestConsole.logLines);
        assert.include(output, '"receipt":{"sequence":2}');
        assert.notInclude(output, '"completed"');
        assert.notInclude(output, "Synthetic prompt contents");
      }).pipe(Effect.provide(TestConsole.layer)),
    ),
  );

  it.effect("sanitizes transport failures and never retries a mutation", () =>
    withFiles(({ fd, prompt }) =>
      Effect.gen(function* () {
        const server = fixture({ failDispatch: true });
        const error = yield* runCli(
          [
            "thread",
            "send",
            threadId,
            ...mutationFlags,
            "--runtime-mode",
            "approval-required",
            "--prompt-file",
            prompt,
            "--execute",
          ],
          server,
          fd,
        ).pipe(Effect.flip);
        assert.equal(server.commands.length, 1);
        assert.notInclude(encodeTestJson(error), "synthetic-fixture-credential");
        assert.notInclude(String(yield* TestConsole.logLines), "synthetic-fixture-credential");
      }).pipe(Effect.provide(TestConsole.layer)),
    ),
  );

  it.effect("rejects invalid UTF-8 prompt bytes without dispatching substituted text", () =>
    withFiles(({ fd, prompt }) =>
      Effect.gen(function* () {
        NodeFS.writeFileSync(prompt, new Uint8Array([0xff]));
        const server = fixture();
        yield* runCli(
          [
            "thread",
            "send",
            threadId,
            ...mutationFlags,
            "--runtime-mode",
            "approval-required",
            "--prompt-file",
            prompt,
            "--execute",
          ],
          server,
          fd,
        ).pipe(Effect.flip);
        assert.deepEqual(server.commands, []);
        assert.include(String(yield* TestConsole.logLines), "prompt_input");
      }).pipe(Effect.provide(TestConsole.layer)),
    ),
  );

  const refusals: ReadonlyArray<{ name: string; changes: Partial<OrchestrationThreadShell> }> = [
    { name: "busy", changes: { status: "running" } },
    { name: "queued", changes: { status: "queued" } },
    { name: "pending decision", changes: { hasActionableProposedPlan: true } },
    { name: "archived", changes: { archivedAt: DateTime.makeUnsafe(stamp) } },
  ];
  it.effect.each(refusals)("refuses $name threads without dispatching", ({ changes }) =>
    withFiles(({ fd, prompt }) =>
      Effect.gen(function* () {
        const snapshot = decodeShell({
          ...shell,
          threads: shell.threads.map((thread) => ({ ...thread, ...changes })),
        });
        const server = fixture({ snapshot });
        yield* runCli(
          [
            "thread",
            "send",
            threadId,
            ...mutationFlags,
            "--runtime-mode",
            "approval-required",
            "--prompt-file",
            prompt,
            "--execute",
          ],
          server,
          fd,
        ).pipe(Effect.flip);
        assert.deepEqual(server.commands, []);
      }).pipe(Effect.provide(TestConsole.layer)),
    ),
  );

  it.effect("refuses a thread in a different project before reading its content", () =>
    withFiles(({ fd }) =>
      Effect.gen(function* () {
        const snapshot = decodeShell({
          ...shell,
          threads: shell.threads.map((thread) => ({ ...thread, projectId: "other-project" })),
        });
        const server = fixture({ snapshot });
        yield* runCli(["thread", "status", threadId, "--project", projectId], server, fd).pipe(
          Effect.flip,
        );
        assert.equal(server.requests.length, 3);
      }).pipe(Effect.provide(TestConsole.layer)),
    ),
  );

  it.effect("refuses workspace and runtime mismatches without changing thread permissions", () =>
    withFiles(({ fd, prompt }) =>
      Effect.gen(function* () {
        const server = fixture();
        yield* runCli(
          [
            "thread",
            "send",
            threadId,
            "--environment-id",
            environmentId,
            "--project",
            projectId,
            "--workspace",
            "/different",
            "--runtime-mode",
            "full-access",
            "--prompt-file",
            prompt,
            "--execute",
          ],
          server,
          fd,
        ).pipe(Effect.flip);
        assert.deepEqual(server.commands, []);
      }).pipe(Effect.provide(TestConsole.layer)),
    ),
  );

  it.effect("requires an explicit environment ID even for preview", () =>
    withFiles(({ fd }) =>
      Effect.gen(function* () {
        const server = fixture();
        yield* runCli(
          [
            "thread",
            "create",
            "--project",
            projectId,
            "--workspace",
            "/fixture/project",
            "--title",
            "Fixture",
          ],
          server,
          fd,
        ).pipe(Effect.flip);
        assert.deepEqual(server.commands, []);
      }).pipe(Effect.provide(TestConsole.layer)),
    ),
  );

  it.effect("refuses execution on old servers before sending credentials", () =>
    withFiles(({ fd }) =>
      Effect.gen(function* () {
        const server = fixture({
          metadata: { ...descriptor, capabilities: { repositoryIdentity: false } },
        });
        yield* runCli(
          ["thread", "create", ...mutationFlags, "--title", "Fixture", "--execute"],
          server,
          fd,
        ).pipe(Effect.flip);
        assert.equal(server.requests.length, 1);
        assert.deepEqual(server.commands, []);
      }).pipe(Effect.provide(TestConsole.layer)),
    ),
  );

  it.effect.each([
    { sessionMethod: "browser-session-cookie" as const },
    { sessionMethod: "dpop-access-token" as const },
    { policy: "unsafe-no-auth" as const },
    {
      scopes: [
        "orchestration:read",
        "terminal:operate",
      ] satisfies ReadonlyArray<AuthEnvironmentScope>,
    },
  ])("refuses unsupported authentication %j", (options) =>
    withFiles(({ fd }) =>
      Effect.gen(function* () {
        const server = fixture(options);
        yield* runCli(["project", "list"], server, fd).pipe(Effect.flip);
        assert.equal(server.requests.length, 2);
        assert.deepEqual(server.commands, []);
      }).pipe(Effect.provide(TestConsole.layer)),
    ),
  );

  it.effect("refuses runtime mismatch even with a matching workspace", () =>
    withFiles(({ fd, prompt }) =>
      Effect.gen(function* () {
        const server = fixture();
        yield* runCli(
          [
            "thread",
            "send",
            threadId,
            ...mutationFlags,
            "--runtime-mode",
            "full-access",
            "--prompt-file",
            prompt,
            "--execute",
          ],
          server,
          fd,
        ).pipe(Effect.flip);
        assert.deepEqual(server.commands, []);
        assert.include(String(yield* TestConsole.logLines), "runtime_mode_mismatch");
      }).pipe(Effect.provide(TestConsole.layer)),
    ),
  );
});

describe("remote credential boundary", () => {
  it.effect.each([
    "https://user:password@fixture.invalid",
    "http://fixture.invalid",
    "https://fixture.invalid/path",
    "https://fixture.invalid/?token=secret",
    "https://fixture.invalid/#secret",
    "not a URL",
  ])("rejects unsafe server input %s", (input) =>
    Effect.gen(function* () {
      const error = yield* validateServerOrigin(input).pipe(Effect.flip);
      assert.equal(error.code, "invalid_server");
      assert.notInclude(encodeTestJson(error), "secret");
    }),
  );
  it.effect("accepts HTTPS and loopback origins", () =>
    Effect.gen(function* () {
      assert.equal(
        yield* validateServerOrigin("https://fixture.invalid/"),
        "https://fixture.invalid",
      );
      assert.equal(yield* validateServerOrigin("http://127.0.0.1:3000"), "http://127.0.0.1:3000");
    }),
  );
  it.effect("refuses device descriptors before attempting a potentially blocking read", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => NodeFS.openSync("/dev/null", "r")),
      (fd) =>
        Effect.gen(function* () {
          assert.equal((yield* readCredential(fd).pipe(Effect.flip)).code, "credential_input");
        }),
      (fd) => Effect.sync(() => NodeFS.closeSync(fd)),
    ),
  );
  it.effect.each(
    ["", "embedded whitespace", "x".repeat(9000)].map((credential) => ({
      credential,
      length: credential.length,
    })),
  )("rejects malformed credential of length $length without exposing it", ({ credential }) =>
    withFiles(
      ({ fd }) =>
        Effect.gen(function* () {
          const error = yield* readCredential(fd).pipe(Effect.flip);
          assert.equal(error.code, "credential_input");
        }),
      credential,
    ),
  );
  const completed = decodeBounded({
    snapshotSequence: 1,
    historyCursor: null,
    hasMoreHistory: false,
    latestLocalTurnOrdinal: 1,
    projection: {
      thread: JSON.parse(JSON.stringify(shell.threads[0])),
      runs: [
        {
          id: "fixture-run",
          threadId,
          ordinal: 1,
          providerInstanceId: "codex",
          modelSelection,
          providerThreadId: null,
          userMessageId: "fixture-message",
          rootNodeId: null,
          activeAttemptId: null,
          status: "completed",
          requestedAt: stamp,
          startedAt: stamp,
          completedAt: stamp,
          checkpointId: null,
          contextHandoffId: null,
        },
      ],
      messages: [
        {
          id: "fixture-result",
          threadId,
          runId: "fixture-run",
          nodeId: null,
          createdBy: "user",
          creationSource: "server",
          role: "assistant",
          text: "Matching run result",
          attachments: [],
          streaming: false,
          createdAt: stamp,
          updatedAt: stamp,
        },
        {
          id: "private-result",
          threadId,
          runId: "older-run",
          nodeId: null,
          createdBy: "user",
          creationSource: "server",
          role: "assistant",
          text: "Unrelated history",
          attachments: [],
          streaming: false,
          createdAt: stamp,
          updatedAt: stamp,
        },
      ],
      attempts: [],
      nodes: [],
      subagents: [],
      providerSessions: [],
      providerThreads: [],
      providerTurns: [],
      runtimeRequests: [],
      plans: [],
      turnItems: [],
      checkpointScopes: [],
      checkpoints: [],
      contextHandoffs: [],
      contextTransfers: [],
      visibleTurnItems: [],
      updatedAt: stamp,
    },
  });
  const completedShell = decodeShell({
    ...shell,
    threads: shell.threads.map((thread) => ({
      ...thread,
      latestRunId: "fixture-run",
      status: "completed",
    })),
  });
  const detailJson = encodeBounded(completed);
  it.effect.each(["status", "wait"])(
    "%s returns only output correlated to the exact submitted message",
    (command) =>
      withFiles(({ fd }) =>
        Effect.gen(function* () {
          const server = fixture({ snapshot: completedShell, detail: detailJson });
          yield* runCli(
            [
              "thread",
              command,
              threadId,
              "--project",
              projectId,
              "--message-id",
              "fixture-message",
            ],
            server,
            fd,
          );
          const output = String(yield* TestConsole.logLines);
          assert.include(output, "Matching run result");
          assert.notInclude(output, "Unrelated history");
          assert.deepEqual(server.commands, []);
          if (command === "wait") assert.include(output, '"waitState":"completed"');
        }).pipe(Effect.provide(TestConsole.layer)),
      ),
  );
  it.effect("refuses to equate an idle thread with completion of another run", () =>
    withFiles(({ fd }) =>
      Effect.gen(function* () {
        const server = fixture({ snapshot: completedShell, detail: detailJson });
        yield* runCli(
          ["thread", "wait", threadId, "--project", projectId, "--turn-id", "other-run"],
          server,
          fd,
        ).pipe(Effect.flip);
        assert.include(String(yield* TestConsole.logLines), "turn_mismatch");
      }).pipe(Effect.provide(TestConsole.layer)),
    ),
  );
  it.effect("stops waiting for a pending decision", () =>
    withFiles(({ fd }) =>
      Effect.gen(function* () {
        const snapshot = {
          ...completedShell,
          threads: completedShell.threads.map((thread) => ({
            ...thread,
            hasActionableProposedPlan: true,
          })),
        };
        const server = fixture({ snapshot, detail: detailJson });
        yield* runCli(
          ["thread", "wait", threadId, "--project", projectId, "--message-id", "fixture-message"],
          server,
          fd,
        );
        assert.include(String(yield* TestConsole.logLines), "needs_attention");
      }).pipe(Effect.provide(TestConsole.layer)),
    ),
  );
  it.effect("refuses state that changed while reading thread output", () =>
    withFiles(({ fd }) =>
      Effect.gen(function* () {
        const server = fixture({
          snapshot: completedShell,
          finalSnapshot: { ...completedShell, snapshotSequence: 2 },
          detail: detailJson,
        });
        yield* runCli(["thread", "status", threadId, "--project", projectId], server, fd).pipe(
          Effect.flip,
        );
        assert.include(String(yield* TestConsole.logLines), "snapshot_changed");
      }).pipe(Effect.provide(TestConsole.layer)),
    ),
  );
});
