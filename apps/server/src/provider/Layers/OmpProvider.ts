/**
 * OmpProvider — snapshot/status for the omp CLI (`omp acp`) binding.
 *
 * Health checking is CLI-first and side-effect free:
 * - `omp --version` proves the binary is installed and yields the version.
 * - `omp usage` reports login state (`No credentials found…` when logged out).
 * - `omp models --json` lists the model catalog (`provider/id` selectors that
 *   match the ACP `model` select values, plus per-model `thinking` levels)
 *   without opening an ACP session.
 *
 * Model discovery never calls `session/new`, so a health refresh cannot
 * create sessions, open a browser login, or boot MCP servers.
 *
 * @module provider/Layers/OmpProvider
 */
import {
  type CustomModelSetting,
  type ModelCapabilities,
  type OmpSettings,
  type ServerProvider,
  type ServerProviderAuth,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { causeErrorTag } from "@t3tools/shared/observability";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import {
  AUTH_PROBE_TIMEOUT_MS,
  buildServerProvider,
  COMPACT_SLASH_COMMAND,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";
import { OMP_DEFAULT_MODEL_SLUG, resolveOmpAcpBaseModelId } from "../acp/OmpAcpSupport.ts";

export { OMP_DEFAULT_MODEL_SLUG, resolveOmpAcpBaseModelId };

const OMP_PRESENTATION = {
  displayName: "Omp",
  supportsConversationRollback: false,
  badgeLabel: "Early Access",
  showInteractionModeToggle: false,
} as const;

const OMP_THINKING_LABELS: Record<string, string> = {
  off: "Off",
  auto: "Auto",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

function thinkingLabel(value: string): string {
  return OMP_THINKING_LABELS[value] ?? value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
}

/**
 * Thinking-level picker for one model, derived from the catalog's per-model
 * `thinking` array (`omp models --json`). Models without thinking support
 * get no descriptor so the picker never offers levels the session rejects.
 */
export function ompThinkingCapabilitiesForLevels(
  levels: ReadonlyArray<string> | null | undefined,
): ModelCapabilities {
  const values = (levels ?? []).filter(
    (level, index, all) =>
      typeof level === "string" && level.trim() && all.indexOf(level) === index,
  );
  if (values.length === 0) {
    return createModelCapabilities({ optionDescriptors: [] });
  }
  return createModelCapabilities({
    optionDescriptors: [
      {
        id: "thinking",
        label: "Thinking",
        type: "select",
        options: values.map((value) => ({
          id: value,
          label: thinkingLabel(value),
        })),
      },
    ],
  });
}

/** Thinking-level picker surfaced on the `auto` product slug (all session levels). */
export const OMP_THINKING_CAPABILITIES: ModelCapabilities = ompThinkingCapabilitiesForLevels([
  "off",
  "auto",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

const OMP_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: OMP_DEFAULT_MODEL_SLUG,
    name: "Auto",
    isCustom: false,
    isDefault: true,
    capabilities: OMP_THINKING_CAPABILITIES,
  },
];

const VERSION_PROBE_TIMEOUT_MS = 4_000;
const MODELS_PROBE_TIMEOUT_MS = 15_000;

export function buildInitialOmpProviderSnapshot(
  ompSettings: OmpSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = ompModelsFromSettings(ompSettings.customModels);

    if (!ompSettings.enabled) {
      return buildServerProvider({
        presentation: OMP_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Omp is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: OMP_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking omp CLI availability...",
      },
    });
  });
}

function ompModelsFromSettings(
  customModels: ReadonlyArray<CustomModelSetting> | undefined,
  builtInModels: ReadonlyArray<ServerProviderModel> = OMP_BUILT_IN_MODELS,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(builtInModels, customModels ?? [], OMP_THINKING_CAPABILITIES);
}

function displayNameFromOmpModelSlug(slug: string): string {
  const short = slug.includes("/") ? (slug.split("/").pop() ?? slug) : slug;
  return short
    .split(/[-_]/g)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ompThinkingLevelsFromEntry(entry: Record<string, unknown>): ReadonlyArray<string> {
  const raw = entry.thinking;
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.flatMap((level) => (typeof level === "string" && level.trim() ? [level.trim()] : []));
}

/**
 * Parses `omp models --json` (`{"models":[{selector,name,thinking}]}`).
 * Selectors are `provider/id` values matching the ACP `model` select, and
 * `thinking` carries the model's supported levels (null when unsupported).
 * Unknown entries are skipped, never fatal.
 */
export function parseOmpModelsJsonOutput(output: string): ReadonlyArray<ServerProviderModel> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output) as unknown;
  } catch {
    return [];
  }
  const entries = isRecord(parsed) && Array.isArray(parsed.models) ? parsed.models : [];
  const seen = new Set<string>();
  const models: ServerProviderModel[] = [];
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    const selector = typeof entry.selector === "string" ? entry.selector.trim() : "";
    if (!selector) continue;
    const slug = resolveOmpAcpBaseModelId(selector);
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    const name =
      typeof entry.name === "string" && entry.name.trim()
        ? entry.name.trim()
        : displayNameFromOmpModelSlug(slug);
    models.push({
      slug,
      name,
      isCustom: false,
      capabilities: ompThinkingCapabilitiesForLevels(ompThinkingLevelsFromEntry(entry)),
    });
  }
  return models;
}

