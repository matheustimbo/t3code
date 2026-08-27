import {
  DEFAULT_TICKET_TITLE_TEMPLATE,
  TicketProviderDriverKind,
  TicketProviderInstanceId,
  type TicketProviderProbeResult,
  type TicketProviderInstanceConfig,
  type TicketTitleMode,
  type TicketTitlePolicy,
} from "@t3tools/contracts";
import { renderTicketThreadTitle } from "@t3tools/shared/ticketTitles";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Field, FieldDescription, FieldLabel } from "../ui/field";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

interface TicketDriverOption {
  readonly driver: TicketProviderDriverKind;
  readonly label: string;
  readonly defaultBaseUrl: string;
  readonly identityLabel?: string;
  readonly identityDescription?: string;
  readonly identityConfigKey?: "accountLogin" | "email" | "workspaceId";
  readonly secretLabel?: string;
  readonly secretEnvironmentName?: string;
}

const TICKET_DRIVER_OPTIONS: ReadonlyArray<TicketDriverOption> = [
  {
    driver: TicketProviderDriverKind.make("github"),
    label: "GitHub Issues",
    defaultBaseUrl: "https://github.com",
    identityLabel: "GitHub account",
    identityDescription:
      "Optional gh account login. T3 reads its token for this command without changing gh's active account.",
    identityConfigKey: "accountLogin",
  },
  {
    driver: TicketProviderDriverKind.make("gitlab"),
    label: "GitLab Issues",
    defaultBaseUrl: "https://gitlab.com",
    secretLabel: "GitLab token (optional)",
    secretEnvironmentName: "GITLAB_TOKEN",
  },
  {
    driver: TicketProviderDriverKind.make("azure-devops"),
    label: "Azure DevOps Work Items",
    defaultBaseUrl: "https://dev.azure.com",
    secretLabel: "Azure DevOps PAT (optional)",
    secretEnvironmentName: "AZURE_DEVOPS_EXT_PAT",
  },
  {
    driver: TicketProviderDriverKind.make("bitbucket"),
    label: "Bitbucket Cloud Issues",
    defaultBaseUrl: "https://bitbucket.org",
    secretLabel: "Access token (optional for public issues)",
    secretEnvironmentName: "T3CODE_BITBUCKET_ACCESS_TOKEN",
  },
  {
    driver: TicketProviderDriverKind.make("jira"),
    label: "Jira",
    defaultBaseUrl: "https://example.atlassian.net",
    identityLabel: "Account email (Jira Cloud)",
    identityConfigKey: "email",
    secretLabel: "API token or Data Center PAT",
    secretEnvironmentName: "JIRA_API_TOKEN",
  },
  {
    driver: TicketProviderDriverKind.make("clickup"),
    label: "ClickUp Tasks",
    defaultBaseUrl: "https://app.clickup.com",
    identityLabel: "Workspace ID (for custom task IDs)",
    identityConfigKey: "workspaceId",
    secretLabel: "ClickUp API token",
    secretEnvironmentName: "CLICKUP_API_TOKEN",
  },
];

const DRIVER_BY_KIND = new Map(TICKET_DRIVER_OPTIONS.map((option) => [option.driver, option]));
const DEFAULT_DRIVER = TICKET_DRIVER_OPTIONS[0]!;
const POLICY_MODE_LABELS: Readonly<Record<TicketTitleMode, string>> = {
  disabled: "Off",
  title: "Ticket title",
  identifier_title: "Identifier and title",
  custom: "Custom template",
};
const TEMPLATE_PREVIEW_METADATA = {
  title: "Fix reconnect failures",
  identifier: "acme/widgets#12",
  provider: "GitHub",
  project: "acme/widgets",
};

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .slice(0, 48);
}

function hostOf(value: string): string | null {
  try {
    return new URL(value).host;
  } catch {
    return null;
  }
}

