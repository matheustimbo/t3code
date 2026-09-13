import type { ProviderConcurrentSend, ServerProvider, TurnDelivery } from "@t3tools/contracts";

import { resolveProviderInstanceDisplayName } from "../state/providerInstanceDisplay.ts";

export type SendWhileRunningDelivery = ProviderConcurrentSend | "unknown";

export type SendWhileRunningPreferences = Partial<Record<SendWhileRunningDelivery, TurnDelivery>>;

export interface SendWhileRunningOption {
  readonly turnDelivery: TurnDelivery;
  readonly label: string;
  readonly description: string;
  readonly destructive: boolean;
}

export interface SendWhileRunningAffordance {
  readonly behavior: SendWhileRunningDelivery;
  readonly selected: SendWhileRunningOption;
  readonly alternate: SendWhileRunningOption | null;
  readonly options: readonly SendWhileRunningOption[];
  readonly blockedReason: string | null;
}

export interface SendWhileRunningInput {
  readonly isRunning: boolean;
  /**
   * The provider bound to the running session, never the composer's current
   * selection. The running turn belongs to the session's provider, so naming
   * the selected one would be a lying label.
   */
  readonly provider: Pick<
    ServerProvider,
    "instanceId" | "driver" | "displayName" | "concurrentSend"
  > | null;
  readonly preferences?: SendWhileRunningPreferences;
}

const queuedOption: SendWhileRunningOption = {
  turnDelivery: "queued",
  label: "Queue",
  description:
    "T3 Code holds it and sends it when this turn finishes. You can edit or remove it until then.",
  destructive: false,
};

function withQueueChoice(
  behavior: SendWhileRunningDelivery,
  now: SendWhileRunningOption,
  fallback: TurnDelivery,
  preferences: SendWhileRunningPreferences | undefined,
): SendWhileRunningAffordance {
  const chosen = preferences?.[behavior] ?? fallback;
  const selected = chosen === "queued" ? queuedOption : now;
  return {
    behavior,
    selected,
    alternate: selected === now ? queuedOption : now,
    options: [now, queuedOption],
    blockedReason: null,
  };
}

function withoutChoice(
  behavior: SendWhileRunningDelivery,
  only: SendWhileRunningOption,
  blockedReason: string | null,
): SendWhileRunningAffordance {
  return { behavior, selected: only, alternate: null, options: [only], blockedReason };
}

export function resolveSendWhileRunning(
  input: SendWhileRunningInput,
): SendWhileRunningAffordance | null {
  if (!input.isRunning) return null;

  if (input.provider === null) {
    return withoutChoice(
      "unknown",
      {
        turnDelivery: "now",
        label: "Send",
        description:
          "T3 Code cannot tell what happens when you send this while the agent is working.",
        destructive: false,
      },
      null,
    );
  }

  const name = resolveProviderInstanceDisplayName(input.provider);

  switch (input.provider.concurrentSend) {
    case "steer":
      return withQueueChoice(
        "steer",
        {
          turnDelivery: "now",
          label: "Steer",
          description: `${name} reads it while it keeps working.`,
          destructive: false,
        },
        "now",
        input.preferences,
      );
    case "provider-queue":
      return withQueueChoice(
        "provider-queue",
        {
          turnDelivery: "now",
          label: "Send now",
          description: `Goes to ${name} now. ${name} decides when it reads it, and you cannot edit or remove it after that.`,
          destructive: false,
        },
        "queued",
        input.preferences,
      );
    case "interrupt":
      return withQueueChoice(
        "interrupt",
        {
          turnDelivery: "now",
          label: "Interrupt",
          description: `Stops what ${name} is doing right now. Work in progress is lost.`,
          destructive: true,
        },
        "queued",
        input.preferences,
      );
    case "unsupported":
      return withoutChoice(
        "unsupported",
        {
          turnDelivery: "now",
          label: "Send",
          description: `${name} cannot take a message while it is working. Wait for this turn to finish, or stop it first.`,
          destructive: false,
        },
        `${name} cannot take a message while it is working.`,
      );
    default:
      return withoutChoice(
        "unknown",
        {
          turnDelivery: "now",
          label: "Send",
          description: `This server is too old to say what happens when you send while ${name} is working.`,
          destructive: false,
        },
        null,
      );
  }
}
