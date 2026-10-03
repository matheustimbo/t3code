import {
  EnvironmentId,
  ExternalReadFailure,
  NonNegativeInt,
  ProjectId,
  ProviderInteractionMode,
  RuntimeMode,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as GrantStore from "../../persistence/ExternalReadGrantStore.ts";

export const AUDIENCE = "t3-code:external-read";
export const CONTROL_AUDIENCE = "t3-code:external-control";
export const ExternalReadOperation = Schema.Literals([
  "projects.list",
  "threads.list",
  "threads.status",
  "threads.messages",
  "threads.create",
  "threads.send",
  "threads.interrupt",
]);
export type ExternalReadOperation = typeof ExternalReadOperation.Type;

export const ExternalReadGrant = Schema.Struct({
  id: TrimmedNonEmptyString,
  principalId: TrimmedNonEmptyString,
  environmentId: EnvironmentId,
  audience: TrimmedNonEmptyString,
  tokenHash: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
  projectIds: Schema.Array(ProjectId),
  operations: Schema.Array(ExternalReadOperation),
  // Absolute epoch milliseconds. Resolving a credential never extends these bounds.
  notBefore: NonNegativeInt,
  expiresAt: NonNegativeInt,
  controlPolicy: Schema.optional(
    Schema.Struct({
      runtimeModeCeiling: RuntimeMode,
      interactionModeCeiling: ProviderInteractionMode,
    }),
  ),
});
export type ExternalReadGrant = typeof ExternalReadGrant.Type;
const decodeGrants = Schema.decodeEffect(Schema.Array(ExternalReadGrant));
const decodeStoredGrant = Schema.decodeUnknownEffect(Schema.fromJsonString(ExternalReadGrant));
const encodeGrant = Schema.encodeSync(Schema.fromJsonString(ExternalReadGrant));

/** Canonical binding of all policy fields. Configuration alone never registers it. */
export const grantBinding = (grant: ExternalReadGrant): GrantStore.ExternalReadGrantBinding => ({
  environmentId: grant.environmentId,
  credentialId: grant.id,
  tokenHash: grant.tokenHash,
  policyJson: encodeGrant({
    ...grant,
    projectIds: grant.projectIds.toSorted(),
    operations: grant.operations.toSorted(),
  }),
});

export class ExternalReadSettings extends Context.Reference<{
  readonly enabled: boolean;
  readonly grants: ReadonlyArray<ExternalReadGrant>;
  /** Production grants are explicitly registered by the local owner CLI. */
  readonly persistedGrants?: boolean;
}>("t3/mcp/external/ExternalReadSettings", {
  defaultValue: () => ({ enabled: false, grants: [] }),
}) {}

export interface ExternalReadIdentity {
  readonly credentialId: string;
  readonly principalId: string;
}

export class ExternalReadInvocation extends Context.Service<
  ExternalReadInvocation,
  ExternalReadIdentity
>()("t3/mcp/external/ExternalReadAccess/ExternalReadInvocation") {}

export class ExternalReadCredentialError extends Schema.TaggedError<ExternalReadCredentialError>()(
  "ExternalReadCredentialError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "External read credential verification failed.";
  }
}

