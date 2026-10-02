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
