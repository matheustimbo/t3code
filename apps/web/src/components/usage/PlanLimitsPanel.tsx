import { PROVIDER_DISPLAY_NAMES, type ServerProvider } from "@t3tools/contracts";
import type { ProviderUsageLimitsEntry } from "@t3tools/client-runtime/providerUsageLimits";
import {
  areProviderUsageLimitsOutOfDate,
  displayRemainingPercent,
  formatLimitReset,
  formatRemainingPercent,
  providerLimitColor,
  usageLimitsStatusLabel,
} from "@t3tools/shared/providerUsageLimits";
import { ExternalLinkIcon, RefreshCwIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { useProviderUsageLimits } from "../../state/providerUsageLimits";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { cn } from "../../lib/utils";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";

function providerColor(provider: ServerProvider): string {
  return providerLimitColor(provider.driver, provider.accentColor);
}

export function PlanLimitsPanel() {
  const environments = useProviderUsageLimits();
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const [refreshing, setRefreshing] = useState(false);
  const providerCount = useMemo(
    () => environments.reduce((total, environment) => total + environment.entries.length, 0),
    [environments],
  );

  const refresh = () => {
    if (refreshing) return;
    setRefreshing(true);
    void Promise.all(
      environments.map((environment) =>
        refreshProviders({ environmentId: environment.environmentId, input: {} }),
      ),
    ).finally(() => setRefreshing(false));
  };

  if (environments.length === 0) {
    return (
      <div className="py-20 text-center text-sm text-muted-foreground">
        Connect an environment to see plan limits.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h2 className="text-lg font-semibold text-foreground">Subscription plan limits</h2>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Live allowance reported by each provider. Percentages are never added across devices or
            accounts.
          </p>
        </div>
        <Button onClick={refresh} disabled={refreshing} variant="outline" size="sm">
          <RefreshCwIcon className={cn("size-3.5", refreshing && "animate-spin")} />
          Refresh
        </Button>
      </div>

      {providerCount === 0 ? (
        <div className="rounded-lg border border-border px-5 py-12 text-center text-sm text-muted-foreground">
          No enabled provider instances are configured.
        </div>
      ) : (
        environments.map((environment) => (
          <section key={environment.environmentId} className="flex flex-col gap-3">
            <div className="flex items-baseline justify-between gap-3">
              <h3 className="text-sm font-medium text-foreground">{environment.label}</h3>
              <span className="text-xs text-muted-foreground">
                {environment.entries.length}{" "}
                {environment.entries.length === 1 ? "account" : "accounts"}
              </span>
            </div>
            <div className="grid gap-3 xl:grid-cols-2">
              {environment.entries.map((entry) => (
                <ProviderLimitCard key={entry.entryId} entry={entry} />
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  );
}

function ProviderLimitCard(props: { readonly entry: ProviderUsageLimitsEntry }) {
  const { entry } = props;
  const limits = entry.limits;
  const color = providerColor(entry.provider);
  const exhausted = limits?.windows.some((window) => displayRemainingPercent(limits, window) === 0);
  const providerName =
    entry.provider.displayName?.trim() ||
    PROVIDER_DISPLAY_NAMES[entry.provider.driver] ||
    entry.provider.driver;

  return (
    <article
      className={cn(
        "flex min-w-0 flex-col gap-4 rounded-xl border border-border bg-card p-4",
        limits && areProviderUsageLimitsOutOfDate(limits) && "opacity-75",
        exhausted && "border-destructive/70",
      )}
    >
      <header className="flex min-w-0 items-start gap-3">
        <ProviderInstanceIcon
          driverKind={entry.provider.driver}
          displayName={providerName}
          accentColor={entry.provider.accentColor}
          showBadge={Boolean(entry.provider.accentColor)}
          className="mt-0.5 size-5"
          iconClassName="size-5"
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="truncate text-sm font-medium text-foreground">{providerName}</h4>
            <Badge variant="outline" size="sm">
              {limits ? usageLimitsStatusLabel(limits) : "Waiting"}
            </Badge>
            {limits?.support === "experimental" ? (
              <Badge variant="outline" size="sm">
                Experimental
              </Badge>
            ) : null}
            {entry.accountPlanLabel ? (
              <Badge variant="outline" size="sm">
                {entry.accountPlanLabel}
              </Badge>
            ) : null}
          </div>
          <p className="truncate text-xs text-muted-foreground">
            {entry.accountLabel}
            {entry.sharedAcrossEnvironments ? " · Same account on another environment" : ""}
          </p>
        </div>
        {exhausted ? (
          <span className="rounded-full border border-destructive/60 px-2 py-0.5 text-xs text-destructive">
            Exhausted
          </span>
        ) : null}
      </header>

      {limits && limits.windows.length > 0 ? (
        <div className="grid gap-2 sm:grid-cols-2">
          {limits.windows.map((window) => {
            const remaining = displayRemainingPercent(limits, window);
            return (
              <div key={window.id} className="rounded-lg bg-muted/50 px-3 py-2.5">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="truncate text-xs font-medium text-foreground">
                    {window.label}
                  </span>
                  <span className="shrink-0 text-xs font-semibold text-foreground tabular-nums">
                    {formatRemainingPercent(remaining)}
                  </span>
                </div>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full transition-[width]"
                    style={{
                      backgroundColor: color,
                      width: `${remaining ?? 0}%`,
                    }}
                  />
                </div>
                <div className="mt-1.5 text-[11px] text-muted-foreground">
                  {formatLimitReset(window.resetsAt)}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          {limits?.message ?? "This provider has not reported plan-limit data yet."}
        </p>
      )}

      {limits ? (
        <footer className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground">
          <span>
            Source: {limits.source} · Updated {new Date(limits.checkedAt).toLocaleString()}
          </span>
          {limits.dashboardUrl ? (
            <a
              href={limits.dashboardUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 hover:text-foreground"
            >
              Provider dashboard <ExternalLinkIcon className="size-3" />
            </a>
          ) : null}
        </footer>
      ) : null}
    </article>
  );
}
