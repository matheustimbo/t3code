import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

// Tests the emitted package entrypoint in separate processes. The preload
// blocks sockets, providers and live-state paths; it never starts a server.
const args = process.argv.slice(2);
let bin = NodeURL.fileURLToPath(new URL("../dist/bin.mjs", import.meta.url));
let output;
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === "--bin") bin = NodePath.resolve(args[++index]);
  else if (args[index] === "--output") output = NodePath.resolve(args[++index]);
  else throw new Error("Use --bin PATH and --output REPORT.json");
}
NodeAssert.ok(output, "An explicit --output outside the checkout is required");
NodeAssert.ok(
  NodeFS.existsSync(bin),
  "Build the official bundle first with pnpm --filter t3 build:bundle",
);
const fixture = NodeURL.fileURLToPath(
  new URL("./fixtures/threadCli.fetchFixture.mjs", import.meta.url),
);
const packageJson = JSON.parse(
  NodeFS.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
const temporary = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-cli-process-smoke-"));
const credential = "synthetic-process-fixture-credential";
const promptText = "Synthetic process fixture prompt, never logged.";
const credentialPath = NodePath.join(temporary, "fixture-credential");
const promptPath = NodePath.join(temporary, "fixture-prompt.txt");
NodeFS.writeFileSync(credentialPath, credential, { mode: 0o600 });
NodeFS.writeFileSync(promptPath, promptText);
const threadId = "process-fixture-thread";
const messageId = "process-fixture-message";
const projectFlags = ["--project", "process-fixture-project"];
const mutationFlags = [
  "--environment-id",
  "process-fixture-environment",
  ...projectFlags,
  "--workspace",
  "/fixture/process-project",
];
const sendFlags = [
  threadId,
  ...mutationFlags,
  "--runtime-mode",
  "approval-required",
  "--prompt-file",
  promptPath,
];
const results = [];

const run = (
  scenario,
  command,
  { error, json = true, server = "https://process-fixture.invalid", timeoutSeconds = 15 } = {},
) => {
  const auditPath = NodePath.join(temporary, `${scenario}-audit.json`);
  const fd = NodeFS.openSync(credentialPath, "r");
  const startedAt = process.hrtime.bigint();
  let child;
  try {
    child = NodeChildProcess.spawnSync(
      process.execPath,
      [
        "--import",
        fixture,
        bin,
        ...command,
        ...(scenario === "help" || scenario === "version"
          ? []
          : ["--server", server, "--token-fd", "3", ...(json ? ["--json"] : [])]),
      ],
      {
        cwd: temporary,
        stdio: ["ignore", "pipe", "pipe", fd],
        encoding: "utf8",
        timeout: timeoutSeconds * 1000,
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          TMPDIR: temporary,
          T3CODE_HOME: NodePath.join(temporary, "isolated-t3-state"),
          XDG_CONFIG_HOME: NodePath.join(temporary, "config"),
          XDG_DATA_HOME: NodePath.join(temporary, "data"),
          XDG_CACHE_HOME: NodePath.join(temporary, "cache"),
          NO_COLOR: "1",
          TERM: "dumb",
          T3_CLI_SMOKE_CASE: scenario,
          T3_CLI_SMOKE_AUDIT: auditPath,
        },
      },
    );
  } finally {
    NodeFS.closeSync(fd);
  }
  NodeAssert.equal(child.error, undefined, `${scenario}: process failed to finish`);
  NodeAssert.equal(child.signal, null, `${scenario}: process was terminated`);
  NodeAssert.equal(
    child.status,
    error ? 1 : 0,
    `${scenario}: unexpected exit code\n${child.stdout}\n${child.stderr}`,
  );
  NodeAssert.ok(
    !`${child.stdout}${child.stderr}`.includes(credential),
    `${scenario}: credential appeared in output`,
  );
  NodeAssert.ok(
    !`${child.stdout}${child.stderr}`.includes(promptText),
    `${scenario}: prompt appeared in output`,
  );
  const audit = JSON.parse(NodeFS.readFileSync(auditPath, "utf8"));
  NodeAssert.deepEqual(audit.blocked, [], `${scenario}: attempted real side effect`);
  const value =
    json && scenario !== "help" && scenario !== "version" ? JSON.parse(child.stdout.trim()) : null;
  if (error && json) {
    NodeAssert.equal(value.ok, false);
    NodeAssert.equal(value.error.code, error);
  }
  results.push({
    scenario,
    exitCode: child.status,
    requests: audit.requests,
    dispatched: audit.dispatched,
    accepted: audit.accepted,
    result: value,
    durationMs: Number(process.hrtime.bigint() - startedAt) / 1e6,
  });
  console.log(`CHECK ${scenario} (exit ${child.status})`);
  return { value, audit, stdout: child.stdout, stderr: child.stderr };
};

