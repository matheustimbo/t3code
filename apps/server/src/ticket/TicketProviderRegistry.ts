import {
  type TicketProviderBindings,
  type TicketProviderInstanceConfig,
  type TicketProviderInstanceConfigMap,
  type TicketProviderInstanceId,
  type TicketProviderProbeResult,
} from "@t3tools/contracts";
import type { TicketReference, TicketTitleMetadata } from "@t3tools/shared/ticketTitles";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import { collectUint8StreamText } from "../stream/collectUint8StreamText.ts";

const LOOKUP_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 128 * 1024;

const PROVIDER_LABELS: Readonly<Record<string, string>> = {
  github: "GitHub",
  gitlab: "GitLab",
  "azure-devops": "Azure DevOps",
  bitbucket: "Bitbucket",
  jira: "Jira",
  clickup: "ClickUp",
};

export class TicketProviderResolveError extends Schema.TaggedErrorClass<TicketProviderResolveError>()(
  "TicketProviderResolveError",
  {
    driver: Schema.String,
    instanceId: Schema.optional(Schema.String),
    reason: Schema.Literals([
      "no-instance",
      "ambiguous-instance",
      "unsupported-driver",
      "unauthenticated",
      "request-failed",
      "invalid-response",
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    const instance = this.instanceId === undefined ? "" : ` (instance '${this.instanceId}')`;
    return `Ticket lookup for driver '${this.driver}'${instance} failed: ${this.reason}.`;
  }
}

class TicketProviderResponseTooLargeError extends Schema.TaggedErrorClass<TicketProviderResponseTooLargeError>()(
  "TicketProviderResponseTooLargeError",
  {},
) {
  override get message(): string {
    return `Ticket provider response exceeded ${MAX_RESPONSE_BYTES} bytes.`;
  }
}

class TicketProviderInvalidResponseError extends Schema.TaggedErrorClass<TicketProviderInvalidResponseError>()(
  "TicketProviderInvalidResponseError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Ticket provider returned an invalid response.";
  }
}

export interface TicketProviderResolveInput {
  readonly cwd: string;
  readonly reference: TicketReference;
  readonly instances: TicketProviderInstanceConfigMap;
  readonly bindings: TicketProviderBindings;
}

export interface TicketProviderProbeInput {
  readonly cwd: string;
  readonly instanceId: TicketProviderInstanceId;
  readonly instance: TicketProviderInstanceConfig;
}

interface ResolvedTicketFields {
  readonly title: string;
  readonly identifier?: string;
  readonly project?: string;
}

export class TicketProviderRegistry extends Context.Service<
  TicketProviderRegistry,
  {
    readonly resolve: (
      input: TicketProviderResolveInput,
    ) => Effect.Effect<TicketTitleMetadata, TicketProviderResolveError>;
    readonly probe: (input: TicketProviderProbeInput) => Effect.Effect<TicketProviderProbeResult>;
  }
>()("t3/ticket/TicketProviderRegistry") {}

function environmentForInstance(instance: TicketProviderInstanceConfig): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...Object.fromEntries((instance.environment ?? []).map((entry) => [entry.name, entry.value])),
  };
}

function environmentValue(
  instance: TicketProviderInstanceConfig,
  name: string,
): string | undefined {
  const value = instance.environment?.find((entry) => entry.name === name)?.value.trim();
  return value ? value : undefined;
}

function normalizedBaseUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    url.hash = "";
    url.search = "";
    url.pathname = url.pathname.replace(/\/$/u, "");
    return url;
  } catch {
    return undefined;
  }
}

function instanceMatchesReference(
  instance: TicketProviderInstanceConfig,
  reference: TicketReference,
): boolean {
  if (instance.enabled === false || instance.driver !== reference.driver) return false;
  const baseUrl = normalizedBaseUrl(instance.baseUrl);
  const referenceUrl = normalizedBaseUrl(reference.url);
  if (!baseUrl || !referenceUrl || baseUrl.host !== referenceUrl.host) return false;
  const basePath = baseUrl.pathname.replace(/\/$/u, "");
  return (
    basePath.length === 0 ||
    referenceUrl.pathname === basePath ||
    referenceUrl.pathname.startsWith(`${basePath}/`)
  );
}

