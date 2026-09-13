import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  values: new Map<unknown, unknown>(),
  draft: { text: "Existing draft", attachments: [] as { id: string }[] },
  mergeError: null as Error | null,
  flushes: 0,
}));

vi.mock("./atom-registry", () => ({
  appAtomRegistry: {
    get: (atom: unknown) => state.values.get(atom),
    set: (atom: unknown, value: unknown) => {
      state.values.set(atom, value);
    },
  },
}));
vi.mock("./threads", () => ({
  environmentThreads: {
    stateAtom: (environmentId: string, threadId: string) => `state:${environmentId}:${threadId}`,
  },
}));
vi.mock("./use-composer-drafts", () => ({
  waitForComposerDraftsLoaded: async () => {},
  getComposerDraftSnapshot: () => state.draft,
  mergeComposerDraftContent: async (_key: string, content: { text: string }) => {
    if (state.mergeError) throw state.mergeError;
    state.draft = { ...state.draft, text: `${state.draft.text}\n\n${content.text}` };
  },
  setComposerDraftText: (_key: string, text: string) => {
    state.draft = { ...state.draft, text };
  },
  flushComposerDrafts: async () => {
    state.flushes += 1;
  },
  undoComposerDraftMerge: async (_key: string, snapshot: typeof state.draft) => {
    state.draft = snapshot;
  },
}));

import {
  beginEditQueuedTurnMessage,
  editingQueuedTurnMessageId,
  editingQueuedTurnMessagesAtom,
  endEditQueuedTurnMessage,
  queuedTurnMessageRevision,
  replaceEditingQueuedTurnMessageDraftText,
} from "./edit-queued-thread-message";

const environmentId = EnvironmentId.make("env");
const threadId = ThreadId.make("thread");
const threadKey = "env:thread";
const first = MessageId.make("first");
const second = MessageId.make("second");

function seedQueue(entries: ReadonlyArray<{ messageId: MessageId; revision: number }>) {
  state.values.set(
    `state:${environmentId}:${threadId}`,
    AsyncResult.success({
      data: Option.some({
        queuedMessages: entries.map((entry) => ({
          messageId: entry.messageId,
          queuedTurnStart: "turn",
          createdAt: "2026-09-06T10:00:00.000Z",
          revision: entry.revision,
        })),
      }),
    }),
  );
}

beforeEach(() => {
  state.values.clear();
  state.values.set(editingQueuedTurnMessagesAtom, {});
  state.draft = { text: "Existing draft", attachments: [] };
  state.mergeError = null;
  state.flushes = 0;
  seedQueue([
    { messageId: first, revision: 3 },
    { messageId: second, revision: 0 },
  ]);
});

describe("editing a server-queued message", () => {
  it("reads the revision the server last accepted", () => {
    expect(queuedTurnMessageRevision({ environmentId, threadId, messageId: first })).toBe(3);
    expect(queuedTurnMessageRevision({ environmentId, threadId, messageId: second })).toBe(0);
    expect(
      queuedTurnMessageRevision({ environmentId, threadId, messageId: MessageId.make("gone") }),
    ).toBe(null);
  });

  it("loads the queued text into the draft and marks the thread as editing it", async () => {
    expect(
      await beginEditQueuedTurnMessage({
        environmentId,
        threadId,
        messageId: first,
        text: "Queued text",
      }),
    ).toBe("started");
    expect(state.draft.text).toBe("Existing draft\n\nQueued text");
    expect(state.flushes).toBe(1);
    expect(editingQueuedTurnMessageId(threadKey)).toBe(first);
  });

  it("refuses a second message rather than merging two into one draft", async () => {
    await beginEditQueuedTurnMessage({
      environmentId,
      threadId,
      messageId: first,
      text: "Queued text",
    });
    expect(
      await beginEditQueuedTurnMessage({
        environmentId,
        threadId,
        messageId: second,
        text: "Other text",
      }),
    ).toBe("already-editing");
    expect(state.draft.text).toBe("Existing draft\n\nQueued text");
    expect(editingQueuedTurnMessageId(threadKey)).toBe(first);
  });

  it("keeps editing when replacing all of the queued text", async () => {
    await beginEditQueuedTurnMessage({
      environmentId,
      threadId,
      messageId: first,
      text: "Queued text",
    });

    replaceEditingQueuedTurnMessageDraftText(threadKey, "");
    replaceEditingQueuedTurnMessageDraftText(threadKey, "Replacement text");

    expect(state.draft.text).toBe("Replacement text");
    expect(editingQueuedTurnMessageId(threadKey)).toBe(first);
  });

  it("cancels the edit without discarding the composer text", async () => {
    await beginEditQueuedTurnMessage({
      environmentId,
      threadId,
      messageId: first,
      text: "Queued text",
    });
    replaceEditingQueuedTurnMessageDraftText(threadKey, "Keep this draft");

    endEditQueuedTurnMessage(threadKey);

    expect(editingQueuedTurnMessageId(threadKey)).toBe(null);
    expect(state.draft.text).toBe("Keep this draft");
  });

  it("does not touch the draft for a message that left the queue", async () => {
    seedQueue([]);
    expect(
      await beginEditQueuedTurnMessage({
        environmentId,
        threadId,
        messageId: first,
        text: "Queued text",
      }),
    ).toBe("not-queued");
    expect(state.draft.text).toBe("Existing draft");
    expect(editingQueuedTurnMessageId(threadKey)).toBe(null);
  });

  it("rolls the draft back and stays out of edit mode when the merge fails", async () => {
    state.mergeError = new Error("disk error");
    await expect(
      beginEditQueuedTurnMessage({
        environmentId,
        threadId,
        messageId: first,
        text: "Queued text",
      }),
    ).rejects.toThrow("disk error");
    expect(state.draft.text).toBe("Existing draft");
    expect(editingQueuedTurnMessageId(threadKey)).toBe(null);
  });

  it("clears only the thread it is given", () => {
    state.values.set(editingQueuedTurnMessagesAtom, { [threadKey]: first, "env:other": second });
    endEditQueuedTurnMessage(threadKey);
    expect(state.values.get(editingQueuedTurnMessagesAtom)).toEqual({ "env:other": second });
  });
});