/**
 * Parses `omp usage`. The command exits 0 whether or not any account is
 * configured; the text is the only signal. Unauthenticated output looks like:
 *
 *     No credentials found. Run `omp` and use /login to add accounts.
 */
export function parseOmpUsageOutput(output: string): boolean | null {
  if (/no credentials found/i.test(output)) {
    return false;
  }
  return output.trim().length > 0 ? true : null;
}

const runOmpCliCommand = (
  ompSettings: OmpSettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
) =>
  Effect.gen(function* () {
    const command = ompSettings.binaryPath || "omp";
    const spawnCommand = yield* resolveSpawnCommand(command, args, { env: environment });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  });

export const checkOmpProviderStatus = Effect.fn("checkOmpProviderStatus")(function* (
  ompSettings: OmpSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = ompModelsFromSettings(ompSettings.customModels);

  if (!ompSettings.enabled) {
    return buildServerProvider({
      presentation: OMP_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Omp is disabled in T3 Code settings.",
      },
    });
  }

  const versionResult = yield* runOmpCliCommand(ompSettings, ["--version"], environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    yield* Effect.logWarning("omp CLI health check failed.", {
      errorTag: error._tag,
    });
    return buildServerProvider({
      presentation: OMP_PRESENTATION,
      enabled: ompSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "omp CLI (`omp`) is not installed or not on PATH."
          : "Failed to execute omp CLI health check.",
      },
    });
  }

  if (Option.isNone(versionResult.success)) {
    return buildServerProvider({
      presentation: OMP_PRESENTATION,
      enabled: ompSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "omp CLI is installed but timed out while running `omp --version`.",
      },
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    yield* Effect.logWarning("omp CLI version probe exited with a non-zero status.", {
      exitCode: versionOutput.code,
      stdoutLength: versionOutput.stdout.length,
      stderrLength: versionOutput.stderr.length,
    });
    return buildServerProvider({
      presentation: OMP_PRESENTATION,
      enabled: ompSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "omp CLI is installed but failed to run.",
      },
    });
  }

  // `omp usage` exits 0 with or without accounts, so only its text is parsed.
  const usageResult = yield* runOmpCliCommand(ompSettings, ["usage"], environment).pipe(
    Effect.timeoutOption(AUTH_PROBE_TIMEOUT_MS),
    Effect.result,
  );
  const usageOutput =
    Result.isSuccess(usageResult) &&
    Option.isSome(usageResult.success) &&
    usageResult.success.value.code === 0
      ? `${usageResult.success.value.stdout}\n${usageResult.success.value.stderr}`
      : undefined;
  if (usageOutput === undefined) {
    yield* Effect.logWarning("omp CLI usage probe failed or timed out.", {
      errorTag: Result.isFailure(usageResult)
        ? usageResult.failure._tag
        : Option.isNone(usageResult.success)
          ? "Timeout"
          : `ExitCode${usageResult.success.value.code}`,
    });
  }
  const authenticated = usageOutput !== undefined ? parseOmpUsageOutput(usageOutput) : null;

  // `omp models --json` lists the catalog without opening an ACP session.
  const modelsResult = yield* runOmpCliCommand(ompSettings, ["models", "--json"], environment).pipe(
    Effect.timeoutOption(MODELS_PROBE_TIMEOUT_MS),
    Effect.result,
  );
  const modelsOutput =
    Result.isSuccess(modelsResult) &&
    Option.isSome(modelsResult.success) &&
    modelsResult.success.value.code === 0
      ? modelsResult.success.value.stdout
      : undefined;
  if (modelsOutput === undefined) {
    yield* Effect.logWarning("omp CLI model listing failed or timed out.", {
      errorTag: Result.isFailure(modelsResult)
        ? modelsResult.failure._tag
        : Option.isNone(modelsResult.success)
          ? "Timeout"
          : `ExitCode${modelsResult.success.value.code}`,
    });
  }
  const cliModels = modelsOutput ? parseOmpModelsJsonOutput(modelsOutput) : [];
  const models =
    cliModels.length > 0
      ? ompModelsFromSettings(ompSettings.customModels, [...OMP_BUILT_IN_MODELS, ...cliModels])
      : fallbackModels;

  const auth: ServerProviderAuth =
    authenticated === true
      ? { status: "authenticated", type: "cached_token", label: "omp account" }
      : authenticated === false
        ? { status: "unauthenticated" }
        : { status: "unknown" };

  if (auth.status === "unauthenticated") {
    return buildServerProvider({
      presentation: OMP_PRESENTATION,
      enabled: ompSettings.enabled,
      checkedAt,
      models,
      slashCommands: [COMPACT_SLASH_COMMAND],
      probe: {
        installed: true,
        version,
        status: "error",
        auth,
        message: "omp CLI is installed but not logged in. Run `omp` and use /login.",
      },
    });
  }

  // A failed probe degrades the snapshot (stale models, unknown auth) — it
  // must not report ready when the data behind the snapshot is missing.
  const failedProbes: Array<string> = [
    ...(usageOutput === undefined ? ["usage"] : []),
    ...(modelsOutput === undefined ? ["models"] : []),
  ];
  if (failedProbes.length > 0) {
    return buildServerProvider({
      presentation: OMP_PRESENTATION,
      enabled: ompSettings.enabled,
      checkedAt,
      models,
      slashCommands: [COMPACT_SLASH_COMMAND],
      probe: {
        installed: true,
        version,
        status: "warning",
        auth,
        message: `omp CLI is installed but the ${failedProbes.join(" and ")} probe${failedProbes.length > 1 ? "s" : ""} failed. Model options or login state may be stale.`,
      },
    });
  }

  return buildServerProvider({
    presentation: OMP_PRESENTATION,
    enabled: ompSettings.enabled,
    checkedAt,
    models,
    slashCommands: [COMPACT_SLASH_COMMAND],
    probe: {
      installed: true,
      version,
      status: "ready",
      auth,
    },
  });
});

export const enrichOmpSnapshot = (input: {
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  readonly httpClient: HttpClient.HttpClient;
}): Effect.Effect<void> => {
  const { snapshot, publishSnapshot } = input;

  return enrichProviderSnapshotWithVersionAdvisory(snapshot, input.maintenanceCapabilities, {
    enableProviderUpdateChecks: input.enableProviderUpdateChecks,
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, input.httpClient),
    Effect.flatMap((enrichedSnapshot) => publishSnapshot(enrichedSnapshot)),
    Effect.catchCause((cause) =>
      Effect.logWarning("omp version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  );
};