function implicitInstance(
  reference: TicketReference,
): readonly [string, TicketProviderInstanceConfig] {
  const url = new URL(reference.url);
  const baseUrl =
    reference.driver === "jira"
      ? `${url.protocol}//${url.host}${url.pathname.slice(0, url.pathname.lastIndexOf("/browse/"))}`
      : `${url.protocol}//${url.host}`;
  return [
    String(reference.driver),
    {
      driver: reference.driver,
      baseUrl,
      displayName: PROVIDER_LABELS[reference.driver] ?? String(reference.driver),
      enabled: true,
      isDefault: true,
    },
  ];
}

function selectInstance(input: TicketProviderResolveInput):
  | {
      readonly _tag: "Selected";
      readonly instanceId: string;
      readonly instance: TicketProviderInstanceConfig;
    }
  | { readonly _tag: "Missing" | "Ambiguous" } {
  const matching = Object.entries(input.instances).filter(([, instance]) =>
    instanceMatchesReference(instance, input.reference),
  );
  const binding = input.bindings.find(
    (entry) =>
      entry.driver === input.reference.driver &&
      entry.host.toLowerCase() === input.reference.host.toLowerCase(),
  );
  if (binding) {
    const instance = input.instances[binding.instanceId];
    return instance && instanceMatchesReference(instance, input.reference)
      ? { _tag: "Selected", instanceId: binding.instanceId, instance }
      : { _tag: "Missing" };
  }

  if (matching.length === 0) {
    const [instanceId, instance] = implicitInstance(input.reference);
    return { _tag: "Selected", instanceId, instance };
  }
  const defaults = matching.filter(([, instance]) => instance.isDefault === true);
  const candidates = defaults.length > 0 ? defaults : matching;
  if (candidates.length !== 1) return { _tag: "Ambiguous" };
  const [instanceId, instance] = candidates[0]!;
  return { _tag: "Selected", instanceId, instance };
}

const GitHubConfig = Schema.Struct({ accountLogin: Schema.optional(Schema.String) });
const JiraConfig = Schema.Struct({
  email: Schema.optional(Schema.String),
  apiVersion: Schema.optional(Schema.Literals(["2", "3"])),
});
const ClickUpConfig = Schema.Struct({ workspaceId: Schema.optional(Schema.String) });

const GitHubIssueResponse = Schema.Struct({ title: Schema.String });
const GitLabIssueResponse = Schema.Struct({ title: Schema.String });
const BitbucketIssueResponse = Schema.Struct({ title: Schema.String });
const JiraIssueResponse = Schema.Struct({ fields: Schema.Struct({ summary: Schema.String }) });
const ClickUpTaskResponse = Schema.Struct({
  name: Schema.String,
  custom_id: Schema.optional(Schema.NullOr(Schema.String)),
  list: Schema.optional(Schema.Struct({ name: Schema.optional(Schema.String) })),
});
const decodeGitHubConfig = Schema.decodeUnknownEffect(GitHubConfig);
const decodeJiraConfig = Schema.decodeUnknownEffect(JiraConfig);
const decodeClickUpConfig = Schema.decodeUnknownEffect(ClickUpConfig);
const decodeGitHubIssueJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(GitHubIssueResponse),
);
const decodeGitLabIssueJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(GitLabIssueResponse),
);
const decodeBitbucketIssueJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(BitbucketIssueResponse),
);
const decodeJiraIssueJson = Schema.decodeUnknownEffect(Schema.fromJsonString(JiraIssueResponse));
const decodeClickUpTaskJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ClickUpTaskResponse),
);
const isTicketProviderResolveError = Schema.is(TicketProviderResolveError);
const isTicketProviderInvalidResponseError = Schema.is(TicketProviderInvalidResponseError);

const decodeTicketResponse = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, TicketProviderInvalidResponseError, R> =>
  effect.pipe(
    Effect.mapError(
      (cause) =>
        new TicketProviderInvalidResponseError({
          cause,
        }),
    ),
  );

