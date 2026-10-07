import * as NodePlatformCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import { ExternalControlMutationResult } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { McpProtocol, McpSchema, McpServer, Tool, Toolkit } from "effect/ai";
import { HttpRouter, HttpServerResponse } from "effect/http";
import * as Access from "./ExternalReadAccess.ts";
import * as Http from "./ExternalControlHttpServer.ts";
import * as ReadHttp from "./ExternalReadHttpServer.ts";
import { allowed, blocked, seed, token } from "./testSupport.ts";
import { controlGrant, controlLayer, controlToken, modelSelection } from "./controlTestSupport.ts";

type Handler = (request: Request) => Promise<Response>;
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
        structuredContent: Schema.optional(Schema.Unknown),
        isError: Schema.optional(Schema.Boolean),
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
  bearer = controlToken,
  session?: string,
  path = Http.PATH,
) =>
  Effect.promise(() =>
    handler(
      new Request(`http://fixture.invalid${path}`, {
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
const initialize = (handler: Handler, bearer = controlToken, path = Http.PATH) =>
  request(
    handler,
    "initialize",
    {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "headless-external-fixture", version: "1" },
    },
    bearer,
    undefined,
    path,
  );
const payload = Effect.fn("externalControlFixturePayload")(function* (response: Response) {
  const text = yield* Effect.promise(() => response.text());
  return yield* Schema.decodeUnknownEffect(responseSchema)(text.match(/\{.*\}/s)?.[0] ?? text);
});
const nativeToolkit = Toolkit.make(
  Tool.make("fixture_native_mutation", {
    parameters: Schema.Struct({ value: Schema.String }),
    success: Schema.Struct({ touched: Schema.Boolean }),
  })
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Destructive, true),
);
const nativeLayer = McpServer.toolkit(nativeToolkit).pipe(
  Layer.provide(
    nativeToolkit.toLayer({ fixture_native_mutation: () => Effect.succeed({ touched: true }) }),
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
const revoke = HttpRouter.add(
  "POST",
  "/fixture-revoke",
  Effect.gen(function* () {
    yield* (yield* Access.ExternalReadAccess).revoke(controlGrant.id);
    return HttpServerResponse.empty({ status: 204 });
  }),
);
const fixture = controlLayer({ ...controlGrant, expiresAt: Number.MAX_SAFE_INTEGER });
const app = Layer.mergeAll(
  Http.layer,
  ReadHttp.layer,
  nativeLayer,
  revoke,
  Layer.effectDiscard(seed),
).pipe(
  Layer.provideMerge(Access.layer),
  Layer.provideMerge(fixture),
  Layer.provide(Layer.succeed(Http.ExternalControlSettings, { enabled: true })),
  Layer.provide(NodePlatformCrypto.layer),
);
const withApp = <A, E>(test: (handler: Handler) => Effect.Effect<A, E>, enabled = true) =>
  Effect.scoped(
    Effect.gen(function* () {
      const application = enabled
        ? app
        : Http.layer.pipe(
            Layer.provideMerge(Access.layer),
            Layer.provide(fixture),
            Layer.provide(NodePlatformCrypto.layer),
          );
      const { handler } = yield* Effect.acquireRelease(
        Effect.sync(() => HttpRouter.toWebHandler(application, { disableLogger: true })),
        ({ dispose }) => Effect.promise(dispose),
      );
      return yield* test(handler);
    }),
  );

it.effect("is disabled by default and rejects other audiences before establishing a session", () =>
  Effect.gen(function* () {
    yield* withApp(
      (handler) =>
        Effect.gen(function* () {
          expect((yield* initialize(handler)).status).toBe(404);
        }),
      false,
    );
    yield* withApp((handler) =>
      Effect.gen(function* () {
        for (const bearer of ["", "provider-fixture", token])
          expect((yield* initialize(handler, bearer)).status).toBe(401);
        expect((yield* initialize(handler, controlToken, ReadHttp.PATH)).status).toBe(401);
      }),
    );
  }),
);

it.effect(
  "exposes seven isolated tools to a headless HTTP client and rejects a reused session after revocation",
  () =>
    withApp((handler) =>
      Effect.gen(function* () {
        const init = yield* initialize(handler);
        expect(init.status).toBe(200);
        const session = init.headers.get("mcp-session-id")!;
        const list = yield* request(handler, "tools/list", {}, controlToken, session);
        expect(list.headers.get("cache-control")).toBe("no-store");
        const tools = (yield* payload(list)).result?.tools ?? [];
        expect(tools.map((tool) => tool.name).sort()).toEqual([
          "external_project_list",
          "external_thread_create",
          "external_thread_interrupt",
          "external_thread_list",
          "external_thread_messages",
          "external_thread_send",
          "external_thread_status",
        ]);
        expect(
          tools.find((tool) => tool.name === "external_thread_messages")?.annotations.readOnlyHint,
        ).toBe(true);
        expect(
          tools.find((tool) => tool.name === "external_thread_interrupt")?.annotations
            .destructiveHint,
        ).toBe(true);
        for (const name of [
          "fixture_native_mutation",
          "delegate_task",
          "t3_thread_read",
          "t3_thread_organize",
          "preview_evaluate",
        ]) {
          const denied = yield* payload(
            yield* request(
              handler,
              "tools/call",
              { name, arguments: { value: "fixture" } },
              controlToken,
              session,
            ),
          );
          expect(denied.error !== undefined || denied.result?.isError === true).toBe(true);
        }
        expect(
          (yield* request(handler, "tools/list", {}, "provider-fixture", session)).status,
        ).toBe(401);
        yield* Effect.promise(() =>
          handler(new Request("http://fixture.invalid/fixture-revoke", { method: "POST" })),
        );
        expect((yield* request(handler, "tools/list", {}, controlToken, session)).status).toBe(401);
      }),
    ),
);

it.effect(
  "performs native create/send/read/interrupt through HTTP, with durable retries and closed inputs",
  () =>
    withApp((handler) =>
      Effect.gen(function* () {
        const session = (yield* initialize(handler)).headers.get("mcp-session-id")!;
        const call = (name: string, arguments_: unknown) =>
          Effect.gen(function* () {
            const response = yield* request(
              handler,
              "tools/call",
              { name, arguments: arguments_ },
              controlToken,
              session,
            );
            expect(response.status).toBe(200);
            const { result, error } = yield* payload(response);
            if (error !== undefined) return { error };
            // Declared failures arrive as error results whose text is the encoded failure.
            return result?.isError === true
              ? yield* decodeJson(result.content?.[0]?.text ?? "")
              : result?.structuredContent;
          });
        const create = {
          projectId: allowed,
          requestKey: "http-create",
          title: "Synthetic HTTP fixture",
          modelSelection,
          runtimeMode: "approval-required",
          interactionMode: "plan",
        };
        const created = yield* Schema.decodeUnknownEffect(ExternalControlMutationResult)(
          yield* call("external_thread_create", create),
        );
        expect(yield* call("external_thread_create", create)).toEqual(created);
        const send = {
          projectId: allowed,
          threadId: created.threadId,
          requestKey: "http-send",
          text: "Synthetic HTTP prompt",
          mode: "auto",
        };
        const sent = yield* call("external_thread_send", send);
        expect(yield* call("external_thread_send", send)).toEqual(sent);
        expect(
          yield* call("external_thread_messages", {
            projectId: allowed,
            threadId: created.threadId,
          }),
        ).toMatchObject({ total: 1, items: [{ text: send.text }] });
        expect(
          yield* call("external_thread_send", {
            ...send,
            requestKey: "http-invalid",
            attachments: [{ id: "foreign" }],
          }),
        ).toEqual({ error: { code: McpSchema.INVALID_PARAMS_ERROR_CODE } });
        expect(
          yield* call("external_thread_create", {
            ...create,
            requestKey: "http-invalid-create",
            parentThreadId: "foreign",
          }),
        ).toEqual({ error: { code: McpSchema.INVALID_PARAMS_ERROR_CODE } });
        expect(
          yield* call("external_thread_messages", {
            projectId: blocked,
            threadId: created.threadId,
          }),
        ).toMatchObject({ code: "access_denied" });
        expect(
          yield* call("external_thread_send", {
            ...send,
            threadId: "foreign",
            requestKey: "http-foreign",
          }),
        ).toMatchObject({ code: "not_found" });
        expect(
          yield* call("external_thread_messages", {
            projectId: allowed,
            threadId: created.threadId,
          }),
        ).toMatchObject({ total: 1 });
        const interrupt = {
          projectId: allowed,
          threadId: created.threadId,
          requestKey: "http-interrupt",
        };
        const interrupted = yield* call("external_thread_interrupt", interrupt);
        expect(interrupted).toMatchObject({ outcome: "accepted" });
        expect(yield* call("external_thread_interrupt", interrupt)).toEqual(interrupted);
      }),
    ),
);
