// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";
import * as NodeFSP from "node:fs/promises";
import * as NodeChildProcess from "node:child_process";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NetService from "@t3tools/shared/Net";
import { expect, it } from "@effect/vitest";
import {
  ExternalControlMutationResult,
  ExternalMcpClientCall,
  ExternalMcpTool,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/cli";
import { McpProtocol, McpServer, Tool, Toolkit } from "effect/ai";
import {
  FetchHttpClient,
  HttpClient,
  HttpRouter,
  HttpServer,
  HttpServerResponse,
} from "effect/http";
import * as SqlClient from "effect/sql/SqlClient";
import { cli } from "../../binCli.ts";
import * as ServerConfig from "../../config.ts";
import * as Startup from "../../serverRuntimeStartup.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as Grants from "../../persistence/ExternalReadGrantStore.ts";
import * as Configuration from "./ExternalMcpConfig.ts";
import * as Admin from "./ExternalMcpAdmin.ts";
import * as Client from "./ExternalMcpClient.ts";
import * as Runtime from "./ExternalMcpRuntime.ts";
import * as Stdio from "./ExternalMcpStdio.ts";
import { nativeLayerFor, modelSelection } from "./controlTestSupport.ts";
import { allowed, blocked, environmentLayer, grant, seed } from "./testSupport.ts";

const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decode = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const mutation = Schema.decodeUnknownEffect(
  Schema.Struct({ structuredContent: ExternalControlMutationResult }),
);
// Declared tool failures arrive as error results whose text is the encoded failure.
const failureCode = (result: unknown) =>
  Schema.decodeUnknownEffect(
    Schema.Struct({
      isError: Schema.Literal(true),
      content: Schema.Tuple([
        Schema.Struct({ text: Schema.fromJsonString(Schema.Struct({ code: Schema.String })) }),
      ]),
    }),
  )(result).pipe(Effect.map(({ content: [{ text }] }) => text.code));
const runCli = (args: ReadonlyArray<string>) =>
  Command.runWith(cli, { version: "fixture", renderErrors: false })(["external-mcp", ...args]).pipe(
    Effect.provide(Layer.mergeAll(NodeServices.layer, NetService.layer, TestConsole.layer)),
  );
const localPort = Effect.tryPromise({
  try: () =>
    new Promise<number>((resolve, reject) => {
      const server = NodeHttp.createServer();
      server.on("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (address === null || typeof address === "string") {
          server.close();
          reject(new Error("missing address"));
          return;
        }
        server.close((error) => (error ? reject(error) : resolve(address.port)));
      });
    }),
  catch: () => new Client.ExternalMcpClientError({ code: "transport_failed" }),
});
const makeHome = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const raw = yield* fs.makeTempDirectoryScoped({
    directory: "/tmp",
    prefix: "external-mcp-production-",
  });
  const baseDir = yield* Effect.promise(() => NodeFSP.realpath(raw));
  const configContext = yield* Layer.build(ServerConfig.layerTest(process.cwd(), baseDir));
  const config = Context.get(configContext, ServerConfig.ServerConfig);
  yield* fs.writeFileString(config.environmentIdPath, `${grant.environmentId}\n`);
  return { baseDir, config, database: SqlitePersistence.layerFromPath(config.dbPath) };
});
type Home = Effect.Success<typeof makeHome>;
const policy: Admin.Policy = {
  environmentId: grant.environmentId,
  projectId: allowed,
  principalId: "production-fixture",
  ttlSeconds: 600,
  tools: [...ExternalMcpTool.literals],
  runtimeModeCeiling: "approval-required",
  interactionModeCeiling: "plan",
};
const cliFlags = (home: Home, overrides: Partial<Admin.Policy> = {}) => {
  const value = { ...policy, ...overrides };
  return [
    "run",
    "--base-dir",
    home.baseDir,
    "--environment-id",
    value.environmentId,
    "--project",
    value.projectId,
    "--principal",
    value.principalId,
    "--ttl-seconds",
    String(value.ttlSeconds),
    "--tools",
    value.tools.join(","),
    "--runtime-ceiling",
    value.runtimeModeCeiling,
    "--interaction-ceiling",
    value.interactionModeCeiling,
  ];
};
const services = (home: Home) =>
  Layer.mergeAll(
    Grants.layer,
    ProjectStore.layer,
    ProjectionStore.layer,
    ThreadManagement.layer.pipe(Layer.provide(nativeLayerFor(home.database))),
  ).pipe(
    Layer.provideMerge(home.database),
    Layer.provideMerge(environmentLayer),
    Layer.provideMerge(ServerConfig.layer(home.config)),
    Layer.provideMerge(NodeServices.layer),
  );
