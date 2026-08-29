import type {
  ProviderInstanceId,
  ServerProvider,
  ServerProviderUsageLimitWindow,
  ServerProviderUsageLimits,
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
          const usageLimits: ServerProviderUsageLimits =
            previous && previous.windows.length > 0
              ? {
                  ...previous,
                  status: "stale",
                  message: result.failure.message,
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

const GrokUsagePayload = Schema.Struct({
  config: Schema.Struct({
    creditUsagePercent: Schema.optional(Schema.Number),
    currentPeriod: Schema.optional(
      Schema.Struct({
        type: Schema.optional(Schema.String),
        end: Schema.optional(Schema.Union([Schema.String, Schema.Number, Schema.Null])),
      }),
    ),
  }),
});
const decodeGrokUsagePayload = Schema.decodeUnknownOption(GrokUsagePayload);

export function parseGrokUsageWindows(
  input: unknown,
): ReadonlyArray<ServerProviderUsageLimitWindow> {
  const decoded = decodeGrokUsagePayload(input);
  if (Option.isNone(decoded)) return [];
  const period = decoded.value.config.currentPeriod;
  const id = period?.type?.toLowerCase().includes("weekly") ? "weekly" : "billing_period";
  return [
    normalizedWindow({
      id,
      usedPercent: decoded.value.config.creditUsagePercent,
      resetsAt: period?.end,
    }),
  ];
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
