import type { EnvironmentId, ServerProvider } from "@t3tools/contracts";

export interface ProviderUsageLimitsEnvironmentInput {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly providers: ReadonlyArray<ServerProvider>;
}

export interface ProviderUsageLimitsEntry {
  readonly provider: ServerProvider;
  readonly accountKey: string | null;
  readonly sharedAcrossEnvironments: boolean;
}

export interface ProviderUsageLimitsEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly entries: ReadonlyArray<ProviderUsageLimitsEntry>;
}

function reliableAccountKey(provider: ServerProvider): string | null {
  const email = provider.auth.email?.trim().toLowerCase();
  return email ? `${provider.driver}:${email}` : null;
}

/** Groups limits by environment while only linking accounts with reliable identity. */
export function collectProviderUsageLimits(
  environments: ReadonlyArray<ProviderUsageLimitsEnvironmentInput>,
): ReadonlyArray<ProviderUsageLimitsEnvironment> {
  const accountEnvironments = new Map<string, Set<EnvironmentId>>();
  for (const environment of environments) {
    for (const provider of environment.providers) {
      if (!provider.enabled) continue;
      const key = reliableAccountKey(provider);
      if (!key) continue;
      const environmentIds = accountEnvironments.get(key) ?? new Set<EnvironmentId>();
      environmentIds.add(environment.environmentId);
      accountEnvironments.set(key, environmentIds);
    }
  }
  return environments.map((environment) => ({
    environmentId: environment.environmentId,
    label: environment.label,
    entries: environment.providers.flatMap((provider) => {
      if (!provider.enabled) return [];
      const accountKey = reliableAccountKey(provider);
      return [
        {
          provider,
          accountKey,
          sharedAcrossEnvironments:
            accountKey !== null && (accountEnvironments.get(accountKey)?.size ?? 0) > 1,
        },
      ];
    }),
  }));
}
