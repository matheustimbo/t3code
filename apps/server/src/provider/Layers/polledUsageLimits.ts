/**
 * Usage-window parsers for the providers that only answer over HTTP: Cursor,
 * Grok (through a CLIProxyAPI hub) and OpenCode Go.
 *
 * Claude and Codex get their windows from `account.rate-limits.updated` during
 * a turn, so they live in `claudeUsageLimits.ts` / `codexUsageLimits.ts` beside
 * the adapters that emit them. These three have no runtime channel, so
 * `providerUsageLimitReaders.ts` polls the endpoint and hands the payload here.
 *
 * Everything in this module is fork-only. Keeping it in one file that upstream
 * does not have keeps the sync conflict surface to the driver call sites.
 *
 * @module provider/Layers/polledUsageLimits
 */
import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { clampPercent } from "../providerUsageLimits.ts";

function asIsoDateTime(value: string | number | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  const dateTime = DateTime.make(
    // Seconds-since-epoch below this bound, milliseconds above it.
    typeof value === "number" && value < 10_000_000_000 ? value * 1_000 : value,
  );
  return Option.map(dateTime, DateTime.formatIso).pipe(Option.getOrUndefined);
}

/**
 * Builds a window, or nothing when the provider gave no usable percentage.
 * `usedPercent` is required by the contract, and a bar with no number is worse
 * than no bar: it reads as "zero used" to anyone glancing at it.
 */
function usageWindow(input: {
  readonly id: string;
  readonly kind: ServerProviderUsageWindow["kind"];
  readonly label: string;
  readonly usedPercent: number | undefined;
  readonly resetsAt?: string | number | null | undefined;
}): ServerProviderUsageWindow | undefined {
  if (input.usedPercent === undefined || !Number.isFinite(input.usedPercent)) return undefined;
  const resetsAt = asIsoDateTime(input.resetsAt);
  return {
    id: input.id,
    kind: input.kind,
    label: input.label,
    usedPercent: clampPercent(input.usedPercent),
    ...(resetsAt ? { resetsAt } : {}),
  };
}

function numericValue(value: number | string | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined;
  const parsed = typeof value === "string" ? Number(value) : value;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function slugifyUsageWindowId(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "_")
      .replace(/^_+|_+$/gu, "") || "product"
  );
}

const NumericValue = Schema.Union([Schema.Number, Schema.String]);
const NullableNumericValue = Schema.Union([NumericValue, Schema.Null]);
const NullableDateValue = Schema.Union([Schema.String, Schema.Number, Schema.Null]);

// ---------------------------------------------------------------- Cursor ----

const CursorUsagePayload = Schema.Struct({
  billingCycleEnd: Schema.optional(NullableDateValue),
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

/** Cursor reports one allowance per billing cycle, as a percentage or a remaining/limit pair. */
export function parseCursorUsageWindows(input: unknown): ReadonlyArray<ServerProviderUsageWindow> {
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
  const window = usageWindow({
    id: "billing_cycle",
    kind: "monthly",
    label: "Billing cycle",
    usedPercent,
    resetsAt: payload.billingCycleEnd,
  });
  return window ? [window] : [];
}

// ------------------------------------------------------------------ Grok ----

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

/** The billing endpoint answers in either camelCase or snake_case depending on the route. */
function billingCentValue(value: typeof GrokBillingCent.Type | undefined): number | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "object") return numericValue(value.val);
  return numericValue(value);
}

