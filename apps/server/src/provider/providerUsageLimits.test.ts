import { assert, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import {
  makePooledUsageLimitsSnapshot,
  makeUsageLimitsSnapshot,
  makeUnavailableUsageLimitsAccount,
  parseCliProxyCodexUsageWindows,
  parseClaudePlanLabel,
  parseClaudeUsageWindows,
  parseCursorUsageWindows,
  parseGrokUsageWindows,
  parseOpenCodeUsageWindows,
  pollProviderUsageLimits,
} from "./providerUsageLimits.ts";
import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import {
  parseCliProxyAuthFiles,
  parseCliProxyClaudeAuthFiles,
  readClaudeUsageLimits,
  readCliProxyCodexUsageLimits,
  readCliProxyGrokUsageLimits,
  resolveCliProxyManagementConfig,
} from "./providerUsageLimitReaders.ts";

const decodeCliProxyRequestBody = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({ auth_index: Schema.String, url: Schema.optional(Schema.String) }),
  ),
);
const encodeUnknownJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

it.effect("polls usage limits while a client has demand even if foreground work is paused", () =>
  Effect.gen(function* () {
    const instanceId = ProviderInstanceId.make("codex");
    const checkedAt = "2026-08-30T12:00:00.000Z";
    const initialSnapshot: ServerProvider = {
      instanceId,
      driver: ProviderDriverKind.make("codex"),
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt,
      models: [],
      slashCommands: [],
      skills: [],
    };
    const snapshotRef = yield* Ref.make(initialSnapshot);
    const published = yield* Deferred.make<ServerProvider>();
    const now = DateTime.makeUnsafe(checkedAt);
    const policySnapshot = {
      hostPower: {
        source: "unknown",
        idle: "unknown",
        idleSeconds: null,
        locked: "unknown",
        suspended: false,
        onBattery: "unknown",
        lowPowerMode: "unknown",
        thermalState: "unknown",
        stale: true,
        updatedAt: now,
      },
      leases: [],
      activeForegroundLeaseCount: 0,
      activeScopeKeys: ["provider-status"],
      shouldRunOpportunisticWork: false,
      updatedAt: now,
    } as const;
    const backgroundPolicy = BackgroundPolicy.BackgroundPolicy.of({
      reportClientActivity: () => Effect.void,
      removeRpcClient: () => Effect.void,
      reportHostPowerState: () => Effect.void,
      snapshot: Effect.succeed(policySnapshot),
      streamChanges: Stream.empty,
      subscribe: Effect.succeed({
        latest: policySnapshot,
        changes: Stream.empty,
      }),
      hasDemand: () => Effect.succeed(true),
      shouldRunScopeWork: () => Effect.succeed(false),
      shouldRunOpportunisticWork: Effect.succeed(false),
    });

    const fiber = yield* pollProviderUsageLimits({
      instanceId,
      getSnapshot: Ref.get(snapshotRef),
      publishSnapshot: (snapshot) =>
        Ref.set(snapshotRef, snapshot).pipe(
          Effect.andThen(Deferred.succeed(published, snapshot)),
          Effect.asVoid,
        ),
      read: Effect.succeed(
        makeUsageLimitsSnapshot({
          source: "codex-app-server",
          support: "supported",
          checkedAt,
          windows: [{ id: "weekly", label: "7 days", remainingPercent: 75 }],
        }),
      ),
      backgroundPolicy,
    }).pipe(Effect.forkChild);

    const next = yield* Deferred.await(published);
    assert.strictEqual(next.usageLimits?.windows[0]?.remainingPercent, 75);
    yield* Fiber.interrupt(fiber);
  }),
);

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

it("normalizes nullable Claude windows and the modern Fable limit", () => {
  const windows = parseClaudeUsageWindows({
    five_hour: { utilization: 0, resets_at: null },
    seven_day: { utilization: 75, resets_at: "2026-09-01T23:59:00.000Z" },
    seven_day_oauth_apps: null,
    seven_day_opus: null,
    seven_day_sonnet: null,
    seven_day_cowork: null,
    iguana_necktie: null,
    limits: [
      { kind: "session", percent: 0, resets_at: null, is_active: false },
      {
        kind: "weekly_scoped",
        percent: 56,
        resets_at: "2026-09-01T23:59:00.000Z",
        is_active: true,
        scope: { model: { display_name: "Fable" } },
      },
    ],
  });

  assert.deepStrictEqual(
    windows.map((window) => ({
      id: window.id,
      label: window.label,
      remaining: window.remainingPercent,
    })),
    [
      { id: "five_hour", label: "5 hours", remaining: 100 },
      { id: "seven_day", label: "7 days", remaining: 25 },
      { id: "seven_day_fable", label: "7 days · Fable 5", remaining: 44 },
    ],
  );
});

