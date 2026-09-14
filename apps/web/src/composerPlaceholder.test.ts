import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { resolveSendWhileRunning } from "@t3tools/client-runtime/composer/send-while-running";
import { describe, expect, it } from "vite-plus/test";

import { composerPlaceholder } from "./composerPlaceholder.ts";

const idle = {
  isApprovalState: false,
  approvalDetail: null,
  pendingQuestion: null,
  refiningPlan: false,
  projectSelectionRequired: false,
  providerUnavailable: false,
  disconnected: false,
  sendWhileRunning: null,
} as const;

const runningWith = (concurrentSend: "steer" | undefined) =>
  resolveSendWhileRunning({
    isRunning: true,
    provider: {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      driver: ProviderDriverKind.make("claudeAgent"),
      ...(concurrentSend ? { concurrentSend } : {}),
    },
  })!.placeholder;

describe("composerPlaceholder", () => {
  it("invites a first message while nothing is running", () => {
    expect(composerPlaceholder(idle)).toBe(
      "Ask anything, @tag files/folders, $use skills, or / for commands",
    );
  });

  it("names the delivery while a turn runs and the composer is empty", () => {
    expect(composerPlaceholder({ ...idle, sendWhileRunning: runningWith("steer") })).toBe(
      "Steer Claude while it keeps working",
    );
  });

  it("tells the user to restart or update a server that cannot name the delivery", () => {
    expect(composerPlaceholder({ ...idle, sendWhileRunning: runningWith(undefined) })).toBe(
      "Restart or update this server to see what sending does while Claude is working",
    );
  });

  it("lets an approval request speak over the running delivery", () => {
    expect(
      composerPlaceholder({
        ...idle,
        isApprovalState: true,
        approvalDetail: "Allow writing to src/index.ts?",
        sendWhileRunning: runningWith("steer"),
      }),
    ).toBe("Allow writing to src/index.ts?");
  });

  it("falls back to generic approval wording when the request carries no detail", () => {
    expect(composerPlaceholder({ ...idle, isApprovalState: true })).toBe(
      "Resolve this approval request to continue",
    );
  });

  it("points at the choices for a question that takes no typed answer", () => {
    expect(
      composerPlaceholder({
        ...idle,
        pendingQuestion: "choice-only",
        sendWhileRunning: runningWith("steer"),
      }),
    ).toBe("Choose an option above");
  });

  it("offers the blank-answer shortcut for a question that takes one", () => {
    expect(composerPlaceholder({ ...idle, pendingQuestion: "open" })).toBe(
      "Type your own answer, or leave this blank to use the selected option",
    );
  });

  it("asks for plan feedback over the running delivery", () => {
    expect(
      composerPlaceholder({ ...idle, refiningPlan: true, sendWhileRunning: runningWith("steer") }),
    ).toBe("Add feedback to refine the plan, or leave this blank to implement it");
  });

  it("asks for a project before anything else can be sent", () => {
    expect(composerPlaceholder({ ...idle, projectSelectionRequired: true })).toBe(
      "Choose a project above to start a thread",
    );
  });

  it("points at Settings when no provider is enabled", () => {
    expect(composerPlaceholder({ ...idle, providerUnavailable: true })).toBe(
      "Enable a provider in Settings to send a message",
    );
  });

  it("keeps the disconnected wording when the environment is gone", () => {
    expect(composerPlaceholder({ ...idle, disconnected: true })).toBe(
      "Ask for changes, send follow-ups, or attach images",
    );
  });
});