const readiness = (ready: Effect.Effect<void, Startup.ServerRuntimeStartupError> = Effect.void) =>
  Layer.succeed(Startup.ServerRuntimeStartup, {
    awaitCommandReady: ready,
    markHttpListening: Effect.void,
    enqueueCommand: (effect) => ready.pipe(Effect.andThen(effect)),
  });
const withServer = <A, E>(
  home: Home,
  test: Effect.Effect<A, E, SqlClient.SqlClient | Grants.ExternalReadGrantStore | Scope.Scope>,
  ready = readiness(),
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(
        Runtime.layer.pipe(Layer.provideMerge(services(home)), Layer.provide(ready)),
      );
      return yield* test.pipe(Effect.provide(context));
    }),
  );
const create: ExternalMcpClientCall = {
  tool: "external_thread_create",
  arguments: {
    projectId: allowed,
    requestKey: "production-create",
    title: "Synthetic production integration",
    modelSelection,
    runtimeMode: "approval-required",
    interactionMode: "plan",
  },
};
const io = (calls: ReadonlyArray<ExternalMcpClientCall>, output: unknown[]) =>
  Layer.succeed(Stdio.ExternalMcpStdio, {
    input: Stream.fromIterable(calls),
    write: (value) =>
      Effect.sync(() => {
        output.push(value);
      }),
  });

it.effect(
  "runs the production root CLI and dedicated HTTP runtime, all seven tools, renew/restart/retry/revoke",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const home = yield* makeHome;
        const port = yield* localPort;
        yield* seed.pipe(Effect.provide(services(home)));
        yield* runCli(["enable", "--base-dir", home.baseDir, "--port", String(port)]);
        const first: unknown[] = [];
        yield* withServer(home, runCli(cliFlags(home)).pipe(Effect.provide(io([create], first))));
        const created = yield* mutation((first[1] as { result: unknown }).result);
        const threadId = created.structuredContent.threadId;
        const send: ExternalMcpClientCall = {
          tool: "external_thread_send",
          arguments: {
            projectId: allowed,
            threadId,
            requestKey: "production-send",
            text: "Synthetic text, provider worker disabled",
            mode: "auto",
          },
        };
        const interrupt: ExternalMcpClientCall = {
          tool: "external_thread_interrupt",
          arguments: { projectId: allowed, threadId, requestKey: "production-interrupt" },
        };
        const second: unknown[] = [];
        yield* withServer(
          home,
          Effect.gen(function* () {
            yield* runCli(cliFlags(home)).pipe(
              Effect.provide(
                io(
                  [
                    { tool: "external_project_list", arguments: {} },
                    { tool: "external_thread_list", arguments: { projectId: allowed } },
                    { tool: "external_thread_status", arguments: { projectId: allowed, threadId } },
                    create,
                    send,
                    {
                      tool: "external_thread_messages",
                      arguments: { projectId: allowed, threadId },
                    },
                    interrupt,
                  ],
                  second,
                ),
              ),
            );
            const sql = yield* SqlClient.SqlClient;
            expect(
              yield* sql`SELECT COUNT(*) AS count FROM orchestration_v2_projection_messages WHERE thread_id = ${threadId}`,
            ).toEqual([{ count: 1 }]);
            expect(yield* sql`SELECT COUNT(*) AS count FROM external_control_requests`).toEqual([
              { count: 3 },
            ]);
            expect(yield* sql`SELECT revoked_at FROM external_read_grants`).toEqual(
              expect.arrayContaining([expect.objectContaining({ revoked_at: expect.any(Number) })]),
            );
            yield* sql`UPDATE external_control_requests SET result_json = NULL`;
          }),
        );
        const third: unknown[] = [];
        yield* withServer(
          home,
          Effect.gen(function* () {
            yield* runCli(cliFlags(home)).pipe(
              Effect.provide(io([create, send, interrupt], third)),
            );
            expect((third[1] as { result: unknown }).result).toEqual(
              (first[1] as { result: unknown }).result,
            );
            expect((third[2] as { result: unknown }).result).toEqual(
              (second[5] as { result: unknown }).result,
            );
            const sql = yield* SqlClient.SqlClient;
            expect(
              yield* sql`SELECT COUNT(*) AS count FROM orchestration_v2_projection_messages WHERE thread_id = ${threadId}`,
            ).toEqual([{ count: 1 }]);
            expect(yield* sql`SELECT COUNT(*) AS count FROM external_control_requests`).toEqual([
              { count: 3 },
            ]);
            const rows = yield* sql<{
              token_hash: string;
              policy_json: string;
            }>`SELECT token_hash,policy_json FROM external_read_grants`;
            expect(rows).toHaveLength(3);
            expect(new Set(rows.map((row) => row.token_hash)).size).toBe(3);
            expect(encode([...first, ...second, ...third])).not.toMatch(
              /tokenHash|authorization|Bearer/u,
            );
            yield* runCli(["list", "--base-dir", home.baseDir]);
            // An explicitly revoked live session cannot call or retry accepted tools.
            yield* Effect.scoped(
              Effect.gen(function* () {
                const session = yield* (yield* Client.ExternalMcpClient).open(policy);
                yield* runCli(["revoke", "--base-dir", home.baseDir, "--id", session.credentialId]);
                expect(
                  yield* session
                    .call(create)
                    .pipe(
                      Effect.match({ onFailure: (error) => error, onSuccess: () => undefined }),
                    ),
                ).toMatchObject({ code: "transport_failed" });
              }).pipe(
                Effect.provide(Client.layer.pipe(Layer.provide(Admin.layerFor(home.baseDir)))),
              ),
            );
          }),
        );
        yield* runCli(["disable", "--base-dir", home.baseDir]);
        yield* withServer(
          home,
          Effect.gen(function* () {
            expect(
              yield* runCli(cliFlags(home)).pipe(Effect.provide(io([], [])), Effect.flip),
            ).toMatchObject({ code: "disabled" });
          }),
        );
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
);

