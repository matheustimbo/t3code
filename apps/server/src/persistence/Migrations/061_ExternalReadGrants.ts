import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Keep revoked rows permanently: neither a reused ID nor renamed bearer may
  // become active by reloading configuration. No credentials are provisioned here.
  yield* sql`
    CREATE TABLE external_read_grants (
      environment_id TEXT NOT NULL,
      credential_id TEXT NOT NULL,
      token_hash TEXT NOT NULL,
      policy_json TEXT NOT NULL,
      revoked_at INTEGER,
      PRIMARY KEY (environment_id, credential_id),
      UNIQUE (environment_id, token_hash)
    )
  `;
});
