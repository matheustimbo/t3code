import type {
  ProviderInstanceId,
  ServerProvider,
  ServerProviderUsageLimitWindow,
  ServerProviderUsageLimits,
  ServerProviderUsageLimitsAccount,
  ServerProviderUsageLimitsSupport,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";

export const USAGE_LIMITS_POLL_INTERVAL = "45 seconds" as const;

export class ProviderUsageLimitsReadError extends Schema.TaggedErrorClass<ProviderUsageLimitsReadError>()(
  "ProviderUsageLimitsReadError",
  {
    message: Schema.String,
  },
) {}

const clampPercent = (value: number): number => Math.min(100, Math.max(0, value));

function asIsoDateTime(value: string | number | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  const dateTime = DateTime.make(
    typeof value === "number" && value < 10_000_000_000 ? value * 1_000 : value,
  );
  return Option.map(dateTime, DateTime.formatIso).pipe(Option.getOrUndefined);
}

function windowLabel(id: string): string {
  return id.replace(/[_-]+/gu, " ").replace(/\b\w/gu, (character) => character.toUpperCase());
}

function normalizedWindow(input: {
  readonly id: string;
  readonly label?: string | undefined;
  readonly usedPercent?: number | undefined;
  readonly remainingPercent?: number | undefined;
  readonly resetsAt?: string | number | null | undefined;
  readonly windowDurationMinutes?: number | undefined;
}): ServerProviderUsageLimitWindow {
  const usedPercent = input.usedPercent === undefined ? undefined : clampPercent(input.usedPercent);
  const remainingPercent =
    input.remainingPercent === undefined
      ? usedPercent === undefined
        ? undefined
        : 100 - usedPercent
      : clampPercent(input.remainingPercent);
  const resetsAt = asIsoDateTime(input.resetsAt);
  return {
    id: input.id,
    label: input.label?.trim() || windowLabel(input.id),
    ...(remainingPercent !== undefined ? { remainingPercent } : {}),
    ...(usedPercent !== undefined ? { usedPercent } : {}),
    ...(resetsAt ? { resetsAt } : {}),
    ...(input.windowDurationMinutes && input.windowDurationMinutes > 0
      ? { windowDurationMinutes: Math.round(input.windowDurationMinutes) }
      : {}),
  };
}

export function makeUsageLimitsSnapshot(input: {
  readonly source: string;
  readonly support: ServerProviderUsageLimitsSupport;
  readonly checkedAt: string;
  readonly windows: ReadonlyArray<ServerProviderUsageLimitWindow>;
  readonly message?: string | undefined;
  readonly dashboardUrl?: string | undefined;
}): ServerProviderUsageLimits {
  const complete = input.windows.every(
    (window) => window.remainingPercent !== undefined && window.resetsAt !== undefined,
  );
  return {
    status: input.windows.length === 0 ? "unavailable" : complete ? "available" : "partial",
    support: input.support,
    source: input.source,
    checkedAt: input.checkedAt,
    windows: [...input.windows].toSorted(
      (left, right) =>
        (left.remainingPercent ?? Number.POSITIVE_INFINITY) -
        (right.remainingPercent ?? Number.POSITIVE_INFINITY),
    ),
    ...(input.message ? { message: input.message } : {}),
    ...(input.dashboardUrl ? { dashboardUrl: input.dashboardUrl } : {}),
  };
}

export function makeUsageLimitsAccount(input: {
  readonly id: string;
  readonly label?: string | undefined;
  readonly email?: string | undefined;
  readonly source: string;
  readonly support: ServerProviderUsageLimitsSupport;
  readonly checkedAt: string;
  readonly windows: ReadonlyArray<ServerProviderUsageLimitWindow>;
  readonly message?: string | undefined;
  readonly dashboardUrl?: string | undefined;
}): ServerProviderUsageLimitsAccount {
  return {
    id: input.id,
    ...(input.label ? { label: input.label } : {}),
    ...(input.email ? { email: input.email } : {}),
    ...makeUsageLimitsSnapshot(input),
  };
}

export function makeUnavailableUsageLimitsAccount(input: {
  readonly id: string;
  readonly label?: string | undefined;
  readonly email?: string | undefined;
  readonly source: string;
  readonly support: ServerProviderUsageLimitsSupport;
  readonly checkedAt: string;
  readonly status?: "unavailable" | "error" | "disabled";
  readonly message: string;
  readonly dashboardUrl?: string | undefined;
}): ServerProviderUsageLimitsAccount {
  return {
    id: input.id,
    ...(input.label ? { label: input.label } : {}),
    ...(input.email ? { email: input.email } : {}),
    ...makeUnavailableUsageLimits(input),
  };
}

export function makePooledUsageLimitsSnapshot(input: {
  readonly source: string;
  readonly support: ServerProviderUsageLimitsSupport;
  readonly checkedAt: string;
  readonly accounts: ReadonlyArray<ServerProviderUsageLimitsAccount>;
  readonly dashboardUrl?: string | undefined;
}): ServerProviderUsageLimits {
  const availableAccounts = input.accounts.filter((account) => account.windows.length > 0).length;
  return {
    status:
      input.accounts.length === 0
        ? "error"
        : availableAccounts === input.accounts.length
          ? "available"
          : availableAccounts > 0
            ? "partial"
            : "error",
    support: input.support,
    source: input.source,
    checkedAt: input.checkedAt,
    windows: [],
    accounts: [...input.accounts],
    message: `${input.accounts.length} independently metered account${input.accounts.length === 1 ? "" : "s"}.`,
    ...(input.dashboardUrl ? { dashboardUrl: input.dashboardUrl } : {}),
  };
}

export function makeUnavailableUsageLimits(input: {
  readonly source: string;
  readonly support: ServerProviderUsageLimitsSupport;
  readonly checkedAt: string;
  readonly status?: "unavailable" | "error" | "disabled";
  readonly message: string;
  readonly dashboardUrl?: string | undefined;
}): ServerProviderUsageLimits {
  return {
    status: input.status ?? "unavailable",
    support: input.support,
    source: input.source,
    checkedAt: input.checkedAt,
    windows: [],
    message: input.message,
    ...(input.dashboardUrl ? { dashboardUrl: input.dashboardUrl } : {}),
  };
}

/**
 * Runs one lightweight limits reader per provider instance. BackgroundPolicy
 * keeps it dormant when no client or turn needs provider status. Failures keep
 * the last good windows, visibly marked stale, instead of erasing useful data.
 */
export const pollProviderUsageLimits = Effect.fn("pollProviderUsageLimits")(function* (input: {
  readonly instanceId: ProviderInstanceId;
  readonly getSnapshot: Effect.Effect<ServerProvider>;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  readonly read: Effect.Effect<ServerProviderUsageLimits, ProviderUsageLimitsReadError>;
  readonly backgroundPolicy: Context.Service.Shape<typeof BackgroundPolicy.BackgroundPolicy>;
}) {
  return yield* Effect.forever(
    Effect.gen(function* () {
      const [genericDemand, instanceDemand] = yield* Effect.all([
        input.backgroundPolicy.shouldRunScopeWork({ type: "provider-status" }),
        input.backgroundPolicy.shouldRunScopeWork({
          type: "provider-status",
          instanceId: input.instanceId,
        }),
      ]);
      if (genericDemand || instanceDemand) {
        const result = yield* input.read.pipe(Effect.result);
        const snapshot = yield* input.getSnapshot;
        if (Result.isSuccess(result)) {
          yield* input.publishSnapshot({ ...snapshot, usageLimits: result.success });
        } else {
          const checkedAt = DateTime.formatIso(yield* DateTime.now);
          const previous = snapshot.usageLimits;
          const hasPreviousReadings =
            previous &&
            (previous.windows.length > 0 ||
              previous.accounts?.some((account) => account.windows.length > 0));
          const usageLimits: ServerProviderUsageLimits =
            previous && hasPreviousReadings
              ? {
                  ...previous,
                  status: "stale",
                  message: result.failure.message,
                  ...(previous.accounts
                    ? {
                        accounts: previous.accounts.map((account) => ({
                          ...account,
                          ...(account.windows.length > 0 ? { status: "stale" as const } : {}),
                        })),
                      }
                    : {}),
                }
              : makeUnavailableUsageLimits({
                  source: previous?.source ?? "unknown",
                  support: previous?.support ?? "unavailable",
                  checkedAt,
                  status: "error",
                  message: result.failure.message,
                  ...(previous?.dashboardUrl ? { dashboardUrl: previous.dashboardUrl } : {}),
                });
          yield* input.publishSnapshot({ ...snapshot, usageLimits });
        }
      }
      yield* Effect.sleep(USAGE_LIMITS_POLL_INTERVAL);
    }),
  );
});

const ClaudeWindow = Schema.Struct({
  utilization: Schema.optional(Schema.Number),
  used_percentage: Schema.optional(Schema.Number),
  resets_at: Schema.optional(Schema.Union([Schema.String, Schema.Number, Schema.Null])),
});
const ClaudeUsagePayload = Schema.Struct({
  five_hour: Schema.optional(ClaudeWindow),
  seven_day: Schema.optional(ClaudeWindow),
  seven_day_oauth_apps: Schema.optional(ClaudeWindow),
  seven_day_sonnet: Schema.optional(ClaudeWindow),
  seven_day_opus: Schema.optional(ClaudeWindow),
  extra_usage: Schema.optional(ClaudeWindow),
});
const decodeClaudeUsagePayload = Schema.decodeUnknownOption(ClaudeUsagePayload);

export function parseClaudeUsageWindows(
  input: unknown,
): ReadonlyArray<ServerProviderUsageLimitWindow> {
  const decoded = decodeClaudeUsagePayload(input);
  if (Option.isNone(decoded)) return [];
  const labels: Readonly<Record<string, string>> = {
    five_hour: "5 hours",
    seven_day: "7 days",
    seven_day_oauth_apps: "7 days · OAuth apps",
    seven_day_sonnet: "7 days · Sonnet",
    seven_day_opus: "7 days · Opus",
    extra_usage: "Extra usage",
  };
  return Object.entries(decoded.value).flatMap(([id, window]) =>
    window
      ? [
          normalizedWindow({
            id,
            label: labels[id],
            usedPercent: window.used_percentage ?? window.utilization,
            resetsAt: window.resets_at,
          }),
        ]
      : [],
  );
}

const CursorUsagePayload = Schema.Struct({
  billingCycleEnd: Schema.optional(Schema.Union([Schema.String, Schema.Number, Schema.Null])),
  planUsage: Schema.optional(
    Schema.Struct({
      totalPercentUsed: Schema.optional(Schema.Number),
      remaining: Schema.optional(Schema.Number),
      limit: Schema.optional(Schema.Number),
    }),
  ),
  totalPercentUsed: Schema.optional(Schema.Number),
});
const decodeCursorUsagePayload = Schema.decodeUnknownOption(CursorUsagePayload);

export function parseCursorUsageWindows(
  input: unknown,
): ReadonlyArray<ServerProviderUsageLimitWindow> {
  const decoded = decodeCursorUsagePayload(input);
  if (Option.isNone(decoded)) return [];
  const payload = decoded.value;
  const usedPercent =
    payload.planUsage?.totalPercentUsed ??
    payload.totalPercentUsed ??
    (payload.planUsage?.remaining !== undefined &&
    payload.planUsage.limit !== undefined &&
    payload.planUsage.limit > 0
      ? 100 - (payload.planUsage.remaining / payload.planUsage.limit) * 100
      : undefined);
  return [
    normalizedWindow({
      id: "billing_cycle",
      label: "Billing cycle",
      usedPercent,
      resetsAt: payload.billingCycleEnd,
    }),
  ];
}

const NumericValue = Schema.Union([Schema.Number, Schema.String]);
const NullableNumericValue = Schema.Union([NumericValue, Schema.Null]);
const NullableDateValue = Schema.Union([Schema.String, Schema.Number, Schema.Null]);

function numericValue(value: number | string | null | undefined): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

const CodexUsageWindow = Schema.Struct({
  used_percent: Schema.optional(NullableNumericValue),
  usedPercent: Schema.optional(NullableNumericValue),
  limit_window_seconds: Schema.optional(NullableNumericValue),
  limitWindowSeconds: Schema.optional(NullableNumericValue),
  reset_after_seconds: Schema.optional(NullableNumericValue),
  resetAfterSeconds: Schema.optional(NullableNumericValue),
  reset_at: Schema.optional(NullableDateValue),
  resetAt: Schema.optional(NullableDateValue),
});
const NullableCodexUsageWindow = Schema.Union([CodexUsageWindow, Schema.Null]);
const CodexRateLimit = Schema.Struct({
  allowed: Schema.optional(Schema.Boolean),
  limit_reached: Schema.optional(Schema.Boolean),
  limitReached: Schema.optional(Schema.Boolean),
  primary_window: Schema.optional(NullableCodexUsageWindow),
  primaryWindow: Schema.optional(NullableCodexUsageWindow),
  secondary_window: Schema.optional(NullableCodexUsageWindow),
  secondaryWindow: Schema.optional(NullableCodexUsageWindow),
});
const NullableCodexRateLimit = Schema.Union([CodexRateLimit, Schema.Null]);
const CodexAdditionalRateLimit = Schema.Struct({
  limit_name: Schema.optional(Schema.String),
  limitName: Schema.optional(Schema.String),
  metered_feature: Schema.optional(Schema.String),
  meteredFeature: Schema.optional(Schema.String),
  rate_limit: Schema.optional(NullableCodexRateLimit),
  rateLimit: Schema.optional(NullableCodexRateLimit),
});
const CodexUsagePayload = Schema.Struct({
  rate_limit: Schema.optional(NullableCodexRateLimit),
  rateLimit: Schema.optional(NullableCodexRateLimit),
  code_review_rate_limit: Schema.optional(NullableCodexRateLimit),
  codeReviewRateLimit: Schema.optional(NullableCodexRateLimit),
  additional_rate_limits: Schema.optional(
    Schema.Union([Schema.Array(CodexAdditionalRateLimit), Schema.Null]),
  ),
  additionalRateLimits: Schema.optional(
    Schema.Union([Schema.Array(CodexAdditionalRateLimit), Schema.Null]),
  ),
});
const decodeCodexUsagePayload = Schema.decodeUnknownOption(CodexUsagePayload);

function usageWindowLabel(durationSeconds: number | undefined, fallback: string): string {
  if (durationSeconds === 18_000) return "5 hours";
  if (durationSeconds === 604_800) return "7 days";
  if (durationSeconds && durationSeconds >= 28 * 86_400 && durationSeconds <= 31 * 86_400) {
    return "Monthly";
  }
  if (durationSeconds && durationSeconds % 86_400 === 0) {
    return `${durationSeconds / 86_400} days`;
  }
  if (durationSeconds && durationSeconds % 3_600 === 0) {
    return `${durationSeconds / 3_600} hours`;
  }
  return fallback;
}

function slugifyUsageWindowId(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-+|-+$/gu, "") || "limit"
  );
}

