import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

import { parseGrokUsageWindows, prefixUsageWindowsWithAccount } from "./polledUsageLimits.ts";
import { ProviderUsageLimitsReadError } from "./providerUsageLimitPolling.ts";
import { makeUsageLimits } from "./providerUsageLimits.ts";

const CliProxyAuthFile = Schema.Struct({
  auth_index: Schema.String,
  name: Schema.String,
  provider: Schema.optional(Schema.String),
  type: Schema.optional(Schema.String),
  label: Schema.optional(Schema.String),
  email: Schema.optional(Schema.String),
  disabled: Schema.optional(Schema.Union([Schema.Boolean, Schema.Number, Schema.String])),
  metadata: Schema.optional(Schema.Unknown),
  attributes: Schema.optional(Schema.Unknown),
  sub: Schema.optional(Schema.String),
  subject: Schema.optional(Schema.String),
  user_id: Schema.optional(Schema.String),
  userId: Schema.optional(Schema.String),
  oauth: Schema.optional(Schema.Unknown),
  user: Schema.optional(Schema.Unknown),
});
const decodeCliProxyAuthFiles = Schema.decodeUnknownOption(
  Schema.Struct({ files: Schema.Array(CliProxyAuthFile) }),
);

const CliProxyApiCallResponse = Schema.Struct({
  status_code: Schema.Number,
  body: Schema.String,
});
const decodeCliProxyApiCallResponse = Schema.decodeUnknownOption(CliProxyApiCallResponse);
const decodeJsonBody = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

const safeReadError = (message: string) => new ProviderUsageLimitsReadError({ message });

interface CliProxyManagementConfig {
  readonly apiBaseUrl: string;
  readonly dashboardUrl: string;
  readonly key: string;
}

const parseUrl = Option.liftThrowable((value: string) => new URL(value));

export function resolveCliProxyManagementConfig(
  environment: NodeJS.ProcessEnv,
): CliProxyManagementConfig | undefined {
  const key = environment.CLIPROXYAPI_MANAGEMENT_KEY?.trim();
  if (!key) return undefined;

  const explicitUrl = environment.CLIPROXYAPI_MANAGEMENT_URL?.trim();
  const inferenceUrl = [
    environment.ANTHROPIC_BASE_URL,
    environment.OPENAI_BASE_URL,
    environment.CODEX_BASE_URL,
    environment.XAI_BASE_URL,
    environment.GROK_BASE_URL,
  ]
    .map((value) => value?.trim())
    .find((value): value is string => Boolean(value));
  const parsed = parseUrl(explicitUrl || inferenceUrl || "");
  if (Option.isNone(parsed)) return undefined;

  const url = parsed.value;
  url.search = "";
  url.hash = "";
  const explicitManagementIndex = url.pathname.indexOf("/v0/management");
  if (explicitUrl) {
    url.pathname =
      explicitManagementIndex >= 0
        ? url.pathname.slice(0, explicitManagementIndex + "/v0/management".length)
        : `${url.pathname.replace(/\/+$/u, "")}/v0/management`;
  } else {
    url.pathname = "/v0/management";
  }
  const apiBaseUrl = url.toString().replace(/\/+$/u, "");
  const dashboardUrl = `${apiBaseUrl.slice(0, -"/v0/management".length)}/management.html#/quota`;
  return { apiBaseUrl, dashboardUrl, key };
}

function cliProxyAuthProvider(authFile: typeof CliProxyAuthFile.Type): string {
  const provider = (authFile.provider ?? authFile.type ?? "")
    .trim()
    .toLowerCase()
    .replace(/_/gu, "-");
  return provider === "x-ai" || provider === "grok" ? "xai" : provider;
}

function parseCliProxyGrokAuthFiles(input: unknown): ReadonlyArray<typeof CliProxyAuthFile.Type> {
  const decoded = decodeCliProxyAuthFiles(input);
  if (Option.isNone(decoded)) return [];
  return decoded.value.files.filter((authFile) => cliProxyAuthProvider(authFile) === "xai");
}

