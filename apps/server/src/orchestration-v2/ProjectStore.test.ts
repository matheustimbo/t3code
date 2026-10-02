import { assert, it } from "@effect/vitest";
import {
  ApplicationProjectEvent,
  EventId,
  ProjectId,
  ProviderInstanceId,
  TicketProviderDriverKind,
  TicketProviderInstanceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ProjectStore from "./ProjectStore.ts";

const projectEventCodec = Schema.fromJsonString(ApplicationProjectEvent);
const encodeProjectEvent = Schema.encodeEffect(projectEventCodec);
const decodeProjectEvent = Schema.decodeEffect(projectEventCodec);

it.layer(ProjectStore.layer.pipe(Layer.provideMerge(SqlitePersistenceMemory)))(
  "ProjectStoreV2",
  (it) => {
    it.effect("replays ticket settings, preserves them on unrelated updates, and resets them", () =>
      Effect.gen(function* () {
        const projects = yield* ProjectStore.ProjectStoreV2;
        const sql = yield* SqlClient.SqlClient;
        const projectId = ProjectId.make("project-ticket-replay");
        const timestamp = "2026-03-24T00:00:00.000Z";
        const ticketTitlePolicy = { mode: "title", customTemplate: "{title}" } as const;
        const ticketProviderBindings = [
          {
            driver: TicketProviderDriverKind.make("github"),
            host: "github.com",
            instanceId: TicketProviderInstanceId.make("github_work"),
          },
        ];
        const base = {
          aggregateKind: "project" as const,
          aggregateId: projectId,
          occurredAt: timestamp,
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
        };
        const events: ReadonlyArray<ApplicationProjectEvent> = [
          {
            ...base,
            sequence: 1,
            eventId: EventId.make("event-ticket-create"),
            type: "project.created",
            payload: {
              projectId,
              title: "Tickets",
              workspaceRoot: "/tmp/tickets",
              defaultModelSelection: null,
              scripts: [],
              createdAt: timestamp,
              updatedAt: timestamp,
            },
          },
          {
            ...base,
            sequence: 2,
            eventId: EventId.make("event-ticket-update"),
            type: "project.meta-updated",
            payload: { projectId, ticketTitlePolicy, ticketProviderBindings, updatedAt: timestamp },
          },
          {
            ...base,
            sequence: 3,
            eventId: EventId.make("event-ticket-rename"),
            type: "project.meta-updated",
            payload: { projectId, title: "Renamed", updatedAt: timestamp },
          },
        ];
        const persistedEvents = yield* Effect.forEach(events, (event) => encodeProjectEvent(event));
        for (const persisted of persistedEvents)
          yield* projects.apply(yield* decodeProjectEvent(persisted));
        const beforeReplay = Option.getOrThrow(yield* projects.getShell(projectId));
        assert.deepEqual(beforeReplay.ticketTitlePolicy, ticketTitlePolicy);
        assert.deepEqual(beforeReplay.ticketProviderBindings, ticketProviderBindings);
        yield* sql`DELETE FROM projection_projects WHERE project_id = ${projectId}`;
        for (const persisted of persistedEvents)
          yield* projects.apply(yield* decodeProjectEvent(persisted));
        assert.deepEqual(Option.getOrThrow(yield* projects.getShell(projectId)), beforeReplay);
        assert.deepEqual(
          (yield* projects.listShells({ projectIds: [projectId] }))[0],
          beforeReplay,
        );
        yield* projects.apply({
          ...base,
          sequence: 4,
          eventId: EventId.make("event-ticket-reset"),
          type: "project.meta-updated",
          payload: {
            projectId,
            ticketTitlePolicy: null,
            ticketProviderBindings: [],
            updatedAt: timestamp,
          },
        });
        const reset = Option.getOrThrow(yield* projects.getShell(projectId));
        assert.isNull(reset.ticketTitlePolicy);
        assert.deepEqual(reset.ticketProviderBindings, []);
      }),
    );

    it.effect("stores a model selection without options as JSON without an options key", () =>
      Effect.gen(function* () {
        const projects = yield* ProjectStore.ProjectStoreV2;
        const sql = yield* SqlClient.SqlClient;
        const projectId = ProjectId.make("project-null-options");
        const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };
        yield* projects.apply({
          sequence: 1,
          eventId: EventId.make("event-null-options"),
          aggregateKind: "project",
          aggregateId: projectId,
          occurredAt: "2026-03-24T00:00:00.000Z",
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          type: "project.created",
          payload: {
            projectId,
            title: "Null options project",
            workspaceRoot: "/tmp/project-null-options",
            defaultModelSelection: modelSelection,
            scripts: [],
            createdAt: "2026-03-24T00:00:00.000Z",
            updatedAt: "2026-03-24T00:00:00.000Z",
          },
        });

        const rows = yield* sql<{ readonly defaultModelSelection: string | null }>`
          SELECT default_model_selection_json AS "defaultModelSelection"
          FROM projection_projects
          WHERE project_id = ${projectId}
        `;
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        assert.strictEqual(rows[0]?.defaultModelSelection, JSON.stringify(modelSelection));
        assert.deepStrictEqual(
          Option.getOrNull(yield* projects.get(projectId))?.defaultModelSelection,
          modelSelection,
        );
      }),
    );
  },
);
