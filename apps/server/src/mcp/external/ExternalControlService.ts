import {
  CommandId,
  ExternalControlCreateInput,
  ExternalControlFailure,
  ExternalControlInterruptInput,
  ExternalControlMessagesInput,
  ExternalControlMutationResult,
  ExternalControlSendInput,
  ExternalReadFailure,
  MessageId,
  ThreadId,
  type ExternalControlMessagesResult,
  type ProjectId,
  type ProviderInteractionMode,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as ThreadMessageIntake from "../../orchestration-v2/ThreadMessageIntake.ts";
import { CommandCommitAuthorization } from "../../orchestration-v2/CommandCommitAuthorization.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as Store from "../../persistence/ExternalControlStore.ts";
import * as Access from "./ExternalReadAccess.ts";
import * as ServerConfig from "../../config.ts";

type Identity = Access.ExternalReadIdentity;
type Create = typeof ExternalControlCreateInput.Type;
type Send = typeof ExternalControlSendInput.Type;
type Interrupt = typeof ExternalControlInterruptInput.Type;
type Messages = typeof ExternalControlMessagesInput.Type;
type MutationResult = typeof ExternalControlMutationResult.Type;
export class ExternalControlService extends Context.Service<
  ExternalControlService,
  {
    readonly messages: (
      identity: Identity,
      input: Messages,
    ) => Effect.Effect<ExternalControlMessagesResult, ExternalControlFailure>;
    readonly create: (
      identity: Identity,
      input: Create,
    ) => Effect.Effect<MutationResult, ExternalControlFailure>;
    readonly send: (
      identity: Identity,
      input: Send,
    ) => Effect.Effect<MutationResult, ExternalControlFailure>;
    readonly interrupt: (
      identity: Identity,
      input: Interrupt,
    ) => Effect.Effect<MutationResult, ExternalControlFailure>;
  }
>()("t3/mcp/external/ExternalControlService") {}

const encodeCreate = Schema.encodeSync(Schema.fromJsonString(ExternalControlCreateInput));
const encodeSend = Schema.encodeSync(Schema.fromJsonString(ExternalControlSendInput));
const encodeInterrupt = Schema.encodeSync(Schema.fromJsonString(ExternalControlInterruptInput));
const encodeStrings = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));
const runtimeRank: Record<RuntimeMode, number> = {
  "approval-required": 0,
  "auto-accept-edits": 1,
  auto: 2,
  "full-access": 3,
};
const interactionRank: Record<ProviderInteractionMode, number> = { plan: 0, default: 1 };
const isFailure = Schema.is(ExternalControlFailure);
const isReadFailure = Schema.is(ExternalReadFailure);
const sanitize = (cause: unknown): ExternalControlFailure => {
  let current = cause;
  for (let depth = 0; depth < 8; depth++) {
    if (isFailure(current)) return current;
    if (isReadFailure(current)) return new ExternalControlFailure({ code: current.code });
    if (typeof current !== "object" || current === null) break;
    if ("_tag" in current && current._tag === "ExternalControlRequestConflict")
      return new ExternalControlFailure({ code: "conflict" });
    if (!("cause" in current)) break;
    current = current.cause;
  }
  return new ExternalControlFailure({ code: "unavailable" });
};
const make = Effect.gen(function* () {
  const access = yield* Access.ExternalReadAccess;
  const store = yield* Store.ExternalControlStore;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const filesystem = yield* FileSystem.FileSystem;
  const config = yield* ServerConfig.ServerConfig;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const environmentId = yield* environment.getEnvironmentId;
  const crypto = yield* Crypto.Crypto;
  const hash = (value: string) =>
    crypto.digest("SHA-256", new TextEncoder().encode(value)).pipe(
      Effect.map((bytes) =>
        Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(""),
      ),
      Effect.mapError(sanitize),
    );
  const check = Effect.fn("ExternalControlService.check")(function* (
    identity: Identity,
    operation: Access.ExternalReadOperation,
    input: {
      readonly projectId: ProjectId;
      readonly threadId?: ThreadId;
      readonly runtimeMode?: RuntimeMode;
      readonly interactionMode?: ProviderInteractionMode;
    },
  ) {
    const grant = yield* access.authorize(identity, operation, input.projectId);
    const project = yield* projects.get(input.projectId);
    if (Option.isNone(project) || project.value.deletedAt !== null) {
      return yield* new ExternalControlFailure({ code: "not_found" });
    }
    const state =
      input.threadId === undefined
        ? undefined
        : yield* store.getState({ projectId: input.projectId, threadId: input.threadId });
    if (input.threadId !== undefined && state === undefined) {
      return yield* new ExternalControlFailure({ code: "not_found" });
    }
    if (operation !== "threads.messages" && state?.subagent === true) {
      return yield* new ExternalControlFailure({ code: "access_denied" });
    }
    if (operation === "threads.send" && state?.archived === true) {
      return yield* new ExternalControlFailure({ code: "access_denied" });
    }
    if (operation === "threads.create" || operation === "threads.send") {
      const runtime = input.runtimeMode ?? state?.runtimeMode;
      const interaction = input.interactionMode ?? state?.interactionMode;
      const policy = grant.controlPolicy;
      if (
        policy === undefined ||
        runtime === undefined ||
        interaction === undefined ||
        runtimeRank[runtime] > runtimeRank[policy.runtimeModeCeiling] ||
        interactionRank[interaction] > interactionRank[policy.interactionModeCeiling]
      ) {
        return yield* new ExternalControlFailure({ code: "access_denied" });
      }
    }
    yield* access.authorize(identity, operation, input.projectId);
    return state;
  });
  const mutate = Effect.fn("ExternalControlService.mutate")(function* (
    identity: Identity,
    operation: "threads.create" | "threads.send" | "threads.interrupt",
    input: Create | Send | Interrupt,
    encoded: string,
  ) {
    const state = yield* check(identity, operation, input);
    const keyHash = yield* hash(
      encodeStrings([environmentId, identity.credentialId, identity.principalId, input.requestKey]),
    );
    const requestHash = yield* hash(encodeStrings([operation, encoded]));
    const reserved = yield* store.reserve({
      environmentId,
      ...identity,
      requestKey: input.requestKey,
      requestHash,
      commandId: CommandId.make(`external:${keyHash}`),
      threadId: "threadId" in input ? input.threadId : ThreadId.make(`external:${keyHash}`),
      runId: operation === "threads.interrupt" ? (state?.runId ?? null) : null,
    });
    // The actual EventSink transaction checks current policy and scoped state
    // immediately before append/outbox. No client can supply this context.
    const guarded = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.provideService(CommandCommitAuthorization, {
          commandId: reserved.commandId,
          check: Effect.gen(function* () {
            const current = yield* check(identity, operation, input);
            // Thread metadata can be reduced while a provider turn retains its
            // original permissions. New external sends require an idle thread;
            // accepted receipt replays never enter this commit guard.
            if (operation === "threads.send" && current !== undefined && current.runId !== null) {
              return yield* new ExternalControlFailure({ code: "access_denied" });
            }
          }).pipe(Effect.mapError(sanitize)),
        }),
      );
    const result: MutationResult = {
      projectId: input.projectId,
      threadId: reserved.threadId,
      outcome:
        operation === "threads.interrupt" && reserved.runId === null ? "no_active_run" : "accepted",
      ...(operation === "threads.send" ? { messageId: MessageId.make(`external:${keyHash}`) } : {}),
    };
    if (reserved.result !== null) {
      if (
        reserved.result.projectId !== result.projectId ||
        reserved.result.threadId !== result.threadId ||
        reserved.result.messageId !== result.messageId ||
        reserved.result.outcome !== result.outcome
      ) {
        return yield* new ExternalControlFailure({ code: "unavailable" });
      }
      yield* check(identity, operation, input);
      return reserved.result;
    }
    yield* check(identity, operation, input);
    if (operation === "threads.create") {
      const create = input as Create;
      yield* guarded(
        threads.dispatch({
          type: "thread.create",
          commandId: reserved.commandId,
          threadId: reserved.threadId,
          projectId: create.projectId,
          title: create.title,
          modelSelection: create.modelSelection,
          runtimeMode: create.runtimeMode,
          interactionMode: create.interactionMode,
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "mcp",
        }),
      );
    } else if (operation === "threads.send") {
      const send = input as Send;
      yield* guarded(
        ThreadMessageIntake.dispatchCommand({
          type: "message.dispatch",
          commandId: reserved.commandId,
          threadId: reserved.threadId,
          messageId: MessageId.make(`external:${keyHash}`),
          text: send.text,
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          deliveryIntent: "auto",
          createdBy: "user",
          creationSource: "mcp",
        }).pipe(
          Effect.provideService(ThreadManagement.ThreadManagementService, threads),
          Effect.provideService(FileSystem.FileSystem, filesystem),
          Effect.provideService(ServerConfig.ServerConfig, config),
        ),
      );
    } else if (reserved.runId !== null) {
      yield* guarded(
        threads.dispatch({
          type: "run.interrupt",
          commandId: reserved.commandId,
          threadId: reserved.threadId,
          runId: reserved.runId,
        }),
      );
    }
    // Persist before returning; a lost response/failed completion write can retry
    // the same native command receipt, never dispatch a new message or target run.
    yield* store.complete(reserved, result);
    yield* check(identity, operation, input);
    return result;
  });
  return ExternalControlService.of({
    messages: (identity, input) =>
      Effect.gen(function* () {
        yield* check(identity, "threads.messages", input);
        const result = yield* store.getMessages(input);
        yield* check(identity, "threads.messages", input);
        return result;
      }).pipe(Effect.mapError(sanitize)),
    create: (identity, input) =>
      mutate(identity, "threads.create", input, encodeCreate(input)).pipe(
        Effect.mapError(sanitize),
      ),
    send: (identity, input) =>
      mutate(identity, "threads.send", input, encodeSend(input)).pipe(Effect.mapError(sanitize)),
    interrupt: (identity, input) =>
      mutate(identity, "threads.interrupt", input, encodeInterrupt(input)).pipe(
        Effect.mapError(sanitize),
      ),
  });
});
export const layer = Layer.effect(ExternalControlService, make);
