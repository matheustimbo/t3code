import { describe, expect, it } from "vite-plus/test";

import {
  queuedMessageActionFailureNotice,
  queuedMessageCountLabel,
  queuedMessageOrdinalMap,
  queuedMessageStatus,
  queuedMessageUnavailableNotice,
} from "./queuedMessages.ts";

describe("queuedMessageStatus", () => {
  it("says the first queued message goes next", () => {
    expect(queuedMessageStatus(1)).toBe("Queued, sends next");
  });

  it("counts the rest of the line in ordinals", () => {
    expect(queuedMessageStatus(2)).toBe("Queued, 2nd in line");
    expect(queuedMessageStatus(3)).toBe("Queued, 3rd in line");
    expect(queuedMessageStatus(4)).toBe("Queued, 4th in line");
  });

  it("uses th for the teens", () => {
    expect(queuedMessageStatus(11)).toBe("Queued, 11th in line");
    expect(queuedMessageStatus(12)).toBe("Queued, 12th in line");
    expect(queuedMessageStatus(13)).toBe("Queued, 13th in line");
  });

  it("returns to st, nd and rd past the teens", () => {
    expect(queuedMessageStatus(21)).toBe("Queued, 21st in line");
    expect(queuedMessageStatus(22)).toBe("Queued, 22nd in line");
    expect(queuedMessageStatus(23)).toBe("Queued, 23rd in line");
  });

  it("reads the last two digits, not the last one, past a hundred", () => {
    expect(queuedMessageStatus(101)).toBe("Queued, 101st in line");
    expect(queuedMessageStatus(111)).toBe("Queued, 111th in line");
  });

  it("clamps a caller's off-by-one to the first position", () => {
    expect(queuedMessageStatus(0)).toBe("Queued, sends next");
  });
});

describe("queuedMessageOrdinalMap", () => {
  it("uses the server queue order instead of client timestamps", () => {
    const ordinals = queuedMessageOrdinalMap([
      { messageId: "newer-client-clock" as never },
      { messageId: "older-client-clock" as never },
    ]);

    expect([...ordinals]).toEqual([
      ["newer-client-clock", 1],
      ["older-client-clock", 2],
    ]);
  });
});

describe("queuedMessageCountLabel", () => {
  it("keeps one message singular", () => {
    expect(queuedMessageCountLabel(1)).toBe("1 message queued");
  });

  it("pluralizes the rest", () => {
    expect(queuedMessageCountLabel(3)).toBe("3 messages queued");
  });
});

describe("queuedMessageUnavailableNotice", () => {
  it("tells an editing user their text is still in the composer after a send", () => {
    expect(queuedMessageUnavailableNotice("already-sent", "edit")).toEqual({
      title: "Already sent",
      description:
        "This message went to the agent while you were editing it. Your text is still in the composer, so you can send it as a new message.",
    });
  });

  it("says a removal lost the race", () => {
    expect(queuedMessageUnavailableNotice("already-sent", "remove")).toEqual({
      title: "Already sent",
      description: "This message went to the agent just before it could be removed.",
    });
  });

  it("keeps the edited text when the message left the queue", () => {
    expect(queuedMessageUnavailableNotice("not-queued", "edit")).toEqual({
      title: "No longer queued",
      description:
        "This message is not waiting in the queue any more. Your text is still in the composer, so you can send it as a new message.",
    });
  });

  it("points at another device when a removal finds nothing queued", () => {
    expect(queuedMessageUnavailableNotice("not-queued", "remove")).toEqual({
      title: "No longer queued",
      description:
        "This message is not waiting in the queue any more. It may have been removed on another device.",
    });
  });

  it("offers both ways out when the message changed under an edit", () => {
    expect(queuedMessageUnavailableNotice("stale-revision", "edit")).toEqual({
      title: "Edited somewhere else",
      description:
        "This message changed on another device while you were editing it. Your text is still in the composer, so you can send it as a new message, or edit the message again to start from the newer text.",
    });
  });

  it("asks for a second look before removing text the user has not seen", () => {
    expect(queuedMessageUnavailableNotice("stale-revision", "remove")).toEqual({
      title: "Edited somewhere else",
      description:
        "This message changed on another device. Open it again to see the newer text before removing it.",
    });
  });
});

describe("queuedMessageActionFailureNotice", () => {
  it("keeps the server error for a failed edit", () => {
    expect(queuedMessageActionFailureNotice("edit", new Error("Connection lost"))).toEqual({
      title: "Could not save the queued message",
      description: "Connection lost",
    });
  });

  it("uses stable copy when a failure has no message", () => {
    expect(queuedMessageActionFailureNotice("remove", {})).toEqual({
      title: "Could not remove the queued message",
      description: "The server refused the request.",
    });
  });
});
