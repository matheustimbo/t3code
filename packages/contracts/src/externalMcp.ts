import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, ProjectId, ThreadId } from "./baseSchemas.ts";
import { OrchestrationV2ShellThreadStatus } from "./orchestrationV2.ts";

export const ExternalReadPageInput = Schema.Struct({
  cursor: Schema.optional(NonNegativeInt),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
});
export type ExternalReadPageInput = typeof ExternalReadPageInput.Type;

export const ExternalReadProject = Schema.Struct({
  id: ProjectId,
  title: Schema.String,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

// A closed metadata view: no content, attachments, filesystem paths, run IDs or lineage.
export const ExternalReadThread = Schema.Struct({
  id: ThreadId,
  projectId: ProjectId,
  title: Schema.String,
  status: OrchestrationV2ShellThreadStatus,
  archived: Schema.Boolean,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ExternalReadThread = typeof ExternalReadThread.Type;

export const ExternalReadThreadsInput = Schema.Struct({
  ...ExternalReadPageInput.fields,
  projectId: ProjectId,
  includeArchived: Schema.optional(Schema.Boolean),
});
export type ExternalReadThreadsInput = typeof ExternalReadThreadsInput.Type;

export const ExternalReadThreadInput = Schema.Struct({ projectId: ProjectId, threadId: ThreadId });
export type ExternalReadThreadInput = typeof ExternalReadThreadInput.Type;

export const ExternalReadProjectsResult = Schema.Struct({
  items: Schema.Array(ExternalReadProject),
  total: NonNegativeInt,
  nextCursor: Schema.NullOr(NonNegativeInt),
});
export type ExternalReadProjectsResult = typeof ExternalReadProjectsResult.Type;

export const ExternalReadThreadsResult = Schema.Struct({
  items: Schema.Array(ExternalReadThread),
  total: NonNegativeInt,
  nextCursor: Schema.NullOr(NonNegativeInt),
});
export type ExternalReadThreadsResult = typeof ExternalReadThreadsResult.Type;

export class ExternalReadFailure extends Schema.TaggedError<ExternalReadFailure>()(
  "ExternalReadFailure",
  { code: Schema.Literals(["access_denied", "not_found", "unavailable"]) },
) {
  override get message(): string {
    return this.code === "access_denied"
      ? "External read access denied."
      : this.code === "not_found"
        ? "The requested resource was not found."
        : "External read data is unavailable.";
  }
}
