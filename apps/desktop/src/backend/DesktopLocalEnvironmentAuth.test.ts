import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";
import { PRIMARY_LOCAL_ENVIRONMENT_ID } from "@t3tools/contracts";
import {
  DESKTOP_BOOTSTRAP_TOKEN_WINDOW_MS,
  currentDesktopBootstrapToken,
} from "@t3tools/shared/desktopBootstrapToken";
import * as TestClock from "effect/testing/TestClock";

import * as DesktopBackendPool from "./DesktopBackendPool.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopLocalEnvironmentAuth from "./DesktopLocalEnvironmentAuth.ts";

const environmentLayer = (stateDir = "/home/user/.t3/userdata") =>
  Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
    stateDir,
    backendEntryPath: "/app/server/bin.js",
  } as unknown as DesktopEnvironment.DesktopEnvironment["Service"]);

const forbiddenSpawnerLayer = Layer.succeed(
  ChildProcessSpawner.ChildProcessSpawner,
  ChildProcessSpawner.make(() => Effect.die("unexpected child process spawn")),
);

const config = {
  executablePath: "/electron",
  entryPath: "/server/bin.mjs",
  cwd: "/server",
  env: {},
  bootstrap: {
    mode: "desktop",
    noBrowser: true,
    port: 3773,
    t3Home: "/tmp/t3",
    host: "127.0.0.1",
    desktopBootstrapToken: "desktop-bootstrap-token",
    tailscaleServeEnabled: false,
    tailscaleServePort: 443,
  },
  httpBaseUrl: new URL("http://127.0.0.1:3773"),
  captureOutput: true,
};

