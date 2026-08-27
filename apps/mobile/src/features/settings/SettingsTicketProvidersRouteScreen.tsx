import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import { useNavigation } from "@react-navigation/native";
import {
  DEFAULT_SERVER_SETTINGS,
  TicketProviderDriverKind,
  TicketProviderInstanceId,
  type EnvironmentId,
  type ServerSettingsPatch,
  type TicketProviderInstanceConfig,
  type TicketProviderProbeResult,
  type TicketProviderBindings,
  type TicketTitleMode,
} from "@t3tools/contracts";
import { Platform, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useContext, useState } from "react";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { useThemeColor } from "../../lib/useThemeColor";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { serverEnvironment } from "../../state/server";
import { useProjects } from "../../state/entities";
import { projectEnvironment } from "../../state/projects";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { SettingsSection } from "./components/SettingsSection";

const MODE_OPTIONS: ReadonlyArray<{
  readonly mode: TicketTitleMode;
  readonly label: string;
}> = [
  { mode: "identifier_title", label: "Identifier and title" },
  { mode: "title", label: "Ticket title" },
  { mode: "custom", label: "Custom template" },
  { mode: "disabled", label: "Off" },
];

interface DriverOption {
  readonly driver: string;
  readonly label: string;
  readonly baseUrl: string;
  readonly identity?: string;
  readonly secret?: string;
}

const DRIVER_OPTIONS: ReadonlyArray<DriverOption> = [
  { driver: "github", label: "GitHub", baseUrl: "https://github.com", identity: "Account login" },
  { driver: "gitlab", label: "GitLab", baseUrl: "https://gitlab.com", secret: "GITLAB_TOKEN" },
  {
    driver: "azure-devops",
    label: "Azure",
    baseUrl: "https://dev.azure.com",
    secret: "AZURE_DEVOPS_EXT_PAT",
  },
  {
    driver: "bitbucket",
    label: "Bitbucket",
    baseUrl: "https://bitbucket.org",
    secret: "T3CODE_BITBUCKET_ACCESS_TOKEN",
  },
  {
    driver: "jira",
    label: "Jira",
    baseUrl: "https://example.atlassian.net",
    identity: "Account email",
    secret: "JIRA_API_TOKEN",
  },
  {
    driver: "clickup",
    label: "ClickUp",
    baseUrl: "https://app.clickup.com",
    identity: "Workspace ID",
    secret: "CLICKUP_API_TOKEN",
  },
];

function inputClassName() {
  return "rounded-[14px] border border-input-border bg-input px-4 py-3 text-base text-foreground";
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .slice(0, 48);
}

