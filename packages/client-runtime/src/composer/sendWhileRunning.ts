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
  /**
   * What the composer says while the turn runs and the draft is still empty.
   * A labeled control needs something to send before it can name the delivery,
   * and the empty composer is exactly where the user decides whether to type,
   * so the name has to reach them here or it never does.
   */
  readonly placeholder: string;
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

const queuedPlaceholder = "Queue a message for when this turn finishes";

function withQueueChoice(
  behavior: SendWhileRunningDelivery,
  now: SendWhileRunningOption,
  nowPlaceholder: string,
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
    placeholder: selected === now ? nowPlaceholder : queuedPlaceholder,
  };
}

function withoutChoice(
  behavior: SendWhileRunningDelivery,
  only: SendWhileRunningOption,
  blockedReason: string | null,
  placeholder: string,
): SendWhileRunningAffordance {
  return {
    behavior,
    selected: only,
    alternate: null,
    options: [only],
    blockedReason,
    placeholder,
  };
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
        label: "Send anyway",
        description:
          "T3 Code cannot tell what happens when you send this while the agent is working.",
        destructive: false,
      },
      null,
      "T3 Code cannot tell what sending does while the agent is working",
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
        `Steer ${name} while it keeps working`,
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
        `Send to ${name} now, while it keeps working`,
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
        `Interrupt ${name} and lose its work in progress`,
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
        `${name} cannot take a message until this turn finishes`,
      );
    // A server that predates the capability. The send still works, so this
    // stays enabled and says the one thing that would fix it instead.
    default:
      return withoutChoice(
        "unknown",
        {
          turnDelivery: "now",
          label: "Send anyway",
          description: `Restart or update this server to see what sending does while ${name} is working. Until then T3 Code cannot say.`,
          destructive: false,
        },
        null,
        `Restart or update this server to see what sending does while ${name} is working`,
      );
  }
}
