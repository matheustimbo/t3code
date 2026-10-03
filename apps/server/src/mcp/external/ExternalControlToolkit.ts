import {
  ExternalControlCreateInput,
  ExternalControlFailure,
  ExternalControlInterruptInput,
  ExternalControlMessagesInput,
  ExternalControlMessagesResult,
  ExternalControlMutationResult,
  ExternalControlSendInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Tool, Toolkit } from "effect/unstable/ai";
import * as Access from "./ExternalReadAccess.ts";
import * as Control from "./ExternalControlService.ts";

const common = {
  failure: ExternalControlFailure,
  failureMode: "return" as const,
  dependencies: [Access.ExternalReadInvocation, Control.ExternalControlService],
};
const messages = Tool.make("external_thread_messages", {
  ...common,
  description:
    "Read only local messages in an authorized project/thread, without acknowledgements. No attachment data or cross-thread references are resolved.",
  parameters: ExternalControlMessagesInput,
  success: ExternalControlMessagesResult,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false);
const create = Tool.make("external_thread_create", {
  ...common,
  description:
    "Create a root thread in an authorized project with explicit runtime/interaction modes within the grant ceilings. requestKey is mandatory and durable; retry the same key and identical arguments.",
  parameters: ExternalControlCreateInput,
  success: ExternalControlMutationResult,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false);
const send = Tool.make("external_thread_send", {
  ...common,
  description:
    "Send text through native message intake to an authorized idle root thread. New sends during an active run are denied, because thread metadata cannot prove that turn's effective permissions. No attachments, context references or provider/parent identity. requestKey is mandatory; identical retries never send twice.",
  parameters: ExternalControlSendInput,
  success: ExternalControlMutationResult,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false);
const interrupt = Tool.make("external_thread_interrupt", {
  ...common,
  description:
    "Request interruption of the active run in an authorized thread. The first request binds its target durably; retrying requestKey cannot interrupt a later run.",
  parameters: ExternalControlInterruptInput,
  success: ExternalControlMutationResult,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, false);
export const ExternalControlToolkit = Toolkit.make(messages, create, send, interrupt);
export const ExternalControlHandlers = ExternalControlToolkit.toLayer({
  external_thread_messages: (input) =>
    Effect.flatMap(Access.ExternalReadInvocation, (identity) =>
      Effect.flatMap(Control.ExternalControlService, (service) =>
        service.messages(identity, input),
      ),
    ),
  external_thread_create: (input) =>
    Effect.flatMap(Access.ExternalReadInvocation, (identity) =>
      Effect.flatMap(Control.ExternalControlService, (service) => service.create(identity, input)),
    ),
  external_thread_send: (input) =>
    Effect.flatMap(Access.ExternalReadInvocation, (identity) =>
      Effect.flatMap(Control.ExternalControlService, (service) => service.send(identity, input)),
    ),
  external_thread_interrupt: (input) =>
    Effect.flatMap(Access.ExternalReadInvocation, (identity) =>
      Effect.flatMap(Control.ExternalControlService, (service) =>
        service.interrupt(identity, input),
      ),
    ),
});
