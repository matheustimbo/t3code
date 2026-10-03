// oxlint-disable t3code/namespace-node-imports, t3code/no-global-process-runtime -- Standalone Node experiment owns disposable processes and cannot use the server Effect runtime.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [mode, entryArg, nodeArg = process.execPath, ...options] = process.argv.slice(2);
assert(
  ["bundle", "sea"].includes(mode) && entryArg,
  "Usage: node mainPoolResilience.mjs <bundle|sea> <absolute-artifact> [node-runtime] [--expect-failure] [--healthy-only]",
);
const entry = path.resolve(entryArg);
const runtime = path.resolve(nodeArg);
const expectFailure = options.includes("--expect-failure");
const healthyOnly = options.includes("--healthy-only");
assert(!(expectFailure && healthyOnly), "Negative control requires saturation");
const directory = await fs.mkdtemp(path.join(os.tmpdir(), "t3-main-pool-16-"));
const workspace = path.join(directory, "workspace");
const faultDir = path.join(directory, "fault");
const label = "disposable-pool16-fixture-".repeat(100);
await fs.mkdir(workspace);
await fs.mkdir(faultDir);
await fs.mkdir(path.join(directory, "userdata"));
await fs.writeFile(
  path.join(directory, "userdata", "settings.json"),
  JSON.stringify({
    environmentLabel: label,
  }),
);
await fs.writeFile(path.join(faultDir, "sentinel"), "filesystem sentinel");
const fifos = Array.from({ length: 16 }, (_, index) => path.join(faultDir, `fifo-${index}`));
for (const fifo of fifos) execFileSync("mkfifo", [fifo]);
const listener = net.createServer();
await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
const port = listener.address().port;
await new Promise((resolve) => listener.close(resolve));
const preload = fileURLToPath(new URL("./mainPoolFaultPreload.mjs", import.meta.url));
const probePath = fileURLToPath(new URL("./mainPoolFaultProbe.mjs", import.meta.url));
const report = {
  mode,
  entry,
  runtime,
  directory,
  serverPoolSize: 16,
  probePoolSize: 4,
  platform: process.platform,
  controllerNodeVersion: process.version,
  expectFailure,
  healthyOnly,
  rounds: [],
  artifactSha256: createHash("sha256")
    .update(await fs.readFile(entry))
    .digest("hex"),
};
let cleaning = false;
const interruption = new Promise((_, reject) => {
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => {
      report.interruptedSignal = signal;
      reject(new Error(`Experiment interrupted by ${signal}`));
    });
});
// Signals can arrive between bounded operations; the next bound will observe it.
interruption.catch(() => {});
const bounded = async (promise, budget, label) => {
  let timer;
  try {
    return await Promise.race([
      promise,
      ...(cleaning ? [] : [interruption]),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded ${budget}ms`)), budget);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};
const child = spawn(
  mode === "sea" ? entry : runtime,
  [
    ...(mode === "sea" ? [] : ["--import", preload, entry]),
    "serve",
    "--base-dir",
    directory,
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    workspace,
  ],
  {
    cwd: workspace,
    env: {
      ...process.env,
      NODE_OPTIONS: "",
      UV_THREADPOOL_SIZE: "16",
      T3_TEST_MAIN_POOL_FAULT_DIR: faultDir,
      T3CODE_ANALYTICS_DISABLED: "1",
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  },
);
report.serverPid = child.pid;
let output = "";
let exited = false;
const inbox = [];
const waiters = new Map();
const helperPids = new Set();
const reapedHelperPids = new Set();
child.stdout.on("data", (bytes) => (output += bytes.toString()));
child.stderr.on("data", (bytes) => (output += bytes.toString()));
child.on("message", (message) => {
  if (message.type === "fault.helperSpawned") {
    helperPids.add(message.pid);
    (report.helperProcesses ??= []).push(message);
  } else if (message.type === "fault.helperReaped") {
    reapedHelperPids.add(message.pid);
    (report.helperReaps ??= []).push(message);
  }
  const waiter = waiters.get(message.type);
  if (waiter && waiter.predicate(message)) {
    waiters.delete(message.type);
    waiter.resolve(message);
  } else inbox.push(message);
});
child.once("exit", (code, signal) => {
  exited = true;
  for (const waiter of waiters.values())
    waiter.reject(new Error(`Server exited ${code ?? signal}`));
  waiters.clear();
});
child.once("error", (error) => {
  exited = true;
  for (const waiter of waiters.values()) waiter.reject(error);
  waiters.clear();
});
const waitFor = async (type, budget = 3000, predicate = () => true) => {
  const existing = inbox.findIndex((message) => message.type === type && predicate(message));
  if (existing >= 0) return inbox.splice(existing, 1)[0];
  assert(!exited, "Server already exited");
  try {
    return await bounded(
      new Promise((resolve, reject) => waiters.set(type, { resolve, reject, predicate })),
      budget,
      type,
    );
  } finally {
    waiters.delete(type);
  }
};
const runProbe = async (input) => {
  const probe = spawn(runtime, [probePath], {
    cwd: workspace,
    env: { ...process.env, NODE_OPTIONS: "", UV_THREADPOOL_SIZE: "4" },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let stderr = "";
  probe.stderr.on("data", (bytes) => (stderr += bytes));
  try {
    const result = await bounded(
      new Promise((resolve, reject) => {
        probe.once("error", reject);
        probe.once("message", resolve);
        probe.once("exit", (code) => reject(new Error(`Probe exited ${code}; ${stderr}`)));
        probe.send(input);
      }),
      15000,
      "independent probe process",
    );
    assert.equal(result.type, "probe.result");
    return result;
  } finally {
    if (probe.exitCode === null && probe.signalCode === null) probe.kill("SIGKILL");
  }
};
let saturated = false;
let failedDuringFault = false;
try {
  report.preload = await waitFor("fault.ready", 5000);
  assert.equal(report.preload.workers, 16);
  assert.equal(report.preload.uvThreadpoolSize, "16");
  const token = await bounded(
    new Promise((resolve, reject) => {
      const inspect = () => {
        const match = /(?:^|\n)Token: (\S+)/.exec(output);
        if (match) {
          clearInterval(interval);
          resolve(match[1]);
        } else if (exited) {
          clearInterval(interval);
          reject(new Error("Server exited before startup"));
        }
      };
      const interval = setInterval(inspect, 25);
      inspect();
      // This deadline also clears the startup observer; the outer bound reports failure.
      setTimeout(() => clearInterval(interval), 120000).unref();
    }),
    120000,
    "server warm startup",
  );
  const origin = `http://127.0.0.1:${port}`;
  const warm = await runProbe({ origin, label, workspace, token });
  assert(warm.ok, `Warm probes must pass before fault injection: ${warm.error}`);
  const { cookie, expectedDescriptor, keybindingsConfigPath, ...warmEvidence } = warm.result;
  report.warm = warmEvidence;
  report.expectedDescriptor = expectedDescriptor;
  if (!healthyOnly) {
    const waiting = waitFor("fault.saturated");
    child.send({ type: "fault.start" });
    saturated = true;
    report.saturation = await waiting;
    assert.equal(report.saturation.workers, 16);
    assert.equal(report.saturation.completedOpens, 0);
    assert.equal(report.saturation.sentinelPending, true);
    assert(
      report.saturation.ticks > 0,
      "Event loop must remain responsive with native opens pending",
    );
    assert(
      keybindingsConfigPath.startsWith(`${directory}${path.sep}`),
      "Touch only disposable keybindings",
    );
    const observerReady = waitFor("fault.keybindingsObserverReady");
    child.send({ type: "fault.observeKeybindings", path: keybindingsConfigPath });
    await observerReady;
    const keybindingsRead = waitFor("fault.keybindingsReadQueued", 3000);
    // Append keeps the config semantically unchanged and emits a native change
    // event, avoiding the rename path's own async stat before watcher delivery.
    await fs.appendFile(keybindingsConfigPath, "\n");
    report.keybindingsInvalidation = await keybindingsRead;
    assert.equal(report.keybindingsInvalidation.sentinelPending, true);
    if (process.platform === "darwin") {
      const samplePath = path.join(directory, "native-sample.txt");
      const sample = spawn("/usr/bin/sample", [String(child.pid), "1", "1", "-file", samplePath], {
        stdio: "ignore",
      });
      let sampleCode;
      try {
        sampleCode = await bounded(
          new Promise((resolve, reject) => {
            sample.once("exit", resolve);
            sample.once("error", reject);
          }),
          10000,
          "macOS sample",
        );
      } finally {
        if (sample.exitCode === null && sample.signalCode === null) sample.kill("SIGKILL");
      }
      if (sampleCode === 0) {
        const native = await fs.readFile(samplePath, "utf8");
        const callGraph = native.split("Total number in stack", 1)[0];
        const threads = callGraph
          .split(/(?=^[ \t]+\d+[ \t]+Thread_\d+)/m)
          .filter(
            (section) =>
              /^[ \t]+\d+[ \t]+Thread_\d+: libuv-worker\b/.test(section) &&
              /(?:__open|open\$NOCANCEL)/.test(section),
          );
        report.nativeSample = { path: samplePath, blockedOpenWorkerThreads: threads.length };
        assert.equal(
          threads.length,
          16,
          "macOS sample must show all 16 native filesystem workers blocked in open",
        );
      } else report.nativeSample = { available: false, sampleExitCode: sampleCode };
    }
    for (let round = 1; round <= 3; round++) {
      const result = await runProbe({ origin, label, workspace, cookie, expectedDescriptor });
      if (!result.ok) {
        report.rounds.push({ round, ok: false, error: result.error, evidence: result.evidence });
        failedDuringFault = true;
        if (!expectFailure) throw new Error(result.error);
        break;
      }
      const {
        cookie: _cookie,
        expectedDescriptor: _descriptor,
        keybindingsConfigPath: _keybindings,
        ...evidence
      } = result.result;
      report.rounds.push({ round, ok: true, ...evidence });
      const heartbeat = waitFor("fault.heartbeat");
      child.send({ type: "fault.heartbeat" });
      const state = await heartbeat;
      assert.equal(state.completedOpens, 0);
      assert.equal(state.sentinelPending, true);
      assert(state.ticks > report.saturation.ticks);
      report.rounds.at(-1).faultStillActive = state;
    }
    assert.equal(
      failedDuringFault,
      expectFailure,
      expectFailure
        ? "Unpatched negative control unexpectedly passed"
        : "Patched server failed under saturation",
    );
    if (!expectFailure) {
      assert(helperPids.size > 0, "Production bundle must launch its publishing observer");
      for (const helper of report.helperProcesses) {
        assert(
          helper.pid !== child.pid && helper.pid !== process.pid,
          "Observer must be a separate OS process",
        );
        assert.equal(helper.parentPid, child.pid);
        assert.equal(helper.helperPoolSize, "1");
      }
      const secrets = path.join(directory, "userdata", "secrets");
      const credentialPath = path.join(secrets, "cloud-relay-environment-credential.bin");
      const transition = async (active, mutate) => {
        const changedAt = Date.now();
        await mutate();
        const receipt = await waitFor(
          "fault.helperObserved",
          6500,
          (message) => message.active === active && message.observedAt >= changedAt,
        );
        const descriptor = {
          ...expectedDescriptor,
          capabilities: { ...expectedDescriptor.capabilities, agentActivityPublishing: active },
        };
        const result = await runProbe({
          origin,
          label,
          workspace,
          cookie,
          expectedDescriptor: descriptor,
        });
        assert(result.ok, `Publishing ${active} convergence probes failed: ${result.error}`);
        const {
          cookie: _cookie,
          expectedDescriptor: _descriptor,
          keybindingsConfigPath: _keybindings,
          ...evidence
        } = result.result;
        (report.publishingTransitions ??= []).push({
          active,
          convergenceMs: Date.now() - changedAt,
          receipt,
          ...evidence,
        });
        const heartbeat = waitFor("fault.heartbeat");
        child.send({ type: "fault.heartbeat" });
        const fault = await heartbeat;
        assert.equal(fault.completedOpens, 0);
        assert.equal(fault.sentinelPending, true);
        report.publishingTransitions.at(-1).faultStillActive = fault;
      };
      assert.equal(expectedDescriptor.capabilities.agentActivityPublishing, false);
      await transition(true, () =>
        Promise.all([
          fs.writeFile(path.join(secrets, "cloud-publish-agent-activity.bin"), "true", {
            mode: 0o600,
          }),
          fs.writeFile(
            path.join(secrets, "cloud-relay-url.bin"),
            "https://publishing-fixture.invalid",
            { mode: 0o600 },
          ),
          fs.writeFile(credentialPath, randomBytes(32).toString("hex"), { mode: 0o600 }),
        ]),
      );
      await transition(false, () => fs.unlink(credentialPath));
    }
  }
  report.pass = true;
} catch (error) {
  report.pass = false;
  report.failure = String(error);
  process.exitCode = 1;
} finally {
  cleaning = true;
  // Independent synchronous O_NONBLOCK opens cannot consume the wedged pool or
  // wait forever for a reader. Hold writers until the injected queue drains.
  if (saturated && !exited) {
    const writer = spawn(
      runtime,
      [
        "--input-type=module",
        "-e",
        `
      import { constants, openSync, closeSync } from "node:fs";
      const files = JSON.parse(process.argv[1]);
      const handles = [];
      let done = false;
      const deadline = Date.now() + 3000;
      const tryOpen = () => {
        for (let index = handles.length; index < files.length; index++) {
          try { handles.push(openSync(files[index], constants.O_WRONLY | constants.O_NONBLOCK)); }
          catch (error) { if (error.code !== "ENXIO") throw error; break; }
        }
        if (handles.length === files.length && !done) {
          done = true;
          setTimeout(() => { handles.forEach(closeSync); process.exit(0); }, 2000);
        } else if (Date.now() < deadline) setTimeout(tryOpen, 20);
        else { handles.forEach(closeSync); process.exit(1); }
      };
      tryOpen();
    `,
        JSON.stringify(fifos),
      ],
      { stdio: "ignore", env: { ...process.env, NODE_OPTIONS: "" } },
    );
    try {
      report.drain = await waitFor("fault.drained", 5000);
      assert.equal(report.drain.completedOpens, 16);
      assert.equal(report.drain.sentinelCompleted, true);
    } catch (error) {
      report.cleanupError = String(error);
      report.pass = false;
      process.exitCode = 1;
    } finally {
      if (writer.exitCode === null && writer.signalCode === null) writer.kill("SIGKILL");
    }
  }
  if (!exited) {
    const exit = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGTERM");
    try {
      await bounded(exit, 3000, "server termination");
    } catch {
      child.kill("SIGKILL");
      await bounded(exit, 3000, "server force termination");
    }
  }
  if (helperPids.size > 0) {
    try {
      for (const pid of helperPids) {
        let verifiedBy = "exit-receipt";
        if (!reapedHelperPids.has(pid)) {
          // Server exit closes IPC, so an absent exact captured PID is the
          // independent fallback proof when its final reap receipt was lost.
          assert.throws(
            () => process.kill(pid, 0),
            (error) => error.code === "ESRCH",
            `Publishing helper ${pid} must exit with its disposable parent`,
          );
          verifiedBy = "ESRCH-after-parent-exit";
        }
        (report.helperTermination ??= []).push({ pid, verifiedBy });
      }
      report.helpersReaped = true;
    } catch (error) {
      report.pass = false;
      report.helperCleanupError = String(error);
      process.exitCode = 1;
    }
  }
  // Authentication credentials never appear in retained startup evidence.
  const redacted = output
    .replace(/(Token: )\S+/g, "$1[REDACTED]")
    .replace(/([?&#](?:token|credential)=)[^\s&]+/g, "$1[REDACTED]");
  await fs.writeFile(path.join(directory, "startup.log"), redacted, { mode: 0o600 });
  await fs.writeFile(path.join(directory, "evidence.json"), JSON.stringify(report, null, 2), {
    mode: 0o600,
  });
  console.log(JSON.stringify(report, null, 2));
}
