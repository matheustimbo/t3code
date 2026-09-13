import {
  OrchestrationDispatchCommandError,
  type QueuedMessageUnavailableReason,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const isOrchestrationDispatchCommandError = Schema.is(OrchestrationDispatchCommandError);

export function wasBootstrapThreadDeleted(error: unknown): boolean {
  return (
    isOrchestrationDispatchCommandError(error) && error.bootstrapThreadDisposition === "deleted"
  );
}

export function queuedMessageUnavailableReason(
  error: unknown,
): QueuedMessageUnavailableReason | null {
  return isOrchestrationDispatchCommandError(error)
    ? (error.queuedMessageUnavailableReason ?? null)
    : null;
}
