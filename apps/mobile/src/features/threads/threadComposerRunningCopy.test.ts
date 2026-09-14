import { resolveSendWhileRunning } from "@t3tools/client-runtime/composer/send-while-running";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { threadComposerRunningCopy } from "./threadComposerRunningCopy.ts";

const IDLE = "Ask the repo agent, or run a command…";

const running = (concurrentSend: "steer" | "interrupt" | undefined) =>
  resolveSendWhileRunning({
    isRunning: true,
    provider: {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      driver: ProviderDriverKind.make("claudeAgent"),
      ...(concurrentSend ? { concurrentSend } : {}),
    },
  });

describe("threadComposerRunningCopy", () => {
  it("keeps the idle invitation while nothing is running", () => {
    expect(
      threadComposerRunningCopy({
        outboxSendLabel: "Send",
        sendWhileRunning: null,
        idlePlaceholder: IDLE,
      }),
    ).toEqual({ sendLabel: null, placeholder: IDLE });
  });

  it("names the delivery in the placeholder, where an empty draft can read it", () => {
    expect(
      threadComposerRunningCopy({
        outboxSendLabel: "Send",
        sendWhileRunning: running("steer"),
        idlePlaceholder: IDLE,
      }),
    ).toEqual({ sendLabel: "Steer", placeholder: "Steer Claude while it keeps working" });
  });

  it("warns before the tap that an interrupt costs work in progress", () => {
    expect(
      threadComposerRunningCopy({
        outboxSendLabel: "Send",
        sendWhileRunning: resolveSendWhileRunning({
          isRunning: true,
          provider: {
            instanceId: ProviderInstanceId.make("grok"),
            driver: ProviderDriverKind.make("grok"),
            concurrentSend: "interrupt",
          },
          preferences: { interrupt: "now" },
        }),
        idlePlaceholder: IDLE,
      }),
    ).toEqual({
      sendLabel: "Interrupt",
      placeholder: "Interrupt Grok and lose its work in progress",
    });
  });

  it("tells the user to restart or update a server that never named the delivery", () => {
    expect(
      threadComposerRunningCopy({
        outboxSendLabel: "Send",
        sendWhileRunning: running(undefined),
        idlePlaceholder: IDLE,
      }),
    ).toEqual({
      sendLabel: "Send anyway",
      placeholder: "Restart or update this server to see what sending does while Claude is working",
    });
  });

  it("does not dress an unnamed send as a named one", () => {
    const stale = threadComposerRunningCopy({
      outboxSendLabel: "Send",
      sendWhileRunning: running(undefined),
      idlePlaceholder: IDLE,
    });
    const named = threadComposerRunningCopy({
      outboxSendLabel: "Send",
      sendWhileRunning: running("steer"),
      idlePlaceholder: IDLE,
    });

    expect(stale.sendLabel).not.toBe(named.sendLabel);
    expect(stale.placeholder).not.toBe(named.placeholder);
  });

  it("lets the outbox describe delivery when it is the one holding the message", () => {
    expect(
      threadComposerRunningCopy({
        outboxSendLabel: "Queue",
        sendWhileRunning: running("steer"),
        idlePlaceholder: IDLE,
      }),
    ).toEqual({ sendLabel: null, placeholder: IDLE });
  });
});