const executePrivateJson = Effect.fn("providerUsageLimits.executePrivateJson")(function* (
  request: HttpClientRequest.HttpClientRequest,
  providerLabel: string,
) {
  const client = yield* HttpClient.HttpClient;
  const response = yield* client.execute(request).pipe(
    Effect.timeout("10 seconds"),
    Effect.mapError(() => safeReadError(`${providerLabel} limits request failed.`)),
  );
  if (response.status < 200 || response.status >= 300) {
    return yield* safeReadError(
      response.status === 401 || response.status === 403
        ? `${providerLabel} rejected the local session. Sign in again and retry.`
        : `${providerLabel} limits request returned HTTP ${response.status}.`,
    );
  }
  return yield* response.json.pipe(
    Effect.mapError(() => safeReadError(`${providerLabel} returned an unreadable limits payload.`)),
  );
});

function unknownRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function cliProxyXaiUserId(authFile: typeof CliProxyAuthFile.Type): string | undefined {
  const metadata = unknownRecord(authFile.metadata);
  const attributes = unknownRecord(authFile.attributes);
  const oauth =
    unknownRecord(authFile.oauth) ??
    unknownRecord(metadata?.oauth) ??
    unknownRecord(attributes?.oauth);
  const user =
    unknownRecord(authFile.user) ??
    unknownRecord(metadata?.user) ??
    unknownRecord(attributes?.user);
  return [
    authFile.sub,
    authFile.subject,
    authFile.user_id,
    authFile.userId,
    metadata?.sub,
    metadata?.subject,
    metadata?.user_id,
    metadata?.userId,
    attributes?.sub,
    attributes?.subject,
    attributes?.user_id,
    attributes?.userId,
    oauth?.sub,
    oauth?.subject,
    user?.sub,
    user?.id,
  ]
    .map(readString)
    .find((value): value is string => Boolean(value));
}

function cliProxyAccountLabel(authFile: typeof CliProxyAuthFile.Type): string {
  return authFile.label?.trim() || authFile.email?.trim() || authFile.name.trim();
}

function cliProxyAccountDisabled(authFile: typeof CliProxyAuthFile.Type): boolean {
  if (typeof authFile.disabled === "boolean") return authFile.disabled;
  if (typeof authFile.disabled === "number") return authFile.disabled !== 0;
  return authFile.disabled?.trim().toLowerCase() === "true";
}

const executeCliProxyApiCall = Effect.fn("providerUsageLimits.executeCliProxyApiCall")(
  function* (input: {
    readonly config: CliProxyManagementConfig;
    readonly authFile: typeof CliProxyAuthFile.Type;
    readonly providerLabel: string;
    readonly url: string;
    readonly header: Readonly<Record<string, string>>;
  }) {
    const payload = yield* executePrivateJson(
      HttpClientRequest.post(`${input.config.apiBaseUrl}/api-call`).pipe(
        HttpClientRequest.bearerToken(input.config.key),
        HttpClientRequest.acceptJson,
        HttpClientRequest.bodyJsonUnsafe({
          auth_index: input.authFile.auth_index,
          method: "GET",
          url: input.url,
          header: input.header,
        }),
      ),
      "CLIProxyAPI",
    );
    const apiCall = decodeCliProxyApiCallResponse(payload);
    if (Option.isNone(apiCall)) {
      return yield* safeReadError("CLIProxyAPI returned an unreadable account response.");
    }
    const label = cliProxyAccountLabel(input.authFile);
    if (apiCall.value.status_code < 200 || apiCall.value.status_code >= 300) {
      return yield* safeReadError(
        `${input.providerLabel} account ${label} returned HTTP ${apiCall.value.status_code}.`,
      );
    }
    const body = decodeJsonBody(apiCall.value.body);
    if (Option.isNone(body)) {
      return yield* safeReadError(
        `${input.providerLabel} account ${label} returned unreadable limits.`,
      );
    }
    return body.value;
  },
);

