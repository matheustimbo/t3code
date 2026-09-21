import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { OmpSettings } from "@t3tools/contracts";

import {
  buildInitialOmpProviderSnapshot,
  checkOmpProviderStatus,
  ompThinkingCapabilitiesForLevels,
  OMP_DEFAULT_MODEL_SLUG,
  OMP_THINKING_CAPABILITIES,
  parseOmpModelsJsonOutput,
  parseOmpUsageOutput,
} from "./OmpProvider.ts";
import { writeFakeCli } from "../../testUtils/fakeCli.ts";

const decodeOmpSettings = Schema.decodeSync(OmpSettings);

const MODELS_JSON = JSON.stringify({
  models: [
    {
      provider: "anthropic",
      id: "claude-opus-4-8",
      selector: "anthropic/claude-opus-4-8",
      name: "Claude Opus 4.8",
      thinking: ["low", "medium", "high", "xhigh", "max"],
    },
    {
      provider: "openai",
      id: "gpt-5.2",
      selector: "openai/gpt-5.2",
      name: "GPT 5.2",
      thinking: null,
    },
    // Duplicate selector collapses to one entry.
    {
      provider: "anthropic",
      id: "claude-opus-4-8",
      selector: "anthropic/claude-opus-4-8",
      name: "Claude Opus 4.8",
      thinking: ["low", "medium", "high", "xhigh", "max"],
    },
    // Missing selector is skipped, never fatal.
    { provider: "anthropic", id: "broken", name: "Broken" },
  ],
});

describe("parseOmpModelsJsonOutput", () => {
  it("reads selectors, names, and per-model thinking levels", () => {
    const models = parseOmpModelsJsonOutput(MODELS_JSON);
    expect(models.map((model) => [model.slug, model.name])).toEqual([
      ["anthropic/claude-opus-4-8", "Claude Opus 4.8"],
      ["openai/gpt-5.2", "GPT 5.2"],
    ]);
    expect(models.every((model) => model.isCustom === false)).toBe(true);
    const thinking = models[0]?.capabilities?.optionDescriptors?.find(
      (entry) => entry.id === "thinking",
    );
    expect(thinking?.type).toBe("select");
    if (thinking?.type === "select") {
      expect(thinking.options.map((option) => option.id)).toEqual([
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
      ]);
    }
  });

  it("omits the thinking picker for models without thinking support", () => {
    const models = parseOmpModelsJsonOutput(MODELS_JSON);
    expect(models[1]?.capabilities?.optionDescriptors ?? []).toEqual([]);
  });

  it("returns no models for invalid JSON", () => {
    expect(parseOmpModelsJsonOutput("not json")).toEqual([]);
    expect(parseOmpModelsJsonOutput('{"other":true}')).toEqual([]);
  });
});

describe("ompThinkingCapabilitiesForLevels", () => {
  it("labels known levels and capitalizes unknown ones", () => {
    const capabilities = ompThinkingCapabilitiesForLevels(["minimal", "xhigh"]);
    const descriptor = capabilities.optionDescriptors?.[0];
    expect(descriptor?.type).toBe("select");
    if (descriptor?.type === "select") {
      expect(descriptor.options).toEqual([
        { id: "minimal", label: "Minimal" },
        { id: "xhigh", label: "Extra high" },
      ]);
    }
  });

  it("returns empty capabilities without levels", () => {
    expect(ompThinkingCapabilitiesForLevels(null).optionDescriptors ?? []).toEqual([]);
    expect(ompThinkingCapabilitiesForLevels([]).optionDescriptors ?? []).toEqual([]);
  });
});

describe("parseOmpUsageOutput", () => {
  it("detects a logged-out CLI even though it exits 0", () => {
    expect(
      parseOmpUsageOutput("No credentials found. Run `omp` and use /login to add accounts.\n"),
    ).toBe(false);
  });

  it("treats account output as authenticated", () => {
    expect(parseOmpUsageOutput("anthropic: ok\n")).toBe(true);
  });

  it("returns unknown for empty output", () => {
    expect(parseOmpUsageOutput("  \n ")).toBeNull();
  });
});

