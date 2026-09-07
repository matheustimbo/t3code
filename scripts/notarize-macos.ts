// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Electron-builder's afterSign hook must run macOS tools and own their deadlines outside an Effect runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTimers from "node:timers";
import * as NodeTimersPromises from "node:timers/promises";
import * as NodeUtil from "node:util";

const DEFAULT_POLL_TIMEOUT_MS = 60 * 60 * 1000;
const POLL_INTERVAL_MS = 30_000;
const POLL_COMMAND_TIMEOUT_MS = 120_000;
const SUBMISSION_COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
const STAPLER_RETRY_DELAY_MS = 15_000;
const STAPLER_RETRY_ATTEMPTS = 4;
const STAPLER_TIMEOUT_MS = 5 * 60 * 1000;
const INVALID_LOG_TIMEOUT_MS = 5 * 60 * 1000;
const INVALID_LOG_ATTEMPTS = 3;

export interface NotarizationCredentials {
  readonly keyPath: string;
  readonly keyId: string;
  readonly issuer: string;
}

export interface NotarizationCommand {
  readonly executable: string;
  readonly args: readonly string[];
  readonly label: string;
}

export interface NotarizationCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut?: boolean;
}

export type NotarizationCommandRunner = (
  command: NotarizationCommand,
  timeoutMs: number,
) => Promise<NotarizationCommandResult>;

export interface NotarizationLogger {
  readonly info: (message: string) => void;
  readonly warn: (message: string) => void;
  readonly error: (message: string) => void;
}

interface PollContext {
  readonly submissionId: string;
  readonly credentials: NotarizationCredentials;
  readonly deadline: number;
  readonly timeoutMs: number;
  readonly runner: NotarizationCommandRunner;
  readonly now: () => number;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly logger: NotarizationLogger;
  lastStatus: string;
}

const execFileAsync = NodeUtil.promisify(NodeChildProcess.execFile);

const processLogger: NotarizationLogger = {
  info: (message) => process.stdout.write(`[mac-notarize] ${message}\n`),
  warn: (message) => process.stderr.write(`[mac-notarize] ${message}\n`),
  error: (message) => process.stderr.write(`[mac-notarize] ${message}\n`),
};

function positiveInteger(value: string | undefined, name: string, fallback: number): number {
  const trimmed = value?.trim();
  if (!trimmed) return fallback;
  if (!/^\d+$/u.test(trimmed)) throw new Error(`${name} must be a positive integer.`);
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function pollTimeout(
  input: { readonly timeoutMs?: number },
  env: Readonly<Record<string, string | undefined>>,
): number {
  const configured =
    input.timeoutMs ??
    positiveInteger(
      env.T3CODE_NOTARIZATION_TIMEOUT_MS,
      "T3CODE_NOTARIZATION_TIMEOUT_MS",
      DEFAULT_POLL_TIMEOUT_MS,
    );
  if (!Number.isSafeInteger(configured) || configured <= 0) {
    throw new Error("timeoutMs must be a positive integer.");
  }
  return configured;
}

export function resolveNotarizationCredentials(
  env: Readonly<Record<string, string | undefined>> = process.env,
): NotarizationCredentials {
  const keyPath = env.APPLE_API_KEY?.trim();
  const keyId = env.APPLE_API_KEY_ID?.trim();
  const issuer = env.APPLE_API_ISSUER?.trim();
  const missing = [
    ...(keyPath ? [] : ["APPLE_API_KEY"]),
    ...(keyId ? [] : ["APPLE_API_KEY_ID"]),
    ...(issuer ? [] : ["APPLE_API_ISSUER"]),
  ];
  if (!keyPath || !keyId || !issuer) {
    throw new Error(
      `macOS notarization needs ${missing.join(", ")}. Check the App Store Connect API-key configuration.`,
    );
  }
  return { keyPath, keyId, issuer };
}

function credentialArguments(credentials: NotarizationCredentials): readonly string[] {
  return [
    "--key",
    credentials.keyPath,
    "--key-id",
    credentials.keyId,
    "--issuer",
    credentials.issuer,
  ];
}

function commandOutput(result: NotarizationCommandResult): string {
  return [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
}

function diagnostic(result: NotarizationCommandResult): string {
  if (result.timedOut) return "the subprocess timed out";
  return commandOutput(result).slice(-12_000) || `exit code ${result.exitCode}`;
}

function isSuccess(result: NotarizationCommandResult): boolean {
  return result.exitCode === 0 && result.timedOut !== true;
}

function isAuthenticationFailure(value: string): boolean {
  return /\b(?:401|403)\b|unauthori[sz]ed|forbidden|authentication|invalid (?:api )?key|invalid issuer|invalid key id|credential/u.test(
    value,
  );
}

function isTransientNetworkFailure(value: string): boolean {
  return /NSURLErrorDomain\s+Code=-(?:1003|1005|1009)|\b-(?:1003|1005|1009)\b|internet connection.*offline|no network route|network.*(?:unavailable|offline|connection)|could not resolve host|nodename nor servname|dns|enotfound|eai_again|timed out|timeout|\b5\d\d\b/iu.test(
    value,
  );
}

function isTransientStaplerFailure(value: string): boolean {
  return (
    isTransientNetworkFailure(value) ||
    /cloudkit|ticket.*not found|could not find.*ticket|\berror 65\b|temporar/iu.test(value)
  );
}

function parseJson(
  output: string,
  operation: string,
  submissionId: string,
): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(output);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error(
      `notarytool ${operation} did not return valid JSON for submission ${submissionId}. The submission will not be resubmitted automatically.`,
    );
  }
}