export function parseCliProxyCodexUsageWindows(
  input: unknown,
  nowMs: number,
): ReadonlyArray<ServerProviderUsageLimitWindow> {
  const decoded = decodeCodexUsagePayload(input);
  if (Option.isNone(decoded)) return [];
  const payload = decoded.value;
  const windows: Array<ServerProviderUsageLimitWindow> = [];

  const appendRateLimit = (
    prefix: string,
    labelPrefix: string | undefined,
    rateLimit: typeof CodexRateLimit.Type | null | undefined,
  ) => {
    if (!rateLimit) return;
    const limitReached = rateLimit.limit_reached ?? rateLimit.limitReached ?? false;
    const allowed = rateLimit.allowed;
    const entries = [
      ["primary", rateLimit.primary_window ?? rateLimit.primaryWindow],
      ["secondary", rateLimit.secondary_window ?? rateLimit.secondaryWindow],
    ] as const;
    for (const [kind, window] of entries) {
      if (!window) continue;
      const durationSeconds = numericValue(
        window.limit_window_seconds ?? window.limitWindowSeconds,
      );
      const resetAfterSeconds = numericValue(
        window.reset_after_seconds ?? window.resetAfterSeconds,
      );
      const label = usageWindowLabel(durationSeconds, kind === "primary" ? "Primary" : "Secondary");
      windows.push(
        normalizedWindow({
          id: `${prefix}:${kind}`,
          label: labelPrefix ? `${labelPrefix} · ${label}` : label,
          usedPercent:
            numericValue(window.used_percent ?? window.usedPercent) ??
            (limitReached || allowed === false ? 100 : undefined),
          resetsAt:
            window.reset_at ??
            window.resetAt ??
            (resetAfterSeconds === undefined ? undefined : nowMs + resetAfterSeconds * 1_000),
          ...(durationSeconds === undefined ? {} : { windowDurationMinutes: durationSeconds / 60 }),
        }),
      );
    }
  };

  appendRateLimit("codex", undefined, payload.rate_limit ?? payload.rateLimit);
  appendRateLimit(
    "code-review",
    "Code review",
    payload.code_review_rate_limit ?? payload.codeReviewRateLimit,
  );
  const additional = payload.additional_rate_limits ?? payload.additionalRateLimits ?? [];
  for (const [index, item] of additional.entries()) {
    const label =
      item.limit_name ??
      item.limitName ??
      item.metered_feature ??
      item.meteredFeature ??
      `Additional ${index + 1}`;
    appendRateLimit(
      `${slugifyUsageWindowId(label)}:${index}`,
      label,
      item.rate_limit ?? item.rateLimit,
    );
  }
  return windows;
}

