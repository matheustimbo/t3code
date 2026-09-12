/**
 * What the composer's primary action does while a turn is already running, in
 * the words the user reads. Every string a client shows for this lives here, so
 * web and mobile cannot describe the same provider differently, and so no
 * client has to hardcode a provider name or a behavior sentence.
 *
 * @module sendWhileRunning
 */
import type { ProviderConcurrentSend, ServerProvider } from "@t3tools/contracts";

import { resolveProviderInstanceDisplayName } from "../state/providerInstanceDisplay.ts";

/** `unknown` covers a server too old to report the capability, and a thread
    whose session provider we cannot resolve. Both mean the same to the user. */
export type SendWhileRunningDelivery = ProviderConcurrentSend | "unknown";

export interface SendWhileRunningOption {
  readonly delivery: SendWhileRunningDelivery;
  readonly label: string;
  readonly description: string;
  readonly destructive: boolean;
  readonly selected: boolean;
}

export interface SendWhileRunningAffordance {
  readonly delivery: SendWhileRunningDelivery;
  /** Goes on the button face, and into the accessible name. */
  readonly label: string;
  readonly description: string;
  readonly destructive: boolean;
  /** Non-null disables the action and replaces the accessible name. */
  readonly blockedReason: string | null;
  /** Deliveries the user could switch to. Empty until T3 owns a queue; a
      client reads its length to decide whether to grow a menu. */
  readonly options: readonly SendWhileRunningOption[];
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
}

const noOptions: readonly SendWhileRunningOption[] = [];

/**
 * Returns null while the thread is idle, which means the composer renders its
 * usual send button and adds no extra chrome.
 */
export function resolveSendWhileRunning(
  input: SendWhileRunningInput,
): SendWhileRunningAffordance | null {
  if (!input.isRunning) return null;

  if (input.provider === null) {
    return {
      delivery: "unknown",
      label: "Send",
      description:
        "T3 Code cannot tell what happens when you send this while the agent is working.",
      destructive: false,
      blockedReason: null,
      options: noOptions,
    };
  }

  const name = resolveProviderInstanceDisplayName(input.provider);

  switch (input.provider.concurrentSend) {
    case "steer":
      return {
        delivery: "steer",
        label: "Steer",
        description: `${name} reads it while it keeps working.`,
        destructive: false,
        blockedReason: null,
        options: noOptions,
      };
    case "provider-queue":
      return {
        delivery: "provider-queue",
        label: "Send next",
        description: `${name} takes it as its next turn. You cannot edit or remove it once it is sent.`,
        destructive: false,
        blockedReason: null,
        options: noOptions,
      };
    case "interrupt":
      return {
        delivery: "interrupt",
        label: "Interrupt",
        description: `Stops what ${name} is doing right now. Work in progress is lost.`,
        destructive: true,
        blockedReason: null,
        options: noOptions,
      };
    case "unsupported":
      return {
        delivery: "unsupported",
        label: "Send",
        description: `${name} cannot take a message while it is working. Wait for this turn to finish, or stop it first.`,
        destructive: false,
        blockedReason: `${name} cannot take a message while it is working.`,
        options: noOptions,
      };
    default:
      return {
        delivery: "unknown",
        label: "Send",
        description: `This server is too old to say what happens when you send while ${name} is working.`,
        destructive: false,
        blockedReason: null,
        options: noOptions,
      };
  }
}