function submissionIdFromOutput(output: string): string | undefined {
  try {
    const payload = JSON.parse(output) as { readonly id?: unknown };
    return typeof payload.id === "string" && payload.id.trim() ? payload.id.trim() : undefined;
  } catch {
    return undefined;
  }
}

function timeoutError(context: PollContext): Error {
  const outcome =
    context.lastStatus === "Accepted"
      ? "was Accepted, but stapling or validation did not complete"
      : "did not reach Accepted";
  return new Error(
    `Notarization submission ${context.submissionId} ${outcome} within ${context.timeoutMs / 60_000}m (last status: ${context.lastStatus}). Set T3CODE_NOTARIZATION_TIMEOUT_MS to a larger positive value only if Apple is still processing it.`,
  );
}

function remaining(context: PollContext): number {
  const milliseconds = context.deadline - context.now();
  if (milliseconds <= 0) throw timeoutError(context);
  return milliseconds;
}

/** `execFile` uses SIGKILL for a real hung xcrun; the outer timer also bounds test runners. */
export const runNotarizationCommand: NotarizationCommandRunner = async (command, timeoutMs) => {
  try {
    const { stdout, stderr } = await execFileAsync(command.executable, [...command.args], {
      encoding: "utf8",
      killSignal: "SIGKILL",
      maxBuffer: 1_048_576,
      timeout: timeoutMs,
    });
    return { exitCode: 0, stdout, stderr };
  } catch (cause) {
    const failure = cause as {
      readonly code?: number | string;
      readonly killed?: boolean;
      readonly signal?: string;
      readonly stderr?: string | Buffer;
      readonly stdout?: string | Buffer;
    };
    return {
      exitCode: typeof failure.code === "number" ? failure.code : 1,
      stdout: String(failure.stdout ?? ""),
      stderr: String(failure.stderr ?? ""),
      timedOut: failure.killed === true || failure.signal === "SIGKILL",
    };
  }
};

async function runBounded(
  runner: NotarizationCommandRunner,
  command: NotarizationCommand,
  timeoutMs: number,
): Promise<NotarizationCommandResult> {
  return await new Promise<NotarizationCommandResult>((resolve) => {
    let settled = false;
    const finish = (result: NotarizationCommandResult) => {
      if (settled) return;
      settled = true;
      NodeTimers.clearTimeout(timer);
      resolve(result);
    };
    const timer = NodeTimers.setTimeout(
      () => finish({ exitCode: 1, stdout: "", stderr: "", timedOut: true }),
      timeoutMs,
    );
    void runner(command, timeoutMs).then(
      (result) => finish(result),
      (cause: unknown) => finish({ exitCode: 1, stdout: "", stderr: String(cause) }),
    );
  });
}

