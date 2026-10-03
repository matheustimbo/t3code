import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import {
  EnvironmentId,
  ExternalMcpTool,
  ProjectId,
  ProviderInteractionMode,
  RuntimeMode,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as GrantStore from "../../persistence/ExternalReadGrantStore.ts";
import * as Access from "./ExternalReadAccess.ts";
import * as Configuration from "./ExternalMcpConfig.ts";

const operations: Record<ExternalMcpTool, Access.ExternalReadOperation> = {
  external_project_list: "projects.list",
  external_thread_list: "threads.list",
  external_thread_status: "threads.status",
  external_thread_messages: "threads.messages",
  external_thread_create: "threads.create",
  external_thread_send: "threads.send",
  external_thread_interrupt: "threads.interrupt",
};
export const Policy = Schema.Struct({
  environmentId: EnvironmentId,
  projectId: ProjectId,
  principalId: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  ttlSeconds: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1800 })),
  tools: Schema.Array(ExternalMcpTool).check(Schema.isMinLength(1), Schema.isMaxLength(7)),
  runtimeModeCeiling: RuntimeMode,
  interactionModeCeiling: ProviderInteractionMode,
});
export type Policy = typeof Policy.Type;
export class ExternalMcpAdminError extends Schema.TaggedError<ExternalMcpAdminError>()(
  "ExternalMcpAdminError",
  {
    code: Schema.Literals([
      "invalid_policy",
      "wrong_environment",
      "not_found",
      "persistence_failed",
    ]),
  },
) {
  override get message(): string {
    return `External MCP administration failed (${this.code}).`;
  }
}
export class ExternalMcpTarget extends Context.Service<
  ExternalMcpTarget,
  Configuration.ExternalMcpHome
>()("t3/mcp/external/ExternalMcpAdmin/ExternalMcpTarget") {}
export class ExternalMcpAdmin extends Context.Service<
  ExternalMcpAdmin,
  {
    readonly register: (
      policy: Policy,
      id: string,
      tokenHash: string,
    ) => Effect.Effect<Access.ExternalReadGrant, ExternalMcpAdminError>;
    readonly list: Effect.Effect<
      ReadonlyArray<
        Omit<Access.ExternalReadGrant, "tokenHash"> & { readonly revokedAt: number | null }
      >,
      ExternalMcpAdminError
    >;
    readonly revoke: (id: string) => Effect.Effect<void, ExternalMcpAdminError>;
  }
>()("t3/mcp/external/ExternalMcpAdmin") {}
const decodePolicy = Schema.decodeUnknownEffect(Policy);
const decodeGrant = Schema.decodeUnknownEffect(Access.ExternalReadGrant);
const decodeStoredGrant = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Access.ExternalReadGrant),
);
const make = Effect.gen(function* () {
  const home = yield* ExternalMcpTarget;
  const grants = yield* GrantStore.ExternalReadGrantStore;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const persistence = () => new ExternalMcpAdminError({ code: "persistence_failed" });
  return ExternalMcpAdmin.of({
    register: (input, id, tokenHash) =>
      Effect.gen(function* () {
        const policy = yield* decodePolicy(input, {
          onExcessProperty: "error",
        }).pipe(Effect.mapError(() => new ExternalMcpAdminError({ code: "invalid_policy" })));
        if (policy.environmentId !== home.environmentId)
          return yield* new ExternalMcpAdminError({ code: "wrong_environment" });
        const project = yield* projects.get(policy.projectId).pipe(Effect.mapError(persistence));
        if (Option.isNone(project)) return yield* new ExternalMcpAdminError({ code: "not_found" });
        const now = yield* Clock.currentTimeMillis;
        const grant = yield* decodeGrant({
          id,
          tokenHash,
          principalId: policy.principalId,
          environmentId: home.environmentId,
          audience: Access.CONTROL_AUDIENCE,
          projectIds: [policy.projectId],
          operations: [...new Set(policy.tools.map((tool) => operations[tool]))],
          notBefore: now,
          expiresAt: now + policy.ttlSeconds * 1000,
          controlPolicy: {
            runtimeModeCeiling: policy.runtimeModeCeiling,
            interactionModeCeiling: policy.interactionModeCeiling,
          },
        }).pipe(Effect.mapError(() => new ExternalMcpAdminError({ code: "invalid_policy" })));
        if (
          !(yield* grants.register(Access.grantBinding(grant)).pipe(Effect.mapError(persistence)))
        )
          return yield* persistence();
        return grant;
      }),
    list: Effect.gen(function* () {
      const rows = yield* grants.list(home.environmentId).pipe(Effect.mapError(persistence));
      return yield* Effect.forEach(rows, (row) =>
        Effect.gen(function* () {
          const grant = yield* decodeStoredGrant(row.policyJson).pipe(Effect.mapError(persistence));
          const binding = Access.grantBinding(grant);
          if (
            binding.environmentId !== row.environmentId ||
            binding.credentialId !== row.credentialId ||
            binding.tokenHash !== row.tokenHash ||
            binding.policyJson !== row.policyJson
          )
            return yield* persistence();
          const { tokenHash: _hash, ...metadata } = grant;
          return { ...metadata, revokedAt: row.revokedAt };
        }),
      );
    }),
    revoke: (id) =>
      Effect.gen(function* () {
        yield* grants
          .revoke(home.environmentId, id, yield* Clock.currentTimeMillis)
          .pipe(Effect.mapError(persistence));
      }),
  });
});
const layer = Layer.effect(ExternalMcpAdmin, make);
/** Local owner administration: existing DB only, no initializer or migrations. */
export const layerFor = (baseDir: string) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const home = yield* (yield* Configuration.ExternalMcpConfig).existingHome(baseDir);
      const database = NodeSqliteClient.layer({ filename: home.dbPath });
      const busyTimeout = Layer.effectDiscard(
        Effect.flatMap(SqlClient.SqlClient, (sql) => sql`PRAGMA busy_timeout = 5000`),
      );
      return layer.pipe(
        Layer.provideMerge(Layer.mergeAll(GrantStore.layer, ProjectStore.layer)),
        Layer.provideMerge(busyTimeout.pipe(Layer.provideMerge(database))),
        Layer.provideMerge(Layer.succeed(ExternalMcpTarget, home)),
      );
    }),
  ).pipe(Layer.provide(Configuration.layer));
