import type {
  MessageId,
  QueuedMessageRef,
  QueuedMessageUnavailableReason,
} from "@t3tools/contracts";

function ordinalSuffix(ordinal: number): string {
  if (ordinal % 100 >= 11 && ordinal % 100 <= 13) return "th";
  switch (ordinal % 10) {
    case 1:
      return "st";
    case 2:
      return "nd";
    case 3:
      return "rd";
    default:
      return "th";
  }
}

export function queuedMessageOrdinalMap(
  queuedMessages: ReadonlyArray<Pick<QueuedMessageRef, "messageId">>,
): ReadonlyMap<MessageId, number> {
  const ordinals = new Map<MessageId, number>();
  for (const [index, message] of queuedMessages.entries()) {
    ordinals.set(message.messageId, index + 1);
  }
  return ordinals;
}

export function queuedMessageStatus(ordinal: number): string {
  if (ordinal <= 1) return "Queued, sends next";
  return `Queued, ${ordinal}${ordinalSuffix(ordinal)} in line`;
}

export const QUEUED_MESSAGE_STATUS_DETAIL =
  "T3 Code sends this when the current turn finishes. You can edit or remove it until then.";

export const EDIT_QUEUED_MESSAGE_LABEL = "Edit";
export const EDIT_QUEUED_MESSAGE_ACCESSIBLE_LABEL = "Edit queued message";
export const REMOVE_QUEUED_MESSAGE_LABEL = "Remove from queue";

export function queuedMessageCountLabel(count: number): string {
  return count === 1 ? "1 message queued" : `${count} messages queued`;
}

export interface QueuedMessageUnavailableNotice {
  readonly title: string;
  readonly description: string;
}

export function queuedMessageActionFailureNotice(
  action: "edit" | "remove",
  error: unknown,
): QueuedMessageUnavailableNotice {
  return {
    title:
      action === "edit"
        ? "Could not save the queued message"
        : "Could not remove the queued message",
    description:
      error instanceof Error && error.message.length > 0
        ? error.message
        : "The server refused the request.",
  };
}

export function queuedMessageUnavailableNotice(
  reason: QueuedMessageUnavailableReason,
  action: "edit" | "remove",
): QueuedMessageUnavailableNotice {
  switch (reason) {
    case "already-sent":
      return {
        title: "Already sent",
        description:
          action === "edit"
            ? "This message went to the agent while you were editing it. Your text is still in the composer, so you can send it as a new message."
            : "This message went to the agent just before it could be removed.",
      };
    case "not-queued":
      return {
        title: "No longer queued",
        description:
          action === "edit"
            ? "This message is not waiting in the queue any more. Your text is still in the composer, so you can send it as a new message."
            : "This message is not waiting in the queue any more. It may have been removed on another device.",
      };
    case "stale-revision":
      return {
        title: "Edited somewhere else",
        description:
          action === "edit"
            ? "This message changed on another device while you were editing it. Your text is still in the composer, so you can send it as a new message, or edit the message again to start from the newer text."
            : "This message changed on another device. Open it again to see the newer text before removing it.",
      };
  }
}
