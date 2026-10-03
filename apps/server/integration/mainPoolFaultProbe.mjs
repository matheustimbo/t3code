// oxlint-disable t3code/namespace-node-imports, t3code/no-global-process-runtime -- Independent Node probe must have its own process and libuv pool outside the server Effect runtime.
import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import * as zlib from "node:zlib";

const require = createRequire(import.meta.url);
const WebSocket = createRequire(require.resolve("@effect/platform-node/NodeSocket"))("ws");
const decompress = {
  gzip: promisify(zlib.gunzip),
  br: promisify(zlib.brotliDecompress),
  deflate: promisify(zlib.inflate),
};
let probeEvidence;
const bounded = async (work, budget, label) => {
  let timer;
  try {
    return await Promise.race([
      work,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded ${budget}ms`)), budget);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

async function probe(input) {
  const measurements = [];
  const compression = [];
  probeEvidence = { measurements, compression };
  const measure = async (label, budget, work) => {
    const start = performance.now();
    const value = await bounded(work(), budget, label);
    const elapsedMs = performance.now() - start;
    assert(elapsedMs <= budget, `${label}: ${elapsedMs}ms exceeded ${budget}ms`);
    measurements.push({ label, elapsedMs: Math.round(elapsedMs * 100) / 100, budgetMs: budget });
    return value;
  };
  const getDescriptor = async (encoding) => {
    // node:http leaves the response compressed so content-encoding is proven.
    const response = await new Promise((resolve, reject) => {
      const request = http.get(
        `${input.origin}/.well-known/t3/environment`,
        {
          headers: { "accept-encoding": encoding },
          agent: false,
        },
        (response) => {
          const parts = [];
          response.on("data", (part) => parts.push(part));
          response.once("error", reject);
          response.once("end", () =>
            resolve({
              status: response.statusCode,
              encoding: response.headers["content-encoding"],
              bytes: Buffer.concat(parts),
            }),
          );
        },
      );
      request.once("error", reject);
      request.setTimeout(500, () => request.destroy(new Error("descriptor HTTP timeout")));
    });
    assert.equal(response.status, 200);
    if (encoding === "identity") assert.equal(response.encoding, undefined);
    if (response.encoding !== undefined) assert.equal(response.encoding, encoding);
    const bytes = response.encoding
      ? await decompress[response.encoding](response.bytes)
      : response.bytes;
    assert(bytes.length > 1024, "Fixture must exceed the production compression threshold");
    return { descriptor: JSON.parse(bytes.toString()), contentEncoding: response.encoding ?? null };
  };
  const assertDescriptor = (descriptor) => {
    assert.equal(descriptor.label, input.label);
    assert.equal(typeof descriptor.environmentId, "string");
    assert(descriptor.environmentId.length > 0);
    assert.equal(typeof descriptor.serverVersion, "string");
    assert.equal(descriptor.platform.os, process.platform);
    assert.equal(descriptor.platform.arch, process.arch);
    assert.equal(descriptor.capabilities.connectionProbe, true);
    assert.equal(descriptor.capabilities.repositoryIdentity, true);
    if (input.expectedDescriptor) assert.deepEqual(descriptor, input.expectedDescriptor);
  };
  let expectedDescriptor = input.expectedDescriptor;
  for (const encoding of ["identity", "gzip", "br", "deflate"]) {
    const result = await measure(`descriptor-${encoding}`, 500, () => getDescriptor(encoding));
    assertDescriptor(result.descriptor);
    expectedDescriptor ??= result.descriptor;
    assert.deepEqual(result.descriptor, expectedDescriptor);
    compression.push({ offered: encoding, returned: result.contentEncoding });
  }
  let cookie = input.cookie;
  if (!cookie) {
    const session = await measure("browser-session", 3000, async () => {
      const response = await fetch(`${input.origin}/api/auth/browser-session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ credential: input.token }),
        signal: AbortSignal.timeout(3000),
      });
      assert.equal(response.status, 200);
      return response.headers.get("set-cookie")?.split(";", 1)[0];
    });
    assert(session, "Browser authentication must issue a cookie");
    cookie = session;
  }
  const wsUrl = new URL(`${input.origin.replace(/^http/, "ws")}/ws`);
  if (expectedDescriptor.orchestrationProtocolVersion !== undefined) {
    wsUrl.searchParams.set(
      "orchestrationProtocol",
      String(expectedDescriptor.orchestrationProtocolVersion),
    );
  }
  const socket = new WebSocket(wsUrl, {
    headers: { cookie },
    perMessageDeflate: true,
    handshakeTimeout: 500,
  });
  let sequence = 0;
  const pending = new Map();
  socket.on("error", () => {});
  socket.on("message", (bytes) => {
    const decoded = JSON.parse(bytes.toString());
    for (const message of Array.isArray(decoded) ? decoded : [decoded]) {
      if (message._tag === "Ping") {
        socket.send(JSON.stringify({ _tag: "Pong" }));
        continue;
      }
      const request = pending.get(String(message.requestId));
      if (!request) continue;
      if (message._tag === "Exit") {
        if (message.exit._tag === "Success") request.resolve(message.exit.value);
        else request.reject(new Error(`${request.tag} failed: ${JSON.stringify(message.exit)}`));
      } else if (message._tag === "Chunk") {
        socket.send(JSON.stringify({ _tag: "Ack", requestId: message.requestId }));
        for (const value of message.values) {
          if (value.type === "snapshot") request.resolve(value.config);
        }
      }
    }
  });
  const rpc = (tag, budget) =>
    measure(tag, budget, async () => {
      const id = String(++sequence);
      try {
        return await new Promise((resolve, reject) => {
          pending.set(id, { resolve, reject, tag });
          socket.send(JSON.stringify({ _tag: "Request", id, tag, payload: {}, headers: [] }));
        });
      } finally {
        pending.delete(id);
      }
    });
  const assertConfig = (config) => {
    assert.deepEqual(config.environment, expectedDescriptor);
    assert.equal(config.settings.environmentLabel, input.label);
    assert.equal(config.cwd, input.workspace);
    assert.equal(config.threadSnapshotPagination, true);
    assert.equal(config.shellResumeCompletionMarker, true);
    assert(Array.isArray(config.providers), "Config must retain the provider catalog");
    assert(config.auth && typeof config.auth === "object", "Config must retain auth capabilities");
  };
  try {
    await measure(
      "fresh-authenticated-websocket",
      500,
      () =>
        new Promise((resolve, reject) => {
          socket.once("open", resolve);
          socket.once("error", reject);
          socket.once("unexpected-response", (_request, response) => {
            response.resume();
            reject(new Error(`WebSocket admission failed HTTP ${response.statusCode}`));
          });
        }),
    );
    await rpc("server.probe", 500);
    const config = await rpc("server.getConfig", 3000);
    assertConfig(config);
    const settings = await rpc("server.getSettings", 500);
    assert.equal(settings.environmentLabel, input.label);
    assert.deepEqual(settings, config.settings);
    const snapshot = await rpc("subscribeServerConfig", 3000);
    assertConfig(snapshot);
    return {
      measurements,
      compression,
      expectedDescriptor,
      cookie,
      keybindingsConfigPath: config.keybindingsConfigPath,
      negotiatedWebSocketCompression: socket.extensions || null,
    };
  } finally {
    socket.terminate();
  }
}

process.once("message", async (input) => {
  try {
    const result = await probe(input);
    process.send({ type: "probe.result", ok: true, result }, () => process.exit(0));
  } catch (error) {
    process.send(
      { type: "probe.result", ok: false, error: String(error), evidence: probeEvidence },
      () => process.exit(1),
    );
  }
});
