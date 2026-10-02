import {
  CommandId,
  MessageId,
  ModelSelection,
  ProjectId,
  RuntimeMode,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
  type ClientOrchestrationCommand,
  type OrchestrationProjectShell,
  type OrchestrationShellSnapshot,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag } from "effect/unstable/cli";

import {
  connectRemote,
  printRemoteResult,
  remoteError,
  remoteFlags,
  reportRemoteErrors,
  withRemoteTransport,
  type RemoteClient,
  type RemoteCliError,
} from "./remoteClient.ts";

const projectFlag = Flag.String("project").pipe(Flag.withSchema(ProjectId));
const threadArgument = Argument.String("thread-id").pipe(Argument.withSchema(ThreadId));
const workspaceFlag = Flag.String("workspace").pipe(
  Flag.withDescription(
    "Exact expected working directory on the server, from thread status or project list.",
  ),
);
const executeFlag = Flag.Boolean("execute").pipe(
  Flag.withDefault(false),
  Flag.withDescription("Dispatch the validated mutation. Without this flag, only print a preview."),
);
const runtimeModeFlag = Flag.Literals("runtime-mode", RuntimeMode.literals);
const decodeModelSelection = Schema.decodeUnknownEffect(ModelSelection);
const decodeTurnStartFailure = Schema.decodeUnknownOption(Schema.Struct({ requestId: MessageId }));

export const requireProject = (snapshot: OrchestrationShellSnapshot, projectId: ProjectId) => {
  const project = snapshot.projects.find((entry) => entry.id === projectId);
  return project === undefined
    ? Effect.fail(
        remoteError(
          "project_not_found",
          "The selected active project does not exist in this environment.",
        ),
      )
    : Effect.succeed(project);
};

const requireThread = Effect.fn("requireRemoteCliThread")(function* (
  snapshot: OrchestrationShellSnapshot,
  projectId: ProjectId,
  threadId: ThreadId,
) {
  const project = yield* requireProject(snapshot, projectId);
  const thread = snapshot.threads.find((entry) => entry.id === threadId);
  if (thread === undefined || thread.projectId !== project.id) {
    return yield* remoteError(
      "thread_not_found",
      "The selected thread does not belong to the selected active project.",
    );
  }
  return { project, thread };
});

const threadSummary = (project: OrchestrationProjectShell, thread: OrchestrationThreadShell) => ({
  id: thread.id,
  projectId: thread.projectId,
  title: thread.title,
  workspace: thread.worktreePath ?? project.workspaceRoot,
  worktreePath: thread.worktreePath,
  branch: thread.branch,
  runtimeMode: thread.runtimeMode,
  interactionMode: thread.interactionMode,
  modelSelection: thread.modelSelection,
  latestTurn: thread.latestTurn,
  sessionStatus: thread.session?.status ?? null,
  hasPendingApprovals: thread.hasPendingApprovals,
  hasPendingUserInput: thread.hasPendingUserInput,
  hasActionableProposedPlan: thread.hasActionableProposedPlan,
  backgroundLiveness: thread.backgroundLiveness ?? null,
  archivedAt: thread.archivedAt,
});

const ensureWorkspace = (expected: string, actual: string) =>
  expected === actual
    ? Effect.void
    : Effect.fail(
        remoteError(
          "workspace_mismatch",
          "--workspace must exactly match the selected server working directory.",
        ),
      );

export const ensureThreadCanReceivePrompt = (thread: OrchestrationThreadShell) => {
  if (thread.archivedAt !== null) {
    return Effect.fail(
      remoteError("thread_archived", "Use an active thread; this CLI does not unarchive threads."),
    );
  }
  if (
    thread.latestTurn?.state === "running" ||
    thread.session?.status === "starting" ||
    thread.session?.status === "running" ||
    thread.backgroundLiveness != null ||
    thread.hasPendingApprovals ||
    thread.hasPendingUserInput ||
    thread.hasActionableProposedPlan ||
    (thread.latestUserMessageAt !== null &&
      (thread.latestTurn === null || thread.latestUserMessageAt > thread.latestTurn.requestedAt))
  ) {
    return Effect.fail(
      remoteError(
        "thread_needs_attention",
        "The thread has active or queued work, background work, or a pending decision. Resolve it before sending another prompt.",
      ),
    );
  }
  return Effect.void;
};