function infoCommand(context: PollContext): NotarizationCommand {
  return {
    executable: "xcrun",
    args: [
      "notarytool",
      "info",
      context.submissionId,
      ...credentialArguments(context.credentials),
      "--output-format",
      "json",
    ],
    label: "xcrun notarytool info",
  };
}

async function pause(context: PollContext, milliseconds: number): Promise<void> {
  await context.sleep(Math.min(milliseconds, remaining(context)));
}

async function printAppleLog(context: PollContext): Promise<boolean> {
  const diagnosticDeadline = context.now() + INVALID_LOG_TIMEOUT_MS;
  for (let attempt = 1; attempt <= INVALID_LOG_ATTEMPTS; attempt += 1) {
    const milliseconds = diagnosticDeadline - context.now();
    if (milliseconds <= 0) break;
    const result = await runBounded(
      context.runner,
      {
        executable: "xcrun",
        args: [
          "notarytool",
          "log",
          context.submissionId,
          ...credentialArguments(context.credentials),
        ],
        label: "xcrun notarytool log",
      },
      Math.min(POLL_COMMAND_TIMEOUT_MS, milliseconds),
    );
    if (isSuccess(result)) {
      context.logger.error(
        `Apple notarization log for ${context.submissionId}:\n${commandOutput(result) || "(notarytool returned no log output)"}`,
      );
      return true;
    }
    const message = diagnostic(result);
    if (!result.timedOut && !isTransientNetworkFailure(message)) {
      context.logger.error(
        `Apple notarization log for ${context.submissionId} could not be retrieved: ${message}`,
      );
      return false;
    }
    if (attempt < INVALID_LOG_ATTEMPTS) {
      context.logger.warn(
        `Transient error retrieving Apple notarization log for ${context.submissionId}: ${message}. Retrying the same id.`,
      );
      await context.sleep(Math.min(5_000, Math.max(0, diagnosticDeadline - context.now())));
    }
  }
  context.logger.error(
    `Apple notarization log for ${context.submissionId} could not be retrieved within the diagnostic retry budget.`,
  );
  return false;
}

async function waitForAccepted(context: PollContext): Promise<void> {
  for (;;) {
    const result = await runBounded(
      context.runner,
      infoCommand(context),
      Math.min(POLL_COMMAND_TIMEOUT_MS, remaining(context)),
    );
    const message = diagnostic(result);
    if (!isSuccess(result)) {
      if (isAuthenticationFailure(message)) {
        throw new Error(
          `notarytool authentication failed while checking submission ${context.submissionId}: ${message}`,
        );
      }
      if (!result.timedOut && !isTransientNetworkFailure(message)) {
        throw new Error(
          `notarytool info failed for submission ${context.submissionId}: ${message}. The submission will not be resubmitted automatically.`,
        );
      }
      context.logger.warn(
        `Transient error while checking submission ${context.submissionId}: ${message}. Retrying the same submission id.`,
      );
      await pause(context, POLL_INTERVAL_MS);
      continue;
    }

    const payload = parseJson(result.stdout, "info", context.submissionId);
    const status = payload.status;
    if (typeof status !== "string" || !status) {
      throw new Error(
        `notarytool info returned no status for submission ${context.submissionId}. The submission will not be resubmitted automatically.`,
      );
    }
    context.lastStatus = status;
    if (status === "Accepted") {
      context.logger.info(`Submission ${context.submissionId} is Accepted.`);
      return;
    }
    if (status === "Invalid") {
      const printedLog = await printAppleLog(context);
      throw new Error(
        printedLog
          ? `Apple marked notarization submission ${context.submissionId} Invalid. The full Apple notarization log was printed above.`
          : `Apple marked notarization submission ${context.submissionId} Invalid. Apple log retrieval failed; see the preceding diagnostic.`,
      );
    }
    if (status !== "In Progress") {
      throw new Error(
        `Apple returned unexpected notarization status "${status}" for submission ${context.submissionId}. The submission will not be resubmitted automatically.`,
      );
    }
    context.logger.info(`Submission ${context.submissionId} remains In Progress.`);
    await pause(context, POLL_INTERVAL_MS);
  }
}

