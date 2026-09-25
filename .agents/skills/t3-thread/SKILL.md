---
name: t3-thread
description: Create new T3 Code threads from the agent, each with its own worktree and a first message that starts an agent on it. Use when the user asks to open, spawn, create, or dispatch a t3code thread (or one thread per ticket/task), or to hand work off to a parallel t3code session.
---

# Create T3 Code threads

`t3-thread` (script at `scripts/t3-thread.mjs`, symlinked as `t3-thread` into a directory on `PATH`; if it is missing, run `node <this skill dir>/scripts/t3-thread.mjs`) creates a thread in the running T3 Code app exactly as the UI does: one `thread.turn.start` with `bootstrap` sent over the local WebSocket RPC. The server creates the thread, prepares a worktree at `~/.t3/worktrees/<repo>/t3code-<hex>` on a `t3code/<hex>` branch, runs the project setup script, and starts the agent with the message. The thread appears in the sidebar at once.

## Usage

```bash
t3-thread "message"                                 # project = repo of the cwd (worktrees resolve to the main repo), base = origin's default branch
t3-thread -p <title|projectId|path> -b <base> -t "Title" "message"
cat prompt.md | t3-thread -p my-project             # message from stdin
t3-thread --plan "message"                          # plan interaction mode
t3-thread -m claude-sonnet-5 "message"              # model (default: the project's default model, else claude-opus-5-5 on claudeAgent; --instance for codex etc.)
t3-thread --selection '<modelSelection json>' "msg" # exact model + options (overrides -m/--instance)
t3-thread --no-worktree "message"                   # run in the project checkout (on its current branch) instead of a new worktree
t3-thread --local-base "message"                    # branch the worktree from the local base instead of origin/<base>
t3-thread --dry-run "message"                       # print the command without sending
t3-thread --stop <threadId>                         # stop the thread's agent session
t3-thread --archive <threadId>                      # archive the thread (hide from the sidebar; worktree kept)
```

To redo a thread with a different model, `--stop` and `--archive` the old one, then create it again. A thread cannot switch between providers (Claude and Codex).

On success it prints one JSON line: `{"threadId", "project", "base", "branch", "result": {"sequence"}}`. T3 Code later renames the `t3code/<hex>` branch and generates the title from the message, as it does for UI threads.

## Workflow

1. Write a self-contained first message. The new thread has none of this conversation: include the goal, the issue/ticket number or URL, the relevant paths, constraints, and what "done" means. For long prompts, write the text to a temp file and pipe it in.
2. For more than one thread, or when the user did not spell out what each thread should do, show the list (title + message summary per thread) and wait for OK before creating. Each thread starts a full agent session.
3. Run `t3-thread` once per thread. Pass `-p` when the target is not the cwd's repo.
4. Verify and report: give the user the title and `threadId` of each thread. To confirm the worktree and first reply:

   ```bash
   sqlite3 -readonly "file:$HOME/.t3/userdata/state.sqlite?mode=ro" \
     "select title, branch, worktree_path from projection_threads where thread_id='<id>';"
   sqlite3 -readonly "file:$HOME/.t3/userdata/state.sqlite?mode=ro" \
     "select role, substr(text,1,200) from projection_thread_messages where thread_id='<id>' order by created_at;"
   ```

## Model selections

Example `--selection` values:

```json
{"instanceId":"claudeAgent","model":"claude-opus-5-5","options":[{"id":"effort","value":"medium"},{"id":"fastMode","value":false},{"id":"contextWindow","value":"1m"}]}
{"instanceId":"codex","model":"gpt-6-sol","options":[{"id":"reasoningEffort","value":"xhigh"},{"id":"serviceTier","value":"default"}]}
{"instanceId":"codex","model":"gpt-6-luna","options":[{"id":"reasoningEffort","value":"max"},{"id":"serviceTier","value":"default"}]}
```

- Claude effort levels per model are in `~/.t3/userdata/model-manifest.json` (`providers.claudeAgent.profiles`).
- Codex models and their supported `reasoningEffort` values are in `~/.codex/models_cache.json`.
- To copy what the UI sent, run `select distinct json_extract(payload_json,'$.modelSelection') from orchestration_events where event_type='thread.turn-start-requested'`.
- Slash commands in the message resolve against the thread's provider. Skills installed only for Claude are plain text in Codex threads, and the reverse. Repo skills in `.agents/skills` work in both.

## Notes

- Projects must already exist in T3 Code. The error lists the known ones; add a new one with `t3 project add <path>`.
- Auth: a bearer token in `~/.config/t3-thread/token` (600). The script issues it with the running server's own CLI (`t3 auth session issue --ttl 30d --label t3-thread-cli`; for the macOS desktop app, the bundled `bin.mjs` under `ELECTRON_RUN_AS_NODE=1`) when missing, and re-issues it after a 401/403. The token carries administrative scopes: list or revoke old ones with `t3 auth session list` / `t3 auth session revoke <id>`.
- Requires Node >= 22 (global `WebSocket`) and `sqlite3`. Honors `T3CODE_HOME`.
- The script prints the `threadId` to stderr before dispatching. If it times out, the thread may still be created: check before retrying.
- `POST /api/orchestration/dispatch` ignores `bootstrap` and fails with "Thread ... does not exist". Only the `/ws` RPC (`orchestration.dispatchCommand`) creates the thread, so do not "simplify" to HTTP.
- Defaults: `runtimeMode: full-access`, and the worktree starts from `origin/<base>` like the UI. Attachments are not supported.
- This relies on T3 Code's internal protocol, so an app update can break it. The schemas live in the t3code source (github.com/pingdotgg/t3code): `packages/contracts/src/orchestration.ts` (`ThreadTurnStartCommand`, `ThreadTurnStartBootstrap`), and the server handling is in `apps/server/src/ws.ts`. On a dispatch failure, look up the returned `traceId` in `~/.t3/userdata/logs/boot-service.log`.
