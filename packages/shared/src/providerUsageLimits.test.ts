import { describe, expect, it } from "vite-plus/test";

import {
  areProviderUsageLimitsOutOfDate,
  displayRemainingPercent,
  formatCompactLimitReset,
  formatCompactRemainingPercent,
  formatLimitReset,
  formatRemainingPercent,
  providerUsageLimitDisplayGroups,
  providerUsageLimitDisplayWindows,
  providerUsageLimitMostRestrictiveWindowId,
  usageLimitsStatusLabel,
} from "./providerUsageLimits.ts";

describe("provider usage-limit formatting", () => {
  it("hides a stale percentage after its reset", () => {
    expect(
      displayRemainingPercent(
        {
          status: "stale",
          support: "experimental",
          source: "test",
          checkedAt: "2026-08-29T12:00:00.000Z",
          windows: [],
        },
        {
          id: "weekly",
          label: "Weekly",
          remainingPercent: 20,
          resetsAt: "2026-08-29T13:00:00.000Z",
        },
        Date.parse("2026-08-29T14:00:00.000Z"),
      ),
    ).toBeUndefined();
  });

  it("treats an available snapshot older than two minutes as out of date", () => {
    const limits = {
      status: "available",
      support: "supported",
      source: "test",
      checkedAt: "2026-08-29T12:00:00.000Z",
      windows: [],
    } as const;

    expect(areProviderUsageLimitsOutOfDate(limits, Date.parse("2026-08-29T12:02:01.000Z"))).toBe(
      true,
    );
    expect(usageLimitsStatusLabel(limits, Date.parse("2026-08-29T12:02:01.000Z"))).toBe(
      "Out of date",
    );
    expect(
      usageLimitsStatusLabel(
        { ...limits, status: "disabled" },
        Date.parse("2026-08-29T12:02:01.000Z"),
      ),
    ).toBe("Disabled");
  });

  it("formats compact reset and remaining labels", () => {
    expect(formatRemainingPercent(24.6)).toBe("25% remaining");
    expect(formatCompactRemainingPercent(24.6)).toBe("25%");
    expect(formatCompactRemainingPercent(undefined)).toBe("—");
    expect(
      formatLimitReset("2026-08-29T14:00:00.000Z", Date.parse("2026-08-29T12:30:00.000Z")),
    ).toBe("Resets in 2h");
    expect(
      formatCompactLimitReset("2026-08-29T14:00:00.000Z", Date.parse("2026-08-29T12:30:00.000Z")),
    ).toBe("2h");
  });

  it("expands pooled account windows without combining them", () => {
    const limits = {
      status: "available",
      support: "experimental",
      source: "cliproxyapi-management",
      checkedAt: "2026-08-29T12:00:00.000Z",
      windows: [],
      accounts: [
        {
          id: "one",
          email: "one@example.com",
          status: "available",
          support: "experimental",
          source: "cliproxyapi-management",
          checkedAt: "2026-08-29T12:00:00.000Z",
          windows: [{ id: "five_hour", label: "5 hours", remainingPercent: 80 }],
        },
        {
          id: "two",
          email: "two@example.com",
          status: "available",
          support: "experimental",
          source: "cliproxyapi-management",
          checkedAt: "2026-08-29T12:00:00.000Z",
          windows: [{ id: "five_hour", label: "5 hours", remainingPercent: 20 }],
        },
      ],
    } as const;
    const groups = providerUsageLimitDisplayGroups(limits);
    const windows = providerUsageLimitDisplayWindows(limits);

    expect(groups.map((group) => group.label)).toEqual(["one@example.com", "two@example.com"]);
    expect(groups.map((group) => group.windows[0]?.label)).toEqual(["5 hours", "5 hours"]);

    expect(windows.map((entry) => entry.label)).toEqual([
      "one@example.com · 5 hours",
      "two@example.com · 5 hours",
    ]);
    expect(windows.map((entry) => entry.window.remainingPercent)).toEqual([80, 20]);
    expect(providerUsageLimitMostRestrictiveWindowId(limits)).toBe("two:five_hour");
  });
});
