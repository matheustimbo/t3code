import {
  ExternalReadFailure,
  type ExternalReadPageInput,
  type ExternalReadProjectsResult,
  type ExternalReadThread,
  type ExternalReadThreadInput,
  type ExternalReadThreadsInput,
  type ExternalReadThreadsResult,
  type ProjectId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ExternalReadAccess from "./ExternalReadAccess.ts";

export class ExternalReadQueryError extends Schema.TaggedError<ExternalReadQueryError>()(
  "ExternalReadQueryError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "External read projection query failed.";
  }
}

type ReadError = ExternalReadFailure | ExternalReadQueryError;
type Identity = ExternalReadAccess.ExternalReadIdentity;

export class ExternalReadService extends Context.Service<
  ExternalReadService,
  {
    readonly listProjects: (
      identity: Identity,
      input: ExternalReadPageInput,
    ) => Effect.Effect<ExternalReadProjectsResult, ReadError>;
    readonly listThreads: (
      identity: Identity,
      input: ExternalReadThreadsInput,
    ) => Effect.Effect<ExternalReadThreadsResult, ReadError>;
    readonly threadStatus: (
      identity: Identity,
      input: ExternalReadThreadInput,
    ) => Effect.Effect<ExternalReadThread, ReadError>;
  }
>()("t3/mcp/external/ExternalReadService") {}

function page<A>(items: ReadonlyArray<A>, input: ExternalReadPageInput) {
  const cursor = input.cursor ?? 0;
  const limit = input.limit ?? 50;
  const end = Math.min(cursor + limit, items.length);
  return {
    items: items.slice(cursor, end),
    total: items.length,
    nextCursor: end < items.length ? end : null,
  };
}

function metadata(thread: ExternalReadThread): ExternalReadThread {
  return {
    id: thread.id,
    projectId: thread.projectId,
    title: thread.title,
    status: thread.status,
    archived: thread.archived,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
  };
}

const make = Effect.gen(function* () {
  const access = yield* ExternalReadAccess.ExternalReadAccess;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;

  const requireProject = Effect.fn("ExternalReadService.requireProject")(function* (
    projectId: ProjectId,
  ) {
    const project = yield* projects
      .get(projectId)
      .pipe(Effect.mapError((cause) => new ExternalReadQueryError({ cause })));
    if (
      Option.isNone(project) ||
      project.value.projectId !== projectId ||
      project.value.deletedAt !== null
    ) {
      return yield* new ExternalReadFailure({ code: "not_found" });
    }
  });

  const listProjects = Effect.fn("ExternalReadService.listProjects")(function* (
    identity: Identity,
    input: ExternalReadPageInput,
  ) {
    const grant = yield* access.authorize(identity, "projects.list");
    const rows =
      grant.projectIds.length === 0
        ? []
        : yield* projects
            .list({ projectIds: grant.projectIds })
            .pipe(Effect.mapError((cause) => new ExternalReadQueryError({ cause })));
    const items = rows
      .filter((row) => row.deletedAt === null && grant.projectIds.includes(row.projectId))
      .map((row) => ({
        id: row.projectId,
        title: row.title,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      }))
      .toSorted((left, right) => left.id.localeCompare(right.id));
    // Recheck after asynchronous storage reads, including in-flight expiry/revocation.
    yield* access.authorize(identity, "projects.list");
    return page(items, input);
  });
  const listThreads = Effect.fn("ExternalReadService.listThreads")(function* (
    identity: Identity,
    input: ExternalReadThreadsInput,
  ) {
    yield* access.authorize(identity, "threads.list", input.projectId);
    yield* requireProject(input.projectId);
    const rows = yield* projections
      .getThreadReadSummaries({
        projectId: input.projectId,
        includeArchived: input.includeArchived ?? false,
      })
      .pipe(Effect.mapError((cause) => new ExternalReadQueryError({ cause })));
    const items = rows
      .filter(
        (row) => row.projectId === input.projectId && (input.includeArchived || !row.archived),
      )
      .map(metadata)
      .toSorted((left, right) => left.id.localeCompare(right.id));
    yield* access.authorize(identity, "threads.list", input.projectId);
    return page(items, input);
  });
  const threadStatus = Effect.fn("ExternalReadService.threadStatus")(function* (
    identity: Identity,
    input: ExternalReadThreadInput,
  ) {
    yield* access.authorize(identity, "threads.status", input.projectId);
    yield* requireProject(input.projectId);
    const rows = yield* projections
      .getThreadReadSummaries({
        projectId: input.projectId,
        threadId: input.threadId,
        includeArchived: true,
      })
      .pipe(Effect.mapError((cause) => new ExternalReadQueryError({ cause })));
    yield* access.authorize(identity, "threads.status", input.projectId);
    const thread = rows.find(
      (row) => row.projectId === input.projectId && row.id === input.threadId,
    );
    if (thread === undefined) return yield* new ExternalReadFailure({ code: "not_found" });
    return metadata(thread);
  });
  return ExternalReadService.of({ listProjects, listThreads, threadStatus });
});

export const layer = Layer.effect(ExternalReadService, make);
