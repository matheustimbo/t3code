/**
 * The slice of CLIProxyAPI's Management API this server talks to.
 *
 * Two routes carry everything: `auth-files` enumerates the OAuth credentials
 * the hub pools, and `api-call` replays an arbitrary request through one of
 * them, substituting `$TOKEN$` with that credential's access token. The hub
 * itself reports no quota percentages — its quota routes cover cooldown and
 * routing state — so usage has to come from each provider's own endpoint,
 * reached through the credential the hub holds.
 *
 * @module usage/cliproxyManagementApi
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { type HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

const AUTH_FILES_PATH = "/v0/management/auth-files";
const API_CALL_PATH = "/v0/management/api-call";

/** Substituted by the hub with the account's live access token. */
const TOKEN_PLACEHOLDER = "$TOKEN$";

export interface CliproxyConfig {
  readonly url: string;
  readonly managementKey: string;
}

const CliproxyAuthFile = Schema.Struct({
  auth_index: Schema.String,
  name: Schema.String,
  provider: Schema.optional(Schema.String),
  type: Schema.optional(Schema.String),
  label: Schema.optional(Schema.String),
  email: Schema.optional(Schema.String),
  disabled: Schema.optional(Schema.Union([Schema.Boolean, Schema.Number, Schema.String])),
  id_token: Schema.optional(Schema.Unknown),
  chatgpt_account_id: Schema.optional(Schema.String),
});
export type CliproxyAuthFile = typeof CliproxyAuthFile.Type;

/** The route answers either a bare array or `{ files: [...] }` depending on version. */
const CliproxyAuthFiles = Schema.Union([
  Schema.Array(CliproxyAuthFile),
  Schema.Struct({ files: Schema.Array(CliproxyAuthFile) }),
]);
const decodeAuthFiles = Schema.decodeUnknownOption(CliproxyAuthFiles);

/** `api-call` wraps the upstream answer; older builds return it bare. */
const CliproxyApiCallResponse = Schema.Struct({
  status: Schema.optional(Schema.Number),
  body: Schema.optional(Schema.Unknown),
});
const decodeApiCallResponse = Schema.decodeUnknownOption(CliproxyApiCallResponse);
const decodeJsonBody = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

function managementUrl(config: CliproxyConfig, path: string): string {
  // An absolute path, so a hub URL carrying its own path still resolves onto
  // the management root the same way.
  return new URL(path, config.url).toString();
}

/**
 * The credentials the hub pools, narrowed to one provider. `provider` is the
 * field current builds set; older ones only carry `type`, and the file name
 * prefix is the last resort.
 */
export const listCliproxyAuthFiles = Effect.fn("cliproxy.listAuthFiles")(function* (
  config: CliproxyConfig,
  httpClient: HttpClient.HttpClient,
) {
  const payload = yield* httpClient
    .get(managementUrl(config, AUTH_FILES_PATH), {
      headers: { Authorization: `Bearer ${config.managementKey}` },
    })
    .pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) => response.json),
    );
  const decoded = decodeAuthFiles(payload);
  if (Option.isNone(decoded)) return [];
  const value = decoded.value;
  const files: ReadonlyArray<CliproxyAuthFile> = "files" in value ? value.files : value;
  return files.filter((file) => !authFileDisabled(file));
});

export function authFileProvider(file: CliproxyAuthFile): string {
  const declared = (file.provider ?? file.type ?? "").trim().toLowerCase();
  if (declared) return declared;
  return file.name.split("-")[0]?.toLowerCase() ?? "";
}

function authFileDisabled(file: CliproxyAuthFile): boolean {
  const value = file.disabled;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value !== "string") return false;
  return ["true", "1", "yes", "on"].includes(value.trim().toLowerCase());
}

/** The signed-in address when the hub names one, else the file's own label. */
export function authFileLabel(file: CliproxyAuthFile): string {
  return file.label?.trim() || file.email?.trim() || file.name.replace(/\.json$/i, "");
}

/**
 * Replay one request through a pooled credential. Errors from the upstream
 * provider surface as the wrapped status, so a single expired account fails
 * alone instead of failing the whole hub read.
 */
export const cliproxyApiCall = Effect.fn("cliproxy.apiCall")(function* (input: {
  readonly config: CliproxyConfig;
  readonly authFile: CliproxyAuthFile;
  readonly httpClient: HttpClient.HttpClient;
  readonly url: string;
  readonly method?: "GET" | "POST";
  readonly header: Readonly<Record<string, string>>;
}) {
  const payload = yield* HttpClientRequest.post(managementUrl(input.config, API_CALL_PATH)).pipe(
    HttpClientRequest.bearerToken(input.config.managementKey),
    HttpClientRequest.bodyJsonUnsafe({
      auth_index: input.authFile.auth_index,
      method: input.method ?? "GET",
      url: input.url,
      header: input.header,
    }),
    HttpClientRequest.acceptJson,
    input.httpClient.execute,
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap((response) => response.json),
  );

  const wrapper = decodeApiCallResponse(payload);
  if (Option.isNone(wrapper) || wrapper.value.body === undefined) return payload;
  const status = wrapper.value.status;
  if (status !== undefined && (status < 200 || status >= 300)) {
    return yield* new CliproxyUpstreamError({ status, url: input.url });
  }
  // The hub passes the upstream body through as a JSON string.
  const body = wrapper.value.body;
  if (typeof body !== "string") return body;
  const parsed = decodeJsonBody(body);
  return Option.isSome(parsed) ? parsed.value : body;
});

export class CliproxyUpstreamError extends Schema.TaggedErrorClass<CliproxyUpstreamError>()(
  "CliproxyUpstreamError",
  { status: Schema.Number, url: Schema.String },
) {}

export { TOKEN_PLACEHOLDER };
