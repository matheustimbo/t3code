import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as PlatformError from "effect/PlatformError";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import * as DesktopBackendOwnership from "./DesktopBackendOwnership.ts";

const STATE_DIR = "/home/user/.t3/userdata";
const RUNTIME_STATE_PATH = `${STATE_DIR}/server-runtime.json`;

const runtimeStateJson = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    version: 1,
    pid: 4242,
    port: 3773,
    origin: "http://127.0.0.1:3773",
    startedAt: "2026-09-09T12:00:00.000Z",
    ...overrides,
  });

const fileSystemLayer = (contents: string | "missing") =>
  FileSystem.layerNoop({
    readFileString: (path: string) =>
      contents !== "missing" && path === RUNTIME_STATE_PATH
        ? Effect.succeed(contents)
        : Effect.fail(
            PlatformError.systemError({
              _tag: "NotFound",
              module: "FileSystem",
              method: "readFileString",
              pathOrDescriptor: path,
            }),
          ),
  });

const respondingHttpClientLayer = (body: unknown, status = 200) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(body === undefined ? null : JSON.stringify(body), {
            status,
            headers: { "content-type": "application/json" },
          }),
        ),
      ),
    ),
  );

const unreachableHttpClientLayer = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make(() => Effect.die("connection refused")),
);

/** A probe must never be attempted when the cheap local checks already failed. */
const forbiddenHttpClientLayer = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make(() => Effect.die("unexpected environment probe")),
);

const descriptorBody = { environmentId: "env_01234567890123456789012345" };

const resolve = (input: {
  readonly contents: string | "missing";
  readonly httpClientLayer: Layer.Layer<HttpClient.HttpClient>;
  readonly alive?: boolean;
}) =>
  DesktopBackendOwnership.resolveBackendOwnership({
    stateDir: STATE_DIR,
    isProcessAlive: () => input.alive ?? true,
  }).pipe(Effect.provide(Layer.mergeAll(fileSystemLayer(input.contents), input.httpClientLayer)));

describe("DesktopBackendOwnership", () => {
  it.effect("owns the state dir quietly when no server published runtime state", () =>
    Effect.gen(function* () {
      const logs: string[] = [];
      const logger = Logger.make(({ message }) => {
        logs.push(String(message));
      });
      const ownership = yield* resolve({
        contents: "missing",
        httpClientLayer: forbiddenHttpClientLayer,
      }).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
      assert.equal(ownership._tag, "Owned");
      // The overwhelmingly common case is "no server running". It must not
      // write a warning on every single launch.
      assert.deepEqual(logs, []);
    }),
  );

  it.effect("owns the state dir when the recorded pid is gone", () =>
    Effect.gen(function* () {
      const ownership = yield* resolve({
        contents: runtimeStateJson(),
        httpClientLayer: forbiddenHttpClientLayer,
        alive: false,
      });
      assert.equal(ownership._tag, "Owned");
    }),
  );

  it.effect("attaches to a live server that answers with a T3 descriptor", () =>
    Effect.gen(function* () {
      const ownership = yield* resolve({
        contents: runtimeStateJson(),
        httpClientLayer: respondingHttpClientLayer(descriptorBody),
      });
      assert.equal(ownership._tag, "Attached");
      if (ownership._tag !== "Attached") return;
      assert.equal(ownership.origin.href, "http://127.0.0.1:3773/");
      assert.equal(ownership.rendererOrigin.href, "http://127.0.0.1:3773/");
      assert.equal(ownership.pid, 4242);
    }),
  );

  it.effect("owns the state dir when the recorded origin is not a T3 server", () =>
    Effect.gen(function* () {
      const ownership = yield* resolve({
        contents: runtimeStateJson(),
        httpClientLayer: respondingHttpClientLayer({ hello: "some other service" }),
      });
      assert.equal(ownership._tag, "Owned");
    }),
  );

  it.effect("owns the state dir when a stale proxy answers with a bad gateway", () =>
    Effect.gen(function* () {
      const ownership = yield* resolve({
        contents: runtimeStateJson(),
        httpClientLayer: respondingHttpClientLayer(undefined, 502),
      });
      assert.equal(ownership._tag, "Owned");
    }),
  );

  it.effect("owns the state dir when nothing is listening on the recorded origin", () =>
    Effect.gen(function* () {
      const ownership = yield* resolve({
        contents: runtimeStateJson(),
        httpClientLayer: unreachableHttpClientLayer,
      });
      assert.equal(ownership._tag, "Owned");
    }),
  );

  it.effect("routes the renderer through the dev URL when the live server fronts one", () =>
    Effect.gen(function* () {
      const ownership = yield* resolve({
        contents: runtimeStateJson({ devUrl: "http://localhost:5173/" }),
        httpClientLayer: respondingHttpClientLayer(descriptorBody),
      });
      assert.equal(ownership._tag, "Attached");
      if (ownership._tag !== "Attached") return;
      // Dev is single-origin: assets must come from the Vite server, while the
      // API origin stays the server that published the runtime state.
      assert.equal(ownership.rendererOrigin.href, "http://localhost:5173/");
      assert.equal(ownership.origin.href, "http://127.0.0.1:3773/");
    }),
  );
});
