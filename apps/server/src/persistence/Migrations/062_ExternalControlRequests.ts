import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE external_control_requests (
      environment_id TEXT NOT NULL,
      credential_id TEXT NOT NULL,
      principal_id TEXT NOT NULL,
      request_key TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      command_id TEXT NOT NULL UNIQUE,
      thread_id TEXT NOT NULL,
      run_id TEXT,
      result_json TEXT,
      PRIMARY KEY (environment_id, credential_id, request_key)
    )
  `;
});
