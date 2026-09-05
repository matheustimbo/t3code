/**
 * Reads the subscription usage of every account a CLIProxyAPI hub pools.
 *
 * The hub exposes no usage percentages of its own — its quota routes cover
 * cooldown and routing state — so each account's numbers come from the
 * provider's own endpoint, replayed through that account's credential with
 * `api-call`. Claude answers `/api/oauth/usage`, the REST twin of the SDK's
 * `get_usage`; Codex answers `/backend-api/wham/usage`, the REST twin of
 * `account/rateLimits/read`. Both are normalised into the same shape the
 * native drivers produce and handed to the same mappers, so a pooled row and
 * a local row are the same row with a different badge.
 *
 * @module usage/cliproxyUsageLimits
 */
import {
  ProviderDriverKind,
  type ServerProviderUsageLimits,
  type UsageLimitSourceAccount,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type { HttpClient } from "effect/unstable/http";

import { codexPlanLabel } from "../provider/Layers/CodexProvider.ts";
import { claudeUsageResponseToLimits } from "../provider/Layers/claudeUsageLimits.ts";
import {
  type CodexRateLimitSnapshot,
  codexRateLimitsToLimits,
} from "../provider/Layers/codexUsageLimits.ts";
import {
  type CliproxyAuthFile,
  type CliproxyConfig,
  authFileLabel,
  authFileProvider,
  cliproxyApiCall,
  listCliproxyAuthFiles,
  TOKEN_PLACEHOLDER,
} from "./cliproxyManagementApi.ts";

const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");
const CODEX_DRIVER = ProviderDriverKind.make("codex");

const ACCOUNT_CONCURRENCY = 3;

const NumericValue = Schema.Union([Schema.Number, Schema.String, Schema.Null]);

function numeric(value: string | number | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined;
  const parsed = typeof value === "string" ? Number(value) : value;
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** `claude-julius@ping.gg.json` → `julius@ping.gg`; `codex-<hash>-x@y-pro.json` → `x@y`. */
export function accountEmailFromAuthFile(fileName: string): string | undefined {
  const stem = fileName.replace(/\.json$/i, "");
  // Strip the provider prefix (and Codex's hash) rather than splitting on
  // `-`, so a hyphenated local part such as `first-last@` survives.
  return stem.match(/^(?:claude-|codex-[a-z0-9]+-)?([^\s/]+@[^\s/]+?)(?:-[a-z0-9]+)?$/i)?.[1];
}

// ------------------------------------------------------------------ Claude ---

const ClaudeWindow = Schema.Struct({
  utilization: Schema.optional(NumericValue),
  used_percentage: Schema.optional(NumericValue),
  resets_at: Schema.optional(Schema.Union([Schema.String, Schema.Number, Schema.Null])),
});
const NullableClaudeWindow = Schema.Union([ClaudeWindow, Schema.Null]);

/** The REST payload names scoped buckets in `limits[]`; the SDK uses `model_scoped[]`. */
const ClaudeScopedLimit = Schema.Struct({
  kind: Schema.optional(Schema.Union([Schema.String, Schema.Null])),
  percent: Schema.optional(NumericValue),
  resets_at: Schema.optional(Schema.Union([Schema.String, Schema.Number, Schema.Null])),
  is_active: Schema.optional(Schema.Union([Schema.Boolean, Schema.Null])),
  scope: Schema.optional(
    Schema.Union([
      Schema.Struct({
        model: Schema.optional(
          Schema.Union([
            Schema.Struct({
              display_name: Schema.optional(Schema.Union([Schema.String, Schema.Null])),
            }),
            Schema.Null,
          ]),
        ),
      }),
      Schema.Null,
    ]),
  ),
});

const ClaudeUsagePayload = Schema.Struct({
  five_hour: Schema.optional(NullableClaudeWindow),
  seven_day: Schema.optional(NullableClaudeWindow),
  limits: Schema.optional(
    Schema.Union([Schema.Array(Schema.Union([ClaudeScopedLimit, Schema.Null])), Schema.Null]),
  ),
});
const decodeClaudeUsage = Schema.decodeUnknownOption(ClaudeUsagePayload);

const ClaudeProfilePayload = Schema.Struct({
  account: Schema.optional(
    Schema.Struct({
      has_claude_max: Schema.optional(
        Schema.Union([Schema.Boolean, Schema.Number, Schema.String, Schema.Null]),
      ),
      has_claude_pro: Schema.optional(
        Schema.Union([Schema.Boolean, Schema.Number, Schema.String, Schema.Null]),
      ),
    }),
  ),
});
const decodeClaudeProfile = Schema.decodeUnknownOption(ClaudeProfilePayload);

function booleanValue(value: boolean | number | string | null | undefined): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  return undefined;
}

export function claudePlanLabel(profile: unknown): string | undefined {
  const decoded = decodeClaudeProfile(profile);
  if (Option.isNone(decoded)) return undefined;
  if (booleanValue(decoded.value.account?.has_claude_max)) return "Max";
  if (booleanValue(decoded.value.account?.has_claude_pro)) return "Pro";
  return undefined;
}

function isoOrUndefined(value: string | number | null | undefined): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * Reshapes the REST payload into the SDK response `claudeUsageResponseToLimits`
 * consumes, so pooled accounts and the local login draw identical rows.
 */
export function claudeUsagePayloadToLimits(
  payload: unknown,
  checkedAt: string,
): ServerProviderUsageLimits {
  const decoded = decodeClaudeUsage(payload);
  if (Option.isNone(decoded)) {
    return claudeUsageResponseToLimits({
      response: { rate_limits_available: false, rate_limits: null },
      checkedAt,
    }).limits;
  }
  const value = decoded.value;
  const window = (input: typeof ClaudeWindow.Type | null | undefined) =>
    input
      ? {
          utilization: numeric(input.used_percentage ?? input.utilization) ?? null,
          resets_at: isoOrUndefined(input.resets_at),
        }
      : undefined;

  const scoped = (value.limits ?? []).flatMap((limit) => {
    const displayName = limit?.scope?.model?.display_name?.trim();
    const utilization = numeric(limit?.percent);
    if (!displayName || utilization === undefined) return [];
    if (limit?.kind?.trim().toLowerCase() !== "weekly_scoped") return [];
    return [{ display_name: displayName, utilization, resets_at: isoOrUndefined(limit.resets_at) }];
  });

  return claudeUsageResponseToLimits({
    response: {
      rate_limits_available: true,
      rate_limits: {
        ...(window(value.five_hour) ? { five_hour: window(value.five_hour) } : {}),
        ...(window(value.seven_day) ? { seven_day: window(value.seven_day) } : {}),
        ...(scoped.length > 0 ? { model_scoped: scoped } : {}),
      },
    } as Parameters<typeof claudeUsageResponseToLimits>[0]["response"],
    checkedAt,
  }).limits;
}

// ------------------------------------------------------------------- Codex ---

const CodexWindow = Schema.Struct({
  used_percent: Schema.optional(NumericValue),
  limit_window_seconds: Schema.optional(NumericValue),
  reset_after_seconds: Schema.optional(NumericValue),
});
const CodexRateLimit = Schema.Struct({
  primary_window: Schema.optional(Schema.Union([CodexWindow, Schema.Null])),
  secondary_window: Schema.optional(Schema.Union([CodexWindow, Schema.Null])),
});
const CodexUsagePayload = Schema.Struct({
  plan_type: Schema.optional(Schema.Union([Schema.String, Schema.Null])),
  rate_limit: Schema.optional(Schema.Union([CodexRateLimit, Schema.Null])),
});
const decodeCodexUsage = Schema.decodeUnknownOption(CodexUsagePayload);

/**
 * `wham/usage` counts down to the reset in seconds; the app-server snapshot
 * the shared mapper expects carries an absolute epoch, so the countdown is
 * anchored to the read.
 */
export function codexUsagePayloadToLimits(
  payload: unknown,
  checkedAt: string,
  nowMs: number,
): ServerProviderUsageLimits | undefined {
  const decoded = decodeCodexUsage(payload);
  if (Option.isNone(decoded)) return undefined;
  const rateLimit = decoded.value.rate_limit;
  if (!rateLimit) return undefined;

  const window = (input: typeof CodexWindow.Type | null | undefined) => {
    if (!input) return null;
    const usedPercent = numeric(input.used_percent);
    if (usedPercent === undefined) return null;
    const resetAfter = numeric(input.reset_after_seconds);
    const duration = numeric(input.limit_window_seconds);
    return {
      usedPercent,
      ...(resetAfter === undefined ? {} : { resetsAt: Math.round(nowMs / 1000) + resetAfter }),
      ...(duration === undefined ? {} : { windowDurationMins: duration / 60 }),
    };
  };

  const snapshot: CodexRateLimitSnapshot = {
    planType: decoded.value.plan_type ?? null,
    primary: window(rateLimit.primary_window),
    secondary: window(rateLimit.secondary_window),
  };
  if (!snapshot.primary && !snapshot.secondary) return undefined;
  return codexRateLimitsToLimits({ snapshot, checkedAt });
}

// ------------------------------------------------------------------ Source ---

const CLAUDE_HEADER = {
  Authorization: `Bearer ${TOKEN_PLACEHOLDER}`,
  "Content-Type": "application/json",
  "anthropic-beta": "oauth-2025-04-20",
};

function codexHeader(file: CliproxyAuthFile): Readonly<Record<string, string>> {
  return {
    Authorization: `Bearer ${TOKEN_PLACEHOLDER}`,
    "Content-Type": "application/json",
    ...(file.chatgpt_account_id ? { "Chatgpt-Account-Id": file.chatgpt_account_id } : {}),
  };
}

function accountBase(file: CliproxyAuthFile, driver: ProviderDriverKind) {
  const email = file.email?.trim() || accountEmailFromAuthFile(file.name);
  return {
    id: file.name,
    driver,
    ...(email ? { email } : {}),
  };
}

/**
 * Every pooled Claude and Codex account the hub can currently speak for. An
 * account whose provider read fails is dropped rather than failing the source:
 * one expired credential must not blank the accounts beside it.
 */
export const readCliproxyAccounts = Effect.fn("cliproxy.readAccounts")(function* (input: {
  readonly config: CliproxyConfig;
  readonly httpClient: HttpClient.HttpClient;
  readonly checkedAt: string;
  readonly nowMs: number;
}) {
  const files = yield* listCliproxyAuthFiles(input.config, input.httpClient);

  const readAccount = (file: CliproxyAuthFile) =>
    Effect.gen(function* () {
      const provider = authFileProvider(file);
      const call = (url: string, header: Readonly<Record<string, string>>) =>
        cliproxyApiCall({
          config: input.config,
          authFile: file,
          httpClient: input.httpClient,
          url,
          header,
        });

      if (provider === "claude") {
        const [usage, profile] = yield* Effect.all(
          [
            call("https://api.anthropic.com/api/oauth/usage", CLAUDE_HEADER),
            call("https://api.anthropic.com/api/oauth/profile", CLAUDE_HEADER).pipe(Effect.result),
          ],
          { concurrency: 2 },
        );
        const limits = claudeUsagePayloadToLimits(usage, input.checkedAt);
        if (limits.windows.length === 0) return [];
        const plan = Result.isSuccess(profile) ? claudePlanLabel(profile.success) : undefined;
        return [
          {
            ...accountBase(file, CLAUDE_DRIVER),
            ...(plan ? { plan } : {}),
            usageLimits: limits,
          } satisfies UsageLimitSourceAccount,
        ];
      }

      if (provider === "codex") {
        const usage = yield* call("https://chatgpt.com/backend-api/wham/usage", codexHeader(file));
        const limits = codexUsagePayloadToLimits(usage, input.checkedAt, input.nowMs);
        if (!limits || limits.windows.length === 0) return [];
        const plan = codexPlanLabel(
          (usage as { readonly plan_type?: string | null } | null)?.plan_type ?? undefined,
        );
        return [
          {
            ...accountBase(file, CODEX_DRIVER),
            ...(plan ? { plan } : {}),
            usageLimits: limits,
          } satisfies UsageLimitSourceAccount,
        ];
      }

      return [];
    }).pipe(
      Effect.catch((cause) =>
        Effect.logDebug("cliproxy account read failed", {
          account: authFileLabel(file),
          cause,
        }).pipe(Effect.as([] as ReadonlyArray<UsageLimitSourceAccount>)),
      ),
    );

  const accounts: ReadonlyArray<ReadonlyArray<UsageLimitSourceAccount>> = yield* Effect.forEach(
    files,
    readAccount,
    { concurrency: ACCOUNT_CONCURRENCY },
  );

  return accounts
    .flat()
    .toSorted(
      (left, right) => left.driver.localeCompare(right.driver) || left.id.localeCompare(right.id),
    );
});
