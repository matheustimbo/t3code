// @effect-diagnostics nodeBuiltinImport:off - Credentials arrive through an inherited descriptor, never a T3 data directory.
import * as NodeFS from "node:fs";

import {
  EnvironmentHttpApi,
  EnvironmentId,
  ORCHESTRATION_PROTOCOL_VERSION,
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_VERSION_TEXT,
  type AuthEnvironmentScope,
  type OrchestrationV2Command,
  type ThreadId,
} from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Runtime from "effect/Runtime";
import * as Schema from "effect/Schema";
import { Flag } from "effect/unstable/cli";
import { FetchHttpClient } from "effect/unstable/http";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";

export class RemoteCliError extends Schema.TaggedError<RemoteCliError>()("RemoteCliError", {
  code: Schema.String,
  detail: Schema.String,
}) {
  // Handlers render a sanitized error themselves. Prevent the main process
  // runner from appending its automatic error log to JSON stdout.
  override readonly [Runtime.errorReported] = false;

  override get message() {
    return this.detail;
  }
}

export const remoteError = (code: string, detail: string) => new RemoteCliError({ code, detail });

export const remoteFlags = {
  server: Flag.String("server").pipe(Flag.withDescription("Explicit HTTPS server origin.")),
  tokenFd: Flag.Finite("token-fd").pipe(
    Flag.withSchema(Schema.Int.check(Schema.isGreaterThanOrEqualTo(3))),
    Flag.withDescription(
      "Inherited regular-file descriptor containing a bearer credential (3 or higher).",
    ),
  ),
  environmentId: Flag.String("environment-id").pipe(
    Flag.withSchema(EnvironmentId),
    Flag.optional,
    Flag.withDescription("Expected environment ID; required for mutations."),
  ),
  json: Flag.Boolean("json").pipe(Flag.withDefault(false)),
};

export interface RemoteFlags {
  readonly server: string;
  readonly tokenFd: number;
  readonly environmentId: Option.Option<EnvironmentId>;
  readonly json: boolean;
}

export const validateServerOrigin = Effect.fn("validateServerOrigin")(function* (input: string) {
  const error = () =>
    remoteError(
      "invalid_server",
      "Use an HTTPS origin without credentials, path, query or fragment; HTTP is allowed only on loopback.",
    );
  const url = yield* Effect.try({ try: () => new URL(input), catch: error });
  const loopback =
    url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  )
    return yield* error();
  return url.origin;
});

const CredentialText = Schema.String.check(Schema.isPattern(/^[\x21-\x7e]{1,8192}$/));
const decodeCredentialText = Schema.decodeUnknownEffect(CredentialText);

export const readCredential = Effect.fn("readRemoteCliCredential")(function* (fd: number) {
  const failure = () =>
    remoteError(
      "credential_input",
      "Could not read a bounded, nonempty bearer credential from --token-fd.",
    );
  if (!Number.isSafeInteger(fd) || fd < 3) return yield* failure();
  const stat = yield* Effect.try({ try: () => NodeFS.fstatSync(fd), catch: failure });
  // Reject pipes and devices before reading: an outstanding pipe read can keep
  // Node alive even after the Effect timeout interrupts its consumer.
  if (!stat.isFile() || stat.size > 8192) return yield* failure();
  const text = yield* Effect.callback<string, RemoteCliError>((resume) => {
    const buffer = Buffer.alloc(8193);
    let offset = 0;
    const read = () =>
      NodeFS.read(fd, buffer, offset, buffer.length - offset, null, (error, size) => {
        if (error !== null) {
          resume(Effect.fail(failure()));
          return;
        }
        offset += size;
        if (offset === buffer.length) {
          resume(Effect.fail(failure()));
          return;
        }
        if (size === 0) {
          resume(Effect.succeed(buffer.subarray(0, offset).toString("utf8").trim()));
          return;
        }
        read();
      });
    read();
  }).pipe(Effect.timeout("5 seconds"), Effect.mapError(failure));
  const token = yield* decodeCredentialText(text).pipe(Effect.mapError(failure));
  return Redacted.make(token);
});

const request = <A, E, R>(operation: Effect.Effect<A, E, R>) =>
  operation.pipe(
    Effect.timeout("15 seconds"),
    // Transport errors carry requests and headers. Never retain or print their causes.
    Effect.mapError(() =>
      remoteError(
        "remote_request",
        "Server request failed, timed out, or returned an incompatible response. No mutation is retried automatically.",
      ),
    ),
  );