const readCliProxyUsageLimits = Effect.fn("readCliProxyUsageLimits")(function* (input: {
  readonly config: CliProxyManagementConfig;
  readonly providerLabel: string;
  readonly readAccount: (authFile: typeof CliProxyAuthFile.Type) => Effect.Effect<
    {
      readonly windows: ReadonlyArray<ServerProviderUsageWindow>;
      readonly planLabel?: string | undefined;
    },
    ProviderUsageLimitsReadError,
    HttpClient.HttpClient
  >;
}) {
  const authPayload = yield* executePrivateJson(
    HttpClientRequest.get(`${input.config.apiBaseUrl}/auth-files`).pipe(
      HttpClientRequest.bearerToken(input.config.key),
      HttpClientRequest.acceptJson,
    ),
    "CLIProxyAPI",
  );
  const authFiles = parseCliProxyGrokAuthFiles(authPayload);
  if (authFiles.length === 0) {
    return yield* safeReadError(
      `CLIProxyAPI did not report any ${input.providerLabel} OAuth accounts.`,
    );
  }

  const checkedAtInstant = yield* DateTime.now;
  const checkedAt = DateTime.formatIso(checkedAtInstant);
  const windowGroups = yield* Effect.forEach(
    authFiles,
    (authFile) =>
      Effect.gen(function* () {
        const label = cliProxyAccountLabel(authFile);
        if (cliProxyAccountDisabled(authFile)) return [];
        const accountUsage = yield* input.readAccount(authFile);
        return prefixUsageWindowsWithAccount(label, accountUsage.windows);
      }).pipe(
        Effect.catch((error) =>
          Effect.logDebug(`${input.providerLabel} usage read failed for one account`, {
            account: cliProxyAccountLabel(authFile),
            message: error.message,
          }).pipe(Effect.as([] as ReadonlyArray<ServerProviderUsageWindow>)),
        ),
      ),
    { concurrency: 3 },
  );

  const windows = windowGroups.flat();
  if (windows.length === 0) {
    return yield* safeReadError(
      `No ${input.providerLabel} account behind CLIProxyAPI reported subscription windows.`,
    );
  }
  return makeUsageLimits({ checkedAt, windows });
});

export const readCliProxyGrokUsageLimits = Effect.fn("readCliProxyGrokUsageLimits")(function* (
  environment: NodeJS.ProcessEnv,
) {
  const config = resolveCliProxyManagementConfig(environment);
  if (!config) {
    return yield* safeReadError(
      "Set CLIPROXYAPI_MANAGEMENT_URL or a provider base URL to read CLIProxyAPI accounts.",
    );
  }
  return yield* readCliProxyUsageLimits({
    config,
    providerLabel: "Grok",
    readAccount: (authFile) => {
      const userId = cliProxyXaiUserId(authFile);
      const header = {
        Authorization: "Bearer $TOKEN$",
        "x-xai-token-auth": "xai-grok-cli",
        "x-grok-client-version": "0.2.91",
        accept: "*/*",
        "user-agent": "grok-pager/0.2.91 grok-shell/0.2.91 (macos; aarch64)",
        ...(userId ? { "x-userid": userId } : {}),
      };
      const request = (url: string) =>
        executeCliProxyApiCall({
          config,
          authFile,
          providerLabel: "Grok",
          url,
          header,
        });
      return Effect.all(
        [
          request("https://cli-chat-proxy.grok.com/v1/billing?format=credits").pipe(Effect.result),
          request("https://cli-chat-proxy.grok.com/v1/billing").pipe(Effect.result),
        ],
        { concurrency: 2 },
      ).pipe(
        Effect.flatMap((results) => {
          const windows = results.flatMap((result) =>
            Result.isSuccess(result) ? parseGrokUsageWindows(result.success) : [],
          );
          const deduplicated = [...new Map(windows.map((window) => [window.id, window])).values()];
          if (deduplicated.length > 0) return Effect.succeed({ windows: deduplicated });
          const failure = results.find(Result.isFailure);
          return Effect.fail(
            failure?.failure ??
              safeReadError("Grok account returned no subscription billing windows."),
          );
        }),
      );
    },
  });
});
