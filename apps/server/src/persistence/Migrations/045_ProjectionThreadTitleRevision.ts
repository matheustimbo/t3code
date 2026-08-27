import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;

  if (!columns.some((column) => column.name === "title_revision")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN title_revision INTEGER
    `;
  }
  yield* sql`
    UPDATE projection_threads
    SET title_revision = COALESCE(title_revision, 0)
    WHERE title_revision IS NULL
  `;
});