async function stapleAndValidate(context: PollContext, appPath: string): Promise<void> {
  const deadline = context.now() + STAPLER_TIMEOUT_MS;
  const terminalRemaining = (): number => {
    const milliseconds = deadline - context.now();
    if (milliseconds <= 0) {
      throw new Error(
        `Stapling or validation did not complete within ${STAPLER_TIMEOUT_MS / 60_000}m after submission ${context.submissionId} was Accepted.`,
      );
    }
    return milliseconds;
  };
  let lastMessage = "";
  for (let attempt = 1; attempt <= STAPLER_RETRY_ATTEMPTS; attempt += 1) {
    const staple = await runBounded(
      context.runner,
      { executable: "xcrun", args: ["stapler", "staple", appPath], label: "xcrun stapler staple" },
      Math.min(POLL_COMMAND_TIMEOUT_MS, terminalRemaining()),
    );
    let result = staple;
    if (isSuccess(staple)) {
      result = await runBounded(
        context.runner,
        {
          executable: "xcrun",
          args: ["stapler", "validate", appPath],
          label: "xcrun stapler validate",
        },
        Math.min(POLL_COMMAND_TIMEOUT_MS, terminalRemaining()),
      );
    }
    if (isSuccess(result)) {
      context.logger.info(`Stapled and validated ${appPath}.`);
      return;
    }
    lastMessage = diagnostic(result);
    if (!result.timedOut && !isTransientStaplerFailure(lastMessage)) break;
    if (attempt < STAPLER_RETRY_ATTEMPTS) {
      context.logger.warn(
        `Transient stapler error for submission ${context.submissionId}: ${lastMessage}. Retrying without resubmitting.`,
      );
      await context.sleep(Math.min(STAPLER_RETRY_DELAY_MS, terminalRemaining()));
    }
  }
  throw new Error(
    `Could not staple and validate ${appPath} after submission ${context.submissionId} was Accepted: ${lastMessage}`,
  );
}

function createPollContext(input: {
  readonly submissionId: string;
  readonly credentials: NotarizationCredentials;
  readonly timeoutMs: number;
  readonly runner: NotarizationCommandRunner;
  readonly now: () => number;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly logger: NotarizationLogger;
}): PollContext {
  return {
    ...input,
    deadline: input.now() + input.timeoutMs,
    lastStatus: "notarytool info has not returned",
  };
}

export interface PollNotarizationSubmissionInput {
  readonly submissionId: string;
  readonly credentials?: NotarizationCredentials;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs?: number;
  readonly runner?: NotarizationCommandRunner;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly logger?: NotarizationLogger;
}

/** Poll an existing Apple submission without creating another one. */
export async function pollNotarizationSubmission(
  input: PollNotarizationSubmissionInput,
): Promise<{ readonly submissionId: string; readonly status: "Accepted" }> {
  const env = input.env ?? process.env;
  const submissionId = input.submissionId.trim();
  if (!submissionId) throw new Error("submissionId must not be empty.");
  const context = createPollContext({
    submissionId,
    credentials: input.credentials ?? resolveNotarizationCredentials(env),
    timeoutMs: pollTimeout(input, env),
    runner: input.runner ?? runNotarizationCommand,
    now: input.now ?? Date.now,
    sleep: input.sleep ?? ((milliseconds) => NodeTimersPromises.setTimeout(milliseconds)),
    logger: input.logger ?? processLogger,
  });
  await waitForAccepted(context);
  return { submissionId, status: "Accepted" };
}

export interface NotarizeMacAppInput extends Omit<PollNotarizationSubmissionInput, "submissionId"> {
  readonly appPath: string;
}

/**
 * Submit a temporary ZIP once. Polling starts only after the returned ID is
 * durable, and the original .app is stapled before electron-builder creates its DMG and ZIP.
 */
