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
import * as DateTime from "effect/DateTime";
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

function editCommand(input: {
  readonly commandId: string;
  readonly messageId: string;
  readonly text: string;
  readonly expectedRevision: number;
}) {
  return {
    type: "thread.queued-message.edit" as const,
    commandId: CommandId.make(input.commandId),
    threadId: THREAD_ID,
    messageId: MessageId.make(input.messageId),
    expectedRevision: input.expectedRevision,
    text: input.text,
    createdAt: NOW,
  } satisfies OrchestrationCommand;
}

function dropCommand(input: {
  readonly commandId: string;
  readonly messageId: string;
  readonly expectedRevision: number;
  readonly createdAt?: string;
}) {
  return {
    type: "thread.queued-message.drop" as const,
    commandId: CommandId.make(input.commandId),
    threadId: THREAD_ID,
    messageId: MessageId.make(input.messageId),
    expectedRevision: input.expectedRevision,
    createdAt: input.createdAt ?? NOW,
  } satisfies OrchestrationCommand;
}

const decideOne = Effect.fn("decideOne")(function* (input: {
  readonly command: OrchestrationCommand;
  readonly readModel: OrchestrationReadModel;
}) {
  const decided = yield* decideOrchestrationCommand(input);
  const events = Array.isArray(decided) ? decided : [decided];
  let next = input.readModel;
  for (const [index, event] of events.entries()) {
    next = yield* projectEvent(next, withSequence(event, next.snapshotSequence + index + 1));
  }
  return { events, readModel: next };
});

