import { queuedMessageOrdinalMap } from "@t3tools/client-runtime/composer/queued-messages";
import type { QueuedMessageRef } from "@t3tools/contracts";

import type { PendingThreadFeedEntry } from "./pending-thread-feed";

const numberedRowsByEntry = new WeakMap<PendingThreadFeedEntry, PendingThreadFeedEntry>();

export function withQueuedMessageOrdinals(
  entries: ReadonlyArray<PendingThreadFeedEntry>,
  queuedMessages: ReadonlyArray<Pick<QueuedMessageRef, "messageId">>,
): ReadonlyArray<PendingThreadFeedEntry> {
  const ordinals = queuedMessageOrdinalMap(queuedMessages);
  if (ordinals.size === 0) return entries;

  const numbered: PendingThreadFeedEntry[] = [];
  for (const entry of entries) {
    const ordinal = entry.type === "message" ? ordinals.get(entry.message.id) : undefined;
    if (ordinal === undefined) {
      numbered.push(entry);
      continue;
    }
    const cached = numberedRowsByEntry.get(entry);
    if (cached?.queuedOrdinal === ordinal) {
      numbered.push(cached);
      continue;
    }
    const row = { ...entry, queuedOrdinal: ordinal };
    numberedRowsByEntry.set(entry, row);
    numbered.push(row);
  }
  return numbered;
}
