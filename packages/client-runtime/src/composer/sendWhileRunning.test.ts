import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveSendWhileRunning } from "./sendWhileRunning.ts";

type SessionProvider = Pick<
  ServerProvider,
  "instanceId" | "driver" | "displayName" | "concurrentSend"
>;

const provider = (
  driver: string,
  concurrentSend: SessionProvider["concurrentSend"],
  displayName?: string,
): SessionProvider => ({
  instanceId: ProviderInstanceId.make(driver),
  driver: ProviderDriverKind.make(driver),
  ...(displayName ? { displayName } : {}),
  ...(concurrentSend ? { concurrentSend } : {}),
});

describe("resolveSendWhileRunning while a turn runs", () => {
  it("names steering for Claude", () => {
    expect(
      resolveSendWhileRunning({ isRunning: true, provider: provider("claudeAgent", "steer") }),
    ).toEqual({
      delivery: "steer",
      label: "Steer",
      description: "Claude reads it while it keeps working.",
      destructive: false,
      blockedReason: null,
      options: [],
    });
  });

  it("warns that a provider queue cannot be taken back", () => {
    expect(
      resolveSendWhileRunning({ isRunning: true, provider: provider("codex", "provider-queue") }),
    ).toEqual({
      delivery: "provider-queue",
      label: "Send next",
      description: "Codex takes it as its next turn. You cannot edit or remove it once it is sent.",
      destructive: false,
      blockedReason: null,
      options: [],
    });
  });

  it("says plainly that an interrupt destroys work in progress", () => {
    expect(
      resolveSendWhileRunning({ isRunning: true, provider: provider("grok", "interrupt") }),
    ).toEqual({
      delivery: "interrupt",
      label: "Interrupt",
      description: "Stops what Grok is doing right now. Work in progress is lost.",
      destructive: true,
      blockedReason: null,
      options: [],
    });
  });

  it("blocks the action when the provider cannot take a concurrent send", () => {
    expect(
      resolveSendWhileRunning({ isRunning: true, provider: provider("cursor", "unsupported") }),
    ).toEqual({
      delivery: "unsupported",
      label: "Send",
      description:
        "Cursor cannot take a message while it is working. Wait for this turn to finish, or stop it first.",
      destructive: false,
      blockedReason: "Cursor cannot take a message while it is working.",
      options: [],
    });
  });

  it("admits the server is too old when the capability is absent", () => {
    expect(
      resolveSendWhileRunning({ isRunning: true, provider: provider("opencode", undefined) }),
    ).toEqual({
      delivery: "unknown",
      label: "Send",
      description:
        "This server is too old to say what happens when you send while OpenCode is working.",
      destructive: false,
      blockedReason: null,
      options: [],
    });
  });

  it("admits it cannot tell when the session provider is unknown", () => {
    expect(resolveSendWhileRunning({ isRunning: true, provider: null })).toEqual({
      delivery: "unknown",
      label: "Send",
      description:
        "T3 Code cannot tell what happens when you send this while the agent is working.",
      destructive: false,
      blockedReason: null,
      options: [],
    });
  });

  it("names the instance the user configured, not the driver brand", () => {
    const affordance = resolveSendWhileRunning({
      isRunning: true,
      provider: provider("codex", "provider-queue", "Codex Work"),
    });

    expect(affordance?.description).toBe(
      "Codex Work takes it as its next turn. You cannot edit or remove it once it is sent.",
    );
  });
});

describe("resolveSendWhileRunning while the thread is idle", () => {
  it("adds no chrome for any behavior class", () => {
    for (const concurrentSend of ["steer", "provider-queue", "interrupt", "unsupported"] as const) {
      expect(
        resolveSendWhileRunning({ isRunning: false, provider: provider("codex", concurrentSend) }),
      ).toBeNull();
    }
  });

  it("adds no chrome when the capability is absent or the provider is unknown", () => {
    expect(
      resolveSendWhileRunning({ isRunning: false, provider: provider("codex", undefined) }),
    ).toBeNull();
    expect(resolveSendWhileRunning({ isRunning: false, provider: null })).toBeNull();
  });
});