it.layer(NodeServices.layer)("editing and dropping a queued message", (it) => {
  it.effect("edits the text in place without moving the message in the queue", () =>
    Effect.gen(function* () {
      const { events, readModel } = yield* decideOne({
        command: editCommand({
          commandId: "cmd-edit-a",
          messageId: "message-a",
          text: "the tests too",
          expectedRevision: 0,
        }),
        readModel: makeReadModel(makeQueuedThread()),
      });

      assert.deepStrictEqual(
        events.map((event) => event.type),
        ["thread.queued-message-edited"],
      );
      assert.deepStrictEqual(readModel.threads[0]?.queuedMessages, [
        {
          messageId: MessageId.make("message-a"),
          queuedTurnStart: { titleSeed: "A" },
          createdAt: "2026-01-01T00:00:01.000Z",
          revision: 1,
        },
        {
          messageId: MessageId.make("message-b"),
          queuedTurnStart: { titleSeed: "B" },
          createdAt: "2026-01-01T00:00:02.000Z",
          revision: 0,
        },
      ]);
      assert.strictEqual(readModel.threads[0]?.messages[0]?.text, "the tests too");
      assert.strictEqual(readModel.threads[0]?.messages[0]?.createdAt, "2026-01-01T00:00:01.000Z");
      assert.strictEqual(readModel.threads[0]?.latestUserMessageAt, "2026-01-01T00:00:02.000Z");
    }),
  );

  it.effect("still drains the edited message first when the thread goes idle", () =>
    Effect.gen(function* () {
      const edited = yield* decideOne({
        command: editCommand({
          commandId: "cmd-edit-then-drain",
          messageId: "message-a",
          text: "the tests too",
          expectedRevision: 0,
        }),
        readModel: makeReadModel(makeQueuedThread()),
      });
      const drained = yield* decideOne({
        command: sessionSetCommand("cmd-ready-after-edit", "ready"),
        readModel: edited.readModel,
      });

      assert.deepStrictEqual(
        drained.events.map((event) => event.type),
        ["thread.session-set", "thread.turn-start-requested"],
      );
      const turnStart = drained.events[1];
      assert.strictEqual(
        turnStart?.type === "thread.turn-start-requested" ? turnStart.payload.messageId : null,
        MessageId.make("message-a"),
      );
      assert.strictEqual(drained.readModel.threads[0]?.messages[0]?.text, "the tests too");
      assert.strictEqual(drained.readModel.threads[0]?.messages[0]?.queued, false);
    }),
  );

  it.effect("refuses an edit once the queued turn has started", () =>
    Effect.gen(function* () {
      const drained = yield* decideOne({
        command: sessionSetCommand("cmd-ready-before-edit", "ready"),
        readModel: makeReadModel(makeQueuedThread()),
      });
      const rejection = yield* decideOrchestrationCommand({
        command: editCommand({
          commandId: "cmd-edit-too-late",
          messageId: "message-a",
          text: "too late",
          expectedRevision: 0,
        }),
        readModel: drained.readModel,
      }).pipe(Effect.flip);

      assert.strictEqual(rejection._tag, "OrchestrationQueuedMessageUnavailableError");
      assert.strictEqual(
        rejection._tag === "OrchestrationQueuedMessageUnavailableError" ? rejection.reason : null,
        "already-sent",
      );
    }),
  );

  it.effect("refuses an edit that carries a revision another device already replaced", () =>
    Effect.gen(function* () {
      const edited = yield* decideOne({
        command: editCommand({
          commandId: "cmd-edit-first",
          messageId: "message-a",
          text: "from the desktop",
          expectedRevision: 0,
        }),
        readModel: makeReadModel(makeQueuedThread()),
      });
      const rejection = yield* decideOrchestrationCommand({
        command: editCommand({
          commandId: "cmd-edit-stale",
          messageId: "message-a",
          text: "from the phone",
          expectedRevision: 0,
        }),
        readModel: edited.readModel,
      }).pipe(Effect.flip);

      assert.strictEqual(
        rejection._tag === "OrchestrationQueuedMessageUnavailableError" ? rejection.reason : null,
        "stale-revision",
      );
      assert.strictEqual(edited.readModel.threads[0]?.messages[0]?.text, "from the desktop");
    }),
  );

  it.effect("refuses to drop a message the thread never queued", () =>
    Effect.gen(function* () {
      const rejection = yield* decideOrchestrationCommand({
        command: dropCommand({
          commandId: "cmd-drop-unknown",
          messageId: "message-never-sent",
          expectedRevision: 0,
        }),
        readModel: makeReadModel(makeQueuedThread()),
      }).pipe(Effect.flip);

      assert.strictEqual(
        rejection._tag === "OrchestrationQueuedMessageUnavailableError" ? rejection.reason : null,
        "not-queued",
      );
    }),
  );

  it.effect("drops the newest queued message and unblocks settle and snooze", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const queuedAt = DateTime.formatIso(now);
      const previousUserMessageAt = DateTime.formatIso(
        DateTime.makeUnsafe(DateTime.toEpochMillis(now) - 86_400_000),
      );
      const messageId = MessageId.make("message-just-queued");
      const initial = makeReadModel(
        makeQueuedThread({
          session: null,
          latestUserMessageAt: queuedAt,
          messages: [
            makeUserMessage("message-earlier", previousUserMessageAt, false),
            makeUserMessage(String(messageId), queuedAt),
          ],
          queuedMessages: [
            {
              messageId,
              queuedTurnStart: {},
              createdAt: queuedAt,
              revision: 0,
            },
          ],
        }),
      );

      const settleCommand = {
        type: "thread.settle" as const,
        commandId: CommandId.make("cmd-settle-before-drop"),
        threadId: THREAD_ID,
      } satisfies OrchestrationCommand;
      const snoozeCommand = {
        type: "thread.snooze" as const,
        commandId: CommandId.make("cmd-snooze-before-drop"),
        threadId: THREAD_ID,
        snoozedUntil: "2030-01-01T00:00:00.000Z",
      } satisfies OrchestrationCommand;

      const blockedSettle = yield* decideOrchestrationCommand({
        command: settleCommand,
        readModel: initial,
      }).pipe(Effect.flip);
      assert.strictEqual(blockedSettle._tag, "OrchestrationThreadSettleBlockedError");
      const blockedSnooze = yield* decideOrchestrationCommand({
        command: snoozeCommand,
        readModel: initial,
      }).pipe(Effect.flip);
      assert.strictEqual(blockedSnooze._tag, "OrchestrationCommandInvariantError");

      const dropped = yield* decideOne({
        command: dropCommand({
          commandId: "cmd-drop-newest",
          messageId: String(messageId),
          expectedRevision: 0,
          createdAt: queuedAt,
        }),
        readModel: initial,
      });
      assert.deepStrictEqual(
        dropped.events.map((event) => event.type),
        ["thread.queued-message-dropped"],
      );
      assert.deepStrictEqual(dropped.readModel.threads[0]?.queuedMessages, []);
      assert.deepStrictEqual(
        dropped.readModel.threads[0]?.messages.map((message) => message.id),
        [MessageId.make("message-earlier")],
      );
      assert.strictEqual(dropped.readModel.threads[0]?.latestUserMessageAt, previousUserMessageAt);

      const settled = yield* decideOne({
        command: { ...settleCommand, commandId: CommandId.make("cmd-settle-after-drop") },
        readModel: dropped.readModel,
      });
      assert.deepStrictEqual(
        settled.events.map((event) => event.type),
        ["thread.settled"],
      );
      const snoozed = yield* decideOne({
        command: { ...snoozeCommand, commandId: CommandId.make("cmd-snooze-after-drop") },
        readModel: dropped.readModel,
      });
      assert.deepStrictEqual(
        snoozed.events.map((event) => event.type),
        ["thread.snoozed"],
      );
    }),
  );
});
