import {
  ExternalReadFailure,
  ExternalReadPageInput,
  ExternalReadProjectsResult,
  ExternalReadThread,
  ExternalReadThreadInput,
  ExternalReadThreadsInput,
  ExternalReadThreadsResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Tool, Toolkit } from "effect/ai";

import * as ExternalReadAccess from "./ExternalReadAccess.ts";
import * as ExternalReadService from "./ExternalReadService.ts";

const common = {
  failure: ExternalReadFailure,
  failureMode: "return" as const,
  dependencies: [
    ExternalReadAccess.ExternalReadInvocation,
    ExternalReadService.ExternalReadService,
  ],
};
const projects = Tool.make("external_project_list", {
  ...common,
  description:
    "List metadata for explicitly authorized projects. Counts and cursors apply only to those projects.",
  parameters: ExternalReadPageInput,
  success: ExternalReadProjectsResult,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false);
const threads = Tool.make("external_thread_list", {
  ...common,
  description:
    "List thread metadata in an authorized project. No messages, attachments, filesystem paths or cross-thread references are returned. Reading never acknowledges deliveries.",
  parameters: ExternalReadThreadsInput,
  success: ExternalReadThreadsResult,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false);
const status = Tool.make("external_thread_status", {
  ...common,
  description:
    "Read a thread's metadata and latest unheld run status in an authorized project, without acknowledging deliveries or marking it visited.",
  parameters: ExternalReadThreadInput,
  success: ExternalReadThread,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false);

export const ExternalReadToolkit = Toolkit.make(projects, threads, status);
export const ExternalReadHandlers = ExternalReadToolkit.toLayer({
  external_project_list: (input) =>
    Effect.flatMap(ExternalReadAccess.ExternalReadInvocation, (identity) =>
      Effect.flatMap(ExternalReadService.ExternalReadService, (service) =>
        service.listProjects(identity, input),
      ),
    ).pipe(
      Effect.catchTags({
        ExternalReadQueryError: () => Effect.fail(new ExternalReadFailure({ code: "unavailable" })),
      }),
    ),
  external_thread_list: (input) =>
    Effect.flatMap(ExternalReadAccess.ExternalReadInvocation, (identity) =>
      Effect.flatMap(ExternalReadService.ExternalReadService, (service) =>
        service.listThreads(identity, input),
      ),
    ).pipe(
      Effect.catchTags({
        ExternalReadQueryError: () => Effect.fail(new ExternalReadFailure({ code: "unavailable" })),
      }),
    ),
  external_thread_status: (input) =>
    Effect.flatMap(ExternalReadAccess.ExternalReadInvocation, (identity) =>
      Effect.flatMap(ExternalReadService.ExternalReadService, (service) =>
        service.threadStatus(identity, input),
      ),
    ).pipe(
      Effect.catchTags({
        ExternalReadQueryError: () => Effect.fail(new ExternalReadFailure({ code: "unavailable" })),
      }),
    ),
});
