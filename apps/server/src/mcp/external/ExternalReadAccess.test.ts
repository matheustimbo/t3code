import { expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import * as Access from "./ExternalReadAccess.ts";
import { accessLayer, allowed, blocked, grant, identity, token } from "./testSupport.ts";

it.effect("uses an absolute validity window without extending it on successful reads", () =>
  Effect.gen(function* () {
    const access = yield* Access.ExternalReadAccess;
    yield* TestClock.setTime(99);
    expect(yield* access.authenticate(token)).toBeUndefined();
    yield* TestClock.setTime(100);
    expect(yield* access.authenticate(token)).toEqual(identity);
    yield* TestClock.setTime(999);
    expect(yield* access.authorize(identity, "threads.list", allowed)).toEqual({
      ...grant,
      notBefore: 100,
    });
    yield* TestClock.setTime(1000);
    expect(yield* access.authenticate(token)).toBeUndefined();
    expect(
      yield* access.authorize(identity, "threads.list", allowed).pipe(Effect.flip),
    ).toMatchObject({ code: "access_denied" });
  }).pipe(Effect.provide(accessLayer([{ ...grant, notBefore: 100 }]))),
);

it.effect.each([
  ["wrong audience", { audience: "provider-session" }, true],
  ["wrong environment", { environmentId: EnvironmentId.make("other") }, true],
  ["disabled policy", {}, false],
] as const)("rejects %s", ([_name, override, enabled]) =>
  Effect.gen(function* () {
    const access = yield* Access.ExternalReadAccess;
    expect(yield* access.authenticate(token)).toBeUndefined();
    expect(yield* access.authorize(identity, "projects.list").pipe(Effect.flip)).toMatchObject({
      code: "access_denied",
    });
  }).pipe(Effect.provide(accessLayer([{ ...grant, ...override }], enabled))),
);

it.effect("enforces exact operation/project allowlists and principal identity", () =>
  Effect.gen(function* () {
    const access = yield* Access.ExternalReadAccess;
    expect(yield* access.authorize(identity, "threads.list", allowed)).toMatchObject({
      id: "fixture",
    });
    for (const attempt of [
      access.authorize(identity, "projects.list"),
      access.authorize(identity, "threads.list", blocked),
      access.authorize({ ...identity, principalId: "provider-session" }, "threads.list", allowed),
    ]) {
      expect(yield* attempt.pipe(Effect.flip)).toMatchObject({ code: "access_denied" });
    }
    expect(yield* access.authenticate("provider-scoped-fixture")).toBeUndefined();
    expect(yield* access.authenticate("")).toBeUndefined();
    expect(yield* access.authenticate("x".repeat(4097))).toBeUndefined();
  }).pipe(Effect.provide(accessLayer([{ ...grant, operations: ["threads.list"] }]))),
);

it.effect("revokes both resolved identities and new authentication attempts", () =>
  Effect.gen(function* () {
    const access = yield* Access.ExternalReadAccess;
    expect(yield* access.authenticate(token)).toEqual(identity);
    yield* access.revoke(identity.credentialId);
    expect(yield* access.authenticate(token)).toBeUndefined();
    expect(yield* access.authorize(identity, "projects.list").pipe(Effect.flip)).toMatchObject({
      code: "access_denied",
    });
  }).pipe(Effect.provide(accessLayer())),
);

it.effect("revokes all fixture grants", () =>
  Effect.gen(function* () {
    const access = yield* Access.ExternalReadAccess;
    yield* access.revokeAll;
    expect(yield* access.authenticate(token)).toBeUndefined();
  }).pipe(Effect.provide(accessLayer())),
);

it.effect("fails closed for duplicate credential IDs or hashes", () =>
  Effect.gen(function* () {
    const result = yield* Effect.void.pipe(
      Effect.provide(accessLayer([grant, grant])),
      Effect.flip,
    );
    expect(result).toMatchObject({ _tag: "InvalidExternalReadPolicy", reason: "duplicate_grants" });
  }),
);
