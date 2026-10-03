// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - OS process isolation and real-time IPC deadlines are required; workers share libuv.
import * as NodeChildProcess from "node:child_process";
import * as NodeOS from "node:os";
import * as NodeSea from "node:sea";

import {
  isPublishingReady,
  isPublishingResult,
  OBSERVATION_DEADLINE_MS,
} from "./publishingObserverProtocol.ts";

interface ChildSlot {
  readonly child: NodeChildProcess.ChildProcess;
  ready: boolean;
  stopping: boolean;
  escalation?: ReturnType<typeof setTimeout>;
}
interface Observation {
  readonly id: number;
  readonly finish: (active: boolean) => void;
  readonly deadline: ReturnType<typeof setTimeout>;
}

/** One child and one request; an unreaped child keeps its slot even after SIGKILL. */
export class PublishingObserverClient {
  private slot: ChildSlot | undefined;
  private pending: Observation | undefined;
  private nextId = 0;
  private closed = false;

  private readonly spawnChild: () => NodeChildProcess.ChildProcess;
  private readonly deadlineMs: number;

  constructor(
    spawnChild: () => NodeChildProcess.ChildProcess,
    deadlineMs = OBSERVATION_DEADLINE_MS,
  ) {
    this.spawnChild = spawnChild;
    this.deadlineMs = deadlineMs;
  }

  observe(): Promise<boolean> {
    if (this.closed || this.pending || this.slot?.stopping) return Promise.resolve(false);
    return new Promise((finish) => {
      const id = ++this.nextId;
      const deadline = setTimeout(() => this.fail(), this.deadlineMs);
      deadline.unref();
      this.pending = { id, finish, deadline };
      if (!this.slot) {
        try {
          const slot: ChildSlot = { child: this.spawnChild(), ready: false, stopping: false };
          this.slot = slot;
          slot.child.on("message", (message: unknown) => {
            if (this.slot !== slot || slot.stopping) return;
            if (isPublishingReady(message) && !slot.ready) {
              slot.ready = true;
              this.send(slot);
            } else if (
              slot.ready &&
              isPublishingResult(message) &&
              message.id === this.pending?.id
            ) {
              this.settle(message.active);
            } else {
              this.fail();
            }
          });
          slot.child.on("error", () => this.failSlot(slot));
          slot.child.on("disconnect", () => this.failSlot(slot));
          slot.child.once("exit", () => this.reaped(slot));
          // A failed spawn has no PID and emits close without exit.
          slot.child.once("close", () => {
            if (slot.child.pid === undefined) this.reaped(slot);
          });
        } catch {
          this.settle(false);
        }
      } else if (this.slot.ready) {
        this.send(this.slot);
      }
    });
  }

  close(): void {
    this.closed = true;
    this.fail();
    // The owning server may exit before an unref escalation timer can run.
    // Signal the captured child now as well, never leaving shutdown to that timer.
    if (this.slot) {
      try {
        this.slot.child.kill("SIGKILL");
      } catch {
        /* retain slot until reaped */
      }
    }
  }

  private settle(active: boolean): void {
    const observation = this.pending;
    this.pending = undefined;
    if (!observation) return;
    clearTimeout(observation.deadline);
    observation.finish(active);
  }

  private send(slot: ChildSlot): void {
    const observation = this.pending;
    if (!observation || slot.stopping) return;
    try {
      slot.child.send({ kind: "observe-publishing", id: observation.id }, (error) => {
        if (error) this.failSlot(slot);
      });
    } catch {
      this.failSlot(slot);
    }
  }

  private failSlot(slot: ChildSlot): void {
    if (this.slot === slot) this.fail();
  }

  private fail(): void {
    this.settle(false);
    const slot = this.slot;
    if (!slot || slot.stopping) return;
    slot.stopping = true;
    // Shutdown never awaits native I/O or exit. Do not release the slot on kill().
    try {
      if (slot.child.connected) slot.child.disconnect();
    } catch {
      /* best effort */
    }
    try {
      slot.child.kill("SIGTERM");
    } catch {
      /* retain slot until reaped */
    }
    slot.escalation = setTimeout(() => {
      if (this.slot === slot) {
        try {
          slot.child.kill("SIGKILL");
        } catch {
          /* retain slot until reaped */
        }
      }
    }, 100);
    slot.escalation.unref();
  }

  private reaped(slot: ChildSlot): void {
    if (this.slot !== slot) return;
    if (slot.escalation) clearTimeout(slot.escalation);
    this.settle(false);
    this.slot = undefined;
  }
}

/** Only the worker pool setting (and Windows process bootstrap) crosses the process boundary. */
export function publishingObserverEnvironment(
  parentEnv: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): NodeJS.ProcessEnv {
  return {
    UV_THREADPOOL_SIZE: "1",
    ...(platform === "win32" && parentEnv.SystemRoot ? { SystemRoot: parentEnv.SystemRoot } : {}),
  };
}

export function spawnPublishingObserver(directory: string): NodeChildProcess.ChildProcess {
  const args = NodeSea.isSea()
    ? ["__publishing-observer", directory]
    : [process.argv[1]!, "__publishing-observer", directory];
  return NodeChildProcess.spawn(process.execPath, args, {
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    serialization: "json",
    // No parent flags or credentials cross into the child process.
    // oxlint-disable-next-line t3code/no-global-process-runtime -- Child spawn is outside the Effect platform and selects a strict environment allowlist.
    env: publishingObserverEnvironment(process.env, NodeOS.platform()),
    windowsHide: true,
  });
}
