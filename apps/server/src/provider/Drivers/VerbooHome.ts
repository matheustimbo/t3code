import * as NodeOS from "node:os";

import type { VerbooSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import { expandHomePath } from "../../pathExpansion.ts";

/**
 * Ensure the Verboo binary's own directory is on PATH.
 *
 * The `@verboo/code` CLI is a `#!/usr/bin/env node` script, so spawning it
 * requires `node` to be resolvable from the child process's PATH. When T3 Code
 * runs as a GUI app (launched from Finder/Dock), the process inherits only the
 * minimal launchd PATH (`/usr/bin:/bin:/usr/sbin:/sbin`) — without nvm, Homebrew
 * or `/usr/local/bin` — so neither `verboo` nor `node` is found.
 *
 * For nvm/npm-global installs the `verboo` symlink lives in the same `bin`
 * directory as `node`. So when the configured binary path is absolute, we
 * prepend its directory to PATH: this lets the binary resolve and lets its
 * shebang find the co-located `node`, without the user having to set a PATH
 * environment variable by hand. A bare command name (e.g. `"verboo"`) is left
 * untouched — there is no directory to derive.
 */
export function withVerbooBinaryDirOnPath(
  env: NodeJS.ProcessEnv,
  binaryPath: string,
): NodeJS.ProcessEnv {
  const trimmed = binaryPath.trim();
  if (!trimmed.includes("/")) return env;
  const expanded = expandHomePath(trimmed);
  const dir = expanded.slice(0, expanded.lastIndexOf("/")) || "/";
  const delimiter = process.platform === "win32" ? ";" : ":";
  const current = env.PATH ?? "";
  const parts = current.split(delimiter).filter(Boolean);
  if (parts.includes(dir)) return env;
  return { ...env, PATH: [dir, ...parts].join(delimiter) };
}

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
