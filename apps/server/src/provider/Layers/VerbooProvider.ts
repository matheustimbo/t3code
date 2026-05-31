/**
 * VerbooProvider — snapshot probes for the Verboo Agent runtime.
 *
 * Verboo is a rebrand/fork of Claude Code: its CLI binary is named `verboo`
 * and it stores data under `$HOME/.verboo/`. It speaks the EXACT same protocol
 * as `@anthropic-ai/claude-agent-sdk`, so we reuse the same lightweight SDK
 * probe used for Claude to read account + slash-command metadata. Unlike
 * Claude, Verboo exposes no fixed built-in model list — its models use a
 * `subprovider/model` slug format and must be discovered at RUNTIME from the
 * SDK initialization result.
 *
 * @module provider/Layers/VerbooProvider
 */
import {
  type ModelCapabilities,
  ProviderDriverKind,
  type ServerProviderModel,
  type ServerProviderSlashCommand,
  type VerbooSettings,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { createModelCapabilities } from "@t3tools/shared/model";
import { query as verbooQuery, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

import {
  buildBooleanOptionDescriptor,
  buildSelectOptionDescriptor,
  buildServerProvider,
  DEFAULT_TIMEOUT_MS,
  detailFromResult,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import { makeVerbooEnvironment } from "../Drivers/VerbooHome.ts";
import {
  dedupeSlashCommands,
  parseClaudeInitializationCommands,
  waitForAbortSignal,
} from "./ClaudeProvider.ts";

const DEFAULT_VERBOO_MODEL_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const PROVIDER = ProviderDriverKind.make("verboo");
const VERBOO_PRESENTATION = {
  displayName: "Verboo",
  showInteractionModeToggle: true,
} as const;

// Seed model used when runtime discovery yields no models, so the provider is
// never left without a selectable model.
const SEED_MODEL_SLUG = "growth/qwen3.6-27b";

// ── SDK capability probe ────────────────────────────────────────────

const CAPABILITIES_PROBE_TIMEOUT_MS = 8_000;

/**
 * Minimal description of a model exposed by the Verboo SDK initialization
 * result. The Claude Agent SDK type does not declare these fields, so we
 * declare them locally and access them defensively.
 */
type VerbooModelInfo = {
  readonly value: string;
  readonly displayName?: string;
  readonly supportsEffort?: boolean;
  readonly supportedEffortLevels?: ReadonlyArray<string>;
  readonly supportsFastMode?: boolean;
  readonly supportsAdaptiveThinking?: boolean;
};

type VerbooCapabilitiesProbe = {
  readonly email: string | undefined;
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly slashCommands: ReadonlyArray<ServerProviderSlashCommand>;
};

function nonEmptyProbeString(value: string | undefined): string | undefined {
  const candidate = value?.trim();
  return candidate ? candidate : undefined;
}

function toTitleCaseWords(value: string): string {
  return value
    .split(/[\s_-]+/g)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function buildVerbooModelCapabilities(model: VerbooModelInfo): ModelCapabilities {
  const optionDescriptors = [];

  const effortLevels = (model.supportedEffortLevels ?? []).filter(
    (level): level is string => typeof level === "string" && level.trim().length > 0,
  );
  if (effortLevels.length > 0) {
    optionDescriptors.push(
      buildSelectOptionDescriptor({
        id: "effort",
        label: "Reasoning",
        options: effortLevels.map((level) => ({
          value: level,
          label: toTitleCaseWords(level),
        })),
      }),
    );
  }

  if (model.supportsFastMode === true) {
    optionDescriptors.push(
      buildBooleanOptionDescriptor({
        id: "fastMode",
        label: "Fast Mode",
      }),
    );
  }

  if (model.supportsAdaptiveThinking === true) {
    optionDescriptors.push(
      buildBooleanOptionDescriptor({
        id: "thinking",
        label: "Thinking",
      }),
    );
  }

  return createModelCapabilities({ optionDescriptors });
}

function verbooModelInfoToServerModel(model: VerbooModelInfo): ServerProviderModel {
  const slug = model.value.trim();
  return {
    slug,
    name: nonEmptyProbeString(model.displayName) ?? slug,
    isCustom: false,
    capabilities: buildVerbooModelCapabilities(model),
  };
}

function parseVerbooModelInfos(
  models: ReadonlyArray<VerbooModelInfo> | undefined,
): ReadonlyArray<ServerProviderModel> {
  if (!Array.isArray(models)) {
    return [];
  }
  const seen = new Set<string>();
  const result: ServerProviderModel[] = [];
  for (const model of models) {
    const slug =
      model && typeof model === "object" && typeof model.value === "string"
        ? model.value.trim()
        : "";
    if (!slug || seen.has(slug)) {
      continue;
    }
    seen.add(slug);
    result.push(verbooModelInfoToServerModel(model));
  }
  return result;
}

function seedVerbooModels(settings: VerbooSettings): ReadonlyArray<ServerProviderModel> {
  const seed: ServerProviderModel = {
    slug: SEED_MODEL_SLUG,
    name: SEED_MODEL_SLUG,
    isCustom: false,
    capabilities: DEFAULT_VERBOO_MODEL_CAPABILITIES,
  };
  return providerModelsFromSettings(
    [seed],
    PROVIDER,
    settings.customModels,
    DEFAULT_VERBOO_MODEL_CAPABILITIES,
  );
}

/**
 * Probe account information + available models by spawning a lightweight
 * Verboo Agent SDK session and reading the initialization result.
 *
 * As with the Claude probe, we pass a never-yielding AsyncIterable as the
 * prompt so the subprocess completes its local initialization IPC (returning
 * account info, slash commands, and the models array) but never starts a
 * remote API request. We read the init data and then abort the subprocess.
 *
 * Model discovery is robust and never throws: it falls back from
 * `init.models` to `query.supportedModels()` (when available) and finally to
 * the seed model + custom models configured in settings.
 */
const probeVerbooCapabilities = (
  verbooSettings: VerbooSettings,
  environment: NodeJS.ProcessEnv = process.env,
) => {
  const abort = new AbortController();
  return Effect.gen(function* () {
    const verbooEnvironment = yield* makeVerbooEnvironment(verbooSettings, environment);
    return yield* Effect.tryPromise(async () => {
      const q = verbooQuery({
        // Never yield — we only need initialization data, not a conversation.
        // This prevents any prompt from reaching the remote API.
        // oxlint-disable-next-line require-yield
        prompt: (async function* (): AsyncGenerator<SDKUserMessage> {
          await waitForAbortSignal(abort.signal);
        })(),
        options: {
          persistSession: false,
          pathToClaudeCodeExecutable: verbooSettings.binaryPath,
          abortController: abort,
          settingSources: ["user", "project", "local"],
          allowedTools: [],
          env: verbooEnvironment,
          stderr: () => {},
        },
      });
      const init = (await q.initializationResult()) as {
        readonly account?: { readonly email?: string };
        readonly commands?: Parameters<typeof parseClaudeInitializationCommands>[0];
        readonly models?: ReadonlyArray<VerbooModelInfo>;
      };

      let models = parseVerbooModelInfos(init.models);
      if (models.length === 0) {
        const supportedModels = (
          q as { readonly supportedModels?: () => Promise<ReadonlyArray<VerbooModelInfo>> }
        ).supportedModels;
        if (typeof supportedModels === "function") {
          const discovered = await supportedModels.call(q).catch(() => undefined);
          models = parseVerbooModelInfos(discovered);
        }
      }

      return {
        email: init.account?.email,
        models,
        slashCommands: parseClaudeInitializationCommands(init.commands),
      } satisfies VerbooCapabilitiesProbe;
    });
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        if (!abort.signal.aborted) abort.abort();
      }),
    ),
    Effect.timeoutOption(CAPABILITIES_PROBE_TIMEOUT_MS),
    Effect.result,
    Effect.map((result) => {
      if (Result.isFailure(result)) return undefined;
      return Option.isSome(result.success) ? result.success.value : undefined;
    }),
  );
};

const runVerbooCommand = Effect.fn("runVerbooCommand")(function* (
  verbooSettings: VerbooSettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const verbooEnvironment = yield* makeVerbooEnvironment(verbooSettings, environment);
  const command = ChildProcess.make(verbooSettings.binaryPath, [...args], {
    env: verbooEnvironment,
    shell: process.platform === "win32",
  });
  return yield* spawnAndCollect(verbooSettings.binaryPath, command);
});

export const checkVerbooProviderStatus = Effect.fn("checkVerbooProviderStatus")(function* (
  verbooSettings: VerbooSettings,
  resolveCapabilities?: (
    verbooSettings: VerbooSettings,
  ) => Effect.Effect<VerbooCapabilitiesProbe | undefined>,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Path.Path
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const seedModels = seedVerbooModels(verbooSettings);

  if (!verbooSettings.enabled) {
    return buildServerProvider({
      presentation: VERBOO_PRESENTATION,
      enabled: false,
      checkedAt,
      models: seedModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Verboo is disabled in T3 Code settings.",
      },
    });
  }

  const versionProbe = yield* runVerbooCommand(verbooSettings, ["--version"], environment).pipe(
    Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionProbe)) {
    const error = versionProbe.failure;
    return buildServerProvider({
      presentation: VERBOO_PRESENTATION,
      enabled: verbooSettings.enabled,
      checkedAt,
      models: seedModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "Verboo CLI (`verboo`) is not installed or not on PATH."
          : `Failed to execute Verboo CLI health check: ${error instanceof Error ? error.message : String(error)}.`,
      },
    });
  }

  if (Option.isNone(versionProbe.success)) {
    return buildServerProvider({
      presentation: VERBOO_PRESENTATION,
      enabled: verbooSettings.enabled,
      checkedAt,
      models: seedModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Verboo CLI is installed but failed to run. Timed out while running command.",
      },
    });
  }

  const version = versionProbe.success.value;
  const parsedVersion = parseGenericCliVersion(`${version.stdout}\n${version.stderr}`);
  if (version.code !== 0) {
    const detail = detailFromResult(version);
    return buildServerProvider({
      presentation: VERBOO_PRESENTATION,
      enabled: verbooSettings.enabled,
      checkedAt,
      models: seedModels,
      probe: {
        installed: true,
        version: parsedVersion,
        status: "error",
        auth: { status: "unknown" },
        message: detail
          ? `Verboo CLI is installed but failed to run. ${detail}`
          : "Verboo CLI is installed but failed to run.",
      },
    });
  }

  const capabilities = resolveCapabilities
    ? yield* resolveCapabilities(verbooSettings).pipe(Effect.orElseSucceed(() => undefined))
    : undefined;
  const slashCommands = capabilities?.slashCommands ?? [];
  const dedupedSlashCommands = dedupeSlashCommands(slashCommands);

  // Model discovery falls back to the seed model + custom models when the
  // probe could not enumerate any models (offline, unauthenticated, etc.).
  const discoveredModels =
    capabilities && capabilities.models.length > 0
      ? providerModelsFromSettings(
          capabilities.models,
          PROVIDER,
          verbooSettings.customModels,
          DEFAULT_VERBOO_MODEL_CAPABILITIES,
        )
      : seedModels;

  if (!capabilities) {
    return buildServerProvider({
      presentation: VERBOO_PRESENTATION,
      enabled: verbooSettings.enabled,
      checkedAt,
      models: discoveredModels,
      slashCommands: dedupedSlashCommands,
      probe: {
        installed: true,
        version: parsedVersion,
        status: "warning",
        auth: { status: "unknown" },
        message:
          "Could not verify Verboo authentication. If you have not signed in, run `verboo /login` in a terminal, then refresh.",
      },
    });
  }

  return buildServerProvider({
    presentation: VERBOO_PRESENTATION,
    enabled: verbooSettings.enabled,
    checkedAt,
    models: discoveredModels,
    slashCommands: dedupedSlashCommands,
    probe: {
      installed: true,
      version: parsedVersion,
      status: "ready",
      auth: {
        status: "authenticated",
        ...(capabilities.email ? { email: capabilities.email } : {}),
        label: "Account",
      },
    },
  });
});

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

export const makePendingVerbooProvider = (
  verbooSettings: VerbooSettings,
): Effect.Effect<ServerProviderDraft> =>
  Effect.gen(function* () {
    const checkedAt = yield* nowIso;
    const models = seedVerbooModels(verbooSettings);

    if (!verbooSettings.enabled) {
      return buildServerProvider({
        presentation: VERBOO_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Verboo is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: VERBOO_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Verboo provider status has not been checked in this session yet.",
      },
    });
  });

export { probeVerbooCapabilities };