it("reads Claude plan labels from account profiles", () => {
  assert.strictEqual(parseClaudePlanLabel({ account: { has_claude_max: true } }), "Max");
  assert.strictEqual(parseClaudePlanLabel({ account: { has_claude_pro: "true" } }), "Pro");
  assert.strictEqual(
    parseClaudePlanLabel({
      account: { has_claude_max: false, has_claude_pro: false },
      organization: { organization_type: "claude_team", subscription_status: "active" },
    }),
    "Team",
  );
  assert.strictEqual(
    parseClaudePlanLabel({ account: { has_claude_max: false, has_claude_pro: false } }),
    "Free",
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

it("normalizes Codex base, review, and additional windows from CLIProxyAPI", () => {
  const windows = parseCliProxyCodexUsageWindows(
    {
      rate_limit: {
        primary_window: {
          used_percent: "25",
          limit_window_seconds: 18_000,
          reset_at: 1_800_000_000,
        },
        secondary_window: {
          used_percent: 60,
          limit_window_seconds: 604_800,
          reset_after_seconds: 600,
        },
      },
      code_review_rate_limit: {
        primary_window: {
          used_percent: 10,
          limit_window_seconds: 18_000,
          reset_at: 1_800_000_100,
        },
      },
      additional_rate_limits: [
        {
          limit_name: "GPT-5.3-Codex-Spark",
          rate_limit: {
            primary_window: {
              used_percent: 5,
              limit_window_seconds: 604_800,
              reset_at: 1_800_000_200,
            },
          },
        },
      ],
    },
    1_700_000_000_000,
  );

  assert.deepStrictEqual(
    windows.map((window) => ({
      id: window.id,
      label: window.label,
      remaining: window.remainingPercent,
    })),
    [
      { id: "codex:primary", label: "5 hours", remaining: 75 },
      { id: "codex:secondary", label: "7 days", remaining: 40 },
      { id: "code-review:primary", label: "Code review · 5 hours", remaining: 90 },
      {
        id: "gpt-5-3-codex-spark:0:primary",
        label: "GPT-5.3-Codex-Spark · 7 days",
        remaining: 95,
      },
    ],
  );
  assert.strictEqual(windows[1]?.resetsAt, "2023-11-14T22:23:20.000Z");
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

it("normalizes Grok weekly products, monthly credits, and on-demand cap", () => {
  const windows = parseGrokUsageWindows({
    config: {
      credit_usage_percent: "30",
      current_period: {
        type: "USAGE_PERIOD_TYPE_WEEKLY",
        end: "2027-02-01T00:00:00Z",
      },
      product_usage: [{ product: "Grok Code", usage_percent: "45" }],
      monthly_limit: { val: "10000" },
      used: { val: 12_000 },
      on_demand_cap: { val: 5_000 },
      billing_period_end: "2027-03-01T00:00:00Z",
    },
  });

  assert.deepStrictEqual(
    windows.map((window) => ({ id: window.id, remaining: window.remainingPercent })),
    [
      { id: "weekly", remaining: 70 },
      { id: "weekly:grok-code:0", remaining: 55 },
      { id: "monthly_credits", remaining: 0 },
      { id: "on_demand", remaining: 60 },
    ],
  );
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

it("recognizes the CLIProxyAPI xAI provider aliases", () => {
  const payload = {
    files: [
      { auth_index: "xai-one", name: "xai.json", provider: "x-ai" },
      { auth_index: "xai-two", name: "grok.json", type: "grok" },
      { auth_index: "claude-one", name: "claude.json", provider: "claude" },
    ],
  };

  assert.deepStrictEqual(
    parseCliProxyAuthFiles(payload, "xai").map((account) => account.auth_index),
    ["xai-one", "xai-two"],
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

it("infers the CLIProxyAPI management API from a Codex-compatible base URL", () => {
  const config = resolveCliProxyManagementConfig({
    OPENAI_BASE_URL: "http://127.0.0.1:8317/v1",
    CLIPROXYAPI_MANAGEMENT_KEY: "management-secret",
  });

  assert.strictEqual(config?.apiBaseUrl, "http://127.0.0.1:8317/v0/management");
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
    const requestedCalls: Array<{ authIndex: string; url: string }> = [];
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
        const requestBody = decodeCliProxyRequestBody(bodyText);
        const authIndex = requestBody.auth_index;
        requestedCalls.push({ authIndex, url: requestBody.url ?? "" });
        return HttpClientResponse.fromWeb(
          request,
          Response.json({
            status_code: 200,
            body: encodeUnknownJson(
              requestBody.url?.endsWith("/profile")
                ? {
                    account: {
                      has_claude_max: authIndex === "auth-one",
                      has_claude_pro: authIndex === "auth-two",
                    },
                  }
                : {
                    five_hour: {
                      utilization: authIndex === "auth-one" ? 20 : 70,
                      resets_at: "2026-08-29T17:00:00.000Z",
                    },
                    seven_day_oauth_apps: null,
                  },
            ),
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

    assert.deepStrictEqual(requestedCalls.map((call) => call.authIndex).toSorted(), [
      "auth-one",
      "auth-one",
      "auth-two",
      "auth-two",
    ]);
    assert.deepStrictEqual([...new Set(requestedCalls.map((call) => call.url))].toSorted(), [
      "https://api.anthropic.com/api/oauth/profile",
      "https://api.anthropic.com/api/oauth/usage",
    ]);
    assert.deepStrictEqual(
      limits.accounts?.map((account) => ({
        plan: account.planLabel,
        remaining: account.windows[0]?.remainingPercent,
      })),
      [
        { plan: "Max", remaining: 80 },
        { plan: "Pro", remaining: 30 },
      ],
    );
    assert.deepStrictEqual(limits.windows, []);
  }),
);

it.effect("reads Codex CLIProxyAPI accounts without aggregating their windows", () =>
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
                  auth_index: "codex-one",
                  name: "codex-one.json",
                  provider: "codex",
                  email: "one@example.com",
                },
                {
                  auth_index: "codex-two",
                  name: "codex-two.json",
                  provider: "codex",
                  account: "must-not-be-displayed",
                },
                {
                  auth_index: "codex-disabled",
                  name: "codex-disabled.json",
                  provider: "codex",
                  disabled: "true",
                },
              ],
            }),
          );
        }
        const bodyText =
          request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "{}";
        const body = decodeCliProxyRequestBody(bodyText);
        requestedAuthIndexes.push(body.auth_index);
        assert.strictEqual(body.url, "https://chatgpt.com/backend-api/wham/usage");
        return HttpClientResponse.fromWeb(
          request,
          Response.json({
            status_code: 200,
            body: encodeUnknownJson({
              rate_limit: {
                primary_window: {
                  used_percent: body.auth_index === "codex-one" ? 20 : 70,
                  limit_window_seconds: 18_000,
                  reset_at: 1_800_000_000,
                },
              },
            }),
          }),
        );
      }),
    );

    const limits = yield* readCliProxyCodexUsageLimits({
      CLIPROXYAPI_MANAGEMENT_URL: "http://127.0.0.1:8317",
      CLIPROXYAPI_MANAGEMENT_KEY: "management-secret",
    }).pipe(Effect.provideService(HttpClient.HttpClient, client));

    assert.deepStrictEqual(requestedAuthIndexes.toSorted(), ["codex-one", "codex-two"]);
    assert.deepStrictEqual(
      limits.accounts?.map((account) => ({
        label: account.label,
        remaining: account.windows[0]?.remainingPercent,
      })),
      [
        { label: "one@example.com", remaining: 80 },
        { label: "codex-two.json", remaining: 30 },
        { label: "codex-disabled.json", remaining: undefined },
      ],
    );
    assert.strictEqual(limits.accounts?.[2]?.status, "disabled");
    assert.deepStrictEqual(limits.windows, []);
  }),
);

it.effect("reads only Grok billing endpoints for CLIProxyAPI xAI accounts", () =>
  Effect.gen(function* () {
    const requestedUrls: Array<string> = [];
    const client = HttpClient.make((request) =>
      Effect.sync(() => {
        if (request.url.endsWith("/auth-files")) {
          return HttpClientResponse.fromWeb(
            request,
            Response.json({
              files: [
                {
                  auth_index: "xai-one",
                  name: "xai-one.json",
                  provider: "grok",
                  email: "grok@example.com",
                },
              ],
            }),
          );
        }
        const bodyText =
          request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "{}";
        const body = decodeCliProxyRequestBody(bodyText);
        requestedUrls.push(body.url ?? "");
        const monthly = body.url?.endsWith("/v1/billing") ?? false;
        return HttpClientResponse.fromWeb(
          request,
          Response.json({
            status_code: 200,
            body: encodeUnknownJson(
              monthly
                ? {
                    config: {
                      monthlyLimit: { val: 10_000 },
                      used: { val: 2_500 },
                      billingPeriodEnd: "2027-03-01T00:00:00Z",
                    },
                  }
                : {
                    config: {
                      creditUsagePercent: 40,
                      currentPeriod: {
                        type: "weekly",
                        end: "2027-02-01T00:00:00Z",
                      },
                    },
                  },
            ),
          }),
        );
      }),
    );

    const limits = yield* readCliProxyGrokUsageLimits({
      CLIPROXYAPI_MANAGEMENT_URL: "http://127.0.0.1:8317",
      CLIPROXYAPI_MANAGEMENT_KEY: "management-secret",
    }).pipe(Effect.provideService(HttpClient.HttpClient, client));

    assert.deepStrictEqual(requestedUrls.toSorted(), [
      "https://cli-chat-proxy.grok.com/v1/billing",
      "https://cli-chat-proxy.grok.com/v1/billing?format=credits",
    ]);
    assert.deepStrictEqual(limits.accounts?.[0]?.windows.map((window) => window.id).toSorted(), [
      "monthly_credits",
      "weekly",
    ]);
  }),
);
