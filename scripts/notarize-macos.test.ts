// @effect-diagnostics nodeBuiltinImport:off - The hook tests create isolated temporary receipt directories.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { expect, it } from "vite-plus/test";

import {
  notarizeMacApp,
  pollNotarizationSubmission,
  type NotarizationCommand,
  type NotarizationCommandResult,
  type NotarizationCommandRunner,
  type NotarizationCredentials,
  type NotarizationLogger,
} from "./notarize-macos.ts";

const submissionId = "54f87778-6e74-431b-bd8a-c790ee822b63";
const credentials: NotarizationCredentials = {
  keyPath: "/tmp/AuthKey_test.p8",
  keyId: "TESTKEY123",
  issuer: "b09e8c8b-2756-46ed-8498-2b45ab7a0968",
};

const accepted = JSON.stringify({
  id: submissionId,
  name: "T3 Code (Alpha).zip",
  status: "Accepted",
  createdDate: "2026-09-06T17:22:46.933Z",
  message: "Successfully received submission info",
});

const result = (stdout = "", stderr = "", exitCode = 0): NotarizationCommandResult => ({
  exitCode,
  stdout,
  stderr,
});

type Step =
  | NotarizationCommandResult
  | ((command: NotarizationCommand, timeoutMs: number) => Promise<NotarizationCommandResult>);

function scriptedRunner(steps: readonly Step[]) {
  const pending = [...steps];
  const commands: NotarizationCommand[] = [];
  const runner: NotarizationCommandRunner = async (command, timeoutMs) => {
    commands.push({ ...command, args: [...command.args] });
    const next = pending.shift();
    if (!next) throw new Error(`Unexpected ${command.label}.`);
    return typeof next === "function" ? next(command, timeoutMs) : next;
  };
  return { commands, runner };
}

function recordedLogger() {
  const info: string[] = [];
  const warn: string[] = [];
  const error: string[] = [];
  const logger: NotarizationLogger = {
    info: (message) => info.push(message),
    warn: (message) => warn.push(message),
    error: (message) => error.push(message),
  };
  return { error, info, logger, warn };
}

function advancingClock() {
  let now = 0;
  return {
    now: () => now,
    sleep: async (milliseconds: number) => {
      now += milliseconds;
    },
  };
}

async function withReceiptDirectory<T>(
  run: (env: Record<string, string>) => Promise<T>,
): Promise<T> {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3code-notarize-test-"));
  try {
    return await run({ RUNNER_TEMP: directory });
  } finally {
    await NodeFSP.rm(directory, { force: true, recursive: true });
  }
}

function commandsFor(commands: readonly NotarizationCommand[], operation: string) {
  return commands.filter((command) => command.args[1] === operation);
}

it("submits once and retries -1009, DNS, and 5xx info failures against the same submission", async () => {
  const { commands, runner } = scriptedRunner([
    result(),
    result(JSON.stringify({ id: submissionId })),
    result("", "NSURLErrorDomain Code=-1009 The Internet connection appears to be offline.", 1),
    result(
      "",
      "NSURLErrorDomain Code=-1003 A server with the specified hostname could not be found.",
      1,
    ),
    result("", "HTTP status code: 503", 1),
    result(accepted),
    result("", "NSURLErrorDomain Code=-1005 The network connection was lost.", 1),
    result(),
    result(),
  ]);
  const clock = advancingClock();
  const logs = recordedLogger();

  await withReceiptDirectory((env) =>
    notarizeMacApp({
      appPath: "/tmp/T3 Code.app",
      credentials,
      env,
      logger: logs.logger,
      now: clock.now,
      runner,
      sleep: clock.sleep,
      timeoutMs: 1_000_000,
    }),
  );

  const submits = commandsFor(commands, "submit");
  const infos = commandsFor(commands, "info");
  expect(submits).toHaveLength(1);
  expect(infos).toHaveLength(4);
  expect(infos.map((command) => command.args[2])).toEqual([
    submissionId,
    submissionId,
    submissionId,
    submissionId,
  ]);
  expect(commandsFor(commands, "staple")).toHaveLength(2);
  expect(commandsFor(commands, "validate")).toHaveLength(1);
  expect(logs.warn).toHaveLength(4);
});

it("prints Apple's full Invalid log and does not package or resubmit", async () => {
  const fullAppleLog = "first diagnostic from Apple\nlast diagnostic from Apple";
  const { commands, runner } = scriptedRunner([
    result(),
    result(JSON.stringify({ id: submissionId })),
    result(JSON.stringify({ id: submissionId, status: "Invalid" })),
    result("", "NSURLErrorDomain Code=-1005 The network connection was lost.", 1),
    result(fullAppleLog),
  ]);
  const clock = advancingClock();
  const logs = recordedLogger();

  await expect(
    withReceiptDirectory((env) =>
      notarizeMacApp({
        appPath: "/tmp/T3 Code.app",
        credentials,
        env,
        logger: logs.logger,
        now: clock.now,
        runner,
        sleep: clock.sleep,
        timeoutMs: 1_000_000,
      }),
    ),
  ).rejects.toThrow(/Invalid/u);

  expect(commandsFor(commands, "submit")).toHaveLength(1);
  expect(commandsFor(commands, "info")).toHaveLength(1);
  expect(commandsFor(commands, "log")).toHaveLength(2);
  expect(commandsFor(commands, "staple")).toHaveLength(0);
  expect(logs.error.join("\n")).toContain(fullAppleLog);
  expect(logs.warn.join("\n")).toContain("Transient error retrieving Apple notarization log");
});