const uuid = Crypto.Crypto.pipe(
  Effect.flatMap((crypto) => crypto.randomUUIDv4),
  Effect.mapError(() =>
    remoteError("identifier_generation", "Could not generate a command identifier."),
  ),
);

export const projectListCommand = Command.make("list", { ...remoteFlags }).pipe(
  Command.withDescription(
    "List active projects on an explicitly selected server using only orchestration:read.",
  ),
  Command.withHandler((flags) =>
    withRemoteTransport(
      reportRemoteErrors(
        flags.json,
        Effect.gen(function* () {
          const client = yield* connectRemote(flags, "read");
          const snapshot = yield* client.shell();
          const projects = snapshot.projects.map(
            ({ id, title, workspaceRoot, defaultModelSelection }) => ({
              id,
              title,
              workspaceRoot,
              defaultModelSelection,
            }),
          );
          yield* printRemoteResult(
            flags.json,
            { ok: true, environment: client.descriptor, projects },
            `Environment ${client.descriptor.environmentId} (${client.descriptor.label}, ${client.descriptor.serverVersion})\n${projects.map((p) => `${p.id}\t${p.title}\t${p.workspaceRoot}`).join("\n")}`,
          );
        }),
      ),
    ),
  ),
);

const threadListCommand = Command.make("list", { ...remoteFlags, project: projectFlag }).pipe(
  Command.withDescription(
    "List thread metadata in one explicit project; does not read conversation bodies.",
  ),
  Command.withHandler((flags) =>
    withRemoteTransport(
      reportRemoteErrors(
        flags.json,
        Effect.gen(function* () {
          const client = yield* connectRemote(flags, "read");
          const snapshot = yield* client.shell();
          const project = yield* requireProject(snapshot, flags.project);
          const threads = snapshot.threads
            .filter((thread) => thread.projectId === project.id)
            .map((thread) => threadSummary(project, thread));
          yield* printRemoteResult(
            flags.json,
            {
              ok: true,
              environmentId: client.descriptor.environmentId,
              projectId: project.id,
              threads,
            },
            threads
              .map(
                (thread) =>
                  `${thread.id}\t${thread.title}\t${thread.latestTurn?.state ?? "idle"}\t${thread.workspace}`,
              )
              .join("\n"),
          );
        }),
      ),
    ),
  ),
);

const threadCreateCommand = Command.make("create", {
  ...remoteFlags,
  project: projectFlag,
  workspace: workspaceFlag,
  title: Flag.String("title").pipe(Flag.withSchema(TrimmedNonEmptyString)),
  instance: Flag.String("instance").pipe(Flag.optional),
  model: Flag.String("model").pipe(Flag.optional),
  runtimeMode: runtimeModeFlag.pipe(Flag.withDefault("approval-required")),
  execute: executeFlag,
}).pipe(
  Command.withDescription(
    "Preview or create an empty thread in the project checkout. Does not start a provider.",
  ),
  Command.withHandler((flags) =>
    withRemoteTransport(
      reportRemoteErrors(
        flags.json,
        Effect.gen(function* () {
          const client = yield* connectRemote(flags, flags.execute ? "operate" : "read");
          if (Option.isNone(flags.environmentId))
            return yield* remoteError(
              "destination_required",
              "Thread creation requires --environment-id even for a preview.",
            );
          const snapshot = yield* client.shell();
          const project = yield* requireProject(snapshot, flags.project);
          yield* ensureWorkspace(flags.workspace, project.workspaceRoot);
          if (Option.isSome(flags.instance) !== Option.isSome(flags.model)) {
            return yield* remoteError(
              "model_selection",
              "Supply both --instance and --model, or use the project default.",
            );
          }
          const selected =
            Option.isSome(flags.instance) && Option.isSome(flags.model)
              ? { instanceId: flags.instance.value, model: flags.model.value }
              : project.defaultModelSelection;
          if (selected === null)
            return yield* remoteError(
              "model_selection",
              "The project has no default model; supply --instance and --model.",
            );
          const modelSelection = yield* decodeModelSelection(selected).pipe(
            Effect.mapError(() =>
              remoteError("model_selection", "Invalid provider instance or model selection."),
            ),
          );
          const command = {
            type: "thread.create",
            expectedSnapshotSequence: snapshot.snapshotSequence,
            commandId: CommandId.make(yield* uuid),
            threadId: ThreadId.make(yield* uuid),
            projectId: project.id,
            title: flags.title,
            modelSelection,
            runtimeMode: flags.runtimeMode,
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt: DateTime.formatIso(yield* DateTime.now),
          } satisfies ClientOrchestrationCommand;
          const receipt = flags.execute ? yield* client.dispatch(command) : null;
          yield* printRemoteResult(
            flags.json,
            {
              ok: true,
              executed: flags.execute,
              environmentId: client.descriptor.environmentId,
              workspace: project.workspaceRoot,
              command,
              receipt,
            },
            `${flags.execute ? "Accepted creation of" : "Preview:"} empty thread ${command.threadId} in ${project.id} at ${project.workspaceRoot} (${command.runtimeMode}).`,
          );
        }),
      ),
    ),
  ),
);

