import * as NodeCrypto from "node:crypto";
import * as NodePlatformCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as GrantStore from "../../persistence/ExternalReadGrantStore.ts";
import { makeSqlitePersistenceLive } from "../../persistence/Layers/Sqlite.ts";
import Migration61 from "../../persistence/Migrations/061_ExternalReadGrants.ts";
import * as Access from "./ExternalReadAccess.ts";
import { accessLayer, allowed, environmentLayer, grant, identity, token } from "./testSupport.ts";

const nextToken = "external-read-next-test-fixture";
const nextGrant = {
  ...grant,
  id: "next-credential",
  principalId: "next-principal",
  tokenHash: NodeCrypto.createHash("sha256").update(nextToken).digest("hex"),
};
const registryLayer = (grants: ReadonlyArray<Access.ExternalReadGrant> = [grant]) =>
  Access.layer.pipe(
    Layer.fresh,
    Layer.provide(NodePlatformCrypto.layer),
    Layer.provide(environmentLayer),
    Layer.provide(Layer.succeed(Access.ExternalReadSettings, { enabled: true, grants })),
  );

it.effect.each([
  ["expire", "authenticate"],
  ["revoke", "authenticate"],
  ["expire", "authorize"],
  ["revoke", "authorize"],
] as const)("denies %s during a suspended durable read in %s", ([mode, operation]) =>
  Effect.gen(function* () {
    const store = yield* GrantStore.ExternalReadGrantStore;
    const queried = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const delayedStore = GrantStore.ExternalReadGrantStore.of({
      ...store,
      isActive: (binding) =>
        store.isActive(binding).pipe(
          Effect.tap(() => Deferred.succeed(queried, undefined)),
          Effect.tap(() => Deferred.await(release)),
        ),
    });
    yield* Effect.gen(function* () {
      const access = yield* Access.ExternalReadAccess;
      const pending = yield* Effect.forkScoped(
        operation === "authenticate"
          ? access.authenticate(token).pipe(Effect.map((result) => result === undefined))
          : access
              .authorize(identity, "threads.list", allowed)
              .pipe(Effect.match({ onSuccess: () => false, onFailure: () => true })),
      );
      yield* Deferred.await(queried);
      if (mode === "expire") yield* TestClock.setTime(grant.expiresAt);
      else yield* access.revoke(grant.id);
      yield* Deferred.succeed(release, undefined);
      expect(yield* Fiber.join(pending)).toBe(true);
    }).pipe(
      Effect.provide(
        registryLayer().pipe(
          Layer.provide(Layer.succeed(GrantStore.ExternalReadGrantStore, delayedStore)),
        ),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(accessLayer())),
);

it.effect("retains revoke after rebuilding and refuses re-registration or a renamed bearer", () =>
  Effect.gen(function* () {
    const access = yield* Access.ExternalReadAccess;
    const store = yield* GrantStore.ExternalReadGrantStore;
    expect(yield* access.authenticate(token)).toEqual(identity);
    yield* access.revoke(grant.id);
    const check = Effect.gen(function* () {
      const rebuilt = yield* Access.ExternalReadAccess;
      expect(yield* rebuilt.authenticate(token)).toBeUndefined();
      expect(
        yield* rebuilt.authorize(identity, "threads.list", allowed).pipe(Effect.flip),
      ).toMatchObject({ code: "access_denied" });
    });
    yield* check.pipe(Effect.provide(registryLayer()));
    expect(yield* store.register(Access.grantBinding(grant))).toBe(false);
    yield* check.pipe(Effect.provide(registryLayer()));
    const renamed = { ...grant, id: "renamed" };
    expect(yield* store.register(Access.grantBinding(renamed))).toBe(false);
    expect(
      yield* Effect.flatMap(Access.ExternalReadAccess, (registry) =>
        registry.authenticate(token),
      ).pipe(Effect.provide(registryLayer([renamed]))),
    ).toBeUndefined();
  }).pipe(Effect.provide(accessLayer())),
);

it.effect("allows only a separate explicitly registered grant after revoke", () =>
  Effect.gen(function* () {
    const access = yield* Access.ExternalReadAccess;
    const store = yield* GrantStore.ExternalReadGrantStore;
    yield* access.revoke(grant.id);
    const unknown = yield* Effect.flatMap(Access.ExternalReadAccess, (registry) =>
      registry.authenticate(nextToken),
    ).pipe(Effect.provide(registryLayer([grant, nextGrant])));
    expect(unknown).toBeUndefined();
    expect(yield* store.register(Access.grantBinding(nextGrant))).toBe(true);
    yield* Effect.gen(function* () {
      const rebuilt = yield* Access.ExternalReadAccess;
      expect(yield* rebuilt.authenticate(token)).toBeUndefined();
      expect(yield* rebuilt.authenticate(nextToken)).toEqual({
        credentialId: nextGrant.id,
        principalId: nextGrant.principalId,
      });
    }).pipe(Effect.provide(registryLayer([grant, nextGrant])));
  }).pipe(Effect.provide(accessLayer())),
);

it.effect("keeps absolute expiry and audience constraints after rebuilding", () =>
  Effect.gen(function* () {
    const store = yield* GrantStore.ExternalReadGrantStore;
    const wrongAudience = { ...nextGrant, audience: "other-audience" };
    expect(yield* store.register(Access.grantBinding(wrongAudience))).toBe(true);
    yield* TestClock.setTime(grant.expiresAt);
    yield* Effect.gen(function* () {
      const rebuilt = yield* Access.ExternalReadAccess;
      expect(yield* rebuilt.authenticate(token)).toBeUndefined();
      expect(yield* rebuilt.authenticate(nextToken)).toBeUndefined();
    }).pipe(Effect.provide(registryLayer([grant, wrongAudience])));
  }).pipe(Effect.provide(accessLayer())),
);

it.effect("rejects changed policy for the same stored credential", () =>
  Effect.gen(function* () {
    const store = yield* GrantStore.ExternalReadGrantStore;
    const changed = { ...grant, expiresAt: grant.expiresAt + 1000 };
    expect(yield* store.register(Access.grantBinding(changed))).toBe(false);
    expect(
      yield* Effect.flatMap(Access.ExternalReadAccess, (registry) =>
        registry.authenticate(token),
      ).pipe(Effect.provide(registryLayer([changed]))),
    ).toBeUndefined();
  }).pipe(Effect.provide(accessLayer())),
);

it.effect(
  "fails closed for missing/corrupt state and never registers configuration on rebuild",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const access = yield* Access.ExternalReadAccess;
      yield* sql`UPDATE external_read_grants SET policy_json = 'invalid-fixture-policy'`;
      expect(yield* access.authenticate(token)).toBeUndefined();
      yield* sql`DROP TABLE external_read_grants`;
      expect(yield* access.authenticate(token).pipe(Effect.flip)).toMatchObject({
        _tag: "ExternalReadCredentialError",
      });
      expect(
        yield* access.authorize(identity, "threads.list", allowed).pipe(Effect.flip),
      ).toMatchObject({ code: "access_denied" });
      expect(
        yield* Effect.flatMap(Access.ExternalReadAccess, (registry) =>
          registry.authenticate(token),
        ).pipe(Effect.provide(registryLayer()), Effect.flip),
      ).toMatchObject({ _tag: "ExternalReadCredentialError" });
      yield* Migration61;
      expect(
        yield* Effect.flatMap(Access.ExternalReadAccess, (registry) =>
          registry.authenticate(token),
        ).pipe(Effect.provide(registryLayer())),
      ).toBeUndefined();
      expect(yield* sql`SELECT credential_id FROM external_read_grants`).toEqual([]);
    }).pipe(Effect.provide(accessLayer())),
);

it.effect("reports failed durable writes and denies the credential in the current runtime", () =>
  Effect.gen(function* () {
    const access = yield* Access.ExternalReadAccess;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`DROP TABLE external_read_grants`;
    expect(yield* access.revoke(grant.id).pipe(Effect.flip)).toMatchObject({
      _tag: "ExternalReadGrantStoreError",
      operation: "revoke",
    });
    expect(yield* access.authenticate(token)).toBeUndefined();
    expect(
      yield* access.authorize(identity, "threads.list", allowed).pipe(Effect.flip),
    ).toMatchObject({ code: "access_denied" });
  }).pipe(Effect.provide(accessLayer())),
);

it.effect("persists revoke/revokeAll across closed and reopened fixture database connections", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({
        directory: "/tmp",
        prefix: "t3-external-read-fixture-",
      });
      const disk = registryLayer([grant, nextGrant]).pipe(
        Layer.provideMerge(GrantStore.layer),
        Layer.provideMerge(makeSqlitePersistenceLive(path.join(directory, "fixture.sqlite"))),
        Layer.fresh,
      );
      yield* Effect.gen(function* () {
        const store = yield* GrantStore.ExternalReadGrantStore;
        const access = yield* Access.ExternalReadAccess;
        expect(yield* store.register(Access.grantBinding(grant))).toBe(true);
        expect(yield* store.register(Access.grantBinding(nextGrant))).toBe(true);
        expect(yield* access.authenticate(token)).toEqual(identity);
        yield* access.revoke(grant.id);
      }).pipe(Effect.provide(disk));
      yield* Effect.gen(function* () {
        const store = yield* GrantStore.ExternalReadGrantStore;
        const access = yield* Access.ExternalReadAccess;
        expect(yield* store.register(Access.grantBinding(grant))).toBe(false);
        expect(yield* access.authenticate(token)).toBeUndefined();
        expect(yield* access.authenticate(nextToken)).toEqual({
          credentialId: nextGrant.id,
          principalId: nextGrant.principalId,
        });
        yield* access.revokeAll;
      }).pipe(Effect.provide(disk));
      yield* Effect.gen(function* () {
        const access = yield* Access.ExternalReadAccess;
        expect(yield* access.authenticate(token)).toBeUndefined();
        expect(yield* access.authenticate(nextToken)).toBeUndefined();
        const sql = yield* SqlClient.SqlClient;
        expect(
          (yield* sql`SELECT credential_id FROM external_read_grants WHERE revoked_at IS NOT NULL`)
            .length,
        ).toBe(2);
      }).pipe(Effect.provide(disk));
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "keeps persisted grants denied locally after failed individual and revoke-all writes",
  () =>
    Effect.gen(function* () {
      const store = yield* GrantStore.ExternalReadGrantStore;
      yield* store.register(Access.grantBinding(grant));
      yield* store.register(Access.grantBinding(nextGrant));
      const failedWrites = GrantStore.ExternalReadGrantStore.of({
        ...store,
        revoke: () =>
          Effect.fail(
            new GrantStore.ExternalReadGrantStoreError({
              operation: "revoke",
              cause: "synthetic write failure",
            }),
          ),
        revokeAll: () =>
          Effect.fail(
            new GrantStore.ExternalReadGrantStoreError({
              operation: "revoke_all",
              cause: "synthetic write failure",
            }),
          ),
      });
      yield* Effect.gen(function* () {
        const access = yield* Access.ExternalReadAccess;
        expect(yield* access.authenticate(token)).toEqual(identity);
        yield* access.revoke(grant.id).pipe(Effect.flip);
        expect(yield* access.authenticate(token)).toBeUndefined();
        expect(yield* access.authenticate(nextToken)).toMatchObject({ credentialId: nextGrant.id });
        yield* access.revokeAll.pipe(Effect.flip);
        expect(yield* store.isActive(Access.grantBinding(nextGrant))).toBe(true);
        expect(yield* access.authenticate(nextToken)).toBeUndefined();
        expect(
          yield* access.authorize(identity, "threads.list", allowed).pipe(Effect.flip),
        ).toMatchObject({ code: "access_denied" });
      }).pipe(
        Effect.provide(
          Access.layer.pipe(
            Layer.fresh,
            Layer.provide(Layer.succeed(GrantStore.ExternalReadGrantStore, failedWrites)),
            Layer.provide(NodePlatformCrypto.layer),
            Layer.provide(
              Layer.succeed(Access.ExternalReadSettings, {
                enabled: true,
                grants: [],
                persistedGrants: true,
              }),
            ),
          ),
        ),
      );
    }).pipe(Effect.provide(accessLayer([], true))),
);
