import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveSendWhileRunning, type SendWhileRunningOption } from "./sendWhileRunning.ts";

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

const queueOption: SendWhileRunningOption = {
  turnDelivery: "queued",
  label: "Queue",
  description:
    "T3 Code holds it and sends it when this turn finishes. You can edit or remove it until then.",
  destructive: false,
};

const steerNow: SendWhileRunningOption = {
  turnDelivery: "now",
  label: "Steer",
  description: "Claude reads it while it keeps working.",
  destructive: false,
};

const codexNow: SendWhileRunningOption = {
  turnDelivery: "now",
  label: "Send now",
  description:
    "Goes to Codex now. Codex decides when it reads it, and you cannot edit or remove it after that.",
  destructive: false,
};

const grokNow: SendWhileRunningOption = {
  turnDelivery: "now",
  label: "Interrupt",
  description: "Stops what Grok is doing right now. Work in progress is lost.",
  destructive: true,
};

describe("resolveSendWhileRunning with no stored preference", () => {
  it("keeps steering as the default for a provider that reads mid-turn", () => {
    expect(
      resolveSendWhileRunning({ isRunning: true, provider: provider("claudeAgent", "steer") }),
    ).toEqual({
      behavior: "steer",
      selected: steerNow,
      alternate: queueOption,
      options: [steerNow, queueOption],
      blockedReason: null,
    });
  });

  it("prefers T3's queue over a provider queue nobody can see into", () => {
    expect(
      resolveSendWhileRunning({ isRunning: true, provider: provider("codex", "provider-queue") }),
    ).toEqual({
      behavior: "provider-queue",
      selected: queueOption,
      alternate: codexNow,
      options: [codexNow, queueOption],
      blockedReason: null,
    });
  });

  it("prefers queueing over destroying work in progress", () => {
    expect(
      resolveSendWhileRunning({ isRunning: true, provider: provider("grok", "interrupt") }),
    ).toEqual({
      behavior: "interrupt",
      selected: queueOption,
      alternate: grokNow,
      options: [grokNow, queueOption],
      blockedReason: null,
    });
  });
});

describe("resolveSendWhileRunning with a stored preference", () => {
  it("queues for a steering provider when the user asked for that", () => {
    expect(
      resolveSendWhileRunning({
        isRunning: true,
        provider: provider("claudeAgent", "steer"),
        preferences: { steer: "queued" },
      }),
    ).toEqual({
      behavior: "steer",
      selected: queueOption,
      alternate: steerNow,
      options: [steerNow, queueOption],
      blockedReason: null,
    });
  });

  it("hands a provider queue the message when the user asked for that", () => {
    expect(
      resolveSendWhileRunning({
        isRunning: true,
        provider: provider("codex", "provider-queue"),
        preferences: { "provider-queue": "now" },
      }),
    ).toEqual({
      behavior: "provider-queue",
      selected: codexNow,
      alternate: queueOption,
      options: [codexNow, queueOption],
      blockedReason: null,
    });
  });

  it("interrupts when the user asked for that", () => {
    expect(
      resolveSendWhileRunning({
        isRunning: true,
        provider: provider("grok", "interrupt"),
        preferences: { interrupt: "now" },
      }),
    ).toEqual({
      behavior: "interrupt",
      selected: grokNow,
      alternate: queueOption,
      options: [grokNow, queueOption],
      blockedReason: null,
    });
  });

  it("reads only the running provider's behavior class", () => {
    const affordance = resolveSendWhileRunning({
      isRunning: true,
      provider: provider("claudeAgent", "steer"),
      preferences: { interrupt: "now", "provider-queue": "now" },
    });

    expect(affordance?.selected).toEqual(steerNow);
    expect(affordance?.alternate).toEqual(queueOption);
  });

  it("ignores a queue preference for a provider that cannot take a send at all", () => {
    expect(
      resolveSendWhileRunning({
        isRunning: true,
        provider: provider("cursor", "unsupported"),
        preferences: { unsupported: "queued" },
      }),
    ).toEqual({
      behavior: "unsupported",
      selected: {
        turnDelivery: "now",
        label: "Send",
        description:
          "Cursor cannot take a message while it is working. Wait for this turn to finish, or stop it first.",
        destructive: false,
      },
      alternate: null,
      options: [
        {
          turnDelivery: "now",
          label: "Send",
          description:
            "Cursor cannot take a message while it is working. Wait for this turn to finish, or stop it first.",
          destructive: false,
        },
      ],
      blockedReason: "Cursor cannot take a message while it is working.",
    });
  });
});

describe("resolveSendWhileRunning option identity", () => {
  it("points selected and alternate at the two entries of options", () => {
    const affordance = resolveSendWhileRunning({
      isRunning: true,
      provider: provider("grok", "interrupt"),
    })!;

    expect(affordance.options).toHaveLength(2);
    expect(affordance.selected).toBe(affordance.options[1]);
    expect(affordance.alternate).toBe(affordance.options[0]);
  });

  it("swaps the same two objects when the preference flips", () => {
    const affordance = resolveSendWhileRunning({
      isRunning: true,
      provider: provider("grok", "interrupt"),
      preferences: { interrupt: "now" },
    })!;

    expect(affordance.selected).toBe(affordance.options[0]);
    expect(affordance.alternate).toBe(affordance.options[1]);
  });

  it("points selected at the only option when there is no choice", () => {
    const affordance = resolveSendWhileRunning({
      isRunning: true,
      provider: provider("cursor", "unsupported"),
    })!;

    expect(affordance.options).toHaveLength(1);
    expect(affordance.selected).toBe(affordance.options[0]);
    expect(affordance.alternate).toBeNull();
  });
});

describe("resolveSendWhileRunning when the capability is missing", () => {
  it("offers no queue on a server too old to describe itself", () => {
    expect(
      resolveSendWhileRunning({ isRunning: true, provider: provider("opencode", undefined) }),
    ).toEqual({
      behavior: "unknown",
      selected: {
        turnDelivery: "now",
        label: "Send",
        description:
          "This server is too old to say what happens when you send while OpenCode is working.",
        destructive: false,
      },
      alternate: null,
      options: [
        {
          turnDelivery: "now",
          label: "Send",
          description:
            "This server is too old to say what happens when you send while OpenCode is working.",
          destructive: false,
        },
      ],
      blockedReason: null,
    });
  });

  it("admits it cannot tell when the session provider is unknown", () => {
    expect(resolveSendWhileRunning({ isRunning: true, provider: null })).toEqual({
      behavior: "unknown",
      selected: {
        turnDelivery: "now",
        label: "Send",
        description:
          "T3 Code cannot tell what happens when you send this while the agent is working.",
        destructive: false,
      },
      alternate: null,
      options: [
        {
          turnDelivery: "now",
          label: "Send",
          description:
            "T3 Code cannot tell what happens when you send this while the agent is working.",
          destructive: false,
        },
      ],
      blockedReason: null,
    });
  });
});

describe("resolveSendWhileRunning naming", () => {
  it("names the instance the user configured, not the driver brand", () => {
    const affordance = resolveSendWhileRunning({
      isRunning: true,
      provider: provider("codex", "provider-queue", "Codex Work"),
    });

    expect(affordance?.alternate?.description).toBe(
      "Goes to Codex Work now. Codex Work decides when it reads it, and you cannot edit or remove it after that.",
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
