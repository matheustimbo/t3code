import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeURL from "node:url";

// Exercise the real issuer against disposable state. The shared preload blocks
// sockets, provider processes and live-state paths. Reports omit credentials.
const args = process.argv.slice(2);
NodeAssert.equal(args.length, 2, "Use --output REPORT.json");
NodeAssert.equal(args[0], "--output", "Use --output REPORT.json");
const output = NodePath.resolve(args[1]);
const bin = NodeURL.fileURLToPath(new NodeURL.URL("../dist/bin.mjs", import.meta.url));
const fixture = NodeURL.fileURLToPath(
  new NodeURL.URL("./fixtures/threadCli.fetchFixture.mjs", import.meta.url),
);
const temporary = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-auth-session-smoke-"));
const results = [];

const parseJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Issuer output was not JSON; credential output withheld");
  }
};

const run = (scenario, command, baseDir, success = true) => {
  const auditPath = NodePath.join(temporary, `${scenario}-audit.json`);
  const child = NodeChildProcess.spawnSync(
    process.execPath,
    ["--import", fixture, bin, "auth", "session", ...command, "--base-dir", baseDir, "--json"],
    {
      cwd: temporary,
      encoding: "utf8",
      timeout: 15_000,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        TMPDIR: temporary,
        T3CODE_HOME: baseDir,
        XDG_CONFIG_HOME: NodePath.join(temporary, "config"),
        XDG_DATA_HOME: NodePath.join(temporary, "data"),
        XDG_CACHE_HOME: NodePath.join(temporary, "cache"),
        NO_COLOR: "1",
        TERM: "dumb",
        T3_CLI_SMOKE_CASE: scenario,
        T3_CLI_SMOKE_AUDIT: auditPath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  NodeAssert.equal(child.error, undefined, `${scenario}: process failed`);
  NodeAssert.equal(child.signal, null, `${scenario}: process was terminated`);
  NodeAssert.equal(
    child.status,
    success ? 0 : 1,
    `${scenario}: unexpected exit code; output withheld`,
  );
  const audit = parseJson(NodeFS.readFileSync(auditPath, "utf8"));
  NodeAssert.deepEqual(audit.blocked, [], `${scenario}: attempted blocked effect`);
  NodeAssert.deepEqual(audit.requests, [], `${scenario}: attempted HTTP access`);
  NodeAssert.deepEqual(audit.dispatched, [], `${scenario}: dispatched provider work`);
  results.push({ scenario, exitCode: child.status, blockedEffects: audit.blocked.length });
  console.log(`CHECK ${scenario} (exit ${child.status})`);
  return success ? parseJson(child.stdout) : null;
};

const verifyIssued = (issued, baseDir, ttlMs) => {
  NodeAssert.equal(issued.method, "bearer-access-token");
  NodeAssert.deepEqual(issued.scopes, ["orchestration:read"]);
  NodeAssert.equal(issued.client.deviceType, "bot");
  const claims = parseJson(Buffer.from(issued.token.split(".")[0], "base64url").toString("utf8"));
  NodeAssert.deepEqual(claims.scopes, ["orchestration:read"]);
  NodeAssert.equal(claims.exp - claims.iat, ttlMs);
  NodeAssert.equal(Date.parse(issued.expiresAt), claims.exp);
  const db = new NodeSqlite.DatabaseSync(NodePath.join(baseDir, "userdata", "statev2.sqlite"), {
    readOnly: true,
  });
  try {
    const row = db
      .prepare(
        "SELECT scopes, issued_at, expires_at, revoked_at FROM auth_sessions WHERE session_id = ?",
      )
      .get(issued.sessionId);
    NodeAssert.ok(row, "Session was not persisted in disposable state");
    NodeAssert.deepEqual(parseJson(row.scopes), ["orchestration:read"]);
    NodeAssert.equal(Date.parse(row.expires_at) - Date.parse(row.issued_at), ttlMs);
    NodeAssert.equal(row.revoked_at, null);
  } finally {
    db.close();
  }
};

try {
  for (const [scenario, flags] of [
    ["missing_scope", ["--ttl", "10m"]],
    ["unknown_scope", ["--scope", "orchestration:reads", "--ttl", "10m"]],
    ["admin_alias_rejected", ["--scope", "admin", "--ttl", "10m"]],
    ["compound_scope_rejected", ["--scope", "orchestration:read access:write", "--ttl", "10m"]],
    ["invalid_ttl", ["--scope", "orchestration:read", "--ttl", "invalid-duration"]],
  ]) {
    const baseDir = NodePath.join(temporary, scenario);
    run(scenario, ["issue", ...flags], baseDir, false);
    NodeAssert.equal(
      NodeFS.existsSync(baseDir),
      false,
      `${scenario}: invalid arguments created access state`,
    );
  }

  const baseDir = NodePath.join(temporary, "read-only-session");
  const attachments = NodePath.join(baseDir, "userdata", "attachments");
  NodeFS.mkdirSync(attachments, { recursive: true });
  const pending = NodePath.join(attachments, "pending-00000000-0000-4000-8000-000000000000.png");
  NodeFS.writeFileSync(pending, "Synthetic stale upload must survive auth commands");
  NodeFS.utimesSync(pending, new Date(0), new Date(0));
  const issued = run(
    "exact_read_scope_10m",
    [
      "issue",
      "--scope",
      "orchestration:read",
      "--ttl",
      "10m",
      "--label",
      "synthetic-read-test",
      "--subject",
      "synthetic-read-test",
    ],
    baseDir,
  );
  verifyIssued(issued, baseDir, 600_000);
  NodeAssert.equal(NodeFS.existsSync(pending), true, "Auth issuance cleaned unrelated uploads");
  NodeAssert.equal(NodeFS.existsSync(NodePath.join(baseDir, "caches")), false);
  NodeAssert.equal(NodeFS.existsSync(NodePath.join(baseDir, "userdata", "logs")), false);
  const listed = run("read_session_listing", ["list"], baseDir);
  NodeAssert.equal(listed.length, 1);
  NodeAssert.equal(listed[0].sessionId, issued.sessionId);
  NodeAssert.deepEqual(listed[0].scopes, ["orchestration:read"]);
  NodeAssert.equal(
    JSON.stringify(listed).includes(issued.token),
    false,
    "Listing disclosed a credential",
  );
  // revoke emits text even when --json is present; parse only issue/list output.
  const auditPath = NodePath.join(temporary, "revoke-audit.json");
  const revoked = NodeChildProcess.spawnSync(
    process.execPath,
    [
      "--import",
      fixture,
      bin,
      "auth",
      "session",
      "revoke",
      issued.sessionId,
      "--base-dir",
      baseDir,
    ],
    {
      cwd: temporary,
      encoding: "utf8",
      timeout: 15_000,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        TMPDIR: temporary,
        T3CODE_HOME: baseDir,
        T3_CLI_SMOKE_CASE: "revoke",
        T3_CLI_SMOKE_AUDIT: auditPath,
        NO_COLOR: "1",
        TERM: "dumb",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  NodeAssert.equal(revoked.status, 0, "Revocation failed; output withheld");
  const revokeAudit = parseJson(NodeFS.readFileSync(auditPath, "utf8"));
  NodeAssert.deepEqual(revokeAudit.blocked, []);
  NodeAssert.deepEqual(revokeAudit.requests, []);
  NodeAssert.equal(`${revoked.stdout}${revoked.stderr}`.includes(issued.token), false);
  results.push({ scenario: "revoke_exact_session", exitCode: 0, blockedEffects: 0 });
  console.log("CHECK revoke_exact_session (exit 0)");
  NodeAssert.deepEqual(run("revoked_session_absent", ["list"], baseDir), []);
  NodeAssert.equal(NodeFS.existsSync(pending), true, "Auth revocation cleaned unrelated uploads");
  const db = new NodeSqlite.DatabaseSync(NodePath.join(baseDir, "userdata", "statev2.sqlite"), {
    readOnly: true,
  });
  try {
    NodeAssert.ok(
      db.prepare("SELECT revoked_at FROM auth_sessions WHERE session_id = ?").get(issued.sessionId)
        .revoked_at,
    );
  } finally {
    db.close();
  }

  const duplicateBaseDir = NodePath.join(temporary, "duplicate-scope");
  const duplicate = run(
    "duplicate_read_scope_does_not_expand",
    ["issue", "--scope", "orchestration:read", "--scope", "orchestration:read", "--ttl", "10m"],
    duplicateBaseDir,
  );
  verifyIssued(duplicate, duplicateBaseDir, 600_000);
  const report = {
    status: "passed",
    scenarios: results.length,
    results,
    node: process.version,
    bundleSha256: NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(bin)).digest("hex"),
    isolation: "temporary T3 home; no sockets, providers, live state or HTTP; credentials omitted",
  };
  NodeFS.mkdirSync(NodePath.dirname(output), { recursive: true });
  NodeFS.writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
  console.log(`Passed ${results.length} isolated issuer scenarios. Report: ${output}`);
} finally {
  NodeFS.rmSync(temporary, { recursive: true, force: true });
}
