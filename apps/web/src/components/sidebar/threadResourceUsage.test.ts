import type { ThreadId, ThreadResourceUsage } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import * as DateTime from "effect/DateTime";

import { formatCpuTime, threadResourceUsageRows } from "./threadResourceUsage";

const MB = 1_024 * 1_024;

function usage(overrides: Partial<ThreadResourceUsage> = {}): ThreadResourceUsage {
  return {
    threadId: "thread-a" as ThreadId,
    readAt: DateTime.makeUnsafe("2026-06-17T12:00:00.000Z"),
    status: "active",
    processCount: 4,
    agentProcessCount: 1,
    terminalCount: 3,
    cpuPercent: 42.4,
    cpuTimeMs: 492_000,
    rssBytes: 1_200 * MB,
    peakRssBytes: 1_400 * MB,
    ioReadBytesPerSecond: 0,
    ioWriteBytesPerSecond: 0,
    cpuSharePercent: 38.2,
    ...overrides,
  };
}

describe("threadResourceUsageRows", () => {
  it("summarizes an active thread", () => {
    const rows = threadResourceUsageRows(usage());

    expect(rows.load).toBe("42% CPU · 1.2 GB · 38% of T3");
    expect(rows.history).toBe("8m 12s CPU time · 1.4 GB peak");
    expect(rows.processes).toBe("4 processes · agent + 3 terminals");
    expect(rows.io).toBeNull();
  });

  it("shows disk traffic once it rises above background noise", () => {
    const rows = threadResourceUsageRows(
      usage({ ioReadBytesPerSecond: 12 * MB, ioWriteBytesPerSecond: 3 * MB }),
    );

    expect(rows.io).toBe("12.0 MB/s read · 3.0 MB/s write");
  });

  it("keeps a small share and a peak that rounds to current usage out of the card", () => {
    const rows = threadResourceUsageRows(
      // A peak a few bytes above current still prints as the same figure.
      usage({ cpuSharePercent: 0.4, peakRssBytes: 1_200 * MB + 64, cpuPercent: 0.2 }),
    );

    expect(rows.load).toBe("<1% CPU · 1.2 GB");
    expect(rows.history).toBe("8m 12s CPU time");
  });

  it("says so when the thread owns no live process", () => {
    const rows = threadResourceUsageRows(usage({ status: "idle" }));

    expect(rows.idle).toBe("No processes running");
    expect(rows.load).toBeNull();
  });

  it("stays silent when the host cannot measure at all", () => {
    const rows = threadResourceUsageRows(usage({ status: "unavailable" }));

    expect(rows.idle).toBeNull();
    expect(rows.load).toBeNull();
    expect(threadResourceUsageRows(null).idle).toBeNull();
  });

  it("names a lone terminal and a lone process in the singular", () => {
    const rows = threadResourceUsageRows(
      usage({ processCount: 1, agentProcessCount: 0, terminalCount: 1 }),
    );

    expect(rows.processes).toBe("1 process · 1 terminal");
  });

  it("formats cumulative CPU time across unit boundaries", () => {
    expect(formatCpuTime(0)).toBe("0s");
    expect(formatCpuTime(45_000)).toBe("45s");
    expect(formatCpuTime(120_000)).toBe("2m");
    expect(formatCpuTime(8_040_000)).toBe("2h 14m");
  });
});