const nativeToolkit = Toolkit.make(
  Tool.make("native_fixture_tool", {
    parameters: Schema.Struct({ value: Schema.String }),
    success: Schema.Struct({ touched: Schema.Boolean }),
  }),
);
const nativeRoutes = Layer.mergeAll(
  HttpRouter.add("GET", "/api/fixture", HttpServerResponse.text("native")),
  HttpRouter.add("GET", "/ws", HttpServerResponse.text("native")),
  McpServer.toolkit(nativeToolkit).pipe(
    Layer.provide(
      nativeToolkit.toLayer({ native_fixture_tool: () => Effect.succeed({ touched: true }) }),
    ),
    Layer.provide(
      McpServer.layerHttp({
        name: "native fixture",
        version: "1",
        path: "/mcp",
        protocols: [McpProtocol.v2025_06_18],
      }),
    ),
  ),
);
it.effect("isolates two real listeners and waits on the production command readiness gate", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const home = yield* makeHome,
        port = yield* localPort;
      yield* seed.pipe(Effect.provide(services(home)));
      yield* runCli(["enable", "--base-dir", home.baseDir, "--port", String(port)]);
      const gate = yield* Startup.makeCommandGate;
      const reached = yield* Deferred.make<void>();
      const external = Runtime.layer.pipe(
        Layer.provide(
          readiness(
            Deferred.succeed(reached, undefined).pipe(Effect.andThen(gate.awaitCommandReady)),
          ),
        ),
      );
      const primary = HttpRouter.serve(nativeRoutes, {
        disableLogger: true,
        disableListenLog: true,
      }).pipe(
        Layer.provideMerge(
          NodeHttpServer.layer(() => NodeHttp.createServer(), { host: "127.0.0.1", port: 0 }),
        ),
      );
      const context = yield* Layer.build(
        Layer.mergeAll(primary, external).pipe(Layer.provide(services(home))),
      );
      const address = Context.get(context, HttpServer.HttpServer).address;
      if (address._tag === "UnixPathAddress") return yield* Effect.die("missing TCP address");
      const http = yield* HttpClient.HttpClient;
      const request = (target: number, path: string) =>
        http.get(`http://127.0.0.1:${target}${path}`);
      const pending = yield* Effect.forkScoped(request(port, "/.well-known/t3/external-mcp"));
      yield* Deferred.await(reached);
      expect(pending.pollUnsafe()).toBeUndefined();
      yield* gate.signalCommandReady;
      expect((yield* Fiber.join(pending)).status).toBe(200);
      for (const path of ["/api/fixture", "/ws", "/mcp"]) {
        expect((yield* request(port, path)).status).toBe(404);
      }
      for (const path of [
        "/mcp/external-read",
        "/mcp/external-control",
        "/.well-known/t3/external-mcp",
      ]) {
        expect((yield* request(address.port, path)).status).toBe(404);
      }
      expect((yield* request(address.port, "/api/fixture")).status).toBe(200);
      const externalCatalog: unknown[] = [];
      yield* runCli(cliFlags(home)).pipe(
        Effect.provide(io([{ tool: "external_project_list", arguments: {} }], externalCatalog)),
      );
      expect(encode(externalCatalog)).not.toContain("native_fixture_tool");
    }).pipe(Effect.provide(Layer.mergeAll(FetchHttpClient.layer, NodeServices.layer))),
  ),
);