it("starts stapling when Accepted arrives at the polling deadline", async () => {
  let now = 0;
  const { commands, runner } = scriptedRunner([
    result(),
    result(JSON.stringify({ id: submissionId })),
    async () => {
      now = 1;
      return result(accepted);
    },
    result(),
    result(),
  ]);

  await withReceiptDirectory((env) =>
    notarizeMacApp({
      appPath: "/tmp/T3 Code.app",
      credentials,
      env,
      now: () => now,
      runner,
      sleep: async () => undefined,
      timeoutMs: 1,
    }),
  );

  expect(commandsFor(commands, "staple")).toHaveLength(1);
  expect(commandsFor(commands, "validate")).toHaveLength(1);
});

it("downloads an Invalid log when Invalid arrives at the polling deadline", async () => {
  let now = 0;
  const fullAppleLog = "Apple found a signing issue";
  const { commands, runner } = scriptedRunner([
    result(),
    result(JSON.stringify({ id: submissionId })),
    async () => {
      now = 1;
      return result(JSON.stringify({ id: submissionId, status: "Invalid" }));
    },
    result(fullAppleLog),
  ]);
  const logs = recordedLogger();

  await expect(
    withReceiptDirectory((env) =>
      notarizeMacApp({
        appPath: "/tmp/T3 Code.app",
        credentials,
        env,
        logger: logs.logger,
        now: () => now,
        runner,
        sleep: async () => undefined,
        timeoutMs: 1,
      }),
    ),
  ).rejects.toThrow(/full Apple notarization log was printed/u);

  expect(commandsFor(commands, "log")).toHaveLength(1);
  expect(logs.error.join("\n")).toContain(fullAppleLog);
});

it("does not claim an Invalid log was printed when Apple log retrieval fails", async () => {
  const { runner } = scriptedRunner([
    result(),
    result(JSON.stringify({ id: submissionId })),
    result(JSON.stringify({ id: submissionId, status: "Invalid" })),
    result("", "notarytool log failed permanently", 1),
  ]);
  const clock = advancingClock();

  await expect(
    withReceiptDirectory((env) =>
      notarizeMacApp({
        appPath: "/tmp/T3 Code.app",
        credentials,
        env,
        now: clock.now,
        runner,
        sleep: clock.sleep,
        timeoutMs: 1_000_000,
      }),
    ),
  ).rejects.toThrow(/Apple log retrieval failed/u);
});

it("fails authentication errors immediately without retrying or resubmitting", async () => {
  const { commands, runner } = scriptedRunner([
    result(),
    result(JSON.stringify({ id: submissionId })),
    result("", "HTTP status code: 401 Unauthorized", 1),
  ]);
  const clock = advancingClock();

  await expect(
    withReceiptDirectory((env) =>
      notarizeMacApp({
        appPath: "/tmp/T3 Code.app",
        credentials,
        env,
        now: clock.now,
        runner,
        sleep: clock.sleep,
        timeoutMs: 1_000_000,
      }),
    ),
  ).rejects.toThrow(/authentication failed/u);

  expect(commandsFor(commands, "submit")).toHaveLength(1);
  expect(commandsFor(commands, "info")).toHaveLength(1);
  expect(commandsFor(commands, "staple")).toHaveLength(0);
});

it("bounds a hung info subprocess and reports the polling deadline", async () => {
  const runner: NotarizationCommandRunner = () =>
    new Promise<NotarizationCommandResult>(() => undefined);

  await expect(
    pollNotarizationSubmission({
      credentials,
      runner,
      sleep: async () => undefined,
      submissionId,
      timeoutMs: 20,
    }),
  ).rejects.toThrow(/did not reach Accepted/u);
});

it("retries a timed out stapler without resubmitting", async () => {
  const { runner } = scriptedRunner([
    result(),
    result(JSON.stringify({ id: submissionId })),
    result(accepted),
    { ...result("", "", 1), timedOut: true },
    { ...result("", "", 1), timedOut: true },
    { ...result("", "", 1), timedOut: true },
    { ...result("", "", 1), timedOut: true },
  ]);
  const clock = advancingClock();

  await expect(
    withReceiptDirectory((env) =>
      notarizeMacApp({
        appPath: "/tmp/T3 Code.app",
        credentials,
        env,
        now: clock.now,
        runner,
        sleep: clock.sleep,
        timeoutMs: 20,
      }),
    ),
  ).rejects.toThrow(/Could not staple and validate/u);
});

it("fails an In Progress submission at the configured polling deadline", async () => {
  const { runner } = scriptedRunner([
    result(JSON.stringify({ id: submissionId, status: "In Progress" })),
  ]);
  const clock = advancingClock();

  await expect(
    pollNotarizationSubmission({
      credentials,
      now: clock.now,
      runner,
      sleep: clock.sleep,
      submissionId,
      timeoutMs: 1,
    }),
  ).rejects.toThrow(/did not reach Accepted/u);
});

it("does not retry a submit whose result has no confirmed id", async () => {
  const { commands, runner } = scriptedRunner([result(), result("", "network connection lost", 1)]);
  const clock = advancingClock();

  await expect(
    withReceiptDirectory((env) =>
      notarizeMacApp({
        appPath: "/tmp/T3 Code.app",
        credentials,
        env,
        now: clock.now,
        runner,
        sleep: clock.sleep,
      }),
    ),
  ).rejects.toThrow(/No automatic retry was attempted/u);

  expect(commandsFor(commands, "submit")).toHaveLength(1);
  expect(commandsFor(commands, "info")).toHaveLength(0);
});

it("validates the polling timeout before creating or submitting an archive", async () => {
  const { commands, runner } = scriptedRunner([]);

  await expect(
    notarizeMacApp({
      appPath: "/tmp/T3 Code.app",
      credentials,
      runner,
      timeoutMs: 0,
    }),
  ).rejects.toThrow(/timeoutMs must be a positive integer/u);

  expect(commands).toHaveLength(0);
});
