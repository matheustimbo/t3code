import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type OrchestrationSession,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { projectEvent } from "./projector.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const THREAD_ID = ThreadId.make("thread-1");
const PROJECT_ID = ProjectId.make("project-1");
const MODEL_SELECTION = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5-codex",
};

function makeSession(status: OrchestrationSession["status"]): OrchestrationSession {
  return {
    threadId: THREAD_ID,
    status,
    providerName: "codex",
    providerInstanceId: ProviderInstanceId.make("codex"),
    runtimeMode: "full-access",
    activeTurnId: null,
    lastError: null,
    updatedAt: NOW,
  };
}

function makeThread(overrides: Partial<OrchestrationThread> = {}): OrchestrationThread {
  return {
    id: THREAD_ID,
    projectId: PROJECT_ID,
    title: "Thread",
    titleRevision: 0,
    modelSelection: MODEL_SELECTION,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    pullRequests: [],
    branchPullRequest: null,
    latestTurn: null,
    latestUserMessageAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    unsettledAt: null,
    activeOrderKey: null,
    snoozedUntil: null,
    snoozedAt: null,
    deletedAt: null,
    messages: [],
    queuedMessages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
    ...overrides,
  };
}

function makeReadModel(thread: OrchestrationThread): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    threads: [thread],
    updatedAt: NOW,
  };
}

function makeUserMessage(messageId: string, createdAt: string, queued = true) {
  return {
    id: MessageId.make(messageId),
    role: "user" as const,
    text: messageId,
    turnId: null,
    streaming: false,
    ...(queued ? { queued: true } : {}),
    createdAt,
    updatedAt: createdAt,
  };
}

function makeQueuedThread(overrides: Partial<OrchestrationThread> = {}): OrchestrationThread {
  const firstCreatedAt = "2026-01-01T00:00:01.000Z";
  const secondCreatedAt = "2026-01-01T00:00:02.000Z";
  const firstMessageId = MessageId.make("message-a");
  const secondMessageId = MessageId.make("message-b");
  return makeThread({
    session: makeSession("running"),
    latestUserMessageAt: secondCreatedAt,
    messages: [
      makeUserMessage(String(firstMessageId), firstCreatedAt),
      makeUserMessage(String(secondMessageId), secondCreatedAt),
    ],
    queuedMessages: [
      {
        messageId: firstMessageId,
        queuedTurnStart: { titleSeed: "A" },
        createdAt: firstCreatedAt,
        revision: 0,
      },
      {
        messageId: secondMessageId,
        queuedTurnStart: { titleSeed: "B" },
        createdAt: secondCreatedAt,
        revision: 0,
      },
    ],
    ...overrides,
  });
}

function turnStartCommand(input: {
  readonly commandId: string;
  readonly messageId: string;
  readonly text?: string;
  readonly delivery?: "now" | "queued";
}) {
  return {
    type: "thread.turn.start" as const,
    commandId: CommandId.make(input.commandId),
    threadId: THREAD_ID,
    message: {
      messageId: MessageId.make(input.messageId),
      role: "user" as const,
      text: input.text ?? input.messageId,
      attachments: [],
    },
    runtimeMode: "full-access" as const,
    interactionMode: "default" as const,
    ...(input.delivery !== undefined ? { delivery: input.delivery } : {}),
    createdAt: NOW,
  } satisfies Extract<OrchestrationCommand, { type: "thread.turn.start" }>;
}

function sessionSetCommand(commandId: string, status: OrchestrationSession["status"]) {
  return {
    type: "thread.session.set" as const,
    commandId: CommandId.make(commandId),
    threadId: THREAD_ID,
    session: makeSession(status),
    createdAt: NOW,
  } satisfies OrchestrationCommand;
}

function withSequence(
  event: Omit<OrchestrationEvent, "sequence">,
  sequence: number,
): OrchestrationEvent {
  return { ...event, sequence } as OrchestrationEvent;
}

