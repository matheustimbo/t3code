import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/http";

import {
  readCliProxyGrokUsageLimits,
  resolveCliProxyManagementConfig,
} from "./providerUsageLimitReaders.ts";

const environment = {
  CLIPROXYAPI_MANAGEMENT_KEY: "management-key",
  XAI_BASE_URL: "https://hub.test/v1",
};
const ApiCall = Schema.Struct({
  auth_index: Schema.String,
  method: Schema.String,
  url: Schema.String,
  header: Schema.Record(Schema.String, Schema.String),
});
const decodeApiCall = Schema.decodeUnknownSync(Schema.fromJsonString(ApiCall));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

function fixture(
  files: ReadonlyArray<unknown>,
  respond: (call: typeof ApiCall.Type) => { status: number; body: unknown },
) {
  const calls: Array<typeof ApiCall.Type> = [];
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      expect(request.headers.authorization).toBe("Bearer management-key");
      if (request.url.endsWith("/auth-files")) {
        return HttpClientResponse.fromWeb(request, Response.json({ files }));
      }
      expect(request.url).toBe("https://hub.test/v0/management/api-call");
      if (request.body._tag !== "Uint8Array") throw new Error("Expected JSON API call");
      const call = decodeApiCall(new TextDecoder().decode(request.body.body));
      calls.push(call);
      const result = respond(call);
      return HttpClientResponse.fromWeb(
        request,
        Response.json({ status_code: result.status, body: encodeJson(result.body) }),
      );
    }),
  );
  return {
    calls,
    read: readCliProxyGrokUsageLimits(environment).pipe(
      Effect.provideService(HttpClient.HttpClient, client),
    ),
  };
}

describe("Grok CLIProxyAPI usage limits", () => {
  it("infers management origin from every supported provider base and preserves an explicit path", () => {
    for (const key of [
      "ANTHROPIC_BASE_URL",
      "OPENAI_BASE_URL",
      "CODEX_BASE_URL",
      "XAI_BASE_URL",
      "GROK_BASE_URL",
    ]) {
      expect(
        resolveCliProxyManagementConfig({
          CLIPROXYAPI_MANAGEMENT_KEY: " key ",
          [key]: "https://hub.test/v1?ignored=true",
        }),
      ).toEqual({
        apiBaseUrl: "https://hub.test/v0/management",
        dashboardUrl: "https://hub.test/management.html#/quota",
        key: "key",
      });
    }
    expect(
      resolveCliProxyManagementConfig({
        ...environment,
        CLIPROXYAPI_MANAGEMENT_URL: "https://hub.test/proxy/v0/management/auth-files#ignored",
      })?.apiBaseUrl,
    ).toBe("https://hub.test/proxy/v0/management");
    expect(
      resolveCliProxyManagementConfig({ XAI_BASE_URL: "https://hub.test/v1" }),
    ).toBeUndefined();
  });

  it.effect(
    "isolates accounts, skips disabled and unrelated accounts, and keeps partial successes",
    () =>
      Effect.gen(function* () {
        const test = fixture(
          [
            {
              auth_index: "a",
              name: "first",
              provider: "x-ai",
              label: "First",
              metadata: { oauth: { sub: "user-a" } },
            },
            { auth_index: "b", name: "second", type: "grok", email: "second@example.com" },
            { auth_index: "c", name: "broken", provider: "x_ai" },
            ...[true, 1, "true"].map((disabled, index) => ({
              auth_index: `disabled-${index}`,
              name: "disabled",
              provider: "xai",
              disabled,
            })),
            { auth_index: "codex", name: "codex", provider: "codex" },
            { auth_index: "claude", name: "claude", provider: "claude" },
          ],
          (call) => {
            expect(call.method).toBe("GET");
            expect(call.header.Authorization).toBe("Bearer $TOKEN$");
            expect(call.header["x-xai-token-auth"]).toBe("xai-grok-cli");
            expect(call.header["x-userid"]).toBe(call.auth_index === "a" ? "user-a" : undefined);
            if (
              call.auth_index === "c" ||
              (call.auth_index === "a" && call.url.endsWith("format=credits"))
            )
              return { status: 503, body: {} };
            return {
              status: 200,
              body: {
                config: {
                  credit_usage_percent: call.auth_index === "a" ? "25" : 70,
                  current_period: { type: "weekly", end: "2026-10-10T00:00:00Z" },
                },
              },
            };
          },
        );
        const limits = yield* test.read;
        expect(
          limits.windows.map(({ id, label, usedPercent }) => ({ id, label, usedPercent })),
        ).toEqual([
          { id: "first:weekly", label: "First · Weekly", usedPercent: 25 },
          {
            id: "second_example_com:weekly",
            label: "second@example.com · Weekly",
            usedPercent: 70,
          },
        ]);
        expect(test.calls.map((call) => call.auth_index).sort()).toEqual([
          "a",
          "a",
          "b",
          "b",
          "c",
          "c",
        ]);
      }),
  );

  it.effect("reads user IDs from flat and nested account fields without requiring them", () =>
    Effect.gen(function* () {
      for (const identity of [
        { user_id: "user" },
        { attributes: { userId: "user" } },
        { oauth: { subject: "user" } },
        { user: { id: "user" } },
        {},
      ]) {
        const test = fixture(
          [{ auth_index: "a", name: "Account", provider: "X_AI", ...identity }],
          (call) => {
            expect(call.header["x-userid"]).toBe(Object.keys(identity).length ? "user" : undefined);
            return { status: 200, body: { config: { creditUsagePercent: 10 } } };
          },
        );
        expect((yield* test.read).windows).toHaveLength(1);
      }
    }),
  );

  it.effect("reports a read failure when every account request fails", () =>
    Effect.gen(function* () {
      const test = fixture([{ auth_index: "a", name: "Account", provider: "grok" }], () => ({
        status: 401,
        body: {},
      }));
      const result = yield* test.read.pipe(Effect.flip);
      expect(result.message).toBe(
        "No Grok account behind CLIProxyAPI reported subscription windows.",
      );
    }),
  );
});
