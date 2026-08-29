import { assert, it } from "@effect/vitest";

import {
  parseClaudeUsageWindows,
  parseCursorUsageWindows,
  parseGrokUsageWindows,
  parseOpenCodeUsageWindows,
} from "./providerUsageLimits.ts";

it("normalizes Claude windows", () => {
  const windows = parseClaudeUsageWindows({
    five_hour: { utilization: 22.5, resets_at: 1_800_000_000 },
    seven_day: { used_percentage: 60, resets_at: "2027-01-15T12:00:00.000Z" },
    seven_day_oauth_apps: { utilization: 75, resets_at: "2027-01-16T12:00:00.000Z" },
    extra_usage: { utilization: 10 },
  });
  assert.deepStrictEqual(
    windows.map((window) => ({ id: window.id, remaining: window.remainingPercent })),
    [
      { id: "five_hour", remaining: 77.5 },
      { id: "seven_day", remaining: 40 },
      { id: "seven_day_oauth_apps", remaining: 25 },
      { id: "extra_usage", remaining: 90 },
    ],
  );
});

it("normalizes Cursor billing-cycle usage", () => {
  const [window] = parseCursorUsageWindows({
    billingCycleEnd: "2027-01-31T00:00:00.000Z",
    planUsage: { remaining: 25, limit: 100 },
  });
  assert.strictEqual(window?.remainingPercent, 25);
  assert.strictEqual(window?.resetsAt, "2027-01-31T00:00:00.000Z");
});

it("normalizes Grok weekly usage", () => {
  const [window] = parseGrokUsageWindows({
    config: {
      creditUsagePercent: 42.5,
      currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end: "2027-02-01T00:00:00Z" },
    },
  });
  assert.strictEqual(window?.id, "weekly");
  assert.strictEqual(window?.remainingPercent, 57.5);
});

it("normalizes every OpenCode Go window", () => {
  const windows = parseOpenCodeUsageWindows({
    usage: {
      rolling: { percent: 34, resetsAt: "2027-02-01T01:00:00Z" },
      weekly: { percent: 51, resetsAt: "2027-02-07T00:00:00Z" },
      monthly: { percent: 100, resetsAt: "2027-03-01T00:00:00Z" },
    },
  });
  assert.deepStrictEqual(
    windows.map((window) => window.remainingPercent),
    [66, 49, 0],
  );
});
