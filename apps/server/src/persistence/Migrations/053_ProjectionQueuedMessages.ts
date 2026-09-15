import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE projection_thread_messages
    ADD COLUMN queued_turn_start_json TEXT
  `.pipe(Effect.catch(() => Effect.void));

  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN queued_message_count INTEGER NOT NULL DEFAULT 0
  `.pipe(Effect.catch(() => Effect.void));
});
