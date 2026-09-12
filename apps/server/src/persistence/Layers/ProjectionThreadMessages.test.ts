import { MessageId, ThreadId, TurnId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ProjectionThreadMessageRepository } from "../Services/ProjectionThreadMessages.ts";
import { ProjectionThreadMessageRepositoryLive } from "./ProjectionThreadMessages.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  ProjectionThreadMessageRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("ProjectionThreadMessageRepository", (it) => {
  it.effect("finds the latest live user-message time within one thread", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadMessageRepository;
      const threadId = ThreadId.make("thread-latest-user-message");
      assert.isNull(yield* repository.getLatestUserMessageAt({ threadId }));

      yield* repository.upsert({
        messageId: MessageId.make("import:codex:latest-user-message:000000"),
        threadId,
        turnId: null,
        role: "user",
        text: "Imported prompt",
        queuedTurnStart: null,
        queuedRevision: 0,
        isStreaming: false,
        createdAt: "2026-02-28T19:05:06.000Z",
        updatedAt: "2026-02-28T19:05:06.000Z",
      });
      assert.isNull(yield* repository.getLatestUserMessageAt({ threadId }));

      const messages = [
        { role: "user", createdAt: "2026-02-28T19:05:02.000Z" },
        { role: "user", createdAt: "2026-02-28T19:05:01.000Z" },
        { role: "assistant", createdAt: "2026-02-28T19:05:03.000Z" },
        { role: "system", createdAt: "2026-02-28T19:05:04.000Z" },
      ] as const;
      for (const [index, message] of messages.entries()) {
        yield* repository.upsert({
          messageId: MessageId.make(`latest-user-message-${index}`),
          threadId,
          turnId: null,
          ...message,
          text: "Message body",
          queuedTurnStart: null,
          queuedRevision: 0,
          isStreaming: false,
          updatedAt: "2026-02-28T19:06:00.000Z",
        });
      }
      yield* repository.upsert({
        messageId: MessageId.make("latest-user-message-other-thread"),
        threadId: ThreadId.make("thread-latest-user-message-other"),
        turnId: null,
        role: "user",
        text: "Other thread",
        queuedTurnStart: null,
        queuedRevision: 0,
        isStreaming: false,
        createdAt: "2026-02-28T19:05:05.000Z",
        updatedAt: "2026-02-28T19:05:05.000Z",
      });

      assert.strictEqual(
        yield* repository.getLatestUserMessageAt({ threadId }),
        "2026-02-28T19:05:02.000Z",
      );
      yield* repository.deleteByThreadId({ threadId });
      assert.isNull(yield* repository.getLatestUserMessageAt({ threadId }));
    }),
  );

  it.effect("appends streaming text and applies attachment updates", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadMessageRepository;
      const threadId = ThreadId.make("thread-streaming-append");
      const messageId = MessageId.make("message-streaming-append");
      const createdAt = "2026-02-28T19:05:00.000Z";
      const attachments = [
        {
          type: "image" as const,
          id: "thread-streaming-append-att-1",
          name: "example.png",
          mimeType: "image/png",
          sizeBytes: 5,
        },
      ];

      yield* repository.appendStreaming({
        messageId,
        threadId,
        turnId: null,
        role: "assistant",
        text: "hello",
        attachments,
        queuedTurnStart: null,
        queuedRevision: 0,
        createdAt,
        updatedAt: createdAt,
      });
      yield* repository.appendStreaming({
        messageId,
        threadId,
        turnId: null,
        role: "assistant",
        text: " world",
        queuedTurnStart: null,
        queuedRevision: 0,
        createdAt: "2026-02-28T19:05:01.000Z",
        updatedAt: "2026-02-28T19:05:01.000Z",
      });

      const rowWithPreservedAttachments = yield* repository.getByMessageId({ messageId });
      assert.equal(rowWithPreservedAttachments._tag, "Some");
      if (rowWithPreservedAttachments._tag === "Some") {
        assert.deepEqual(rowWithPreservedAttachments.value.attachments, attachments);
      }

      yield* repository.appendStreaming({
        messageId,
        threadId,
        turnId: null,
        role: "assistant",
        text: "",
        attachments: [],
        queuedTurnStart: null,
        queuedRevision: 0,
        createdAt: "2026-02-28T19:05:02.000Z",
        updatedAt: "2026-02-28T19:05:02.000Z",
      });

      const row = yield* repository.getByMessageId({ messageId });
      assert.equal(row._tag, "Some");
      if (row._tag === "Some") {
        assert.equal(row.value.text, "hello world");
        assert.deepEqual(row.value.attachments, []);
        assert.equal(row.value.createdAt, createdAt);
        assert.equal(row.value.updatedAt, "2026-02-28T19:05:02.000Z");
        assert.isTrue(row.value.isStreaming);
      }
    }),
  );

  it.effect("preserves existing attachments when upsert omits attachments", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadMessageRepository;
      const threadId = ThreadId.make("thread-preserve-attachments");
      const messageId = MessageId.make("message-preserve-attachments");
      const createdAt = "2026-02-28T19:00:00.000Z";
      const updatedAt = "2026-02-28T19:00:01.000Z";
      const persistedAttachments = [
        {
          type: "image" as const,
          id: "thread-preserve-attachments-att-1",
          name: "example.png",
          mimeType: "image/png",
          sizeBytes: 5,
        },
      ];

      yield* repository.upsert({
        messageId,
        threadId,
        turnId: null,
        role: "user",
        text: "initial",
        attachments: persistedAttachments,
        queuedTurnStart: null,
        queuedRevision: 0,
        isStreaming: false,
        createdAt,
        updatedAt,
      });

      yield* repository.upsert({
        messageId,
        threadId,
        turnId: null,
        role: "user",
        text: "updated",
        queuedTurnStart: null,
        queuedRevision: 0,
        isStreaming: false,
        createdAt,
        updatedAt: "2026-02-28T19:00:02.000Z",
      });

      const rows = yield* repository.listByThreadId({ threadId });
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.text, "updated");
      assert.deepEqual(rows[0]?.attachments, persistedAttachments);

      const rowById = yield* repository.getByMessageId({ messageId });
      assert.equal(rowById._tag, "Some");
      if (rowById._tag === "Some") {
        assert.equal(rowById.value.text, "updated");
        assert.deepEqual(rowById.value.attachments, persistedAttachments);
      }
    }),
  );

  it.effect("orders queued messages by receipt row when timestamps tie", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadMessageRepository;
      const threadId = ThreadId.make("thread-queued-fifo");
      const createdAt = "2026-02-28T19:00:00.000Z";
      for (const messageId of ["queued-second", "queued-first"]) {
        yield* repository.upsert({
          messageId: MessageId.make(messageId),
          threadId,
          turnId: null,
          role: "user",
          text: messageId,
          queuedTurnStart: { titleSeed: messageId },
          queuedRevision: 0,
          isStreaming: false,
          createdAt,
          updatedAt: createdAt,
        });
      }

      const queued = yield* repository.listQueuedByThreadId({ threadId });
      assert.deepEqual(
        queued.map((message) => message.messageId),
        ["queued-second", "queued-first"],
      );
      assert.equal(yield* repository.countQueuedByThreadId({ threadId }), 2);
    }),
  );

  it.effect("deletes one queued message and preserves sibling FIFO order after edit", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadMessageRepository;
      const threadId = ThreadId.make("thread-queued-edit-delete");
      const messages = [
        ["queued-first", "2026-02-28T19:00:00.000Z"],
        ["queued-second", "2026-02-28T19:00:01.000Z"],
        ["queued-third", "2026-02-28T19:00:02.000Z"],
      ] as const;

      for (const [messageId, createdAt] of messages) {
        yield* repository.upsert({
          messageId: MessageId.make(messageId),
          threadId,
          turnId: null,
          role: "user",
          text: messageId,
          queuedTurnStart: { titleSeed: messageId },
          queuedRevision: 0,
          isStreaming: false,
          createdAt,
          updatedAt: createdAt,
        });
      }

      yield* repository.upsert({
        messageId: MessageId.make("queued-second"),
        threadId,
        turnId: null,
        role: "user",
        text: "edited queued-second",
        queuedTurnStart: { titleSeed: "queued-second" },
        queuedRevision: 1,
        isStreaming: false,
        createdAt: "2026-02-28T19:00:01.000Z",
        updatedAt: "2026-02-28T19:01:00.000Z",
      });

      const afterEdit = yield* repository.listQueuedByThreadId({ threadId });
      assert.deepEqual(
        afterEdit.map((message) => message.messageId),
        ["queued-first", "queued-second", "queued-third"],
      );
      assert.equal(afterEdit[1]?.text, "edited queued-second");
      assert.equal(afterEdit[1]?.createdAt, "2026-02-28T19:00:01.000Z");
      assert.equal(afterEdit[1]?.queuedRevision, 1);

      yield* repository.deleteByMessageId({ messageId: MessageId.make("queued-second") });

      const afterDelete = yield* repository.listQueuedByThreadId({ threadId });
      assert.deepEqual(
        afterDelete.map((message) => message.messageId),
        ["queued-first", "queued-third"],
      );
      assert.deepEqual(
        (yield* repository.listByThreadId({ threadId })).map((message) => message.messageId),
        ["queued-first", "queued-third"],
      );
      const deleted = yield* repository.getByMessageId({
        messageId: MessageId.make("queued-second"),
      });
      assert.equal(deleted._tag, "None");
    }),
  );

  it.effect("allows explicit attachment clearing with an empty array", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadMessageRepository;
      const threadId = ThreadId.make("thread-clear-attachments");
      const messageId = MessageId.make("message-clear-attachments");
      const createdAt = "2026-02-28T19:10:00.000Z";

      yield* repository.upsert({
        messageId,
        threadId,
        turnId: null,
        role: "assistant",
        text: "with attachment",
        attachments: [
          {
            type: "image",
            id: "thread-clear-attachments-att-1",
            name: "example.png",
            mimeType: "image/png",
            sizeBytes: 5,
          },
        ],
        queuedTurnStart: null,
        queuedRevision: 0,
        isStreaming: false,
        createdAt,
        updatedAt: "2026-02-28T19:10:01.000Z",
      });

      yield* repository.upsert({
        messageId,
        threadId,
        turnId: null,
        role: "assistant",
        text: "cleared",
        attachments: [],
        queuedTurnStart: null,
        queuedRevision: 0,
        isStreaming: false,
        createdAt,
        updatedAt: "2026-02-28T19:10:02.000Z",
      });

      const rows = yield* repository.listByThreadId({ threadId });
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.text, "cleared");
      assert.deepEqual(rows[0]?.attachments, []);
    }),
  );

  it.effect("checks assistant turn state without hydrating message text", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadMessageRepository;
      const threadId = ThreadId.make("thread-assistant-turn-state");
      const turnId = TurnId.make("turn-assistant-state");
      const createdAt = "2026-03-01T00:00:00.000Z";

      yield* repository.upsert({
        messageId: MessageId.make("message-assistant-turn-state"),
        threadId,
        turnId,
        role: "assistant",
        text: "large text that the existence query must not select",
        queuedTurnStart: null,
        queuedRevision: 0,
        isStreaming: false,
        createdAt,
        updatedAt: createdAt,
      });

      assert.equal(
        yield* repository.hasAssistantMessageForTurn({
          threadId,
          turnId,
          streamingOnly: false,
        }),
        true,
      );
      assert.equal(
        yield* repository.hasAssistantMessageForTurn({
          threadId,
          turnId,
          streamingOnly: true,
        }),
        false,
      );
      assert.equal(
        yield* repository.hasAssistantMessageForTurn({
          threadId,
          turnId: TurnId.make("turn-assistant-state-missing"),
          streamingOnly: false,
        }),
        false,
      );
    }),
  );
});
