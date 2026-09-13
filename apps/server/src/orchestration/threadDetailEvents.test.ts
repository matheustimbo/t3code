import { EventId, MessageId, ThreadId, type OrchestrationEvent } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { isThreadDetailEvent } from "./threadDetailEvents.ts";

const baseEvent = {
  eventId: EventId.make("queue-lifecycle"),
  commandId: null,
  causationEventId: null,
  correlationId: null,
  metadata: {},
  sequence: 1,
  occurredAt: "2026-09-13T00:00:00.000Z",
  aggregateKind: "thread",
  aggregateId: ThreadId.make("thread"),
} as const;

describe("isThreadDetailEvent", () => {
  it("streams every event that changes queued message membership", () => {
    const events = [
      {
        ...baseEvent,
        type: "thread.turn-start-requested",
        payload: {
          threadId: ThreadId.make("thread"),
          messageId: MessageId.make("queued"),
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: "2026-09-13T00:00:00.000Z",
        },
      },
      {
        ...baseEvent,
        type: "thread.message-requeued",
        payload: {
          threadId: ThreadId.make("thread"),
          messageId: MessageId.make("queued"),
          queuedTurnStart: {},
          updatedAt: "2026-09-13T00:00:00.000Z",
        },
      },
      {
        ...baseEvent,
        type: "thread.queued-message-cancelled",
        payload: {
          threadId: ThreadId.make("thread"),
          messageId: MessageId.make("queued"),
          updatedAt: "2026-09-13T00:00:00.000Z",
        },
      },
    ] satisfies ReadonlyArray<OrchestrationEvent>;

    expect(events.map(isThreadDetailEvent)).toEqual([true, true, true]);
  });
});
