import { describe, expect, it } from "vite-plus/test";

import {
  accountEmailFromAuthFile,
  claudePlanLabel,
  claudeUsagePayloadToLimits,
  codexUsagePayloadToLimits,
} from "./cliproxyUsageLimits.ts";

const checkedAt = "2026-09-03T22:00:00.000Z";

describe("claudeUsagePayloadToLimits", () => {
  // Trimmed from a live `/api/oauth/usage` replayed through the hub.
  it("draws the same windows the local Claude login draws", () => {
    const limits = claudeUsagePayloadToLimits(
      {
        five_hour: { utilization: 0, resets_at: "2026-09-04T02:00:00Z" },
        seven_day: { utilization: 51, resets_at: "2026-09-07T07:59:59Z" },
        limits: [
          {
            kind: "weekly_scoped",
            percent: 100,
            resets_at: "2026-09-07T07:59:59Z",
            is_active: true,
            scope: { model: { display_name: "Fable" } },
          },
          // A non-scoped entry must not open a row.
          { kind: "five_hour", percent: 3 },
        ],
      },
      checkedAt,
    );

    expect(limits.windows).toEqual([
      {
        id: "five_hour",
        kind: "session",
        label: "Session",
        usedPercent: 0,
        windowDurationMins: 300,
        resetsAt: "2026-09-04T02:00:00.000Z",
      },
      {
        id: "seven_day",
        kind: "weekly",
        label: "Weekly",
        usedPercent: 51,
        windowDurationMins: 10080,
        resetsAt: "2026-09-07T07:59:59.000Z",
      },
      {
        id: "seven_day_fable",
        kind: "weekly",
        label: "Weekly · Fable",
        usedPercent: 100,
        windowDurationMins: 10080,
        resetsAt: "2026-09-07T07:59:59.000Z",
      },
    ]);
  });

  it("reports unsupported rather than empty bars when the payload is unreadable", () => {
    expect(claudeUsagePayloadToLimits({ nonsense: true }, checkedAt).windows).toEqual([]);
    expect(claudeUsagePayloadToLimits("not json at all", checkedAt).unavailable?.reason).toBe(
      "unsupported",
    );
  });
});

describe("codexUsagePayloadToLimits", () => {
  // `wham/usage` counts down in seconds; the shared mapper wants an epoch.
  it("anchors the reset countdown to the moment of the read", () => {
    const nowMs = Date.parse("2026-09-03T22:00:00.000Z");
    const limits = codexUsagePayloadToLimits(
      {
        plan_type: "pro",
        rate_limit: {
          primary_window: {
            used_percent: 20,
            limit_window_seconds: 18000,
            reset_after_seconds: 3600,
          },
          secondary_window: {
            used_percent: 12,
            limit_window_seconds: 604800,
            reset_after_seconds: 86400,
          },
        },
      },
      checkedAt,
      nowMs,
    );

    expect(limits?.windows).toEqual([
      {
        id: "primary",
        kind: "session",
        label: "Session",
        usedPercent: 20,
        windowDurationMins: 300,
        resetsAt: "2026-09-03T23:00:00.000Z",
      },
      {
        id: "secondary",
        kind: "weekly",
        label: "Weekly",
        usedPercent: 12,
        windowDurationMins: 10080,
        resetsAt: "2026-09-04T22:00:00.000Z",
      },
    ]);
  });

  it("yields nothing when the account reports no rate limit at all", () => {
    expect(codexUsagePayloadToLimits({ plan_type: "pro" }, checkedAt, 0)).toBeUndefined();
    expect(codexUsagePayloadToLimits({ rate_limit: {} }, checkedAt, 0)).toBeUndefined();
  });
});

describe("claudePlanLabel", () => {
  it("reads the subscription tier off the profile payload", () => {
    expect(claudePlanLabel({ account: { has_claude_max: true } })).toBe("Max");
    expect(claudePlanLabel({ account: { has_claude_pro: 1 } })).toBe("Pro");
    expect(claudePlanLabel({ account: {} })).toBeUndefined();
  });
});

describe("accountEmailFromAuthFile", () => {
  it("pulls the email out of the hub's auth file names", () => {
    expect(accountEmailFromAuthFile("claude-julius@ping.gg.json")).toBe("julius@ping.gg");
    expect(accountEmailFromAuthFile("codex-e413dce6-julius@ping.gg-pro.json")).toBe(
      "julius@ping.gg",
    );
    expect(accountEmailFromAuthFile("claude-first-last@example.com.json")).toBe(
      "first-last@example.com",
    );
    expect(accountEmailFromAuthFile("mystery.json")).toBeUndefined();
  });
});
