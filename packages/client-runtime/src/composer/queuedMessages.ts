/**
 * Every string a client shows for a message already waiting in T3 Code's own
 * queue, so web and mobile cannot word the same state differently and neither
 * has to invent copy for it. It lives beside `sendWhileRunning.ts` because the
 * edit flow runs back through the composer.
 *
 * @module queuedMessages
 */
import type { QueuedMessageUnavailableReason } from "@t3tools/contracts";

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

/** Status for the slot where a sent message shows its timestamp.
    `ordinal` is 1-based and counted client-side from the ordered message
    list; nothing stores queue position. */
export function queuedMessageStatus(ordinal: number): string {
  if (ordinal <= 1) return "Queued, sends next";
  return `Queued, ${ordinal}${ordinalSuffix(ordinal)} in line`;
}

/** Longer form, for a tooltip or a screen reader. */
export const QUEUED_MESSAGE_STATUS_DETAIL =
  "T3 Code sends this when the current turn finishes. You can edit or remove it until then.";

export const EDIT_QUEUED_MESSAGE_LABEL = "Edit";
export const EDIT_QUEUED_MESSAGE_ACCESSIBLE_LABEL = "Edit queued message";
export const REMOVE_QUEUED_MESSAGE_LABEL = "Remove from queue";

/** Count for a thread-list indicator. */
export function queuedMessageCountLabel(count: number): string {
  return count === 1 ? "1 message queued" : `${count} messages queued`;
}

export interface QueuedMessageUnavailableNotice {
  readonly title: string;
  readonly description: string;
}

/** The server refused an edit or a drop. The user must never lose typing to
    this, so the edit copy says in words where their text still is. */
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