const GrokBillingCent = Schema.Union([
  NumericValue,
  Schema.Struct({ val: Schema.optional(NullableNumericValue) }),
  Schema.Null,
]);
const GrokProductUsage = Schema.Struct({
  product: Schema.optional(Schema.String),
  usagePercent: Schema.optional(NullableNumericValue),
  usage_percent: Schema.optional(NullableNumericValue),
});
const GrokCurrentPeriod = Schema.Struct({
  type: Schema.optional(Schema.String),
  start: Schema.optional(NullableDateValue),
  end: Schema.optional(NullableDateValue),
});
const GrokUsagePayload = Schema.Struct({
  config: Schema.Struct({
    creditUsagePercent: Schema.optional(NullableNumericValue),
    credit_usage_percent: Schema.optional(NullableNumericValue),
    currentPeriod: Schema.optional(Schema.Union([GrokCurrentPeriod, Schema.Null])),
    current_period: Schema.optional(Schema.Union([GrokCurrentPeriod, Schema.Null])),
    productUsage: Schema.optional(Schema.Union([Schema.Array(GrokProductUsage), Schema.Null])),
    product_usage: Schema.optional(Schema.Union([Schema.Array(GrokProductUsage), Schema.Null])),
    monthlyLimit: Schema.optional(GrokBillingCent),
    monthly_limit: Schema.optional(GrokBillingCent),
    used: Schema.optional(GrokBillingCent),
    onDemandCap: Schema.optional(GrokBillingCent),
    on_demand_cap: Schema.optional(GrokBillingCent),
    onDemandUsed: Schema.optional(GrokBillingCent),
    on_demand_used: Schema.optional(GrokBillingCent),
    billingPeriodStart: Schema.optional(NullableDateValue),
    billing_period_start: Schema.optional(NullableDateValue),
    billingPeriodEnd: Schema.optional(NullableDateValue),
    billing_period_end: Schema.optional(NullableDateValue),
  }),
});
const decodeGrokUsagePayload = Schema.decodeUnknownOption(GrokUsagePayload);

