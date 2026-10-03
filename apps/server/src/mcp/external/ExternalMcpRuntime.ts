// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { ExternalMcpDescriptor, ExternalMcpTool } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";
import packageJson from "../../../package.json" with { type: "json" };
import * as ServerConfig from "../../config.ts";
import * as Environment from "../../environment/ServerEnvironment.ts";
import * as Startup from "../../serverRuntimeStartup.ts";
import { guardHttpResponseWriteErrors } from "../../httpResponseErrorGuard.ts";
import * as Configuration from "./ExternalMcpConfig.ts";
import * as Access from "./ExternalReadAccess.ts";
import * as ReadHttp from "./ExternalReadHttpServer.ts";
import * as ControlHttp from "./ExternalControlHttpServer.ts";

const descriptor = HttpRouter.add(
  "GET",
  "/.well-known/t3/external-mcp",
  Effect.gen(function* () {
    const environment = yield* Environment.ServerEnvironment;
    const value: typeof ExternalMcpDescriptor.Type = {
      environmentId: yield* environment.getEnvironmentId,
      version: packageJson.version,
      protocol: "2025-06-18",
      tools: [...ExternalMcpTool.literals],
    };
    return HttpServerResponse.jsonUnsafe(value, { headers: { "cache-control": "no-store" } });
  }),
);
const readiness = HttpRouter.middleware(
  (httpEffect) =>
    Effect.flatMap(Startup.ServerRuntimeStartup, (startup) =>
      startup.awaitCommandReady.pipe(
        Effect.andThen(httpEffect),
        Effect.catchTag("ServerRuntimeStartupError", () =>
          Effect.succeed(HttpServerResponse.empty({ status: 503 })),
        ),
      ),
    ),
  { global: true },
);

/** Dedicated listener; no native APIs, cookies, websocket, relay or Tailscale layer. */
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const settings = yield* (yield* Configuration.ExternalMcpConfig).read(config.stateDir);
    if (!settings.enabled) return Layer.empty;
    const server = guardHttpResponseWriteErrors(NodeHttp.createServer());
    const listener = NodeHttpServer.layer(() => server, {
      host: "127.0.0.1",
      port: settings.port,
      disablePreemptiveShutdown: true,
    });
    return HttpRouter.serve(
      Layer.mergeAll(descriptor, ReadHttp.layer, ControlHttp.layer).pipe(Layer.provide(readiness)),
      { disableLogger: true },
    ).pipe(
      Layer.provide(listener),
      // Close only our listener and connections. A zero-duration timeout on the
      // platform's cached shutdown can leave an interrupted finalizer to replay.
      Layer.tap(() =>
        Effect.addFinalizer(() =>
          Effect.callback<void>((resume) => {
            server.close(() => resume(Effect.void));
            server.closeAllConnections();
          }),
        ),
      ),
      // Freshen the entire router/listener/transport graph, not just McpServer.
      // Native orchestration and persistence are supplied outside this boundary.
      Layer.fresh,
      Layer.provide(
        Layer.succeed(Access.ExternalReadSettings, {
          enabled: true,
          persistedGrants: true,
          grants: [],
        }),
      ),
      Layer.provide(Layer.succeed(ControlHttp.ExternalControlSettings, { enabled: true })),
    );
  }),
).pipe(Layer.provide(Configuration.layer));
