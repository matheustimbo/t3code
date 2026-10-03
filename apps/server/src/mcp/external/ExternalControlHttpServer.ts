import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpProtocol, McpServer, Toolkit } from "effect/unstable/ai";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import packageJson from "../../../package.json" with { type: "json" };
import * as Access from "./ExternalReadAccess.ts";
import * as Control from "./ExternalControlService.ts";
import * as Reads from "./ExternalReadService.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as GrantStore from "../../persistence/ExternalReadGrantStore.ts";
import * as ControlStore from "../../persistence/ExternalControlStore.ts";
import { ExternalControlHandlers, ExternalControlToolkit } from "./ExternalControlToolkit.ts";
import { ExternalReadHandlers, ExternalReadToolkit } from "./ExternalReadToolkit.ts";
import { normalizeMcpHttpResponse } from "../McpHttpServer.ts";

export const PATH = "/mcp/external-control";
export class ExternalControlSettings extends Context.Reference<{ readonly enabled: boolean }>(
  "t3/mcp/external/ExternalControlSettings",
  { defaultValue: () => ({ enabled: false }) },
) {}
const authentication = HttpRouter.middleware<{ provides: Access.ExternalReadInvocation }>()(
  Effect.map(Access.ExternalReadAccess, (access) =>
    Effect.fn("ExternalControlHttpServer.authenticate")(function* (httpEffect) {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const header = request.headers.authorization;
      const identity = yield* access
        .authenticate(
          header?.startsWith("Bearer ") === true ? header.slice(7).trim() : "",
          Access.CONTROL_AUDIENCE,
        )
        .pipe(Effect.catch(() => Effect.succeed(undefined)));
      if (identity === undefined)
        return HttpServerResponse.jsonUnsafe(
          { error: "invalid_external_control_credential" },
          { status: 401, headers: { "cache-control": "no-store", "www-authenticate": "Bearer" } },
        );
      return yield* httpEffect.pipe(
        Effect.provideService(Access.ExternalReadInvocation, identity),
        Effect.map((response) =>
          HttpServerResponse.setHeader(
            normalizeMcpHttpResponse(response),
            "cache-control",
            "no-store",
          ),
        ),
      );
    }),
  ),
).layer;
const enabledLayer = McpServer.toolkit(
  Toolkit.merge(ExternalReadToolkit, ExternalControlToolkit),
).pipe(
  Layer.provide(Layer.merge(ExternalReadHandlers, ExternalControlHandlers)),
  Layer.provide(
    McpServer.layerHttp({
      name: "T3 Code external control",
      version: packageJson.version,
      path: PATH,
      protocols: [McpProtocol.v2025_06_18],
    }).pipe(Layer.provide(authentication)),
  ),
  Layer.fresh,
  Layer.provide(Control.layer.pipe(Layer.provide(ControlStore.layer))),
  Layer.provide(Reads.layer),
  Layer.provide(ProjectionStore.layer),
  Layer.provide(Access.layer.pipe(Layer.provide(GrantStore.layer))),
);
export const layer = Layer.unwrap(
  Effect.map(ExternalControlSettings, (settings) =>
    settings.enabled ? enabledLayer : Layer.empty,
  ),
);
