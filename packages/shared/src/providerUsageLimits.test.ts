import { describe, expect, it } from "vite-plus/test";

import {
  displayRemainingPercent,
  formatLimitReset,
  formatRemainingPercent,
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
});