class InvalidExternalReadPolicy extends Schema.TaggedError<InvalidExternalReadPolicy>()(
  "InvalidExternalReadPolicy",
  {
    reason: Schema.Literals(["invalid_grants", "duplicate_grants"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return "Invalid external MCP read policy.";
  }
}

export class ExternalReadAccess extends Context.Service<
  ExternalReadAccess,
  {
    readonly authenticate: (
      token: string,
      audience?: typeof AUDIENCE | typeof CONTROL_AUDIENCE,
    ) => Effect.Effect<ExternalReadIdentity | undefined, ExternalReadCredentialError>;
    readonly authorize: (
      identity: ExternalReadIdentity,
      operation: ExternalReadOperation,
      projectId?: ProjectId,
    ) => Effect.Effect<ExternalReadGrant, ExternalReadFailure>;
    readonly revoke: (
      credentialId: string,
    ) => Effect.Effect<void, GrantStore.ExternalReadGrantStoreError>;
    readonly revokeAll: Effect.Effect<void, GrantStore.ExternalReadGrantStoreError>;
  }
>()("t3/mcp/external/ExternalReadAccess") {}

const make = Effect.gen(function* () {
  const settings = yield* ExternalReadSettings;
  const enabled = settings.enabled;
  const crypto = yield* Crypto.Crypto;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const environmentId = yield* environment.getEnvironmentId;
  const store = yield* GrantStore.ExternalReadGrantStore;
  const decodedGrants = yield* decodeGrants(settings.grants).pipe(
    Effect.mapError((cause) => new InvalidExternalReadPolicy({ reason: "invalid_grants", cause })),
  );
  const grants = decodedGrants.map((grant) =>
    Object.freeze({
      ...grant,
      projectIds: Object.freeze([...grant.projectIds]),
      operations: Object.freeze([...grant.operations]),
      ...(grant.controlPolicy === undefined
        ? {}
        : { controlPolicy: Object.freeze({ ...grant.controlPolicy }) }),
    }),
  );
  const byId = new Map(grants.map((grant) => [grant.id, grant]));
  const byHash = new Map(grants.map((grant) => [grant.tokenHash, grant]));
  const bindings = new Map(grants.map((grant) => [grant.id, grantBinding(grant)]));
  if (byId.size !== grants.length || byHash.size !== grants.length) {
    return yield* new InvalidExternalReadPolicy({ reason: "duplicate_grants" });
  }
  const revoked = yield* Ref.make<ReadonlySet<string>>(new Set());
  const denyAll = yield* Ref.make(false);
  const persistedGrant = Effect.fn("ExternalReadAccess.persistedGrant")(function* (
    field: "credential_id" | "token_hash",
    value: string,
  ) {
    if (!settings.persistedGrants) return undefined;
    const row = yield* store
      .find(environmentId, field, value)
      .pipe(Effect.mapError((cause) => new ExternalReadCredentialError({ cause })));
    if (row === undefined) return undefined;
    const grant = yield* decodeStoredGrant(row.policyJson).pipe(
      Effect.orElseSucceed(() => undefined),
    );
    if (grant === undefined) return undefined;
    const binding = grantBinding(grant);
    return binding.environmentId === row.environmentId &&
      binding.credentialId === row.credentialId &&
      binding.tokenHash === row.tokenHash &&
      binding.policyJson === row.policyJson
      ? grant
      : undefined;
  });
  const validGrant = Effect.fn("ExternalReadAccess.validGrant")(function* (id: string) {
    const grant = byId.get(id) ?? (yield* persistedGrant("credential_id", id));
    const timestamp = yield* Clock.currentTimeMillis;
    if (
      !enabled ||
      (yield* Ref.get(denyAll)) ||
      grant === undefined ||
      (yield* Ref.get(revoked)).has(id) ||
      grant.environmentId !== environmentId ||
      (grant.audience !== AUDIENCE && grant.audience !== CONTROL_AUDIENCE) ||
      timestamp < grant.notBefore ||
      timestamp >= grant.expiresAt
    ) {
      return undefined;
    }
    const binding = bindings.get(id) ?? grantBinding(grant);
    const active =
      binding === undefined
        ? false
        : yield* store
            .isActive(binding)
            .pipe(Effect.mapError((cause) => new ExternalReadCredentialError({ cause })));
    const afterRead = yield* Clock.currentTimeMillis;
    if (
      !active ||
      (yield* Ref.get(denyAll)) ||
      (yield* Ref.get(revoked)).has(id) ||
      afterRead < grant.notBefore ||
      afterRead >= grant.expiresAt
    ) {
      return undefined;
    }
    return grant;
  });
  const authenticate = Effect.fn("ExternalReadAccess.authenticate")(function* (
    token: string,
    audience: typeof AUDIENCE | typeof CONTROL_AUDIENCE = AUDIENCE,
  ) {
    if (token.length === 0 || token.length > 4096) return undefined;
    const bytes = yield* crypto
      .digest("SHA-256", new TextEncoder().encode(token))
      .pipe(Effect.mapError((cause) => new ExternalReadCredentialError({ cause })));
    const hash = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    const candidate = byHash.get(hash) ?? (yield* persistedGrant("token_hash", hash));
    if (candidate === undefined) return undefined;
    const grant = yield* validGrant(candidate.id);
    return grant === undefined || grant.audience !== audience
      ? undefined
      : { credentialId: grant.id, principalId: grant.principalId };
  });
  const authorize = Effect.fn("ExternalReadAccess.authorize")(function* (
    identity: ExternalReadIdentity,
    operation: ExternalReadOperation,
    projectId?: ProjectId,
  ) {
    const grant = yield* validGrant(identity.credentialId).pipe(
      Effect.catchTags({ ExternalReadCredentialError: () => Effect.succeed(undefined) }),
    );
    if (
      grant === undefined ||
      grant.principalId !== identity.principalId ||
      !grant.operations.includes(operation) ||
      (!["projects.list", "threads.list", "threads.status"].includes(operation) &&
        (grant.audience !== CONTROL_AUDIENCE ||
          (operation !== "threads.messages" && grant.controlPolicy === undefined))) ||
      (projectId !== undefined && !grant.projectIds.includes(projectId))
    ) {
      return yield* new ExternalReadFailure({ code: "access_denied" });
    }
    return grant;
  });
  return ExternalReadAccess.of({
    authenticate,
    authorize,
    revoke: (id) =>
      Effect.gen(function* () {
        // Deny immediately in this runtime even if the durable write fails. A failed
        // write is returned to the caller; it is never reported as a durable revoke.
        yield* Ref.update(revoked, (ids) => new Set([...ids, id]));
        yield* store.revoke(environmentId, id, yield* Clock.currentTimeMillis);
      }),
    revokeAll: Effect.gen(function* () {
      yield* Ref.set(denyAll, true);
      yield* store.revokeAll(environmentId, yield* Clock.currentTimeMillis);
    }),
  });
});

export const layer = Layer.effect(ExternalReadAccess, make);
