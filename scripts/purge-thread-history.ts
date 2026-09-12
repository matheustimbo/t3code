// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeURL from "node:url";

export interface ThreadPurgeOptions {
  readonly databasePath: string;
  readonly backupPath: string;
  readonly inactiveDays?: number;
  readonly apply: boolean;
  readonly vacuum?: boolean;
  readonly cleanupFiles?: boolean;
}

interface PurgeThreadRow {
  readonly threadId: string;
  readonly projectRoot: string;
  readonly worktreePath: string | null;
  readonly attachments: string | null;
}

export interface ThreadPurgeReport {
  readonly cutoff: string;
  readonly applied: boolean;
  readonly targetThreads: number;
  readonly deletedThreads: number;
  readonly archivedThreads: number;
  readonly inactiveThreads: number;
  readonly retainedThreads: number;
  readonly databaseBytesBefore: number;
  readonly databaseBytesAfter: number;
  readonly databaseBytesReclaimed: number;
  readonly rowsDeleted: Readonly<Record<string, number>>;
  readonly filesDeleted: number;
  readonly fileCleanupFailures: ReadonlyArray<string>;
  readonly externalBackupPath: string | null;
  readonly backupBytes: number;
  readonly externalBackupBytes: number;
  readonly externalStagedBytes: number;
  readonly netBytesReclaimed: number;
  readonly recoveryJournalPath: string | null;
}

interface ThreadPurgeRecoveryJournal {
  readonly version: 1;
  readonly status: "prepared" | "complete" | "restoring" | "restored";
  readonly databasePath: string;
  readonly backupPath: string;
  readonly backupSha256: string;
  readonly backupBytes: number;
  readonly databaseBytesBefore: number;
  readonly targetThreadIds: ReadonlyArray<string>;
  readonly externalManifestPath: string | null;
  readonly preRestoreDatabasePath?: string;
}

export const THREAD_TABLES = [
  "projection_pending_approvals",
  "projection_thread_sessions",
  "projection_thread_messages",
  "projection_thread_activities",
  "projection_thread_proposed_plans",
  "projection_thread_pull_requests",
  "projection_turns",
  "provider_session_runtime",
  "checkpoint_diff_blobs",
  "thread_drafts",
  "thread_queue_messages",
  "thread_queue_state",
] as const;

function assertSafeDatabasePath(databasePath: string): void {
  if (!NodePath.isAbsolute(databasePath) || NodePath.basename(databasePath) !== "state.sqlite") {
    throw new Error(`Refusing unexpected database path: ${databasePath}`);
  }
}

function assertBackupPath(databasePath: string, backupPath: string): void {
  if (
    !NodePath.isAbsolute(backupPath) ||
    NodePath.resolve(backupPath) === NodePath.resolve(databasePath)
  ) {
    throw new Error("A distinct absolute backup path is required.");
  }
}

function pathEntryExists(filePath: string): boolean {
  try {
    NodeFS.lstatSync(filePath);
    return true;
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ENOENT");
  }
}

function recoveryJournalPath(databasePath: string): string {
  return NodePath.join(NodePath.dirname(databasePath), ".state.sqlite.thread-purge.json");
}

function fileSha256(filePath: string): string {
  const hash = NodeCrypto.createHash("sha256");
  const descriptor = NodeFS.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    while (true) {
      const bytesRead = NodeFS.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    NodeFS.closeSync(descriptor);
  }
  return hash.digest("hex");
}

function directoryBytes(directory: string): number {
  if (!NodeFS.existsSync(directory)) return 0;
  let total = 0;
  for (const entry of NodeFS.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = NodePath.join(directory, entry.name);
    if (entry.isDirectory()) total += directoryBytes(entryPath);
    else if (entry.isFile()) total += NodeFS.statSync(entryPath).size;
  }
  return total;
}

function externalStagedBytes(manifestPath: string): number {
  if (!NodeFS.existsSync(manifestPath)) return 0;
  return readExternalManifest(manifestPath).files.reduce(
    (total, file) =>
      total + (NodeFS.existsSync(file.staged) ? NodeFS.statSync(file.staged).size : 0),
    0,
  );
}

function ensurePrivateDirectory(directory: string): void {
  if (NodeFS.existsSync(directory)) {
    if (!NodeFS.statSync(directory).isDirectory()) {
      throw new Error(`Backup parent is not a directory: ${directory}`);
    }
    return;
  }
  NodeFS.mkdirSync(directory, { recursive: true, mode: 0o700 });
  NodeFS.chmodSync(directory, 0o700);
}

function assertNoIncompleteExternalBackups(backupDirectory: string): void {
  for (const name of NodeFS.readdirSync(backupDirectory)) {
    if (!name.endsWith(".sqlite.external")) continue;
    const manifestPath = NodePath.join(backupDirectory, name, "manifest.json");
    if (!NodeFS.existsSync(manifestPath)) {
      throw new Error(`Incomplete external purge backup has no manifest: ${manifestPath}`);
    }
    const manifest = JSON.parse(NodeFS.readFileSync(manifestPath, "utf8")) as {
      readonly status?: unknown;
    };
    if (manifest.status !== "complete") {
      throw new Error(
        `Interrupted external cleanup detected at ${manifestPath}. Restore each manifest file from staged to source and each Git ref to its recorded OID before retrying.`,
      );
    }
  }
}

function syncPath(filePath: string): void {
  const descriptor = NodeFS.openSync(filePath, "r");
  try {
    NodeFS.fsyncSync(descriptor);
  } finally {
    NodeFS.closeSync(descriptor);
  }
}

function writeDurableJson(filePath: string, value: unknown): void {
  const temporaryPath = `${filePath}.tmp`;
  NodeFS.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  syncPath(temporaryPath);
  NodeFS.renameSync(temporaryPath, filePath);
  syncPath(NodePath.dirname(filePath));
}

function recoverAtomicManifest(manifestPath: string): void {
  if (NodeFS.existsSync(manifestPath)) return;
  const temporaryPath = `${manifestPath}.tmp`;
  if (!NodeFS.existsSync(temporaryPath)) return;
  JSON.parse(NodeFS.readFileSync(temporaryPath, "utf8"));
  NodeFS.renameSync(temporaryPath, manifestPath);
  syncPath(NodePath.dirname(manifestPath));
}

function assertNoOrphanCandidates(databasePath: string): void {
  const directory = NodePath.dirname(databasePath);
  const candidates = NodeFS.readdirSync(directory).filter((name) =>
    name.startsWith(".state.sqlite.purge-candidate-"),
  );
  if (candidates.length > 0) {
    throw new Error(
      `Orphan purge candidates require inspection before retrying: ${candidates.join(", ")}`,
    );
  }
}

function validateDatabase(databasePath: string): void {
  if (!NodeFS.existsSync(databasePath) || NodeFS.statSync(databasePath).size === 0) {
    throw new Error(`SQLite database is missing or empty: ${databasePath}`);
  }
  const backup = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
  try {
    const result = backup.prepare("PRAGMA quick_check").all() as Array<{
      readonly quick_check: string;
    }>;
    if (result.length !== 1 || result[0]?.quick_check !== "ok") {
      throw new Error(`SQLite quick_check failed for ${databasePath}.`);
    }
  } finally {
    backup.close();
  }
}

function acquireMaintenanceLock(databasePath: string): () => void {
  const lockPath = NodePath.join(NodePath.dirname(databasePath), "server-instance.lock");
  if (NodeFS.existsSync(lockPath)) {
    throw new Error(
      `T3 Code server lock exists at ${lockPath}. Stop the server cleanly; inspect and remove a proven-stale lock explicitly before maintenance.`,
    );
  }
  let descriptor: number;
  const ownerId = `thread-purge-${NodeCrypto.randomUUID()}`;
  try {
    descriptor = NodeFS.openSync(lockPath, "wx", 0o600);
  } catch (error) {
    throw new Error(`Could not acquire maintenance lock ${lockPath}: ${String(error)}`, {
      cause: error,
    });
  }
  NodeFS.writeSync(
    descriptor,
    // @effect-diagnostics-next-line globalDate:off - one-shot maintenance lock boundary.
    `${JSON.stringify({ version: 1, ownerId, pid: process.pid, startedAt: new Date().toISOString() })}\n`,
  );
  return () => {
    NodeFS.closeSync(descriptor);
    try {
      const record = JSON.parse(NodeFS.readFileSync(lockPath, "utf8")) as {
        readonly ownerId?: unknown;
      };
      if (record.ownerId === ownerId) NodeFS.unlinkSync(lockPath);
    } catch {
      // A replaced or already-removed lock is not ours to modify.
    }
  };
}

