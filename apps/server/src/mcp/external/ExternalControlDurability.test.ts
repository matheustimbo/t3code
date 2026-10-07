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
import * as SqlClient from "effect/sql/SqlClient";
import { CommandCommitAuthorization } from "../../orchestration-v2/CommandCommitAuthorization.ts";
import * as GrantStore from "../../persistence/ExternalReadGrantStore.ts";
import * as Store from "../../persistence/ExternalControlStore.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as Access from "./ExternalReadAccess.ts";
import * as Control from "./ExternalControlService.ts";
import { allowed, environmentLayer, seed } from "./testSupport.ts";
import {
  controlGrant,
  controlIdentity,
  controlLayer,
  modelSelection,
} from "./controlTestSupport.ts";

const create = {
  projectId: allowed,
  requestKey: "durability-create",
  title: "Fixture",
  modelSelection,
  runtimeMode: "approval-required" as const,
  interactionMode: "plan" as const,
};
it.effect.each(["expire", "revoke"] as const)(
  "denies %s during an actual commit-state read, before append/outbox",
  (mode) =>
    Effect.gen(function* () {
      yield* seed;
      const service = yield* Control.ExternalControlService;
      const { threadId } = yield* service.create(controlIdentity, create);
      const sql = yield* SqlClient.SqlClient;
      const beforeEvents = yield* sql`SELECT COUNT(*) AS count FROM orchestration_v2_events`;
      const beforeEffects =
        yield* sql`SELECT COUNT(*) AS count FROM orchestration_v2_effect_outbox`;
      const store = yield* Store.ExternalControlStore;
      const grants = yield* GrantStore.ExternalReadGrantStore;
      const reached = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const revoking = yield* Deferred.make<void>();
      const decoratedGrants = GrantStore.ExternalReadGrantStore.of({
        ...grants,
        revoke: (...args) =>
          Deferred.succeed(revoking, undefined).pipe(Effect.andThen(grants.revoke(...args))),
      });
      const delayed = Store.ExternalControlStore.of({
        ...store,
        getState: (input) =>
          store.getState(input).pipe(
            Effect.tap(() =>
              Effect.gen(function* () {
                const authorization = yield* CommandCommitAuthorization;
                if (authorization === undefined) return;
                yield* Deferred.succeed(reached, undefined);
                yield* Deferred.await(release);
              }),
            ),
          ),
      });
      const registry = Access.layer.pipe(
        Layer.fresh,
        Layer.provide(Layer.succeed(GrantStore.ExternalReadGrantStore, decoratedGrants)),
        Layer.provide(
          Layer.succeed(Access.ExternalReadSettings, { enabled: true, grants: [controlGrant] }),
        ),
        Layer.provide(environmentLayer),
        Layer.provide(NodePlatformCrypto.layer),
      );
      yield* Effect.gen(function* () {
        const controller = yield* Control.ExternalControlService;
        const access = yield* Access.ExternalReadAccess;
        const attempt = yield* Effect.forkScoped(
          controller
            .send(controlIdentity, {
              projectId: allowed,
              threadId,
              requestKey: "suspended-send",
              text: "Synthetic",
              mode: "auto",
            })
            .pipe(Effect.flip),
        );
        yield* Deferred.await(reached);
        const revoke =
          mode === "revoke" ? yield* Effect.forkScoped(access.revoke(controlGrant.id)) : undefined;
        if (mode === "revoke") yield* Deferred.await(revoking);
        else yield* TestClock.setTime(controlGrant.expiresAt);
        yield* Deferred.succeed(release, undefined);
        expect(yield* Fiber.join(attempt)).toMatchObject({ code: "access_denied" });
        if (revoke !== undefined) yield* Fiber.join(revoke);
        expect(
          yield* sql`SELECT COUNT(*) AS count FROM orchestration_v2_projection_messages WHERE thread_id = ${threadId}`,
        ).toEqual([{ count: 0 }]);
        expect(yield* sql`SELECT COUNT(*) AS count FROM orchestration_v2_events`).toEqual(
          beforeEvents,
        );
        expect(yield* sql`SELECT COUNT(*) AS count FROM orchestration_v2_effect_outbox`).toEqual(
          beforeEffects,
        );
      }).pipe(
        Effect.provide(
          Control.layer.pipe(
            Layer.fresh,
            Layer.provide(Layer.succeed(Store.ExternalControlStore, delayed)),
            Layer.provideMerge(registry),
          ),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(controlLayer())),
);

it.effect(
  "retains identical create/send results across closed and reopened SQLite connections",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({
          directory: "/tmp",
          prefix: "external-control-db-",
        });
        const database = SqlitePersistence.layerFromPath(path.join(directory, "fixture.sqlite"));
        const fixture = controlLayer(controlGrant, database).pipe(Layer.fresh);
        const first = yield* Effect.gen(function* () {
          yield* seed;
          const service = yield* Control.ExternalControlService;
          const created = yield* service.create(controlIdentity, create);
          const input = {
            projectId: allowed,
            threadId: created.threadId,
            requestKey: "persistent-send",
            text: "Synthetic restart fixture",
            mode: "auto" as const,
          };
          return { created, sent: yield* service.send(controlIdentity, input), input };
        }).pipe(Effect.provide(fixture));
        yield* Effect.gen(function* () {
          const service = yield* Control.ExternalControlService;
          expect(yield* service.create(controlIdentity, create)).toEqual(first.created);
          expect(yield* service.send(controlIdentity, first.input)).toEqual(first.sent);
          expect(
            (yield* service.messages(controlIdentity, {
              projectId: allowed,
              threadId: first.created.threadId,
            })).total,
          ).toBe(1);
          const sql = yield* SqlClient.SqlClient;
          yield* sql`UPDATE external_control_requests SET result_json = NULL WHERE request_key = 'persistent-send'`;
        }).pipe(Effect.provide(fixture));
        yield* Effect.gen(function* () {
          const service = yield* Control.ExternalControlService;
          expect(yield* service.send(controlIdentity, first.input)).toEqual(first.sent);
          expect(
            (yield* service.messages(controlIdentity, {
              projectId: allowed,
              threadId: first.created.threadId,
            })).total,
          ).toBe(1);
          yield* (yield* Access.ExternalReadAccess).revoke(controlGrant.id);
        }).pipe(Effect.provide(fixture));
        yield* Effect.gen(function* () {
          const service = yield* Control.ExternalControlService;
          expect(yield* service.create(controlIdentity, create).pipe(Effect.flip)).toMatchObject({
            code: "access_denied",
          });
          expect(yield* service.send(controlIdentity, first.input).pipe(Effect.flip)).toMatchObject(
            { code: "access_denied" },
          );
        }).pipe(Effect.provide(fixture));
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
);
