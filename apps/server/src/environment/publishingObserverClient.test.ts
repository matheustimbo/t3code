// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Exercises OS isolation and captured child cleanup.
import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  PublishingObserverClient,
  publishingObserverEnvironment,
} from "./publishingObserverClient.ts";
import { PUBLISHING_SECRET_NAMES } from "./publishingObserverProtocol.ts";

class FakeChild extends NodeEvents.EventEmitter {
  readonly pid = 42;
  connected = true;
  readonly send = vi.fn();
  readonly kill = vi.fn(() => true);
  disconnect() {
    this.connected = false;
  }
  asChild(): NodeChildProcess.ChildProcess {
    return this as unknown as NodeChildProcess.ChildProcess;
  }
}

it("passes only the worker setting and required Windows bootstrap to the helper", () => {
  const parentEnv = {
    NODE_OPTIONS: "--require /tmp/inherited-preload.cjs",
    PROVIDER_API_KEY: "must-not-cross",
    T3_SECRET: "must-not-cross",
    SystemRoot: "C:\\Windows",
    PATH: "/tmp/inherited-path",
  };
  expect(publishingObserverEnvironment(parentEnv, "darwin")).toEqual({
    UV_THREADPOOL_SIZE: "1",
  });
  expect(publishingObserverEnvironment(parentEnv, "win32")).toEqual({
    UV_THREADPOOL_SIZE: "1",
    SystemRoot: "C:\\Windows",
  });
});

it("coalesces admission and fences timeout/late replies until the child is reaped", async () => {
  vi.useFakeTimers();
  const children: FakeChild[] = [];
  const client = new PublishingObserverClient(() => {
    const child = new FakeChild();
    children.push(child);
    return child.asChild();
  });
  try {
    const first = client.observe();
    expect(await client.observe()).toBe(false);
    children[0]!.emit("message", { kind: "ready" });
    expect(children[0]!.send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await first).toBe(false);
    expect(children[0]!.kill).toHaveBeenCalledWith("SIGTERM");
    children[0]!.emit("message", { id: 1, active: true });
    await vi.advanceTimersByTimeAsync(100);
    expect(children[0]!.kill).toHaveBeenCalledWith("SIGKILL");
    for (let i = 0; i < 20; i++) expect(await client.observe()).toBe(false);
    expect(children).toHaveLength(1);
    // IPC/stdio closure alone does not prove that a process has exited.
    children[0]!.emit("close");
    expect(await client.observe()).toBe(false);
    expect(children).toHaveLength(1);
    children[0]!.emit("exit", null, "SIGKILL");
    const second = client.observe();
    expect(children).toHaveLength(2);
    children[1]!.emit("message", { kind: "ready" });
    children[1]!.emit("message", { id: 2, active: true });
    expect(await second).toBe(true);
  } finally {
    client.close();
    vi.useRealTimers();
  }
});

it("fails closed for unexpected schema, child crash, and failed kill without respawning", async () => {
  const child = new FakeChild();
  child.kill.mockImplementation(() => {
    throw new Error("cannot signal");
  });
  const spawnChild = vi.fn(() => child.asChild());
  const client = new PublishingObserverClient(spawnChild);
  try {
    const read = client.observe();
    child.emit("message", { kind: "ready" });
    child.emit("message", { id: 1, active: true, credential: "untrusted-extra-field" });
    expect(await read).toBe(false);
    expect(await client.observe()).toBe(false);
    expect(spawnChild).toHaveBeenCalledTimes(1);
    child.emit("exit", 1);
    const next = client.observe();
    child.emit("exit", 1);
    expect(await next).toBe(false);
  } finally {
    client.close();
  }
});

it("counts startup inside the observation deadline and makes shutdown immediate", async () => {
  vi.useFakeTimers();
  const child = new FakeChild();
  const client = new PublishingObserverClient(() => child.asChild());
  try {
    const startup = client.observe();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await startup).toBe(false);
    expect(child.send).not.toHaveBeenCalled();
    client.close();
    expect(await client.observe()).toBe(false);
  } finally {
    client.close();
    vi.useRealTimers();
  }
});