function EnvironmentTicketProviders({
  environmentId,
  label,
}: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}) {
  const settings = useAtomValue(serverEnvironment.settingsValueAtom(environmentId));
  const registry = useContext(RegistryContext);
  const checkmarkColor = useThemeColor("--color-icon");
  const destructiveColor = useThemeColor("--color-destructive");
  const [showAdd, setShowAdd] = useState(false);
  const [driver, setDriver] = useState<DriverOption>(DRIVER_OPTIONS[0]);
  const [displayName, setDisplayName] = useState("");
  const [baseUrl, setBaseUrl] = useState<string>(driver.baseUrl);
  const [identity, setIdentity] = useState("");
  const [secret, setSecret] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [probeByInstanceId, setProbeByInstanceId] = useState<
    Readonly<Record<string, TicketProviderProbeResult | "testing">>
  >({});

  if (!settings) {
    return (
      <SettingsSection title={label} card>
        <Text className="p-4 text-sm text-foreground-muted">
          Connect this environment to configure ticket providers.
        </Text>
      </SettingsSection>
    );
  }

  const savePatch = (patch: ServerSettingsPatch) => {
    void runAtomCommand(
      registry,
      serverEnvironment.updateSettings,
      { environmentId, input: { patch } },
      { label: "mobile ticket provider settings" },
    );
  };
  const instances = Object.entries(settings.ticketProviderInstances);
  const probeProvider = (instanceId: string) => {
    setProbeByInstanceId((current) => ({ ...current, [instanceId]: "testing" }));
    void runAtomCommand(
      registry,
      serverEnvironment.probeTicketProvider,
      {
        environmentId,
        input: { instanceId: TicketProviderInstanceId.make(instanceId) },
      },
      { label: "mobile ticket provider connection test" },
    ).then((result) => {
      setProbeByInstanceId((current) => ({
        ...current,
        [instanceId]:
          result._tag === "Success"
            ? result.value
            : {
                instanceId: TicketProviderInstanceId.make(instanceId),
                availability: "unavailable",
                detail: "Connection test could not reach this environment.",
              },
      }));
    });
  };
  const chooseDriver = (option: DriverOption) => {
    setDriver(option);
    setBaseUrl(option.baseUrl);
    setIdentity("");
    setSecret("");
    setError(null);
  };
  const addProvider = () => {
    let parsed: URL;
    try {
      parsed = new URL(baseUrl.trim());
    } catch {
      setError("Enter a valid base URL.");
      return;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      setError("The base URL must use HTTP or HTTPS.");
      return;
    }
    if (driver.driver === "jira" && parsed.hostname === "example.atlassian.net") {
      setError("Replace the example URL with your Jira site URL.");
      return;
    }
    const name = displayName.trim() || driver.label;
    const baseId = `${driver.driver}_${slugify(`${name}_${parsed.host}`)}`.slice(0, 60);
    let id = baseId;
    let suffix = 2;
    while (settings.ticketProviderInstances[TicketProviderInstanceId.make(id)]) {
      id = `${baseId.slice(0, 60 - String(suffix).length)}_${suffix}`;
      suffix += 1;
    }
    const identityConfig =
      identity.trim().length === 0
        ? undefined
        : driver.driver === "github"
          ? { accountLogin: identity.trim() }
          : driver.driver === "jira"
            ? { email: identity.trim() }
            : driver.driver === "clickup"
              ? { workspaceId: identity.trim() }
              : undefined;
    const instance: TicketProviderInstanceConfig = {
      driver: TicketProviderDriverKind.make(driver.driver),
      displayName: name,
      baseUrl: parsed.toString().replace(/\/$/u, ""),
      enabled: true,
      ...(identityConfig ? { config: identityConfig } : {}),
      ...(driver.secret && secret.trim()
        ? {
            environment: [{ name: driver.secret, value: secret.trim(), sensitive: true }],
          }
        : {}),
    };
    savePatch({
      ticketProviderInstances: {
        ...settings.ticketProviderInstances,
        [TicketProviderInstanceId.make(id)]: instance,
      },
    });
    // Credentials are write-only on mobile: discard the draft immediately.
    setSecret("");
    setIdentity("");
    setDisplayName("");
    setShowAdd(false);
    setError(null);
  };

  return (
    <View className="gap-3">
      <SettingsSection title={label} card>
        {MODE_OPTIONS.map((option, index) => (
          <Pressable
            key={option.mode}
            accessibilityRole="radio"
            accessibilityState={{ checked: settings.ticketTitlePolicy.mode === option.mode }}
            className={
              index === 0
                ? "flex-row items-center gap-4 p-4"
                : "flex-row items-center gap-4 border-t border-border-subtle p-4"
            }
            onPress={() =>
              savePatch({
                ticketTitlePolicy: { ...settings.ticketTitlePolicy, mode: option.mode },
              })
            }
          >
            <Text className="min-w-0 flex-1 text-lg text-foreground">{option.label}</Text>
            {settings.ticketTitlePolicy.mode === option.mode ? (
              <SymbolView
                name="checkmark"
                size={18}
                tintColor={checkmarkColor}
                type="monochrome"
                weight="semibold"
              />
            ) : null}
          </Pressable>
        ))}
        {settings.ticketTitlePolicy.mode === "custom" ? (
          <View className="gap-2 border-t border-border-subtle p-4">
            <Text className="text-sm text-foreground-muted">Template</Text>
            <TextInput
              autoCapitalize="none"
              autoCorrect={false}
              defaultValue={settings.ticketTitlePolicy.customTemplate}
              placeholder="{identifier} — {title}"
              className={inputClassName()}
              onSubmitEditing={(event) =>
                savePatch({
                  ticketTitlePolicy: {
                    ...settings.ticketTitlePolicy,
                    customTemplate: event.nativeEvent.text,
                  },
                })
              }
            />
          </View>
        ) : null}
      </SettingsSection>

      <SettingsSection title="Accounts" card>
        {instances.map(([instanceId, instance], index) => {
          const probe = probeByInstanceId[instanceId];
          return (
            <View
              key={instanceId}
              className={index === 0 ? "gap-3 p-4" : "gap-3 border-t border-border-subtle p-4"}
            >
              <View className="flex-row items-center gap-3">
                <View className="min-w-0 flex-1">
                  <Text className="text-lg text-foreground" numberOfLines={1}>
                    {instance.displayName ?? instanceId}
                  </Text>
                  <Text className="text-sm text-foreground-muted" numberOfLines={1}>
                    {instance.baseUrl}
                  </Text>
                </View>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Remove ${instance.displayName ?? instanceId}`}
                  onPress={() => {
                    const next = { ...settings.ticketProviderInstances };
                    delete next[TicketProviderInstanceId.make(instanceId)];
                    savePatch({ ticketProviderInstances: next });
                  }}
                  className="p-2"
                >
                  <SymbolView
                    name="trash"
                    size={18}
                    tintColor={destructiveColor}
                    type="monochrome"
                  />
                </Pressable>
              </View>
              <View className="flex-row items-center gap-3">
                <Text className="min-w-0 flex-1 text-sm text-foreground-muted" numberOfLines={2}>
                  {probe && probe !== "testing"
                    ? probe.detail
                    : "Uses this environment's local tools."}
                </Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Test ${instance.displayName ?? instanceId}`}
                  disabled={probe === "testing" || instance.enabled === false}
                  onPress={() => probeProvider(instanceId)}
                  className="rounded-full border border-border px-3 py-2 disabled:opacity-50"
                >
                  <Text className="text-sm font-medium text-foreground">
                    {probe === "testing" ? "Testing…" : "Test"}
                  </Text>
                </Pressable>
              </View>
            </View>
          );
        })}
        <Pressable
          accessibilityRole="button"
          className={
            instances.length === 0
              ? "flex-row items-center gap-3 p-4"
              : "flex-row items-center gap-3 border-t border-border-subtle p-4"
          }
          onPress={() => setShowAdd((value) => !value)}
        >
          <SymbolView
            name={showAdd ? "xmark" : "plus"}
            size={18}
            tintColor={checkmarkColor}
            type="monochrome"
          />
          <Text className="text-lg text-foreground">{showAdd ? "Cancel" : "Add provider"}</Text>
        </Pressable>
        {showAdd ? (
          <View className="gap-3 border-t border-border-subtle p-4">
            <View className="flex-row flex-wrap gap-2">
              {DRIVER_OPTIONS.map((option) => (
                <Pressable
                  key={option.driver}
                  onPress={() => chooseDriver(option)}
                  className={
                    option.driver === driver.driver
                      ? "rounded-full bg-foreground px-3 py-2"
                      : "rounded-full bg-subtle px-3 py-2"
                  }
                >
                  <Text
                    className={
                      option.driver === driver.driver
                        ? "text-sm text-background"
                        : "text-sm text-foreground"
                    }
                  >
                    {option.label}
                  </Text>
                </Pressable>
              ))}
            </View>
            <TextInput
              placeholder="Name (optional)"
              value={displayName}
              onChangeText={setDisplayName}
              className={inputClassName()}
            />
            <TextInput
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              placeholder="Base URL"
              value={baseUrl}
              onChangeText={setBaseUrl}
              className={inputClassName()}
            />
            {driver.identity ? (
              <TextInput
                autoCapitalize="none"
                autoCorrect={false}
                placeholder={driver.identity}
                value={identity}
                onChangeText={setIdentity}
                className={inputClassName()}
              />
            ) : null}
            {driver.secret ? (
              <TextInput
                autoCapitalize="none"
                autoCorrect={false}
                secureTextEntry
                placeholder="Token (write-only)"
                value={secret}
                onChangeText={setSecret}
                className={inputClassName()}
              />
            ) : null}
            {error ? <Text className="text-sm text-destructive">{error}</Text> : null}
            <Pressable
              accessibilityRole="button"
              onPress={addProvider}
              className="items-center rounded-[14px] bg-foreground px-4 py-3"
            >
              <Text className="font-t3-medium text-background">Save provider</Text>
            </Pressable>
          </View>
        ) : null}
      </SettingsSection>
    </View>
  );
}

