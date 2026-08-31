import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("044_ProjectionProjectTicketTitles", (it) => {
  it.effect("adds ticket policy and account bindings to project projections", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 43 });
      yield* runMigrations({ toMigrationInclusive: 44 });

      const columns = yield* sql<{
        readonly name: string;
        readonly notnull: number;
        readonly dflt_value: string | null;
      }>`
        PRAGMA table_info(projection_projects)
      `;
      const policy = columns.find((column) => column.name === "ticket_title_policy_json");
      const bindings = columns.find((column) => column.name === "ticket_provider_bindings_json");

      assert.equal(policy?.notnull, 0);
      assert.equal(bindings?.notnull, 1);
      assert.equal(bindings?.dflt_value, "'[]'");
    }),
  );
});
