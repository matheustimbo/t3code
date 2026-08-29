import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import {
  makePooledUsageLimitsSnapshot,
  makeUnavailableUsageLimitsAccount,
  parseClaudeUsageWindows,
  parseCursorUsageWindows,
  parseGrokUsageWindows,
  parseOpenCodeUsageWindows,
} from "./providerUsageLimits.ts";
import {
  parseCliProxyClaudeAuthFiles,
  readClaudeUsageLimits,
  resolveCliProxyManagementConfig,
} from "./providerUsageLimitReaders.ts";

const decodeCliProxyRequestBody = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ auth_index: Schema.String })),
);
const encodeUnknownJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

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

it("keeps CLIProxyAPI Claude accounts separate", () => {
  const accounts = parseCliProxyClaudeAuthFiles({
    files: [
      {
        auth_index: "claude-one",
        name: "claude-one.json",
        provider: "claude",
        email: "one@example.com",
      },
      {
        auth_index: "codex-one",
        name: "codex-one.json",
        provider: "codex",
        email: "one@example.com",
      },
    ],
  });

  assert.deepStrictEqual(
    accounts.map((account) => account.auth_index),
    ["claude-one"],
  );
});

it("infers the CLIProxyAPI management API from the Anthropic base URL", () => {
  const config = resolveCliProxyManagementConfig({
    ANTHROPIC_BASE_URL: "http://127.0.0.1:8317/v1",
    CLIPROXYAPI_MANAGEMENT_KEY: "management-secret",
  });

  assert.deepStrictEqual(config, {
    apiBaseUrl: "http://127.0.0.1:8317/v0/management",
    dashboardUrl: "http://127.0.0.1:8317/management.html#/quota",
    key: "management-secret",
  });
});

it("keeps an explicit CLIProxyAPI reverse-proxy path", () => {
  const config = resolveCliProxyManagementConfig({
    CLIPROXYAPI_MANAGEMENT_URL: "https://example.com/cliproxy",
    CLIPROXYAPI_MANAGEMENT_KEY: "management-secret",
  });

  assert.strictEqual(config?.apiBaseUrl, "https://example.com/cliproxy/v0/management");
  assert.strictEqual(config?.dashboardUrl, "https://example.com/cliproxy/management.html#/quota");
});

it("marks a CLIProxyAPI pool partial without aggregating account windows", () => {
  const checkedAt = "2026-08-29T12:00:00.000Z";
  const snapshot = makePooledUsageLimitsSnapshot({
    source: "cliproxyapi-management",
    support: "experimental",
    checkedAt,
    accounts: [
      {
        id: "one",
        email: "one@example.com",
        status: "available",
        support: "experimental",
        source: "cliproxyapi-management",
        checkedAt,
        windows: [{ id: "five_hour", label: "5 hours", remainingPercent: 80 }],
      },
      makeUnavailableUsageLimitsAccount({
        id: "two",
        email: "two@example.com",
        source: "cliproxyapi-management",
        support: "experimental",
        checkedAt,
        status: "error",
        message: "Unavailable",
      }),
    ],
  });

  assert.strictEqual(snapshot.status, "partial");
  assert.deepStrictEqual(snapshot.windows, []);
  assert.strictEqual(snapshot.accounts?.length, 2);
});

it.effect("reads every CLIProxyAPI Claude account through its stable auth index", () =>
  Effect.gen(function* () {
    const requestedAuthIndexes: Array<string> = [];
    const client = HttpClient.make((request) =>
      Effect.sync(() => {
        if (request.url.endsWith("/auth-files")) {
          return HttpClientResponse.fromWeb(
            request,
            Response.json({
              files: [
                {
                  auth_index: "auth-one",
                  name: "claude-one.json",
                  provider: "claude",
                  email: "one@example.com",
                },
                {
                  auth_index: "auth-two",
                  name: "claude-two.json",
                  provider: "claude",
                  email: "two@example.com",
                },
              ],
            }),
          );
        }
        const bodyText =
          request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "{}";
        const authIndex = decodeCliProxyRequestBody(bodyText).auth_index;
        requestedAuthIndexes.push(authIndex);
        return HttpClientResponse.fromWeb(
          request,
          Response.json({
            status_code: 200,
            body: encodeUnknownJson({
              five_hour: {
                utilization: authIndex === "auth-one" ? 20 : 70,
                resets_at: "2026-08-29T17:00:00.000Z",
              },
            }),
          }),
        );
      }),
    );

    const limits = yield* readClaudeUsageLimits(
      { homePath: "" },
      {
        ANTHROPIC_BASE_URL: "http://127.0.0.1:8317",
        CLIPROXYAPI_MANAGEMENT_KEY: "management-secret",
      },
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(HttpClient.HttpClient, client),
          FileSystem.layerNoop({}),
          Path.layer,
        ),
      ),
    );

    assert.deepStrictEqual(requestedAuthIndexes.toSorted(), ["auth-one", "auth-two"]);
    assert.deepStrictEqual(
      limits.accounts?.map((account) => account.windows[0]?.remainingPercent),
      [80, 30],
    );
    assert.deepStrictEqual(limits.windows, []);
  }),
);
