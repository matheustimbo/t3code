import { expect, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as Access from "./ExternalReadAccess.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as Reads from "./ExternalReadService.ts";
import {
  accessLayer,
  allowed,
  blocked,
  grant,
  identity,
  readsLayer,
  removed,
  seed,
  storesLayer,
} from "./testSupport.ts";

const memoryReadsLayer = Reads.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(ProjectStore.layer, ProjectionStore.layerMemory).pipe(
      Layer.provideMerge(SqlitePersistenceMemory),
    ),
  ),
  Layer.provideMerge(accessLayer()),
);

it.effect.each([
  { name: "SQL", layer: readsLayer },
  { name: "memory", layer: memoryReadsLayer },
])("keeps the same scoped metadata and held-queue status in $name", ({ layer }) =>
  Effect.gen(function* () {
    yield* seed;
    const service = yield* Reads.ExternalReadService;
    const result = yield* service.threadStatus(identity, {
      projectId: allowed,
      threadId: ThreadId.make("b"),
    });
    expect(result).toEqual({
      id: "b",
      projectId: allowed,
      title: "b",
      status: "completed",
      archived: false,
      createdAt: "2026-10-03T00:00:00.000Z",
      updatedAt: "2026-10-03T00:00:00.000Z",
    });
    expect((yield* service.listThreads(identity, { projectId: allowed })).total).toBe(2);
  }).pipe(Effect.provide(layer)),
);

it.effect("filters before counts/cursors and excludes removed projects and threads", () =>
  Effect.gen(function* () {
    yield* seed;
    const service = yield* Reads.ExternalReadService;
    const projects = yield* service.listProjects(identity, { limit: 1 });
    expect(projects).toMatchObject({ total: 1, nextCursor: null, items: [{ id: allowed }] });
    expect(Object.keys(projects.items[0]!).sort()).toEqual([
      "createdAt",
      "id",
      "title",
      "updatedAt",
    ]);
    const first = yield* service.listThreads(identity, { projectId: allowed, limit: 1 });
    expect(first).toMatchObject({ total: 2, nextCursor: 1, items: [{ id: "a" }] });
    const second = yield* service.listThreads(identity, {
      projectId: allowed,
      limit: 1,
      cursor: 1,
    });
    expect(second).toMatchObject({ total: 2, nextCursor: null, items: [{ id: "b" }] });
    expect(
      (yield* service.listThreads(identity, { projectId: allowed, includeArchived: true })).total,
    ).toBe(3);
    expect(
      yield* service.listThreads(identity, { projectId: removed }).pipe(Effect.flip),
    ).toMatchObject({ code: "not_found" });
    expect(
      yield* service.listThreads(identity, { projectId: blocked, cursor: 999 }).pipe(Effect.flip),
    ).toMatchObject({ code: "access_denied" });
  }).pipe(Effect.provide(readsLayer)),
);

it.effect("makes cross-project IDs indistinguishable from missing IDs", () =>
  Effect.gen(function* () {
    yield* seed;
    const service = yield* Reads.ExternalReadService;
    for (const threadId of ["foreign", "unknown", "deleted"]) {
      const result = yield* service
        .threadStatus(identity, { projectId: allowed, threadId: ThreadId.make(threadId) })
        .pipe(Effect.flip);
      expect(result).toMatchObject({ _tag: "ExternalReadFailure", code: "not_found" });
      expect(Object.keys(result)).not.toContain("threadId");
      expect(result.message).toBe("The requested resource was not found.");
    }
  }).pipe(Effect.provide(readsLayer)),
);

it.effect("reads only project metadata and makes zero database writes", () =>
  Effect.gen(function* () {
    yield* seed;
    const sql = yield* SqlClient.SqlClient;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const service = yield* Reads.ExternalReadService;
    const beforeProjection = yield* projections.getThreadProjection(ThreadId.make("a"));
    const beforeDelivery = yield* projections.getThreadProjection(ThreadId.make("b"));
    expect(beforeDelivery.runs[0]?.delegatedCompletion?.delivery).not.toBeNull();
    // Invalid foreign payload would fail full shell/history hydration; this read never touches it.
    yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json = '{}' WHERE thread_id = 'foreign'`;
    const before = yield* sql<{ readonly changes: number }>`SELECT total_changes() AS changes`;
    yield* service.listProjects(identity, {});
    yield* service.listThreads(identity, { projectId: allowed, includeArchived: true });
    const status = yield* service.threadStatus(identity, {
      projectId: allowed,
      threadId: ThreadId.make("a"),
    });
    expect(Object.keys(status).sort()).toEqual([
      "archived",
      "createdAt",
      "id",
      "projectId",
      "status",
      "title",
      "updatedAt",
    ]);
    expect(status).toMatchObject({ id: "a", status: "idle", archived: false });
    expect(
      yield* service.threadStatus(identity, { projectId: allowed, threadId: ThreadId.make("b") }),
    ).toMatchObject({ status: "completed" });
    const after = yield* sql<{ readonly changes: number }>`SELECT total_changes() AS changes`;
    expect(after).toEqual(before);
    expect(yield* projections.getThreadProjection(ThreadId.make("a"))).toEqual(beforeProjection);
    expect(yield* projections.getThreadProjection(ThreadId.make("b"))).toEqual(beforeDelivery);
    // No orchestrator, provider, notifications or filesystem service is supplied to these reads.
  }).pipe(Effect.provide(readsLayer)),
);

it.effect("denies disallowed operations before any storage query", () =>
  Effect.gen(function* () {
    const service = yield* Reads.ExternalReadService;
    expect(yield* service.listProjects(identity, {}).pipe(Effect.flip)).toMatchObject({
      code: "access_denied",
    });
    expect(
      yield* service.listThreads(identity, { projectId: blocked }).pipe(Effect.flip),
    ).toMatchObject({ code: "access_denied" });
  }).pipe(
    Effect.provide(
      Reads.layer.pipe(
        Layer.provide(accessLayer([{ ...grant, operations: ["threads.list"] }])),
        // Storage methods are deliberately unavailable: a policy failure must happen first.
        Layer.provide(Layer.mock(ProjectStore.ProjectStoreV2)({})),
        Layer.provide(Layer.mock(ProjectionStore.ProjectionStoreV2)({})),
      ),
    ),
  ),
);

it.effect.each(["revoke", "expire"] as const)("rechecks %s during an in-flight query", (mode) =>
  Effect.gen(function* () {
    yield* seed;
    const projects = yield* ProjectStore.ProjectStoreV2;
    const access = yield* Access.ExternalReadAccess;
    const serviceLayer = Reads.layer.pipe(
      Layer.provide(
        Layer.succeed(ProjectStore.ProjectStoreV2, {
          ...projects,
          list: (options) =>
            projects.list(options).pipe(
              Effect.tap(() =>
                mode === "revoke"
                  ? access.revoke(identity.credentialId)
                  : TestClock.setTime(grant.expiresAt),
              ),
              Effect.mapError(
                (cause) =>
                  new ProjectStore.ProjectStoreV2Error({
                    operation: "fixture-in-flight-revoke",
                    cause,
                  }),
              ),
            ),
        }),
      ),
    );
    const error = yield* Effect.flatMap(Reads.ExternalReadService, (service) =>
      service.listProjects(identity, {}),
    ).pipe(Effect.provide(serviceLayer), Effect.flip);
    expect(error).toMatchObject({ code: "access_denied" });
  }).pipe(Effect.provide(Layer.mergeAll(storesLayer, accessLayer()))),
);