function billingCentValue(value: typeof GrokBillingCent.Type | undefined): number | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "object") return numericValue(value.val);
  return numericValue(value);
}

export function parseGrokUsageWindows(
  input: unknown,
): ReadonlyArray<ServerProviderUsageLimitWindow> {
  const decoded = decodeGrokUsagePayload(input);
  if (Option.isNone(decoded)) return [];
  const config = decoded.value.config;
  const period = config.currentPeriod ?? config.current_period;
  const usagePercent = numericValue(config.creditUsagePercent ?? config.credit_usage_percent);
  const windows: Array<ServerProviderUsageLimitWindow> = [];
  const isWeekly = period?.type?.toLowerCase().includes("weekly") ?? false;
  if (usagePercent !== undefined || period) {
    windows.push(
      normalizedWindow({
        id: isWeekly ? "weekly" : "billing_period",
        label: isWeekly ? "Weekly" : "Billing period",
        usedPercent: usagePercent,
        resetsAt: period?.end,
      }),
    );
  }
  const productUsage = config.productUsage ?? config.product_usage ?? [];
  for (const [index, product] of productUsage.entries()) {
    const usedPercent = numericValue(product.usagePercent ?? product.usage_percent);
    if (usedPercent === undefined) continue;
    const productLabel = product.product?.trim() || `Product ${index + 1}`;
    windows.push(
      normalizedWindow({
        id: `weekly:${slugifyUsageWindowId(productLabel)}:${index}`,
        label: `Weekly · ${productLabel}`,
        usedPercent,
        resetsAt: period?.end,
      }),
    );
  }

  const monthlyLimit = billingCentValue(config.monthlyLimit ?? config.monthly_limit);
  const used = billingCentValue(config.used);
  const billingEnd = config.billingPeriodEnd ?? config.billing_period_end;
  if (monthlyLimit !== undefined && monthlyLimit > 0 && used !== undefined) {
    windows.push(
      normalizedWindow({
        id: "monthly_credits",
        label: "Monthly credits",
        usedPercent: (Math.min(used, monthlyLimit) / monthlyLimit) * 100,
        resetsAt: billingEnd,
      }),
    );
  }

  const onDemandCap = billingCentValue(config.onDemandCap ?? config.on_demand_cap);
  const explicitOnDemandUsed = billingCentValue(config.onDemandUsed ?? config.on_demand_used);
  const onDemandUsed =
    explicitOnDemandUsed ??
    (used !== undefined && monthlyLimit !== undefined
      ? Math.max(0, used - monthlyLimit)
      : undefined);
  if (onDemandCap !== undefined && onDemandCap > 0 && onDemandUsed !== undefined) {
    windows.push(
      normalizedWindow({
        id: "on_demand",
        label: "Pay as you go",
        usedPercent: (onDemandUsed / onDemandCap) * 100,
        resetsAt: billingEnd,
      }),
    );
  }
  return windows;
}

const OpenCodeUsageWindow = Schema.Struct({
  percent: Schema.optional(Schema.Number),
  resetsAt: Schema.optional(Schema.Union([Schema.String, Schema.Number, Schema.Null])),
});
const OpenCodeUsagePayload = Schema.Struct({
  usage: Schema.Struct({
    rolling: Schema.optional(OpenCodeUsageWindow),
    weekly: Schema.optional(OpenCodeUsageWindow),
    monthly: Schema.optional(OpenCodeUsageWindow),
  }),
});
const decodeOpenCodeUsagePayload = Schema.decodeUnknownOption(OpenCodeUsagePayload);

export function parseOpenCodeUsageWindows(
  input: unknown,
): ReadonlyArray<ServerProviderUsageLimitWindow> {
  const decoded = decodeOpenCodeUsagePayload(input);
  if (Option.isNone(decoded)) return [];
  return Object.entries(decoded.value.usage).flatMap(([id, window]) =>
    window
      ? [normalizedWindow({ id, usedPercent: window.percent, resetsAt: window.resetsAt })]
      : [],
  );
}