describe("DesktopLocalEnvironmentAuth", () => {
  it.effect("exchanges the desktop bootstrap credential only once", () =>
    Effect.gen(function* () {
      const requestCount = yield* Ref.make(0);
      const layerHttpClient = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Ref.update(requestCount, (count) => count + 1).pipe(
            Effect.as(
              HttpClientResponse.fromWeb(
                request,
                new Response(
                  JSON.stringify({
                    access_token: "desktop-bearer-token",
                    issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
                    token_type: "Bearer",
                    expires_in: 3600,
                    scope: "orchestration:read",
                  }),
                  { status: 200, headers: { "content-type": "application/json" } },
                ),
              ),
            ),
          ),
        ),
      );
      const layerPool = Layer.succeed(DesktopBackendPool.DesktopBackendPool, {
        list: Effect.succeed([
          {
            id: PRIMARY_LOCAL_ENVIRONMENT_ID,
            label: Effect.succeed("Windows"),
            currentConfig: Effect.succeedSome(config),
          },
        ]),
      } as unknown as DesktopBackendPool.DesktopBackendPool["Service"]);
      const layerTest = DesktopLocalEnvironmentAuth.layer.pipe(
        Layer.provide(
          Layer.mergeAll(layerPool, layerHttpClient, environmentLayer(), forbiddenSpawnerLayer),
        ),
      );

      const [first, second] = yield* Effect.gen(function* () {
        const auth = yield* DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth;
        return yield* Effect.all([auth.getBearerToken, auth.getBearerToken]);
      }).pipe(Effect.provide(layerTest));

      assert.strictEqual(first, "desktop-bearer-token");
      assert.strictEqual(second, "desktop-bearer-token");
      assert.strictEqual(yield* Ref.get(requestCount), 1);
    }),
  );

  it.effect("mints a session for an attached server instead of exchanging a token", () =>
    Effect.gen(function* () {
      const encoder = new TextEncoder();
      const spawnedArgs: string[][] = [];
      const spawnerLayer = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make((command) => {
          spawnedArgs.push([...(command as unknown as { args: readonly string[] }).args]);
          return Effect.succeed({
            pid: 4242,
            stdout: Stream.make(encoder.encode("attached-bearer-token\n")),
            stderr: Stream.empty,
            exitCode: Effect.succeed(0),
            kill: () => Effect.void,
            stdin: Sink.drain,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
            unref: Effect.succeed(Effect.void),
          } as never);
        }),
      );
      // An attached server never received a bootstrap token from us, so any
      // HTTP token exchange would be a bug.
      const httpClientLayer = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("unexpected bootstrap token exchange")),
      );
      const poolLayer = Layer.succeed(DesktopBackendPool.DesktopBackendPool, {
        list: Effect.succeed([
          {
            id: PRIMARY_LOCAL_ENVIRONMENT_ID,
            label: Effect.succeed("Attached server"),
            ownership: "attached",
            currentConfig: Effect.succeed(Option.none()),
            httpBaseUrl: Effect.succeed(Option.some(new URL("http://127.0.0.1:3773"))),
          },
        ]),
      } as unknown as DesktopBackendPool.DesktopBackendPool["Service"]);

      const token = yield* Effect.gen(function* () {
        const auth = yield* DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth;
        return yield* auth.getBearerToken;
      }).pipe(
        Effect.provide(
          DesktopLocalEnvironmentAuth.layer.pipe(
            Layer.provide(
              Layer.mergeAll(poolLayer, httpClientLayer, environmentLayer(), spawnerLayer),
            ),
          ),
        ),
      );

      assert.strictEqual(token, "attached-bearer-token");
      assert.strictEqual(spawnedArgs.length, 1);
      assert.deepInclude(spawnedArgs[0] ?? [], "--token-only");
    }),
  );

  it.effect(
    "exchanges the current window's token when the backend was launched with a secret",
    () =>
      Effect.gen(function* () {
        const presented = yield* Ref.make<string | null>(null);
        const httpClientLayer = Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) => {
            const body =
              request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
            return Ref.set(presented, new URLSearchParams(body).get("subject_token")).pipe(
              Effect.as(
                HttpClientResponse.fromWeb(
                  request,
                  new Response(
                    JSON.stringify({
                      access_token: "desktop-bearer-token",
                      issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
                      token_type: "Bearer",
                      expires_in: 3600,
                      scope: "orchestration:read",
                    }),
                    { status: 200, headers: { "content-type": "application/json" } },
                  ),
                ),
              ),
            );
          }),
        );
        const poolLayer = Layer.succeed(DesktopBackendPool.DesktopBackendPool, {
          list: Effect.succeed([
            {
              id: PRIMARY_LOCAL_ENVIRONMENT_ID,
              label: Effect.succeed("Windows"),
              currentConfig: Effect.succeedSome({
                ...config,
                bootstrap: { ...config.bootstrap, desktopBootstrapSecret: "desktop-secret" },
              }),
            },
          ]),
        } as unknown as DesktopBackendPool.DesktopBackendPool["Service"]);

        // The first exchange happens a day after launch, past the launch token's windows.
        yield* TestClock.setTime(DESKTOP_BOOTSTRAP_TOKEN_WINDOW_MS * 2 + 1);
        yield* Effect.gen(function* () {
          const auth = yield* DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth;
          return yield* auth.getBearerToken;
        }).pipe(
          Effect.provide(
            DesktopLocalEnvironmentAuth.layer.pipe(
              Layer.provide(
                Layer.mergeAll(
                  poolLayer,
                  httpClientLayer,
                  environmentLayer(),
                  forbiddenSpawnerLayer,
                ),
              ),
            ),
          ),
        );

        assert.strictEqual(
          yield* Ref.get(presented),
          currentDesktopBootstrapToken("desktop-secret", DESKTOP_BOOTSTRAP_TOKEN_WINDOW_MS * 2 + 1),
        );
      }).pipe(Effect.provide(TestClock.layer())),
  );

  const tokenResponse = (request: HttpClientRequest.HttpClientRequest) =>
    HttpClientResponse.fromWeb(
      request,
      new Response(
        JSON.stringify({
          access_token: "desktop-bearer-token",
          issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
          token_type: "Bearer",
          expires_in: 3600,
          scope: "orchestration:read",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
  const layerPool = Layer.succeed(DesktopBackendPool.DesktopBackendPool, {
    list: Effect.succeed([
      {
        id: PRIMARY_LOCAL_ENVIRONMENT_ID,
        label: Effect.succeed("Windows"),
        currentConfig: Effect.succeedSome(config),
      },
    ]),
  } as unknown as DesktopBackendPool.DesktopBackendPool["Service"]);
  // Answers the first `failures` exchanges with `failure`, then with a token.
  const makeExchange = (failures: number, failure: () => Response) =>
    Effect.gen(function* () {
      const requestCount = yield* Ref.make(0);
      const layerHttpClient = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Ref.updateAndGet(requestCount, (count) => count + 1).pipe(
            Effect.map((count) =>
              count <= failures
                ? HttpClientResponse.fromWeb(request, failure())
                : tokenResponse(request),
            ),
          ),
        ),
      );
      const auth = yield* DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth.pipe(
        Effect.provide(
          DesktopLocalEnvironmentAuth.layer.pipe(
            Layer.provide(
              Layer.mergeAll(layerPool, layerHttpClient, environmentLayer(), forbiddenSpawnerLayer),
            ),
          ),
        ),
      );
      return { auth, requestCount };
    });

  it.effect("retries a backend that is still starting", () =>
    Effect.gen(function* () {
      const { auth, requestCount } = yield* makeExchange(
        2,
        () => new Response("", { status: 503 }),
      );

      const fiber = yield* auth.getBearerToken.pipe(Effect.forkChild);
      yield* TestClock.adjust(Duration.seconds(1));

      assert.strictEqual(yield* Fiber.join(fiber), "desktop-bearer-token");
      assert.strictEqual(yield* Ref.get(requestCount), 3);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("does not retry a rejected bootstrap credential", () =>
    Effect.gen(function* () {
      const { auth, requestCount } = yield* makeExchange(1, () =>
        Response.json(
          {
            _tag: "EnvironmentAuthInvalidError",
            code: "auth_invalid",
            reason: "invalid_credential",
            traceId: "trace-1",
          },
          { status: 401 },
        ),
      );

      const fiber = yield* auth.getBearerToken.pipe(Effect.flip, Effect.forkChild);
      yield* TestClock.adjust(Duration.seconds(1));
      const error = yield* Fiber.join(fiber);

      assert.strictEqual(error._tag, "DesktopLocalEnvironmentAuthSessionBootstrapError");
      assert.strictEqual(yield* Ref.get(requestCount), 1);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});
