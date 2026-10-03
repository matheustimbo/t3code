import * as NodeCrypto from "node:crypto";
import * as NodePlatformCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import {
  makeSqlitePersistenceLive,
  SqlitePersistenceMemory,
} from "../../persistence/Layers/Sqlite.ts";
import * as Access from "./ExternalReadAccess.ts";
import * as GrantStore from "../../persistence/ExternalReadGrantStore.ts";
import * as Reads from "./ExternalReadService.ts";

// Public, synthetic test values. Never issued to a client or written to real T3 state.
export const token = "external-read-test-fixture";
export const allowed = ProjectId.make("allowed");
export const blocked = ProjectId.make("blocked");
export const removed = ProjectId.make("removed");
const environmentId = EnvironmentId.make("fixture-environment");
export const identity = { credentialId: "fixture", principalId: "external-fixture" };
export const grant: Access.ExternalReadGrant = {
  id: identity.credentialId,
  principalId: identity.principalId,
  environmentId,
  audience: Access.AUDIENCE,
  tokenHash: NodeCrypto.createHash("sha256").update(token).digest("hex"),
  projectIds: [allowed, removed],
  operations: ["projects.list", "threads.list", "threads.status"],
  notBefore: 0,
  expiresAt: 1000,
};
export const environmentLayer = Layer.succeed(ServerEnvironment.ServerEnvironment, {
  getEnvironmentId: Effect.succeed(environmentId),
  getDescriptor: Effect.die("unused fixture descriptor"),
});
export const registerFixtures = Effect.gen(function* () {
  const store = yield* GrantStore.ExternalReadGrantStore;
  const { grants } = yield* Access.ExternalReadSettings;
  for (const fixture of grants) yield* store.register(Access.grantBinding(fixture));
});
export const accessLayer = (
  grants: ReadonlyArray<Access.ExternalReadGrant> = [grant],
  enabled = true,
  database: ReturnType<typeof makeSqlitePersistenceLive> = SqlitePersistenceMemory,
) =>
  Layer.effectDiscard(registerFixtures).pipe(
    Layer.provideMerge(Access.layer),
    Layer.provideMerge(GrantStore.layer),
    Layer.provideMerge(Layer.succeed(Access.ExternalReadSettings, { enabled, grants })),
    Layer.provideMerge(environmentLayer),
    Layer.provide(NodePlatformCrypto.layer),
    Layer.provideMerge(database),
    Layer.provide(NodeServices.layer),
  );
export const storesLayer = Layer.mergeAll(ProjectStore.layer, ProjectionStore.layer).pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
);
export const readsLayer = Reads.layer.pipe(
  Layer.provideMerge(storesLayer),
  Layer.provideMerge(accessLayer()),
);

export const seed = Effect.gen(function* () {
  const projects = yield* ProjectStore.ProjectStoreV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const now = DateTime.makeUnsafe("2026-10-03T00:00:00.000Z");
  const timestamp = DateTime.formatIso(now);
  for (const [index, projectId] of [allowed, blocked, removed].entries()) {
    const base = {
      aggregateKind: "project" as const,
      aggregateId: projectId,
      occurredAt: timestamp,
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
    };
    yield* projects.apply({
      ...base,
      sequence: index + 1,
      eventId: EventId.make(`project-${projectId}`),
      type: "project.created",
      payload: {
        projectId,
        title: projectId,
        workspaceRoot: `/private/${projectId}`,
        scripts: [],
        defaultModelSelection: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    });
    if (projectId === removed)
      yield* projects.apply({
        ...base,
        sequence: 4,
        eventId: EventId.make("project-remove"),
        type: "project.deleted",
        payload: { projectId, deletedAt: timestamp },
      });
  }
  const providerInstanceId = ProviderInstanceId.make("codex");
  for (const [id, projectId, archived, deleted] of [
    ["a", allowed, false, false],
    ["b", allowed, false, false],
    ["archived", allowed, true, false],
    ["deleted", allowed, false, true],
    ["foreign", blocked, false, false],
    ["removed", removed, false, false],
  ] as const) {
    const threadId = ThreadId.make(id);
    yield* projections.apply({
      id: EventId.make(`thread-${id}`),
      type: "thread.created",
      threadId,
      occurredAt: now,
      payload: {
        id: threadId,
        projectId,
        title: id,
        createdBy: "user",
        creationSource: "web",
        providerInstanceId,
        modelSelection: { instanceId: providerInstanceId, model: "fixture" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: "private-branch",
        worktreePath: "/private/fixture",
        activeProviderThreadId: null,
        lineage: {
          parentThreadId: ThreadId.make("foreign"),
          relationshipToParent: "subagent",
          rootThreadId: ThreadId.make("foreign"),
        },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: archived ? now : null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: deleted ? now : null,
      },
    });
  }
  const threadId = ThreadId.make("b");
  const run = {
    id: RunId.make("completed"),
    threadId,
    ordinal: 1,
    providerInstanceId,
    modelSelection: { instanceId: providerInstanceId, model: "fixture" },
    providerThreadId: null,
    userMessageId: MessageId.make("private-message"),
    rootNodeId: null,
    activeAttemptId: null,
    status: "completed" as const,
    requestedAt: now,
    startedAt: now,
    completedAt: now,
    checkpointId: null,
    contextHandoffId: null,
    delegatedCompletion: {
      disposition: "open" as const,
      nextGeneration: 2,
      delivery: {
        generation: 1,
        messageId: MessageId.make("private-delivery"),
        taskIds: [NodeId.make("private-task")],
      },
    },
  };
  yield* projections.apply({
    id: EventId.make("completed-run"),
    type: "run.created",
    threadId,
    occurredAt: now,
    payload: run,
  });
  yield* projections.apply({
    id: EventId.make("held-run"),
    type: "run.created",
    threadId,
    occurredAt: now,
    payload: {
      ...run,
      id: RunId.make("held"),
      ordinal: 2,
      status: "queued",
      queueHeld: true,
      startedAt: null,
      completedAt: null,
      delegatedCompletion: { disposition: "open", nextGeneration: 1, delivery: null },
    },
  });
});
