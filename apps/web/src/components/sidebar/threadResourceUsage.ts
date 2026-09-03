import type { ThreadResourceUsage } from "@t3tools/contracts";

/**
 * Below this, disk traffic is background noise (log writes, a config read)
 * and the row is more clutter than signal.
 */
const IO_FLOOR_BYTES_PER_SECOND = 64 * 1_024;

/** A share only earns its place once it rounds to something you can act on. */
const MIN_SHARE_PERCENT = 1;

export interface ThreadResourceUsageRows {
  /**
   * Said out loud when the host can measure but the thread owns nothing.
   * Silence here is indistinguishable from a broken card, which is how the
   * first users of this read it.
   */
  readonly idle: string | null;
  /** What the thread is holding right now: CPU, memory, and its cut of T3. */
  readonly load: string | null;
  /** What it has cost so far: CPU time burned and the high-water memory mark. */
  readonly history: string | null;
  /** How many processes that adds up to, and what they are. */
  readonly processes: string | null;
  /** Disk traffic, only while there is enough of it to matter. */
  readonly io: string | null;
}

const EMPTY_ROWS: ThreadResourceUsageRows = {
  idle: null,
  load: null,
  history: null,
  processes: null,
  io: null,
};

export function terminalProcessLabel(count: number): string {
  return `${count} terminal ${count === 1 ? "process" : "processes"} running`;
}

export function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value < 1_024) return `${Math.max(0, Math.round(value))} B`;
  const units = ["KB", "MB", "GB", "TB"] as const;
  let next = value;
  let unitIndex = -1;
  do {
    next /= 1_024;
    unitIndex += 1;
  } while (next >= 1_024 && unitIndex < units.length - 1);
  return `${next.toFixed(next >= 100 ? 0 : 1)} ${units[unitIndex]}`;
}

export function formatCpuPercent(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0%";
  if (value < 1) return "<1%";
  return `${Math.round(value)}%`;
}

/** Cumulative CPU, in the largest two units that still say something. */
export function formatCpuTime(valueMs: number): string {
  const totalSeconds = Math.max(0, Math.round(valueMs / 1_000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) {
    const seconds = totalSeconds % 60;
    return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes === 0 ? `${hours}h` : `${hours}h ${remainingMinutes}m`;
}

function processBreakdown(usage: ThreadResourceUsage): string | null {
  const parts: string[] = [];
  if (usage.agentProcessCount > 0) parts.push("agent");
  if (usage.terminalCount > 0) {
    parts.push(usage.terminalCount === 1 ? "1 terminal" : `${usage.terminalCount} terminals`);
  }
  return parts.length > 0 ? parts.join(" + ") : null;
}

/**
 * Turns a usage snapshot into the lines the thread card shows. Returns empty
 * rows whenever there is nothing true to say — no telemetry on this host, or
 * the thread owns no live process — so the card stays silent instead of
 * claiming a confident zero.
 */
export function threadResourceUsageRows(
  usage: ThreadResourceUsage | null | undefined,
): ThreadResourceUsageRows {
  // `unavailable` stays silent: that is the host lacking a resource monitor,
  // not a fact about this thread.
  if (!usage || usage.status === "unavailable") return EMPTY_ROWS;
  if (usage.status === "idle") return { ...EMPTY_ROWS, idle: "No processes running" };

  // Compare what the card will actually print: a peak that rounds to the same
  // figure as current usage is the same number twice.
  const rss = formatBytes(usage.rssBytes);
  const peakRss = formatBytes(usage.peakRssBytes);
  const load = [
    `${formatCpuPercent(usage.cpuPercent)} CPU`,
    rss,
    ...(usage.cpuSharePercent >= MIN_SHARE_PERCENT
      ? [`${Math.round(usage.cpuSharePercent)}% of T3`]
      : []),
  ].join(" · ");

  const history = [
    `${formatCpuTime(usage.cpuTimeMs)} CPU time`,
    ...(peakRss === rss ? [] : [`${peakRss} peak`]),
  ].join(" · ");

  const breakdown = processBreakdown(usage);
  const processes =
    usage.processCount === 0
      ? null
      : [
          usage.processCount === 1 ? "1 process" : `${usage.processCount} processes`,
          ...(breakdown ? [breakdown] : []),
        ].join(" · ");

  const peakIo = Math.max(usage.ioReadBytesPerSecond, usage.ioWriteBytesPerSecond);
  const io =
    peakIo < IO_FLOOR_BYTES_PER_SECOND
      ? null
      : `${formatBytes(usage.ioReadBytesPerSecond)}/s read · ${formatBytes(usage.ioWriteBytesPerSecond)}/s write`;

  return { idle: null, load, history, processes, io };
}
