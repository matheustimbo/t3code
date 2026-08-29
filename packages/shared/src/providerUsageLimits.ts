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

export function providerLimitColor(
  driver: ProviderDriverKind,
  customAccent?: string | undefined,
): string {
  return customAccent ?? PROVIDER_LIMIT_COLORS[driver] ?? "#64748b";
}

export function displayRemainingPercent(
  limits: ServerProviderUsageLimits,
  window: ServerProviderUsageLimitWindow,
  nowMs = new Date().getTime(),
): number | undefined {
  if (
    limits.status === "stale" &&
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

export function usageLimitsStatusLabel(limits: ServerProviderUsageLimits): string {
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
