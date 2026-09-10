/**
 * Decides whether this desktop shell should spawn its own server or attach to
 * one that already owns the same state directory.
 *
 * Two servers over one `state.sqlite` do not corrupt the file — WAL plus
 * `busy_timeout` handles that — but each holds its own in-memory orchestration
 * state and notifies only its own subscribers, so the two views silently
 * diverge, and both would own the same provider processes, terminals and
 * checkpoint refs. Attaching keeps a single owner.
 *
 * The discovery sequence mirrors `t3 pair` (`apps/server/src/cli/pair.ts`):
 * read the published runtime state, confirm the pid is alive, then prove a T3
 * server actually answers on the recorded origin. The pid check alone is not
 * enough because a recycled pid or a stale file would point at a stranger.
 */
import { isProcessAlive as defaultIsProcessAlive } from "@t3tools/shared/serverRuntimeState";
import { readPersistedServerRuntimeState } from "@t3tools/shared/serverRuntimeState";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

const WELL_KNOWN_ENVIRONMENT_PATH = "/.well-known/t3/environment";
const PROBE_TIMEOUT = "2500 millis";

/**
 * Only the field that proves a T3 server answered. Deliberately not the full
 * `ExecutionEnvironmentDescriptor`: an attached server can be older than this
 * shell, and a capability the desktop has never heard of must not read as
 * "not a T3 server".
 */
const ProbedEnvironment = Schema.Struct({
  environmentId: Schema.String,
});

export type DesktopBackendOwnership =
  /** No live server owns this state dir; spawn one as usual. */
  | { readonly _tag: "Owned" }
  /** A server already owns this state dir; use it and never kill it. */
  | {
      readonly _tag: "Attached";
      /** API origin that published the runtime state. */
      readonly origin: URL;
      /** Where renderer assets come from; differs only for dev servers. */
      readonly rendererOrigin: URL;
      readonly pid: number;
      readonly environmentId: string;
    };

const OWNED = { _tag: "Owned" } as const satisfies DesktopBackendOwnership;

const probeIsT3Server = (origin: URL) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const request = HttpClientRequest.get(new URL(WELL_KNOWN_ENVIRONMENT_PATH, origin).toString());
    const response = yield* client.execute(request).pipe(
      Effect.timeout(PROBE_TIMEOUT),
      Effect.mapError(() => "unreachable" as const),
    );
    // A bad-gateway family answer is a proxy speaking for a backend that is
    // gone — a stale mapping, not a live occupant.
    if (response.status === 502 || response.status === 503 || response.status === 504) {
      return yield* Effect.fail("unreachable" as const);
    }
    return yield* HttpClientResponse.filterStatusOk(response).pipe(
      Effect.flatMap(HttpClientResponse.schemaBodyJson(ProbedEnvironment)),
      Effect.mapError(() => "not-a-t3-server" as const),
    );
  }).pipe(
    Effect.map(Option.some),
    Effect.catch(() => Effect.succeed(Option.none<typeof ProbedEnvironment.Type>())),
    // A probe must never take the app down; anything unexpected means "spawn".
    Effect.catchCause(() => Effect.succeed(Option.none<typeof ProbedEnvironment.Type>())),
  );

const parseUrl = (value: string): Option.Option<URL> => {
  try {
    return Option.some(new URL(value));
  } catch {
    return Option.none();
  }
};

export const resolveBackendOwnership = (input: {
  readonly stateDir: string;
  /** Injectable so tests do not depend on real pids. */
  readonly isProcessAlive?: (pid: number) => boolean;
}): Effect.Effect<DesktopBackendOwnership, never, FileSystem.FileSystem | HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const isAlive = input.isProcessAlive ?? defaultIsProcessAlive;
    const statePath = `${input.stateDir.replace(/[/\\]+$/, "")}/server-runtime.json`;

    const state = yield* readPersistedServerRuntimeState(statePath);
    if (Option.isNone(state)) {
      return OWNED;
    }
    if (!isAlive(state.value.pid)) {
      return OWNED;
    }

    const origin = parseUrl(state.value.origin);
    if (Option.isNone(origin)) {
      return OWNED;
    }

    const probed = yield* probeIsT3Server(origin.value);
    if (Option.isNone(probed)) {
      return OWNED;
    }

    // Dev is single-origin: when the live server fronts a Vite dev server the
    // renderer must load from that URL, while the API stays on `origin`.
    const rendererOrigin = state.value.devUrl
      ? Option.getOrElse(parseUrl(state.value.devUrl), () => origin.value)
      : origin.value;

    return {
      _tag: "Attached",
      origin: origin.value,
      rendererOrigin,
      pid: state.value.pid,
      environmentId: probed.value.environmentId,
    } as const;
  });
