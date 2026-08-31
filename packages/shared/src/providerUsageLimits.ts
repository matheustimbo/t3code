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

/** Expands pooled accounts without combining their independently metered windows. */
export function providerUsageLimitDisplayWindows(
  limits: ServerProviderUsageLimits,
): ReadonlyArray<ProviderUsageLimitDisplayWindow> {
  if (limits.accounts && limits.accounts.length > 0) {
    return limits.accounts.flatMap((account) => {
      const accountLabel = account.email ?? account.label ?? account.id;
      return account.windows.map((window) => ({
        id: `${account.id}:${window.id}`,
        label: `${accountLabel} · ${window.label}`,
        limits: account,
        window,
      }));
    });
  }
  return limits.windows.map((window) => ({
    id: window.id,
    label: window.label,
    limits,
    window,
  }));
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

export function formatRemainingPercent(value: number | undefined): string {
  return value === undefined ? "Remaining unavailable" : `${Math.round(value)}% remaining`;
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