it("signals the captured child immediately on service close without a timer turn", async () => {
  vi.useFakeTimers();
  const child = new FakeChild();
  const client = new PublishingObserverClient(() => child.asChild());
  try {
    const read = client.observe();
    child.emit("message", { kind: "ready" });
    client.close();
    expect(await read).toBe(false);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(await client.observe()).toBe(false);
  } finally {
    client.close();
    vi.useRealTimers();
  }
});

it("dispatches the source helper before CLI startup and observes only publishing truthiness", async () => {
  const directory = await NodeFSP.mkdtemp(
    NodePath.join(NodeOS.tmpdir(), "t3-publishing-observer-"),
  );
  const children: NodeChildProcess.ChildProcess[] = [];
  const client = new PublishingObserverClient(() => {
    const child = NodeChildProcess.spawn(
      process.execPath,
      [
        "--experimental-strip-types",
        NodePath.resolve("src/bin.ts"),
        "__publishing-observer",
        directory,
      ],
      { stdio: ["ignore", "ignore", "ignore", "ipc"] },
    );
    children.push(child);
    return child;
  }, 3_000);
  try {
    await Promise.all(
      PUBLISHING_SECRET_NAMES.map((name, i) =>
        NodeFSP.writeFile(NodePath.join(directory, `${name}.bin`), i === 0 ? "true" : "configured"),
      ),
    );
    expect(await client.observe()).toBe(true);
    await NodeFSP.writeFile(NodePath.join(directory, `${PUBLISHING_SECRET_NAMES[0]}.bin`), "TRUE");
    expect(await client.observe()).toBe(false);
    await NodeFSP.writeFile(NodePath.join(directory, `${PUBLISHING_SECRET_NAMES[0]}.bin`), "true");
    await NodeFSP.writeFile(NodePath.join(directory, `${PUBLISHING_SECRET_NAMES[1]}.bin`), "");
    expect(await client.observe()).toBe(false);
    await NodeFSP.writeFile(
      NodePath.join(directory, `${PUBLISHING_SECRET_NAMES[1]}.bin`),
      "configured",
    );
    await NodeFSP.writeFile(
      NodePath.join(directory, `${PUBLISHING_SECRET_NAMES[2]}.bin`),
      Buffer.alloc(65_537, 65),
    );
    expect(await client.observe()).toBe(false);
  } finally {
    const exited = children.map((child) =>
      child.exitCode !== null || child.signalCode !== null
        ? Promise.resolve()
        : new Promise<void>((done) => child.once("exit", () => done())),
    );
    client.close();
    await Promise.all(exited);
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});

it("times out a real FIFO read and reaps the isolated helper without waiting for native I/O", async () => {
  const directory = await NodeFSP.mkdtemp(
    NodePath.join(NodeOS.tmpdir(), "t3-publishing-fifo-deadline-"),
  );
  const children: NodeChildProcess.ChildProcess[] = [];
  const client = new PublishingObserverClient(() => {
    const child = NodeChildProcess.spawn(
      process.execPath,
      [
        "--experimental-strip-types",
        NodePath.resolve("src/bin.ts"),
        "__publishing-observer",
        directory,
      ],
      { stdio: ["ignore", "ignore", "ignore", "ipc"] },
    );
    children.push(child);
    return child;
  });
  try {
    NodeChildProcess.execFileSync("mkfifo", [
      NodePath.join(directory, `${PUBLISHING_SECRET_NAMES[0]}.bin`),
    ]);
    await Promise.all(
      PUBLISHING_SECRET_NAMES.slice(1).map((name) =>
        NodeFSP.writeFile(NodePath.join(directory, `${name}.bin`), "configured"),
      ),
    );
    const started = performance.now();
    expect(await client.observe()).toBe(false);
    expect(performance.now() - started).toBeLessThan(2_000);
    const child = children[0]!;
    await new Promise<void>((done, reject) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        done();
        return;
      }
      const deadline = setTimeout(() => reject(new Error("helper reap deadline")), 2_000);
      child.once("exit", () => {
        clearTimeout(deadline);
        done();
      });
    });
    expect(children).toHaveLength(1);
  } finally {
    client.close();
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});

