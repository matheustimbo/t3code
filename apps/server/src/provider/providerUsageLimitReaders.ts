import type {
  ClaudeSettings,
  CursorSettings,
  OpenCodeSettings,
  ServerProviderUsageLimitWindow,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

import {
  makePooledUsageLimitsSnapshot,
  makeUsageLimitsSnapshot,
  makeUsageLimitsAccount,
  makeUnavailableUsageLimitsAccount,
  parseCliProxyCodexUsageWindows,
  parseClaudeUsageWindows,
  parseCursorUsageWindows,
  parseGrokUsageWindows,
  parseOpenCodeUsageWindows,
  ProviderUsageLimitsReadError,
} from "./providerUsageLimits.ts";
import { expandHomePath } from "../pathExpansion.ts";

const ClaudeCredentials = Schema.Struct({
  claudeAiOauth: Schema.Struct({
    accessToken: Schema.String,
  }),
});
const decodeClaudeCredentials = Schema.decodeUnknownOption(
  Schema.fromJsonString(ClaudeCredentials),
);

const CliProxyAuthFile = Schema.Struct({
  auth_index: Schema.String,
  name: Schema.String,
  provider: Schema.optional(Schema.String),
  type: Schema.optional(Schema.String),
  label: Schema.optional(Schema.String),
  email: Schema.optional(Schema.String),
  disabled: Schema.optional(Schema.Union([Schema.Boolean, Schema.Number, Schema.String])),
  id_token: Schema.optional(Schema.Unknown),
  chatgpt_account_id: Schema.optional(Schema.String),
  chatgptAccountId: Schema.optional(Schema.String),
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

const CursorCredentials = Schema.Union([
  Schema.Struct({ accessToken: Schema.String }),
  Schema.Struct({ access_token: Schema.String }),
  Schema.Struct({ auth: Schema.Struct({ accessToken: Schema.String }) }),
]);
const decodeCursorCredentials = Schema.decodeUnknownOption(
  Schema.fromJsonString(CursorCredentials),
);

function cursorCredentialToken(value: typeof CursorCredentials.Type): string {
  if ("accessToken" in value) return value.accessToken;
  if ("access_token" in value) return value.access_token;
  return value.auth.accessToken;
}

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

type CliProxyQuotaProvider = "claude" | "codex" | "xai";

function cliProxyAuthProvider(authFile: typeof CliProxyAuthFile.Type): string {
  const provider = (authFile.provider ?? authFile.type ?? "")
    .trim()
    .toLowerCase()
    .replace(/_/gu, "-");
  return provider === "x-ai" || provider === "grok" ? "xai" : provider;
}

export function parseCliProxyAuthFiles(
  input: unknown,
  provider: CliProxyQuotaProvider,
): ReadonlyArray<typeof CliProxyAuthFile.Type> {
  const decoded = decodeCliProxyAuthFiles(input);
  if (Option.isNone(decoded)) return [];
  return decoded.value.files.filter((authFile) => cliProxyAuthProvider(authFile) === provider);
}

export function parseCliProxyClaudeAuthFiles(
  input: unknown,
): ReadonlyArray<typeof CliProxyAuthFile.Type> {
  return parseCliProxyAuthFiles(input, "claude");
}

const readFirstToken = Effect.fn("providerUsageLimits.readFirstToken")(function* (input: {
  readonly paths: ReadonlyArray<string>;
  readonly decode: (contents: string) => Option.Option<string>;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  for (const candidate of input.paths) {
    const contents = yield* fileSystem.readFileString(candidate).pipe(Effect.option);
    if (Option.isNone(contents)) continue;
    const token = input.decode(contents.value);
    if (Option.isSome(token) && token.value.trim().length > 0) return token.value.trim();
  }
  return yield* safeReadError("No compatible local provider credential was found.");
});

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

function decodeJwtPayload(value: unknown): Readonly<Record<string, unknown>> | undefined {
  const token = readString(value);
  if (!token) return unknownRecord(value);
  const encoded = token.split(".")[1];
  if (!encoded) return undefined;
  try {
    const normalized = encoded.replace(/-/gu, "+").replace(/_/gu, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    return unknownRecord(JSON.parse(globalThis.atob(padded)));
  } catch {
    return undefined;
  }
}

function cliProxyCodexAccountId(authFile: typeof CliProxyAuthFile.Type): string | undefined {
  const metadata = unknownRecord(authFile.metadata);
  const attributes = unknownRecord(authFile.attributes);
  const tokens = [authFile.id_token, metadata?.id_token, attributes?.id_token];
  for (const token of tokens) {
    const payload = decodeJwtPayload(token);
    const auth = unknownRecord(payload?.["https://api.openai.com/auth"]) ?? payload;
    const accountId = readString(auth?.chatgpt_account_id ?? auth?.chatgptAccountId);
    if (accountId) return accountId;
  }
  return authFile.chatgpt_account_id?.trim() || authFile.chatgptAccountId?.trim() || undefined;
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
    readonly method?: "GET" | "POST";
    readonly url: string;
    readonly header: Readonly<Record<string, string>>;
    readonly data?: string | undefined;
  }) {
    const payload = yield* executePrivateJson(
      HttpClientRequest.post(`${input.config.apiBaseUrl}/api-call`).pipe(
        HttpClientRequest.bearerToken(input.config.key),
        HttpClientRequest.acceptJson,
        HttpClientRequest.bodyJsonUnsafe({
          auth_index: input.authFile.auth_index,
          method: input.method ?? "GET",
          url: input.url,
          header: input.header,
          ...(input.data === undefined ? {} : { data: input.data }),
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
  readonly provider: CliProxyQuotaProvider;
  readonly providerLabel: string;
  readonly readWindows: (
    authFile: typeof CliProxyAuthFile.Type,
    checkedAtMs: number,
  ) => Effect.Effect<
    ReadonlyArray<ServerProviderUsageLimitWindow>,
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
  const authFiles = parseCliProxyAuthFiles(authPayload, input.provider);
  if (authFiles.length === 0) {
    return yield* safeReadError(
      `CLIProxyAPI did not report any ${input.providerLabel} OAuth accounts.`,
    );
  }

  const checkedAtInstant = yield* DateTime.now;
  const checkedAt = DateTime.formatIso(checkedAtInstant);
  const checkedAtMs = DateTime.toEpochMillis(checkedAtInstant);
  const accounts = yield* Effect.forEach(
    authFiles,
    (authFile) =>
      Effect.gen(function* () {
        const label = cliProxyAccountLabel(authFile);
        if (cliProxyAccountDisabled(authFile)) {
          return makeUnavailableUsageLimitsAccount({
            id: authFile.auth_index,
            label,
            ...(authFile.email?.trim() ? { email: authFile.email.trim() } : {}),
            source: "cliproxyapi-management",
            support: "experimental",
            checkedAt,
            status: "disabled",
            message: "Disabled in CLIProxyAPI.",
            dashboardUrl: input.config.dashboardUrl,
          });
        }
        const windows = yield* input.readWindows(authFile, checkedAtMs);
        if (windows.length === 0) {
          return yield* safeReadError(
            `${input.providerLabel} account ${label} returned no subscription windows.`,
          );
        }
        return makeUsageLimitsAccount({
          id: authFile.auth_index,
          label,
          ...(authFile.email?.trim() ? { email: authFile.email.trim() } : {}),
          source: "cliproxyapi-management",
          support: "experimental",
          checkedAt,
          windows,
          dashboardUrl: input.config.dashboardUrl,
        });
      }).pipe(
        Effect.catch((error) =>
          Effect.succeed(
            makeUnavailableUsageLimitsAccount({
              id: authFile.auth_index,
              label: cliProxyAccountLabel(authFile),
              ...(authFile.email?.trim() ? { email: authFile.email.trim() } : {}),
              source: "cliproxyapi-management",
              support: "experimental",
              checkedAt,
              status: "error",
              message: error.message,
              dashboardUrl: input.config.dashboardUrl,
            }),
          ),
        ),
      ),
    { concurrency: 3 },
  );
  return makePooledUsageLimitsSnapshot({
    source: "cliproxyapi-management",
    support: "experimental",
    checkedAt,
    accounts,
    dashboardUrl: input.config.dashboardUrl,
  });
});

const readCliProxyClaudeUsageLimits = Effect.fn("readCliProxyClaudeUsageLimits")(function* (
  config: CliProxyManagementConfig,
) {
  return yield* readCliProxyUsageLimits({
    config,
    provider: "claude",
    providerLabel: "Claude",
    readWindows: (authFile) =>
      executeCliProxyApiCall({
        config,
        authFile,
        providerLabel: "Claude",
        url: "https://api.anthropic.com/api/oauth/usage",
        header: {
          Authorization: "Bearer $TOKEN$",
          "Content-Type": "application/json",
          "anthropic-beta": "oauth-2025-04-20",
        },
      }).pipe(Effect.map(parseClaudeUsageWindows)),
  });
});

export const readCliProxyCodexUsageLimits = Effect.fn("readCliProxyCodexUsageLimits")(function* (
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
    provider: "codex",
    providerLabel: "Codex",
    readWindows: (authFile, checkedAtMs) => {
      const accountId = cliProxyCodexAccountId(authFile);
      return executeCliProxyApiCall({
        config,
        authFile,
        providerLabel: "Codex",
        url: "https://chatgpt.com/backend-api/wham/usage",
        header: {
          Authorization: "Bearer $TOKEN$",
          "Content-Type": "application/json",
          "User-Agent":
            "codex-tui/0.149.1 (Mac OS 26.5.2; arm64) iTerm.app/3.6.11 (codex-tui; 0.149.1)",
          ...(accountId ? { "Chatgpt-Account-Id": accountId } : {}),
        },
      }).pipe(Effect.map((payload) => parseCliProxyCodexUsageWindows(payload, checkedAtMs)));
    },
  });
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
    provider: "xai",
    providerLabel: "Grok",
    readWindows: (authFile) => {
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
          if (deduplicated.length > 0) return Effect.succeed(deduplicated);
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

const readNativeClaudeUsageLimits = Effect.fn("readNativeClaudeUsageLimits")(function* (
  settings: Pick<ClaudeSettings, "homePath">,
  environment: NodeJS.ProcessEnv,
) {
  const path = yield* Path.Path;
  const configDirectory = settings.homePath.trim()
    ? expandHomePath(settings.homePath)
    : path.join(environment.HOME ?? process.env.HOME ?? "", ".claude");
  const accessToken = yield* readFirstToken({
    paths: [path.join(configDirectory, ".credentials.json")],
    decode: (contents) => {
      const decoded = decodeClaudeCredentials(contents);
      return Option.map(decoded, (credentials) => credentials.claudeAiOauth.accessToken);
    },
  });
  const payload = yield* executePrivateJson(
    HttpClientRequest.get("https://api.anthropic.com/api/oauth/usage").pipe(
      HttpClientRequest.bearerToken(accessToken),
      HttpClientRequest.setHeader("anthropic-beta", "oauth-2025-04-20"),
      HttpClientRequest.acceptJson,
    ),
    "Claude",
  );
  const windows = parseClaudeUsageWindows(payload);
  if (windows.length === 0) {
    return yield* safeReadError("Claude did not return any subscription windows.");
  }
  return makeUsageLimitsSnapshot({
    source: "claude-oauth-private",
    support: "experimental",
    checkedAt: DateTime.formatIso(yield* DateTime.now),
    windows,
    dashboardUrl: "https://claude.ai/settings/usage",
  });
});

export const readClaudeUsageLimits = Effect.fn("readClaudeUsageLimits")(function* (
  settings: Pick<ClaudeSettings, "homePath">,
  environment: NodeJS.ProcessEnv,
) {
  const cliProxy = resolveCliProxyManagementConfig(environment);
  if (cliProxy) return yield* readCliProxyClaudeUsageLimits(cliProxy);
  if (environment.CLIPROXYAPI_MANAGEMENT_KEY?.trim()) {
    return yield* safeReadError(
      "Set CLIPROXYAPI_MANAGEMENT_URL or a provider base URL to read CLIProxyAPI accounts.",
    );
  }
  return yield* readNativeClaudeUsageLimits(settings, environment);
});

export const readCursorUsageLimits = Effect.fn("readCursorUsageLimits")(function* (
  _settings: Pick<CursorSettings, "apiEndpoint">,
  environment: NodeJS.ProcessEnv,
) {
  const path = yield* Path.Path;
  const home = environment.HOME ?? process.env.HOME ?? "";
  const environmentToken = environment.CURSOR_AUTH_TOKEN?.trim();
  const accessToken =
    environmentToken ||
    (yield* readFirstToken({
      paths: [
        path.join(home, ".cursor", "auth.json"),
        path.join(home, ".cursor-agent", "auth.json"),
        path.join(home, ".config", "cursor", "auth.json"),
      ],
      decode: (contents) => {
        const decoded = decodeCursorCredentials(contents);
        return Option.map(decoded, cursorCredentialToken);
      },
    }));
  const payload = yield* executePrivateJson(
    HttpClientRequest.post(
      "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage",
    ).pipe(
      HttpClientRequest.bearerToken(accessToken),
      HttpClientRequest.setHeader("connect-protocol-version", "1"),
      HttpClientRequest.bodyJsonUnsafe({}),
      HttpClientRequest.acceptJson,
    ),
    "Cursor",
  );
  const windows = parseCursorUsageWindows(payload);
  if (windows.length === 0) {
    return yield* safeReadError("Cursor did not return a billing-cycle allowance.");
  }
  return makeUsageLimitsSnapshot({
    source: "cursor-private-api",
    support: "experimental",
    checkedAt: DateTime.formatIso(yield* DateTime.now),
    windows,
    dashboardUrl: "https://cursor.com/dashboard?tab=usage",
  });
});

export const readOpenCodeGoUsageLimits = Effect.fn("readOpenCodeGoUsageLimits")(function* (
  _settings: Pick<OpenCodeSettings, "serverUrl">,
  environment: NodeJS.ProcessEnv,
) {
  const accessToken =
    environment.OPENCODE_GO_API_KEY?.trim() || environment.OPENCODE_API_KEY?.trim();
  if (!accessToken) {
    return yield* safeReadError(
      "OpenCode Go limits need OPENCODE_GO_API_KEY in this provider instance environment.",
    );
  }
  const payload = yield* executePrivateJson(
    HttpClientRequest.get("https://opencode.ai/zen/go/v1/usage").pipe(
      HttpClientRequest.bearerToken(accessToken),
      HttpClientRequest.acceptJson,
    ),
    "OpenCode Go",
  );
  const windows = parseOpenCodeUsageWindows(payload);
  if (windows.length === 0) {
    return yield* safeReadError("This OpenCode account did not report OpenCode Go limits.");
  }
  return makeUsageLimitsSnapshot({
    source: "opencode-go",
    support: "experimental",
    checkedAt: DateTime.formatIso(yield* DateTime.now),
    windows,
    dashboardUrl: "https://opencode.ai/zen",
  });
});