try {
  NodeAssert.match(
    run("help", ["thread", "--help"], { json: false }).stdout,
    /create[\s\S]*send[\s\S]*status[\s\S]*wait/,
  );
  NodeAssert.equal(
    run("version", ["--version"], { json: false }).stdout.trim(),
    `t3 v${packageJson.version}`,
  );
  const projects = run("read_projects", ["project", "list"]);
  NodeAssert.equal(projects.value.projects[0].id, "process-fixture-project");
  NodeAssert.equal(
    projects.audit.requests.every((r) => r.method === "GET"),
    true,
  );
  const threads = run("read_threads", ["thread", "list", ...projectFlags]);
  NodeAssert.equal(threads.value.threads[0].id, threadId);
  NodeAssert.equal(threads.audit.requests.length, 3);
  NodeAssert.match(
    run("text_projects", ["project", "list"], { json: false }).stdout,
    /Process fixture project/,
  );
  const creationPreview = run("create_preview", [
    "thread",
    "create",
    ...mutationFlags,
    "--title",
    "Process fixture creation",
  ]);
  NodeAssert.equal(creationPreview.value.executed, false);
  NodeAssert.deepEqual(creationPreview.audit.dispatched, []);
  const created = run("create_execute", [
    "thread",
    "create",
    ...mutationFlags,
    "--title",
    "Process fixture creation",
    "--execute",
  ]);
  NodeAssert.equal(created.value.executed, true);
  NodeAssert.equal(created.audit.accepted.length, 1);
  NodeAssert.equal(created.audit.accepted[0].type, "thread.create");
  const preview = run("send_preview", ["thread", "send", ...sendFlags]);
  NodeAssert.equal(preview.value.executed, false);
  NodeAssert.deepEqual(preview.audit.dispatched, []);
  const sent = run("send_execute", ["thread", "send", ...sendFlags, "--execute"]);
  NodeAssert.equal(sent.audit.accepted.length, 1);
  NodeAssert.equal(sent.value.receipt.sequence, 2);
  NodeAssert.equal(sent.value.waitState, undefined);
  NodeAssert.ok(sent.value.messageId);
  NodeAssert.equal(
    run("status", ["thread", "status", threadId, ...projectFlags, "--message-id", messageId]).value
      .result[0].text,
    "Process fixture result",
  );
  NodeAssert.equal(
    run("wait_completed", ["thread", "wait", threadId, ...projectFlags, "--message-id", messageId])
      .value.waitState,
    "completed",
  );
  const delayed = run("wait_delayed", [
    "thread",
    "wait",
    threadId,
    ...projectFlags,
    "--message-id",
    messageId,
  ]);
  NodeAssert.equal(delayed.value.result[0].text, "Process fixture result");
  NodeAssert.equal(delayed.value.latestTurn.userMessageId, messageId);
  NodeAssert.equal(
    delayed.audit.requests.filter((r) => r.path === "/api/orchestration/shell").length,
    4,
  );
  NodeAssert.equal(
    run("wait_attention", ["thread", "wait", threadId, ...projectFlags, "--message-id", messageId])
      .value.waitState,
    "needs_attention",
  );
  run(
    "wait_timeout",
    [
      "thread",
      "wait",
      threadId,
      ...projectFlags,
      "--message-id",
      messageId,
      "--timeout-seconds",
      "1",
    ],
    { error: "wait_timeout" },
  );
  run("mixed_snapshot", ["thread", "status", threadId, ...projectFlags], {
    error: "snapshot_changed",
  });
  NodeAssert.deepEqual(
    run("missing_operate", ["thread", "send", ...sendFlags, "--execute"], {
      error: "insufficient_scope",
    }).audit.dispatched,
    [],
  );
  for (const [scenario, error] of [
    ["wrong_environment", "destination_mismatch"],
    ["old_server", "unsupported_preconditions"],
  ]) {
    const refused = run(scenario, ["thread", "send", ...sendFlags, "--execute"], { error });
    NodeAssert.equal(refused.audit.requests.length, 1);
    NodeAssert.equal(refused.audit.requests[0].authenticated, false);
  }
  for (const [scenario, error] of [
    ["excessive_scope", "excessive_scope"],
    ["cookie_session", "unsupported_auth"],
  ])
    NodeAssert.deepEqual(run(scenario, ["project", "list"], { error }).audit.dispatched, []);
  for (const scenario of ["raced_send", "transport_failure"]) {
    const refused = run(scenario, ["thread", "send", ...sendFlags, "--execute"], {
      error: "remote_request",
    });
    NodeAssert.equal(refused.audit.dispatched.length, 1);
    NodeAssert.deepEqual(refused.audit.accepted, []);
    NodeAssert.equal(refused.audit.dispatched[0].expectedSnapshotSequence, 1);
  }
  NodeAssert.deepEqual(
    run("unsafe_origin", ["project", "list"], {
      error: "invalid_server",
      server: "http://process-fixture.invalid",
    }).audit.requests,
    [],
  );
  const plainFailure = run("text_failure", ["project", "list"], {
    error: "invalid_server",
    json: false,
    server: "http://process-fixture.invalid",
  });
  NodeAssert.equal(plainFailure.stdout, "");
  NodeAssert.match(plainFailure.stderr, /Use an HTTPS origin/);
  NodeFS.writeFileSync(promptPath, new Uint8Array([0xff]));
  NodeAssert.deepEqual(
    run("invalid_utf8", ["thread", "send", ...sendFlags, "--execute"], { error: "prompt_input" })
      .audit.dispatched,
    [],
  );
  const report = {
    status: "passed",
    scenarios: results.length,
    version: packageJson.version,
    bundle: bin,
    bundleSha256: NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(bin)).digest("hex"),
    node: process.version,
    transport: "preloaded synthetic fetch; sockets, providers and live state blocked",
    results,
  };
  NodeFS.mkdirSync(NodePath.dirname(output), { recursive: true });
  NodeFS.writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
  console.log(`Passed ${results.length} bundle-process scenarios. Report: ${output}`);
} finally {
  NodeFS.rmSync(temporary, { recursive: true, force: true });
}
