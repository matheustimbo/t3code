// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { ExternalMcpClientCall, ExternalMcpDescriptor, ExternalMcpTool } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Admin from "./ExternalMcpAdmin.ts";
import * as Configuration from "./ExternalMcpConfig.ts";
import { PATH } from "./ExternalControlHttpServer.ts";

export class ExternalMcpClientError extends Schema.TaggedError<ExternalMcpClientError>()(
  "ExternalMcpClientError",
  {
    code: Schema.Literals([
      "disabled",
      "transport_failed",
      "wrong_environment",
      "unexpected_catalog",
      "invalid_input",
      "operation_denied",
      "protocol_failed",
    ]),
  },
) {
  override get message(): string {
    return `External MCP client failed (${this.code}).`;
  }
}
export class ExternalMcpClient extends Context.Service<
  ExternalMcpClient,
  {
    /** Acquires an ephemeral grant; scope exit durably revokes it. */
    readonly open: (policy: Admin.Policy) => Effect.Effect<
      {
        readonly credentialId: string;
        readonly expiresAt: number;
        readonly call: (
          input: ExternalMcpClientCall,
        ) => Effect.Effect<unknown, ExternalMcpClientError>;
      },
      ExternalMcpClientError | Admin.ExternalMcpAdminError | Configuration.ExternalMcpConfigError,
      Scope.Scope
    >;
  }
