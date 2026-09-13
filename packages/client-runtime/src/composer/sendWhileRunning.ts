/**
 * What the composer's primary action does while a turn is already running, in
 * the words the user reads. Every string a client shows for this lives here, so
 * web and mobile cannot describe the same provider differently, and so no
 * client has to hardcode a provider name or a behavior sentence.
 *
 * @module sendWhileRunning
 */
import type { ProviderConcurrentSend, ServerProvider, TurnDelivery } from "@t3tools/contracts";

import { resolveProviderInstanceDisplayName } from "../state/providerInstanceDisplay.ts";

/** `unknown` covers a server too old to report the capability, and a thread
    whose session provider we cannot resolve. Both mean the same to the user. */
export type SendWhileRunningDelivery = ProviderConcurrentSend | "unknown";

/** What the user last chose, keyed by BEHAVIOR CLASS rather than by provider:
    a user who learns they like queueing means it everywhere it means the same
    thing. An absent key takes the default below, so a changed default reaches
    everyone who never expressed a preference. */
export type SendWhileRunningPreferences = Partial<Record<SendWhileRunningDelivery, TurnDelivery>>;

export interface SendWhileRunningOption {
  readonly turnDelivery: TurnDelivery;
  /** Goes on the button face, and into the accessible name. */
  readonly label: string;
  readonly description: string;
  readonly destructive: boolean;
}

export interface SendWhileRunningAffordance {
  /** The session provider's behavior class. Also the preference key. */
  readonly behavior: SendWhileRunningDelivery;
  /** What plain Enter sends right now. Always one of `options`, by identity. */
  readonly selected: SendWhileRunningOption;
  /** What the one-shot modifier sends, or null when there is no choice to
      make. Always one of `options`, by identity, and never `selected`. */
  readonly alternate: SendWhileRunningOption | null;
  /** Every delivery this provider offers, in a fixed order, for a menu.
      Length 1 means there is no choice and a client renders no menu. */
  readonly options: readonly SendWhileRunningOption[];
  /** Non-null disables the action and replaces the accessible name. */
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
  /** Read straight from the client's persisted store. Pass a referentially
      stable object; a fresh one each render defeats the caller's memo. */
  readonly preferences?: SendWhileRunningPreferences;
}

/** T3 Code holds a queued message itself, so this reads the same whichever
    provider is running and names none of them. */
const queuedOption: SendWhileRunningOption = {
  turnDelivery: "queued",
  label: "Queue",
  description:
    "T3 Code holds it and sends it when this turn finishes. You can edit or remove it until then.",
  destructive: false,
};

/**
 * Build the affordance for a class where both deliveries are real, so
 * `selected`, `alternate` and `options` are derived once and cannot disagree.
 */
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

/** The one-delivery classes: a provider that refuses a concurrent send, and a
    server old enough that we cannot say, which also means it has no queue. */
function withoutChoice(
  behavior: SendWhileRunningDelivery,
  only: SendWhileRunningOption,
  blockedReason: string | null,
): SendWhileRunningAffordance {
  return { behavior, selected: only, alternate: null, options: [only], blockedReason };
}

/**
 * Returns null while the thread is idle, which means the composer renders its
 * usual send button and adds no extra chrome.
 */
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
      // Two of the three providers in this class are labelled by inference, so
      // the copy must not promise the message becomes the literal next turn.
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
