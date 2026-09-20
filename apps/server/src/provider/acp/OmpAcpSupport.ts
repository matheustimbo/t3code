/**
 * OmpAcpSupport — spawn + model selection for the omp (`omp acp`) ACP runtime.
 *
 * Verified against `omp/18.2.6` over stdio:
 * - `initialize` advertises `agentInfo.name: "oh-my-pi"` and a single
 *   `authMethods: [{ id: "agent" }]` entry ("Use existing local credentials
 *   under ~/.omp").
 * - `authenticate({ methodId: "agent" })` succeeds with `{}`.
 * - `session/new` returns `configOptions` with `mode` (default/plan),
 *   `model` (select, `provider/model` values) and `thinking`
 *   (off/auto/low/medium/high/xhigh/max) selects, plus
 *   `modes.availableModes` (default/plan).
 *
 * The product slug `auto` is never sent over the wire; it keeps the
 * session's current model, mirroring Cursor's `auto` semantics.
 *
 * @module provider/acp/OmpAcpSupport
 */
import {
  type OmpSettings,
  type ProviderOptionSelection,
  type RuntimeMode,
} from "@t3tools/contracts";
import { getProviderOptionStringSelectionValue } from "@t3tools/shared/model";
import { normalizeModelSlug } from "@t3tools/shared/model";
import { ProviderDriverKind } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

const OMP_DRIVER_KIND = ProviderDriverKind.make("omp");

/** ACP `authenticate` method id advertised by `omp acp` (`initialize.authMethods`). */
export const OMP_AUTH_METHOD_ID = "agent";

type OmpAcpRuntimeOmpSettings = Pick<OmpSettings, "binaryPath">;

export function ompAcpSpawnArgs(runtimeMode?: RuntimeMode): ReadonlyArray<string> {
  switch (runtimeMode) {
    case "approval-required":
      return ["--approval-mode", "always-ask", "acp"];
    case "auto-accept-edits":
    case "auto":
      return ["--approval-mode", "write", "acp"];
    case "full-access":
      return ["--approval-mode", "yolo", "acp"];
    default:
      return ["acp"];
  }
}

export function buildOmpAcpSpawnInput(
  ompSettings: OmpAcpRuntimeOmpSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
  runtimeMode?: RuntimeMode,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: ompSettings?.binaryPath || "omp",
    args: [...ompAcpSpawnArgs(runtimeMode)],
    cwd,
    ...(environment ? { env: environment } : {}),
  };
}

export interface OmpAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly ompSettings: OmpAcpRuntimeOmpSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
  readonly runtimeMode?: RuntimeMode;
}

export const makeOmpAcpRuntime = (
  input: OmpAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildOmpAcpSpawnInput(
          input.ompSettings,
          input.cwd,
          input.environment,
          input.runtimeMode,
        ),
        authMethodId: OMP_AUTH_METHOD_ID,
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
    );
  });

/**
 * T3's built-in omp slug. It is a product alias, not a model id the ACP
 * accepts, so selecting it means "use whatever model the omp session
 * currently runs on".
 */
export const OMP_DEFAULT_MODEL_SLUG = "auto";

export function resolveOmpAcpBaseModelId(model: string | null | undefined): string {
  const trimmed = model?.trim();
  const base = trimmed && trimmed.length > 0 ? trimmed : OMP_DEFAULT_MODEL_SLUG;
  return normalizeModelSlug(base, OMP_DRIVER_KIND) ?? OMP_DEFAULT_MODEL_SLUG;
}

/** Thinking levels advertised by `omp acp` (`session/new` config option `thinking`). */
const OMP_THINKING_TOKEN = /^(off|auto|low|medium|high|xhigh|max)$/;

export function isValidOmpThinkingToken(value: string): boolean {
  return OMP_THINKING_TOKEN.test(value);
}

export function normalizeOmpThinking(value: string | undefined): string | undefined {
  const thinking = value?.trim().toLowerCase();
  return thinking && isValidOmpThinkingToken(thinking) ? thinking : undefined;
}

/** Values advertised by a select config option, tolerating grouped options. */
export function ompSelectOptionValues(
  option: EffectAcpSchema.SessionConfigOption,
): ReadonlyArray<string> {
  if (option.type !== "select") {
    return [];
  }
  return option.options.flatMap((entry) => {
    if ("value" in entry && typeof entry.value === "string") {
      return [entry.value];
    }
    if ("options" in entry && Array.isArray(entry.options)) {
      return entry.options.flatMap((grouped) =>
        typeof grouped.value === "string" ? [grouped.value] : [],
      );
    }
    return [];
  });
}

interface OmpAcpModelSelectionRuntime {
  readonly getConfigOptions: AcpSessionRuntime.AcpSessionRuntime["Service"]["getConfigOptions"];
  readonly setConfigOption: (
    configId: string,
    value: string | boolean,
  ) => Effect.Effect<unknown, EffectAcpErrors.AcpError>;
  readonly setModel: (model: string) => Effect.Effect<unknown, EffectAcpErrors.AcpError>;
}

export interface OmpAcpModelSelectionErrorContext {
  readonly cause: EffectAcpErrors.AcpError;
  readonly step: "set-config-option" | "set-model";
  readonly configId?: string;
}

export function applyOmpAcpModelSelection<E>(input: {
  readonly runtime: OmpAcpModelSelectionRuntime;
  readonly model: string | null | undefined;
  readonly selections: ReadonlyArray<ProviderOptionSelection> | null | undefined;
  readonly mapError: (context: OmpAcpModelSelectionErrorContext) => E;
}): Effect.Effect<void, E> {
  return Effect.gen(function* () {
    const requested = resolveOmpAcpBaseModelId(input.model);
    // The product slug is never sent over the wire; it keeps the session's current model.
    if (requested !== OMP_DEFAULT_MODEL_SLUG) {
      yield* input.runtime.setModel(requested).pipe(
        Effect.mapError((cause) =>
          input.mapError({
            cause,
            step: "set-model",
          }),
        ),
      );
    }

    const requestedThinking = normalizeOmpThinking(
      getProviderOptionStringSelectionValue(input.selections, "thinking"),
    );
    if (requestedThinking) {
      const configOptions = yield* input.runtime.getConfigOptions;
      const thinkingOption = configOptions.find((option) => option.id === "thinking");
      // The session may not advertise thinking at all (older CLI, or a model
      // without thinking support): keep the session's current level instead
      // of failing the turn with an unsupported config update.
      if (thinkingOption?.type !== "select") {
        return;
      }
      const advertised = ompSelectOptionValues(thinkingOption);
      if (advertised.length > 0 && !advertised.includes(requestedThinking)) {
        return;
      }
      if (requestedThinking !== thinkingOption.currentValue) {
        yield* input.runtime.setConfigOption("thinking", requestedThinking).pipe(
          Effect.mapError((cause) =>
            input.mapError({
              cause,
              step: "set-config-option",
              configId: "thinking",
            }),
          ),
        );
      }
    }
  });
}
