// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { EnvironmentId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

const Config = Schema.Struct({
  enabled: Schema.Boolean,
  port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
});
export type ExternalMcpConfiguration = typeof Config.Type;
const decodeConfiguration = Schema.decodeUnknownEffect(Config);
const decodeConfig = Schema.decodeUnknownSync(Schema.fromJsonString(Config));
const encodeConfig = Schema.encodeSync(Schema.fromJsonString(Config));
const decodeEnvironmentId = Schema.decodeUnknownSync(EnvironmentId);
export class ExternalMcpConfigError extends Schema.TaggedError<ExternalMcpConfigError>()(
  "ExternalMcpConfigError",
  { code: Schema.Literals(["invalid_home", "invalid_config", "configuration_failed"]) },
) {
  override get message(): string {
    return `External MCP configuration failed (${this.code}).`;
  }
}
export interface ExternalMcpHome {
  readonly stateDir: string;
  readonly dbPath: string;
  readonly environmentId: EnvironmentId;
}
export class ExternalMcpConfig extends Context.Service<
  ExternalMcpConfig,
  {
    readonly existingHome: (
      baseDir: string,
    ) => Effect.Effect<ExternalMcpHome, ExternalMcpConfigError>;
    readonly read: (
      stateDir: string,
    ) => Effect.Effect<ExternalMcpConfiguration, ExternalMcpConfigError>;
    readonly configure: (
      baseDir: string,
      configuration: ExternalMcpConfiguration,
    ) => Effect.Effect<void, ExternalMcpConfigError>;
  }
>()("t3/mcp/external/ExternalMcpConfig") {}

const make = Effect.sync(() => {
  const validate = async (path: string, kind: "file" | "directory") => {
    const info = await NodeFSP.lstat(path);
    if (
      (kind === "file" ? !info.isFile() : !info.isDirectory()) ||
      info.isSymbolicLink() ||
      process.getuid === undefined ||
      info.uid !== process.getuid() ||
      (info.mode & 0o022) !== 0
    )
      throw new Error("invalid owner or path");
  };
  const read = (stateDir: string) =>
    Effect.tryPromise({
      try: async () => {
        const path = NodePath.join(stateDir, "external-mcp.json");
        try {
          await validate(path, "file");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT")
            return { enabled: false, port: 3774 };
          throw error;
        }
        await validate(stateDir, "directory");
        const info = await NodeFSP.stat(path);
        if (info.size > 4096) throw new Error("oversized configuration");
        return decodeConfig(await NodeFSP.readFile(path, "utf8"), { onExcessProperty: "error" });
      },
      catch: () => new ExternalMcpConfigError({ code: "invalid_config" }),
    });
  const existingHome = (baseDir: string) =>
    Effect.tryPromise({
      try: async () => {
        if (!NodePath.isAbsolute(baseDir)) throw new Error("absolute home required");
        const resolved = NodePath.resolve(baseDir);
        // Resolve ancestors too: a writable or redirected state path must not be
        // confused with the explicitly selected environment.
        if ((await NodeFSP.realpath(resolved)) !== resolved) throw new Error("redirected home");
        for (let ancestor = NodePath.dirname(resolved); ; ancestor = NodePath.dirname(ancestor)) {
          const info = await NodeFSP.lstat(ancestor);
          // Sticky temporary parents prevent another user from renaming this
          // owner's home. Ordinary group/world-writable ancestors do not.
          if (
            !info.isDirectory() ||
            info.isSymbolicLink() ||
            ((info.mode & 0o022) !== 0 && (info.mode & 0o1000) === 0)
          )
            throw new Error("writable ancestor");
          if (ancestor === NodePath.dirname(ancestor)) break;
        }
        await validate(resolved, "directory");
        const stateDir = NodePath.join(resolved, "userdata");
        const dbPath = NodePath.join(stateDir, "statev2.sqlite");
        const idPath = NodePath.join(stateDir, "environment-id");
        await validate(stateDir, "directory");
        await validate(dbPath, "file");
        await validate(idPath, "file");
        for (const suffix of ["-wal", "-shm"]) {
          try {
            await validate(`${dbPath}${suffix}`, "file");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        }
        if ((await NodeFSP.stat(idPath)).size > 256) throw new Error("invalid environment ID");
        const environmentId = decodeEnvironmentId((await NodeFSP.readFile(idPath, "utf8")).trim());
        return { stateDir, dbPath, environmentId };
      },
      catch: () => new ExternalMcpConfigError({ code: "invalid_home" }),
    });
  return ExternalMcpConfig.of({
    existingHome,
    read,
    configure: (baseDir, configuration) =>
      Effect.gen(function* () {
        const home = yield* existingHome(baseDir);
        yield* read(home.stateDir);
        const decoded = yield* decodeConfiguration(configuration).pipe(
          Effect.mapError(() => new ExternalMcpConfigError({ code: "invalid_config" })),
        );
        yield* Effect.tryPromise({
          try: async () => {
            const target = NodePath.join(home.stateDir, "external-mcp.json");
            const temporary = await NodeFSP.mkdtemp(NodePath.join(home.stateDir, ".external-mcp-"));
            try {
              const file = NodePath.join(temporary, "config");
              await NodeFSP.writeFile(file, `${encodeConfig(decoded)}\n`, {
                flag: "wx",
                mode: 0o600,
              });
              await NodeFSP.rename(file, target);
            } finally {
              await NodeFSP.rm(temporary, { recursive: true, force: true });
            }
          },
          catch: () => new ExternalMcpConfigError({ code: "configuration_failed" }),
        });
      }),
  });
});
export const layer = Layer.effect(ExternalMcpConfig, make);
