// @effect-diagnostics nodeBuiltinImport:off -- fixtures hash tokens synchronously, as grants store them.
import * as NodeCrypto from "node:crypto";
import * as NodePlatformCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { McpProtocol, McpSchema, McpServer, Tool, Toolkit } from "effect/ai";
import { HttpRouter, HttpServerResponse } from "effect/http";

import * as Access from "./ExternalReadAccess.ts";
import * as GrantStore from "../../persistence/ExternalReadGrantStore.ts";
import * as Http from "./ExternalReadHttpServer.ts";
import {
  allowed,
  blocked,
  environmentLayer,
  grant,
  registerFixtures,
  seed,
  storesLayer,
  token,
} from "./testSupport.ts";

type Handler = (request: Request) => Promise<Response>;
const secondToken = "external-read-second-fixture";
const secondGrant = {
  ...grant,
  expiresAt: Number.MAX_SAFE_INTEGER,
  id: "second",
  principalId: "second-principal",
  projectIds: [blocked],
  tokenHash: NodeCrypto.createHash("sha256").update(secondToken).digest("hex"),
};
const settings = Layer.succeed(Access.ExternalReadSettings, {
  enabled: true,
  grants: [
    { ...grant, expiresAt: Number.MAX_SAFE_INTEGER },
    secondGrant,
    {
      ...grant,
      id: "expired",
      principalId: "expired",
      expiresAt: 0,
      tokenHash: NodeCrypto.createHash("sha256").update("expired-fixture").digest("hex"),
    },
  ],
});
const responseSchema = Schema.fromJsonString(
  Schema.Struct({
    result: Schema.optional(
      Schema.Struct({
        tools: Schema.optional(
          Schema.Array(
            Schema.Struct({
              name: Schema.String,
              annotations: Schema.Struct({
                readOnlyHint: Schema.Boolean,
                destructiveHint: Schema.Boolean,
              }),
            }),
          ),
        ),
        isError: Schema.optional(Schema.Boolean),
        structuredContent: Schema.optional(Schema.Unknown),
        content: Schema.optional(Schema.Array(Schema.Struct({ text: Schema.String }))),
      }),
    ),
    error: Schema.optional(Schema.Struct({ code: Schema.Number })),
  }),
);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const request = (
  handler: Handler,
  method: string,
  params: unknown,
  bearer = token,
  session?: string,
) =>
  Effect.promise(() =>
    handler(
      new Request(`http://fixture.invalid${Http.PATH}`, {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${bearer}`,
          "content-type": "application/json",
          "mcp-protocol-version": "2025-06-18",
          ...(session === undefined ? {} : { "mcp-session-id": session }),
        },
        body: encodeJson({ jsonrpc: "2.0", id: 1, method, params }),
      }),
    ),
  );
const initialize = (handler: Handler, bearer = token) =>
  request(
    handler,
    "initialize",
    {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "external-fixture", version: "1" },
    },
    bearer,
  );
const payload = Effect.fn("fixtureMcpPayload")(function* (response: Response) {
  const text = yield* Effect.promise(() => response.text());
  return yield* Schema.decodeUnknownEffect(responseSchema)(text.match(/\{.*\}/s)?.[0] ?? text);
});
const fixtureRevoke = HttpRouter.add(
  "POST",
  "/fixture-revoke",
  Effect.gen(function* () {
    const access = yield* Access.ExternalReadAccess;
    yield* access.revoke(grant.id);
    return HttpServerResponse.empty({ status: 204 });
  }),
);
const nativeFixtureToolkit = Toolkit.make(
  Tool.make("fixture_native_mutation", {
    parameters: Schema.Struct({ value: Schema.String }),
    success: Schema.Struct({ touched: Schema.Boolean }),
  })
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Destructive, true),
);
const nativeFixtureLayer = McpServer.toolkit(nativeFixtureToolkit).pipe(
  Layer.provide(
    nativeFixtureToolkit.toLayer({
      fixture_native_mutation: () => Effect.succeed({ touched: true }),
    }),
  ),
  Layer.provide(
    McpServer.layerHttp({
      name: "native fixture",
      version: "1",
      path: "/mcp",
      protocols: [McpProtocol.v2025_06_18],
    }),
  ),
);
const app = Layer.mergeAll(
  Http.layer,
  nativeFixtureLayer,
  fixtureRevoke,
  Layer.effectDiscard(seed),
  Layer.effectDiscard(registerFixtures),
).pipe(
  Layer.provideMerge(Access.layer),
  Layer.provideMerge(GrantStore.layer),
  Layer.provide(storesLayer),
  Layer.provide(environmentLayer),
  Layer.provide(settings),
  Layer.provide(NodePlatformCrypto.layer),
);
const withApp = <A, E>(test: (handler: Handler) => Effect.Effect<A, E>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const { handler } = yield* Effect.acquireRelease(
        Effect.sync(() => HttpRouter.toWebHandler(app, { disableLogger: true })),
        ({ dispose }) => Effect.promise(dispose),
      );
      return yield* test(handler);
    }),
  );

it.effect("has no route when settings are omitted (production default)", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { handler } = yield* Effect.acquireRelease(
        Effect.sync(() =>
          HttpRouter.toWebHandler(
            Http.layer.pipe(
              Layer.provide(storesLayer),
              Layer.provide(environmentLayer),
              Layer.provide(NodePlatformCrypto.layer),
            ),
            { disableLogger: true },
          ),
        ),
        ({ dispose }) => Effect.promise(dispose),
      );
      expect((yield* initialize(handler)).status).toBe(404);
    }),
  ),
);

it.effect("authenticates every request and exposes exactly three read tools", () =>
  withApp((handler) =>
    Effect.gen(function* () {
      for (const bearer of ["", "provider-fixture", "expired-fixture"])
        expect((yield* initialize(handler, bearer)).status).toBe(401);
      const init = yield* initialize(handler);
      expect(init.status).toBe(200);
      const session = init.headers.get("mcp-session-id")!;
      const initialized = yield* Effect.promise(() =>
        handler(
          new Request(`http://fixture.invalid${Http.PATH}`, {
            method: "POST",
            headers: {
              accept: "application/json, text/event-stream",
              "content-type": "application/json",
              authorization: `Bearer ${token}`,
              "mcp-session-id": session,
              "mcp-protocol-version": "2025-06-18",
            },
            body: encodeJson({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }),
          }),
        ),
      );
      expect(initialized.status).toBe(202);
      const list = yield* request(handler, "tools/list", {}, token, session);
      expect(list.headers.get("cache-control")).toBe("no-store");
      const tools = (yield* payload(list)).result?.tools ?? [];
      expect(tools.map((tool) => tool.name).sort()).toEqual([
        "external_project_list",
        "external_thread_list",
        "external_thread_status",
      ]);
      for (const tool of tools)
        expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
      const invalid = yield* payload(
        yield* request(
          handler,
          "tools/call",
          {
            name: "external_thread_list",
            arguments: { projectId: allowed, limit: 101 },
          },
          token,
          session,
        ),
      );
      expect(invalid.error?.code).toBe(McpSchema.INVALID_PARAMS_ERROR_CODE);
      for (const name of [
        "fixture_native_mutation",
        "delegate_task",
        "t3_thread_read",
        "task_status",
        "t3_thread_organize",
        "t3_worktree_handoff",
        "preview_evaluate",
      ]) {
        const rejected = yield* payload(
          yield* request(
            handler,
            "tools/call",
            { name, arguments: { value: "fixture" } },
            token,
            session,
          ),
        );
        expect(rejected.error !== undefined || rejected.result?.isError === true).toBe(true);
      }
      yield* Effect.promise(() =>
        handler(new Request("http://fixture.invalid/fixture-revoke", { method: "POST" })),
      );
      expect((yield* request(handler, "tools/list", {}, token, session)).status).toBe(401);
    }),
  ),
);

it.effect("uses the current request principal even when an MCP session ID is reused", () =>
  withApp((handler) =>
    Effect.gen(function* () {
      const session = (yield* initialize(handler)).headers.get("mcp-session-id")!;
      const denied = yield* payload(
        yield* request(
          handler,
          "tools/call",
          {
            name: "external_thread_list",
            arguments: { projectId: allowed },
          },
          secondToken,
          session,
        ),
      );
      expect(denied.result?.isError).toBe(true);
      // Declared failures arrive as error results whose text is the encoded failure.
      expect(yield* decodeJson(denied.result?.content?.[0]?.text ?? "")).toMatchObject({
        code: "access_denied",
      });
      const projects = yield* payload(
        yield* request(
          handler,
          "tools/call",
          { name: "external_project_list", arguments: {} },
          secondToken,
          session,
        ),
      );
      expect(projects.result?.structuredContent).toMatchObject({
        total: 1,
        items: [{ id: blocked }],
      });
    }),
  ),
);
