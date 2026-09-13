import type { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import type { QueuedMessageEditSession } from "@t3tools/client-runtime/composer/queued-messages";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { scopedThreadKey } from "../lib/scopedEntities";
import { appAtomRegistry } from "./atom-registry";
import { environmentThreads } from "./threads";
import {
  flushComposerDrafts,
  getComposerDraftSnapshot,
  mergeComposerDraftContent,
  setComposerDraftText,
  undoComposerDraftMerge,
  waitForComposerDraftsLoaded,
} from "./use-composer-drafts";

export interface QueuedTurnMessageRef {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
}

/**
 * Which message already waiting in T3 Code's server-side queue each thread's
 * composer draft is currently editing. At most one per thread, because the
 * draft is per thread.
 *
 * Deliberately not `edit-pending-thread-message.ts`: that one edits the local
 * outbox by taking the message back out of it, which a queued message cannot
 * do without losing its place in line. This one leaves the message on the
 * server until the user sends the replacement text.
 */
export const editingQueuedTurnMessagesAtom = Atom.make<Record<string, QueuedMessageEditSession>>(
  {},
).pipe(Atom.keepAlive, Atom.withLabel("mobile:queued-turn:editing"));

export function editingQueuedTurnMessageId(threadKey: string): MessageId | null {
  return editingQueuedTurnMessage(threadKey)?.messageId ?? null;
}

export function editingQueuedTurnMessage(threadKey: string): QueuedMessageEditSession | null {
  return appAtomRegistry.get(editingQueuedTurnMessagesAtom)[threadKey] ?? null;
}

export function endEditQueuedTurnMessage(threadKey: string): void {
  const current = appAtomRegistry.get(editingQueuedTurnMessagesAtom);
  if (!(threadKey in current)) return;
  const { [threadKey]: _editing, ...rest } = current;
  appAtomRegistry.set(editingQueuedTurnMessagesAtom, rest);
}

export function replaceEditingQueuedTurnMessageDraftText(threadKey: string, text: string): void {
  if (editingQueuedTurnMessageId(threadKey) === null) return;
  setComposerDraftText(threadKey, text);
}

/** Read the current revision for an immediate action such as removal. */
export function queuedTurnMessageRevision(message: QueuedTurnMessageRef): number | null {
  const state = appAtomRegistry.get(
    environmentThreads.stateAtom(message.environmentId, message.threadId),
  );
  const thread = Option.flatMap(AsyncResult.value(state), (value) => value.data);
  if (Option.isNone(thread)) return null;
  const queued = thread.value.queuedMessages?.find(
    (candidate) => candidate.messageId === message.messageId,
  );
  return queued?.revision ?? null;
}

/** `already-editing` covers a second tap on either queued message in the same
    thread: one draft can only stand in for one of them, and its text is
    already loaded, so the caller just returns the user to the composer. */
export type BeginEditQueuedTurnMessage = "started" | "already-editing" | "not-queued";

/**
 * Move the queued text into the composer and mark the draft as editing it.
 * The message stays queued on the server meanwhile, so its place in line
 * survives an abandoned edit.
 */
export async function beginEditQueuedTurnMessage(
  message: QueuedTurnMessageRef & {
    readonly expectedRevision: number;
    readonly text: string;
  },
): Promise<BeginEditQueuedTurnMessage> {
  const draftKey = scopedThreadKey(message.environmentId, message.threadId);
  if (editingQueuedTurnMessageId(draftKey) !== null) return "already-editing";
  if (queuedTurnMessageRevision(message) === null) return "not-queued";
  await waitForComposerDraftsLoaded();
  const snapshot = getComposerDraftSnapshot(draftKey);
  let merged = snapshot;
  try {
    try {
      await mergeComposerDraftContent(draftKey, { text: message.text, attachments: [] });
    } finally {
      // Captured even on a throw, so a half-applied merge still has something
      // to roll back to what the user had typed.
      merged = getComposerDraftSnapshot(draftKey);
    }
    await flushComposerDrafts();
  } catch (error) {
    await undoComposerDraftMerge(draftKey, snapshot, merged);
    throw error;
  }
  appAtomRegistry.set(editingQueuedTurnMessagesAtom, {
    ...appAtomRegistry.get(editingQueuedTurnMessagesAtom),
    [draftKey]: {
      messageId: message.messageId,
      expectedRevision: message.expectedRevision,
    },
  });
  return "started";
}
