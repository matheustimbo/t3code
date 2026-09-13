import type { ThreadFeedEntry } from "../../lib/threadActivity";
import type { QueuedMessageEditSession } from "@t3tools/client-runtime/composer/queued-messages";
import type { QueuedThreadMessage } from "../../state/thread-outbox-model";

export type PendingThreadFeedEntry = ThreadFeedEntry & {
  /** Local outbox: not on the server yet. Reads as "Pending" in the timeline. */
  readonly pendingMessage?: QueuedThreadMessage;
  readonly acknowledged?: boolean;
  /**
   * Place in T3 Code's server-side queue, 1-based, filled in by
   * `withQueuedMessageOrdinals`. Unrelated to `pendingMessage`: this message
   * reached the server and is waiting for the running turn to finish.
   */
  readonly queuedOrdinal?: number;
  readonly queuedMessageEdit?: QueuedMessageEditSession;
};

/** Append the outbox after all presented activity, until the server echoes each message. */
export function appendPendingThreadMessages(
  presentedFeed: ReadonlyArray<ThreadFeedEntry>,
  feed: ReadonlyArray<ThreadFeedEntry>,
  queuedMessages: ReadonlyArray<QueuedThreadMessage>,
): ReadonlyArray<PendingThreadFeedEntry> {
  if (queuedMessages.length === 0) return presentedFeed;
  const deliveredIds = new Set(
    feed.flatMap((entry) => (entry.type === "message" ? [entry.message.id] : [])),
  );
  return [
    ...presentedFeed,
    ...queuedMessages
      .filter((message) => !deliveredIds.has(message.messageId))
      .map((pendingMessage): PendingThreadFeedEntry => ({
        type: "message",
        id: pendingMessage.messageId,
        createdAt: pendingMessage.createdAt,
        pendingMessage,
        message: {
          id: pendingMessage.messageId,
          role: "user",
          text: pendingMessage.text,
          createdAt: pendingMessage.createdAt,
          updatedAt: pendingMessage.createdAt,
          turnId: null,
          streaming: false,
        },
      })),
  ];
}
