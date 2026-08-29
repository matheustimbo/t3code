import { describe, expect, it } from "vite-plus/test";

import {
  displayRemainingPercent,
  formatLimitReset,
  formatRemainingPercent,
  providerUsageLimitDisplayWindows,
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

  it("formats compact reset and remaining labels", () => {
    expect(formatRemainingPercent(24.6)).toBe("25% remaining");
    expect(
      formatLimitReset("2026-08-29T14:00:00.000Z", Date.parse("2026-08-29T12:30:00.000Z")),
    ).toBe("Resets in 2h");
  });

  it("expands pooled account windows without combining them", () => {
    const windows = providerUsageLimitDisplayWindows({
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
    });

    expect(windows.map((entry) => entry.label)).toEqual([
      "one@example.com · 5 hours",
      "two@example.com · 5 hours",
    ]);
    expect(windows.map((entry) => entry.window.remainingPercent)).toEqual([80, 20]);
  });
});
