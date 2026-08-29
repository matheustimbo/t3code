import type {
  EnvironmentId,
  ServerProvider,
  ServerProviderUsageLimits,
  ServerProviderUsageLimitsAccount,
} from "@t3tools/contracts";

export interface ProviderUsageLimitsEnvironmentInput {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly providers: ReadonlyArray<ServerProvider>;
}

export interface ProviderUsageLimitsEntry {
  readonly provider: ServerProvider;
  readonly entryId: string;
  readonly accountLabel: string;
  readonly accountEmail?: string | undefined;
  readonly limits?: ServerProviderUsageLimits | ServerProviderUsageLimitsAccount | undefined;
  readonly accountKey: string | null;
  readonly sharedAcrossEnvironments: boolean;
}

export interface ProviderUsageLimitsEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly entries: ReadonlyArray<ProviderUsageLimitsEntry>;
}

function reliableAccountKey(provider: ServerProvider, email: string | undefined): string | null {
  const normalizedEmail = email?.trim().toLowerCase();
  return normalizedEmail ? `${provider.driver}:${normalizedEmail}` : null;
}

function providerEntries(
  provider: ServerProvider,
): ReadonlyArray<Omit<ProviderUsageLimitsEntry, "sharedAcrossEnvironments">> {
  const accounts = provider.usageLimits?.accounts;
  if (accounts && accounts.length > 0) {
    return accounts.map((account) => ({
      provider,
      entryId: `${provider.instanceId}:${account.id}`,
      accountLabel: account.email ?? account.label ?? account.id,
      ...(account.email ? { accountEmail: account.email } : {}),
      limits: account,
      accountKey: reliableAccountKey(provider, account.email),
    }));
  }
  const accountLabel = provider.auth.email ?? provider.auth.label ?? provider.instanceId;
  return [
    {
      provider,
      entryId: provider.instanceId,
      accountLabel,
      ...(provider.auth.email ? { accountEmail: provider.auth.email } : {}),
      ...(provider.usageLimits ? { limits: provider.usageLimits } : {}),
      accountKey: reliableAccountKey(provider, provider.auth.email),
    },
  ];
}

/** Groups limits by environment while only linking accounts with reliable identity. */
export function collectProviderUsageLimits(
  environments: ReadonlyArray<ProviderUsageLimitsEnvironmentInput>,
): ReadonlyArray<ProviderUsageLimitsEnvironment> {
  const environmentEntries = environments.map((environment) => ({
    environmentId: environment.environmentId,
    label: environment.label,
    entries: environment.providers.flatMap((provider) =>
      provider.enabled ? providerEntries(provider) : [],
    ),
  }));
  const accountEnvironments = new Map<string, Set<EnvironmentId>>();
  for (const environment of environmentEntries) {
    for (const entry of environment.entries) {
      const key = entry.accountKey;
      if (!key) continue;
      const environmentIds = accountEnvironments.get(key) ?? new Set<EnvironmentId>();
      environmentIds.add(environment.environmentId);
      accountEnvironments.set(key, environmentIds);
    }
  }
  return environmentEntries.map((environment) => ({
    environmentId: environment.environmentId,
    label: environment.label,
    entries: environment.entries.map((entry) => ({
      ...entry,
      sharedAcrossEnvironments:
        entry.accountKey !== null && (accountEnvironments.get(entry.accountKey)?.size ?? 0) > 1,
    })),
  }));
}