>()("t3/mcp/external/ExternalMcpClient") {}
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeRpc = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      jsonrpc: Schema.Literal("2.0"),
      id: Schema.optional(Schema.Number),
      result: Schema.optional(Schema.Unknown),
      error: Schema.optional(Schema.Unknown),
    }),
  ),
);
const decodeDescriptor = Schema.decodeUnknownEffect(Schema.fromJsonString(ExternalMcpDescriptor));
const decodeCall = Schema.decodeUnknownEffect(ExternalMcpClientCall);
const decodeCatalog = Schema.decodeUnknownEffect(
  Schema.Struct({ tools: Schema.Array(Schema.Struct({ name: Schema.String })) }),
);
const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const admin = yield* Admin.ExternalMcpAdmin;
  const home = yield* Admin.ExternalMcpTarget;
  const configuration = yield* Configuration.ExternalMcpConfig;
  const hex = (bytes: Uint8Array) =>
    Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return ExternalMcpClient.of({
    open: (policy) =>
      Effect.gen(function* () {
        const config = yield* configuration.read(home.stateDir);
        if (!config.enabled) return yield* new ExternalMcpClientError({ code: "disabled" });
        if (policy.environmentId !== home.environmentId)
          return yield* new ExternalMcpClientError({ code: "wrong_environment" });
        // Node's direct HTTP transport neither consults proxy variables nor follows
        // redirects. The bearer can only reach this explicit IPv4 loopback socket.
        const request = (path: string, body?: string, bearer?: string, session?: string) =>
          Effect.tryPromise({
            try: (signal) =>
              new Promise<{ text: string; session?: string }>((resolve, reject) => {
                const req = NodeHttp.request(
                  {
                    hostname: "127.0.0.1",
                    port: config.port,
                    path,
                    method: body === undefined ? "GET" : "POST",
                    agent: false,
                    signal,
                    headers: {
                      accept: "application/json, text/event-stream",
                      "mcp-protocol-version": "2025-06-18",
                      ...(body === undefined
                        ? {}
                        : {
                            "content-type": "application/json",
                            "content-length": Buffer.byteLength(body),
                          }),
                      ...(bearer === undefined ? {} : { authorization: `Bearer ${bearer}` }),
                      ...(session === undefined ? {} : { "mcp-session-id": session }),
                    },
                  },
                  (response) => {
                    if (
                      (response.statusCode ?? 0) < 200 ||
                      (response.statusCode ?? 0) >= 300 ||
                      response.headers["set-cookie"] !== undefined
                    ) {
                      response.destroy();
                      reject(new Error("rejected response"));
                      return;
                    }
                    const chunks: Buffer[] = [];
                    let size = 0;
                    response.on("data", (chunk: Buffer) => {
                      size += chunk.byteLength;
                      if (size > 2 * 1024 * 1024) {
                        response.destroy();
                        reject(new Error("oversized response"));
                      } else chunks.push(chunk);
                    });
                    response.on("error", reject);
                    response.on("end", () => {
                      const value = response.headers["mcp-session-id"];
                      if (
                        value !== undefined &&
                        (typeof value !== "string" || value.length > 256)
                      ) {
                        reject(new Error("invalid session"));
                        return;
                      }
                      resolve({
                        text: Buffer.concat(chunks).toString("utf8"),
                        ...(value === undefined ? {} : { session: value }),
                      });
                    });
                  },
                );
                req.on("error", reject);
                req.end(body);
              }),
            catch: () => new ExternalMcpClientError({ code: "transport_failed" }),
          }).pipe(
            Effect.timeout("15 seconds"),
            Effect.mapError(() => new ExternalMcpClientError({ code: "transport_failed" })),
          );
        const descriptorResponse = yield* request("/.well-known/t3/external-mcp");
        const descriptor = yield* decodeDescriptor(descriptorResponse.text, {
          onExcessProperty: "error",
        }).pipe(Effect.mapError(() => new ExternalMcpClientError({ code: "wrong_environment" })));
        if (descriptor.environmentId !== home.environmentId)
          return yield* new ExternalMcpClientError({ code: "wrong_environment" });
        const token = hex(
          yield* crypto
            .randomBytes(32)
            .pipe(Effect.mapError(() => new ExternalMcpClientError({ code: "transport_failed" }))),
        );
        const tokenHash = hex(
          yield* crypto
            .digest("SHA-256", new TextEncoder().encode(token))
            .pipe(Effect.mapError(() => new ExternalMcpClientError({ code: "transport_failed" }))),
        );
        const id = yield* crypto.randomUUIDv4.pipe(
          Effect.mapError(() => new ExternalMcpClientError({ code: "transport_failed" })),
        );
        const grant = yield* Effect.acquireRelease(
          admin.register(policy, id, tokenHash),
          (registered) => admin.revoke(registered.id).pipe(Effect.orDie),
        );
        let sequence = 0,
          session: string | undefined;
        const rpc = Effect.fn("ExternalMcpClient.rpc")(function* (
          method: string,
          params: unknown,
          notification = false,
        ) {
          const rpcId = ++sequence;
          const response = yield* request(
            PATH,
            encodeJson({ jsonrpc: "2.0", ...(notification ? {} : { id: rpcId }), method, params }),
            token,
            session,
          );
          if (response.session !== undefined) session = response.session;
          if (notification) return undefined;
          return yield* Effect.try({
            try: () => {
              const texts =
                response.text.startsWith("data:") || response.text.startsWith("event:")
                  ? response.text
                      .split(/\r?\n\r?\n/u)
                      .map((event) =>
                        event
                          .split(/\r?\n/u)
                          .filter((line) => line.startsWith("data:"))
                          .map((line) => line.slice(5).trimStart())
                          .join("\n"),
                      )
                      .filter(Boolean)
                  : [response.text];
              const payloads = texts.map((text) => decodeRpc(text));
              const payload = payloads.find((candidate) => candidate.id === rpcId);
              if (
                payload?.jsonrpc !== "2.0" ||
                payload.error !== undefined ||
                !("result" in payload)
              )
                throw new Error("invalid RPC response");
              return payload.result;
            },
            catch: () => new ExternalMcpClientError({ code: "protocol_failed" }),
          });
        });
        yield* rpc("initialize", {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "t3-external-local-client", version: "1" },
        });
        yield* rpc("notifications/initialized", {}, true);
        const catalog = yield* rpc("tools/list", {});
        const decoded = yield* decodeCatalog(catalog).pipe(
          Effect.mapError(() => new ExternalMcpClientError({ code: "unexpected_catalog" })),
        );
        if (
          decoded.tools
            .map((tool) => tool.name)
            .toSorted()
            .join(",") !== ExternalMcpTool.literals.toSorted().join(",") ||
          descriptor.tools.toSorted().join(",") !== ExternalMcpTool.literals.toSorted().join(",")
        )
          return yield* new ExternalMcpClientError({ code: "unexpected_catalog" });
        return {
          credentialId: grant.id,
          expiresAt: grant.expiresAt,
          call: (input) =>
            Effect.gen(function* () {
              const call = yield* decodeCall(input, {
                onExcessProperty: "error",
              }).pipe(Effect.mapError(() => new ExternalMcpClientError({ code: "invalid_input" })));
              if (!policy.tools.includes(call.tool))
                return yield* new ExternalMcpClientError({ code: "operation_denied" });
              if (Buffer.byteLength(encodeJson(call)) > 131072)
                return yield* new ExternalMcpClientError({ code: "invalid_input" });
              return yield* rpc("tools/call", { name: call.tool, arguments: call.arguments });
            }),
        };
      }),
  });
});
export const layer = Layer.effect(ExternalMcpClient, make).pipe(
  Layer.provide(Configuration.layer),
  Layer.provide(NodeCrypto.layer),
);
