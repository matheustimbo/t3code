#!/usr/bin/env node
// Create a T3 Code thread (with its own worktree) and send the first message,
// the same way the desktop UI does: one `thread.turn.start` with `bootstrap`.
//
//   t3-thread [-p project] [-b base] [-t title] [-m model] [--selection json] [--plan] [--no-worktree] [--local-base] [--dry-run] "message"
//   echo "message" | t3-thread -p my-project
//   t3-thread --stop <threadId> | --archive <threadId>
//
// Token: ~/.config/t3-thread/token, issued automatically when missing or rejected. Requires Node >= 22.
import { execFileSync } from "node:child_process";
import { randomUUID, randomBytes } from "node:crypto";
import { readFileSync, existsSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, dirname, basename } from "node:path";

const HOME = homedir();
const BASE_DIR = process.env.T3CODE_HOME ?? `${HOME}/.t3`;
const DB = `${BASE_DIR}/userdata/state.sqlite`;
const RUNTIME = `${BASE_DIR}/userdata/server-runtime.json`;
const TOKEN_FILE = `${HOME}/.config/t3-thread/token`;

function die(msg) {
  console.error(`t3-thread: ${msg}`);
  process.exit(1);
}

if (typeof WebSocket === "undefined") die(`Node >= 22 is required (found ${process.version})`);

const args = process.argv.slice(2);
const opts = { worktree: true, fromOrigin: true, plan: false, dryRun: false };
const positional = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  const next = () => args[++i] ?? die(`missing value for ${a}`);
  if (a === "-p" || a === "--project") opts.project = next();
  else if (a === "-b" || a === "--base") opts.base = next();
  else if (a === "-t" || a === "--title") opts.title = next();
  else if (a === "-m" || a === "--model") opts.model = next();
  else if (a === "--instance") opts.instance = next();
  else if (a === "--selection") {
    const raw = next();
    try {
      opts.selection = JSON.parse(raw);
    } catch {
      die(`--selection is not valid JSON: ${raw}`);
    }
  } else if (a === "--plan") opts.plan = true;
  else if (a === "--no-worktree") opts.worktree = false;
  else if (a === "--local-base") opts.fromOrigin = false;
  else if (a === "--dry-run") opts.dryRun = true;
  else if (a === "--stop") opts.control = { type: "thread.session.stop", threadId: next() };
  else if (a === "--archive") opts.control = { type: "thread.archive", threadId: next() };
  else if (a === "-h" || a === "--help") {
    console.log(
      readFileSync(new URL(import.meta.url))
        .toString()
        .split("\n")
        .slice(1, 9)
        .join("\n"),
    );
    process.exit(0);
  } else positional.push(a);
}

if (!existsSync(RUNTIME)) die(`T3 Code server is not running (no ${RUNTIME})`);
const { origin, pid } = JSON.parse(readFileSync(RUNTIME, "utf8"));

async function request(url, init) {
  try {
    return await fetch(url, init);
  } catch (e) {
    die(`T3 Code server at ${origin} is unreachable (${e.cause?.code ?? e.message})`);
  }
}

// The server's own CLI, so the token lands in the same auth store. server-runtime.json
// can outlive a crashed server, so only trust a pid that still looks like T3 Code.
function serverCli() {
  const read = (cmd, cmdArgs) => execFileSync(cmd, cmdArgs, { encoding: "utf8" }).trim();
  let exe, argv;
  if (existsSync(`/proc/${pid}/cmdline`)) {
    argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
    exe = read("readlink", ["-f", `/proc/${pid}/exe`]);
  } else {
    // macOS `ps` joins argv with spaces and app paths contain spaces, so cut after the exe.
    exe = read("ps", ["-o", "comm=", "-p", String(pid)]);
    const rest = read("ps", ["-o", "args=", "-p", String(pid)]).slice(exe.length);
    argv = [exe, ...(rest.match(/\/.*?bin\.mjs/) ?? [])];
  }
  const entry = argv.find((arg) => arg.endsWith("bin.mjs"));
  // The desktop app embeds the server: running its executable directly would open a second
  // app window, so run the bundled server CLI with the app's Electron acting as Node.
  const app = exe.match(/^(.*\.app\/Contents)\/MacOS\/[^/]+$/);
  if (app) {
    return {
      cmd: exe,
      pre: [entry ?? `${app[1]}/Resources/app.asar/apps/server/dist/bin.mjs`],
      env: { ELECTRON_RUN_AS_NODE: "1" },
    };
  }
  if (entry) return { cmd: exe, pre: [entry], env: {} };
  if (basename(exe) === "t3") return { cmd: exe, pre: [], env: {} };
  die(
    `pid ${pid} from ${RUNTIME} does not look like a T3 Code server (${exe}); issue a token manually into ${TOKEN_FILE}`,
  );
}

