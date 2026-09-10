/**
 * Mints a bearer token for a server this app attached to instead of spawned.
 *
 * A spawned backend gets a bootstrap token pushed into it at launch, which the
 * desktop then exchanges. That does not exist for a server someone else
 * started: its token was chosen by whoever launched it, and nothing publishes
 * it. What the desktop does have is filesystem access to the shared state
 * directory — which is the very reason attaching was necessary — and that is
 * exactly what the shipped `t3 auth session issue` command needs. The session
 * is signed with `secrets/server-signing-key.bin` and backed by a row in
 * `state.sqlite`, both of which the running server re-reads on every verify, so
 * a token minted out-of-process is accepted immediately.
 *
 * `packages/ssh/src/tunnel.ts` already pairs with a discovered remote server
 * the same way, through `t3 auth pairing create --json`.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

const MINT_TIMEOUT = "20 seconds";

export class DesktopAttachedCredentialError extends Schema.TaggedError<DesktopAttachedCredentialError>()(
  "DesktopAttachedCredentialError",
  {
    reason: Schema.String,
  },
) {
  override get message(): string {
    return `Failed to mint a bearer token for the attached server: ${this.reason}`;
  }
}

/**
 * `--base-dir` makes the CLI derive `<baseDir>/userdata`, so attaching is only
 * expressible when the shell's state directory is that. A development shell
 * uses `<baseDir>/dev`, which no auth flag can name; minting with the wrong
 * base dir would write the session into a different database and hand back a
 * token the attached server rejects. Fail loudly instead.
 */
export const resolveAuthBaseDir = (stateDir: string): string | null => {
  const normalized = stateDir.replace(/[/\\]+$/, "");
  const match = /^(.*)[/\\]userdata$/.exec(normalized);
  return match?.[1] ?? null;
};

const decodeUtf8 = (chunks: readonly Uint8Array[]): string =>
  new TextDecoder().decode(
    chunks.reduce<Uint8Array>((accumulator, chunk) => {
      const merged = new Uint8Array(accumulator.length + chunk.length);
      merged.set(accumulator);
      merged.set(chunk, accumulator.length);
      return merged;
    }, new Uint8Array()),
  );

export const issueAttachedBearerToken = Effect.fn("desktop.attachedCredential.issue")(
  function* (input: {
    readonly executablePath: string;
    readonly entryPath: string;
    readonly stateDir: string;
    readonly label?: string;
  }) {
    const baseDir = resolveAuthBaseDir(input.stateDir);
    if (baseDir === null) {
      return yield* new DesktopAttachedCredentialError({
        reason: `the state directory ${input.stateDir} is not a "<baseDir>/userdata" path, so no auth base dir names it`,
      });
    }

    const command = ChildProcess.make(
      input.executablePath,
      [
        input.entryPath,
        "auth",
        "session",
        "issue",
        "--base-dir",
        baseDir,
        "--label",
        input.label ?? "T3 Code Desktop",
        "--token-only",
      ],
      {
        // The bundled entry is plain Node, not an Electron renderer.
        env: { ELECTRON_RUN_AS_NODE: "1" },
        extendEnv: true,
        stdout: "pipe",
        stderr: "pipe",
        killSignal: "SIGTERM",
        forceKillAfter: "5 seconds",
      },
    );

    const result = yield* Effect.scoped(
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const handle = yield* spawner.spawn(command);
        const [stdout, stderr, exitCode] = yield* Effect.all(
          [Stream.runCollect(handle.stdout), Stream.runCollect(handle.stderr), handle.exitCode],
          { concurrency: "unbounded" },
        );
        return {
          exitCode: exitCode as unknown as number,
          stdout: decodeUtf8(Array.from(stdout)),
          stderr: decodeUtf8(Array.from(stderr)),
        };
      }),
    ).pipe(
      Effect.timeoutOption(MINT_TIMEOUT),
      // A spawn failure is reported as a non-zero run, not as a missing result,
      // so the timeout branch below stays the only "None".
      Effect.catch((error) =>
        Effect.succeed(
          Option.some({ exitCode: 127, stdout: "", stderr: String(error.message ?? error) }),
        ),
      ),
    );

    if (result._tag === "None") {
      return yield* new DesktopAttachedCredentialError({ reason: "the mint command timed out" });
    }

    const { exitCode, stdout, stderr } = result.value;
    if (exitCode !== 0) {
      return yield* new DesktopAttachedCredentialError({
        reason: `\`auth session issue\` exited with ${exitCode}: ${stderr.trim() || "no output"}`,
      });
    }

    // `--token-only` prints the bearer and nothing else, but the CLI may still
    // have emitted a trailing newline or a stray warning line.
    const token = stdout
      .split("\n")
      .map((line) => line.trim())
      .findLast((line) => line.length > 0);

    if (!token) {
      return yield* new DesktopAttachedCredentialError({
        reason: "`auth session issue` produced no token",
      });
    }
    return token;
  },
);
