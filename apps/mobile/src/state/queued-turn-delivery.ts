import {
  resolveSendWhileRunning,
  type SendWhileRunningPreferences,
} from "@t3tools/client-runtime/composer/send-while-running";
import type { ModelSelection, OrchestrationSession, ServerProvider } from "@t3tools/contracts";

type TurnProvider = Pick<
  ServerProvider,
  "instanceId" | "driver" | "displayName" | "concurrentSend"
>;

/**
 * Delivery for a turn the outbox is about to start.
 *
 * Resolved here, at drain time, rather than when the message was enqueued: an
 * outbox entry only says "send this", and whether it becomes a queued turn
 * depends on what the thread is doing when it actually goes. Null means leave
 * `delivery` off the wire entirely, so an idle thread's payload is identical
 * to one from a build without this feature.
 */
export function resolveOutboxTurnDelivery(input: {
  readonly thread: {
    readonly session: Pick<OrchestrationSession, "status" | "providerInstanceId"> | null;
    readonly modelSelection: Pick<ModelSelection, "instanceId">;
  } | null;
  readonly providers: ReadonlyArray<TurnProvider>;
  readonly preferences: SendWhileRunningPreferences | undefined;
}): "queued" | null {
  const session = input.thread?.session ?? null;
  // The running turn belongs to the session's provider, so a draft that has
  // since been pointed at another one must not decide this.
  const instanceId = session?.providerInstanceId ?? input.thread?.modelSelection.instanceId;
  const affordance = resolveSendWhileRunning({
    isRunning: session?.status === "running",
    provider: input.providers.find((provider) => provider.instanceId === instanceId) ?? null,
    ...(input.preferences ? { preferences: input.preferences } : {}),
  });
  return affordance?.selected.turnDelivery === "queued" ? "queued" : null;
}