export async function notarizeMacApp(
  input: NotarizeMacAppInput,
): Promise<{ readonly submissionId: string }> {
  const env = input.env ?? process.env;
  const credentials = input.credentials ?? resolveNotarizationCredentials(env);
  const runner = input.runner ?? runNotarizationCommand;
  const logger = input.logger ?? processLogger;
  // Validate before the non-idempotent submit. A bad configuration must never
  // create a submission that this hook then cannot safely monitor.
  const timeoutMs = pollTimeout(input, env);
  const temporaryDirectory = await NodeFSP.mkdtemp(
    NodePath.join(NodeOS.tmpdir(), "t3code-notarization-"),
  );
  const archivePath = NodePath.join(temporaryDirectory, "notarization-upload.zip");

  try {
    const archive = await runBounded(
      runner,
      {
        executable: "ditto",
        args: ["-c", "-k", "--keepParent", input.appPath, archivePath],
        label: "ditto notarization upload archive",
      },
      SUBMISSION_COMMAND_TIMEOUT_MS,
    );
    if (!isSuccess(archive))
      throw new Error(`Could not create notarization upload ZIP: ${diagnostic(archive)}`);

    const submit = await runBounded(
      runner,
      {
        executable: "xcrun",
        args: [
          "notarytool",
          "submit",
          archivePath,
          ...credentialArguments(credentials),
          "--no-wait",
          "--output-format",
          "json",
        ],
        label: "xcrun notarytool submit",
      },
      SUBMISSION_COMMAND_TIMEOUT_MS,
    );
    const submitMessage = diagnostic(submit);
    if (!isSuccess(submit)) {
      if (isAuthenticationFailure(submitMessage)) {
        throw new Error(
          `notarytool authentication failed while submitting the app: ${submitMessage}`,
        );
      }
      const recoveredId = submissionIdFromOutput(submit.stdout);
      throw new Error(
        `notarytool submit did not return a confirmed submission id: ${submitMessage}. No automatic retry was attempted.${recoveredId ? ` Apple may have received submission ${recoveredId}; query that id manually.` : " The submission outcome is unknown."}`,
      );
    }

    let submissionId: string;
    try {
      const id = parseJson(submit.stdout, "submit", "unknown").id;
      if (typeof id !== "string" || !id.trim()) throw new Error("missing id");
      submissionId = id.trim();
    } catch {
      throw new Error(
        "notarytool submit returned without a usable submission id. No automatic retry was attempted because the submission outcome is unknown.",
      );
    }

    const receiptPath = NodePath.join(
      env.RUNNER_TEMP?.trim() || NodePath.dirname(input.appPath),
      `t3code-notarization-submission-${process.pid}.json`,
    );
    try {
      await NodeFSP.writeFile(
        receiptPath,
        `${JSON.stringify({ submissionId, appPath: input.appPath })}\n`,
      );
      logger.info(
        `Submitted ${submissionId}; receipt: ${receiptPath}. Polling this exact id only.`,
      );
    } catch (cause) {
      logger.warn(
        `Submitted ${submissionId}; could not write receipt: ${String(cause)}. Polling this exact id only.`,
      );
    }

    const context = createPollContext({
      submissionId,
      credentials,
      timeoutMs,
      runner,
      now: input.now ?? Date.now,
      sleep: input.sleep ?? ((milliseconds) => NodeTimersPromises.setTimeout(milliseconds)),
      logger,
    });
    await waitForAccepted(context);
    await stapleAndValidate(context, input.appPath);
    await NodeFSP.rm(receiptPath, { force: true });
    return { submissionId };
  } finally {
    await NodeFSP.rm(temporaryDirectory, { force: true, recursive: true }).catch(() => undefined);
  }
}

interface AfterSignContext {
  readonly electronPlatformName: string;
  readonly appOutDir: string;
  readonly packager: { readonly appInfo: { readonly productFilename: string } };
}

/** electron-builder invokes afterSign after codesign and before distributable targets. */
export default async function notarizeAfterSign(context: AfterSignContext): Promise<void> {
  if (context.electronPlatformName !== "darwin") return;
  const productFilename = context.packager.appInfo.productFilename;
  await notarizeMacApp({
    appPath: NodePath.join(
      context.appOutDir,
      productFilename.endsWith(".app") ? productFilename : `${productFilename}.app`,
    ),
  });
}