function databaseFingerprint(database: NodeSqlite.DatabaseSync) {
  const events = database
    .prepare(
      "SELECT COUNT(*) AS count, COALESCE(MAX(sequence), 0) AS maxSequence FROM orchestration_events",
    )
    .get() as { readonly count: number; readonly maxSequence: number };
  const threads = database.prepare("SELECT COUNT(*) AS count FROM projection_threads").get() as {
    readonly count: number;
  };
  const pragmas = database.prepare("PRAGMA user_version").get() as {
    readonly user_version: number;
  };
  const schemaHash = NodeCrypto.createHash("sha256")
    .update(
      JSON.stringify(
        database
          .prepare(
            "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
          )
          .all(),
      ),
    )
    .digest("hex");
  const tableCounts = Object.fromEntries(
    (
      database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all() as Array<{ readonly name: string }>
    ).map((row) => {
      if (!/^[a-zA-Z0-9_]+$/u.test(row.name)) {
        throw new Error(`Unexpected SQLite table name: ${row.name}`);
      }
      const count = database.prepare(`SELECT COUNT(*) AS count FROM ${row.name}`).get() as {
        readonly count: number;
      };
      return [row.name, Number(count.count)] as const;
    }),
  );
  return {
    eventCount: Number(events.count),
    maxSequence: Number(events.maxSequence),
    threadCount: Number(threads.count),
    userVersion: Number(pragmas.user_version),
    schemaHash,
    tableCounts,
  };
}

function ensureCurrentBackup(
  database: NodeSqlite.DatabaseSync,
  databasePath: string,
  backupPath: string,
  additionalRequiredBytes: number,
  expectedDataVersion?: number,
): { readonly sha256: string; readonly bytes: number; readonly sourceFingerprint: string } {
  assertBackupPath(databasePath, backupPath);
  const backupDirectory = NodePath.dirname(backupPath);
  ensurePrivateDirectory(backupDirectory);
  assertNoIncompleteExternalBackups(backupDirectory);
  if (pathEntryExists(backupPath)) {
    throw new Error(
      `Backup already exists; use a new path so freshness is unambiguous: ${backupPath}`,
    );
  }
  const databaseBytes = NodeFS.statSync(databasePath).size;
  const databaseDirectory = NodePath.dirname(databasePath);
  const backupFileSystem = NodeFS.statfsSync(backupDirectory);
  const databaseFileSystem = NodeFS.statfsSync(databaseDirectory);
  const backupAvailable = Number(backupFileSystem.bavail) * Number(backupFileSystem.bsize);
  const databaseAvailable = Number(databaseFileSystem.bavail) * Number(databaseFileSystem.bsize);
  const reserveBytes = 1024 * 1024 * 1024;
  const sameFileSystem =
    NodeFS.statSync(backupDirectory).dev === NodeFS.statSync(databaseDirectory).dev;
  // Free space must cover the fresh backup, the same-filesystem replacement
  // candidate, and SQLite's temporary copy while VACUUM rewrites that
  // candidate. The live source already occupies its own existing allocation.
  const backupRequired =
    databaseBytes * (sameFileSystem ? 3 : 1) + reserveBytes + additionalRequiredBytes;
  const databaseRequired = databaseBytes * 2 + reserveBytes;
  if (
    backupAvailable < backupRequired ||
    (!sameFileSystem && databaseAvailable < databaseRequired)
  ) {
    throw new Error(
      `Insufficient free space for backup and candidate VACUUM: backup filesystem needs ${backupRequired} bytes and has ${backupAvailable}; database filesystem needs ${databaseRequired} bytes and has ${databaseAvailable}.`,
    );
  }
  const dataVersionBefore = Number(
    (database.prepare("PRAGMA data_version").get() as { readonly data_version: number })
      .data_version,
  );
  if (expectedDataVersion !== undefined && dataVersionBefore !== expectedDataVersion) {
    throw new Error("Source database changed after external cleanup was planned.");
  }
  database.prepare("VACUUM INTO ?").run(backupPath);
  NodeFS.chmodSync(backupPath, 0o600);
  syncPath(backupPath);
  syncPath(backupDirectory);
  validateDatabase(backupPath);
  const backup = new NodeSqlite.DatabaseSync(backupPath, { readOnly: true });
  let sourceFingerprint = "";
  try {
    sourceFingerprint = JSON.stringify(databaseFingerprint(database));
    const backupFingerprint = databaseFingerprint(backup);
    if (sourceFingerprint !== JSON.stringify(backupFingerprint)) {
      throw new Error(
        `Backup ${backupPath} does not match the stopped source database; use a new backup NodePath.`,
      );
    }
    const dataVersionAfter = Number(
      (database.prepare("PRAGMA data_version").get() as { readonly data_version: number })
        .data_version,
    );
    if (dataVersionAfter !== dataVersionBefore) {
      throw new Error("Source database changed while its purge backup was being created.");
    }
    database.exec("BEGIN IMMEDIATE");
    const dataVersionAfterLock = Number(
      (database.prepare("PRAGMA data_version").get() as { readonly data_version: number })
        .data_version,
    );
    if (dataVersionAfterLock !== dataVersionBefore) {
      throw new Error("Source database changed before the purge write lock was acquired.");
    }
    if (sourceFingerprint !== JSON.stringify(databaseFingerprint(database))) {
      throw new Error("Source database changed before the purge write lock was acquired.");
    }
  } finally {
    backup.close();
  }
  return {
    sha256: fileSha256(backupPath),
    bytes: NodeFS.statSync(backupPath).size,
    sourceFingerprint,
  };
}

function assertThreadTableCoverage(database: NodeSqlite.DatabaseSync): void {
  const expected = new Set<string>([...THREAD_TABLES, "projection_threads"]);
  const rows = database
    .prepare(
      `SELECT DISTINCT tables.name AS name
       FROM sqlite_master AS tables
       JOIN pragma_table_info(tables.name) AS columns ON columns.name = 'thread_id'
       WHERE tables.type = 'table'`,
    )
    .all() as Array<{ readonly name: string }>;
  const unknown = rows
    .map((row) => row.name)
    .filter((name) => !expected.has(name))
    .toSorted();
  if (unknown.length > 0) {
    throw new Error(`Refusing purge: unhandled thread_id tables: ${unknown.join(", ")}`);
  }
}

function base64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function safeThreadSegment(threadId: string): string | null {
  const segment = threadId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, 80)
    .replace(/[-_]+$/g, "");
  return segment || null;
}

function legacyTerminalSegment(threadId: string): string {
  return threadId.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function matchingFiles(directory: string, matches: (name: string) => boolean): string[] {
  if (!NodeFS.existsSync(directory)) return [];
  return NodeFS.readdirSync(directory)
    .filter(matches)
    .map((name) => NodePath.join(directory, name));
}

function tableHasColumn(database: NodeSqlite.DatabaseSync, table: string, column: string): boolean {
  return (
    database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ readonly name: string }>
  ).some((row) => row.name === column);
}

function resolveThreadTables(database: NodeSqlite.DatabaseSync) {
  return THREAD_TABLES.filter((table) => tableHasColumn(database, table, "thread_id"));
}

