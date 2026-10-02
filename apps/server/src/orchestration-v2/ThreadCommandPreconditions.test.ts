import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  OrchestrationV2AppThread,
  OrchestrationV2ThreadShell,
  ProjectId,
  ProviderInstanceId,
  RunId,
  OrchestrationV2Run,
  ThreadId,
  type OrchestrationV2Command,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import { threadCommandPreconditionFailure } from "./ThreadCommandPreconditions.ts";

const decodeRun = Schema.decodeUnknownSync(Schema.toCodecJson(OrchestrationV2Run));
const decodeThread = Schema.decodeUnknownSync(Schema.toCodecJson(OrchestrationV2AppThread));
const stamp = "2026-10-02T10:00:00.000Z";
const projectId = ProjectId.make("guard-project");
const threadId = ThreadId.make("guard-thread");
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "fixture" };
const thread = Schema.decodeUnknownSync(Schema.toCodecJson(OrchestrationV2ThreadShell))({
  id: threadId,
  projectId,
  title: "Fixture",
  createdBy: "user",
  creationSource: "server",
  providerInstanceId: "codex",
  modelSelection,
  runtimeMode: "approval-required",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
  forkedFrom: null,
  activeProviderThreadId: null,
  latestRunId: null,
  activeRunId: null,
  status: "idle",
  pendingRuntimeRequest: null,
  latestVisibleMessage: null,
  latestUserMessageAt: null,
  hasActionableProposedPlan: false,
  itemCount: 0,
  visibleItemCount: 0,
  createdAt: stamp,
  updatedAt: stamp,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  deletedAt: null,
});
const project = Schema.decodeUnknownSync(ProjectStore.ProjectRow)({
  projectId,
  title: "Fixture",
  workspaceRoot: "/fixture",
  defaultModelSelection: modelSelection,
  defaultThreadEnvMode: null,
  autoPull: false,
  faviconPath: null,
  projectIcon: null,
  scripts: [],
  createdAt: stamp,
  updatedAt: stamp,
  deletedAt: null,
});
const create = {
  type: "thread.create",
  commandId: CommandId.make("guard-create"),
  threadId,
  projectId,
  title: "Fixture",
  modelSelection,
  runtimeMode: "approval-required",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  createdBy: "user",
  creationSource: "server",
  preconditions: {
    snapshotSequence: 0,
    projectId,
    workspace: "/fixture",
    modelSelection,
    runtimeMode: "approval-required",
    interactionMode: "default",
  },
} satisfies OrchestrationV2Command;
const send = {
  type: "message.dispatch",
  commandId: CommandId.make("guard-send"),
  threadId,
  messageId: MessageId.make("guard-message"),
  text: "Fixture",
  attachments: [],
  dispatchMode: { type: "start_immediately" },
  createdBy: "user",
  creationSource: "server",
  preconditions: create.preconditions,
} satisfies OrchestrationV2Command;
const state = { sequence: 0, project, thread, runs: [] };

describe("thread command preconditions", () => {
  it("accepts an idle destination and root creation", () => {
    assert.isNull(threadCommandPreconditionFailure(send, state));
    assert.isNull(threadCommandPreconditionFailure(create, { ...state, thread: null }));
  });
  it("rejects stale state, missing projects, permissions and changed destinations", () => {
    for (const changed of [
      { ...state, sequence: 1 },
      { ...state, project: null },
      { ...state, thread: { ...thread, runtimeMode: "full-access" as const } },
      { ...state, thread: { ...thread, projectId: ProjectId.make("other") } },
      { ...state, thread: { ...thread, worktreePath: "/other" } },
      { ...state, thread: { ...thread, modelSelection: { ...modelSelection, model: "other" } } },
      { ...state, thread: { ...thread, interactionMode: "plan" as const } },
      { ...state, thread: { ...thread, archivedAt: DateTime.makeUnsafe(stamp) } },
      { ...state, thread: { ...thread, hasActionableProposedPlan: true } },
      {
        ...state,
        thread: {
          ...thread,
          pendingBackgroundTasks: [{ kind: "command" as const, taskId: "fixture" }],
        },
      },
    ])
      assert.isNotNull(threadCommandPreconditionFailure(send, changed));
  });
  it("refuses queued work even when the shell looks idle", () => {
    const run = decodeRun({
      id: "queued-run",
      threadId,
      ordinal: 1,
      providerInstanceId: "codex",
      modelSelection,
      providerThreadId: null,
      userMessageId: "queued-message",
      rootNodeId: null,
      activeAttemptId: null,
      status: "queued",
      requestedAt: stamp,
      startedAt: null,
      completedAt: null,
      checkpointId: null,
      contextHandoffId: null,
    });
    assert.isNotNull(threadCommandPreconditionFailure(send, { ...state, runs: [run] }));
  });
  it("rejects reused thread IDs, worktrees and steering", () => {
    assert.isNotNull(threadCommandPreconditionFailure(create, state));
    assert.isNotNull(
      threadCommandPreconditionFailure(
        { ...create, worktreePath: "/other" },
        { ...state, thread: null },
      ),
    );
    assert.isNotNull(
      threadCommandPreconditionFailure(
        { ...send, dispatchMode: { type: "queue_after_active" } },
        state,
      ),
    );
  });
});