const readPrompt = Effect.fn("readRemoteCliPrompt")(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  const failure = () =>
    remoteError("prompt_input", "--prompt-file must be a nonempty UTF-8 file of at most 1 MiB.");
  const stat = yield* fs.stat(path).pipe(Effect.mapError(failure));
  if (stat.type !== "File" || stat.size > 1_048_576) return yield* failure();
  const bytes = yield* fs.readFile(path).pipe(Effect.mapError(failure));
  const text = yield* Effect.try({
    try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    catch: failure,
  });
  if (text.trim().length === 0 || new TextEncoder().encode(text).length > 1_048_576)
    return yield* failure();
  return text;
});

const threadSendCommand = Command.make("send", {
  ...remoteFlags,
  threadId: threadArgument,
  project: projectFlag,
  workspace: workspaceFlag,
  runtimeMode: runtimeModeFlag,
  promptFile: Flag.String("prompt-file"),
  execute: executeFlag,
}).pipe(
  Command.withDescription(
    "Preview or send a prompt to one idle thread. --execute starts provider work on the server.",
  ),
  Command.withHandler((flags) =>
    withRemoteTransport(
      reportRemoteErrors(
        flags.json,
        Effect.gen(function* () {
          if (Option.isNone(flags.environmentId))
            return yield* remoteError(
              "destination_required",
              "Sending requires --environment-id even for a preview.",
            );
          const client = yield* connectRemote(flags, flags.execute ? "operate" : "read");
          const snapshot = yield* client.shell();
          const { project, thread } = yield* requireThread(snapshot, flags.project, flags.threadId);
          yield* ensureWorkspace(flags.workspace, thread.worktreePath ?? project.workspaceRoot);
          yield* ensureThreadCanReceivePrompt(thread);
          if (flags.runtimeMode !== thread.runtimeMode)
            return yield* remoteError(
              "runtime_mode_mismatch",
              "--runtime-mode must match the thread. This CLI does not change its permissions.",
            );
          const text = yield* readPrompt(flags.promptFile);
          const command = {
            type: "thread.turn.start",
            expectedSnapshotSequence: snapshot.snapshotSequence,
            commandId: CommandId.make(yield* uuid),
            threadId: thread.id,
            message: {
              messageId: MessageId.make(yield* uuid),
              role: "user",
              text,
              attachments: [],
            },
            runtimeMode: thread.runtimeMode,
            interactionMode: thread.interactionMode,
            createdAt: DateTime.formatIso(yield* DateTime.now),
          } satisfies ClientOrchestrationCommand;
          const receipt = flags.execute ? yield* client.dispatch(command) : null;
          yield* printRemoteResult(
            flags.json,
            {
              ok: true,
              executed: flags.execute,
              environmentId: client.descriptor.environmentId,
              projectId: project.id,
              threadId: thread.id,
              workspace: thread.worktreePath ?? project.workspaceRoot,
              runtimeMode: command.runtimeMode,
              interactionMode: command.interactionMode,
              commandId: command.commandId,
              messageId: command.message.messageId,
              requestedAt: command.createdAt,
              promptBytes: new TextEncoder().encode(text).length,
              receipt,
            },
            `${flags.execute ? "Accepted prompt for" : "Preview:"} thread ${thread.id} (${command.runtimeMode}); ${flags.execute ? "provider completion is separate from this receipt" : "nothing dispatched"}.`,
          );
        }),
      ),
    ),
  ),
);

