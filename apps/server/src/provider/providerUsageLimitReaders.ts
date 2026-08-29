import type { ClaudeSettings, CursorSettings, OpenCodeSettings } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

import {
  makePooledUsageLimitsSnapshot,
  makeUsageLimitsSnapshot,
  makeUsageLimitsAccount,
  makeUnavailableUsageLimitsAccount,
  parseClaudeUsageWindows,
  parseCursorUsageWindows,
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
  provider: Schema.String,
  label: Schema.optional(Schema.String),
  email: Schema.optional(Schema.String),
  account: Schema.optional(Schema.String),
  disabled: Schema.optional(Schema.Boolean),
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
  const inferenceUrl = environment.ANTHROPIC_BASE_URL?.trim();
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

export function parseCliProxyClaudeAuthFiles(
  input: unknown,
): ReadonlyArray<typeof CliProxyAuthFile.Type> {
  const decoded = decodeCliProxyAuthFiles(input);
  if (Option.isNone(decoded)) return [];
  return decoded.value.files.filter(
    (authFile) => authFile.provider.trim().toLowerCase() === "claude",
  );
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

const readCliProxyClaudeUsageLimits = Effect.fn("readCliProxyClaudeUsageLimits")(function* (
  config: CliProxyManagementConfig,
) {
  const authPayload = yield* executePrivateJson(
    HttpClientRequest.get(`${config.apiBaseUrl}/auth-files`).pipe(
      HttpClientRequest.bearerToken(config.key),
      HttpClientRequest.acceptJson,
    ),
    "CLIProxyAPI",
  );
  const authFiles = parseCliProxyClaudeAuthFiles(authPayload);
  if (authFiles.length === 0) {
    return yield* safeReadError("CLIProxyAPI did not report any Claude OAuth accounts.");
  }

  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const accounts = yield* Effect.forEach(
    authFiles,
    (authFile) =>
      Effect.gen(function* () {
        const label =
          authFile.label?.trim() ||
          authFile.email?.trim() ||
          authFile.account?.trim() ||
          authFile.name.trim();
        const payload = yield* executePrivateJson(
          HttpClientRequest.post(`${config.apiBaseUrl}/api-call`).pipe(
            HttpClientRequest.bearerToken(config.key),
            HttpClientRequest.acceptJson,
            HttpClientRequest.bodyJsonUnsafe({
              auth_index: authFile.auth_index,
              method: "GET",
              url: "https://api.anthropic.com/api/oauth/usage",
              header: {
                Authorization: "Bearer $TOKEN$",
                "anthropic-beta": "oauth-2025-04-20",
              },
            }),
          ),
          "CLIProxyAPI",
        );
        const apiCall = decodeCliProxyApiCallResponse(payload);
        if (Option.isNone(apiCall)) {
          return yield* safeReadError("CLIProxyAPI returned an unreadable account response.");
        }
        if (apiCall.value.status_code < 200 || apiCall.value.status_code >= 300) {
          return yield* safeReadError(
            `Claude account ${label} returned HTTP ${apiCall.value.status_code}.`,
          );
        }
        const usagePayload = decodeJsonBody(apiCall.value.body);
        if (Option.isNone(usagePayload)) {
          return yield* safeReadError(`Claude account ${label} returned unreadable limits.`);
        }
        const windows = parseClaudeUsageWindows(usagePayload.value);
        if (windows.length === 0) {
          return yield* safeReadError(`Claude account ${label} returned no subscription windows.`);
        }
        return makeUsageLimitsAccount({
          id: authFile.auth_index,
          label,
          ...(authFile.email?.trim() ? { email: authFile.email.trim() } : {}),
          source: "cliproxyapi-management",
          support: "experimental",
          checkedAt,
          windows,
          dashboardUrl: config.dashboardUrl,
        });
      }).pipe(
        Effect.catch((error) =>
          Effect.succeed(
            makeUnavailableUsageLimitsAccount({
              id: authFile.auth_index,
              label:
                authFile.label?.trim() ||
                authFile.email?.trim() ||
                authFile.account?.trim() ||
                authFile.name.trim(),
              ...(authFile.email?.trim() ? { email: authFile.email.trim() } : {}),
              source: "cliproxyapi-management",
              support: "experimental",
              checkedAt,
              status: authFile.disabled ? "disabled" : "error",
              message: authFile.disabled ? "Disabled in CLIProxyAPI." : error.message,
              dashboardUrl: config.dashboardUrl,
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
    dashboardUrl: config.dashboardUrl,
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
      "Set CLIPROXYAPI_MANAGEMENT_URL or ANTHROPIC_BASE_URL to read CLIProxyAPI accounts.",
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
