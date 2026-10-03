// oxlint-disable t3code/namespace-node-imports -- Test-only Node preload observes real native operations before the server runtime starts.
import * as fs from "node:fs/promises";
import path from "node:path";
import nativeFs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import nativeChildProcess from "node:child_process";

// Test-only preload: do not instrument project helpers or provider children.
const directory = process.env.T3_TEST_MAIN_POOL_FAULT_DIR;
if (directory && process.argv.includes("serve") && process.connected) {
  const workers = 16;
  if (process.env.UV_THREADPOOL_SIZE !== String(workers)) {
    throw new Error("Fault experiment requires UV_THREADPOOL_SIZE=16 before startup");
  }
  let jobs = [];
  let completedOpens = 0;
  let sentinelCompleted = false;
  let started = false;
  let ticks = 0;
  let observedKeybindingsPath;
  let keybindingsNotified = false;
  const heartbeat = setInterval(() => ticks++, 25);
  heartbeat.unref();
  const send = (message) => process.send?.(message);
  const originalSpawn = nativeChildProcess.spawn;
  nativeChildProcess.spawn = function (...args) {
    const child = Reflect.apply(originalSpawn, this, args);
    if (Array.isArray(args[1]) && args[1].includes("__publishing-observer")) {
      send({
        type: "fault.helperSpawned",
        pid: child.pid,
        parentPid: process.pid,
        helperPoolSize: args[2]?.env?.UV_THREADPOOL_SIZE,
      });
      child.on("message", (message) => {
        if (typeof message?.active === "boolean")
          send({
            type: "fault.helperObserved",
            pid: child.pid,
            active: message.active,
            observedAt: Date.now(),
          });
      });
      child.once("exit", (code, signal) =>
        send({ type: "fault.helperReaped", pid: child.pid, code, signal }),
      );
    }
    return child;
  };
  // Observe the real queued read after the watcher invalidates its cache. The
  // wrapped functions still perform the native operation with identical args.
  for (const operation of ["access", "stat", "readFile"]) {
    const original = nativeFs[operation];
    nativeFs[operation] = function (...args) {
      const result = Reflect.apply(original, this, args);
      if (started && !keybindingsNotified && String(args[0]) === observedKeybindingsPath) {
        keybindingsNotified = true;
        send({
          type: "fault.keybindingsReadQueued",
          operation,
          sentinelPending: !sentinelCompleted,
        });
      }
      return result;
    };
  }
  syncBuiltinESMExports();
  process.on("message", (message) => {
    if (message?.type === "fault.start" && !started) {
      started = true;
      jobs = Array.from({ length: workers }, (_, index) =>
        fs.open(path.join(directory, `fifo-${index}`), "r").then(async (handle) => {
          completedOpens++;
          await handle.close();
        }),
      );
      jobs.push(
        fs.stat(path.join(directory, "sentinel")).then(() => {
          sentinelCompleted = true;
        }),
      );
      Promise.all(jobs).then(
        () => send({ type: "fault.drained", completedOpens, sentinelCompleted }),
        (error) => send({ type: "fault.error", error: String(error) }),
      );
      setTimeout(
        () =>
          send({
            type: "fault.saturated",
            workers,
            completedOpens,
            sentinelPending: !sentinelCompleted,
            ticks,
            pid: process.pid,
            uvThreadpoolSize: process.env.UV_THREADPOOL_SIZE,
          }),
        250,
      );
    } else if (message?.type === "fault.heartbeat") {
      send({ type: "fault.heartbeat", ticks, completedOpens, sentinelPending: !sentinelCompleted });
    } else if (message?.type === "fault.observeKeybindings") {
      observedKeybindingsPath = message.path;
      send({ type: "fault.keybindingsObserverReady" });
    }
  });
  send({
    type: "fault.ready",
    pid: process.pid,
    workers,
    uvThreadpoolSize: process.env.UV_THREADPOOL_SIZE,
    nodeVersion: process.version,
    libuvVersion: process.versions.uv,
  });
}
