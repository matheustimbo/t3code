import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeDgram from "node:dgram";
import * as NodeDns from "node:dns";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";
import * as NodeModule from "node:module";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import * as NodeTls from "node:tls";
import * as NodeURL from "node:url";

// Preloaded only by the process smoke test. All requests stay in this fixture;
// accidental network, provider execution or access to live state fails closed.
const scenario = process.env.T3_CLI_SMOKE_CASE;
const auditPath = process.env.T3_CLI_SMOKE_AUDIT;
NodeAssert.ok(scenario && auditPath && NodePath.isAbsolute(auditPath));
const credential = "synthetic-process-fixture-credential";
const prompt = "Synthetic process fixture prompt, never logged.";
const stamp = "2026-10-02T10:00:00.000Z";
const environmentId = "process-fixture-environment";
const projectId = "process-fixture-project";
const threadId = "process-fixture-thread";
const messageId = "process-fixture-message";
const modelSelection = { instanceId: "codex", model: "fixture-model" };
const audit = { requests: [], dispatched: [], accepted: [], blocked: [], shellReads: 0 };
const writeAudit = NodeFS.writeFileSync;
process.on("exit", () => writeAudit(auditPath, JSON.stringify(audit), { mode: 0o600 }));

const forbidden = (kind) => {
  audit.blocked.push(kind);
  throw new Error(`Smoke fixture blocked ${kind}`);
};
for (const [module, methods, kind] of [
  [
    NodeChildProcess.default,
    ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"],
    "subprocess",
  ],
  [NodeNet.default, ["connect", "createConnection", "createServer"], "network"],
  [NodeTls.default, ["connect", "createServer"], "network"],
  [NodeHttp.default, ["request", "get", "createServer"], "network"],
  [NodeHttps.default, ["request", "get", "createServer"], "network"],
  [NodeDgram.default, ["createSocket"], "network"],
  [NodeDns.default, ["lookup", "resolve", "resolve4", "resolve6"], "DNS"],
]) {
  for (const method of methods) module[method] = () => forbidden(kind);
}
globalThis.WebSocket = function FixtureWebSocket() {
  forbidden("WebSocket");
};

const guardPath = (file) => {
  const path =
    file instanceof URL ? NodeURL.fileURLToPath(file) : typeof file === "string" ? file : "";
  if (/(?:^|\/)\.(?:t3|codex|aws|ssh)(?:\/|$)|\/auth\.json$|\/\.env(?:\.|$)/.test(path))
    forbidden("live state file");
};
for (const method of [
  "openSync",
  "readFileSync",
  "statSync",
  "lstatSync",
  "readdirSync",
  "accessSync",
  "realpathSync",
  "existsSync",
  "open",
  "readFile",
  "stat",
  "lstat",
  "readdir",
  "access",
  "realpath",
]) {
  const original = NodeFS.default[method];
  NodeFS.default[method] = (file, ...args) => {
    guardPath(file);
    return original(file, ...args);
  };
}
for (const method of ["open", "readFile", "stat", "lstat", "readdir", "access", "realpath"]) {
  const original = NodeFS.promises[method];
  NodeFS.promises[method] = (file, ...args) => {
    guardPath(file);
    return original(file, ...args);
  };
}
NodeModule.syncBuiltinESMExports();

const project = {
  id: projectId,
  title: "Process fixture project",
  workspaceRoot: "/fixture/process-project",
  defaultModelSelection: modelSelection,
  scripts: [],
  createdAt: stamp,
  updatedAt: stamp,
};
const thread = {
  id: threadId,
  projectId,
  title: "Process fixture thread",
  modelSelection,
  runtimeMode: "approval-required",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  session: null,
  createdAt: stamp,
  updatedAt: stamp,
  archivedAt: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
  backgroundLiveness: null,
};
let sequence = 1;
let threads = [thread];
let resultText = "Process fixture result";
const completedTurn = (userMessageId = messageId) => ({
  turnId: "process-fixture-turn",
  userMessageId,
  state: "completed",
  requestedAt: stamp,
  startedAt: stamp,
  completedAt: stamp,
  assistantMessageId: "process-fixture-assistant",
});
if (
  [
    "status",
    "wait_completed",
    "wait_attention",
    "wait_delayed",
    "wait_timeout",
    "mixed_snapshot",
  ].includes(scenario)
) {
  thread.latestTurn = completedTurn(
    ["wait_delayed", "wait_timeout"].includes(scenario) ? "previous-message" : messageId,
  );
  if (["wait_delayed", "wait_timeout"].includes(scenario))
    resultText = "Previous result must not be returned";
  if (scenario === "wait_attention") thread.hasPendingApprovals = true;
}

