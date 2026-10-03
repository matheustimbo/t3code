import {
  CommandId,
  EnvironmentId,
  ExternalControlMessagesResult,
  ExternalControlMutationResult,
  ProjectId,
  ProviderInteractionMode,
  RunId,
  RuntimeMode,
  ThreadId,
  type ExternalControlMessagesInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export class ExternalControlStoreError extends Schema.TaggedError<ExternalControlStoreError>()(
  "ExternalControlStoreError",
  { operation: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return "External control persistence failed.";
  }
}
export class ExternalControlRequestConflict extends Schema.TaggedError<ExternalControlRequestConflict>()(
  "ExternalControlRequestConflict",
  {},
) {
  override get message(): string {
    return "The external request key conflicts.";
  }
}
const State = Schema.Struct({
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  subagent: Schema.Boolean,
  archived: Schema.Boolean,
  runId: Schema.NullOr(RunId),
});
export type ExternalControlThreadState = typeof State.Type;
export interface ExternalControlRequest {
  readonly environmentId: EnvironmentId;
  readonly requestNamespace: string;
  readonly principalId: string;
  readonly requestKey: string;
  readonly requestHash: string;
  readonly commandId: CommandId;
  readonly threadId: ThreadId;
  readonly runId: RunId | null;
}
export interface ExternalControlReservation extends ExternalControlRequest {
  readonly result: typeof ExternalControlMutationResult.Type | null;
}
export class ExternalControlStore extends Context.Service<
  ExternalControlStore,
  {
    readonly getState: (input: {
      projectId: ProjectId;
      threadId: ThreadId;
    }) => Effect.Effect<ExternalControlThreadState | undefined, ExternalControlStoreError>;
    readonly getMessages: (
      input: ExternalControlMessagesInput,
    ) => Effect.Effect<typeof ExternalControlMessagesResult.Type, ExternalControlStoreError>;
    readonly reserve: (
      input: ExternalControlRequest,
    ) => Effect.Effect<
      ExternalControlReservation,
      ExternalControlStoreError | ExternalControlRequestConflict
    >;
    readonly complete: (
      input: ExternalControlRequest,
      result: typeof ExternalControlMutationResult.Type,
    ) => Effect.Effect<void, ExternalControlStoreError>;
  }
>()("t3/persistence/ExternalControlStore") {}

const decodeState = Schema.decodeUnknownEffect(State);
const decodeMessages = Schema.decodeUnknownEffect(ExternalControlMessagesResult);
const decodeResult = Schema.decodeEffect(Schema.fromJsonString(ExternalControlMutationResult));
const encodeResult = Schema.encodeSync(Schema.fromJsonString(ExternalControlMutationResult));
const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const failure = (operation: string) => (cause: unknown) =>
    new ExternalControlStoreError({ operation, cause });
  return ExternalControlStore.of({
    getState: (input) =>
      sql<{
        runtimeMode: string;
        interactionMode: string;
        subagent: number;
        archived: number;
        runId: string | null;
      }>`
      SELECT json_extract(t.payload_json, '$.runtimeMode') AS runtimeMode,
        json_extract(t.payload_json, '$.interactionMode') AS interactionMode,
        COALESCE(json_extract(t.payload_json, '$.lineage.relationshipToParent') = 'subagent', 0) AS subagent,
        t.archived_at IS NOT NULL AS archived,
        (SELECT r.run_id FROM orchestration_v2_projection_runs r
         WHERE r.thread_id = t.thread_id AND r.status IN ('preparing','starting','running','waiting')
         ORDER BY r.ordinal DESC, r.run_id DESC LIMIT 1) AS runId
      FROM orchestration_v2_projection_threads t
      WHERE t.project_id = ${input.projectId} AND t.thread_id = ${input.threadId} AND t.deleted_at IS NULL
    `.pipe(
        Effect.flatMap((rows) =>
          rows[0] === undefined
            ? Effect.succeed(undefined)
            : decodeState({
                ...rows[0],
                subagent: rows[0].subagent === 1,
                archived: rows[0].archived === 1,
              }),
        ),
        Effect.mapError(failure("read_state")),
      ),
    getMessages: (input) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const cursor = input.cursor ?? 0,
              limit = input.limit ?? 50;
            const count = yield* sql<{ total: number }>`
        SELECT COUNT(*) AS total FROM orchestration_v2_projection_messages m
        JOIN orchestration_v2_projection_threads t ON t.thread_id = m.thread_id
        WHERE t.project_id = ${input.projectId} AND t.thread_id = ${input.threadId} AND t.deleted_at IS NULL
      `;
            const rows = yield* sql<{
              id: string;
              role: string;
              text: string;
              truncated: number;
              streaming: number;
              createdAt: string;
              updatedAt: string;
            }>`
        SELECT m.message_id AS id, m.role AS role,
          substr(json_extract(m.payload_json, '$.text'), 1, 65536) AS text,
          length(json_extract(m.payload_json, '$.text')) > 65536 AS truncated,
          m.streaming AS streaming, m.created_at AS createdAt, m.updated_at AS updatedAt
        FROM orchestration_v2_projection_messages m
        JOIN orchestration_v2_projection_threads t ON t.thread_id = m.thread_id
        WHERE t.project_id = ${input.projectId} AND t.thread_id = ${input.threadId} AND t.deleted_at IS NULL
        ORDER BY m.created_at ASC, m.message_id ASC LIMIT ${limit} OFFSET ${cursor}
      `;
            const total = count[0]?.total ?? 0;
            // MCP carries both text and structuredContent. Bound the aggregate,
            // including worst-case JSON escapes, below the local client's cap.
            // Advance by returned rows so stopping early never skips a message.
            let remaining = 131072;
            const items = [];
            for (const row of rows) {
              if (remaining === 0) break;
              if (row.text.length > remaining && items.length > 0) break;
              const text = row.text.slice(0, remaining);
              remaining -= text.length;
              items.push({
                ...row,
                text,
                truncated: row.truncated === 1 || text.length < row.text.length,
                streaming: row.streaming === 1,
              });
            }
            return yield* decodeMessages({
              items,
              total,
              nextCursor: cursor + items.length < total ? cursor + items.length : null,
            });
          }),
        )
        .pipe(Effect.mapError(failure("read_messages"))),
    reserve: (input) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`
        INSERT INTO external_control_requests
          (environment_id,credential_id,principal_id,request_key,request_hash,command_id,thread_id,run_id)
        VALUES (${input.environmentId},${input.requestNamespace},${input.principalId},${input.requestKey},
          ${input.requestHash},${input.commandId},${input.threadId},${input.runId})
        ON CONFLICT DO NOTHING
      `;
            const rows = yield* sql<{
              request_hash: string;
              principal_id: string;
              command_id: string;
              thread_id: string;
              run_id: string | null;
              result_json: string | null;
            }>`
        SELECT request_hash,principal_id,command_id,thread_id,run_id,result_json
        FROM external_control_requests WHERE environment_id = ${input.environmentId}
          AND credential_id = ${input.requestNamespace} AND request_key = ${input.requestKey}
      `;
            const row = rows[0];
            if (
              row === undefined ||
              row.request_hash !== input.requestHash ||
              row.principal_id !== input.principalId ||
              row.command_id !== input.commandId ||
              row.thread_id !== input.threadId
            ) {
              return yield* new ExternalControlRequestConflict();
            }
            return {
              ...input,
              commandId: CommandId.make(row.command_id),
              threadId: ThreadId.make(row.thread_id),
              runId: row.run_id === null ? null : RunId.make(row.run_id),
              result: row.result_json === null ? null : yield* decodeResult(row.result_json),
            };
          }),
        )
        .pipe(
          Effect.mapError((cause) =>
            cause._tag === "ExternalControlRequestConflict" ? cause : failure("reserve")(cause),
          ),
        ),
    complete: (input, result) =>
      sql`
      UPDATE external_control_requests SET result_json = COALESCE(result_json, ${encodeResult(result)})
      WHERE environment_id = ${input.environmentId} AND credential_id = ${input.requestNamespace}
        AND principal_id = ${input.principalId} AND request_key = ${input.requestKey}
        AND request_hash = ${input.requestHash} RETURNING command_id
    `.pipe(
        Effect.flatMap((rows) =>
          rows.length === 1 ? Effect.void : Effect.fail(new ExternalControlRequestConflict()),
        ),
        Effect.mapError(failure("complete")),
      ),
  });
});
export const layer = Layer.effect(ExternalControlStore, make);