function issueToken() {
  const { cmd, pre, env } = serverCli();
  const issueArgs = [
    "auth",
    "session",
    "issue",
    "--base-dir",
    BASE_DIR,
    "--ttl",
    "30d",
    "--label",
    "t3-thread-cli",
    "--token-only",
  ];
  const fresh = execFileSync(cmd, [...pre, ...issueArgs], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  }).trim();
  if (!/^\S+$/.test(fresh)) die(`unexpected output issuing a token with ${cmd}`);
  mkdirSync(dirname(TOKEN_FILE), { recursive: true });
  chmodSync(dirname(TOKEN_FILE), 0o700);
  writeFileSync(TOKEN_FILE, fresh);
  chmodSync(TOKEN_FILE, 0o600);
  return fresh;
}

// The HTTP dispatch endpoint ignores `bootstrap`; only the WebSocket RPC creates
// the thread and worktree, so go through /ws like the UI does.
async function dispatch(command) {
  if (opts.dryRun) {
    console.log(JSON.stringify({ origin, command }, null, 2));
    process.exit(0);
  }
  await request(origin);
  let token = existsSync(TOKEN_FILE) ? readFileSync(TOKEN_FILE, "utf8").trim() : "";
  const requestTicket = () =>
    request(`${origin}/api/auth/websocket-ticket`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
  if (!token) token = issueToken();
  let ticketRes = await requestTicket();
  if (ticketRes.status === 401 || ticketRes.status === 403) {
    token = issueToken();
    ticketRes = await requestTicket();
  }
  if (!ticketRes.ok) die(`ticket HTTP ${ticketRes.status}: ${await ticketRes.text()}`);
  const { ticket } = await ticketRes.json();

  const wsUrl = new URL("/ws", origin.replace(/^http/, "ws"));
  wsUrl.searchParams.set("wsTicket", ticket);
  const ws = new WebSocket(wsUrl);
  const exit = await new Promise((resolveExit, reject) => {
    // Worktree setup keeps running on the server even if we stop waiting, so a
    // timeout is "unknown", not "failed": retrying could create a duplicate.
    const timer = setTimeout(
      () =>
        reject(
          new Error(
            `no reply after 10 min; ${command.threadId} may still be being created, check before retrying`,
          ),
        ),
      600_000,
    );
    ws.addEventListener("open", () =>
      ws.send(
        JSON.stringify({
          _tag: "Request",
          id: "1",
          tag: "orchestration.dispatchCommand",
          payload: command,
          headers: [],
        }),
      ),
    );
    ws.addEventListener("message", (ev) => {
      for (const msg of [JSON.parse(ev.data)].flat()) {
        if (msg._tag === "Exit" && String(msg.requestId) === "1") {
          clearTimeout(timer);
          resolveExit(msg.exit);
        } else if (msg._tag === "Defect" || msg._tag === "ClientProtocolError") {
          clearTimeout(timer);
          reject(new Error(`server rejected the request: ${JSON.stringify(msg)}`));
        }
      }
    });
    ws.addEventListener("error", (ev) =>
      reject(new Error(`websocket error: ${ev.message ?? ev.type}`)),
    );
    ws.addEventListener("close", (ev) =>
      reject(new Error(`websocket closed: ${ev.code} ${ev.reason}`)),
    );
  }).catch((e) => die(e.message));
  ws.close();

  if (exit._tag !== "Success") die(`dispatch failed: ${JSON.stringify(exit)}`);
  return exit.value;
}

if (opts.control) {
  const { type, threadId } = opts.control;
  const command = { type, commandId: randomUUID(), threadId };
  if (type === "thread.session.stop") command.createdAt = new Date().toISOString();
  console.log(JSON.stringify({ threadId, type, result: await dispatch(command) }));
  process.exit(0);
}

let text = positional.join(" ").trim();
if (!text && !process.stdin.isTTY) text = readFileSync(0, "utf8").trim();
if (!text) die("empty message");

const sql = (q) =>
  execFileSync("sqlite3", ["-readonly", "-json", `file:${DB}?mode=ro`, q], { encoding: "utf8" });
const projects = JSON.parse(
  sql(
    "select project_id, title, workspace_root, default_model_selection_json from projection_projects where deleted_at is null;",
  ) || "[]",
);

const git = (dir, gitArgs) => {
  try {
    return execFileSync("git", ["-C", dir, ...gitArgs], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
};
const gitMainRoot = (dir) => {
  const common = git(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  return common ? resolve(common, "..") : null;
};

let project;
if (opts.project) {
  const wanted = opts.project;
  const asPath = existsSync(wanted) ? (gitMainRoot(resolve(wanted)) ?? resolve(wanted)) : null;
  project = projects.find(
    (p) => p.title === wanted || p.project_id === wanted || p.workspace_root === asPath,
  );
} else {
  const root = gitMainRoot(process.cwd());
  project = projects.find((p) => p.workspace_root === root);
}
if (!project)
  die(
    `project not found (${opts.project ?? process.cwd()}); known: ${projects.map((p) => p.title).join(", ")}`,
  );

// A new worktree branches from origin's default branch; without one the thread runs on
// whatever the project checkout has checked out, like the UI's local mode.
const base =
  opts.base ??
  (opts.worktree
    ? (git(project.workspace_root, [
        "symbolic-ref",
        "--short",
        "refs/remotes/origin/HEAD",
      ])?.replace(/^origin\//, "") ?? "main")
    : git(project.workspace_root, ["branch", "--show-current"]) || null);

const now = new Date().toISOString();
const threadId = randomUUID();
const title = (opts.title ?? text.split("\n")[0]).trim().slice(0, 80) || die("empty title");
const projectDefault = project.default_model_selection_json
  ? JSON.parse(project.default_model_selection_json)
  : null;
const modelSelection =
  opts.selection ??
  (opts.model || opts.instance || !projectDefault
    ? {
        instanceId: opts.instance ?? "claudeAgent",
        model: opts.model ?? "claude-opus-5-5",
        options: [],
      }
    : projectDefault);
const runtimeMode = "full-access";
const interactionMode = opts.plan ? "plan" : "default";
const branchName = `t3code/${randomBytes(4).toString("hex")}`;

console.error(`t3-thread: creating ${threadId} in ${project.title}`);
const result = await dispatch({
  type: "thread.turn.start",
  commandId: randomUUID(),
  threadId,
  message: { messageId: randomUUID(), role: "user", text, attachments: [] },
  modelSelection,
  titleSeed: title,
  runtimeMode,
  interactionMode,
  bootstrap: {
    createThread: {
      projectId: project.project_id,
      title,
      modelSelection,
      runtimeMode,
      interactionMode,
      branch: base,
      worktreePath: null,
      createdAt: now,
    },
    ...(opts.worktree
      ? {
          prepareWorktree: {
            projectCwd: project.workspace_root,
            baseBranch: base,
            requireWorktree: true,
            branch: branchName,
            ...(opts.fromOrigin ? { startFromOrigin: true } : {}),
          },
          runSetupScript: true,
        }
      : {}),
  },
  createdAt: now,
});
console.log(
  JSON.stringify({
    threadId,
    project: project.title,
    base,
    branch: opts.worktree ? branchName : base,
    result,
  }),
);
