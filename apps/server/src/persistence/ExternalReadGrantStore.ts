import { EnvironmentId, NonNegativeInt, TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

export const ExternalReadGrantBinding = Schema.Struct({
  environmentId: EnvironmentId,
  credentialId: TrimmedNonEmptyString,
  tokenHash: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
  policyJson: Schema.String,
});
export type ExternalReadGrantBinding = typeof ExternalReadGrantBinding.Type;

class MissingExternalReadGrantRecord extends Schema.TaggedError<MissingExternalReadGrantRecord>()(
  "MissingExternalReadGrantRecord",
  {},
) {
  override get message(): string {
    return "The stored external read grant is absent.";
  }
}

export class ExternalReadGrantStoreError extends Schema.TaggedError<ExternalReadGrantStoreError>()(
  "ExternalReadGrantStoreError",
  {
    operation: Schema.Literals(["register", "read", "revoke", "revoke_all"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "External read grant persistence failed.";
  }
}

export class ExternalReadGrantStore extends Context.Service<
  ExternalReadGrantStore,
  {
    /** Explicit insertion only. Existing IDs/hashes, including revoked rows, are never updated. */
    readonly register: (
      binding: ExternalReadGrantBinding,
    ) => Effect.Effect<boolean, ExternalReadGrantStoreError>;
    /** An absent record is denied. Positive authorization is never cached. */
    readonly isActive: (
      binding: ExternalReadGrantBinding,
    ) => Effect.Effect<boolean, ExternalReadGrantStoreError>;
    readonly find: (
      environmentId: EnvironmentId,
      field: "credential_id" | "token_hash",
      value: string,
    ) => Effect.Effect<ExternalReadGrantBinding | undefined, ExternalReadGrantStoreError>;
    readonly list: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<
      ReadonlyArray<ExternalReadGrantBinding & { readonly revokedAt: number | null }>,
      ExternalReadGrantStoreError
    >;
    readonly revoke: (
      environmentId: EnvironmentId,
      credentialId: string,
      timestamp: number,
    ) => Effect.Effect<void, ExternalReadGrantStoreError>;
    readonly revokeAll: (
      environmentId: EnvironmentId,
      timestamp: number,
    ) => Effect.Effect<void, ExternalReadGrantStoreError>;
  }
>()("t3/persistence/ExternalReadGrantStore") {}

const decodeTimestamp = Schema.decodeEffect(NonNegativeInt);
const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return ExternalReadGrantStore.of({
    find: (environmentId, field, value) =>
      sql<{
        environmentId: EnvironmentId;
        credentialId: string;
        tokenHash: string;
        policyJson: string;
      }>`
        SELECT environment_id AS "environmentId", credential_id AS "credentialId",
          token_hash AS "tokenHash", policy_json AS "policyJson"
        FROM external_read_grants
        WHERE environment_id = ${environmentId} AND ${sql(field)} = ${value} AND revoked_at IS NULL
      `.pipe(
        Effect.map((rows) => rows[0]),
        Effect.mapError((cause) => new ExternalReadGrantStoreError({ operation: "read", cause })),
      ),
    list: (environmentId) =>
      sql<ExternalReadGrantBinding & { revokedAt: number | null }>`
        SELECT environment_id AS "environmentId", credential_id AS "credentialId",
          token_hash AS "tokenHash", policy_json AS "policyJson", revoked_at AS "revokedAt"
        FROM external_read_grants WHERE environment_id = ${environmentId} ORDER BY credential_id
      `.pipe(
        Effect.mapError((cause) => new ExternalReadGrantStoreError({ operation: "read", cause })),
      ),
    register: (binding) =>
      sql`
      INSERT INTO external_read_grants (environment_id, credential_id, token_hash, policy_json)
      VALUES (${binding.environmentId}, ${binding.credentialId}, ${binding.tokenHash}, ${binding.policyJson})
      ON CONFLICT DO NOTHING RETURNING credential_id
    `.pipe(
        Effect.map((rows) => rows.length === 1),
        Effect.mapError(
          (cause) => new ExternalReadGrantStoreError({ operation: "register", cause }),
        ),
      ),
    isActive: (binding) =>
      sql`
      SELECT credential_id FROM external_read_grants
      WHERE environment_id = ${binding.environmentId} AND credential_id = ${binding.credentialId}
        AND token_hash = ${binding.tokenHash} AND policy_json = ${binding.policyJson} AND revoked_at IS NULL
    `.pipe(
        Effect.map((rows) => rows.length === 1),
        Effect.mapError((cause) => new ExternalReadGrantStoreError({ operation: "read", cause })),
      ),
    revoke: (environmentId, credentialId, timestamp) =>
      decodeTimestamp(timestamp).pipe(
        Effect.flatMap(
          (revokedAt) => sql`
        UPDATE external_read_grants SET revoked_at = COALESCE(revoked_at, ${revokedAt})
        WHERE environment_id = ${environmentId} AND credential_id = ${credentialId}
        RETURNING credential_id
      `,
        ),
        Effect.flatMap((rows) =>
          rows.length === 0 ? Effect.fail(new MissingExternalReadGrantRecord()) : Effect.void,
        ),
        Effect.mapError((cause) => new ExternalReadGrantStoreError({ operation: "revoke", cause })),
      ),
    revokeAll: (environmentId, timestamp) =>
      decodeTimestamp(timestamp).pipe(
        Effect.flatMap(
          (revokedAt) => sql`
        UPDATE external_read_grants SET revoked_at = COALESCE(revoked_at, ${revokedAt})
        WHERE environment_id = ${environmentId}
      `,
        ),
        Effect.asVoid,
        Effect.mapError(
          (cause) => new ExternalReadGrantStoreError({ operation: "revoke_all", cause }),
        ),
      ),
  });
});

export const layer = Layer.effect(ExternalReadGrantStore, make);
