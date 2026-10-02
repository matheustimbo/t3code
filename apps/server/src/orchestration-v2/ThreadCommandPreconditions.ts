import { modelSelectionsEqual } from "@t3tools/shared/model";
import type {
  OrchestrationV2Command,
  OrchestrationV2Run,
  OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import type { ProjectRow } from "./ProjectStore.ts";

export function threadCommandPreconditionFailure(
  command: Extract<OrchestrationV2Command, { type: "thread.create" | "message.dispatch" }>,
  state: {
    readonly sequence: number;
    readonly project: ProjectRow | null;
    readonly thread: OrchestrationV2ThreadShell | null;
    readonly runs: ReadonlyArray<OrchestrationV2Run>;
  },
): string | null {
  const expected = command.preconditions;
  if (expected === undefined) return null;
  if (expected.snapshotSequence !== state.sequence)
    return "The environment changed after the command preview.";
  if (state.project === null || state.project.deletedAt !== null)
    return "The selected project is no longer active.";
  if (command.type === "thread.create") {
    if (state.thread !== null) return "The thread already exists.";
    if (
      command.projectId !== expected.projectId ||
      command.worktreePath !== null ||
      command.importedNativeThread !== undefined ||
      expected.workspace !== state.project.workspaceRoot
    )
      return "Guarded creation requires the selected project checkout.";
    if (
      command.runtimeMode !== expected.runtimeMode ||
      command.interactionMode !== expected.interactionMode ||
      !modelSelectionsEqual(command.modelSelection, expected.modelSelection)
    )
      return "The command does not match the preview.";
    return null;
  }
  const thread = state.thread;
  if (
    thread === null ||
    thread.projectId !== expected.projectId ||
    thread.deletedAt !== null ||
    thread.archivedAt !== null
  )
    return "The selected thread is no longer active in the project.";
  if (
    (thread.worktreePath ?? state.project.workspaceRoot) !== expected.workspace ||
    thread.runtimeMode !== expected.runtimeMode ||
    thread.interactionMode !== expected.interactionMode ||
    !modelSelectionsEqual(thread.modelSelection, expected.modelSelection)
  )
    return "The thread destination or permissions changed after the preview.";
  if (
    command.dispatchMode.type !== "start_immediately" ||
    command.deliveryIntent !== undefined ||
    command.notification !== undefined ||
    command.scheduledTaskId !== undefined ||
    command.senderThreadId !== undefined ||
    command.sourcePlanRef !== undefined ||
    command.restartContinuationOfRunId !== undefined ||
    command.usageLimitContinuationOfRunId !== undefined ||
    command.manualContinuationOfRunId !== undefined ||
    command.delegatedCompletion !== undefined ||
    (command.modelSelection !== undefined &&
      !modelSelectionsEqual(command.modelSelection, expected.modelSelection))
  )
    return "Guarded sends cannot steer, queue, switch providers, or deliver notifications.";
  if (
    state.runs.some((run) =>
      ["queued", "preparing", "starting", "running", "waiting"].includes(run.status),
    ) ||
    thread.activeRunId !== null ||
    thread.pendingRuntimeRequest !== null ||
    thread.hasActionableProposedPlan ||
    (thread.pendingBackgroundTasks?.length ?? 0) > 0
  )
    return "The thread has active or queued work or a pending decision.";
  return null;
}