function nextInstanceId(
  driver: TicketProviderDriverKind,
  label: string,
  existing: ReadonlySet<string>,
): TicketProviderInstanceId {
  const base = `${driver}_${slugify(label) || "default"}`.slice(0, 60);
  let candidate = base;
  let suffix = 2;
  while (existing.has(candidate)) {
    candidate = `${base.slice(0, 60 - String(suffix).length)}_${suffix}`;
    suffix += 1;
  }
  return TicketProviderInstanceId.make(candidate);
}

export function TicketTitlePolicySettings({
  policy,
  inheritedPolicy,
  onChange,
  allowInherit = false,
}: {
  readonly policy: TicketTitlePolicy | null;
  readonly inheritedPolicy?: TicketTitlePolicy;
  readonly onChange: (policy: TicketTitlePolicy | null) => void;
  readonly allowInherit?: boolean;
}) {
  const effective = policy ??
    inheritedPolicy ?? {
      mode: "identifier_title" as const,
      customTemplate: DEFAULT_TICKET_TITLE_TEMPLATE,
    };
  const [templateDraft, setTemplateDraft] = useState(effective.customTemplate);
  useEffect(() => setTemplateDraft(effective.customTemplate), [effective.customTemplate]);
  const preview = renderTicketThreadTitle(
    { ...effective, customTemplate: templateDraft },
    TEMPLATE_PREVIEW_METADATA,
  );
  const selectValue = policy === null && allowInherit ? "inherit" : effective.mode;

  const updateMode = (value: string | null) => {
    if (allowInherit && value === "inherit") {
      onChange(null);
      return;
    }
    if (
      value === "disabled" ||
      value === "title" ||
      value === "identifier_title" ||
      value === "custom"
    ) {
      onChange({ ...effective, mode: value });
    }
  };

  return (
    <>
      <SettingsRow
        {...searchableSetting("ticket-thread-titles")}
        description={
          allowInherit
            ? "Use the linked ticket from the first message to name new threads in this project."
            : "Use a supported ticket link in the first message to rename the thread asynchronously."
        }
        control={
          <Select value={selectValue} onValueChange={updateMode}>
            <SelectTrigger className="w-full sm:w-48" aria-label="Ticket thread title format">
              <SelectValue>
                {selectValue === "inherit"
                  ? `Default (${POLICY_MODE_LABELS[effective.mode].toLowerCase()})`
                  : POLICY_MODE_LABELS[effective.mode]}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {allowInherit ? <SelectItem value="inherit">Default</SelectItem> : null}
              <SelectItem value="identifier_title">Identifier and title</SelectItem>
              <SelectItem value="title">Ticket title</SelectItem>
              <SelectItem value="custom">Custom template</SelectItem>
              <SelectItem value="disabled">Off</SelectItem>
            </SelectPopup>
          </Select>
        }
      />
      {effective.mode === "custom" && !(allowInherit && policy === null) ? (
        <SettingsRow
          title="Title template"
          description="Variables: {title}, {identifier}, {provider}, and {project}. Use {{ and }} for literal braces."
          status={preview ? `Preview: ${preview}` : "The template contains an unknown variable."}
          control={
            <Input
              className="w-full sm:w-80"
              aria-label="Ticket title template"
              value={templateDraft}
              onChange={(event) => setTemplateDraft(event.currentTarget.value)}
              onBlur={() => {
                if (preview) onChange({ ...effective, customTemplate: templateDraft });
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
              }}
            />
          }
        />
      ) : null}
    </>
  );
}

