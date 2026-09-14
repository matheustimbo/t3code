import type { SendWhileRunningAffordance } from "@t3tools/client-runtime/composer/send-while-running";

/**
 * What the composer says about sending into a turn that is already running.
 * The send button carries the label only once there is something to send, so
 * with an empty draft the placeholder is the only place the delivery gets a
 * name, and mobile has no Enter key to guess with.
 */
export function threadComposerRunningCopy(input: {
  /** "Send" when the outbox would hand the message over right away. Anything
   *  else describes real delivery already and outranks the provider wording. */
  readonly outboxSendLabel: string;
  readonly sendWhileRunning: Pick<SendWhileRunningAffordance, "selected" | "placeholder"> | null;
  readonly idlePlaceholder: string;
}): { readonly sendLabel: string | null; readonly placeholder: string } {
  if (input.outboxSendLabel !== "Send" || input.sendWhileRunning === null) {
    return { sendLabel: null, placeholder: input.idlePlaceholder };
  }
  return {
    sendLabel: input.sendWhileRunning.selected.label,
    placeholder: input.sendWhileRunning.placeholder,
  };
}
