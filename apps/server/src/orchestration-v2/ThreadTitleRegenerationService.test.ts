import { assert, describe, it, vi } from "@effect/vitest";
import {
  type ChatAttachment,
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TextGenerationError,
  type TicketTitlePolicy,
  type TicketProviderBindings,
  TicketProviderDriverKind,
  TicketProviderInstanceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TicketProviderRegistry from "../ticket/TicketProviderRegistry.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import type { ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as ThreadTitleRegeneration from "./ThreadTitleRegenerationService.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "./testkit/ProviderReplayHarness.ts";

const projectId = ProjectId.make("project:title-regeneration");
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.1-codex",
} as const;

const adapter = {
  instanceId: modelSelection.instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("provider execution is disabled in title regeneration tests"),
} as ProviderAdapterV2Shape;

function makeHarness(
  options: {
    readonly resolveTicket?: TicketProviderRegistry.TicketProviderRegistry["Service"]["resolve"];
    readonly projectFields?: () => Partial<ProjectStore.ProjectRow>;
    readonly settings?: Parameters<typeof ServerSettings.layerTest>[0];
    readonly generateTitle?: TextGeneration.TextGeneration["Service"]["generateThreadTitle"];
  } = {},
) {
  const database = SqlitePersistenceMemory;
  const registry = ProviderAdapterRegistry.makeLayer([adapter]);
  const orchestrator = makeOrchestratorV2ReplayLayerWithRegistry(
    { name: "thread-title-regeneration" },
    registry,
    { databaseLayer: database, runEffectWorker: false },
  );
  const threadManagement = ThreadManagement.layer.pipe(Layer.provide(orchestrator));
  const outbox = EffectOutbox.layer.pipe(Layer.provide(database));
  const generateThreadTitle = vi.fn(
    options.generateTitle ?? (() => Effect.succeed({ title: "Generated title" })),
  );
  const resolveTicket = vi.fn(
    options.resolveTicket ??
      (() =>
        Effect.succeed({
          title: "Fix login",
          identifier: "t3tools/t3code#42",
          project: "t3tools/t3code",
          provider: "GitHub",
        })),
  );
  const projectedProjects = Layer.mock(ProjectStore.ProjectStoreV2)({
    get: (requestedProjectId) =>
      Effect.succeed(
        requestedProjectId === projectId
          ? Option.some({
              projectId,
              title: "Project",
              workspaceRoot: "/repo",
              defaultModelSelection: modelSelection,
              defaultThreadEnvMode: null,
              autoPull: false,
              faviconPath: null,
              projectIcon: null,
              scripts: [],
              createdAt: "2026-06-20T00:00:00.000Z",
              updatedAt: "2026-06-20T00:00:00.000Z",
              deletedAt: null,
              ...options.projectFields?.(),
            })
          : Option.none(),
      ),
  });
  const settings = ServerSettings.layerTest(options.settings);
  const titleRegeneration = ThreadTitleRegeneration.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        threadManagement,
        projectedProjects,
        Layer.mock(TextGeneration.TextGeneration)({ generateThreadTitle }),
        settings,
        Layer.mock(TicketProviderRegistry.TicketProviderRegistry)({ resolve: resolveTicket }),
      ),
    ),
  );
  return {
    layer: Layer.mergeAll(threadManagement, titleRegeneration, outbox, database, settings),
    generateThreadTitle,
    resolveTicket,
  };
}

function createThread(input: { readonly command: string; readonly thread: string }) {
  return Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    const threadId = ThreadId.make(input.thread);
    yield* threads.dispatch({
      type: "thread.create",
      commandId: CommandId.make(input.command),
      threadId,
      projectId,
      title: "Seed title",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    return threadId;
  });
}

function dispatchUserMessage(input: {
  readonly command: string;
  readonly threadId: ThreadId;
  readonly text: string;
}) {
  return Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    yield* threads.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(input.command),
      threadId: input.threadId,
      messageId: MessageId.make(`${input.command}:message`),
      text: input.text,
      attachments: [],
      modelSelection,
      dispatchMode: { type: "defer_start" },
      createdBy: "user",
      creationSource: "web",
    });
  });
}

