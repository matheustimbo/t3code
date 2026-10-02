// @effect-diagnostics nodeBuiltinImport:off - Only synthetic credential and prompt files are opened.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ClientOrchestrationCommand,
  EnvironmentId,
  MessageId,
  OrchestrationShellSnapshot,
  OrchestrationThreadDetailSnapshot,
  ProjectId,
  ThreadId,
  TurnId,
  type AuthEnvironmentScope,
  type OrchestrationThreadShell,
  type OrchestrationLatestTurn,
} from "@t3tools/contracts";
import * as NetService from "@t3tools/shared/Net";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestConsole from "effect/testing/TestConsole";
import * as TestClock from "effect/testing/TestClock";
import { Command } from "effect/unstable/cli";
import { FetchHttpClient } from "effect/unstable/http";

import { cli } from "../bin.ts";
import { readCredential, remoteError, validateServerOrigin } from "./remoteClient.ts";
import { waitForTurn, type ThreadStatus } from "./thread.ts";

const decodeShell = Schema.decodeUnknownSync(OrchestrationShellSnapshot);
const decodeDetail = Schema.decodeUnknownSync(OrchestrationThreadDetailSnapshot);
const decodeCommandJson = Schema.decodeUnknownSync(
  Schema.fromJsonString(ClientOrchestrationCommand),
);
const encodeTestJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const stamp = "2026-10-02T10:00:00.000Z";
const environmentId = EnvironmentId.make("environment-fixture");
const projectId = ProjectId.make("project-fixture");
const threadId = ThreadId.make("thread-fixture");
const turnId = TurnId.make("turn-fixture");
const modelSelection = { instanceId: "codex", model: "fixture-model" };
const descriptor = {
  environmentId,
  label: "Fixture server",
  platform: { os: "linux", arch: "x64" },
  serverVersion: "fixture-version",
  orchestrationProtocolVersion: 1,
  capabilities: {
    repositoryIdentity: false,
    threadCommandPreconditions: true,
    threadTurnMessageCorrelation: true,
  },
};
const shell = decodeShell({
  snapshotSequence: 1,
  updatedAt: stamp,
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
      latestTurn: null,
      session: null,
      createdAt: stamp,
      updatedAt: stamp,
      archivedAt: null,
      latestUserMessageAt: null,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
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
        return Response.json(shellReads++ === 0 ? snapshot : (options.finalSnapshot ?? snapshot));
      case `/api/orchestration/threads/${threadId}`: {
        assert.equal(url.searchParams.get("turnLimit"), "1");
        const thread = snapshot.threads[0];
        return Response.json(
          options.detail ?? {
            snapshotSequence: snapshot.snapshotSequence,
            thread: { ...thread, deletedAt: null, messages: [], activities: [], checkpoints: [] },
          },
        );
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
            assert.equal(command.expectedSnapshotSequence, 1);
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
        assert.equal(command?.type, "thread.turn.start");
        if (command?.type === "thread.turn.start") {
          assert.equal(command.threadId, threadId);
          assert.equal(command.message.text, "Synthetic prompt contents, never logged.");
          assert.deepEqual(command.message.attachments, []);
          assert.equal(command.expectedSnapshotSequence, 1);
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
    {
      name: "busy",
      changes: {
        session: {
          threadId,
          status: "running",
          runtimeMode: "approval-required",
          providerName: "codex",
          activeTurnId: turnId,
          lastError: null,
          updatedAt: stamp,
        },
      },
    },
    { name: "pending approval", changes: { hasPendingApprovals: true } },
    { name: "pending input", changes: { hasPendingUserInput: true } },
    { name: "background work", changes: { backgroundLiveness: "working" } },
    { name: "queued prompt", changes: { latestUserMessageAt: stamp } },
    { name: "archived", changes: { archivedAt: stamp } },
  ];
  for (const { name, changes } of refusals) {
    it.effect(`refuses ${name} threads without dispatching`, () =>
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
  }

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

  for (const options of [
    { sessionMethod: "browser-session-cookie" as const },
    { sessionMethod: "dpop-access-token" as const },
    { policy: "unsafe-no-auth" as const },
    {
      scopes: [
        "orchestration:read",
        "terminal:operate",
      ] satisfies ReadonlyArray<AuthEnvironmentScope>,
    },
  ]) {
    it.effect(`refuses unsupported authentication ${JSON.stringify(options)}`, () =>
      withFiles(({ fd }) =>
        Effect.gen(function* () {
          const server = fixture(options);
          yield* runCli(["project", "list"], server, fd).pipe(Effect.flip);
          assert.equal(server.requests.length, 2);
          assert.deepEqual(server.commands, []);
        }).pipe(Effect.provide(TestConsole.layer)),
      ),
    );
  }

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
  for (const input of [
    "https://user:password@fixture.invalid",
    "http://fixture.invalid",
    "https://fixture.invalid/path",
    "https://fixture.invalid/?token=secret",
    "https://fixture.invalid/#secret",
    "not a URL",
  ]) {
    it.effect(`rejects unsafe server input ${input}`, () =>
      Effect.gen(function* () {
        const error = yield* validateServerOrigin(input).pipe(Effect.flip);
        assert.equal(error.code, "invalid_server");
        assert.notInclude(encodeTestJson(error), "secret");
      }),
    );
  }
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
  for (const credential of ["", "embedded whitespace", "x".repeat(9000)]) {
    it.effect(
      `rejects malformed credential of length ${credential.length} without exposing it`,
      () =>
        withFiles(
          ({ fd }) =>
            Effect.gen(function* () {
              const error = yield* readCredential(fd).pipe(Effect.flip);
              assert.equal(error.code, "credential_input");
            }),
          credential,
        ),
    );
  }
});

describe("exact turn wait", () => {
  const latestTurn = {
    turnId,
    userMessageId: MessageId.make("user-fixture"),
    state: "completed",
    requestedAt: stamp,
    startedAt: stamp,
    completedAt: stamp,
    assistantMessageId: MessageId.make("assistant-fixture"),
  } satisfies OrchestrationLatestTurn;
  const detail = decodeDetail({
    snapshotSequence: 1,
    thread: {
      ...shell.threads[0],
      deletedAt: null,
      latestTurn,
      messages: [
        {
          id: "assistant-fixture",
          role: "assistant",
          text: "Fixture result",
          turnId,
          streaming: false,
          createdAt: stamp,
          updatedAt: stamp,
        },
        {
          id: "private-old-message",
          role: "assistant",
          text: "Unrelated older history",
          turnId: "old-turn",
          streaming: false,
          createdAt: stamp,
          updatedAt: stamp,
        },
      ],
      activities: [],
      checkpoints: [],
    },
  });
  it.effect("reads only the selected thread and returns output for the latest turn", () =>
    withFiles(({ fd }) =>
      Effect.gen(function* () {
        const server = fixture({ detail });
        yield* runCli(["thread", "status", threadId, "--project", projectId], server, fd);
        const output = String(yield* TestConsole.logLines);
        assert.include(output, "Fixture result");
        assert.notInclude(output, "Unrelated older history");
        assert.deepEqual(server.commands, []);
      }).pipe(Effect.provide(TestConsole.layer)),
    ),
  );

  it.effect("wait command returns the exact completed turn without mutating the server", () =>
    withFiles(({ fd }) =>
      Effect.gen(function* () {
        const server = fixture({ detail });
        yield* runCli(
          ["thread", "wait", threadId, "--project", projectId, "--turn-id", turnId],
          server,
          fd,
        );
        assert.include(String(yield* TestConsole.logLines), '"waitState":"completed"');
        assert.deepEqual(server.commands, []);
      }).pipe(Effect.provide(TestConsole.layer)),
    ),
  );

  const status: ThreadStatus = {
    ok: true,
    environmentId,
    snapshotSequence: 1,
    requestedMessageId: null,
    requestState: "latest_turn",
    id: threadId,
    projectId,
    title: "Fixture",
    workspace: "/fixture/project",
    worktreePath: null,
    branch: null,
    runtimeMode: "approval-required",
    interactionMode: "default",
    modelSelection: detail.thread.modelSelection,
    latestTurn: detail.thread.latestTurn,
    sessionStatus: "ready",
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    backgroundLiveness: null,
    archivedAt: null,
    result: [{ id: MessageId.make("assistant-fixture"), text: "Fixture result", streaming: false }],
  };

  it.effect("does not confuse an earlier completed turn with the requested turn", () =>
    Effect.gen(function* () {
      const error = yield* waitForTurn(
        () => Effect.succeed(status),
        { type: "turn", id: TurnId.make("another-turn") },
        Effect.void,
      ).pipe(Effect.flip);
      assert.equal(error.code, "turn_mismatch");
    }),
  );

  it.effect("keeps following running and native background work until completion", () =>
    Effect.gen(function* () {
      const running: ThreadStatus = {
        ...status,
        latestTurn: { ...latestTurn, state: "running", assistantMessageId: null },
      };
      const stages: ReadonlyArray<ThreadStatus> = [
        running,
        { ...status, backgroundLiveness: "working" },
        status,
      ];
      let reads = 0;
      const result = yield* waitForTurn(
        () => Effect.sync(() => stages[reads++] ?? status),
        { type: "turn", id: turnId },
        Effect.void,
      );
      assert.equal(reads, 3);
      assert.equal(result.waitState, "completed");
    }),
  );

  it.effect("stops for a pending decision instead of claiming success", () =>
    Effect.gen(function* () {
      const result = yield* waitForTurn(
        () => Effect.succeed({ ...status, hasPendingApprovals: true }),
        { type: "turn", id: turnId },
        Effect.void,
      );
      assert.equal(result.waitState, "needs_attention");
    }),
  );

  it.effect(
    "does not report the previous completed turn while a submitted message awaits start",
    () =>
      withFiles(({ fd }) =>
        Effect.gen(function* () {
          const server = fixture({ detail });
          yield* runCli(
            [
              "thread",
              "status",
              threadId,
              "--project",
              projectId,
              "--message-id",
              "new-user-message",
            ],
            server,
            fd,
          );
          const output = String(yield* TestConsole.logLines);
          assert.include(output, '"requestState":"awaiting_turn"');
          assert.include(output, '"latestTurn":null');
          assert.notInclude(output, "Fixture result");
        }).pipe(Effect.provide(TestConsole.layer)),
      ),
  );

  it.effect("waits for the matching message, including a delayed provider start", () =>
    Effect.gen(function* () {
      const messageId = MessageId.make("new-user-message");
      const awaiting: ThreadStatus = {
        ...status,
        requestedMessageId: messageId,
        requestState: "awaiting_turn",
        latestTurn: null,
        result: [],
      };
      const matching: ThreadStatus = {
        ...status,
        requestedMessageId: messageId,
        latestTurn: { ...latestTurn, userMessageId: messageId },
      };
      let reads = 0;
      const result = yield* waitForTurn(
        () => Effect.succeed(reads++ === 0 ? awaiting : matching),
        { type: "message", id: messageId },
        Effect.void,
      );
      assert.equal(reads, 2);
      assert.equal(result.waitState, "completed");
      assert.equal(result.latestTurn?.userMessageId, messageId);
    }),
  );

  it.effect("bounds waiting for a message that never starts", () =>
    Effect.gen(function* () {
      const messageId = MessageId.make("never-started");
      const awaiting: ThreadStatus = {
        ...status,
        requestedMessageId: messageId,
        requestState: "awaiting_turn",
        latestTurn: null,
        result: [],
      };
      const fiber = yield* waitForTurn(
        () => Effect.succeed(awaiting),
        { type: "message", id: messageId },
        Effect.sleep("1 second"),
      ).pipe(Effect.timeout("2 seconds"), Effect.forkChild);
      yield* TestClock.adjust("2 seconds");
      const error = yield* Fiber.join(fiber).pipe(Effect.flip);
      assert.equal(error._tag, "TimeoutError");
    }),
  );

  for (const state of ["error", "interrupted"] as const) {
    it.effect(`reports ${state} without treating it as completion`, () =>
      Effect.gen(function* () {
        const result = yield* waitForTurn(
          () => Effect.succeed({ ...status, latestTurn: { ...latestTurn, state } }),
          { type: "turn", id: turnId },
          Effect.void,
        );
        assert.equal(result.waitState, state);
      }),
    );
  }

  it.effect("requires exactly one wait target before making requests", () =>
    withFiles(({ fd }) =>
      Effect.gen(function* () {
        const server = fixture();
        yield* runCli(
          [
            "thread",
            "wait",
            threadId,
            "--project",
            projectId,
            "--turn-id",
            turnId,
            "--message-id",
            "fixture-user",
          ],
          server,
          fd,
        ).pipe(Effect.flip);
        assert.deepEqual(server.requests, []);
      }).pipe(Effect.provide(TestConsole.layer)),
    ),
  );

  it.effect("rejects mixed snapshot versions instead of using stale pending-decision flags", () =>
    withFiles(({ fd }) =>
      Effect.gen(function* () {
        const server = fixture({ detail: { ...detail, snapshotSequence: 2 } });
        yield* runCli(["thread", "status", threadId, "--project", projectId], server, fd).pipe(
          Effect.flip,
        );
        const output = String(yield* TestConsole.logLines);
        assert.include(output, "snapshot_changed");
        assert.notInclude(output, "Fixture result");
      }).pipe(Effect.provide(TestConsole.layer)),
    ),
  );

  it.effect("uses final background liveness even when the event sequence did not change", () =>
    withFiles(({ fd }) =>
      Effect.gen(function* () {
        const finalSnapshot = decodeShell({
          ...shell,
          threads: shell.threads.map((thread) => ({ ...thread, backgroundLiveness: "working" })),
        });
        const server = fixture({ detail, finalSnapshot });
        yield* runCli(["thread", "status", threadId, "--project", projectId], server, fd);
        assert.include(String(yield* TestConsole.logLines), '"backgroundLiveness":"working"');
        assert.equal(
          server.requests.filter((request) => request.path === "/api/orchestration/shell").length,
          2,
        );
      }).pipe(Effect.provide(TestConsole.layer)),
    ),
  );

  it.effect("wait rereads changed snapshots before deciding completion", () =>
    Effect.gen(function* () {
      let reads = 0;
      const result = yield* waitForTurn(
        () =>
          reads++ === 0
            ? Effect.fail(remoteError("snapshot_changed", "Fixture changed"))
            : Effect.succeed({ ...status, hasPendingUserInput: true }),
        { type: "turn", id: turnId },
        Effect.void,
      );
      assert.equal(reads, 2);
      assert.equal(result.waitState, "needs_attention");
    }),
  );

  it.effect("reports correlated provider start failure without returning an older result", () =>
    withFiles(({ fd }) =>
      Effect.gen(function* () {
        const server = fixture({
          detail: {
            ...detail,
            thread: {
              ...detail.thread,
              activities: [
                {
                  id: "failure",
                  kind: "provider.turn.start.failed",
                  tone: "error",
                  summary: "Fixture start failed",
                  payload: { requestId: "new-user-message" },
                  turnId: null,
                  createdAt: stamp,
                },
              ],
            },
          },
        });
        yield* runCli(
          ["thread", "wait", threadId, "--project", projectId, "--message-id", "new-user-message"],
          server,
          fd,
        );
        const output = String(yield* TestConsole.logLines);
        assert.include(output, '"waitState":"error"');
        assert.notInclude(output, "Fixture result");
      }).pipe(Effect.provide(TestConsole.layer)),
    ),
  );
});
