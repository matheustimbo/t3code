import { CommandId, EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { QueuedThreadMessage } from "../../state/thread-outbox-model";
import { appendPendingThreadMessages, type PendingThreadFeedEntry } from "./pending-thread-feed";
import { withQueuedMessageOrdinals } from "./queued-message-ordinals";

function message(id: string, role: "user" | "assistant", queued?: boolean): PendingThreadFeedEntry {
  return {
    type: "message",
    id,
    createdAt: "2026-09-06T10:00:00.000Z",
    message: {
      id: MessageId.make(id),
      role,
      text: id,
      createdAt: "2026-09-06T10:00:00.000Z",
      updatedAt: "2026-09-06T10:00:00.000Z",
      turnId: null,
      streaming: false,
      ...(queued === undefined ? {} : { queued }),
    },
  };
}

const outbox = (id: string): QueuedThreadMessage => ({
  environmentId: EnvironmentId.make("env"),
  threadId: ThreadId.make("thread"),
  messageId: MessageId.make(id),
  commandId: CommandId.make(id),
  text: id,
  attachments: [],
  createdAt: "2026-09-06T11:00:00.000Z",
});

const queue = (...ids: ReadonlyArray<string>) =>
  ids.map((messageId, revision) => ({ messageId: MessageId.make(messageId), revision }));

describe("queued message ordinals", () => {
  it("uses server queue order when client timestamps are skewed", () => {
    const entries = withQueuedMessageOrdinals(
      [
        message("sent", "user"),
        message("reply", "assistant"),
        message("second-queued", "user", true),
        message("also-sent", "user", false),
        message("first-queued", "user", true),
        message("third-queued", "user", true),
      ],
      queue("first-queued", "second-queued", "third-queued"),
    );

    expect(entries.map((entry) => [entry.id, entry.queuedOrdinal])).toEqual([
      ["sent", undefined],
      ["reply", undefined],
      ["second-queued", 2],
      ["also-sent", undefined],
      ["first-queued", 1],
      ["third-queued", 3],
    ]);
  });

  it("does not number outbox messages that have not reached the server", () => {
    const feed = [message("sent", "user"), message("queued", "user", true)];
    const entries = withQueuedMessageOrdinals(
      appendPendingThreadMessages(feed, feed, [outbox("pending")]),
      queue("queued"),
    );

    expect(entries.map((entry) => [entry.id, entry.queuedOrdinal])).toEqual([
      ["sent", undefined],
      ["queued", 1],
      ["pending", undefined],
    ]);
    expect(entries[2]?.pendingMessage?.text).toBe("pending");
  });

  it("returns the same array when nothing is queued", () => {
    const entries: ReadonlyArray<PendingThreadFeedEntry> = [
      message("sent", "user"),
      message("reply", "assistant"),
    ];
    expect(withQueuedMessageOrdinals(entries, [])).toBe(entries);
  });

  it("keeps row identity across rebuilds so streaming deltas do not rebuild rows", () => {
    const sent = message("sent", "user");
    const queued = message("queued", "user", true);
    const first = withQueuedMessageOrdinals([sent, queued], queue("queued"));
    const second = withQueuedMessageOrdinals(
      [sent, queued, message("reply", "assistant")],
      queue("queued"),
    );

    expect(second[0]).toBe(sent);
    expect(second[1]).toBe(first[1]);
    expect(second[1]?.queuedOrdinal).toBe(1);
  });

  it("renumbers a message when the one ahead of it leaves the queue", () => {
    const ahead = message("ahead", "user", true);
    const behind = message("behind", "user", true);
    expect(
      withQueuedMessageOrdinals([ahead, behind], queue("ahead", "behind"))[1]?.queuedOrdinal,
    ).toBe(2);
    expect(withQueuedMessageOrdinals([behind], queue("behind"))[0]?.queuedOrdinal).toBe(1);
  });

  it("binds the displayed message to its observed queue revision", () => {
    const queued = message("queued", "user", true);
    const first = withQueuedMessageOrdinals(
      [queued],
      [{ messageId: MessageId.make("queued"), revision: 0 }],
    );
    const second = withQueuedMessageOrdinals(
      [queued],
      [{ messageId: MessageId.make("queued"), revision: 1 }],
    );

    expect(first[0]?.queuedMessageEdit?.expectedRevision).toBe(0);
    expect(second[0]?.queuedMessageEdit?.expectedRevision).toBe(1);
    expect(second[0]).not.toBe(first[0]);
  });

  it("clears queued UI when the queue no longer contains a stale flagged message", () => {
    const stale = message("started", "user", true);
    const entries = [stale];

    expect(withQueuedMessageOrdinals(entries, [])).toBe(entries);
    expect(entries[0]?.queuedOrdinal).toBeUndefined();
  });
});
