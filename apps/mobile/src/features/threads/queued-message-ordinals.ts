import { queuedMessageOrdinalMap } from "@t3tools/client-runtime/composer/queued-messages";
import type { QueuedMessageRef } from "@t3tools/contracts";

import type { PendingThreadFeedEntry } from "./pending-thread-feed";

const numberedRowsByEntry = new WeakMap<PendingThreadFeedEntry, PendingThreadFeedEntry>();

export function withQueuedMessageOrdinals(
  entries: ReadonlyArray<PendingThreadFeedEntry>,
  queuedMessages: ReadonlyArray<Pick<QueuedMessageRef, "messageId" | "revision">>,
): ReadonlyArray<PendingThreadFeedEntry> {
  const ordinals = queuedMessageOrdinalMap(queuedMessages);
  if (ordinals.size === 0) return entries;
  const edits = new Map(
    queuedMessages.map(
      (message) =>
        [
          message.messageId,
          { messageId: message.messageId, expectedRevision: message.revision },
        ] as const,
    ),
  );

  const numbered: PendingThreadFeedEntry[] = [];
  for (const entry of entries) {
    if (entry.type !== "message") {
      numbered.push(entry);
      continue;
    }
    const ordinal = ordinals.get(entry.message.id);
    if (ordinal === undefined) {
      numbered.push(entry);
      continue;
    }
    const edit = edits.get(entry.message.id);
    if (edit === undefined) {
      numbered.push(entry);
      continue;
    }
    const cached = numberedRowsByEntry.get(entry);
    if (
      cached?.queuedOrdinal === ordinal &&
      cached.queuedMessageEdit?.expectedRevision === edit.expectedRevision
    ) {
      numbered.push(cached);
      continue;
    }
    const row = { ...entry, queuedOrdinal: ordinal, queuedMessageEdit: edit };
    numberedRowsByEntry.set(entry, row);
    numbered.push(row);
  }
  return numbered;
}