function ProjectTicketTitles({ project }: { readonly project: EnvironmentProject }) {
  const settings = useAtomValue(serverEnvironment.settingsValueAtom(project.environmentId));
  const registry = useContext(RegistryContext);
  const checkmarkColor = useThemeColor("--color-icon");
  const storedPolicy = project.ticketTitlePolicy ?? null;
  const effectivePolicy =
    storedPolicy ?? settings?.ticketTitlePolicy ?? DEFAULT_SERVER_SETTINGS.ticketTitlePolicy;
  const selectedMode = storedPolicy?.mode ?? "inherit";
  const bindings = project.ticketProviderBindings ?? [];
  const providerGroups = new Map<
    string,
    {
      readonly driver: string;
      readonly host: string;
      readonly instances: ReadonlyArray<readonly [string, TicketProviderInstanceConfig]>;
    }
  >();
  for (const [instanceId, instance] of Object.entries(settings?.ticketProviderInstances ?? {})) {
    if (instance.enabled === false) continue;
    try {
      const host = new URL(instance.baseUrl).host.toLowerCase();
      const key = `${instance.driver}:${host}`;
      const current = providerGroups.get(key);
      providerGroups.set(key, {
        driver: instance.driver,
        host,
        instances: [...(current?.instances ?? []), [instanceId, instance]],
      });
    } catch {
      // Invalid persisted URLs are ignored here; the server schema reports them on write.
    }
  }

  const updateProject = (input: {
    readonly ticketTitlePolicy?: EnvironmentProject["ticketTitlePolicy"];
    readonly ticketProviderBindings?: TicketProviderBindings;
  }) => {
    void runAtomCommand(
      registry,
      projectEnvironment.update,
      { environmentId: project.environmentId, input: { projectId: project.id, ...input } },
      { label: "mobile project ticket title settings" },
    );
  };
  const updateBinding = (driver: string, host: string, instanceId: string | null) => {
    const remaining = bindings.filter(
      (binding) => !(binding.driver === driver && binding.host.toLowerCase() === host),
    );
    updateProject({
      ticketProviderBindings: instanceId
        ? [
            ...remaining,
            {
              driver: TicketProviderDriverKind.make(driver),
              host,
              instanceId: TicketProviderInstanceId.make(instanceId),
            },
          ]
        : remaining,
    });
  };

  return (
    <SettingsSection title={project.title} card>
      {[
        {
          mode: "inherit",
          label: `Environment default (${MODE_OPTIONS.find((option) => option.mode === effectivePolicy.mode)?.label ?? "Identifier and title"})`,
        },
        ...MODE_OPTIONS,
      ].map((option, index) => (
        <Pressable
          key={option.mode}
          accessibilityRole="radio"
          accessibilityState={{ checked: selectedMode === option.mode }}
          className={
            index === 0
              ? "flex-row items-center gap-4 p-4"
              : "flex-row items-center gap-4 border-t border-border-subtle p-4"
          }
          onPress={() =>
            updateProject({
              ticketTitlePolicy:
                option.mode === "inherit"
                  ? null
                  : { ...effectivePolicy, mode: option.mode as TicketTitleMode },
            })
          }
        >
          <Text className="min-w-0 flex-1 text-lg text-foreground">{option.label}</Text>
          {selectedMode === option.mode ? (
            <SymbolView
              name="checkmark"
              size={18}
              tintColor={checkmarkColor}
              type="monochrome"
              weight="semibold"
            />
          ) : null}
        </Pressable>
      ))}
      {storedPolicy?.mode === "custom" ? (
        <View className="gap-2 border-t border-border-subtle p-4">
          <Text className="text-sm text-foreground-muted">Template</Text>
          <TextInput
            autoCapitalize="none"
            autoCorrect={false}
            defaultValue={storedPolicy.customTemplate}
            className={inputClassName()}
            onSubmitEditing={(event) =>
              updateProject({
                ticketTitlePolicy: {
                  ...storedPolicy,
                  customTemplate: event.nativeEvent.text,
                },
              })
            }
          />
        </View>
      ) : null}
      {[...providerGroups.values()].map((group) => {
        const binding = bindings.find(
          (candidate) =>
            candidate.driver === group.driver && candidate.host.toLowerCase() === group.host,
        );
        const choices = [
          { id: "automatic", label: `${group.host}: environment default` },
          ...group.instances.map(([instanceId, instance]) => ({
            id: instanceId,
            label: `${group.host}: ${instance.displayName ?? instanceId}`,
          })),
        ];
        return choices.map((choice) => (
          <Pressable
            key={`${group.driver}:${group.host}:${choice.id}`}
            accessibilityRole="radio"
            accessibilityState={{ checked: (binding?.instanceId ?? "automatic") === choice.id }}
            className="flex-row items-center gap-4 border-t border-border-subtle p-4"
            onPress={() =>
              updateBinding(group.driver, group.host, choice.id === "automatic" ? null : choice.id)
            }
          >
            <Text className="min-w-0 flex-1 text-base text-foreground">{choice.label}</Text>
            {(binding?.instanceId ?? "automatic") === choice.id ? (
              <SymbolView
                name="checkmark"
                size={18}
                tintColor={checkmarkColor}
                type="monochrome"
                weight="semibold"
              />
            ) : null}
          </Pressable>
        ));
      })}
    </SettingsSection>
  );
}

export function SettingsTicketProvidersRouteScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { savedConnectionsById } = useSavedRemoteConnections();
  const environments = Object.values(savedConnectionsById);
  const projects = useProjects();

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader title="Ticket Providers" onBack={() => navigation.goBack()} />
        </>
      ) : null}
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {environments.length === 0 ? (
          <Text className="rounded-[24px] bg-card p-4 text-foreground-muted">
            Connect an environment first.
          </Text>
        ) : (
          environments.map((environment) => (
            <EnvironmentTicketProviders
              key={environment.environmentId}
              environmentId={environment.environmentId}
              label={environment.environmentLabel || "Environment"}
            />
          ))
        )}
        {projects.length > 0 ? (
          <View className="gap-3">
            <Text className="px-2 text-sm text-foreground-muted">
              Project overrides and account bindings
            </Text>
            {projects.map((project) => (
              <ProjectTicketTitles
                key={`${project.environmentId}:${project.id}`}
                project={project}
              />
            ))}
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}