function armRegeneration(input: { readonly command: string; readonly threadId: ThreadId }) {
  return Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    const requestId = CommandId.make(input.command);
    yield* threads.dispatch({
      type: "thread.metadata.update",
      commandId: requestId,
      threadId: input.threadId,
      regenerateTitle: true,
    });
    return requestId;
  });
}

describe("formatThreadTitleContext", () => {
  const attachment = (id: string): ChatAttachment => ({
    type: "image",
    id,
    name: `${id}.png`,
    mimeType: "image/png",
    sizeBytes: 1,
  });

  it("builds a newest-first digest, skipping system messages and empty sections", () => {
    const context = ThreadTitleRegeneration.formatThreadTitleContext([
      { role: "user", text: "First question" },
      { role: "system", text: "Hidden instructions" },
      { role: "assistant", text: "" },
      { role: "assistant", text: "Second answer", attachments: [attachment("shot")] },
    ]);
    assert.equal(
      context.message,
      "USER:\nFirst question\n\nASSISTANT:\nSecond answer\n[Attachments: shot.png]",
    );
    assert.deepEqual(
      context.attachments.map((entry) => entry.name),
      ["shot.png"],
    );
  });

  it("pins the first user message ahead of the retained tail once content stops fitting", () => {
    const context = ThreadTitleRegeneration.formatThreadTitleContext([
      { role: "user", text: `Ancient context that anchors the topic ${"x".repeat(600)}` },
      { role: "assistant", text: "y".repeat(6_000) },
      { role: "user", text: "z".repeat(1_500) },
    ]);
    assert.isTrue(context.message.includes("USER:\nAncient context that anchors the topic"));
    assert.isTrue(context.message.includes("[Earlier content truncated]\n\n"));
    assert.isTrue(context.message.includes("y".repeat(100)));
  });

  it("truncates an oversized pinned first user message", () => {
    const context = ThreadTitleRegeneration.formatThreadTitleContext([
      { role: "user", text: `Topic anchor ${"a".repeat(4_000)}` },
      { role: "assistant", text: "y".repeat(9_000) },
      { role: "user", text: "z".repeat(1_500) },
    ]);
    assert.isTrue(context.message.includes("USER:\nTopic anchor"));
    assert.isTrue(context.message.includes("[Content truncated]"));
    assert.isTrue(context.message.includes("[Earlier content truncated]\n\n"));
  });

  it("retains at most four attachments from the newest messages", () => {
    const context = ThreadTitleRegeneration.formatThreadTitleContext([
      { role: "user", text: "older", attachments: [attachment("a"), attachment("b")] },
      {
        role: "user",
        text: "newer",
        attachments: [attachment("c"), attachment("d"), attachment("e")],
      },
    ]);
    assert.deepEqual(
      context.attachments.map((entry) => entry.name),
      ["a.png", "c.png", "d.png", "e.png"],
    );
  });
});

