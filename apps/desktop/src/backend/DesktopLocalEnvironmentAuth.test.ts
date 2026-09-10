import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { PRIMARY_LOCAL_ENVIRONMENT_ID } from "@t3tools/contracts";

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
      const httpClientLayer = Layer.succeed(
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
      const poolLayer = Layer.succeed(DesktopBackendPool.DesktopBackendPool, {
        list: Effect.succeed([
          {
            id: PRIMARY_LOCAL_ENVIRONMENT_ID,
            label: Effect.succeed("Windows"),
            currentConfig: Effect.succeed(Option.some(config)),
          },
        ]),
      } as unknown as DesktopBackendPool.DesktopBackendPool["Service"]);
      const testLayer = DesktopLocalEnvironmentAuth.layer.pipe(
        Layer.provide(
          Layer.mergeAll(poolLayer, httpClientLayer, environmentLayer(), forbiddenSpawnerLayer),
        ),
      );

      const [first, second] = yield* Effect.gen(function* () {
        const auth = yield* DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth;
        return yield* Effect.all([auth.getBearerToken, auth.getBearerToken]);
      }).pipe(Effect.provide(testLayer));

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
});