it.layer(NodeServices.layer)("queued turn starts", (it) => {
  it.effect("queues a delivery while the provider session is running", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: turnStartCommand({
          commandId: "cmd-queue-running",
          messageId: "message-queue-running",
          delivery: "queued",
        }),
        readModel: makeReadModel(makeThread({ session: makeSession("running") })),
      });
      const events = Array.isArray(result) ? result : [result];

      assert.deepStrictEqual(
        events.map((event) => event.type),
        ["thread.message-sent"],
      );
      const messageSent = events[0];
      if (messageSent?.type !== "thread.message-sent") {
        return;
      }
      assert.deepStrictEqual(messageSent.payload.queuedTurnStart, {});
      assert.strictEqual(messageSent.payload.messageId, MessageId.make("message-queue-running"));
    }),
  );

  it.effect("drains one queued message per idle transition in FIFO order", () =>
    Effect.gen(function* () {
      const initial = makeReadModel(makeQueuedThread());
      const firstResult = yield* decideOrchestrationCommand({
        command: sessionSetCommand("cmd-ready-a", "ready"),
        readModel: initial,
      });
      const firstEvents = Array.isArray(firstResult) ? firstResult : [firstResult];
      assert.deepStrictEqual(
        firstEvents.map((event) => event.type),
        ["thread.session-set", "thread.turn-start-requested"],
      );
      const firstTurnStart = firstEvents[1];
      if (firstTurnStart?.type !== "thread.turn-start-requested") {
        return;
      }
      assert.strictEqual(firstTurnStart.payload.messageId, MessageId.make("message-a"));

      let afterFirst = initial;
      for (const [index, event] of firstEvents.entries()) {
        afterFirst = yield* projectEvent(afterFirst, withSequence(event, index + 1));
      }
      assert.deepStrictEqual(
        afterFirst.threads[0]?.queuedMessages?.map((message) => message.messageId),
        [MessageId.make("message-b")],
      );

      const secondResult = yield* decideOrchestrationCommand({
        command: sessionSetCommand("cmd-ready-b", "ready"),
        readModel: afterFirst,
      });
      const secondEvents = Array.isArray(secondResult) ? secondResult : [secondResult];
      assert.deepStrictEqual(
        secondEvents.map((event) => event.type),
        ["thread.session-set", "thread.turn-start-requested"],
      );
      const secondTurnStart = secondEvents[1];
      if (secondTurnStart?.type === "thread.turn-start-requested") {
        assert.strictEqual(secondTurnStart.payload.messageId, MessageId.make("message-b"));
      }
    }),
  );

  it.effect("silently upgrades queued delivery when the thread is idle", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: turnStartCommand({
          commandId: "cmd-queue-idle",
          messageId: "message-queue-idle",
          delivery: "queued",
        }),
        readModel: makeReadModel(makeThread()),
      });
      const events = Array.isArray(result) ? result : [result];

      assert.deepStrictEqual(
        events.map((event) => event.type),
        ["thread.message-sent", "thread.turn-start-requested"],
      );
      if (events[0]?.type === "thread.message-sent") {
        assert.strictEqual(events[0].payload.queuedTurnStart, undefined);
      }
    }),
  );

  it.effect.each(["interrupted", "error", "stopped"] as const)(
    "%s session transition handles the durable queue",
    (status) =>
      Effect.gen(function* () {
        const result = yield* decideOrchestrationCommand({
          command: sessionSetCommand(`cmd-${status}`, status),
          readModel: makeReadModel(makeQueuedThread()),
        });
        const events = Array.isArray(result) ? result : [result];
        assert.deepStrictEqual(
          events.map((event) => event.type),
          status === "interrupted"
            ? ["thread.session-set", "thread.turn-start-requested"]
            : ["thread.session-set"],
        );
        if (status === "interrupted" && events[1]?.type === "thread.turn-start-requested") {
          assert.strictEqual(events[1].payload.messageId, MessageId.make("message-a"));
        }
      }),
  );

  it.effect("keeps manual settle and snooze available for a queued message", () =>
    Effect.gen(function* () {
      const thread = makeQueuedThread({
        latestUserMessageAt: "1969-12-31T00:00:00.000Z",
        session: null,
      });
      const settled = yield* decideOrchestrationCommand({
        command: {
          type: "thread.settle",
          commandId: CommandId.make("cmd-settle-with-queue"),
          threadId: THREAD_ID,
        },
        readModel: makeReadModel(thread),
      });
      assert.strictEqual((Array.isArray(settled) ? settled : [settled])[0]?.type, "thread.settled");

      const snoozed = yield* decideOrchestrationCommand({
        command: {
          type: "thread.snooze",
          commandId: CommandId.make("cmd-snooze-with-queue"),
          threadId: THREAD_ID,
          snoozedUntil: "1970-01-02T09:00:00.000Z",
        },
        readModel: makeReadModel(thread),
      });
      assert.strictEqual((Array.isArray(snoozed) ? snoozed : [snoozed])[0]?.type, "thread.snoozed");
    }),
  );

  it.effect("re-emits requeue events without duplicating the queue entry", () =>
    Effect.gen(function* () {
      const messageId = MessageId.make("message-requeue");
      const initial = makeReadModel(
        makeThread({
          messages: [makeUserMessage(String(messageId), NOW, false)],
        }),
      );
      const command = {
        type: "thread.message.requeue" as const,
        commandId: CommandId.make("cmd-requeue-one"),
        threadId: THREAD_ID,
        messageId,
        queuedTurnStart: { titleSeed: "first" },
        createdAt: NOW,
      } satisfies OrchestrationCommand;
      const firstResult = yield* decideOrchestrationCommand({
        command,
        readModel: initial,
      });
      const firstEvent = Array.isArray(firstResult) ? firstResult[0] : firstResult;
      if (firstEvent === undefined) {
        return;
      }
      const afterFirst = yield* projectEvent(initial, withSequence(firstEvent, 1));
      const secondResult = yield* decideOrchestrationCommand({
        command: {
          ...command,
          commandId: CommandId.make("cmd-requeue-two"),
          queuedTurnStart: { titleSeed: "second" },
        },
        readModel: afterFirst,
      });
      const secondEvent = Array.isArray(secondResult) ? secondResult[0] : secondResult;
      if (secondEvent === undefined) {
        return;
      }
      const afterSecond = yield* projectEvent(afterFirst, withSequence(secondEvent, 2));
      assert.deepStrictEqual(afterSecond.threads[0]?.queuedMessages, [
        {
          messageId,
          queuedTurnStart: { titleSeed: "first" },
          createdAt: NOW,
          revision: 0,
        },
      ]);
      assert.strictEqual(afterSecond.threads[0]?.messages[0]?.queued, true);
    }),
  );
});