export const connectRemote = Effect.fn("connectRemoteCli")(function* (
  flags: RemoteFlags,
  access: "read" | "operate",
) {
  const origin = yield* validateServerOrigin(flags.server);
  if (access === "operate" && Option.isNone(flags.environmentId)) {
    return yield* remoteError(
      "destination_required",
      "Mutations require --environment-id from project list and an explicitly selected project.",
    );
  }
  const client = yield* HttpApiClient.make(EnvironmentHttpApi, { baseUrl: origin });
  const descriptor = yield* request(client.metadata.descriptor());
  if ((descriptor.orchestrationProtocolVersion ?? 1) !== ORCHESTRATION_PROTOCOL_VERSION) {
    return yield* remoteError(
      "unsupported_protocol",
      "The server orchestration protocol is incompatible with this CLI.",
    );
  }
  if (
    Option.isSome(flags.environmentId) &&
    flags.environmentId.value !== descriptor.environmentId
  ) {
    return yield* remoteError(
      "destination_mismatch",
      "The server environment ID does not match --environment-id.",
    );
  }
  if (access === "operate" && descriptor.capabilities.threadCommandPreconditions !== true) {
    return yield* remoteError(
      "unsupported_preconditions",
      "This server cannot atomically reject stale thread mutations. Upgrade the server before using --execute.",
    );
  }
  const credential = yield* readCredential(flags.tokenFd);
  const headers = {
    authorization: `Bearer ${Redacted.value(credential)}`,
    [ORCHESTRATION_PROTOCOL_HEADER]: ORCHESTRATION_PROTOCOL_VERSION_TEXT,
  } as const;
  const session = yield* request(client.auth.session({ headers }));
  if (
    session.auth.policy === "unsafe-no-auth" ||
    !session.auth.sessionMethods.includes("bearer-access-token") ||
    session.sessionMethod !== "bearer-access-token"
  ) {
    return yield* remoteError(
      "unsupported_auth",
      "This CLI requires a server-confirmed bearer session; cookie, DPoP and unauthenticated sessions are not supported.",
    );
  }
  const required: ReadonlyArray<AuthEnvironmentScope> =
    access === "read" ? ["orchestration:read"] : ["orchestration:read", "orchestration:operate"];
  if (!session.authenticated || required.some((scope) => !session.scopes?.includes(scope))) {
    return yield* remoteError(
      "insufficient_scope",
      `A supplied authenticated credential must grant ${required.join(" and ")}.`,
    );
  }
  if (
    session.scopes?.some(
      (scope) => scope !== "orchestration:read" && scope !== "orchestration:operate",
    )
  ) {
    return yield* remoteError(
      "excessive_scope",
      "Supply a dedicated credential with only orchestration:read and, when needed, orchestration:operate.",
    );
  }
  return {
    descriptor,
    shell: () => request(client.orchestration.shellSnapshot({ headers })),
    thread: (threadId: ThreadId) =>
      request(
        client.orchestration.threadBoundedSnapshot({
          headers,
          params: { threadId },
        }),
      ),
    dispatch: (
      payload: Extract<OrchestrationV2Command, { type: "thread.create" | "message.dispatch" }>,
    ) => {
      switch (payload.type) {
        case "thread.create":
          return request(client.orchestration.dispatch({ headers, payload }));
        case "message.dispatch":
          return request(client.orchestration.dispatch({ headers, payload }));
      }
    },
  };
});

export type RemoteClient = Effect.Success<ReturnType<typeof connectRemote>>;

export const withRemoteTransport = <A, E, R>(operation: Effect.Effect<A, E, R>) =>
  operation.pipe(
    Effect.provideService(FetchHttpClient.RequestInit, {
      redirect: "error",
      credentials: "omit",
      cache: "no-store",
    }),
    Effect.provide(FetchHttpClient.layer),
  );

export const printRemoteResult = (json: boolean, value: unknown, summary: string) =>
  Console.log(json ? JSON.stringify(value) : summary);

export const reportRemoteErrors = <A, R>(
  json: boolean,
  operation: Effect.Effect<A, RemoteCliError, R>,
) =>
  operation.pipe(
    Effect.tapError((error) =>
      json
        ? Console.log(
            JSON.stringify({ ok: false, error: { code: error.code, message: error.message } }),
          )
        : Console.error(error.message),
    ),
  );
