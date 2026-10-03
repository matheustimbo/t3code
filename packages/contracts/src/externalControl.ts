import * as Schema from "effect/Schema";
import {
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import { ProviderInteractionMode, RuntimeMode } from "./providerPolicy.ts";
import { ExternalReadPageInput } from "./externalMcp.ts";

const closed = <Fields extends Schema.Struct.Fields>(fields: Fields) => {
  const schema = Schema.Struct(fields);
  const extraKey = Schema.String.check(
    Schema.isPattern(
      new RegExp(`^(?!(?:${Object.keys(fields).join("|")})(?![\\s\\S]))[\\s\\S]*$`, "u"),
    ),
  );
  return Schema.StructWithRest(schema, [Schema.Record(extraKey, Schema.Never)]).pipe(
    Schema.decodeTo(schema),
  );
};
const requestKey = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
const title = TrimmedNonEmptyString.check(Schema.isMaxLength(512));
// Only a configured model selection. No provider identity, options, path, attachment or context references.
const model = closed({
  instanceId: ProviderInstanceId,
  model: TrimmedNonEmptyString,
});
export const ExternalControlCreateInput = closed({
  projectId: ProjectId,
  requestKey,
  title,
  modelSelection: model,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
});
export type ExternalControlCreateInput = typeof ExternalControlCreateInput.Type;
export const ExternalControlSendInput = closed({
  projectId: ProjectId,
  threadId: ThreadId,
  requestKey,
  text: TrimmedNonEmptyString.check(Schema.isMaxLength(65536)),
  mode: Schema.Literal("auto"),
});
export type ExternalControlSendInput = typeof ExternalControlSendInput.Type;
export const ExternalControlInterruptInput = closed({
  projectId: ProjectId,
  threadId: ThreadId,
  requestKey,
});
export type ExternalControlInterruptInput = typeof ExternalControlInterruptInput.Type;
export const ExternalControlMessagesInput = closed({
  ...ExternalReadPageInput.fields,
  projectId: ProjectId,
  threadId: ThreadId,
});
export type ExternalControlMessagesInput = typeof ExternalControlMessagesInput.Type;
export const ExternalControlMessage = Schema.Struct({
  id: MessageId,
  role: Schema.Literals(["user", "assistant", "system"]),
  text: Schema.String,
  truncated: Schema.Boolean,
  streaming: Schema.Boolean,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export const ExternalControlMessagesResult = Schema.Struct({
  items: Schema.Array(ExternalControlMessage),
  total: NonNegativeInt,
  nextCursor: Schema.NullOr(NonNegativeInt),
});
export type ExternalControlMessagesResult = typeof ExternalControlMessagesResult.Type;
export const ExternalControlMutationResult = Schema.Struct({
  projectId: ProjectId,
  threadId: ThreadId,
  messageId: Schema.optional(MessageId),
  outcome: Schema.Literals(["accepted", "no_active_run"]),
});
export type ExternalControlMutationResult = typeof ExternalControlMutationResult.Type;
export class ExternalControlFailure extends Schema.TaggedError<ExternalControlFailure>()(
  "ExternalControlFailure",
  { code: Schema.Literals(["access_denied", "not_found", "conflict", "unavailable"]) },
) {
  override get message(): string {
    return this.code === "access_denied"
      ? "External control access denied."
      : this.code === "not_found"
        ? "The requested resource was not found."
        : this.code === "conflict"
          ? "The request key was already used for a different request."
          : "External control is unavailable.";
  }
}
