export const DISCONNECTED_COMPOSER_PLACEHOLDER =
  "Ask for changes, send follow-ups, or attach images";

const IDLE_COMPOSER_PLACEHOLDER =
  "Ask anything, @tag files/folders, $use skills, or / for commands";

/**
 * What the empty composer says, in precedence order. The states that take the
 * composer over (an approval, a question, a plan to refine) speak first; the
 * running turn only reaches the placeholder once none of them apply.
 */
export function composerPlaceholder(input: {
  readonly isApprovalState: boolean;
  readonly approvalDetail: string | null;
  readonly pendingQuestion: "choice-only" | "open" | null;
  readonly refiningPlan: boolean;
  readonly projectSelectionRequired: boolean;
  readonly providerUnavailable: boolean;
  readonly disconnected: boolean;
  /**
   * What sending does while the turn runs. Null while idle, and null while a
   * queued message is being edited, where the primary action saves instead of
   * sending and naming a delivery would be a lie.
   */
  readonly sendWhileRunning: string | null;
}): string {
  if (input.isApprovalState) {
    return input.approvalDetail ?? "Resolve this approval request to continue";
  }
  if (input.pendingQuestion !== null) {
    return input.pendingQuestion === "choice-only"
      ? "Choose an option above"
      : "Type your own answer, or leave this blank to use the selected option";
  }
  if (input.refiningPlan) {
    return "Add feedback to refine the plan, or leave this blank to implement it";
  }
  if (input.projectSelectionRequired) {
    return "Choose a project above to start a thread";
  }
  if (input.providerUnavailable) {
    return "Enable a provider in Settings to send a message";
  }
  if (input.disconnected) {
    return DISCONNECTED_COMPOSER_PLACEHOLDER;
  }
  return input.sendWhileRunning ?? IDLE_COMPOSER_PLACEHOLDER;
}