function AddTicketProviderDialog({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const [driver, setDriver] = useState(DEFAULT_DRIVER.driver);
  const option = DRIVER_BY_KIND.get(driver) ?? DEFAULT_DRIVER;
  const [label, setLabel] = useState("");
  const [baseUrl, setBaseUrl] = useState(DEFAULT_DRIVER.defaultBaseUrl);
  const [identity, setIdentity] = useState("");
  const [secret, setSecret] = useState("");
  const [isDefault, setIsDefault] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectDriver = (value: string | null) => {
    const next = TICKET_DRIVER_OPTIONS.find((candidate) => candidate.driver === value);
    if (!next) return;
    setDriver(next.driver);
    setBaseUrl(next.defaultBaseUrl);
    setIdentity("");
    setSecret("");
    setError(null);
  };

  const save = () => {
    let parsed: URL;
    try {
      parsed = new URL(baseUrl.trim());
    } catch {
      setError("Enter a valid base URL.");
      return;
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      setError("The base URL must use HTTP or HTTPS.");
      return;
    }
    if (
      option.driver === TicketProviderDriverKind.make("jira") &&
      parsed.hostname === "example.atlassian.net"
    ) {
      setError("Replace the example URL with your Jira site URL.");
      return;
    }

    const displayName = label.trim() || option.label;
    const instanceId = nextInstanceId(
      option.driver,
      `${displayName}_${parsed.host}`,
      new Set(Object.keys(settings.ticketProviderInstances)),
    );
    const config =
      option.identityConfigKey && identity.trim()
        ? { [option.identityConfigKey]: identity.trim() }
        : undefined;
    const environment =
      option.secretEnvironmentName && secret.trim()
        ? [
            {
              name: option.secretEnvironmentName,
              value: secret.trim(),
              sensitive: true,
            },
          ]
        : undefined;
    const instance: TicketProviderInstanceConfig = {
      driver: option.driver,
      displayName,
      baseUrl: parsed.toString().replace(/\/$/u, ""),
      enabled: true,
      isDefault,
      ...(config ? { config } : {}),
      ...(environment ? { environment } : {}),
    };
    const nextInstances = { ...settings.ticketProviderInstances };
    if (isDefault) {
      for (const [id, candidate] of Object.entries(nextInstances)) {
        if (candidate.driver === option.driver && hostOf(candidate.baseUrl) === parsed.host) {
          nextInstances[TicketProviderInstanceId.make(id)] = { ...candidate, isDefault: false };
        }
      }
    }
    nextInstances[instanceId] = instance;
    updateSettings({ ticketProviderInstances: nextInstances });
    toastManager.add({ type: "success", title: "Ticket provider added", description: displayName });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Add ticket provider</DialogTitle>
          <DialogDescription>
            T3 prefers the provider's local CLI where one is available. Credentials entered here are
            stored by this environment and never returned to clients.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <Field>
            <FieldLabel>Provider</FieldLabel>
            <Select value={driver} onValueChange={selectDriver}>
              <SelectTrigger className="w-full" aria-label="Ticket provider">
                <SelectValue>{option.label}</SelectValue>
              </SelectTrigger>
              <SelectPopup alignItemWithTrigger={false}>
                {TICKET_DRIVER_OPTIONS.map((candidate) => (
                  <SelectItem key={candidate.driver} value={candidate.driver}>
                    {candidate.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </Field>
          <Field>
            <FieldLabel>Name</FieldLabel>
            <Input
              value={label}
              onChange={(event) => setLabel(event.currentTarget.value)}
              placeholder={option.label}
            />
          </Field>
          <Field>
            <FieldLabel>Base URL</FieldLabel>
            <Input value={baseUrl} onChange={(event) => setBaseUrl(event.currentTarget.value)} />
            <FieldDescription>
              Use the web URL where ticket links for this account open.
            </FieldDescription>
          </Field>
          {option.identityConfigKey ? (
            <Field>
              <FieldLabel>{option.identityLabel}</FieldLabel>
              <Input
                value={identity}
                onChange={(event) => setIdentity(event.currentTarget.value)}
              />
              {option.identityDescription ? (
                <FieldDescription>{option.identityDescription}</FieldDescription>
              ) : null}
            </Field>
          ) : null}
          {option.secretEnvironmentName ? (
            <Field>
              <FieldLabel>{option.secretLabel}</FieldLabel>
              <Input
                type="password"
                value={secret}
                onChange={(event) => setSecret(event.currentTarget.value)}
                autoComplete="off"
              />
            </Field>
          ) : null}
          <label className="flex items-center justify-between gap-4 text-sm">
            <span>
              Default for this provider and host
              <span className="mt-1 block text-xs text-muted-foreground">
                Used when a project has no explicit account binding.
              </span>
            </span>
            <Switch
              checked={isDefault}
              onCheckedChange={(checked) => setIsDefault(Boolean(checked))}
            />
          </label>
          {error ? <p className="text-sm text-destructive-foreground">{error}</p> : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={save}>Add provider</Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

export function TicketProviderSettings() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const environmentId = usePrimaryEnvironmentId();
  const probeProvider = useAtomCommand(serverEnvironment.probeTicketProvider, {
    reportFailure: false,
  });
  const [dialogOpen, setDialogOpen] = useState(false);
  const [probeByInstanceId, setProbeByInstanceId] = useState<
    Readonly<Record<string, TicketProviderProbeResult | "testing">>
  >({});
  const entries = useMemo(
    () => Object.entries(settings.ticketProviderInstances),
    [settings.ticketProviderInstances],
  );

  const replaceInstance = (instanceId: string, instance: TicketProviderInstanceConfig) => {
    updateSettings({
      ticketProviderInstances: {
        ...settings.ticketProviderInstances,
        [TicketProviderInstanceId.make(instanceId)]: instance,
      },
    });
  };

  return (
    <>
      <TicketTitlePolicySettings
        policy={settings.ticketTitlePolicy}
        onChange={(ticketTitlePolicy) => {
          if (ticketTitlePolicy) updateSettings({ ticketTitlePolicy });
        }}
      />
      <SettingsRow
        {...searchableSetting("ticket-providers")}
        description="Accounts T3 can use to read linked tickets. With no configured account, T3 still tries the local CLI for supported providers."
        resetAction={
          entries.length > 0 ? (
            <SettingResetButton
              label="ticket providers"
              onClick={() => updateSettings({ ticketProviderInstances: {} })}
            />
          ) : null
        }
        control={
          <Button size="xs" variant="outline" onClick={() => setDialogOpen(true)}>
            <PlusIcon /> Add provider
          </Button>
        }
      />
      {entries.map(([instanceId, instance]) => {
        const option = DRIVER_BY_KIND.get(instance.driver);
        const probe = probeByInstanceId[instanceId];
        return (
          <div key={instanceId} className="mx-3 flex items-center gap-3 border-t px-1 py-3 sm:mx-4">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">
                {instance.displayName ?? option?.label ?? instance.driver}
              </p>
              <p className="truncate text-xs text-muted-foreground">
                {instance.baseUrl} · {instanceId}
              </p>
              {probe && probe !== "testing" ? (
                <p
                  className={
                    probe.availability === "available"
                      ? "truncate text-xs text-success"
                      : "truncate text-xs text-muted-foreground"
                  }
                >
                  {probe.detail}
                </p>
              ) : null}
            </div>
            <Button
              size="xs"
              variant="outline"
              disabled={!environmentId || probe === "testing" || instance.enabled === false}
              onClick={() => {
                if (!environmentId) return;
                setProbeByInstanceId((current) => ({ ...current, [instanceId]: "testing" }));
                void probeProvider({
                  environmentId,
                  input: { instanceId: TicketProviderInstanceId.make(instanceId) },
                }).then((result) => {
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
              }}
            >
              {probe === "testing" ? "Testing…" : "Test"}
            </Button>
            <Switch
              checked={instance.enabled !== false}
              aria-label={`Enable ${instance.displayName ?? instanceId}`}
              onCheckedChange={(checked) =>
                replaceInstance(instanceId, { ...instance, enabled: Boolean(checked) })
              }
            />
            <Button
              size="icon-sm"
              variant="ghost-muted"
              aria-label={`Remove ${instance.displayName ?? instanceId}`}
              onClick={() => {
                const next = { ...settings.ticketProviderInstances };
                delete next[TicketProviderInstanceId.make(instanceId)];
                updateSettings({ ticketProviderInstances: next });
              }}
            >
              <Trash2Icon />
            </Button>
          </div>
        );
      })}
      <AddTicketProviderDialog open={dialogOpen} onOpenChange={setDialogOpen} />
    </>
  );
}
