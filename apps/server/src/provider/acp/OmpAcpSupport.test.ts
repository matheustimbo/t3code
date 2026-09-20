import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  buildOmpAcpSpawnInput,
  isValidOmpThinkingToken,
  normalizeOmpThinking,
  OMP_AUTH_METHOD_ID,
  OMP_DEFAULT_MODEL_SLUG,
  ompAcpSpawnArgs,
  ompSelectOptionValues,
  applyOmpAcpModelSelection,
  resolveOmpAcpBaseModelId,
} from "./OmpAcpSupport.ts";

describe("resolveOmpAcpBaseModelId", () => {
  it("falls back to the auto product slug", () => {
    expect(resolveOmpAcpBaseModelId(undefined)).toBe(OMP_DEFAULT_MODEL_SLUG);
    expect(resolveOmpAcpBaseModelId("   ")).toBe(OMP_DEFAULT_MODEL_SLUG);
  });

  it("keeps provider/model selectors verbatim", () => {
    expect(resolveOmpAcpBaseModelId("anthropic/claude-opus-4-8")).toBe("anthropic/claude-opus-4-8");
  });
});

describe("ompAcpSpawnArgs", () => {
  it("starts the ACP server with the binary default", () => {
    expect(ompAcpSpawnArgs()).toEqual(["acp"]);
  });

  it("maps T3 runtime modes onto omp approval modes", () => {
    expect(ompAcpSpawnArgs("approval-required")).toEqual(["--approval-mode", "always-ask", "acp"]);
    expect(ompAcpSpawnArgs("auto-accept-edits")).toEqual(["--approval-mode", "write", "acp"]);
    expect(ompAcpSpawnArgs("auto")).toEqual(["--approval-mode", "write", "acp"]);
    expect(ompAcpSpawnArgs("full-access")).toEqual(["--approval-mode", "yolo", "acp"]);
  });
});

describe("buildOmpAcpSpawnInput", () => {
  it("defaults to the omp binary on PATH", () => {
    expect(buildOmpAcpSpawnInput(undefined, "/repo")).toMatchObject({
      command: "omp",
      args: ["acp"],
      cwd: "/repo",
    });
  });

  it("honors a custom binary path", () => {
    expect(buildOmpAcpSpawnInput({ binaryPath: "/opt/omp" }, "/repo")).toMatchObject({
      command: "/opt/omp",
    });
  });
});

describe("omp thinking tokens", () => {
  it("accepts the levels advertised by session/new", () => {
    for (const level of ["off", "auto", "low", "medium", "high", "xhigh", "max"]) {
      expect(isValidOmpThinkingToken(level)).toBe(true);
    }
    expect(isValidOmpThinkingToken("ultra")).toBe(false);
  });

  it("normalizes case and trims", () => {
    expect(normalizeOmpThinking(" High ")).toBe("high");
    expect(normalizeOmpThinking("ultra")).toBeUndefined();
    expect(normalizeOmpThinking(undefined)).toBeUndefined();
  });
});

describe("omp ACP authentication", () => {
  it("uses the local-credentials method advertised by initialize", () => {
    expect(OMP_AUTH_METHOD_ID).toBe("agent");
  });
});

describe("ompSelectOptionValues", () => {
  it("collects flat select values", () => {
    expect(
      ompSelectOptionValues({
        id: "thinking",
        name: "Thinking",
        type: "select",
        currentValue: "high",
        options: [
          { name: "Low", value: "low" },
          { name: "High", value: "high" },
        ],
      }),
    ).toEqual(["low", "high"]);
  });

  it("collects grouped select values", () => {
    expect(
      ompSelectOptionValues({
        id: "thinking",
        name: "Thinking",
        type: "select",
        currentValue: "high",
        options: [{ group: "g", name: "G", options: [{ name: "High", value: "high" }] }],
      }),
    ).toEqual(["high"]);
  });

  it("returns no values for boolean options", () => {
    expect(
      ompSelectOptionValues({ id: "x", name: "X", type: "boolean", currentValue: true }),
    ).toEqual([]);
  });
});

describe("applyOmpAcpModelSelection", () => {
  const stubRuntime = (
    calls: Array<string>,
    options?: {
      readonly thinking?: { readonly current: string; readonly values: ReadonlyArray<string> };
    },
  ) => ({
    getConfigOptions: Effect.succeed(
      options?.thinking
        ? ([
            {
              id: "thinking",
              type: "select",
              currentValue: options.thinking.current,
              options: options.thinking.values.map((value) => ({ name: value, value })),
            },
          ] as never)
        : ([] as never),
    ),
    setConfigOption: (configId: string, value: string | boolean) =>
      Effect.sync(() => {
        calls.push(`config:${configId}=${value}`);
        return {};
      }),
    setModel: (model: string) =>
      Effect.sync(() => {
        calls.push(`model:${model}`);
        return {};
      }),
  });

  it.effect("keeps the session model for the auto product slug", () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];
      yield* applyOmpAcpModelSelection({
        runtime: stubRuntime(calls, { thinking: { current: "high", values: ["low", "high"] } }),
        model: "auto",
        selections: [],
        mapError: (context) => context.step,
      });
      expect(calls).toEqual([]);
    }),
  );

  it.effect("sets an explicit model and thinking level", () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];
      yield* applyOmpAcpModelSelection({
        runtime: stubRuntime(calls, { thinking: { current: "high", values: ["low", "high"] } }),
        model: "anthropic/claude-opus-4-8",
        selections: [{ id: "thinking", value: "low" }],
        mapError: (context) => context.step,
      });
      expect(calls).toEqual(["model:anthropic/claude-opus-4-8", "config:thinking=low"]);
    }),
  );

  it.effect("skips thinking updates already at the requested level", () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];
      yield* applyOmpAcpModelSelection({
        runtime: stubRuntime(calls, { thinking: { current: "high", values: ["low", "high"] } }),
        model: "auto",
        selections: [{ id: "thinking", value: "high" }],
        mapError: (context) => context.step,
      });
      expect(calls).toEqual([]);
    }),
  );

  it.effect("skips thinking when the session does not advertise it", () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];
      yield* applyOmpAcpModelSelection({
        runtime: stubRuntime(calls),
        model: "auto",
        selections: [{ id: "thinking", value: "low" }],
        mapError: (context) => context.step,
      });
      expect(calls).toEqual([]);
    }),
  );

  it.effect("skips stale thinking levels the session does not offer", () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];
      yield* applyOmpAcpModelSelection({
        runtime: stubRuntime(calls, { thinking: { current: "high", values: ["low", "high"] } }),
        model: "auto",
        selections: [{ id: "thinking", value: "max" }],
        mapError: (context) => context.step,
      });
      expect(calls).toEqual([]);
    }),
  );
});