describe("omp built-in model", () => {
  it("keeps auto as the session-current product slug", () => {
    expect(OMP_DEFAULT_MODEL_SLUG).toBe("auto");
  });

  it("exposes the thinking levels advertised by session/new", () => {
    const descriptor = OMP_THINKING_CAPABILITIES.optionDescriptors?.find(
      (entry) => entry.id === "thinking",
    );
    expect(descriptor?.type).toBe("select");
    if (descriptor?.type === "select") {
      expect(descriptor.options.map((option) => option.id)).toEqual([
        "off",
        "auto",
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
      ]);
    }
  });
});

describe("buildInitialOmpProviderSnapshot", () => {
  it.effect("returns a disabled snapshot when off", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialOmpProviderSnapshot(decodeOmpSettings({}));
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
      expect(snapshot.models.map((model) => model.slug)).toEqual(["auto"]);
    }),
  );
});

it.layer(NodeServices.layer)("checkOmpProviderStatus", (it) => {
  const writeFakeOmpCli = (input: {
    readonly usageOutput: string | null;
    readonly modelsOutput: string | null;
  }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-omp-probe-" });
      return writeFakeCli({
        directory: dir,
        name: "omp",
        source: [
          'if (process.argv[2] === "--version") {',
          '  process.stdout.write("omp/18.2.6\\n");',
          "  process.exit(0);",
          "}",
          'if (process.argv[2] === "usage") {',
          ...(input.usageOutput === null
            ? ["  process.exit(3);"]
            : [
                // @effect-diagnostics-next-line preferSchemaOverJson:off
                `  process.stdout.write(${JSON.stringify(input.usageOutput)});`,
                "  process.exit(0);",
              ]),
          "}",
          'if (process.argv[2] === "models") {',
          ...(input.modelsOutput === null
            ? ["  process.exit(3);"]
            : [
                // @effect-diagnostics-next-line preferSchemaOverJson:off
                `  process.stdout.write(${JSON.stringify(input.modelsOutput)});`,
                "  process.exit(0);",
              ]),
          "}",
          "process.exit(1);",
          "",
        ].join("\n"),
      });
    });

  it.effect("reports ready with CLI-listed models when logged in", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const ompPath = yield* writeFakeOmpCli({
            usageOutput: "anthropic: ok\n",
            modelsOutput: MODELS_JSON,
          });
          return yield* checkOmpProviderStatus(
            decodeOmpSettings({ enabled: true, binaryPath: ompPath }),
          );
        }),
      );

      expect(snapshot.status).toBe("ready");
      expect(snapshot.version).toBe("18.2.6");
      expect(snapshot.auth).toEqual({
        status: "authenticated",
        type: "cached_token",
        label: "omp account",
      });
      expect(snapshot.models.map((model) => model.slug)).toEqual([
        "auto",
        "anthropic/claude-opus-4-8",
        "openai/gpt-5.2",
      ]);
    }),
  );

  it.effect("reports unauthenticated from omp usage without starting a session", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const ompPath = yield* writeFakeOmpCli({
            usageOutput: "No credentials found. Run `omp` and use /login to add accounts.\n",
            modelsOutput: MODELS_JSON,
          });
          return yield* checkOmpProviderStatus(
            decodeOmpSettings({ enabled: true, binaryPath: ompPath }),
          );
        }),
      );

      expect(snapshot.status).toBe("error");
      expect(snapshot.auth.status).toBe("unauthenticated");
      expect(snapshot.message).toContain("/login");
    }),
  );

  it.effect("warns instead of ready when a probe fails", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const ompPath = yield* writeFakeOmpCli({
            usageOutput: "anthropic: ok\n",
            modelsOutput: null,
          });
          return yield* checkOmpProviderStatus(
            decodeOmpSettings({ enabled: true, binaryPath: ompPath }),
          );
        }),
      );

      expect(snapshot.status).toBe("warning");
      expect(snapshot.message).toContain("models");
      // Fallback models keep the picker usable.
      expect(snapshot.models.map((model) => model.slug)).toEqual(["auto"]);
    }),
  );

  it.effect("reports the binary as missing when the binary path does not resolve", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkOmpProviderStatus(
        decodeOmpSettings({
          enabled: true,
          binaryPath: "/definitely/not/installed/omp-binary",
        }),
      );
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(false);
      expect(snapshot.status).toBe("error");
    }),
  );
});
