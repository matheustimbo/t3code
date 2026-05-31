import * as NodeOS from "node:os";

import type { VerbooSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import { expandHomePath } from "../../pathExpansion.ts";

export const resolveVerbooHomePath = Effect.fn("resolveVerbooHomePath")(function* (
  config: Pick<VerbooSettings, "homePath">,
): Effect.fn.Return<string, never, Path.Path> {
  const path = yield* Path.Path;
  const homePath = config.homePath.trim();
  return path.resolve(homePath.length > 0 ? expandHomePath(homePath) : NodeOS.homedir());
});

export const makeVerbooEnvironment = Effect.fn("makeVerbooEnvironment")(function* (
  config: Pick<VerbooSettings, "homePath">,
  baseEnv: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<NodeJS.ProcessEnv, never, Path.Path> {
  const homePath = config.homePath.trim();
  if (homePath.length === 0) return baseEnv;
  const resolvedHomePath = yield* resolveVerbooHomePath(config);
  return {
    ...baseEnv,
    HOME: resolvedHomePath,
  };
});

export const makeVerbooContinuationGroupKey = Effect.fn("makeVerbooContinuationGroupKey")(
  function* (config: Pick<VerbooSettings, "homePath">): Effect.fn.Return<string, never, Path.Path> {
    const resolvedHomePath = yield* resolveVerbooHomePath(config);
    return `verboo:home:${resolvedHomePath}`;
  },
);

export const makeVerbooCapabilitiesCacheKey = Effect.fn("makeVerbooCapabilitiesCacheKey")(
  function* (
    config: Pick<VerbooSettings, "binaryPath" | "homePath">,
  ): Effect.fn.Return<string, never, Path.Path> {
    const resolvedHomePath = yield* resolveVerbooHomePath(config);
    return `${config.binaryPath}\0${resolvedHomePath}`;
  },
);
