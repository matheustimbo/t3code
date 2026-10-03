import type { CommandId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

// Internal invocation context, never accepted as a client command field.
// Only the named command is guarded, leaving internal delegation/follow-ups unchanged.
export class CommandCommitAuthorization extends Context.Reference<
  | {
      readonly commandId: CommandId;
      readonly check: Effect.Effect<void, unknown>;
    }
  | undefined
>("t3/orchestration-v2/CommandCommitAuthorization", {
  defaultValue: () => undefined,
}) {}