export const readThreadStatus = Effect.fn("readRemoteCliThreadStatus")(function* (
  client: RemoteClient,
  projectId: ProjectId,
  threadId: ThreadId,
  messageId: MessageId | null = null,
) {
  if (messageId !== null && client.descriptor.capabilities.threadTurnMessageCorrelation !== true)
    return yield* remoteError(
      "unsupported_correlation",
      "This server cannot associate a turn with the submitted message. Upgrade it before following --message-id.",
    );
  const snapshot = yield* client.shell();
  const { project, thread } = yield* requireThread(snapshot, projectId, threadId);
  const detail = yield* client.thread(thread.id);
  // Background liveness is in memory and can change without a new event
  // sequence. Read it after detail rather than deciding from the first shell.
  const finalSnapshot = yield* client.shell();
  const finalDestination = yield* requireThread(finalSnapshot, projectId, threadId);
  if (
    detail.thread.id !== thread.id ||
    detail.thread.projectId !== project.id ||
    detail.thread.deletedAt !== null
  ) {
    return yield* remoteError(
      "destination_mismatch",
      "The thread detail does not match the selected destination.",
    );
  }
  if (
    detail.snapshotSequence !== snapshot.snapshotSequence ||
    detail.snapshotSequence !== finalSnapshot.snapshotSequence
  )
    return yield* remoteError(
      "snapshot_changed",
      "The environment changed while reading status. Read it again to obtain consistent state.",
    );
  const observedTurn = detail.thread.latestTurn;
  const turn =
    messageId === null || observedTurn?.userMessageId === messageId ? observedTurn : null;
  const startFailed =
    messageId !== null &&
    detail.thread.activities.some((activity) => {
      if (activity.kind !== "provider.turn.start.failed") return false;
      const payload = decodeTurnStartFailure(activity.payload);
      return Option.isSome(payload) && payload.value.requestId === messageId;
    });
  const requestState: "latest_turn" | "awaiting_turn" | "start_failed" =
    messageId === null || turn !== null
      ? "latest_turn"
      : startFailed
        ? "start_failed"
        : "awaiting_turn";
  const result =
    turn === null
      ? []
      : detail.thread.messages
          .filter((message) => message.role === "assistant" && message.turnId === turn.turnId)
          .map(({ id, text, streaming }) => ({ id, text, streaming }));
  return {
    ok: true,
    environmentId: client.descriptor.environmentId,
    snapshotSequence: detail.snapshotSequence,
    requestedMessageId: messageId,
    requestState,
    ...threadSummary(finalDestination.project, { ...finalDestination.thread, latestTurn: turn }),
    result,
  };
});

export type ThreadStatus = Effect.Success<ReturnType<typeof readThreadStatus>>;

export type WaitTarget =
  | { readonly type: "turn"; readonly id: TurnId }
  | { readonly type: "message"; readonly id: MessageId };

export const turnWaitState = (status: ThreadStatus, target: WaitTarget) => {
  if (target.type === "message") {
    if (status.requestedMessageId !== target.id) return "turn_mismatch";
    if (status.requestState === "start_failed") return "error";
    if (status.requestState === "awaiting_turn") return "awaiting_turn";
  }
  if (
    status.latestTurn === null ||
    (target.type === "turn"
      ? status.latestTurn.turnId !== target.id
      : status.latestTurn.userMessageId !== target.id)
  ) {
    return "turn_mismatch";
  }
  if (status.hasPendingApprovals || status.hasPendingUserInput || status.hasActionableProposedPlan)
    return "needs_attention";
  if (status.backgroundLiveness !== null) return "background";
  switch (status.latestTurn.state) {
    case "running":
      return "running";
    case "completed":
      return status.result.some((message) => message.streaming) ? "running" : "completed";
    case "error":
      return "error";
    case "interrupted":
      return "interrupted";
    default: {
      const exhaustive: never = status.latestTurn.state;
      return exhaustive;
    }
  }
};