it.effect(
  "denies insufficient, expired and renewed foreign policies before replay or new sends",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const home = yield* makeHome,
          port = yield* localPort;
        yield* seed.pipe(Effect.provide(services(home)));
        yield* runCli(["enable", "--base-dir", home.baseDir, "--port", String(port)]);
        yield* withServer(
          home,
          Effect.scoped(
            Effect.gen(function* () {
              const client = yield* Client.ExternalMcpClient;
              const session = yield* client.open(policy);
              const created = yield* mutation(yield* session.call(create));
              const threadId = created.structuredContent.threadId;
              const send: ExternalMcpClientCall = {
                tool: "external_thread_send",
                arguments: {
                  projectId: allowed,
                  threadId,
                  requestKey: "guard-send",
                  text: "Synthetic guard",
                  mode: "auto",
                },
              };
              yield* session.call(send);
              const denied = yield* session.call({
                ...send,
                arguments: { ...send.arguments, requestKey: "new-send" },
              });
              expect(yield* failureCode(denied)).toBe("access_denied");
              const conflicting = yield* session.call({
                ...create,
                arguments: { ...create.arguments, title: "Changed input" },
              });
              expect(yield* failureCode(conflicting)).toBe("conflict");
              const readOnly = yield* client.open({ ...policy, tools: ["external_project_list"] });
              expect(
                yield* readOnly
                  .call(create)
                  .pipe(Effect.match({ onFailure: (error) => error, onSuccess: () => undefined })),
              ).toMatchObject({ code: "operation_denied" });
              const foreign = yield* client.open({ ...policy, projectId: blocked });
              expect(yield* failureCode(yield* foreign.call(create))).toBe("access_denied");
              const other = yield* client.open({ ...policy, principalId: "other-principal" });
              const separate = yield* mutation(yield* other.call(create));
              expect(separate.structuredContent.threadId).not.toBe(threadId);
              yield* TestClock.adjust("601 seconds");
              expect(
                yield* session
                  .call(create)
                  .pipe(Effect.match({ onFailure: (error) => error, onSuccess: () => undefined })),
              ).toMatchObject({ code: "transport_failed" });
            }).pipe(Effect.provide(Client.layer.pipe(Layer.provide(Admin.layerFor(home.baseDir))))),
          ),
        );
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
);

it.effect(
  "uses only an existing owned home and fails closed for missing, redirected or permissive state",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const home = yield* makeHome;
        const fs = yield* FileSystem.FileSystem;
        const config = yield* Configuration.ExternalMcpConfig;
        expect(yield* config.read(home.config.stateDir)).toEqual({ enabled: false, port: 3774 });
        expect(
          yield* runCli(["list", "--base-dir", `${home.baseDir}/missing`]).pipe(Effect.flip),
        ).toMatchObject({ code: "invalid_home" });
        expect(yield* fs.exists(`${home.baseDir}/missing`)).toBe(false);
        // makeHome has directories but no DB until the native persistence layer builds.
        expect(yield* config.existingHome(home.baseDir).pipe(Effect.flip)).toMatchObject({
          code: "invalid_home",
        });
        yield* seed.pipe(Effect.provide(services(home)));
        yield* config.configure(home.baseDir, { enabled: true, port: 3774 });
        const raw = yield* fs.readFileString(`${home.config.stateDir}/external-mcp.json`);
        expect(decode(raw)).toEqual({ enabled: true, port: 3774 });
        expect(
          (yield* Effect.promise(() => NodeFSP.stat(`${home.config.stateDir}/external-mcp.json`)))
            .mode & 0o777,
        ).toBe(0o600);
        yield* fs.remove(home.config.environmentIdPath);
        expect(yield* runCli(["list", "--base-dir", home.baseDir]).pipe(Effect.flip)).toMatchObject(
          { code: "invalid_home" },
        );
        expect(yield* fs.exists(home.config.environmentIdPath)).toBe(false);
        yield* fs.writeFileString(home.config.environmentIdPath, `${grant.environmentId}\n`);
        yield* Effect.promise(() => NodeFSP.chmod(home.config.dbPath, 0o666));
        expect(yield* config.existingHome(home.baseDir).pipe(Effect.flip)).toMatchObject({
          code: "invalid_home",
        });
        yield* Effect.promise(() => NodeFSP.chmod(home.config.dbPath, 0o600));
        yield* fs.remove(home.config.environmentIdPath);
        yield* Effect.promise(() =>
          NodeFSP.symlink(home.config.dbPath, home.config.environmentIdPath),
        );
        expect(yield* config.existingHome(home.baseDir).pipe(Effect.flip)).toMatchObject({
          code: "invalid_home",
        });
      }).pipe(Effect.provide(Layer.mergeAll(Configuration.layer, NodeServices.layer))),
    ),
);

