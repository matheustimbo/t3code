// @effect-diagnostics globalDate:off -- Plan-limit labels are presentation helpers derived from the viewer's wall clock.
import type {
  ProviderDriverKind,
  ServerProviderUsageLimitWindow,
  ServerProviderUsageLimits,
} from "@t3tools/contracts";

const PROVIDER_LIMIT_COLORS: Readonly<Record<string, string>> = {
  codex: "#10a37f",
  claude: "#d97757",
  cursor: "#7c3aed",
  grok: "#64748b",
  opencode: "#2563eb",
};

export const PROVIDER_USAGE_LIMITS_STALE_AFTER_MS = 2 * 60_000;

export function areProviderUsageLimitsOutOfDate(
  limits: ServerProviderUsageLimits,
  nowMs = new Date().getTime(),
): boolean {
  if (limits.status === "stale") return true;
  if (limits.status !== "available" && limits.status !== "partial") return false;
  const checkedAtMs = Date.parse(limits.checkedAt);
  return Number.isFinite(checkedAtMs) && nowMs - checkedAtMs > PROVIDER_USAGE_LIMITS_STALE_AFTER_MS;
}

export function providerLimitColor(
  driver: ProviderDriverKind,
  customAccent?: string | undefined,
): string {
  return customAccent ?? PROVIDER_LIMIT_COLORS[driver] ?? "#64748b";
}

export interface ProviderUsageLimitDisplayWindow {
  readonly id: string;
  readonly label: string;
  readonly limits: ServerProviderUsageLimits;
  readonly window: ServerProviderUsageLimitWindow;
}

export interface ProviderUsageLimitDisplayGroup {
  readonly id: string;
  readonly label?: string | undefined;
  readonly limits: ServerProviderUsageLimits;
  readonly windows: ReadonlyArray<ProviderUsageLimitDisplayWindow>;
}

/** Keeps independently metered accounts separate and labels each account once. */
export function providerUsageLimitDisplayGroups(
  limits: ServerProviderUsageLimits,
): ReadonlyArray<ProviderUsageLimitDisplayGroup> {
  if (limits.accounts && limits.accounts.length > 0) {
    return limits.accounts.map((account) => ({
      id: account.id,
      label: account.email ?? account.label ?? account.id,
      limits: account,
      windows: account.windows.map((window) => ({
        id: `${account.id}:${window.id}`,
        label: window.label,
        limits: account,
        window,
      })),
    }));
  }
  return [
    {
      id: "provider",
      limits,
      windows: limits.windows.map((window) => ({
        id: window.id,
        label: window.label,
        limits,
        window,
      })),
    },
  ];
}

/** Expands pooled accounts without combining their independently metered windows. */
export function providerUsageLimitDisplayWindows(
  limits: ServerProviderUsageLimits,
): ReadonlyArray<ProviderUsageLimitDisplayWindow> {
  return providerUsageLimitDisplayGroups(limits).flatMap((group) =>
    group.windows.map((entry) => ({
      ...entry,
      label: group.label ? `${group.label} · ${entry.label}` : entry.label,
    })),
  );
}

export function displayRemainingPercent(
  limits: ServerProviderUsageLimits,
  window: ServerProviderUsageLimitWindow,
  nowMs = new Date().getTime(),
): number | undefined {
  if (
    areProviderUsageLimitsOutOfDate(limits, nowMs) &&
    window.resetsAt !== undefined &&
    Date.parse(window.resetsAt) <= nowMs
  ) {
    return undefined;
  }
  return window.remainingPercent;
}

/** Finds the tightest comparable window without combining account allowances. */
export function providerUsageLimitMostRestrictiveWindowId(
  limits: ServerProviderUsageLimits,
  nowMs = new Date().getTime(),
): string | null {
  const candidates = providerUsageLimitDisplayWindows(limits).flatMap((entry) => {
    const remaining = displayRemainingPercent(entry.limits, entry.window, nowMs);
    return remaining === undefined ? [] : [{ id: entry.id, remaining }];
  });
  if (candidates.length < 2) return null;
  return candidates.reduce((tightest, candidate) =>
    candidate.remaining < tightest.remaining ? candidate : tightest,
  ).id;
}

export function formatRemainingPercent(value: number | undefined): string {
  return value === undefined ? "Remaining unavailable" : `${Math.round(value)}% remaining`;
}

export function formatCompactRemainingPercent(value: number | undefined): string {
  return value === undefined ? "—" : `${Math.round(value)}%`;
}

export function formatLimitReset(
  resetsAt: string | undefined,
  nowMs = new Date().getTime(),
): string {
  if (!resetsAt) return "Reset unavailable";
  const resetMs = Date.parse(resetsAt);
  if (!Number.isFinite(resetMs)) return "Reset unavailable";
  const remainingMs = resetMs - nowMs;
  if (remainingMs <= 0) return "Reset due";
  const minutes = Math.max(1, Math.ceil(remainingMs / 60_000));
  if (minutes < 60) return `Resets in ${minutes}m`;
  const hours = Math.ceil(minutes / 60);
  if (hours < 48) return `Resets in ${hours}h`;
  return `Resets in ${Math.ceil(hours / 24)}d`;
}

export function formatCompactLimitReset(
  resetsAt: string | undefined,
  nowMs = new Date().getTime(),
): string {
  const label = formatLimitReset(resetsAt, nowMs);
  if (label.startsWith("Resets in ")) return label.slice("Resets in ".length);
  if (label === "Reset unavailable") return "—";
  if (label === "Reset due") return "Due";
  return label;
}

export function usageLimitsStatusLabel(
  limits: ServerProviderUsageLimits,
  nowMs = new Date().getTime(),
): string {
  if (areProviderUsageLimitsOutOfDate(limits, nowMs)) return "Out of date";
  switch (limits.status) {
    case "available":
      return "Live";
    case "partial":
      return "Partial";
    case "stale":
      return "Out of date";
    case "disabled":
      return "Disabled";
    case "error":
      return "Unavailable";
    case "unavailable":
      return "Not reported";
  }
}