it("exits a FIFO-blocked helper when its parent dies, without orphaning the captured PID", async () => {
  const directory = await NodeFSP.mkdtemp(
    NodePath.join(NodeOS.tmpdir(), "t3-publishing-parent-death-"),
  );
  let controller: NodeChildProcess.ChildProcess | undefined;
  let helperPid: number | undefined;
  try {
    NodeChildProcess.execFileSync("mkfifo", [
      NodePath.join(directory, `${PUBLISHING_SECRET_NAMES[0]}.bin`),
    ]);
    await Promise.all(
      PUBLISHING_SECRET_NAMES.slice(1).map((name) =>
        NodeFSP.writeFile(NodePath.join(directory, `${name}.bin`), "configured"),
      ),
    );
    // Controller owns the helper. Root only kills this captured controller PID.
    controller = NodeChildProcess.spawn(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `
      import * as NodeChildProcess from "node:child_process";
      const child = NodeChildProcess.spawn(process.execPath, ["--experimental-strip-types",
        ${JSON.stringify(NodePath.resolve("src/bin.ts"))}, "__publishing-observer",
        ${JSON.stringify(directory)}], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
      child.on("message", (message) => {
        if (message.kind === "ready") {
          child.send({ kind: "observe-publishing", id: 1 });
          // This bounded no-response check exercises the real FIFO open, not a mock.
          setTimeout(() => process.send({ helperPid: child.pid }), 200);
        } else { process.send({ unexpectedResponse: true }); }
      });
      child.on("error", () => process.send({ failed: true }));
      process.on("message", () => {});
    `,
      ],
      { stdio: ["ignore", "ignore", "ignore", "ipc"] },
    );
    const metadata = await new Promise<{ helperPid: number }>((done, reject) => {
      const deadline = setTimeout(() => reject(new Error("controller startup deadline")), 3_000);
      controller!.once("message", (value: unknown) => {
        clearTimeout(deadline);
        if (
          typeof value === "object" &&
          value !== null &&
          "helperPid" in value &&
          typeof value.helperPid === "number"
        )
          done({ helperPid: value.helperPid });
        else reject(new Error("helper did not enter blocked observation"));
      });
      controller!.once("error", reject);
    });
    helperPid = metadata.helperPid;
    process.kill(helperPid, 0);
    const controllerExit = new Promise<void>((done) => controller!.once("exit", () => done()));
    controller.kill("SIGKILL");
    await controllerExit;
    // The root cannot reap a grandchild; the OS's process inventory is authoritative.
    await new Promise<void>((done, reject) => {
      const started = performance.now();
      const check = () => {
        try {
          process.kill(helperPid!, 0);
        } catch (error) {
          if (error instanceof Error && "code" in error && error.code === "ESRCH") {
            done();
            return;
          }
          reject(error);
          return;
        }
        if (performance.now() - started > 3_000) {
          reject(
            new Error(
              "FIFO-blocked helper survived parent death: " +
                NodeChildProcess.execFileSync(
                  "ps",
                  ["-p", String(helperPid), "-o", "pid=,ppid=,state="],
                  {
                    encoding: "utf8",
                  },
                ).trim(),
            ),
          );
          return;
        }
        setTimeout(check, 20);
      };
      check();
    });
    helperPid = undefined;
  } finally {
    if (controller && controller.exitCode === null && controller.signalCode === null) {
      controller.kill("SIGKILL");
    }
    if (helperPid !== undefined) {
      try {
        process.kill(helperPid, "SIGKILL");
      } catch {
        /* already reaped */
      }
    }
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});