const scopes = [
  "read_projects",
  "read_threads",
  "text_projects",
  "create_preview",
  "send_preview",
  "missing_operate",
].includes(scenario)
  ? ["orchestration:read"]
  : scenario === "excessive_scope"
    ? ["orchestration:read", "terminal:operate"]
    : ["orchestration:read", "orchestration:operate"];
const descriptor = {
  environmentId: scenario === "wrong_environment" ? "wrong-environment" : environmentId,
  label: "Process fixture server",
  platform: { os: "linux", arch: "x64" },
  serverVersion: "fixture-server",
  orchestrationProtocolVersion: 1,
  capabilities: {
    repositoryIdentity: false,
    threadCommandPreconditions: scenario !== "old_server",
    threadTurnMessageCorrelation: true,
  },
};

globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  NodeAssert.equal(url.origin, "https://process-fixture.invalid");
  NodeAssert.equal(init?.redirect, "error");
  NodeAssert.equal(init?.credentials, "omit");
  const authorization = new Headers(init?.headers).get("authorization");
  audit.requests.push({
    path: url.pathname,
    method: init?.method ?? "GET",
    authenticated: authorization !== null,
  });
  if (url.pathname === "/.well-known/t3/environment") {
    NodeAssert.equal(authorization, null);
    return Response.json(descriptor);
  }
  NodeAssert.equal(authorization, `Bearer ${credential}`);
  if (url.pathname === "/api/auth/session")
    return Response.json({
      authenticated: true,
      auth: {
        policy: "remote-reachable",
        bootstrapMethods: [],
        sessionMethods: ["bearer-access-token"],
        sessionCookieName: "fixture-cookie",
      },
      sessionMethod:
        scenario === "cookie_session" ? "browser-session-cookie" : "bearer-access-token",
      scopes,
    });
  if (url.pathname === "/api/orchestration/shell") {
    audit.shellReads += 1;
    if (scenario === "wait_delayed" && audit.shellReads === 3) {
      sequence += 1;
      thread.latestTurn = completedTurn();
      resultText = "Process fixture result";
    }
    return Response.json({
      snapshotSequence: sequence,
      updatedAt: stamp,
      projects: [project],
      threads,
    });
  }
  if (url.pathname === `/api/orchestration/threads/${threadId}`) {
    NodeAssert.equal(url.searchParams.get("turnLimit"), "1");
    return Response.json({
      snapshotSequence: scenario === "mixed_snapshot" ? sequence + 1 : sequence,
      thread: {
        ...thread,
        deletedAt: null,
        messages: thread.latestTurn
          ? [
              {
                id: "process-fixture-assistant",
                role: "assistant",
                text: resultText,
                turnId: thread.latestTurn.turnId,
                streaming: false,
                createdAt: stamp,
                updatedAt: stamp,
              },
            ]
          : [],
        activities: [],
        checkpoints: [],
      },
    });
  }
  if (url.pathname === "/api/orchestration/dispatch") {
    NodeAssert.equal(init?.method, "POST");
    const body = init.body;
    const text =
      typeof body === "string"
        ? body
        : body instanceof Uint8Array
          ? new TextDecoder().decode(body)
          : null;
    NodeAssert.ok(text);
    const command = JSON.parse(text);
    audit.dispatched.push({
      type: command.type,
      threadId: command.threadId,
      expectedSnapshotSequence: command.expectedSnapshotSequence,
      runtimeMode: command.runtimeMode,
    });
    if (scenario === "transport_failure") throw new Error(`${credential} ${prompt}`);
    if (scenario === "raced_send") {
      thread.runtimeMode = "full-access";
      sequence += 1;
    }
    if (command.expectedSnapshotSequence !== sequence || !scopes.includes("orchestration:operate"))
      return Response.json(
        {
          _tag: "OrchestrationDispatchCommandError",
          message: "Fixture rejected stale or unauthorized command",
        },
        { status: 400 },
      );
    NodeAssert.equal(command.runtimeMode, "approval-required");
    if (command.type === "thread.create") {
      NodeAssert.equal(command.projectId, projectId);
      NodeAssert.equal(command.worktreePath, null);
      NodeAssert.equal(command.branch, null);
      NodeAssert.equal(command.bootstrap, undefined);
      threads = [...threads, { ...thread, id: command.threadId, title: command.title }];
    } else {
      NodeAssert.equal(command.type, "thread.turn.start");
      NodeAssert.equal(command.threadId, threadId);
      NodeAssert.equal(command.message.text, prompt);
      NodeAssert.deepEqual(command.message.attachments, []);
      NodeAssert.equal(command.bootstrap, undefined);
    }
    audit.accepted.push({ type: command.type, threadId: command.threadId });
    sequence += 1;
    return Response.json({ sequence });
  }
  return forbidden("unrecognized HTTP endpoint");
};
