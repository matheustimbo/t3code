import type {
  ResourceTelemetryProcess,
  ResourceTelemetrySnapshot,
  ThreadId,
  ThreadResourceUsage,
} from "@t3tools/contracts";

import type { ThreadProcessClaim } from "./ThreadProcessRegistry.ts";

/**
 * Shortest command-line marker we will match on. Provider session ids are
 * UUIDs; anything shorter is too likely to collide with an unrelated
 * argument and bill another thread's work to this one.
 */
const MIN_COMMAND_TOKEN_LENGTH = 8;

interface Totals {
  processCount: number;
  cpuPercent: number;
  cpuTimeMs: number;
  rssBytes: number;
  peakRssBytes: number;
  ioReadBytesPerSecond: number;
  ioWriteBytesPerSecond: number;
}

function emptyTotals(): Totals {
  return {
    processCount: 0,
    cpuPercent: 0,
    cpuTimeMs: 0,
    rssBytes: 0,
    peakRssBytes: 0,
    ioReadBytesPerSecond: 0,
    ioWriteBytesPerSecond: 0,
  };
}

function add(totals: Totals, process: ResourceTelemetryProcess): void {
  totals.processCount += 1;
  totals.cpuPercent += process.cpuPercent;
  totals.cpuTimeMs += process.cpuTimeMs;
  totals.rssBytes += process.residentBytes;
  totals.peakRssBytes += process.peakResidentBytes;
  totals.ioReadBytesPerSecond += process.ioReadBytesPerSecond;
  totals.ioWriteBytesPerSecond += process.ioWriteBytesPerSecond;
}

/**
 * Root pids a claim currently resolves to. A pid claim is a single root; a
 * command-token claim can resolve to several, because a provider may briefly
 * have more than one CLI alive for the same session id during a handover.
 */
function resolveRoots(
  claim: ThreadProcessClaim,
  processes: ReadonlyArray<ResourceTelemetryProcess>,
): ReadonlyArray<number> {
  if (claim.pid !== undefined) {
    return processes.some((process) => process.identity.pid === claim.pid) ? [claim.pid] : [];
  }
  const token = claim.commandToken;
  if (token === undefined || token.length < MIN_COMMAND_TOKEN_LENGTH) return [];
  return processes
    .filter((process) => process.command.includes(token))
    .map((process) => process.identity.pid);
}

function collectSubtree(
  rootPid: number,
  byPid: ReadonlyMap<number, ResourceTelemetryProcess>,
  seen: Set<number>,
): ReadonlyArray<ResourceTelemetryProcess> {
  const collected: ResourceTelemetryProcess[] = [];
  const queue = [rootPid];
  while (queue.length > 0) {
    const pid = queue.pop();
    if (pid === undefined || seen.has(pid)) continue;
    const process = byPid.get(pid);
    if (!process) continue;
    seen.add(pid);
    collected.push(process);
    queue.push(...process.childPids);
  }
  return collected;
}

function telemetryUnavailable(snapshot: ResourceTelemetrySnapshot): boolean {
  const dead = (status: string) => status === "unavailable" || status === "stopped";
  return dead(snapshot.health.native.status) && dead(snapshot.health.desktop.status);
}

function percentOf(part: number, whole: number): number {
  if (!Number.isFinite(whole) || whole <= 0) return 0;
  return (part / whole) * 100;
}

function round(value: number): number {
  return Math.max(0, Math.round(value));
}

/**
 * Whether a subscriber should be handed the cached snapshot as its first
 * value.
 *
 * Subscribing is what starts sampling, so the cached snapshot predates the
 * subscription on the first card of a session: it carries no processes and
 * reads as "no telemetry on this host". Showing that is worse than showing
 * nothing for the moment it takes the first real sample to land.
 */
export function shouldSeedFromCachedSnapshot(input: {
  readonly cachedReadAtMs: number;
  readonly subscribedAtMs: number;
}): boolean {
  return input.cachedReadAtMs >= input.subscribedAtMs;
}

/**
 * Sums one thread's slice of a telemetry snapshot: its provider runtime, its
 * terminals, and every process those spawned.
 *
 * Each provider runs one runtime per thread, so a claimed root's subtree
 * belongs to that thread alone; pids are visited once so overlapping claims
 * cannot double-count.
 */
export function aggregateThreadResourceUsage(input: {
  readonly threadId: ThreadId;
  readonly claims: ReadonlyArray<ThreadProcessClaim>;
  readonly snapshot: ResourceTelemetrySnapshot;
}): ThreadResourceUsage {
  const { threadId, claims, snapshot } = input;
  const base = {
    threadId,
    readAt: snapshot.readAt,
    processCount: 0,
    agentProcessCount: 0,
    terminalCount: 0,
    cpuPercent: 0,
    cpuTimeMs: 0,
    rssBytes: 0,
    peakRssBytes: 0,
    ioReadBytesPerSecond: 0,
    ioWriteBytesPerSecond: 0,
    cpuSharePercent: 0,
  } as const;

  if (telemetryUnavailable(snapshot)) {
    return { ...base, status: "unavailable" };
  }

  const byPid = new Map(snapshot.processes.map((process) => [process.identity.pid, process]));
  const totals = emptyTotals();
  let agentProcessCount = 0;
  // Terminals are counted as terminals. Summing their subtrees instead would
  // report one terminal running a dev server as several terminals.
  let terminalCount = 0;
  const seen = new Set<number>();

  for (const claim of claims) {
    if (claim.threadId !== threadId) continue;
    let claimProcessCount = 0;
    for (const rootPid of resolveRoots(claim, snapshot.processes)) {
      const subtree = collectSubtree(rootPid, byPid, seen);
      claimProcessCount += subtree.length;
      for (const process of subtree) add(totals, process);
    }
    if (claimProcessCount === 0) continue;
    if (claim.kind === "terminal") terminalCount += 1;
    else agentProcessCount += claimProcessCount;
  }

  if (totals.processCount === 0) {
    return { ...base, status: "idle" };
  }

  return {
    threadId,
    readAt: snapshot.readAt,
    status: "active",
    processCount: totals.processCount,
    agentProcessCount,
    terminalCount,
    cpuPercent: totals.cpuPercent,
    cpuTimeMs: round(totals.cpuTimeMs),
    rssBytes: round(totals.rssBytes),
    peakRssBytes: round(totals.peakRssBytes),
    ioReadBytesPerSecond: totals.ioReadBytesPerSecond,
    ioWriteBytesPerSecond: totals.ioWriteBytesPerSecond,
    cpuSharePercent: percentOf(totals.cpuPercent, snapshot.groups.allT3.currentCpuPercent),
  };
}