class FixtureProcessError extends Schema.TaggedError<FixtureProcessError>()("FixtureProcessError", {
  code: Schema.String,
}) {}
it.live.each(["EOF", "SIGTERM"] as const)(
  "executes bin.ts with real stdin/stdout and revokes on %s without a provider process",
  (termination) =>
    Effect.scoped(
      Effect.gen(function* () {
        const home = yield* makeHome,
          port = yield* localPort;
        yield* seed.pipe(Effect.provide(services(home)));
        yield* runCli(["enable", "--base-dir", home.baseDir, "--port", String(port)]);
        yield* withServer(
          home,
          Effect.gen(function* () {
            const child = yield* Effect.acquireRelease(
              Effect.sync(() =>
                NodeChildProcess.spawn(
                  process.execPath,
                  [
                    new URL("../../bin.ts", import.meta.url).pathname,
                    "external-mcp",
                    ...cliFlags(home),
                  ],
                  { stdio: ["pipe", "pipe", "pipe"] },
                ),
              ),
              (process) =>
                Effect.callback<void>((resume) => {
                  if (process.exitCode !== null || process.signalCode !== null) {
                    resume(Effect.void);
                    return;
                  }
                  process.once("close", () => resume(Effect.void));
                  process.kill("SIGTERM");
                }),
            );
            const output = yield* Effect.callback<string, FixtureProcessError>((resume) => {
              let stdout = "";
              let signalled = false;
              child.on("error", () =>
                resume(Effect.fail(new FixtureProcessError({ code: "spawn" }))),
              );
              child.stdout.on("data", (chunk: Buffer) => {
                stdout += chunk.toString("utf8");
                if (Buffer.byteLength(stdout) > 2 * 1024 * 1024)
                  resume(Effect.fail(new FixtureProcessError({ code: "oversized_stdout" })));
                if (termination === "SIGTERM" && !signalled && stdout.includes("\n")) {
                  signalled = true;
                  child.kill("SIGTERM");
                }
              });
              child.stderr.resume();
              child.once("close", (code) =>
                resume(
                  code === 0 ||
                    (termination === "SIGTERM" &&
                      (code === 130 || code === 143 || child.signalCode === "SIGTERM"))
                    ? Effect.succeed(stdout)
                    : Effect.fail(new FixtureProcessError({ code: `exit_${code}` })),
                ),
              );
              if (termination === "EOF") child.stdin.end(`${encode(create)}\n`);
            }).pipe(Effect.timeout("30 seconds"));
            const records = output
              .trim()
              .split("\n")
              .map((line) => decode(line));
            expect(records).toHaveLength(termination === "EOF" ? 2 : 1);
            expect(records[0]).toMatchObject({ type: "ready" });
            if (termination === "EOF")
              expect(yield* mutation((records[1] as { result: unknown }).result)).toMatchObject({
                structuredContent: { projectId: allowed, outcome: "accepted" },
              });
            const sql = yield* SqlClient.SqlClient;
            expect(
              yield* sql`SELECT COUNT(*) AS count FROM external_read_grants WHERE revoked_at IS NULL`,
            ).toEqual([{ count: 0 }]);
            expect(output).not.toMatch(/Bearer|tokenHash|authorization/u);
          }),
        );
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
);
