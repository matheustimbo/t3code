// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";

import {
  finalizeThreadPurge,
  purgeThreadHistory,
  restoreThreadPurge,
} from "./purge-thread-history.ts";

function seed(databasePath: string) {
  const database = new NodeSqlite.DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE projection_projects(project_id TEXT PRIMARY KEY, workspace_root TEXT NOT NULL);
    CREATE TABLE projection_threads(thread_id TEXT PRIMARY KEY, project_id TEXT, worktree_path TEXT, updated_at TEXT, archived_at TEXT, deleted_at TEXT, continuation_of_thread_id TEXT, continued_by_thread_id TEXT);
    CREATE TABLE projection_thread_messages(message_id TEXT PRIMARY KEY, thread_id TEXT, attachments_json TEXT);
    CREATE TABLE projection_thread_activities(activity_id TEXT PRIMARY KEY, thread_id TEXT, turn_id TEXT, tone TEXT, kind TEXT, summary TEXT, payload_json TEXT, sequence INTEGER, created_at TEXT);
    CREATE TABLE projection_thread_sessions(thread_id TEXT PRIMARY KEY);
    CREATE TABLE projection_turns(thread_id TEXT, source_proposed_plan_thread_id TEXT, source_proposed_plan_id TEXT);
    CREATE TABLE projection_pending_approvals(request_id TEXT, thread_id TEXT);
    CREATE TABLE projection_thread_proposed_plans(plan_id TEXT, thread_id TEXT, implementation_thread_id TEXT);
    CREATE TABLE provider_session_runtime(thread_id TEXT PRIMARY KEY);
    CREATE TABLE checkpoint_diff_blobs(thread_id TEXT);
    CREATE TABLE thread_drafts(thread_id TEXT, command_json TEXT NOT NULL DEFAULT '{}');
    CREATE TABLE thread_queue_messages(thread_id TEXT, command_json TEXT NOT NULL DEFAULT '{}');
    CREATE TABLE thread_queue_state(thread_id TEXT);
    CREATE TABLE orchestration_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT, aggregate_kind TEXT, stream_id TEXT, event_type TEXT, command_id TEXT, payload_json TEXT);
    CREATE TABLE orchestration_command_receipts(command_id TEXT, aggregate_kind TEXT, aggregate_id TEXT);
    INSERT INTO projection_projects VALUES ('project', '${NodePath.dirname(databasePath).replaceAll("'", "''")}');
    INSERT INTO projection_threads VALUES
      ('old', 'project', NULL, '2020-01-01T00:00:00.000Z', NULL, NULL, NULL, NULL),
      ('archived', 'project', NULL, '2099-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL, NULL, NULL),
      ('deleted', 'project', NULL, '2099-01-01T00:00:00.000Z', NULL, '2026-01-01T00:00:00.000Z', NULL, NULL),
      ('recent', 'project', NULL, '2099-01-01T00:00:00.000Z', NULL, NULL, NULL, NULL);
    INSERT INTO projection_thread_messages VALUES
      ('old-message', 'old', '[{"type":"image","id":"old-00000000-0000-0000-0000-000000000000","name":"old.png","mimeType":"image/png","sizeBytes":4}]'),
      ('recent-message', 'recent', '[{"type":"image","id":"recent-00000000-0000-0000-0000-000000000000","name":"recent.png","mimeType":"image/png","sizeBytes":6}]');
    INSERT INTO projection_thread_activities VALUES
      ('old-activity', 'old', NULL, 'tool', 'command', 'Old', '{}', 1, '2020-01-01T00:00:00.000Z'),
      ('recent-activity', 'recent', NULL, 'tool', 'command', 'Recent', '{"itemType":"tool","data":{"rawOutput":{"content":"This is intentionally long presentation output that should be summarized before it is retained in the activity projection because the event log remains lossless and can retain the original content safely."},"unused":"discard me"}}', 2, '2099-01-01T00:00:00.000Z');
    INSERT INTO projection_thread_proposed_plans VALUES ('recent-plan', 'recent', NULL);
    INSERT INTO projection_turns VALUES ('recent', NULL, NULL);
    INSERT INTO orchestration_events VALUES
      (1, 'old-event', 'thread', 'old', 'thread.activity-appended', 'old-command', '{}'),
      (2, 'recent-event', 'thread', 'recent', 'thread.activity-appended', 'recent-command', '{}');
    INSERT INTO orchestration_command_receipts VALUES ('old-command', 'thread', 'old'), ('recent-command', 'thread', 'recent');
  `);
  database.close();
}

describe("purgeThreadHistory", () => {
  it("can inventory a live-style database through a read-only connection without creating a backup", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-purge-dry-run-test-"));
    const databasePath = NodePath.join(root, "state.sqlite");
    const backupPath = NodePath.join(root, "backup.sqlite");
    seed(databasePath);

    const report = purgeThreadHistory({
      databasePath,
      backupPath,
      inactiveDays: 30,
      apply: false,
    });

    expect(report).toMatchObject({
      applied: false,
      targetThreads: 3,
      retainedThreads: 1,
      rowsDeleted: {},
      filesDeleted: 0,
      externalBackupPath: null,
    });
    expect(NodeFS.existsSync(backupPath)).toBe(false);
    const database = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
    expect(database.prepare("SELECT COUNT(*) AS count FROM projection_threads").get()).toEqual({
      count: 4,
    });
    database.close();
  });

  it("purges a database without the unported thread tables", () => {
    const root = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3-purge-missing-thread-tables-test-"),
    );
    const databasePath = NodePath.join(root, "state.sqlite");
    const backupPath = NodePath.join(root, "backup.sqlite");
    seed(databasePath);
    const database = new NodeSqlite.DatabaseSync(databasePath);
    database.exec(
      "DROP TABLE thread_drafts; DROP TABLE thread_queue_messages; DROP TABLE thread_queue_state;",
    );
    database.close();

    const report = purgeThreadHistory({
      databasePath,
      backupPath,
      inactiveDays: 30,
      apply: true,
      cleanupFiles: false,
    });

    expect(report).toMatchObject({
      targetThreads: 3,
      retainedThreads: 1,
      rowsDeleted: {
        projection_thread_messages: 1,
        projection_thread_activities: 1,
        orchestration_command_receipts: 1,
        orchestration_events: 1,
        projection_threads: 3,
      },
    });
    expect(report.rowsDeleted).not.toHaveProperty("thread_drafts");
    expect(report.rowsDeleted).not.toHaveProperty("thread_queue_messages");
    expect(report.rowsDeleted).not.toHaveProperty("thread_queue_state");

    const purged = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
    expect(purged.prepare("SELECT COUNT(*) AS count FROM projection_threads").get()).toEqual({
      count: 1,
    });
    expect(
      purged.prepare("SELECT COUNT(*) AS count FROM projection_thread_messages").get(),
    ).toEqual({
      count: 1,
    });
    expect(
      purged.prepare("SELECT COUNT(*) AS count FROM projection_thread_activities").get(),
    ).toEqual({
      count: 1,
    });
    purged.close();

    expect(finalizeThreadPurge(databasePath).finalized).toBe(true);
  });

  it("fully removes inactive, archived, and deleted streams while preserving retained references safely", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-purge-test-"));
    const databasePath = NodePath.join(root, "state.sqlite");
    const backupPath = NodePath.join(root, "backup.sqlite");
    seed(databasePath);

    const report = purgeThreadHistory({
      databasePath,
      backupPath,
      inactiveDays: 30,
      apply: true,
      cleanupFiles: false,
    });

    expect(report.targetThreads).toBe(3);
    expect(report.retainedThreads).toBe(1);
    expect(report.databaseBytesAfter).toBeGreaterThan(0);
    const database = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
    expect(database.prepare("SELECT thread_id FROM projection_threads").all()).toEqual([
      { thread_id: "recent" },
    ]);
    expect(database.prepare("SELECT message_id FROM projection_thread_messages").all()).toEqual([
      { message_id: "recent-message" },
    ]);
    expect(database.prepare("SELECT event_id FROM orchestration_events").all()).toEqual([
      { event_id: "recent-event" },
    ]);
    expect(database.prepare("SELECT command_id FROM orchestration_command_receipts").all()).toEqual(
      [{ command_id: "recent-command" }],
    );
    expect(
      database
        .prepare("SELECT continuation_of_thread_id, continued_by_thread_id FROM projection_threads")
        .get(),
    ).toEqual({ continuation_of_thread_id: null, continued_by_thread_id: null });
    expect(
      database
        .prepare("SELECT implementation_thread_id FROM projection_thread_proposed_plans")
        .get(),
    ).toEqual({ implementation_thread_id: null });
    expect(
      database
        .prepare(
          "SELECT source_proposed_plan_thread_id, source_proposed_plan_id FROM projection_turns",
        )
        .get(),
    ).toEqual({ source_proposed_plan_thread_id: null, source_proposed_plan_id: null });
    database.close();
    expect(NodeFS.statSync(backupPath).size).toBeGreaterThan(0);
  });

  it("restores the database from the durable journal and verified backup", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-purge-restore-test-"));
    const databasePath = NodePath.join(root, "state.sqlite");
    const backupPath = NodePath.join(root, "backup.sqlite");
    seed(databasePath);
    purgeThreadHistory({
      databasePath,
      backupPath,
      inactiveDays: 30,
      apply: true,
      cleanupFiles: false,
    });

    const restored = restoreThreadPurge(databasePath);
    expect(NodeFS.existsSync(restored.preRestoreDatabasePath)).toBe(true);
    const database = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
    expect(database.prepare("SELECT COUNT(*) AS count FROM projection_threads").get()).toEqual({
      count: 4,
    });
    database.close();
  });

  it("refuses restoration when the recorded backup hash has changed", () => {
    const root = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3-purge-corrupt-backup-test-"),
    );
    const databasePath = NodePath.join(root, "state.sqlite");
    const backupPath = NodePath.join(root, "backup.sqlite");
    seed(databasePath);
    purgeThreadHistory({
      databasePath,
      backupPath,
      inactiveDays: 30,
      apply: true,
      cleanupFiles: false,
    });
    NodeFS.writeFileSync(backupPath, "changed backup\n");

    expect(() => restoreThreadPurge(databasePath)).toThrow(/backup hash does not match/);
    const database = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
    expect(database.prepare("SELECT COUNT(*) AS count FROM projection_threads").get()).toEqual({
      count: 1,
    });
    database.close();
  });

  it("finalizes a verified purge and reports the backup space it releases", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-purge-finalize-test-"));
    const databasePath = NodePath.join(root, "state.sqlite");
    const backupPath = NodePath.join(root, "backup.sqlite");
    seed(databasePath);
    const report = purgeThreadHistory({
      databasePath,
      backupPath,
      inactiveDays: 30,
      apply: true,
      cleanupFiles: false,
    });
    expect(report.netBytesReclaimed).toBeLessThan(0);
    const finalized = finalizeThreadPurge(databasePath);
    expect(finalized.bytesRemoved).toBeGreaterThan(0);
    expect(finalized.netBytesReclaimed).toBeGreaterThanOrEqual(0);
    expect(NodeFS.existsSync(backupPath)).toBe(false);
    expect(NodeFS.existsSync(report.recoveryJournalPath!)).toBe(false);
  });

  it("refuses retained cross-links that could be resurrected by replay", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-purge-cross-link-test-"));
    const databasePath = NodePath.join(root, "state.sqlite");
    const backupPath = NodePath.join(root, "backup.sqlite");
    seed(databasePath);
    const database = new NodeSqlite.DatabaseSync(databasePath);
    database.exec(
      "UPDATE projection_threads SET continuation_of_thread_id = 'old' WHERE thread_id = 'recent'",
    );
    database.close();

    expect(() =>
      purgeThreadHistory({
        databasePath,
        backupPath,
        inactiveDays: 30,
        apply: true,
        cleanupFiles: false,
      }),
    ).toThrow(/retained references would resurrect/);
    const retained = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
    expect(retained.prepare("SELECT COUNT(*) AS count FROM projection_threads").get()).toEqual({
      count: 4,
    });
    retained.close();
  });

  it("removes thread-owned files and checkpoint refs while retaining unrelated files", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-purge-files-test-"));
    const databasePath = NodePath.join(root, "state.sqlite");
    const backupPath = NodePath.join(root, "backup.sqlite");
    seed(databasePath);
    const attachmentDatabase = new NodeSqlite.DatabaseSync(databasePath);
    attachmentDatabase.exec(`
      UPDATE projection_thread_messages
      SET attachments_json = '[{"type":"image","id":"old-00000000-0000-0000-0000-000000000000","name":"old.png","mimeType":"image/png","sizeBytes":4},{"type":"image","id":"shared-00000000-0000-0000-0000-000000000000","name":"shared.png","mimeType":"image/png","sizeBytes":7}]'
      WHERE message_id = 'old-message';
      UPDATE projection_thread_messages
      SET attachments_json = '[{"type":"image","id":"recent-00000000-0000-0000-0000-000000000000","name":"recent.png","mimeType":"image/png","sizeBytes":6},{"type":"image","id":"shared-00000000-0000-0000-0000-000000000000","name":"shared.png","mimeType":"image/png","sizeBytes":7}]'
      WHERE message_id = 'recent-message'
    `);
    attachmentDatabase.close();
    NodeChildProcess.execFileSync("git", ["init", "-q", root]);
    NodeChildProcess.execFileSync("git", [
      "-C",
      root,
      "config",
      "user.email",
      "purge@example.test",
    ]);
    NodeChildProcess.execFileSync("git", ["-C", root, "config", "user.name", "Purge Test"]);
    NodeFS.writeFileSync(NodePath.join(root, "tracked.txt"), "tracked\n");
    NodeChildProcess.execFileSync("git", ["-C", root, "add", "tracked.txt"]);
    NodeChildProcess.execFileSync("git", ["-C", root, "commit", "-qm", "fixture"]);
    NodeChildProcess.execFileSync("git", [
      "-C",
      root,
      "update-ref",
      "refs/t3/checkpoints/b2xk/one",
      "HEAD",
    ]);
    NodeChildProcess.execFileSync("git", [
      "-C",
      root,
      "update-ref",
      "refs/t3/checkpoints/b2xk/two",
      "HEAD",
    ]);

    const attachments = NodePath.join(root, "attachments");
    const providerLogs = NodePath.join(root, "logs", "provider");
    const terminalLogs = NodePath.join(root, "logs", "terminals");
    NodeFS.mkdirSync(attachments, { recursive: true });
    NodeFS.mkdirSync(providerLogs, { recursive: true });
    NodeFS.mkdirSync(terminalLogs, { recursive: true });
    const removedFiles = [
      NodePath.join(attachments, "old-00000000-0000-0000-0000-000000000000.png"),
      NodePath.join(providerLogs, "events.native.old.log"),
      NodePath.join(terminalLogs, "terminal_b2xk.log"),
      NodePath.join(terminalLogs, "old.log"),
    ];
    for (const file of removedFiles) NodeFS.writeFileSync(file, "old\n");
    const retainedFile = NodePath.join(
      attachments,
      "recent-00000000-0000-0000-0000-000000000000.png",
    );
    NodeFS.writeFileSync(retainedFile, "recent\n");
    const sharedRetainedFile = NodePath.join(
      attachments,
      "shared-00000000-0000-0000-0000-000000000000.png",
    );
    NodeFS.writeFileSync(sharedRetainedFile, "shared\n");

    const report = purgeThreadHistory({
      databasePath,
      backupPath,
      inactiveDays: 30,
      apply: true,
    });

    expect(report.fileCleanupFailures).toEqual([]);
    expect(report.filesDeleted).toBe(6);
    for (const file of removedFiles) expect(NodeFS.existsSync(file)).toBe(false);
    expect(NodeFS.existsSync(retainedFile)).toBe(true);
    expect(NodeFS.existsSync(sharedRetainedFile)).toBe(true);
    expect(
      NodeChildProcess.execFileSync(
        "git",
        ["-C", root, "for-each-ref", "--format=%(refname)", "refs/t3/checkpoints/b2xk/"],
        { encoding: "utf8" },
      ),
    ).toBe("");
    expect(NodeFS.existsSync(`${backupPath}.external`)).toBe(true);
    const manifest = JSON.parse(
      NodeFS.readFileSync(NodePath.join(`${backupPath}.external`, "manifest.json"), "utf8"),
    ) as {
      readonly status: string;
      readonly bundles: ReadonlyArray<{ readonly path: string }>;
      readonly refs: ReadonlyArray<{
        readonly cwd: string;
        readonly ref: string;
        readonly oid: string;
      }>;
      readonly [key: string]: unknown;
    };
    expect(manifest.status).toBe("complete");
    expect(manifest.bundles).toHaveLength(1);
    expect(NodeFS.existsSync(manifest.bundles[0]!.path)).toBe(true);

    // Simulate a crash after the first ref was removed but before the second:
    // the resume must treat the absent ref as complete and compare-delete the
    // still-present one without getting stuck.
    const secondRef = manifest.refs[1]!;
    NodeChildProcess.execFileSync("git", [
      "-C",
      secondRef.cwd,
      "update-ref",
      secondRef.ref,
      secondRef.oid,
    ]);
    NodeFS.writeFileSync(
      NodePath.join(`${backupPath}.external`, "manifest.json"),
      `${JSON.stringify({ ...manifest, status: "database-swapped" }, null, 2)}\n`,
    );
    purgeThreadHistory({
      databasePath,
      backupPath: NodePath.join(root, "backup-after-partial-ref.sqlite"),
      inactiveDays: 30,
      apply: true,
      cleanupFiles: false,
    });
    expect(
      NodeChildProcess.execFileSync(
        "git",
        ["-C", root, "for-each-ref", "--format=%(refname)", "refs/t3/checkpoints/b2xk/"],
        { encoding: "utf8" },
      ),
    ).toBe("");
  });

  it("restores staged files and checkpoint refs together with the database", () => {
    const root = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3-purge-external-restore-test-"),
    );
    const databasePath = NodePath.join(root, "state.sqlite");
    const backupPath = NodePath.join(root, "backup.sqlite");
    seed(databasePath);
    NodeChildProcess.execFileSync("git", ["init", "-q", root]);
    NodeChildProcess.execFileSync("git", [
      "-C",
      root,
      "config",
      "user.email",
      "purge@example.test",
    ]);
    NodeChildProcess.execFileSync("git", ["-C", root, "config", "user.name", "Purge Test"]);
    NodeFS.writeFileSync(NodePath.join(root, "tracked.txt"), "tracked\n");
    NodeChildProcess.execFileSync("git", ["-C", root, "add", "tracked.txt"]);
    NodeChildProcess.execFileSync("git", ["-C", root, "commit", "-qm", "fixture"]);
    const ref = "refs/t3/checkpoints/b2xk/one";
    NodeChildProcess.execFileSync("git", ["-C", root, "update-ref", ref, "HEAD"]);
    const oid = NodeChildProcess.execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
    const attachment = NodePath.join(
      root,
      "attachments",
      "old-00000000-0000-0000-0000-000000000000.png",
    );
    NodeFS.mkdirSync(NodePath.dirname(attachment), { recursive: true });
    NodeFS.writeFileSync(attachment, "old\n");

    const purged = purgeThreadHistory({
      databasePath,
      backupPath,
      inactiveDays: 30,
      apply: true,
    });
    expect(NodeFS.existsSync(attachment)).toBe(false);
    expect(() =>
      NodeChildProcess.execFileSync("git", ["-C", root, "rev-parse", "--verify", ref], {
        stdio: ["ignore", "ignore", "ignore"],
      }),
    ).toThrow();

    restoreThreadPurge(databasePath);
    expect(NodeFS.readFileSync(attachment, "utf8")).toBe("old\n");
    expect(
      NodeChildProcess.execFileSync("git", ["-C", root, "rev-parse", "--verify", ref], {
        encoding: "utf8",
      }).trim(),
    ).toBe(oid);
    expect(JSON.parse(NodeFS.readFileSync(purged.recoveryJournalPath!, "utf8"))).toMatchObject({
      status: "restored",
    });
  });

  it("refuses restore and finalize when a staged external file was changed", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-purge-external-hash-test-"));
    const databasePath = NodePath.join(root, "state.sqlite");
    const backupPath = NodePath.join(root, "backup.sqlite");
    seed(databasePath);
    const attachment = NodePath.join(
      root,
      "attachments",
      "old-00000000-0000-0000-0000-000000000000.png",
    );
    NodeFS.mkdirSync(NodePath.dirname(attachment), { recursive: true });
    NodeFS.writeFileSync(attachment, "old\n");
    purgeThreadHistory({ databasePath, backupPath, inactiveDays: 30, apply: true });
    const manifestPath = NodePath.join(`${backupPath}.external`, "manifest.json");
    const manifest = JSON.parse(NodeFS.readFileSync(manifestPath, "utf8")) as {
      readonly files: ReadonlyArray<{ readonly staged: string }>;
    };
    NodeFS.writeFileSync(manifest.files[0]!.staged, "changed\n");

    expect(() => restoreThreadPurge(databasePath)).toThrow(/missing, truncated, or changed/);
    expect(() => finalizeThreadPurge(databasePath)).toThrow(/missing, truncated, or changed/);
    const database = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
    expect(database.prepare("SELECT COUNT(*) AS count FROM projection_threads").get()).toEqual({
      count: 1,
    });
    database.close();
  });

  it("refuses finalize if a purged external file reappeared at its source", () => {
    const root = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3-purge-external-reappeared-test-"),
    );
    const databasePath = NodePath.join(root, "state.sqlite");
    const backupPath = NodePath.join(root, "backup.sqlite");
    seed(databasePath);
    const attachment = NodePath.join(
      root,
      "attachments",
      "old-00000000-0000-0000-0000-000000000000.png",
    );
    NodeFS.mkdirSync(NodePath.dirname(attachment), { recursive: true });
    NodeFS.writeFileSync(attachment, "old\n");
    purgeThreadHistory({ databasePath, backupPath, inactiveDays: 30, apply: true });
    const manifest = JSON.parse(
      NodeFS.readFileSync(NodePath.join(`${backupPath}.external`, "manifest.json"), "utf8"),
    ) as { readonly files: ReadonlyArray<{ readonly staged: string }> };
    NodeFS.renameSync(manifest.files[0]!.staged, attachment);

    expect(() => finalizeThreadPurge(databasePath)).toThrow(/reappeared or is not staged/);
    expect(NodeFS.existsSync(backupPath)).toBe(true);
  });

  it("uses the project root when a historical worktree no longer exists", () => {
    const root = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3-purge-missing-worktree-test-"),
    );
    const databasePath = NodePath.join(root, "state.sqlite");
    const backupPath = NodePath.join(root, "backup.sqlite");
    seed(databasePath);
    const database = new NodeSqlite.DatabaseSync(databasePath);
    database
      .prepare("UPDATE projection_threads SET worktree_path = ? WHERE thread_id = 'old'")
      .run(NodePath.join(root, "removed-worktree"));
    database.close();
    NodeChildProcess.execFileSync("git", ["init", "-q", root]);
    NodeChildProcess.execFileSync("git", [
      "-C",
      root,
      "config",
      "user.email",
      "purge@example.test",
    ]);
    NodeChildProcess.execFileSync("git", ["-C", root, "config", "user.name", "Purge Test"]);
    NodeFS.writeFileSync(NodePath.join(root, "tracked.txt"), "tracked\n");
    NodeChildProcess.execFileSync("git", ["-C", root, "add", "tracked.txt"]);
    NodeChildProcess.execFileSync("git", ["-C", root, "commit", "-qm", "fixture"]);
    const ref = "refs/t3/checkpoints/b2xk/one";
    NodeChildProcess.execFileSync("git", ["-C", root, "update-ref", ref, "HEAD"]);

    purgeThreadHistory({ databasePath, backupPath, inactiveDays: 30, apply: true });

    expect(() =>
      NodeChildProcess.execFileSync("git", ["-C", root, "rev-parse", "--verify", ref], {
        stdio: ["ignore", "ignore", "ignore"],
      }),
    ).toThrow();
  });

  it("resumes a durable external cleanup journal after the database was swapped", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-purge-resume-test-"));
    const databasePath = NodePath.join(root, "state.sqlite");
    const backupPath = NodePath.join(root, "backup.sqlite");
    seed(databasePath);
    const attachments = NodePath.join(root, "attachments");
    NodeFS.mkdirSync(attachments, { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(attachments, "old-00000000-0000-0000-0000-000000000000.png"),
      "old\n",
    );
    const report = purgeThreadHistory({ databasePath, backupPath, inactiveDays: 30, apply: true });
    const manifestPath = NodePath.join(`${backupPath}.external`, "manifest.json");
    const interrupted = JSON.parse(NodeFS.readFileSync(manifestPath, "utf8")) as Record<
      string,
      unknown
    >;
    NodeFS.writeFileSync(
      manifestPath,
      `${JSON.stringify({ ...interrupted, status: "prepared" }, null, 2)}\n`,
    );
    const recovery = JSON.parse(NodeFS.readFileSync(report.recoveryJournalPath!, "utf8")) as Record<
      string,
      unknown
    >;
    NodeFS.writeFileSync(
      report.recoveryJournalPath!,
      `${JSON.stringify({ ...recovery, status: "prepared" }, null, 2)}\n`,
    );

    purgeThreadHistory({
      databasePath,
      backupPath: NodePath.join(root, "different-backup-directory", "unused.sqlite"),
      inactiveDays: 30,
      apply: true,
      cleanupFiles: false,
    });
    expect(JSON.parse(NodeFS.readFileSync(manifestPath, "utf8"))).toMatchObject({
      status: "complete",
    });
    expect(JSON.parse(NodeFS.readFileSync(report.recoveryJournalPath!, "utf8"))).toMatchObject({
      status: "complete",
    });
  });

  it("treats a non-Git project root as having no checkpoint refs", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-purge-non-git-test-"));
    const databasePath = NodePath.join(root, "state.sqlite");
    const backupPath = NodePath.join(root, "backup.sqlite");
    seed(databasePath);

    const report = purgeThreadHistory({ databasePath, backupPath, inactiveDays: 30, apply: true });

    expect(report.targetThreads).toBe(3);
    expect(report.fileCleanupFailures).toEqual([]);
  });

  it("refuses maintenance while any server-instance lock exists", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-purge-server-lock-test-"));
    const databasePath = NodePath.join(root, "state.sqlite");
    const backupPath = NodePath.join(root, "backup.sqlite");
    seed(databasePath);
    NodeFS.writeFileSync(
      NodePath.join(root, "server-instance.lock"),
      '{"version":1,"ownerId":"stale","pid":999999,"startedAt":"2020-01-01T00:00:00Z"}\n',
    );

    expect(() =>
      purgeThreadHistory({ databasePath, backupPath, inactiveDays: 30, apply: true }),
    ).toThrow(/server lock exists/);
    expect(NodeFS.existsSync(backupPath)).toBe(false);
  });
});
