import type { OrchestrationEvent, OrchestrationEventType } from "@t3tools/contracts";

/**
 * The events an open thread detail page is subscribed to. The live stream
 * filters on this list and the page's watermark query counts exactly the same
 * types: a watermark that counted an event the subscription never delivers
 * could never be reached, and the page would park forever. Both read this
 * array so they cannot drift apart.
 */
export const THREAD_DETAIL_EVENT_TYPES = [
  "thread.message-sent",
  "thread.message-requeued",
  "thread.turn-start-requested",
  "thread.queued-message-cancelled",
  "thread.queued-message-edited",
  "thread.queued-message-dropped",
  "thread.proposed-plan-upserted",
  "thread.activity-appended",
  "thread.turn-diff-completed",
  "thread.reverted",
  "thread.session-set",
] as const satisfies ReadonlyArray<OrchestrationEventType>;

type ThreadDetailEventType = (typeof THREAD_DETAIL_EVENT_TYPES)[number];

const threadDetailEventTypes = new Set<string>(THREAD_DETAIL_EVENT_TYPES);

export function isThreadDetailEvent(
  event: OrchestrationEvent,
): event is Extract<OrchestrationEvent, { type: ThreadDetailEventType }> {
  return threadDetailEventTypes.has(event.type);
}
