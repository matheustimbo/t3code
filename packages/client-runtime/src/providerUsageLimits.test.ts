import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";

import { collectProviderUsageLimits } from "./providerUsageLimits.ts";

const provider = (email: string) =>
  ({
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: "1",
    status: "ready",
    auth: { status: "authenticated", email },
    checkedAt: "2026-08-29T12:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
  }) as const;

describe("collectProviderUsageLimits", () => {
  it("links the same reliably identified account without aggregating environments", () => {
    const result = collectProviderUsageLimits([
      {
        environmentId: EnvironmentId.make("one"),
        label: "Laptop",
        providers: [provider("Me@Example.com")],
      },
      {
        environmentId: EnvironmentId.make("two"),
        label: "Desktop",
        providers: [provider("me@example.com")],
      },
    ]);
    expect(result).toHaveLength(2);
    expect(result[0]?.entries[0]?.sharedAcrossEnvironments).toBe(true);
    expect(result[1]?.entries[0]?.accountKey).toBe("codex:me@example.com");
  });

  it("does not call duplicate instances in one environment cross-environment matches", () => {
    const result = collectProviderUsageLimits([
      {
        environmentId: EnvironmentId.make("one"),
        label: "Laptop",
        providers: [provider("me@example.com"), provider("me@example.com")],
      },
    ]);
    expect(result[0]?.entries.every((entry) => !entry.sharedAcrossEnvironments)).toBe(true);
  });

  it("expands independently metered proxy accounts without combining their windows", () => {
    const result = collectProviderUsageLimits([
      {
        environmentId: EnvironmentId.make("one"),
        label: "Laptop",
        providers: [
          {
            ...provider("proxy@example.com"),
            usageLimits: {
              status: "available",
              support: "experimental",
              source: "cliproxyapi-management",
              checkedAt: "2026-08-29T12:00:00.000Z",
              windows: [],
              accounts: [
                {
                  id: "auth-one",
                  email: "one@example.com",
                  status: "available",
                  support: "experimental",
                  source: "cliproxyapi-management",
                  checkedAt: "2026-08-29T12:00:00.000Z",
                  windows: [{ id: "five_hour", label: "5 hours", remainingPercent: 80 }],
                },
                {
                  id: "auth-two",
                  email: "two@example.com",
                  status: "available",
                  support: "experimental",
                  source: "cliproxyapi-management",
                  checkedAt: "2026-08-29T12:00:00.000Z",
                  windows: [{ id: "five_hour", label: "5 hours", remainingPercent: 20 }],
                },
              ],
            },
          },
        ],
      },
    ]);

    expect(result[0]?.entries.map((entry) => entry.accountLabel)).toEqual([
      "one@example.com",
      "two@example.com",
    ]);
    expect(result[0]?.entries.map((entry) => entry.limits?.windows[0]?.remainingPercent)).toEqual([
      80, 20,
    ]);
  });
});