export function parseGrokUsageWindows(input: unknown): ReadonlyArray<ServerProviderUsageWindow> {
  const decoded = decodeGrokUsagePayload(input);
  if (Option.isNone(decoded)) return [];
  const config = decoded.value.config;
  const period = config.currentPeriod ?? config.current_period;
  const usagePercent = numericValue(config.creditUsagePercent ?? config.credit_usage_percent);
  const windows: Array<ServerProviderUsageWindow> = [];
  const push = (window: ServerProviderUsageWindow | undefined) => {
    if (window) windows.push(window);
  };
  const isWeekly = period?.type?.toLowerCase().includes("weekly") ?? false;

  push(
    usageWindow({
      id: isWeekly ? "weekly" : "billing_period",
      kind: isWeekly ? "weekly" : "monthly",
      label: isWeekly ? "Weekly" : "Billing period",
      usedPercent: usagePercent,
      resetsAt: period?.end,
    }),
  );

  const productUsage = config.productUsage ?? config.product_usage ?? [];
  for (const [index, product] of productUsage.entries()) {
    const productLabel = product.product?.trim() || `Product ${index + 1}`;
    push(
      usageWindow({
        id: `weekly:${slugifyUsageWindowId(productLabel)}:${index}`,
        kind: "weekly",
        label: `Weekly · ${productLabel}`,
        usedPercent: numericValue(product.usagePercent ?? product.usage_percent),
        resetsAt: period?.end,
      }),
    );
  }

  const monthlyLimit = billingCentValue(config.monthlyLimit ?? config.monthly_limit);
  const used = billingCentValue(config.used);
  const billingEnd = config.billingPeriodEnd ?? config.billing_period_end;
  if (monthlyLimit !== undefined && monthlyLimit > 0 && used !== undefined) {
    push(
      usageWindow({
        id: "monthly_credits",
        kind: "monthly",
        label: "Monthly credits",
        usedPercent: (Math.min(used, monthlyLimit) / monthlyLimit) * 100,
        resetsAt: billingEnd,
      }),
    );
  }

  const onDemandCap = billingCentValue(config.onDemandCap ?? config.on_demand_cap);
  // Spend past the monthly allowance is on-demand, when the hub does not say so outright.
  const onDemandUsed =
    billingCentValue(config.onDemandUsed ?? config.on_demand_used) ??
    (used !== undefined && monthlyLimit !== undefined
      ? Math.max(0, used - monthlyLimit)
      : undefined);
  if (onDemandCap !== undefined && onDemandCap > 0 && onDemandUsed !== undefined) {
    push(
      usageWindow({
        id: "on_demand",
        kind: "other",
        label: "Pay as you go",
        usedPercent: (onDemandUsed / onDemandCap) * 100,
        resetsAt: billingEnd,
      }),
    );
  }
  return windows;
}

/**
 * A CLIProxy hub pools several Grok accounts behind one provider instance, but
 * the provider snapshot has room for exactly one set of windows. Prefixing the
 * account keeps every account's bars visible and distinguishable.
 */
export function prefixUsageWindowsWithAccount(
  accountLabel: string,
  windows: ReadonlyArray<ServerProviderUsageWindow>,
): ReadonlyArray<ServerProviderUsageWindow> {
  const slug = slugifyUsageWindowId(accountLabel);
  return windows.map((window) => ({
    ...window,
    id: `${slug}:${window.id}`,
    label: `${accountLabel} · ${window.label}`,
  }));
}

// -------------------------------------------------------------- OpenCode ----

const OpenCodeUsageWindow = Schema.Struct({
  percent: Schema.optional(Schema.Number),
  resetsAt: Schema.optional(NullableDateValue),
});
const OpenCodeUsagePayload = Schema.Struct({
  usage: Schema.Struct({
    rolling: Schema.optional(OpenCodeUsageWindow),
    weekly: Schema.optional(OpenCodeUsageWindow),
    monthly: Schema.optional(OpenCodeUsageWindow),
  }),
});
const decodeOpenCodeUsagePayload = Schema.decodeUnknownOption(OpenCodeUsagePayload);

const OPEN_CODE_WINDOWS = {
  rolling: { kind: "session", label: "Rolling" },
  weekly: { kind: "weekly", label: "Weekly" },
  monthly: { kind: "monthly", label: "Monthly" },
} as const satisfies Record<string, { kind: ServerProviderUsageWindow["kind"]; label: string }>;

export function parseOpenCodeUsageWindows(
  input: unknown,
): ReadonlyArray<ServerProviderUsageWindow> {
  const decoded = decodeOpenCodeUsagePayload(input);
  if (Option.isNone(decoded)) return [];
  const usage = decoded.value.usage;
  return Object.entries(OPEN_CODE_WINDOWS).flatMap(([id, shape]) => {
    const window = usage[id as keyof typeof usage];
    if (!window) return [];
    const parsed = usageWindow({
      id,
      kind: shape.kind,
      label: shape.label,
      usedPercent: window.percent,
      resetsAt: window.resetsAt,
    });
    return parsed ? [parsed] : [];
  });
}