export const make = Effect.gen(function* () {
  const vcsProcess = yield* VcsProcess.VcsProcess;
  const httpClient = yield* HttpClient.HttpClient;

  const runText = Effect.fn("TicketProviderRegistry.runText")(function* (input: {
    readonly command: string;
    readonly args: ReadonlyArray<string>;
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
  }) {
    const output = yield* vcsProcess.run({
      operation: "resolveTicket",
      command: input.command,
      args: input.args,
      cwd: input.cwd,
      env: input.env,
      timeoutMs: LOOKUP_TIMEOUT_MS,
      maxOutputBytes: MAX_RESPONSE_BYTES,
    });
    return output.stdout;
  });

  const executeText = Effect.fn("TicketProviderRegistry.executeText")(function* (
    request: HttpClientRequest.HttpClientRequest,
  ) {
    return yield* Effect.gen(function* () {
      const response = yield* httpClient
        .execute(request.pipe(HttpClientRequest.acceptJson))
        .pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }));
      const success = yield* HttpClientResponse.filterStatusOk(response);
      const collected = yield* collectUint8StreamText({
        stream: success.stream,
        maxBytes: MAX_RESPONSE_BYTES,
      });
      if (collected.truncated) {
        return yield* new TicketProviderResponseTooLargeError();
      }
      return collected.text;
    }).pipe(Effect.timeout(Duration.millis(LOOKUP_TIMEOUT_MS)));
  });

  const resolveGitHub = Effect.fn("TicketProviderRegistry.resolveGitHub")(function* (input: {
    readonly cwd: string;
    readonly reference: TicketReference;
    readonly instance: TicketProviderInstanceConfig;
  }) {
    const config = yield* decodeGitHubConfig(input.instance.config ?? {});
    const env = environmentForInstance(input.instance);
    if (config.accountLogin?.trim()) {
      const token = yield* vcsProcess.run({
        operation: "resolveTicketAccount",
        command: "gh",
        args: [
          "auth",
          "token",
          "--hostname",
          input.reference.host,
          "--user",
          config.accountLogin.trim(),
        ],
        env,
        cwd: input.cwd,
        timeoutMs: LOOKUP_TIMEOUT_MS,
        maxOutputBytes: 16 * 1024,
      });
      const value = token.stdout.trim();
      if (!value) {
        return yield* new TicketProviderResolveError({
          driver: "github",
          reason: "unauthenticated",
        });
      }
      env[input.reference.host === "github.com" ? "GH_TOKEN" : "GH_ENTERPRISE_TOKEN"] = value;
      env.GH_HOST = input.reference.host;
    }
    const stdout = yield* runText({
      command: "gh",
      args: ["issue", "view", input.reference.url, "--json", "title"],
      cwd: input.cwd,
      env,
    });
    const issue = yield* decodeTicketResponse(decodeGitHubIssueJson(stdout));
    return { title: issue.title };
  });

  const resolveGitLab = Effect.fn("TicketProviderRegistry.resolveGitLab")(function* (input: {
    readonly cwd: string;
    readonly reference: TicketReference;
    readonly instance: TicketProviderInstanceConfig;
  }) {
    const stdout = yield* runText({
      command: "glab",
      args: [
        "api",
        "--hostname",
        input.reference.host,
        `projects/${encodeURIComponent(input.reference.project)}/issues/${input.reference.resourceId}`,
      ],
      cwd: input.cwd,
      env: environmentForInstance(input.instance),
    });
    const issue = yield* decodeTicketResponse(decodeGitLabIssueJson(stdout));
    return { title: issue.title };
  });

  const resolveAzureDevOps = Effect.fn("TicketProviderRegistry.resolveAzureDevOps")(
    function* (input: {
      readonly cwd: string;
      readonly reference: TicketReference;
      readonly instance: TicketProviderInstanceConfig;
    }) {
      const organization = input.reference.project.split("/")[0]!;
      const configuredBaseUrl = input.instance.baseUrl.replace(/\/$/u, "");
      const configuredUrl = new URL(configuredBaseUrl);
      const organizationUrl =
        input.reference.host === "dev.azure.com" && configuredUrl.pathname === "/"
          ? `${configuredBaseUrl}/${organization}`
          : configuredBaseUrl;
      const output = yield* vcsProcess.run({
        operation: "resolveTicket",
        command: "az",
        args: [
          "boards",
          "work-item",
          "show",
          "--id",
          input.reference.resourceId,
          "--organization",
          organizationUrl,
          "--detect",
          "false",
          "--fields",
          "System.Title",
          "--query",
          'fields."System.Title"',
          "-o",
          "tsv",
        ],
        cwd: input.cwd,
        env: environmentForInstance(input.instance),
        timeoutMs: LOOKUP_TIMEOUT_MS,
        maxOutputBytes: MAX_RESPONSE_BYTES,
      });
      return { title: output.stdout.trim() };
    },
  );

  const resolveBitbucket = Effect.fn("TicketProviderRegistry.resolveBitbucket")(function* (input: {
    readonly reference: TicketReference;
    readonly instance: TicketProviderInstanceConfig;
  }) {
    const [workspace, repository] = input.reference.project.split("/");
    if (!workspace || !repository) {
      return yield* new TicketProviderResolveError({
        driver: "bitbucket",
        reason: "request-failed",
      });
    }
    let request = HttpClientRequest.get(
      `https://api.bitbucket.org/2.0/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repository)}/issues/${encodeURIComponent(input.reference.resourceId)}`,
    );
    const accessToken = environmentValue(input.instance, "T3CODE_BITBUCKET_ACCESS_TOKEN");
    const email = environmentValue(input.instance, "T3CODE_BITBUCKET_EMAIL");
    const apiToken = environmentValue(input.instance, "T3CODE_BITBUCKET_API_TOKEN");
    if (accessToken) request = request.pipe(HttpClientRequest.bearerToken(accessToken));
    else if (email && apiToken)
      request = request.pipe(HttpClientRequest.basicAuth(email, apiToken));
    const issue = yield* decodeTicketResponse(
      decodeBitbucketIssueJson(yield* executeText(request)),
    );
    return { title: issue.title };
  });

  const resolveJira = Effect.fn("TicketProviderRegistry.resolveJira")(function* (input: {
    readonly reference: TicketReference;
    readonly instance: TicketProviderInstanceConfig;
  }) {
    const config = yield* decodeJiraConfig(input.instance.config ?? {});
    const baseUrl = input.instance.baseUrl.replace(/\/$/u, "");
    const apiVersion =
      config.apiVersion ?? (input.reference.host.endsWith(".atlassian.net") ? "3" : "2");
    let request = HttpClientRequest.get(
      `${baseUrl}/rest/api/${apiVersion}/issue/${encodeURIComponent(input.reference.resourceId)}?fields=summary`,
    );
    const token = environmentValue(input.instance, "JIRA_API_TOKEN");
    const pat = environmentValue(input.instance, "JIRA_PAT");
    if (config.email?.trim() && token) {
      request = request.pipe(HttpClientRequest.basicAuth(config.email.trim(), token));
    } else if (pat ?? token) {
      request = request.pipe(HttpClientRequest.bearerToken((pat ?? token)!));
    }
    const issue = yield* decodeTicketResponse(decodeJiraIssueJson(yield* executeText(request)));
    return { title: issue.fields.summary };
  });

  const resolveClickUp = Effect.fn("TicketProviderRegistry.resolveClickUp")(function* (input: {
    readonly reference: TicketReference;
    readonly instance: TicketProviderInstanceConfig;
  }) {
    const config = yield* decodeClickUpConfig(input.instance.config ?? {});
    const token = environmentValue(input.instance, "CLICKUP_API_TOKEN");
    if (!token) {
      return yield* new TicketProviderResolveError({
        driver: "clickup",
        reason: "unauthenticated",
      });
    }
    const custom = input.reference.resourceId.includes("-") && config.workspaceId?.trim();
    const query = custom
      ? `?custom_task_ids=true&team_id=${encodeURIComponent(config.workspaceId!.trim())}`
      : "";
    const task = yield* decodeTicketResponse(
      decodeClickUpTaskJson(
        yield* executeText(
          HttpClientRequest.get(
            `https://api.clickup.com/api/v2/task/${encodeURIComponent(input.reference.resourceId)}${query}`,
          ).pipe(HttpClientRequest.setHeader("Authorization", token)),
        ),
      ),
    );
    return {
      title: task.name,
      ...(task.custom_id ? { identifier: task.custom_id } : {}),
      ...(task.list?.name ? { project: task.list.name } : {}),
    };
  });

  const inFlight = new Map<
    string,
    Deferred.Deferred<TicketTitleMetadata, TicketProviderResolveError>
  >();

  const resolveSelected = Effect.fn("TicketProviderRegistry.resolveSelected")(function* (
    input: TicketProviderResolveInput,
    selected: Extract<ReturnType<typeof selectInstance>, { readonly _tag: "Selected" }>,
  ) {
    const mapResolveError = <A, E, R>(
      effect: Effect.Effect<A, E, R>,
    ): Effect.Effect<A, TicketProviderResolveError, R> =>
      effect.pipe(
        Effect.mapError((cause) =>
          isTicketProviderResolveError(cause)
            ? cause
            : new TicketProviderResolveError({
                driver: selected.instance.driver,
                instanceId: selected.instanceId,
                reason: isTicketProviderInvalidResponseError(cause)
                  ? "invalid-response"
                  : "request-failed",
                cause: isTicketProviderInvalidResponseError(cause) ? cause.cause : cause,
              }),
        ),
      );

    let resolved: ResolvedTicketFields;
    switch (String(selected.instance.driver)) {
      case "github":
        resolved = yield* mapResolveError(resolveGitHub({ ...input, instance: selected.instance }));
        break;
      case "gitlab":
        resolved = yield* mapResolveError(resolveGitLab({ ...input, instance: selected.instance }));
        break;
      case "azure-devops":
        resolved = yield* mapResolveError(
          resolveAzureDevOps({ ...input, instance: selected.instance }),
        );
        break;
      case "bitbucket":
        resolved = yield* mapResolveError(
          resolveBitbucket({ ...input, instance: selected.instance }),
        );
        break;
      case "jira":
        resolved = yield* mapResolveError(resolveJira({ ...input, instance: selected.instance }));
        break;
      case "clickup":
        resolved = yield* mapResolveError(
          resolveClickUp({ ...input, instance: selected.instance }),
        );
        break;
      default:
        return yield* new TicketProviderResolveError({
          driver: selected.instance.driver,
          instanceId: selected.instanceId,
          reason: "unsupported-driver",
        });
    }

    return {
      title: resolved.title,
      identifier: resolved.identifier ?? input.reference.identifier,
      provider: PROVIDER_LABELS[selected.instance.driver] ?? String(selected.instance.driver),
      project: resolved.project ?? input.reference.project,
    };
  });

  const resolve: TicketProviderRegistry["Service"]["resolve"] = Effect.fn(
    "TicketProviderRegistry.resolve",
  )(function* (input) {
    const selected = selectInstance(input);
    if (selected._tag !== "Selected") {
      return yield* new TicketProviderResolveError({
        driver: input.reference.driver,
        reason: selected._tag === "Ambiguous" ? "ambiguous-instance" : "no-instance",
      });
    }

    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const key = `${selected.instanceId}:${input.reference.driver}:${input.reference.url}`;
        const pending = inFlight.get(key);
        if (pending) {
          return yield* restore(Deferred.await(pending));
        }
        const deferred = Deferred.makeUnsafe<TicketTitleMetadata, TicketProviderResolveError>();
        inFlight.set(key, deferred);
        const exit = yield* Effect.exit(resolveSelected(input, selected));
        yield* Deferred.done(deferred, exit);
        inFlight.delete(key);
        return yield* Deferred.await(deferred);
      }),
    );
  });

  const probe: TicketProviderRegistry["Service"]["probe"] = Effect.fn(
    "TicketProviderRegistry.probe",
  )(function* (input) {
    const driver = String(input.instance.driver);
    if (!Object.hasOwn(PROVIDER_LABELS, driver)) {
      return {
        instanceId: input.instanceId,
        availability: "unknown_driver",
        detail: `No ${driver} ticket driver is registered in this build.`,
      };
    }

    const probeEffect = Effect.gen(function* () {
      const env = environmentForInstance(input.instance);
      const baseUrl = input.instance.baseUrl.replace(/\/$/u, "");
      const host = new URL(baseUrl).host;
      switch (driver) {
        case "github": {
          const config = yield* decodeGitHubConfig(input.instance.config ?? {});
          yield* vcsProcess.run({
            operation: "probeTicketProvider",
            command: "gh",
            args: config.accountLogin?.trim()
              ? ["auth", "token", "--hostname", host, "--user", config.accountLogin.trim()]
              : ["auth", "status", "--hostname", host],
            cwd: input.cwd,
            env,
            timeoutMs: LOOKUP_TIMEOUT_MS,
            maxOutputBytes: 16 * 1024,
          });
          break;
        }
        case "gitlab":
          yield* runText({
            command: "glab",
            args: ["auth", "status", "--hostname", host],
            cwd: input.cwd,
            env,
          });
          break;
        case "azure-devops": {
          const configuredUrl = new URL(baseUrl);
          const detectOrganization =
            configuredUrl.hostname === "dev.azure.com" && configuredUrl.pathname === "/";
          yield* runText({
            command: "az",
            args: [
              "devops",
              "project",
              "list",
              ...(detectOrganization ? [] : ["--organization", baseUrl]),
              "--top",
              "1",
              "--output",
              "none",
              "--detect",
              detectOrganization ? "true" : "false",
            ],
            cwd: input.cwd,
            env,
          });
          break;
        }
        case "bitbucket": {
          let request = HttpClientRequest.get("https://api.bitbucket.org/2.0/user");
          const accessToken = environmentValue(input.instance, "T3CODE_BITBUCKET_ACCESS_TOKEN");
          const email = environmentValue(input.instance, "T3CODE_BITBUCKET_EMAIL");
          const apiToken = environmentValue(input.instance, "T3CODE_BITBUCKET_API_TOKEN");
          if (accessToken) request = request.pipe(HttpClientRequest.bearerToken(accessToken));
          else if (email && apiToken) {
            request = request.pipe(HttpClientRequest.basicAuth(email, apiToken));
          }
          yield* executeText(request);
          break;
        }
        case "jira": {
          const config = yield* decodeJiraConfig(input.instance.config ?? {});
          let request = HttpClientRequest.get(`${baseUrl}/rest/api/2/myself`);
          const token = environmentValue(input.instance, "JIRA_API_TOKEN");
          const pat = environmentValue(input.instance, "JIRA_PAT");
          if (config.email?.trim() && token) {
            request = request.pipe(HttpClientRequest.basicAuth(config.email.trim(), token));
          } else if (pat ?? token) {
            request = request.pipe(HttpClientRequest.bearerToken((pat ?? token)!));
          }
          yield* executeText(request);
          break;
        }
        case "clickup": {
          const token = environmentValue(input.instance, "CLICKUP_API_TOKEN");
          if (!token) {
            return yield* new TicketProviderResolveError({
              driver,
              instanceId: input.instanceId,
              reason: "unauthenticated",
            });
          }
          yield* executeText(
            HttpClientRequest.get("https://api.clickup.com/api/v2/user").pipe(
              HttpClientRequest.setHeader("Authorization", token),
            ),
          );
          break;
        }
      }
    });

    return yield* probeEffect.pipe(
      Effect.matchCause({
        onFailure: () => ({
          instanceId: input.instanceId,
          availability: "unavailable" as const,
          detail: "Connection test failed. Check the local CLI login or configured credential.",
        }),
        onSuccess: () => ({
          instanceId: input.instanceId,
          availability: "available" as const,
          detail: "Connection test succeeded.",
        }),
      }),
    );
  });

  return TicketProviderRegistry.of({ resolve, probe });
});

export const layer = Layer.effect(TicketProviderRegistry, make);
