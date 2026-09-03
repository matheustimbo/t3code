import type {
  ResourceTelemetryAggregate,
  ResourceTelemetryProcess,
  ResourceTelemetrySnapshot,
  ResourceTelemetrySourceStatus,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

import type { ThreadProcessClaim } from "./ThreadProcessRegistry.ts";
import { aggregateThreadResourceUsage } from "./ThreadResourceUsage.ts";

const READ_AT = DateTime.makeUnsafe("2026-06-17T12:00:00.000Z");
const THREAD = "thread-a" as ThreadId;
const OTHER_THREAD = "thread-b" as ThreadId;

function process(
  input: Partial<ResourceTelemetryProcess> & { readonly pid: number },
): ResourceTelemetryProcess {
  const { pid, ...rest } = input;
  return {
    identity: { pid, startTimeMs: 1_000 },
    ppid: 1,
    childPids: [],
    depth: 1,
    name: `process-${pid}`,
    command: `process-${pid}`,
    status: "Running",
    category: "server-child",
    cpuPercent: 0,
    cpuTimeMs: 0,
    residentBytes: 0,
    peakResidentBytes: 0,
    virtualBytes: 0,
    ioReadBytes: 0,
    ioWriteBytes: 0,
    ioReadBytesPerSecond: 0,
    ioWriteBytesPerSecond: 0,
    ioSemantics: "storage",
    runTimeMs: 1_000,
    firstSeenAt: READ_AT,
    lastSeenAt: READ_AT,
    ...rest,
  };
}

function aggregate(cpuPercent: number): ResourceTelemetryAggregate {
  return {
    processCount: 0,
    currentCpuPercent: cpuPercent,
    cpuTimeMs: 0,
    currentRssBytes: 0,
    peakRssBytes: 0,
    ioReadBytes: 0,
    ioWriteBytes: 0,
    ioReadBytesPerSecond: 0,
    ioWriteBytesPerSecond: 0,
    processStarts: 0,
    processExits: 0,
  };
}

function snapshot(input: {
  readonly processes: ReadonlyArray<ResourceTelemetryProcess>;
  readonly allT3CpuPercent?: number;
  readonly nativeStatus?: ResourceTelemetrySourceStatus;
}): ResourceTelemetrySnapshot {
  const sourceHealth = (status: ResourceTelemetrySourceStatus) => ({
    status,
    lastSampleAt: Option.none(),
    lastError: Option.none(),
  });
  return {
    readAt: READ_AT,
    sampleIntervalMs: 1_000,
    processes: input.processes,
    groups: {
      backend: aggregate(0),
      electron: aggregate(0),
      monitor: aggregate(0),
      allT3: aggregate(input.allT3CpuPercent ?? 0),
    },
    power: {
      source: "unknown",
      idle: "unknown",
      idleSeconds: null,
      locked: "unknown",
      suspended: false,
      onBattery: "unknown",
      lowPowerMode: "unknown",
      thermalState: "unknown",
      stale: false,
      updatedAt: READ_AT,
    },
    speedLimitPercent: Option.none(),
    attribution: { readAt: READ_AT, entries: [] },
    health: {
      native: sourceHealth(input.nativeStatus ?? "healthy"),
      desktop: sourceHealth("unavailable"),
      sidecarVersion: Option.none(),
      sidecarPid: Option.none(),
      restartCount: 0,
      collectionDurationMicros: 0,
      scannedProcessCount: 0,
      retainedProcessCount: 0,
      inaccessibleProcessCount: 0,
    },
  };
}

function usageFor(claims: ReadonlyArray<ThreadProcessClaim>, telemetry: ResourceTelemetrySnapshot) {
  return aggregateThreadResourceUsage({ threadId: THREAD, claims, snapshot: telemetry });
}

describe("aggregateThreadResourceUsage", () => {
  it("sums the agent process subtree and its terminals", () => {
    const telemetry = snapshot({
      allT3CpuPercent: 200,
      processes: [
        process({
          pid: 10,
          childPids: [11],
          cpuPercent: 30,
          cpuTimeMs: 5_000,
          residentBytes: 100,
          peakResidentBytes: 150,
        }),
        process({ pid: 11, ppid: 10, cpuPercent: 10, cpuTimeMs: 2_000, residentBytes: 50 }),
        process({ pid: 20, cpuPercent: 10, cpuTimeMs: 1_000, residentBytes: 25 }),
        // Another thread's work must not land in this thread's totals.
        process({ pid: 30, cpuPercent: 90, residentBytes: 999 }),
      ],
    });

    const usage = usageFor(
      [
        { threadId: THREAD, kind: "agent", pid: 10 },
        { threadId: THREAD, kind: "terminal", pid: 20 },
        { threadId: OTHER_THREAD, kind: "agent", pid: 30 },
      ],
      telemetry,
    );

    expect(usage.status).toBe("active");
    expect(usage.processCount).toBe(3);
    expect(usage.agentProcessCount).toBe(2);
    expect(usage.terminalCount).toBe(1);
    expect(usage.cpuPercent).toBe(50);
    expect(usage.cpuTimeMs).toBe(8_000);
    expect(usage.rssBytes).toBe(175);
    expect(usage.peakRssBytes).toBe(150);
    expect(usage.cpuSharePercent).toBe(25);
  });

  it("finds a Claude CLI the SDK spawned by its session id in the command line", () => {
    const sessionId = "6f1d0d3e-9a4c-4d1a-9f66-2f3c2c8a77b1";
    const telemetry = snapshot({
      processes: [
        process({
          pid: 41,
          command: `claude --output-format stream-json --session-id ${sessionId}`,
          childPids: [42],
          cpuPercent: 12,
        }),
        process({ pid: 42, ppid: 41, cpuPercent: 3 }),
        process({ pid: 50, command: "claude --session-id 00000000-dead-beef", cpuPercent: 80 }),
      ],
    });

    const usage = usageFor(
      [{ threadId: THREAD, kind: "agent", commandToken: sessionId }],
      telemetry,
    );

    expect(usage.processCount).toBe(2);
    expect(usage.cpuPercent).toBe(15);
  });

  it("ignores command tokens too short to identify a process", () => {
    const telemetry = snapshot({
      processes: [process({ pid: 60, command: "claude --session-id abc", cpuPercent: 40 })],
    });

    const usage = usageFor([{ threadId: THREAD, kind: "agent", commandToken: "abc" }], telemetry);

    expect(usage.status).toBe("idle");
    expect(usage.cpuPercent).toBe(0);
  });

  it("counts a busy terminal as one terminal, not as its process tree", () => {
    const telemetry = snapshot({
      processes: [
        process({ pid: 10, cpuPercent: 1 }),
        // One terminal running a dev server: shell -> node -> two workers.
        process({ pid: 20, childPids: [21] }),
        process({ pid: 21, ppid: 20, childPids: [22, 23] }),
        process({ pid: 22, ppid: 21 }),
        process({ pid: 23, ppid: 21 }),
      ],
    });

    const usage = usageFor(
      [
        { threadId: THREAD, kind: "agent", pid: 10 },
        { threadId: THREAD, kind: "terminal", pid: 20 },
      ],
      telemetry,
    );

    expect(usage.processCount).toBe(5);
    expect(usage.agentProcessCount).toBe(1);
    expect(usage.terminalCount).toBe(1);
  });

  it("does not count a terminal whose process has exited", () => {
    const telemetry = snapshot({ processes: [process({ pid: 10 })] });

    const usage = usageFor(
      [
        { threadId: THREAD, kind: "agent", pid: 10 },
        { threadId: THREAD, kind: "terminal", pid: 999 },
      ],
      telemetry,
    );

    expect(usage.terminalCount).toBe(0);
  });

  it("counts a process once when claims overlap", () => {
    const telemetry = snapshot({
      processes: [
        process({ pid: 70, childPids: [71], cpuPercent: 5 }),
        process({ pid: 71, ppid: 70, cpuPercent: 5 }),
      ],
    });

    const usage = usageFor(
      [
        { threadId: THREAD, kind: "agent", pid: 70 },
        { threadId: THREAD, kind: "terminal", pid: 71 },
      ],
      telemetry,
    );

    expect(usage.processCount).toBe(2);
    expect(usage.cpuPercent).toBe(10);
  });

  it("reports idle when the thread's claimed processes have exited", () => {
    const telemetry = snapshot({ processes: [process({ pid: 80 })] });

    const usage = usageFor([{ threadId: THREAD, kind: "agent", pid: 99 }], telemetry);

    expect(usage.status).toBe("idle");
    expect(usage.processCount).toBe(0);
  });

  it("reports unavailable when no telemetry source is alive", () => {
    const telemetry = snapshot({ processes: [], nativeStatus: "unavailable" });

    const usage = usageFor([{ threadId: THREAD, kind: "agent", pid: 10 }], telemetry);

    expect(usage.status).toBe("unavailable");
  });

  it("leaves the CPU share at zero when the host reports no T3 CPU", () => {
    const telemetry = snapshot({
      allT3CpuPercent: 0,
      processes: [process({ pid: 90, cpuPercent: 4 })],
    });

    const usage = usageFor([{ threadId: THREAD, kind: "agent", pid: 90 }], telemetry);

    expect(usage.cpuSharePercent).toBe(0);
  });
});