describe("ThreadTitleRegenerationService", () => {
  it.effect("arms and clears the regeneration marker through metadata commands", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      yield* Effect.gen(function* () {
        const threads = yield* ThreadManagement.ThreadManagementService;
        const outbox = yield* EffectOutbox.EffectOutboxV2;
        const threadId = yield* createThread({
          command: "command:title:arm:create",
          thread: "thread:title:arm",
        });

        const firstRequest = yield* armRegeneration({ command: "command:title:arm:1", threadId });
        const armed = yield* threads.getThreadProjection(threadId);
        assert.equal(armed.thread.titleRegeneration?.requestId, firstRequest);
        assert.deepEqual(
          (yield* outbox.listByCommandId(firstRequest)).map((effect) => effect.request),
          [{ type: "thread-title.generate", kind: { type: "regenerate" } }],
        );

        yield* threads.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make("command:title:arm:abandon"),
          threadId,
          regenerateTitle: false,
        });
        const abandoned = yield* threads.getThreadProjection(threadId);
        assert.isNotOk(abandoned.thread.titleRegeneration);

        yield* armRegeneration({ command: "command:title:arm:2", threadId });
        yield* threads.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make("command:title:arm:rename"),
          threadId,
          title: "Manual title",
        });
        const renamed = yield* threads.getThreadProjection(threadId);
        assert.equal(renamed.thread.title, "Manual title");
        assert.isNotOk(renamed.thread.titleRegeneration);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("skips execution when the marker was superseded by a newer request", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      yield* Effect.gen(function* () {
        const threads = yield* ThreadManagement.ThreadManagementService;
        const titleRegeneration = yield* ThreadTitleRegeneration.ThreadTitleRegenerationService;
        const threadId = yield* createThread({
          command: "command:title:stale:create",
          thread: "thread:title:stale",
        });
        const staleRequest = yield* armRegeneration({ command: "command:title:stale:1", threadId });
        const currentRequest = yield* armRegeneration({
          command: "command:title:stale:2",
          threadId,
        });

        yield* titleRegeneration.execute({
          threadId,
          requestId: staleRequest,
          kind: { type: "regenerate" },
        });

        assert.equal(harness.generateThreadTitle.mock.calls.length, 0);
        const projection = yield* threads.getThreadProjection(threadId);
        assert.equal(projection.thread.title, "Seed title");
        assert.equal(projection.thread.titleRegeneration?.requestId, currentRequest);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("lands the regenerated title from the conversation digest", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        generateTitle: () => Effect.succeed({ title: "Fresh title" }),
      });
      yield* Effect.gen(function* () {
        const threads = yield* ThreadManagement.ThreadManagementService;
        const titleRegeneration = yield* ThreadTitleRegeneration.ThreadTitleRegenerationService;
        const threadId = yield* createThread({
          command: "command:title:landing:create",
          thread: "thread:title:landing",
        });
        yield* dispatchUserMessage({
          command: "command:title:landing:message",
          threadId,
          text: "Investigate the flaky login test",
        });
        const requestId = yield* armRegeneration({ command: "command:title:landing:1", threadId });

        yield* titleRegeneration.execute({ threadId, requestId, kind: { type: "regenerate" } });

        const call = harness.generateThreadTitle.mock.calls[0]?.[0];
        assert.equal(call?.previousTitle, "Seed title");
        assert.equal(call?.cwd, "/repo");
        assert.include(call?.message, "USER:\nInvestigate the flaky login test");
        const projection = yield* threads.getThreadProjection(threadId);
        assert.equal(projection.thread.title, "Fresh title");
        assert.isNotOk(projection.thread.titleRegeneration);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("keeps the current title when generation returns the fallback", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        generateTitle: () => Effect.succeed({ title: "New thread" }),
      });
      yield* Effect.gen(function* () {
        const threads = yield* ThreadManagement.ThreadManagementService;
        const titleRegeneration = yield* ThreadTitleRegeneration.ThreadTitleRegenerationService;
        const threadId = yield* createThread({
          command: "command:title:fallback:create",
          thread: "thread:title:fallback",
        });
        yield* dispatchUserMessage({
          command: "command:title:fallback:message",
          threadId,
          text: "Some conversation",
        });
        const requestId = yield* armRegeneration({ command: "command:title:fallback:1", threadId });

        yield* titleRegeneration.execute({ threadId, requestId, kind: { type: "regenerate" } });

        const projection = yield* threads.getThreadProjection(threadId);
        assert.equal(projection.thread.title, "Seed title");
        assert.isNotOk(projection.thread.titleRegeneration);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("keeps the current title when regeneration reproduces it", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        generateTitle: () => Effect.succeed({ title: "Seed title" }),
      });
      yield* Effect.gen(function* () {
        const threads = yield* ThreadManagement.ThreadManagementService;
        const titleRegeneration = yield* ThreadTitleRegeneration.ThreadTitleRegenerationService;
        const threadId = yield* createThread({
          command: "command:title:unchanged:create",
          thread: "thread:title:unchanged",
        });
        yield* dispatchUserMessage({
          command: "command:title:unchanged:message",
          threadId,
          text: "Some conversation",
        });
        const requestId = yield* armRegeneration({
          command: "command:title:unchanged:1",
          threadId,
        });

        yield* titleRegeneration.execute({ threadId, requestId, kind: { type: "regenerate" } });

        const projection = yield* threads.getThreadProjection(threadId);
        assert.equal(projection.thread.title, "Seed title");
        assert.isNotOk(projection.thread.titleRegeneration);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("clears the marker and keeps the title when generation fails", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        generateTitle: () => Effect.die(new Error("model unavailable")),
      });
      yield* Effect.gen(function* () {
        const threads = yield* ThreadManagement.ThreadManagementService;
        const titleRegeneration = yield* ThreadTitleRegeneration.ThreadTitleRegenerationService;
        const threadId = yield* createThread({
          command: "command:title:failure:create",
          thread: "thread:title:failure",
        });
        yield* dispatchUserMessage({
          command: "command:title:failure:message",
          threadId,
          text: "Some conversation",
        });
        const requestId = yield* armRegeneration({ command: "command:title:failure:1", threadId });

        yield* titleRegeneration.execute({ threadId, requestId, kind: { type: "regenerate" } });

        assert.equal(harness.generateThreadTitle.mock.calls.length, 1);
        const projection = yield* threads.getThreadProjection(threadId);
        assert.equal(projection.thread.title, "Seed title");
        assert.isNotOk(projection.thread.titleRegeneration);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("completes without generating when the initial message is unavailable", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      yield* Effect.gen(function* () {
        const threads = yield* ThreadManagement.ThreadManagementService;
        const titleRegeneration = yield* ThreadTitleRegeneration.ThreadTitleRegenerationService;
        const threadId = yield* createThread({
          command: "command:title:missing:create",
          thread: "thread:title:missing",
        });
        const requestId = yield* armRegeneration({ command: "command:title:missing:1", threadId });

        yield* titleRegeneration.execute({
          threadId,
          requestId,
          kind: { type: "initial", messageId: MessageId.make("message:title:missing") },
        });

        assert.equal(harness.generateThreadTitle.mock.calls.length, 0);
        const projection = yield* threads.getThreadProjection(threadId);
        assert.equal(projection.thread.title, "Seed title");
        assert.isNotOk(projection.thread.titleRegeneration);
      }).pipe(Effect.provide(harness.layer));
    }),
  );
});

for (const outcome of ["success", "exhausted", "stale", "interrupted"] as const) {
  it.effect(`initial title retry: ${outcome}`, () =>
    Effect.gen(function* () {
      const attempted = yield* Deferred.make<void>();
      let attempts = 0;
      const harness = makeHarness({
        generateTitle: () =>
          Effect.gen(function* () {
            attempts += 1;
            yield* Deferred.succeed(attempted, undefined);
            if (outcome === "success" && attempts === 3) return { title: "Recovered title" };
            return yield* new TextGenerationError({
              operation: "generateThreadTitle",
              detail: "Temporary failure",
            });
          }),
      });
      yield* Effect.gen(function* () {
        const threads = yield* ThreadManagement.ThreadManagementService;
        const service = yield* ThreadTitleRegeneration.ThreadTitleRegenerationService;
        const threadId = yield* createThread({
          command: `create:${outcome}`,
          thread: `thread:${outcome}`,
        });
        const messageCommand = `message:${outcome}`;
        yield* dispatchUserMessage({ command: messageCommand, threadId, text: "Fix the title" });
        const requestId = yield* armRegeneration({ command: `title:${outcome}`, threadId });
        const fiber = yield* service
          .execute({
            threadId,
            requestId,
            kind: { type: "initial", messageId: MessageId.make(`${messageCommand}:message`) },
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(attempted);
        if (outcome === "interrupted") {
          yield* Fiber.interrupt(fiber);
        } else {
          if (outcome === "stale")
            yield* threads.dispatch({
              type: "thread.metadata.update",
              commandId: CommandId.make("manual-title"),
              threadId,
              title: "Manual title",
            });
          yield* TestClock.adjust("2 seconds");
          if (outcome !== "stale") yield* TestClock.adjust("4 seconds");
          yield* Fiber.join(fiber);
        }
        assert.equal(attempts, outcome === "success" || outcome === "exhausted" ? 3 : 1);
        const projection = yield* threads.getThreadProjection(threadId);
        assert.equal(
          projection.thread.title,
          outcome === "success"
            ? "Recovered title"
            : outcome === "stale"
              ? "Manual title"
              : "Seed title",
        );
        if (outcome === "interrupted")
          assert.equal(projection.thread.titleRegeneration?.requestId, requestId);
        else assert.isNotOk(projection.thread.titleRegeneration);
      }).pipe(Effect.provide(harness.layer));
    }),
  );
}

const ticketBindings: TicketProviderBindings = [
  {
    driver: TicketProviderDriverKind.make("github"),
    host: "github.com",
    instanceId: TicketProviderInstanceId.make("github_work"),
  },
];
const ticketSettings = {
  ticketTitlePolicy: { mode: "title" as const },
  ticketProviderInstances: {
    github_work: {
      driver: "github",
      baseUrl: "https://github.com",
    },
  },
};
const ticketMessage = "Fix https://github.com/t3tools/t3code/issues/42";

for (const scenario of [
  "project-policy",
  "global-policy",
  "disabled",
  "ambiguous",
  "failed",
  "invalid-template",
  "regenerate",
] as const) {
  it.effect(`ticket title: ${scenario}`, () =>
    Effect.gen(function* () {
      const policy: TicketTitlePolicy | null =
        scenario === "global-policy"
          ? null
          : {
              mode: scenario === "disabled" ? "disabled" : "custom",
              customTemplate:
                scenario === "invalid-template" ? "{unsupported}" : "{provider}: {title}",
            };
      const harness = makeHarness({
        settings: ticketSettings,
        projectFields: () => ({
          ticketTitlePolicy: policy,
          ticketProviderBindings: ticketBindings,
        }),
        ...(scenario === "failed"
          ? {
              resolveTicket: () =>
                Effect.fail(
                  new TicketProviderRegistry.TicketProviderResolveError({
                    driver: "github",
                    reason: "request-failed",
                  }),
                ),
            }
          : {}),
      });
      yield* Effect.gen(function* () {
        const threads = yield* ThreadManagement.ThreadManagementService;
        const service = yield* ThreadTitleRegeneration.ThreadTitleRegenerationService;
        const threadId = yield* createThread({
          command: `create:ticket:${scenario}`,
          thread: `thread:ticket:${scenario}`,
        });
        const messageCommand = `message:ticket:${scenario}`;
        yield* dispatchUserMessage({
          command: messageCommand,
          threadId,
          text:
            scenario === "ambiguous"
              ? `${ticketMessage} and https://github.com/t3tools/t3code/issues/43`
              : ticketMessage,
        });
        const requestId = yield* armRegeneration({ command: `title:ticket:${scenario}`, threadId });
        yield* service.execute({
          threadId,
          requestId,
          kind:
            scenario === "regenerate"
              ? { type: "regenerate" }
              : { type: "initial", messageId: MessageId.make(`${messageCommand}:message`) },
        });
        const successfulTicket = scenario === "project-policy" || scenario === "global-policy";
        const projection = yield* threads.getThreadProjection(threadId);
        assert.equal(
          projection.thread.title,
          successfulTicket
            ? scenario === "project-policy"
              ? "GitHub: Fix login"
              : "Fix login"
            : "Generated title",
        );
        assert.isNotOk(projection.thread.titleRegeneration);
        assert.equal(harness.generateThreadTitle.mock.calls.length, successfulTicket ? 0 : 1);
        const attemptedTicket =
          successfulTicket || scenario === "failed" || scenario === "invalid-template";
        assert.equal(harness.resolveTicket.mock.calls.length, attemptedTicket ? 1 : 0);
        if (attemptedTicket) {
          const input = harness.resolveTicket.mock.calls[0]?.[0];
          assert.equal(input?.cwd, "/repo");
          assert.deepEqual(input?.bindings, ticketBindings);
          assert.equal(
            input?.instances[TicketProviderInstanceId.make("github_work")]?.baseUrl,
            "https://github.com",
          );
          assert.equal(input?.reference.resourceId, "42");
        }
      }).pipe(Effect.provide(harness.layer));
    }),
  );
}

for (const scenario of [
  "manual-title",
  "failed-manual-title",
  "new-request",
  "failed-new-request",
  "disabled-policy",
  "changed-bindings",
  "changed-instances",
  "stale-before-lookup",
  "interrupted",
] as const) {
  it.effect(`ticket title race: ${scenario}`, () =>
    Effect.gen(function* () {
      const lookupStarted = yield* Deferred.make<void>();
      const lookupReady = yield* Deferred.make<void>();
      let policy: TicketTitlePolicy = { mode: "title", customTemplate: "{title}" };
      let bindings = ticketBindings;
      const harness = makeHarness({
        settings: ticketSettings,
        projectFields: () => ({ ticketTitlePolicy: policy, ticketProviderBindings: bindings }),
        resolveTicket: () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(lookupStarted, undefined);
            yield* Deferred.await(lookupReady);
            if (scenario === "failed-manual-title" || scenario === "failed-new-request") {
              return yield* new TicketProviderRegistry.TicketProviderResolveError({
                driver: "github",
                reason: "request-failed",
              });
            }
            return {
              title: "Fix login",
              identifier: "#42",
              provider: "GitHub",
              project: "T3 Code",
            };
          }),
      });
      yield* Effect.gen(function* () {
        const threads = yield* ThreadManagement.ThreadManagementService;
        const service = yield* ThreadTitleRegeneration.ThreadTitleRegenerationService;
        const threadId = yield* createThread({
          command: `create:ticket-race:${scenario}`,
          thread: `thread:ticket-race:${scenario}`,
        });
        const messageCommand = `message:ticket-race:${scenario}`;
        yield* dispatchUserMessage({ command: messageCommand, threadId, text: ticketMessage });
        const requestId = yield* armRegeneration({
          command: `title:ticket-race:${scenario}`,
          threadId,
        });
        const rename = () =>
          threads.dispatch({
            type: "thread.metadata.update",
            commandId: CommandId.make(`manual:ticket-race:${scenario}`),
            threadId,
            title: "Seed title",
          });
        if (scenario === "stale-before-lookup") yield* rename();
        const fiber = yield* service
          .execute({
            threadId,
            requestId,
            kind: { type: "initial", messageId: MessageId.make(`${messageCommand}:message`) },
          })
          .pipe(Effect.forkChild);
        let currentRequest = requestId;
        if (scenario !== "stale-before-lookup") {
          yield* Deferred.await(lookupStarted);
          if (scenario === "manual-title" || scenario === "failed-manual-title") yield* rename();
          if (scenario === "new-request" || scenario === "failed-new-request")
            currentRequest = yield* armRegeneration({
              command: "title:ticket-race:newer",
              threadId,
            });
          if (scenario === "disabled-policy") policy = { ...policy, mode: "disabled" };
          if (scenario === "changed-bindings") bindings = [];
          if (scenario === "changed-instances") {
            const settings = yield* ServerSettings.ServerSettingsService;
            yield* settings.updateSettings({ ticketProviderInstances: {} });
          }
          if (scenario === "interrupted") yield* Fiber.interrupt(fiber);
          else yield* Deferred.succeed(lookupReady, undefined);
        }
        if (scenario !== "interrupted") yield* Fiber.join(fiber);
        const shouldGenerate =
          scenario === "disabled-policy" ||
          scenario === "changed-bindings" ||
          scenario === "changed-instances";
        const projection = yield* threads.getThreadProjection(threadId);
        assert.equal(projection.thread.title, shouldGenerate ? "Generated title" : "Seed title");
        assert.equal(harness.generateThreadTitle.mock.calls.length, shouldGenerate ? 1 : 0);
        assert.equal(
          harness.resolveTicket.mock.calls.length,
          scenario === "stale-before-lookup" ? 0 : 1,
        );
        if (
          scenario === "new-request" ||
          scenario === "failed-new-request" ||
          scenario === "interrupted"
        )
          assert.equal(projection.thread.titleRegeneration?.requestId, currentRequest);
        else assert.isNotOk(projection.thread.titleRegeneration);
      }).pipe(Effect.provide(harness.layer));
    }),
  );
}
