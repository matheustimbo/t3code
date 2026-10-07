import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpProtocol, McpServer } from "effect/ai";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import packageJson from "../../../package.json" with { type: "json" };
import * as ExternalReadAccess from "./ExternalReadAccess.ts";
import * as ExternalReadService from "./ExternalReadService.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as GrantStore from "../../persistence/ExternalReadGrantStore.ts";
import { normalizeMcpHttpResponse } from "../McpHttpServer.ts";
import { ExternalReadHandlers, ExternalReadToolkit } from "./ExternalReadToolkit.ts";

export const PATH = "/mcp/external-read";
const unauthorized = HttpServerResponse.jsonUnsafe(
  { error: "invalid_external_read_credential" },
  {
    status: 401,
    headers: { "cache-control": "no-store", "www-authenticate": "Bearer" },
  },
);

const authentication = HttpRouter.middleware<{
  provides: ExternalReadAccess.ExternalReadInvocation;
}>()(
  Effect.map(ExternalReadAccess.ExternalReadAccess, (access) =>
    Effect.fn("ExternalReadHttpServer.authenticate")(function* (httpEffect) {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const header = request.headers.authorization;
      const identity = yield* access
        .authenticate(header?.startsWith("Bearer ") === true ? header.slice(7).trim() : "")
        .pipe(Effect.catch(() => Effect.succeed(undefined)));
      if (identity === undefined) return unauthorized;
      return yield* httpEffect.pipe(
        Effect.provideService(ExternalReadAccess.ExternalReadInvocation, identity),
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

const enabledLayer = McpServer.toolkit(ExternalReadToolkit).pipe(
  Layer.provide(ExternalReadHandlers),
  Layer.provide(
    McpServer.layerHttp({
      name: "T3 Code external read",
      version: packageJson.version,
      path: PATH,
      protocols: [McpProtocol.v2025_06_18],
    }).pipe(Layer.provide(authentication)),
  ),
  // McpServer.layer is memoized and mutable. Freshen transport + toolkit together,
  // before providing access/read services, so the native catalog cannot be merged in.
  Layer.fresh,
  Layer.provide(ExternalReadService.layer),
  Layer.provide(ProjectionStore.layer),
  Layer.provide(ExternalReadAccess.layer.pipe(Layer.provide(GrantStore.layer))),
);

// A distinct transport instance keeps native provider tools outside this catalog.
export const layer = Layer.unwrap(
  Effect.map(ExternalReadAccess.ExternalReadSettings, (settings) =>
    settings.enabled ? enabledLayer : Layer.empty,
  ),
);
