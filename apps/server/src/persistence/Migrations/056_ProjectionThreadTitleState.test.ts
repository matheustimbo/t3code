import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";

it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()))("fork queue upgrade", (it) => {
  it.effect("adds upstream title state after the already shipped fork migrations", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 55 });
      const previous = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
      const applied = yield* runMigrations();
      assert.deepEqual(applied, [[56, "ProjectionThreadTitleState"]]);
      assert.deepEqual(
        yield* sql`SELECT * FROM effect_sql_migrations WHERE migration_id <= 55 ORDER BY migration_id`,
        previous,
      );
      const threadColumns = yield* sql<{ name: string }>`PRAGMA table_info(projection_threads)`;
      const messageColumns = yield* sql<{
        name: string;
      }>`PRAGMA table_info(projection_thread_messages)`;
      assert.isTrue(threadColumns.some((column) => column.name === "title_state_json"));
      assert.isTrue(threadColumns.some((column) => column.name === "title_revision"));
      assert.isTrue(messageColumns.some((column) => column.name === "queued_turn_start_json"));
      assert.isTrue(messageColumns.some((column) => column.name === "context_json"));
      assert.deepEqual(yield* runMigrations(), []);
    }),
  );
});