function collectAttachmentIds(value: unknown, target: Set<string>): void {
  if (Array.isArray(value)) {
    for (const entry of value) collectAttachmentIds(entry, target);
    return;
  }
  if (value === null || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  if (
    record.type === "image" &&
    typeof record.id === "string" &&
    /^[a-z0-9_-]+$/iu.test(record.id)
  ) {
    target.add(record.id);
  }
  for (const nested of Object.values(record)) collectAttachmentIds(nested, target);
}

function attachmentIdsForScope(database: NodeSqlite.DatabaseSync, targets: boolean): Set<string> {
  const ids = new Set<string>();
  const scope = targets ? "IN" : "NOT IN";
  if (tableHasColumn(database, "projection_thread_messages", "attachments_json")) {
    const rows = database
      .prepare(
        `SELECT attachments_json AS json FROM projection_thread_messages
         WHERE thread_id ${scope} (SELECT thread_id FROM purge_thread_ids)
           AND attachments_json IS NOT NULL`,
      )
      .all() as Array<{ readonly json: string }>;
    for (const row of rows) collectAttachmentIds(JSON.parse(row.json), ids);
  }
  for (const table of ["thread_drafts", "thread_queue_messages"] as const) {
    if (!tableHasColumn(database, table, "command_json")) continue;
    const rows = database
      .prepare(
        `SELECT command_json AS json FROM ${table}
         WHERE thread_id ${scope} (SELECT thread_id FROM purge_thread_ids)`,
      )
      .all() as Array<{ readonly json: string }>;
    for (const row of rows) collectAttachmentIds(JSON.parse(row.json), ids);
  }
  if (tableHasColumn(database, "orchestration_events", "payload_json")) {
    const rows = database
      .prepare(
        `SELECT DISTINCT json_extract(attachment.value, '$.id') AS id
         FROM orchestration_events AS events,
              json_each(events.payload_json, '$.attachments') AS attachment
         WHERE events.aggregate_kind = 'thread'
           AND events.event_type = 'thread.message-sent'
           AND events.stream_id ${scope} (SELECT thread_id FROM purge_thread_ids)
           AND json_extract(attachment.value, '$.type') = 'image'
           AND json_type(attachment.value, '$.id') = 'text'`,
      )
      .all() as Array<{ readonly id: string }>;
    for (const row of rows) {
      if (/^[a-z0-9_-]+$/iu.test(row.id)) ids.add(row.id);
    }
  }
  return ids;
}

interface CheckpointRefPlan {
  readonly cwd: string;
  readonly commonDir: string;
  readonly ref: string;
  readonly oid: string;
}

function estimatedCheckpointBundleBytes(refs: ReadonlyArray<CheckpointRefPlan>): number {
  const grouped = new Map<string, CheckpointRefPlan[]>();
  for (const ref of refs) {
    grouped.set(ref.commonDir, [...(grouped.get(ref.commonDir) ?? []), ref]);
  }
  let total = 0;
  for (const group of grouped.values()) {
    const output = NodeChildProcess.execFileSync(
      "git",
      [
        "--git-dir",
        group[0]!.commonDir,
        "rev-list",
        "--disk-usage",
        ...group.map((ref) => ref.ref),
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
    const bytes = Number(output);
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      throw new Error(`Could not estimate checkpoint bundle size from: ${output}`);
    }
    total += bytes;
  }
  // `rev-list --disk-usage` measures existing packed objects. Reserve twice
  // that amount for a conservative standalone bundle plus its temporary file.
  return total * 2;
}

function checkpointRefs(row: PurgeThreadRow): CheckpointRefPlan[] {
  const cwd =
    row.worktreePath && NodeFS.existsSync(row.worktreePath) ? row.worktreePath : row.projectRoot;
  if (cwd.length === 0 || !NodeFS.existsSync(cwd)) return [];
  try {
    NodeChildProcess.execFileSync("git", ["-C", cwd, "rev-parse", "--git-dir"], {
      stdio: ["ignore", "ignore", "ignore"],
    });
  } catch {
    // Some projects intentionally use a non-Git workspace. They cannot own
    // checkpoint refs, so there is nothing to clean here.
    return [];
  }
  const prefix = `refs/t3/checkpoints/${base64Url(row.threadId)}/`;
  const commonDirRaw = NodeChildProcess.execFileSync(
    "git",
    ["-C", cwd, "rev-parse", "--git-common-dir"],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  ).trim();
  const commonDir = NodePath.resolve(cwd, commonDirRaw);
  const output = NodeChildProcess.execFileSync(
    "git",
    ["-C", cwd, "for-each-ref", "--format=%(refname)%09%(objectname)", prefix],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  return output
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => {
      const [ref, oid] = value.split("\t");
      if (!ref || !oid) throw new Error(`Unexpected git ref record in ${cwd}: ${value}`);
      return { cwd, commonDir, ref, oid };
    });
}

interface ExternalCleanupManifest {
  readonly version: 2;
  readonly status: "prepared" | "database-swapped" | "complete" | "restored";
  readonly targetThreadIds: ReadonlyArray<string>;
  readonly candidatePath: string;
  readonly files: ReadonlyArray<{
    readonly source: string;
    readonly staged: string;
    readonly sizeBytes: number;
    readonly sha256: string;
  }>;
  readonly refs: ReadonlyArray<CheckpointRefPlan>;
  readonly bundles: ReadonlyArray<{ readonly commonDir: string; readonly path: string }>;
}

interface ThreadFilePlan {
  readonly plannedFiles: ReadonlyArray<string>;
  readonly plannedRefs: ReadonlyArray<CheckpointRefPlan>;
  readonly estimatedBundleBytes: number;
  readonly failures: string[];
}

function planThreadFiles(
  database: NodeSqlite.DatabaseSync,
  databasePath: string,
  rows: readonly PurgeThreadRow[],
): ThreadFilePlan {
  const userdataDir = NodePath.dirname(databasePath);
  const failures: string[] = [];
  const plannedFiles = new Set<string>();
  const plannedRefs: CheckpointRefPlan[] = [];
  const retainedAttachmentIds = attachmentIdsForScope(database, false);
  const targetAttachmentIds = attachmentIdsForScope(database, true);
  const attachmentsDirectory = NodePath.join(userdataDir, "attachments");
  for (const attachmentId of targetAttachmentIds) {
    if (retainedAttachmentIds.has(attachmentId)) continue;
    for (const file of matchingFiles(attachmentsDirectory, (name) =>
      name.startsWith(`${attachmentId}.`),
    )) {
      plannedFiles.add(file);
    }
  }
  for (const row of rows) {
    const segment = safeThreadSegment(row.threadId);
    if (segment) {
      for (const file of matchingFiles(
        NodePath.join(userdataDir, "logs", "provider"),
        (name) =>
          name === `${segment}.log` ||
          name.startsWith(`${segment}.log.`) ||
          name.includes(`.${segment}.log`),
      ))
        plannedFiles.add(file);
    }
    const terminalPrefix = `terminal_${base64Url(row.threadId)}`;
    const legacyTerminal = legacyTerminalSegment(row.threadId);
    for (const file of matchingFiles(
      NodePath.join(userdataDir, "logs", "terminals"),
      (name) =>
        name === `${terminalPrefix}.log` ||
        name.startsWith(`${terminalPrefix}_`) ||
        name === `${legacyTerminal}.log`,
    ))
      plannedFiles.add(file);
    try {
      plannedRefs.push(...checkpointRefs(row));
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  return {
    plannedFiles: [...plannedFiles],
    plannedRefs: [
      ...new Map(plannedRefs.map((ref) => [`${ref.commonDir}\0${ref.ref}`, ref] as const)).values(),
    ],
    estimatedBundleBytes: estimatedCheckpointBundleBytes(plannedRefs),
    failures,
  };
}

function prepareThreadFileCleanup(
  databasePath: string,
  backupPath: string,
  candidatePath: string,
  rows: readonly PurgeThreadRow[],
  plan: ThreadFilePlan,
): { readonly manifestPath: string; readonly failures: ReadonlyArray<string> } {
  const { plannedFiles, plannedRefs, failures } = plan;
  if (failures.length > 0) return { manifestPath: "", failures };
  const externalBackupPath = `${backupPath}.external`;
  if (
    NodeFS.statSync(NodePath.dirname(databasePath)).dev !==
    NodeFS.statSync(NodePath.dirname(backupPath)).dev
  ) {
    return {
      manifestPath: "",
      failures: [
        "External thread files require the backup on the same filesystem for atomic staging.",
      ],
    };
  }
  if (pathEntryExists(externalBackupPath)) {
    return {
      manifestPath: "",
      failures: [`External backup already exists: ${externalBackupPath}`],
    };
  }

  NodeFS.mkdirSync(externalBackupPath, { recursive: true, mode: 0o700 });
  const staged = plannedFiles.map((source, index) => ({
    source,
    staged: NodePath.join(
      externalBackupPath,
      `${String(index).padStart(6, "0")}-${NodePath.basename(source)}`,
    ),
    sizeBytes: NodeFS.statSync(source).size,
    sha256: fileSha256(source),
  }));
  const manifestPath = NodePath.join(externalBackupPath, "manifest.json");
  const refsByCwd = new Map<string, CheckpointRefPlan[]>();
  for (const ref of plannedRefs) {
    refsByCwd.set(ref.commonDir, [...(refsByCwd.get(ref.commonDir) ?? []), ref]);
  }
  const bundles: Array<{ commonDir: string; path: string }> = [];
  try {
    let bundleIndex = 0;
    for (const refs of refsByCwd.values()) {
      const commonDir = refs[0]!.commonDir;
      const bundlePath = NodePath.join(
        externalBackupPath,
        `checkpoint-refs-${String(bundleIndex).padStart(4, "0")}.bundle`,
      );
      NodeChildProcess.execFileSync(
        "git",
        ["--git-dir", commonDir, "bundle", "create", bundlePath, ...refs.map((ref) => ref.ref)],
        {
          stdio: ["ignore", "ignore", "pipe"],
        },
      );
      NodeFS.chmodSync(bundlePath, 0o600);
      syncPath(bundlePath);
      bundles.push({ commonDir, path: bundlePath });
      bundleIndex += 1;
    }
    writeDurableJson(manifestPath, {
      version: 2,
      status: "prepared",
      targetThreadIds: rows.map((row) => row.threadId),
      candidatePath,
      files: staged,
      refs: plannedRefs,
      bundles,
    } satisfies ExternalCleanupManifest);
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
    NodeFS.rmSync(externalBackupPath, { recursive: true, force: true });
    return { manifestPath: "", failures };
  }
  return { manifestPath, failures };
}

function readExternalManifest(manifestPath: string): ExternalCleanupManifest {
  const manifest = JSON.parse(NodeFS.readFileSync(manifestPath, "utf8")) as ExternalCleanupManifest;
  if (
    manifest.version !== 2 ||
    !["prepared", "database-swapped", "complete", "restored"].includes(manifest.status) ||
    !Array.isArray(manifest.targetThreadIds) ||
    !Array.isArray(manifest.files) ||
    !Array.isArray(manifest.refs) ||
    !Array.isArray(manifest.bundles)
  ) {
    throw new Error(`Unsupported external cleanup journal: ${manifestPath}`);
  }
  return manifest;
}

function assertExternalRestoreReady(
  manifestPath: string,
  expectedThreadIds: ReadonlyArray<string>,
): void {
  if (!NodeFS.existsSync(manifestPath)) {
    throw new Error(`External recovery manifest is missing: ${manifestPath}`);
  }
  const manifest = readExternalManifest(manifestPath);
  if (
    JSON.stringify(manifest.targetThreadIds.toSorted()) !==
    JSON.stringify(expectedThreadIds.toSorted())
  ) {
    throw new Error(`External recovery manifest targets do not match the database journal.`);
  }
  const externalDirectory = NodePath.dirname(NodePath.resolve(manifestPath));
  for (const bundle of manifest.bundles) {
    const resolvedBundle = NodePath.resolve(bundle.path);
    if (
      NodePath.dirname(resolvedBundle) !== externalDirectory ||
      !NodeFS.existsSync(resolvedBundle) ||
      !NodePath.isAbsolute(bundle.commonDir)
    ) {
      throw new Error(`External recovery bundle is missing or outside its journal: ${bundle.path}`);
    }
    NodeChildProcess.execFileSync(
      "git",
      ["--git-dir", bundle.commonDir, "bundle", "verify", resolvedBundle],
      {
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
  }
  for (const file of manifest.files) {
    const resolvedStaged = NodePath.resolve(file.staged);
    if (
      !NodePath.isAbsolute(file.source) ||
      NodePath.dirname(resolvedStaged) !== externalDirectory
    ) {
      throw new Error(`External recovery file has an unsafe path: ${file.source}`);
    }
    const sourceExists = pathEntryExists(file.source);
    const stagedExists = pathEntryExists(file.staged);
    if (sourceExists === stagedExists) {
      throw new Error(
        sourceExists
          ? `Both source and staged recovery files exist: ${file.source}`
          : `Both source and staged recovery files are missing: ${file.source}`,
      );
    }
    const recoveryFile = stagedExists ? file.staged : file.source;
    if (
      !Number.isSafeInteger(file.sizeBytes) ||
      file.sizeBytes < 0 ||
      !/^[0-9a-f]{64}$/u.test(file.sha256) ||
      NodeFS.statSync(recoveryFile).size !== file.sizeBytes ||
      fileSha256(recoveryFile) !== file.sha256
    ) {
      throw new Error(`External recovery file is missing, truncated, or changed: ${recoveryFile}`);
    }
  }
  for (const ref of manifest.refs) {
    if (
      !NodePath.isAbsolute(ref.cwd) ||
      !ref.ref.startsWith("refs/t3/checkpoints/") ||
      !/^[0-9a-f]{40,64}$/u.test(ref.oid)
    ) {
      throw new Error(`External recovery manifest has an invalid checkpoint ref: ${ref.ref}`);
    }
    let currentOid: string | null = null;
    try {
      currentOid = NodeChildProcess.execFileSync(
        "git",
        ["--git-dir", ref.commonDir, "rev-parse", "--verify", ref.ref],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        },
      ).trim();
    } catch {
      currentOid = null;
    }
    if (currentOid !== null && currentOid !== ref.oid) {
      throw new Error(
        `Checkpoint ref ${ref.ref} now points to ${currentOid}; recovery would overwrite it.`,
      );
    }
  }
}

function assertExternalCleanupComplete(
  manifestPath: string,
  expectedThreadIds: ReadonlyArray<string>,
): void {
  assertExternalRestoreReady(manifestPath, expectedThreadIds);
  const manifest = readExternalManifest(manifestPath);
  if (manifest.status !== "complete") {
    throw new Error(`External cleanup is not complete: ${manifestPath}`);
  }
  for (const file of manifest.files) {
    if (pathEntryExists(file.source) || !pathEntryExists(file.staged)) {
      throw new Error(`External cleanup file reappeared or is not staged: ${file.source}`);
    }
  }
  for (const ref of manifest.refs) {
    try {
      NodeChildProcess.execFileSync(
        "git",
        ["--git-dir", ref.commonDir, "show-ref", "--verify", "--quiet", ref.ref],
        { stdio: ["ignore", "ignore", "ignore"] },
      );
      throw new Error(`Purged checkpoint ref reappeared before finalize: ${ref.ref}`);
    } catch (error) {
      if (error instanceof Error && error.message.includes("reappeared before finalize")) {
        throw error;
      }
      const status =
        typeof error === "object" && error !== null && "status" in error
          ? (error as { readonly status?: unknown }).status
          : undefined;
      if (status !== 1) throw error;
    }
  }
}

function executeExternalCleanup(manifestPath: string) {
  let manifest = readExternalManifest(manifestPath);
  if (manifest.status === "restored") {
    throw new Error(`External cleanup was already restored: ${manifestPath}`);
  }
  if (manifest.status === "complete") {
    return { filesDeleted: manifest.files.length + manifest.refs.length, failures: [] as string[] };
  }
  writeDurableJson(manifestPath, { ...manifest, status: "database-swapped" });
  manifest = { ...manifest, status: "database-swapped" };
  const failures: string[] = [];
  try {
    for (const file of manifest.files) {
      const sourceExists = pathEntryExists(file.source);
      const stagedExists = pathEntryExists(file.staged);
      if (sourceExists && !stagedExists) {
        if (
          NodeFS.statSync(file.source).size !== file.sizeBytes ||
          fileSha256(file.source) !== file.sha256
        ) {
          throw new Error(`Thread-owned file changed after cleanup was planned: ${file.source}`);
        }
        NodeFS.renameSync(file.source, file.staged);
        syncPath(NodePath.dirname(file.source));
        syncPath(NodePath.dirname(file.staged));
      } else if (sourceExists && stagedExists) {
        throw new Error(`Both source and staged cleanup files exist: ${file.source}`);
      } else if (!sourceExists && !stagedExists) {
        throw new Error(`Both source and staged cleanup files are missing: ${file.source}`);
      }
    }
    for (const ref of manifest.refs) {
      let currentOid: string | null = null;
      try {
        NodeChildProcess.execFileSync(
          "git",
          ["--git-dir", ref.commonDir, "show-ref", "--verify", "--quiet", ref.ref],
          {
            stdio: ["ignore", "ignore", "ignore"],
          },
        );
        currentOid = NodeChildProcess.execFileSync(
          "git",
          ["--git-dir", ref.commonDir, "rev-parse", "--verify", ref.ref],
          {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
          },
        ).trim();
      } catch (error) {
        const status =
          typeof error === "object" && error !== null && "status" in error
            ? (error as { readonly status?: unknown }).status
            : undefined;
        if (status !== 1) throw error;
        // `git show-ref --verify` uses status 1 specifically for an absent
        // ref. Repository, cwd, permission and executable failures propagate.
      }
      if (currentOid === null) continue;
      if (currentOid !== ref.oid) {
        throw new Error(
          `Checkpoint ref ${ref.ref} changed from ${ref.oid} to ${currentOid}; refusing cleanup.`,
        );
      }
      NodeChildProcess.execFileSync(
        "git",
        ["--git-dir", ref.commonDir, "update-ref", "-d", ref.ref, ref.oid],
        {
          stdio: ["ignore", "ignore", "pipe"],
        },
      );
    }
    writeDurableJson(manifestPath, { ...manifest, status: "complete" });
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }
  return {
    filesDeleted: failures.length === 0 ? manifest.files.length + manifest.refs.length : 0,
    failures,
  };
}

function restoreExternalCleanup(manifestPath: string): void {
  let manifest = readExternalManifest(manifestPath);
  if (manifest.status === "restored") return;
  for (const bundle of manifest.bundles) {
    if (!NodeFS.existsSync(bundle.path)) {
      throw new Error(`Checkpoint bundle is missing: ${bundle.path}`);
    }
    NodeChildProcess.execFileSync(
      "git",
      ["--git-dir", bundle.commonDir, "bundle", "unbundle", bundle.path],
      {
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
  }
  for (const ref of manifest.refs) {
    let currentOid: string | null = null;
    try {
      currentOid = NodeChildProcess.execFileSync(
        "git",
        ["--git-dir", ref.commonDir, "rev-parse", "--verify", ref.ref],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        },
      ).trim();
    } catch {
      currentOid = null;
    }
    if (currentOid !== null && currentOid !== ref.oid) {
      throw new Error(
        `Checkpoint ref ${ref.ref} now points to ${currentOid}; refusing to overwrite it with ${ref.oid}.`,
      );
    }
    if (currentOid === null) {
      NodeChildProcess.execFileSync(
        "git",
        ["--git-dir", ref.commonDir, "update-ref", ref.ref, ref.oid, ""],
        {
          stdio: ["ignore", "ignore", "pipe"],
        },
      );
    }
  }
  for (const file of manifest.files.toReversed()) {
    const sourceExists = pathEntryExists(file.source);
    const stagedExists = pathEntryExists(file.staged);
    if (sourceExists && stagedExists) {
      throw new Error(`Both source and staged restore files exist: ${file.source}`);
    }
    if (!sourceExists && stagedExists) {
      ensurePrivateDirectory(NodePath.dirname(file.source));
      NodeFS.renameSync(file.staged, file.source);
      syncPath(NodePath.dirname(file.source));
      syncPath(NodePath.dirname(file.staged));
    }
  }
  manifest = { ...manifest, status: "restored" };
  writeDurableJson(manifestPath, manifest);
}

function rollbackPreparedExternalCleanup(manifestPath: string): void {
  const manifest = readExternalManifest(manifestPath);
  if (manifest.status !== "prepared") {
    throw new Error(`Only a prepared external cleanup can be rolled back: ${manifestPath}`);
  }
  for (const file of manifest.files.toReversed()) {
    if (!pathEntryExists(file.source) && pathEntryExists(file.staged)) {
      NodeFS.renameSync(file.staged, file.source);
      syncPath(NodePath.dirname(file.source));
      syncPath(NodePath.dirname(file.staged));
    }
  }
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    NodeFS.rmSync(`${manifest.candidatePath}${suffix}`, { force: true });
  }
  NodeFS.rmSync(NodePath.dirname(manifestPath), { recursive: true, force: true });
}

function recoverIncompleteExternalBackups(
  database: NodeSqlite.DatabaseSync,
  backupDirectory: string,
): void {
  for (const name of NodeFS.readdirSync(backupDirectory)) {
    if (!name.endsWith(".sqlite.external")) continue;
    const manifestPath = NodePath.join(backupDirectory, name, "manifest.json");
    recoverAtomicManifest(manifestPath);
    if (!NodeFS.existsSync(manifestPath)) {
      throw new Error(`Incomplete external purge backup has no manifest: ${manifestPath}`);
    }
    const raw = JSON.parse(NodeFS.readFileSync(manifestPath, "utf8")) as {
      readonly status?: unknown;
    };
    if (raw.status === "complete" || raw.status === "restored") continue;
    const manifest = readExternalManifest(manifestPath);
    const placeholders = manifest.targetThreadIds.map(() => "?").join(", ");
    const remaining =
      manifest.targetThreadIds.length === 0
        ? 0
        : Number(
            (
              database
                .prepare(
                  `SELECT COUNT(*) AS count FROM projection_threads WHERE thread_id IN (${placeholders})`,
                )
                .get(...manifest.targetThreadIds) as { readonly count: number }
            ).count,
          );
    if (remaining === 0) {
      const result = executeExternalCleanup(manifestPath);
      if (result.failures.length > 0) {
        throw new Error(`Could not resume external cleanup: ${result.failures.join("; ")}`);
      }
    } else if (remaining === manifest.targetThreadIds.length) {
      if (manifest.status === "prepared") rollbackPreparedExternalCleanup(manifestPath);
      else restoreExternalCleanup(manifestPath);
    } else {
      throw new Error(`External cleanup journal has a partial database state: ${manifestPath}`);
    }
  }
}

function recoverInterruptedPurge(database: NodeSqlite.DatabaseSync, databasePath: string): void {
  const journalPath = recoveryJournalPath(databasePath);
  if (!NodeFS.existsSync(journalPath)) return;
  const { journal } = readRecoveryJournal(databasePath);
  if (journal.status !== "prepared" && journal.status !== "restoring") return;
  if (
    !NodeFS.existsSync(journal.backupPath) ||
    fileSha256(journal.backupPath) !== journal.backupSha256
  ) {
    throw new Error(
      `Cannot recover interrupted purge: backup is missing or changed at ${journal.backupPath}.`,
    );
  }
  if (journal.externalManifestPath && !NodeFS.existsSync(journal.externalManifestPath)) {
    throw new Error(
      `Cannot recover interrupted purge: external manifest is missing at ${journal.externalManifestPath}.`,
    );
  }
  const placeholders = journal.targetThreadIds.map(() => "?").join(", ");
  const remaining =
    journal.targetThreadIds.length === 0
      ? 0
      : Number(
          (
            database
              .prepare(
                `SELECT COUNT(*) AS count FROM projection_threads WHERE thread_id IN (${placeholders})`,
              )
              .get(...journal.targetThreadIds) as { readonly count: number }
          ).count,
        );
  if (remaining !== 0 && remaining !== journal.targetThreadIds.length) {
    throw new Error(
      `Interrupted purge has a partial database state: ${remaining}/${journal.targetThreadIds.length} target threads remain.`,
    );
  }
  if (journal.status === "restoring") {
    if (remaining === 0) {
      throw new Error(
        `An interrupted restore is pending at ${journalPath}; resume it with --restore before other maintenance.`,
      );
    }
    if (journal.externalManifestPath) {
      assertExternalRestoreReady(journal.externalManifestPath, journal.targetThreadIds);
      restoreExternalCleanup(journal.externalManifestPath);
    }
    writeDurableJson(journalPath, { ...journal, status: "restored" });
    return;
  }
  if (journal.externalManifestPath && NodeFS.existsSync(journal.externalManifestPath)) {
    const manifest = readExternalManifest(journal.externalManifestPath);
    if (remaining === 0) {
      const result = executeExternalCleanup(journal.externalManifestPath);
      if (result.failures.length > 0) {
        throw new Error(`Could not resume external cleanup: ${result.failures.join("; ")}`);
      }
    } else if (manifest.status === "prepared") {
      rollbackPreparedExternalCleanup(journal.externalManifestPath);
    } else {
      restoreExternalCleanup(journal.externalManifestPath);
    }
  }
  writeDurableJson(journalPath, {
    ...journal,
    status: remaining === 0 ? "complete" : "restored",
  } satisfies ThreadPurgeRecoveryJournal);
}

function deletionCount(database: NodeSqlite.DatabaseSync, sql: string): number {
  return Number(database.prepare(sql).run().changes);
}

export function purgeThreadHistory(options: ThreadPurgeOptions): ThreadPurgeReport {
  const databasePath = NodePath.resolve(options.databasePath);
  const backupPath = NodePath.resolve(options.backupPath);
  const inactiveDays = options.inactiveDays ?? 30;
  if (!Number.isInteger(inactiveDays) || inactiveDays < 1) {
    throw new Error("inactiveDays must be a positive integer.");
  }
  assertSafeDatabasePath(databasePath);
  assertBackupPath(databasePath, backupPath);

  // @effect-diagnostics-next-line globalDate:off - one-shot maintenance CLI boundary.
  const cutoff = new Date(Date.now() - inactiveDays * 86_400_000).toISOString();
  const databaseBytesBefore = NodeFS.statSync(databasePath).size;
  const journalPath = recoveryJournalPath(databasePath);
  const releaseMaintenanceLock = options.apply
    ? acquireMaintenanceLock(databasePath)
    : () => undefined;
  const database = new NodeSqlite.DatabaseSync(databasePath, {
    timeout: 30_000,
    readOnly: !options.apply,
  });
  if (options.apply) {
    database.exec("PRAGMA locking_mode = EXCLUSIVE");
    const checkpoint = database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as {
      readonly busy: number;
    };
    if (Number(checkpoint.busy) !== 0) {
      database.close();
      releaseMaintenanceLock();
      throw new Error("Source SQLite WAL checkpoint remained busy before purge preparation.");
    }
  }
  let databaseClosed = false;
  const rowsDeleted: Record<string, number> = {};
  let targets: PurgeThreadRow[] = [];
  let counts = { deletedThreads: 0, archivedThreads: 0, inactiveThreads: 0 };
  let retainedThreads = 0;
  let cleanup = { filesDeleted: 0, failures: [] as string[] };
  let backupBytes = 0;
  let externalBackupBytes = 0;
  let stagedBytes = 0;
  let estimatedBundleBytes = 0;
  let cleanupPlan: ThreadFilePlan | null = null;
  let cleanupPlanDataVersion: number | undefined;
  try {
    assertThreadTableCoverage(database);
    const threadTables = resolveThreadTables(database);
    if (options.apply) {
      ensurePrivateDirectory(NodePath.dirname(backupPath));
      recoverInterruptedPurge(database, databasePath);
      recoverIncompleteExternalBackups(database, NodePath.dirname(backupPath));
      assertNoOrphanCandidates(databasePath);
    }
    database.exec(
      "PRAGMA foreign_keys = ON; CREATE TEMP TABLE purge_thread_ids (thread_id TEXT PRIMARY KEY)",
    );
    database
      .prepare(
        `INSERT INTO purge_thread_ids(thread_id)
         SELECT thread_id FROM projection_threads
         WHERE deleted_at IS NOT NULL OR archived_at IS NOT NULL OR updated_at < ?`,
      )
      .run(cutoff);
    counts = database
      .prepare(
        `SELECT
           SUM(deleted_at IS NOT NULL) AS deletedThreads,
           SUM(deleted_at IS NULL AND archived_at IS NOT NULL) AS archivedThreads,
           SUM(deleted_at IS NULL AND archived_at IS NULL AND updated_at < ?) AS inactiveThreads
         FROM projection_threads WHERE thread_id IN (SELECT thread_id FROM purge_thread_ids)`,
      )
      .get(cutoff) as typeof counts;
    retainedThreads = Number(
      (
        database
          .prepare(
            "SELECT COUNT(*) AS count FROM projection_threads WHERE thread_id NOT IN (SELECT thread_id FROM purge_thread_ids)",
          )
          .get() as { readonly count: number }
      ).count,
    );
    targets = database
      .prepare(
        `SELECT
           threads.thread_id AS threadId,
           COALESCE(projects.workspace_root, '') AS projectRoot,
           threads.worktree_path AS worktreePath,
           NULL AS attachments
         FROM projection_threads AS threads
         LEFT JOIN projection_projects AS projects ON projects.project_id = threads.project_id
         WHERE threads.thread_id IN (SELECT thread_id FROM purge_thread_ids)`,
      )
      .all() as unknown as PurgeThreadRow[];

    const retainedSegments = new Set(
      (
        database
          .prepare(
            "SELECT thread_id AS threadId FROM projection_threads WHERE thread_id NOT IN (SELECT thread_id FROM purge_thread_ids)",
          )
          .all() as Array<{ readonly threadId: string }>
      ).flatMap((row) => {
        const segment = safeThreadSegment(row.threadId);
        return segment === null ? [] : [segment];
      }),
    );
    const retainedLegacySegments = new Set(
      (
        database
          .prepare(
            "SELECT thread_id AS threadId FROM projection_threads WHERE thread_id NOT IN (SELECT thread_id FROM purge_thread_ids)",
          )
          .all() as Array<{ readonly threadId: string }>
      ).map((row) => legacyTerminalSegment(row.threadId)),
    );
    const collidingTargets = targets.filter((row) => {
      const segment = safeThreadSegment(row.threadId);
      return (
        (segment !== null && retainedSegments.has(segment)) ||
        retainedLegacySegments.has(legacyTerminalSegment(row.threadId))
      );
    });
    if (collidingTargets.length > 0) {
      throw new Error(
        `Refusing purge: ${collidingTargets.length} target thread file prefixes collide with retained threads.`,
      );
    }

    if (options.apply && targets.length > 0 && options.cleanupFiles !== false) {
      const dataVersionBeforePlan = Number(
        (database.prepare("PRAGMA data_version").get() as { readonly data_version: number })
          .data_version,
      );
      const cleanupPreflight = planThreadFiles(database, databasePath, targets);
      const dataVersionAfterPlan = Number(
        (database.prepare("PRAGMA data_version").get() as { readonly data_version: number })
          .data_version,
      );
      if (dataVersionAfterPlan !== dataVersionBeforePlan) {
        throw new Error("Source database changed while external cleanup was being planned.");
      }
      cleanupPlan = cleanupPreflight;
      cleanupPlanDataVersion = dataVersionAfterPlan;
      estimatedBundleBytes = cleanupPreflight.estimatedBundleBytes;
      if (pathEntryExists(`${backupPath}.external`)) {
        cleanupPreflight.failures.push(`External backup already exists: ${backupPath}.external`);
      }
      if (cleanupPreflight.failures.length > 0) {
        throw new Error(
          `Refusing purge: ${cleanupPreflight.failures.length} external cleanup preflight checks failed: ${cleanupPreflight.failures.join("; ")}`,
        );
      }
    }

    if (options.apply && targets.length > 0) {
      if (pathEntryExists(journalPath)) {
        throw new Error(
          `A previous purge recovery journal still exists at ${journalPath}; restore or finalize it before another purge.`,
        );
      }
      const crossReferenceTerms = [
        `(SELECT COUNT(*) FROM projection_threads
                WHERE thread_id NOT IN (SELECT thread_id FROM purge_thread_ids)
                  AND (continuation_of_thread_id IN (SELECT thread_id FROM purge_thread_ids)
                    OR continued_by_thread_id IN (SELECT thread_id FROM purge_thread_ids)))`,
        `+ (SELECT COUNT(*) FROM projection_thread_proposed_plans
                WHERE thread_id NOT IN (SELECT thread_id FROM purge_thread_ids)
                  AND implementation_thread_id IN (SELECT thread_id FROM purge_thread_ids))`,
        `+ (SELECT COUNT(*) FROM projection_turns
                WHERE thread_id NOT IN (SELECT thread_id FROM purge_thread_ids)
                  AND source_proposed_plan_thread_id IN (SELECT thread_id FROM purge_thread_ids))`,
        `+ (SELECT COUNT(*) FROM orchestration_events
                WHERE stream_id NOT IN (SELECT thread_id FROM purge_thread_ids)
                  AND (
                    (event_type = 'thread.continuation-linked'
                      AND json_extract(payload_json, '$.successorThreadId') IN (SELECT thread_id FROM purge_thread_ids))
                    OR (event_type = 'thread.proposed-plan-upserted'
                      AND json_extract(payload_json, '$.proposedPlan.implementationThreadId') IN (SELECT thread_id FROM purge_thread_ids))
                    OR (event_type = 'thread.turn-start-requested'
                      AND json_extract(payload_json, '$.sourceProposedPlan.threadId') IN (SELECT thread_id FROM purge_thread_ids))
                  ))`,
        ...threadTables
          .filter((table) => table === "thread_drafts" || table === "thread_queue_messages")
          .map(
            (table) => `+ (SELECT COUNT(*) FROM ${table}
                WHERE thread_id NOT IN (SELECT thread_id FROM purge_thread_ids)
                  AND json_extract(command_json, '$.sourceProposedPlan.threadId') IN (SELECT thread_id FROM purge_thread_ids))`,
          ),
      ];
      const crossReferences = database
        .prepare(
          `SELECT
             ${crossReferenceTerms.join("\n             ")}
             AS count`,
        )
        .get() as { readonly count: number };
      if (Number(crossReferences.count) > 0) {
        throw new Error(
          `Refusing purge: ${crossReferences.count} retained references would resurrect purged thread history during replay.`,
        );
      }
      const backup = ensureCurrentBackup(
        database,
        databasePath,
        backupPath,
        estimatedBundleBytes,
        cleanupPlanDataVersion,
      );
      backupBytes = backup.bytes;
      const candidatePath = NodePath.join(
        NodePath.dirname(databasePath),
        `.state.sqlite.purge-candidate-${process.pid}`,
      );
      if (pathEntryExists(candidatePath)) {
        throw new Error(`Purge candidate already exists: ${candidatePath}`);
      }
      const externalPreparation =
        options.cleanupFiles !== false
          ? prepareThreadFileCleanup(databasePath, backupPath, candidatePath, targets, cleanupPlan!)
          : { manifestPath: "", failures: [] as ReadonlyArray<string> };
      if (externalPreparation.failures.length > 0) {
        throw new Error(
          `Refusing purge: external cleanup journal could not be prepared: ${externalPreparation.failures.join("; ")}`,
        );
      }
      const recoveryJournal: ThreadPurgeRecoveryJournal = {
        version: 1,
        status: "prepared",
        databasePath,
        backupPath,
        backupSha256: backup.sha256,
        backupBytes: backup.bytes,
        databaseBytesBefore,
        targetThreadIds: targets.map((row) => row.threadId),
        externalManifestPath:
          externalPreparation.manifestPath.length > 0 ? externalPreparation.manifestPath : null,
      };
      writeDurableJson(journalPath, recoveryJournal);
      NodeFS.copyFileSync(backupPath, candidatePath, NodeFS.constants.COPYFILE_EXCL);
      NodeFS.chmodSync(candidatePath, 0o600);
      const candidate = new NodeSqlite.DatabaseSync(candidatePath, { timeout: 30_000 });
      let candidateClosed = false;
      let databaseSwapped = false;
      try {
        assertThreadTableCoverage(candidate);
        const candidateThreadTables = resolveThreadTables(candidate);
        candidate.exec(
          `PRAGMA foreign_keys = ON;
           CREATE TEMP TABLE purge_thread_ids (thread_id TEXT PRIMARY KEY);
           INSERT INTO purge_thread_ids(thread_id)
           SELECT thread_id FROM projection_threads
           WHERE deleted_at IS NOT NULL OR archived_at IS NOT NULL OR updated_at < '${cutoff.replaceAll("'", "''")}';
           CREATE TEMP TABLE purge_command_ids AS
           SELECT DISTINCT command_id FROM orchestration_events
           WHERE aggregate_kind = 'thread'
             AND stream_id IN (SELECT thread_id FROM purge_thread_ids)
             AND command_id IS NOT NULL;`,
        );
        const eventAutoincrementBefore = Number(
          (
            candidate
              .prepare("SELECT seq FROM sqlite_sequence WHERE name = 'orchestration_events'")
              .get() as { readonly seq?: number } | undefined
          )?.seq ?? 0,
        );
        candidate.exec("BEGIN IMMEDIATE");
        rowsDeleted.retainedContinuationLinks = deletionCount(
          candidate,
          `UPDATE projection_threads SET continuation_of_thread_id = NULL
           WHERE continuation_of_thread_id IN (SELECT thread_id FROM purge_thread_ids)`,
        );
        rowsDeleted.retainedContinuedByLinks = deletionCount(
          candidate,
          `UPDATE projection_threads SET continued_by_thread_id = NULL
           WHERE continued_by_thread_id IN (SELECT thread_id FROM purge_thread_ids)`,
        );
        rowsDeleted.retainedPlanLinks = deletionCount(
          candidate,
          `UPDATE projection_thread_proposed_plans SET implementation_thread_id = NULL
           WHERE implementation_thread_id IN (SELECT thread_id FROM purge_thread_ids)
             AND thread_id NOT IN (SELECT thread_id FROM purge_thread_ids)`,
        );
        rowsDeleted.retainedTurnLinks = deletionCount(
          candidate,
          `UPDATE projection_turns SET source_proposed_plan_thread_id = NULL, source_proposed_plan_id = NULL
           WHERE source_proposed_plan_thread_id IN (SELECT thread_id FROM purge_thread_ids)
             AND thread_id NOT IN (SELECT thread_id FROM purge_thread_ids)`,
        );
        for (const table of candidateThreadTables) {
          rowsDeleted[table] = deletionCount(
            candidate,
            `DELETE FROM ${table} WHERE thread_id IN (SELECT thread_id FROM purge_thread_ids)`,
          );
        }
        rowsDeleted.orchestration_command_receipts = deletionCount(
          candidate,
          `DELETE FROM orchestration_command_receipts
           WHERE (aggregate_kind = 'thread' AND aggregate_id IN (SELECT thread_id FROM purge_thread_ids))
              OR command_id IN (SELECT command_id FROM purge_command_ids)`,
        );
        rowsDeleted.orchestration_events = deletionCount(
          candidate,
          `DELETE FROM orchestration_events
           WHERE aggregate_kind = 'thread' AND stream_id IN (SELECT thread_id FROM purge_thread_ids)`,
        );
        rowsDeleted.projection_threads = deletionCount(
          candidate,
          "DELETE FROM projection_threads WHERE thread_id IN (SELECT thread_id FROM purge_thread_ids)",
        );
        candidate.exec("COMMIT");
        candidate.exec("PRAGMA optimize");
        if (options.vacuum !== false) candidate.exec("VACUUM");
        const checkpoint = candidate.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as {
          readonly busy: number;
        };
        if (Number(checkpoint.busy) !== 0) {
          throw new Error("SQLite candidate WAL checkpoint remained busy.");
        }
        const quickCheck = candidate.prepare("PRAGMA quick_check").all() as Array<{
          readonly quick_check: string;
        }>;
        if (quickCheck.length !== 1 || quickCheck[0]?.quick_check !== "ok") {
          throw new Error("SQLite quick_check failed after purge.");
        }
        const foreignKeyFailures = candidate.prepare("PRAGMA foreign_key_check").all();
        if (foreignKeyFailures.length > 0) {
          throw new Error(
            `SQLite foreign_key_check found ${foreignKeyFailures.length} violations.`,
          );
        }
        const remainingTargets = candidate
          .prepare(
            `SELECT
               (SELECT COUNT(*) FROM projection_threads WHERE thread_id IN (SELECT thread_id FROM purge_thread_ids))
               + (SELECT COUNT(*) FROM orchestration_events WHERE aggregate_kind = 'thread' AND stream_id IN (SELECT thread_id FROM purge_thread_ids))
               + (SELECT COUNT(*) FROM orchestration_command_receipts WHERE aggregate_kind = 'thread' AND aggregate_id IN (SELECT thread_id FROM purge_thread_ids))
               AS count`,
          )
          .get() as { readonly count: number };
        if (Number(remainingTargets.count) !== 0) {
          throw new Error(
            `Purge postcondition failed: ${remainingTargets.count} target rows remain.`,
          );
        }
        for (const table of candidateThreadTables) {
          const remaining = candidate
            .prepare(
              `SELECT COUNT(*) AS count FROM ${table} WHERE thread_id IN (SELECT thread_id FROM purge_thread_ids)`,
            )
            .get() as { readonly count: number };
          if (Number(remaining.count) !== 0) {
            throw new Error(
              `Purge postcondition failed: ${remaining.count} target rows remain in ${table}.`,
            );
          }
        }
        if (rowsDeleted.projection_threads !== targets.length) {
          throw new Error(
            `Purge postcondition failed: selected ${targets.length} threads but removed ${rowsDeleted.projection_threads ?? 0}.`,
          );
        }
        const survivorCount = candidate
          .prepare("SELECT COUNT(*) AS count FROM projection_threads")
          .get() as { readonly count: number };
        if (Number(survivorCount.count) !== retainedThreads) {
          throw new Error(
            `Purge postcondition failed: expected ${retainedThreads} retained threads, found ${survivorCount.count}.`,
          );
        }
        const eventAutoincrementAfter = Number(
          (
            candidate
              .prepare("SELECT seq FROM sqlite_sequence WHERE name = 'orchestration_events'")
              .get() as { readonly seq?: number } | undefined
          )?.seq ?? 0,
        );
        if (eventAutoincrementAfter !== eventAutoincrementBefore) {
          throw new Error(
            `Purge postcondition failed: orchestration event sequence changed from ${eventAutoincrementBefore} to ${eventAutoincrementAfter}.`,
          );
        }
        candidate.close();
        candidateClosed = true;
        syncPath(candidatePath);
        if (JSON.stringify(databaseFingerprint(database)) !== backup.sourceFingerprint) {
          throw new Error("Source database changed after its verified purge backup was created.");
        }
        database.exec("ROLLBACK");
        database.close();
        databaseClosed = true;
        for (const suffix of ["-wal", "-shm"]) {
          const sidecar = `${databasePath}${suffix}`;
          if (NodeFS.existsSync(sidecar)) NodeFS.unlinkSync(sidecar);
        }
        NodeFS.renameSync(candidatePath, databasePath);
        databaseSwapped = true;
        // Order the durable database replacement before any external cleanup.
        // Otherwise a power loss could persist removed files/refs while the
        // directory entry still points to the pre-purge database.
        syncPath(NodePath.dirname(databasePath));
      } catch (error) {
        if (!candidateClosed) {
          try {
            candidate.exec("ROLLBACK");
          } catch {
            // No active transaction if setup failed before BEGIN or after COMMIT.
          }
          candidate.close();
        }
        for (const suffix of ["", "-wal", "-shm", "-journal"]) {
          NodeFS.rmSync(`${candidatePath}${suffix}`, { force: true });
        }
        if (!databaseSwapped) {
          if (
            externalPreparation.manifestPath.length > 0 &&
            pathEntryExists(externalPreparation.manifestPath)
          ) {
            rollbackPreparedExternalCleanup(externalPreparation.manifestPath);
          }
          NodeFS.rmSync(journalPath, { force: true });
          syncPath(NodePath.dirname(journalPath));
        }
        throw error;
      }
      if (externalPreparation.manifestPath.length > 0) {
        cleanup = executeExternalCleanup(externalPreparation.manifestPath);
        externalBackupBytes = directoryBytes(NodePath.dirname(externalPreparation.manifestPath));
        stagedBytes = externalStagedBytes(externalPreparation.manifestPath);
      }
    }
    if (cleanup.failures.length > 0) {
      throw new Error(
        `Thread database purge completed safely, but ${cleanup.failures.length} external cleanup operations failed. The full backup remains at ${backupPath}.`,
      );
    }
    if (options.apply && targets.length > 0) {
      const recoveryJournal = JSON.parse(
        NodeFS.readFileSync(journalPath, "utf8"),
      ) as ThreadPurgeRecoveryJournal;
      writeDurableJson(journalPath, { ...recoveryJournal, status: "complete" });
    }
  } finally {
    if (!databaseClosed) database.close();
    releaseMaintenanceLock();
  }
  const databaseBytesAfter = NodeFS.statSync(databasePath).size;
  const databaseBytesReclaimed = Math.max(0, databaseBytesBefore - databaseBytesAfter);
  return {
    cutoff,
    applied: options.apply,
    targetThreads: targets.length,
    deletedThreads: Number(counts.deletedThreads ?? 0),
    archivedThreads: Number(counts.archivedThreads ?? 0),
    inactiveThreads: Number(counts.inactiveThreads ?? 0),
    retainedThreads,
    databaseBytesBefore,
    databaseBytesAfter,
    databaseBytesReclaimed,
    rowsDeleted,
    filesDeleted: cleanup.filesDeleted,
    fileCleanupFailures: cleanup.failures,
    externalBackupPath:
      options.apply && options.cleanupFiles !== false ? `${backupPath}.external` : null,
    backupBytes,
    externalBackupBytes,
    externalStagedBytes: stagedBytes,
    netBytesReclaimed:
      databaseBytesReclaimed - backupBytes - Math.max(0, externalBackupBytes - stagedBytes),
    recoveryJournalPath: options.apply && targets.length > 0 ? journalPath : null,
  };
}

function readRecoveryJournal(databasePath: string): {
  readonly path: string;
  readonly journal: ThreadPurgeRecoveryJournal;
} {
  const journalPath = recoveryJournalPath(NodePath.resolve(databasePath));
  if (!NodeFS.existsSync(journalPath)) {
    throw new Error(`No purge recovery journal exists at ${journalPath}.`);
  }
  const journal = JSON.parse(
    NodeFS.readFileSync(journalPath, "utf8"),
  ) as ThreadPurgeRecoveryJournal;
  if (
    journal.version !== 1 ||
    !["prepared", "complete", "restoring", "restored"].includes(journal.status) ||
    NodePath.resolve(journal.databasePath) !== NodePath.resolve(databasePath) ||
    !NodePath.isAbsolute(journal.backupPath) ||
    !/^[0-9a-f]{64}$/u.test(journal.backupSha256) ||
    !Number.isSafeInteger(journal.backupBytes) ||
    !Number.isSafeInteger(journal.databaseBytesBefore) ||
    !Array.isArray(journal.targetThreadIds) ||
    !journal.targetThreadIds.every((threadId) => typeof threadId === "string") ||
    (journal.externalManifestPath !== null &&
      NodePath.resolve(journal.externalManifestPath) !==
        NodePath.resolve(`${journal.backupPath}.external`, "manifest.json")) ||
    (journal.preRestoreDatabasePath !== undefined &&
      (!NodePath.isAbsolute(journal.preRestoreDatabasePath) ||
        NodePath.dirname(journal.preRestoreDatabasePath) !== NodePath.dirname(databasePath) ||
        !NodePath.basename(journal.preRestoreDatabasePath).startsWith(
          ".state.sqlite.pre-restore-",
        )))
  ) {
    throw new Error(`Invalid purge recovery journal: ${journalPath}`);
  }
  return { path: journalPath, journal };
}

export function restoreThreadPurge(databasePathInput: string): {
  readonly restored: true;
  readonly preRestoreDatabasePath: string;
} {
  const databasePath = NodePath.resolve(databasePathInput);
  assertSafeDatabasePath(databasePath);
  const { path: journalPath, journal } = readRecoveryJournal(databasePath);
  if (journal.status === "restored") {
    throw new Error(`Purge was already restored according to ${journalPath}.`);
  }
  const releaseMaintenanceLock = acquireMaintenanceLock(databasePath);
  const candidatePath = NodePath.join(
    NodePath.dirname(databasePath),
    `.state.sqlite.restore-candidate-${NodeCrypto.randomUUID()}`,
  );
  const preRestoreDatabasePath =
    journal.preRestoreDatabasePath ??
    NodePath.join(
      NodePath.dirname(databasePath),
      `.state.sqlite.pre-restore-${NodeCrypto.randomUUID()}`,
    );
  try {
    if (!NodeFS.existsSync(journal.backupPath)) {
      throw new Error(`Purge backup is missing: ${journal.backupPath}`);
    }
    if (fileSha256(journal.backupPath) !== journal.backupSha256) {
      throw new Error(`Purge backup hash does not match ${journalPath}.`);
    }
    validateDatabase(journal.backupPath);
    if (journal.externalManifestPath) {
      assertExternalRestoreReady(journal.externalManifestPath, journal.targetThreadIds);
    }
    NodeFS.copyFileSync(journal.backupPath, candidatePath, NodeFS.constants.COPYFILE_EXCL);
    NodeFS.chmodSync(candidatePath, 0o600);
    syncPath(candidatePath);
    validateDatabase(candidatePath);
    writeDurableJson(journalPath, {
      ...journal,
      status: "restoring",
      preRestoreDatabasePath,
    } satisfies ThreadPurgeRecoveryJournal);
    for (const suffix of ["-wal", "-shm"])
      NodeFS.rmSync(`${databasePath}${suffix}`, { force: true });
    if (!NodeFS.existsSync(preRestoreDatabasePath)) {
      NodeFS.linkSync(databasePath, preRestoreDatabasePath);
      syncPath(NodePath.dirname(databasePath));
    }
    NodeFS.renameSync(candidatePath, databasePath);
    syncPath(NodePath.dirname(databasePath));
    if (journal.externalManifestPath) restoreExternalCleanup(journal.externalManifestPath);
    writeDurableJson(journalPath, {
      ...journal,
      status: "restored",
      preRestoreDatabasePath,
    } satisfies ThreadPurgeRecoveryJournal);
    return { restored: true, preRestoreDatabasePath };
  } finally {
    NodeFS.rmSync(candidatePath, { force: true });
    releaseMaintenanceLock();
  }
}

export function finalizeThreadPurge(databasePathInput: string): {
  readonly finalized: true;
  readonly bytesRemoved: number;
  readonly netBytesReclaimed: number;
} {
  const databasePath = NodePath.resolve(databasePathInput);
  assertSafeDatabasePath(databasePath);
  const { path: journalPath, journal } = readRecoveryJournal(databasePath);
  if (journal.status !== "complete") {
    throw new Error(`Only a fully completed purge can be finalized; status is ${journal.status}.`);
  }
  const releaseMaintenanceLock = acquireMaintenanceLock(databasePath);
  try {
    if (
      !NodeFS.existsSync(journal.backupPath) ||
      fileSha256(journal.backupPath) !== journal.backupSha256
    ) {
      throw new Error(
        `Refusing finalize: purge backup is missing or changed at ${journal.backupPath}.`,
      );
    }
    if (journal.externalManifestPath) {
      assertExternalCleanupComplete(journal.externalManifestPath, journal.targetThreadIds);
    }
    const database = new NodeSqlite.DatabaseSync(databasePath);
    try {
      validateDatabase(databasePath);
      assertThreadTableCoverage(database);
      const threadTables = resolveThreadTables(database);
      database.exec("CREATE TEMP TABLE purge_finalize_ids (thread_id TEXT PRIMARY KEY)");
      const insert = database.prepare("INSERT INTO purge_finalize_ids(thread_id) VALUES (?)");
      for (const threadId of journal.targetThreadIds) insert.run(threadId);
      const remainingByTable: Record<string, number> = {};
      for (const table of [...threadTables, "projection_threads"]) {
        const count = Number(
          (
            database
              .prepare(
                `SELECT COUNT(*) AS count FROM ${table} WHERE thread_id IN (SELECT thread_id FROM purge_finalize_ids)`,
              )
              .get() as { readonly count: number }
          ).count,
        );
        if (count > 0) remainingByTable[table] = count;
      }
      const eventCount = Number(
        (
          database
            .prepare(
              "SELECT COUNT(*) AS count FROM orchestration_events WHERE aggregate_kind = 'thread' AND stream_id IN (SELECT thread_id FROM purge_finalize_ids)",
            )
            .get() as { readonly count: number }
        ).count,
      );
      if (eventCount > 0) remainingByTable.orchestration_events = eventCount;
      if (Object.keys(remainingByTable).length > 0) {
        throw new Error(
          `Refusing finalize: purged thread data reappeared: ${JSON.stringify(remainingByTable)}.`,
        );
      }
    } finally {
      database.close();
    }
    const stagedBytes = journal.externalManifestPath
      ? externalStagedBytes(journal.externalManifestPath)
      : 0;
    const bytesRemoved =
      NodeFS.statSync(journal.backupPath).size +
      (journal.externalManifestPath
        ? directoryBytes(NodePath.dirname(journal.externalManifestPath))
        : 0);
    const databaseBytesReclaimed = Math.max(
      0,
      journal.databaseBytesBefore - NodeFS.statSync(databasePath).size,
    );
    const durableDirectories = new Set([
      NodePath.dirname(journal.backupPath),
      NodePath.dirname(journalPath),
    ]);
    NodeFS.rmSync(journal.backupPath, { force: true });
    if (journal.externalManifestPath) {
      durableDirectories.add(NodePath.dirname(NodePath.dirname(journal.externalManifestPath)));
      NodeFS.rmSync(NodePath.dirname(journal.externalManifestPath), {
        recursive: true,
        force: true,
      });
    }
    NodeFS.rmSync(journalPath, { force: true });
    for (const directory of durableDirectories) syncPath(directory);
    return {
      finalized: true,
      bytesRemoved,
      netBytesReclaimed: databaseBytesReclaimed + stagedBytes,
    };
  } finally {
    releaseMaintenanceLock();
  }
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function runCli(): void {
  const databasePath = argument("--database");
  const backupPath = argument("--backup");
  if (!databasePath) {
    throw new Error(
      "Usage: node scripts/purge-thread-history.ts --database /absolute/state.sqlite (--backup /absolute/backup.sqlite [--inactive-days 30] [--apply] | --restore | --finalize) [--report file.json]",
    );
  }
  if (process.argv.includes("--restore")) {
    process.stdout.write(`${JSON.stringify(restoreThreadPurge(databasePath), null, 2)}\n`);
    return;
  }
  if (process.argv.includes("--finalize")) {
    process.stdout.write(`${JSON.stringify(finalizeThreadPurge(databasePath), null, 2)}\n`);
    return;
  }
  if (!backupPath) throw new Error("--backup is required for inventory or purge.");
  const inactiveDaysRaw = argument("--inactive-days");
  const report = purgeThreadHistory({
    databasePath,
    backupPath,
    inactiveDays: inactiveDaysRaw ? Number(inactiveDaysRaw) : 30,
    apply: process.argv.includes("--apply"),
    vacuum: !process.argv.includes("--no-vacuum"),
    cleanupFiles: !process.argv.includes("--no-file-cleanup"),
  });
  const json = `${JSON.stringify(report, null, 2)}\n`;
  const reportPath = argument("--report");
  if (reportPath) NodeFS.writeFileSync(reportPath, json, { mode: 0o600 });
  process.stdout.write(json);
}

if (import.meta.url === NodeURL.pathToFileURL(process.argv[1] ?? "").href) runCli();