const database = SqlitePersistenceMemory;
const stores = Layer.mergeAll(
  database,
  EventStore.layer.pipe(Layer.provide(database)),
  ProjectionStore.layer.pipe(Layer.provide(database)),
  ProjectStore.layer.pipe(Layer.provide(database)),
  CommandReceiptStore.layer.pipe(Layer.provide(database)),
  EffectOutbox.layer.pipe(Layer.provide(database)),
);
const testLayer = EventSink.layer.pipe(Layer.provideMerge(stores));
it.effect(
  "atomically rejects stale or busy commands without events, effects or an accepted receipt",
  () =>
    Effect.gen(function* () {
      const projects = yield* ProjectStore.ProjectStoreV2;
      const sink = yield* EventSink.EventSinkV2;
      const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const events = yield* EventStore.EventStoreV2;
      const sql = yield* SqlClient.SqlClient;
      yield* projects.apply({
        sequence: 0,
        eventId: EventId.make("guard-project-created"),
        aggregateKind: "project",
        aggregateId: projectId,
        occurredAt: stamp,
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "project.created",
        payload: {
          projectId,
          title: "Fixture",
          workspaceRoot: "/fixture",
          defaultModelSelection: modelSelection,
          scripts: [],
          createdAt: stamp,
          updatedAt: stamp,
        },
      });
      const now = DateTime.makeUnsafe(stamp);
      const createdThread = decodeThread({ ...thread, createdAt: stamp, updatedAt: stamp });
      const input = {
        commandId: create.commandId,
        threadId,
        commandType: create.type,
        acceptedAt: now,
        guardedCommand: create,
        events: [
          {
            id: EventId.make("guard-thread-created"),
            type: "thread.created" as const,
            threadId,
            occurredAt: now,
            payload: decodeThread({
              ...thread,
              createdAt: stamp,
              updatedAt: stamp,
            }),
          },
        ],
        effects: [
          {
            id: "guard-effect",
            commandId: create.commandId,
            threadId,
            request: { type: "provider-turn.start" as const, runId: RunId.make("guard-run") },
          },
        ],
      };
      yield* sql`UPDATE projection_projects SET workspace_root = '/changed' WHERE project_id = ${projectId}`;
      yield* sink.commitCommand(input).pipe(Effect.flip);
      assert.isTrue(Option.isNone(yield* receipts.getByCommandId(create.commandId)));
      assert.lengthOf(yield* outbox.listByCommandId(create.commandId), 0);
      assert.equal(yield* events.latestApplicationSequence, 0);
      yield* sql`UPDATE projection_projects SET workspace_root = '/fixture' WHERE project_id = ${projectId}`;
      const accepted = yield* sink.commitCommand(input);
      assert.isTrue(accepted.committed);
      assert.lengthOf(yield* outbox.listByCommandId(create.commandId), 1);
      const staleId = CommandId.make("guard-stale");
      yield* sink
        .commitCommand({
          ...input,
          commandId: staleId,
          guardedCommand: { ...create, commandId: staleId, threadId: ThreadId.make("guard-other") },
        })
        .pipe(Effect.flip);
      assert.isTrue(Option.isNone(yield* receipts.getByCommandId(staleId)));
      assert.equal(yield* events.latestApplicationSequence, accepted.receipt.resultSequence);
      assert.isFalse((yield* sink.commitCommand(input)).committed);
      const queued = decodeRun({
        id: "guard-queued-run",
        threadId,
        ordinal: 1,
        providerInstanceId: "codex",
        modelSelection,
        providerThreadId: null,
        userMessageId: "guard-queued-message",
        rootNodeId: null,
        activeAttemptId: null,
        status: "queued",
        requestedAt: stamp,
        startedAt: null,
        completedAt: null,
        checkpointId: null,
        contextHandoffId: null,
      });
      yield* sink.write({
        events: [
          {
            id: EventId.make("guard-queued-event"),
            type: "run.created",
            threadId,
            runId: queued.id,
            occurredAt: now,
            payload: queued,
          },
        ],
      });
      const sequence = yield* events.latestApplicationSequence;
      yield* sink
        .commitCommand({
          commandId: send.commandId,
          commandType: send.type,
          threadId,
          acceptedAt: now,
          guardedCommand: {
            ...send,
            preconditions: { ...send.preconditions, snapshotSequence: sequence },
          },
          events: [
            {
              id: EventId.make("guard-should-not-update"),
              type: "thread.metadata-updated",
              threadId,
              occurredAt: now,
              payload: createdThread,
            },
          ],
          effects: [
            {
              id: "guard-send-effect",
              commandId: send.commandId,
              threadId,
              request: { type: "provider-turn.start", runId: queued.id },
            },
          ],
        })
        .pipe(Effect.flip);
      assert.isTrue(Option.isNone(yield* receipts.getByCommandId(send.commandId)));
      assert.lengthOf(yield* outbox.listByCommandId(send.commandId), 0);
      assert.equal(yield* events.latestApplicationSequence, sequence);
    }).pipe(Effect.provide(testLayer)),
);
