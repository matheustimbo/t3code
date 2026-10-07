import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Command, Flag } from "effect/cli";
import * as Admin from "../mcp/external/ExternalMcpAdmin.ts";
import * as Client from "../mcp/external/ExternalMcpClient.ts";
import * as Configuration from "../mcp/external/ExternalMcpConfig.ts";
import * as Stdio from "../mcp/external/ExternalMcpStdio.ts";

const decodePolicy = Schema.decodeUnknownEffect(Admin.Policy);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const location = {
  baseDir: Flag.String("base-dir").pipe(
    Flag.withDescription("Explicit existing T3 home; absolute path required."),
  ),
};
const enable = Command.make("enable", {
  ...location,
  port: Flag.Int("port").pipe(Flag.withDefault(3774)),
}).pipe(
  Command.withHandler(({ baseDir, port }) =>
    Effect.gen(function* () {
      yield* (yield* Configuration.ExternalMcpConfig).configure(baseDir, { enabled: true, port });
      yield* Console.log(
        encodeJson({ enabled: true, host: "127.0.0.1", port, appliesAfterRestart: true }),
      );
    }).pipe(Effect.provide(Configuration.layer)),
  ),
);
const disable = Command.make("disable", location).pipe(
  Command.withHandler(({ baseDir }) =>
    Effect.gen(function* () {
      const config = yield* Configuration.ExternalMcpConfig;
      const home = yield* config.existingHome(baseDir);
      const previous = yield* config.read(home.stateDir);
      yield* config.configure(baseDir, { ...previous, enabled: false });
      yield* Console.log(encodeJson({ enabled: false, appliesAfterRestart: true }));
    }).pipe(Effect.provide(Configuration.layer)),
  ),
);
const list = Command.make("list", location).pipe(
  Command.withHandler(({ baseDir }) =>
    Effect.gen(function* () {
      yield* Console.log(encodeJson(yield* (yield* Admin.ExternalMcpAdmin).list));
    }).pipe(Effect.provide(Admin.layerFor(baseDir))),
  ),
);
const revoke = Command.make("revoke", { ...location, id: Flag.String("id") }).pipe(
  Command.withHandler(({ baseDir, id }) =>
    Effect.gen(function* () {
      yield* (yield* Admin.ExternalMcpAdmin).revoke(id);
      yield* Console.log(encodeJson({ credentialId: id, revoked: true }));
    }).pipe(Effect.provide(Admin.layerFor(baseDir))),
  ),
);
const run = Command.make("run", {
  ...location,
  environmentId: Flag.String("environment-id"),
  projectId: Flag.String("project"),
  principalId: Flag.String("principal"),
  tools: Flag.String("tools").pipe(
    Flag.withDescription("Explicit comma-separated external tool names."),
  ),
  ttlSeconds: Flag.Int("ttl-seconds").pipe(Flag.withDefault(600)),
  runtimeModeCeiling: Flag.String("runtime-ceiling").pipe(Flag.withDefault("approval-required")),
  interactionModeCeiling: Flag.String("interaction-ceiling").pipe(Flag.withDefault("plan")),
}).pipe(
  Command.withHandler(({ baseDir, tools, ...flags }) =>
    Effect.gen(function* () {
      const policy = yield* decodePolicy(
        { ...flags, tools: tools.split(",") },
        { onExcessProperty: "error" },
      ).pipe(Effect.mapError(() => new Admin.ExternalMcpAdminError({ code: "invalid_policy" })));
      const session = yield* (yield* Client.ExternalMcpClient).open(policy);
      const io = yield* Stdio.ExternalMcpStdio;
      yield* io.write({
        type: "ready",
        credentialId: session.credentialId,
        expiresAt: session.expiresAt,
      });
      yield* io.input.pipe(
        Stream.runForEach((call) =>
          Effect.flatMap(session.call(call), (result) => io.write({ tool: call.tool, result })),
        ),
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(Client.layer.pipe(Layer.provide(Admin.layerFor(baseDir)))),
    ),
  ),
);

export const externalMcpCommand = Command.make("external-mcp").pipe(
  Command.withDescription("Opt in to local external MCP and run an ephemeral scoped client."),
  Command.withSubcommands([enable, disable, list, revoke, run]),
);