export const waitForTurn = Effect.fn("waitForRemoteCliTurn")(function* (
  read: () => Effect.Effect<ThreadStatus, RemoteCliError>,
  target: WaitTarget,
  interval: Effect.Effect<void>,
) {
  while (true) {
    const status = yield* read().pipe(
      Effect.catch((error) =>
        error.code === "snapshot_changed" ? Effect.succeed(null) : Effect.fail(error),
      ),
    );
    if (status === null) {
      yield* interval;
      continue;
    }
    const state = turnWaitState(status, target);
    if (state === "turn_mismatch")
      return yield* remoteError(
        "turn_mismatch",
        "The requested turn is not the latest turn. Follow the message ID returned by send; this CLI does not infer completion from an idle thread.",
      );
    if (state !== "running" && state !== "background" && state !== "awaiting_turn")
      return { ...status, waitState: state };
    yield* interval;
  }
});

const threadStatusCommand = Command.make("status", {
  ...remoteFlags,
  threadId: threadArgument,
  project: projectFlag,
  messageId: Flag.String("message-id").pipe(Flag.withSchema(MessageId), Flag.optional),
}).pipe(
  Command.withDescription(
    "Read status and assistant output for the latest turn in one explicit thread.",
  ),
  Command.withHandler((flags) =>
    withRemoteTransport(
      reportRemoteErrors(
        flags.json,
        Effect.gen(function* () {
          const client = yield* connectRemote(flags, "read");
          const status = yield* readThreadStatus(
            client,
            flags.project,
            flags.threadId,
            Option.getOrNull(flags.messageId),
          );
          yield* printRemoteResult(
            flags.json,
            status,
            `${status.id}\t${status.latestTurn?.turnId ?? "no turn"}\t${status.latestTurn?.state ?? status.requestState}\n${status.result.map((message) => message.text).join("\n")}`,
          );
        }),
      ),
    ),
  ),
);

const threadWaitCommand = Command.make("wait", {
  ...remoteFlags,
  threadId: threadArgument,
  project: projectFlag,
  turnId: Flag.String("turn-id").pipe(Flag.withSchema(TurnId), Flag.optional),
  messageId: Flag.String("message-id").pipe(Flag.withSchema(MessageId), Flag.optional),
  timeoutSeconds: Flag.Int("timeout-seconds").pipe(
    Flag.withSchema(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 86_400 }))),
    Flag.withDefault(300),
  ),
}).pipe(
  Command.withDescription(
    "Wait for one exact latest turn to finish or need attention; safe to run as a background process.",
  ),
  Command.withHandler((flags) =>
    withRemoteTransport(
      reportRemoteErrors(
        flags.json,
        Effect.gen(function* () {
          if (Option.isSome(flags.turnId) === Option.isSome(flags.messageId))
            return yield* remoteError(
              "wait_target",
              "Supply exactly one of --message-id from send or --turn-id from status.",
            );
          const target: WaitTarget = Option.isSome(flags.messageId)
            ? { type: "message", id: flags.messageId.value }
            : { type: "turn", id: Option.getOrThrow(flags.turnId) };
          const client = yield* connectRemote(flags, "read");
          const result = yield* waitForTurn(
            () =>
              readThreadStatus(
                client,
                flags.project,
                flags.threadId,
                target.type === "message" ? target.id : null,
              ),
            target,
            Effect.sleep("1 second"),
          ).pipe(
            Effect.timeout(`${flags.timeoutSeconds} seconds`),
            Effect.mapError((error) =>
              error._tag === "RemoteCliError"
                ? error
                : remoteError(
                    "wait_timeout",
                    "Wait timed out; the CLI has not cancelled server work. Read status or wait again.",
                  ),
            ),
          );
          yield* printRemoteResult(
            flags.json,
            result,
            `${result.id}\t${result.latestTurn?.turnId}\t${result.waitState}\n${result.result.map((message) => message.text).join("\n")}`,
          );
        }),
      ),
    ),
  ),
);

export const threadCommand = Command.make("thread").pipe(
  Command.withDescription(
    "Operate explicitly selected remote threads using a supplied credential, without desktop state.",
  ),
  Command.withSubcommands([
    threadListCommand,
    threadCreateCommand,
    threadSendCommand,
    threadStatusCommand,
    threadWaitCommand,
  ]),
);
