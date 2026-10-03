import { expect, it } from "@effect/vitest";
import * as NodeCrypto from "node:crypto";
import * as NodePlatformCrypto from "@effect/platform-node/NodeCrypto";
import {
  CommandId,
  ExternalControlCreateInput,
  ExternalControlSendInput,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Access from "./ExternalReadAccess.ts";
import * as Control from "./ExternalControlService.ts";
import * as GrantStore from "../../persistence/ExternalReadGrantStore.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import { allowed, blocked, environmentLayer, grant, removed, seed } from "./testSupport.ts";
import {
  controlGrant,
  controlIdentity,
  controlLayer,
  controlToken,
  modelSelection,
} from "./controlTestSupport.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const createInput = {
  projectId: allowed,
  requestKey: "create-fixture",
  title: "External fixture",
  modelSelection,
  runtimeMode: "approval-required" as const,
  interactionMode: "plan" as const,
};
it.effect("uses native commands and intake, with concurrent durable create/send retries", () =>
  Effect.gen(function* () {
    yield* seed;
    const service = yield* Control.ExternalControlService;
    const sql = yield* SqlClient.SqlClient;
    const created = yield* Effect.all(
      Array.from({ length: 4 }, () => service.create(controlIdentity, createInput)),
      { concurrency: "unbounded" },
    );
    expect(new Set(created.map((result) => result.threadId)).size).toBe(1);
    const threadId = created[0]!.threadId;
    const input = {
      projectId: allowed,
      threadId,
      requestKey: "send-fixture",
      text: "Synthetic prompt only",
      mode: "auto" as const,
    };
    const sent = yield* Effect.all(
      Array.from({ length: 4 }, () => service.send(controlIdentity, input)),
      { concurrency: "unbounded" },
    );
    expect(new Set(sent.map((result) => result.messageId)).size).toBe(1);
    const messages = yield* service.messages(controlIdentity, { projectId: allowed, threadId });
    expect(messages.items.map((message) => message.text)).toEqual(["Synthetic prompt only"]);
    expect(messages.total).toBe(1);
    expect(yield* sql`SELECT COUNT(*) AS count FROM external_control_requests`).toEqual([
      { count: 2 },
    ]);
    // Simulates losing the response/cache write after the native receipt committed.
    yield* sql`UPDATE external_control_requests SET result_json = NULL WHERE request_key = 'send-fixture'`;
    expect(yield* service.send(controlIdentity, input)).toEqual(sent[0]);
    expect((yield* service.messages(controlIdentity, { projectId: allowed, threadId })).total).toBe(
      1,
    );
  }).pipe(Effect.provide(controlLayer())),
);

it.effect(
  "binds request keys to the full operation/input and denies cross-project thread IDs",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const service = yield* Control.ExternalControlService;
      yield* service.create(controlIdentity, createInput);
      expect(
        yield* service
          .create(controlIdentity, { ...createInput, title: "Different" })
          .pipe(Effect.flip),
      ).toMatchObject({ code: "conflict" });
      for (const id of ["foreign", "unknown", "deleted"]) {
        const threadId = ThreadId.make(id);
        expect(
          yield* service
            .messages(controlIdentity, { projectId: allowed, threadId })
            .pipe(Effect.flip),
        ).toMatchObject({ code: "not_found" });
        expect(
          yield* service
            .send(controlIdentity, {
              projectId: allowed,
              threadId,
              requestKey: id,
              text: "fixture",
              mode: "auto",
            })
            .pipe(Effect.flip),
        ).toMatchObject({ code: "not_found" });
        expect(
          yield* service
            .interrupt(controlIdentity, { projectId: allowed, threadId, requestKey: id })
            .pipe(Effect.flip),
        ).toMatchObject({ code: "not_found" });
      }
      expect(
        yield* service
          .create(controlIdentity, { ...createInput, projectId: blocked })
          .pipe(Effect.flip),
      ).toMatchObject({ code: "access_denied" });
    }).pipe(Effect.provide(controlLayer())),
);

it.effect(
  "reads without acknowledgements, attachment/lineage hydration or other state writes",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const service = yield* Control.ExternalControlService;
      const sql = yield* SqlClient.SqlClient;
      const before = yield* sql`SELECT total_changes() AS changes`;
      const result = yield* service.messages(controlIdentity, {
        projectId: allowed,
        threadId: ThreadId.make("b"),
      });
      expect(
        result.items.every(
          (message) =>
            !("attachments" in message) && !("context" in message) && !("runId" in message),
        ),
      ).toBe(true);
      expect(yield* sql`SELECT total_changes() AS changes`).toEqual(before);
    }).pipe(Effect.provide(controlLayer())),
);

it.effect("binds both no-op and active interruptions without targeting a later run", () =>
  Effect.gen(function* () {
    yield* seed;
    const service = yield* Control.ExternalControlService;
    const sql = yield* SqlClient.SqlClient;
    const { threadId } = yield* service.create(controlIdentity, createInput);
    const empty = { projectId: allowed, threadId, requestKey: "interrupt-empty" };
    const noop = yield* service.interrupt(controlIdentity, empty);
    expect(noop.outcome).toBe("no_active_run");
    yield* service.send(controlIdentity, {
      projectId: allowed,
      threadId,
      requestKey: "first-run",
      text: "Synthetic first run",
      mode: "auto",
    });
    const active = yield* sql<{
      run_id: string;
      status: string;
    }>`SELECT run_id, status FROM orchestration_v2_projection_runs WHERE thread_id = ${threadId} ORDER BY ordinal DESC LIMIT 1`;
    expect(yield* service.interrupt(controlIdentity, empty)).toEqual(noop);
    expect(
      yield* sql`SELECT run_id, status FROM orchestration_v2_projection_runs WHERE thread_id = ${threadId} ORDER BY ordinal DESC LIMIT 1`,
    ).toEqual(active);
    const input = { projectId: allowed, threadId, requestKey: "interrupt-first-run" };
    const interrupted = yield* service.interrupt(controlIdentity, input);
    expect(interrupted.outcome).toBe("accepted");
    yield* service.send(controlIdentity, {
      projectId: allowed,
      threadId,
      requestKey: "second-run",
      text: "Synthetic second run",
      mode: "auto",
    });
    const later = yield* sql<{
      run_id: string;
      status: string;
    }>`SELECT run_id, status FROM orchestration_v2_projection_runs WHERE thread_id = ${threadId} ORDER BY ordinal DESC LIMIT 1`;
    expect(later[0]?.run_id).not.toBe(active[0]?.run_id);
    yield* sql`UPDATE external_control_requests SET result_json = NULL WHERE request_key = 'interrupt-first-run'`;
    expect(yield* service.interrupt(controlIdentity, input)).toEqual(interrupted);
    expect(
      yield* sql`SELECT run_id, status FROM orchestration_v2_projection_runs WHERE thread_id = ${threadId} ORDER BY ordinal DESC LIMIT 1`,
    ).toEqual(later);
    expect(
      yield* sql`SELECT run_id FROM external_control_requests WHERE request_key = 'interrupt-first-run'`,
    ).toEqual([{ run_id: active[0]!.run_id }]);
  }).pipe(Effect.provide(controlLayer())),
);

it.effect(
  "denies missing operations, subagent writes and deleted projects before reserving requests",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const service = yield* Control.ExternalControlService;
      const sql = yield* SqlClient.SqlClient;
      expect(
        yield* service
          .messages(controlIdentity, { projectId: allowed, threadId: ThreadId.make("b") })
          .pipe(Effect.flip),
      ).toMatchObject({ code: "access_denied" });
      expect(
        yield* service
          .create(controlIdentity, { ...createInput, projectId: removed })
          .pipe(Effect.flip),
      ).toMatchObject({ code: "not_found" });
      expect(
        yield* service
          .send(controlIdentity, {
            projectId: allowed,
            threadId: ThreadId.make("a"),
            requestKey: "subagent",
            text: "Synthetic",
            mode: "auto",
          })
          .pipe(Effect.flip),
      ).toMatchObject({ code: "access_denied" });
      expect(
        yield* service
          .interrupt(controlIdentity, {
            projectId: allowed,
            threadId: ThreadId.make("a"),
            requestKey: "interrupt-subagent",
          })
          .pipe(Effect.flip),
      ).toMatchObject({ code: "access_denied" });
      expect(yield* sql`SELECT COUNT(*) AS count FROM external_control_requests`).toEqual([
        { count: 0 },
      ]);
    }).pipe(
      Effect.provide(
        controlLayer({
          ...controlGrant,
          operations: ["threads.create", "threads.send", "threads.interrupt"],
        }),
      ),
    ),
);

it.effect("fails closed for absent request persistence and corrupt cached results", () =>
  Effect.gen(function* () {
    yield* seed;
    const service = yield* Control.ExternalControlService;
    const sql = yield* SqlClient.SqlClient;
    const created = yield* service.create(controlIdentity, createInput);
    const send = {
      projectId: allowed,
      threadId: created.threadId,
      requestKey: "corrupt-cache",
      text: "Synthetic",
      mode: "auto" as const,
    };
    yield* service.send(controlIdentity, send);
    yield* sql`UPDATE external_control_requests SET result_json = 'invalid' WHERE request_key = 'corrupt-cache'`;
    expect(yield* service.send(controlIdentity, send).pipe(Effect.flip)).toMatchObject({
      code: "unavailable",
    });
    expect(
      (yield* service.messages(controlIdentity, { projectId: allowed, threadId: created.threadId }))
        .total,
    ).toBe(1);
    yield* sql`DROP TABLE external_control_requests`;
    expect(
      yield* service
        .send(controlIdentity, { ...send, requestKey: "absent-store" })
        .pipe(Effect.flip),
    ).toMatchObject({ code: "unavailable" });
    expect(
      (yield* service.messages(controlIdentity, { projectId: allowed, threadId: created.threadId }))
        .total,
    ).toBe(1);
  }).pipe(Effect.provide(controlLayer())),
);

it.effect.each(["thread", "command", "result"] as const)(
  "rejects an inconsistent durable %s binding before dispatch/replay",
  (binding) =>
    Effect.gen(function* () {
      yield* seed;
      const service = yield* Control.ExternalControlService;
      const sql = yield* SqlClient.SqlClient;
      const { threadId } = yield* service.create(controlIdentity, createInput);
      const input = {
        projectId: allowed,
        threadId,
        requestKey: "inconsistent-binding",
        text: "Synthetic",
        mode: "auto" as const,
      };
      yield* service.send(controlIdentity, input);
      if (binding === "thread")
        yield* sql`UPDATE external_control_requests SET thread_id = 'foreign', result_json = NULL WHERE request_key = 'inconsistent-binding'`;
      else if (binding === "command")
        yield* sql`UPDATE external_control_requests SET command_id = 'inconsistent-command', result_json = NULL WHERE request_key = 'inconsistent-binding'`;
      else
        yield* sql`UPDATE external_control_requests SET result_json = json_set(result_json, '$.projectId', 'blocked', '$.threadId', 'foreign') WHERE request_key = 'inconsistent-binding'`;
      const before = yield* sql`SELECT COUNT(*) AS count FROM orchestration_v2_events`;
      expect(yield* service.send(controlIdentity, input).pipe(Effect.flip)).toMatchObject({
        code: binding === "result" ? "unavailable" : "conflict",
      });
      expect(yield* sql`SELECT COUNT(*) AS count FROM orchestration_v2_events`).toEqual(before);
      expect(
        yield* sql`SELECT COUNT(*) AS count FROM orchestration_v2_projection_messages WHERE thread_id = 'foreign'`,
      ).toEqual([{ count: 0 }]);
      expect(
        (yield* service.messages(controlIdentity, { projectId: allowed, threadId })).total,
      ).toBe(1);
    }).pipe(Effect.provide(controlLayer())),
);

it.effect("enforces runtime/interaction ceilings and denies old read audience for control", () =>
  Effect.gen(function* () {
    yield* seed;
    const service = yield* Control.ExternalControlService;
    const access = yield* Access.ExternalReadAccess;
    expect(yield* access.authenticate(controlToken)).toBeUndefined();
    expect(yield* access.authenticate(controlToken, Access.CONTROL_AUDIENCE)).toEqual(
      controlIdentity,
    );
    expect(
      yield* service
        .create({ credentialId: grant.id, principalId: grant.principalId }, createInput)
        .pipe(Effect.flip),
    ).toMatchObject({ code: "access_denied" });
    expect(
      yield* service
        .create(controlIdentity, { ...createInput, runtimeMode: "full-access" })
        .pipe(Effect.flip),
    ).toMatchObject({ code: "access_denied" });
    expect(
      yield* service
        .create(controlIdentity, { ...createInput, interactionMode: "default" })
        .pipe(Effect.flip),
    ).toMatchObject({ code: "access_denied" });
    yield* service.create(controlIdentity, createInput);
  }).pipe(
    Effect.provide(
      controlLayer({
        ...controlGrant,
        controlPolicy: { runtimeModeCeiling: "approval-required", interactionModeCeiling: "plan" },
      }),
    ),
  ),
);

it.effect(
  "denies a new send after thread policy is reduced during an existing run, while allowing receipt replay",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const service = yield* Control.ExternalControlService;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const sql = yield* SqlClient.SqlClient;
      const { threadId } = yield* service.create(controlIdentity, {
        ...createInput,
        runtimeMode: "full-access",
        interactionMode: "default",
      });
      const original = {
        projectId: allowed,
        threadId,
        requestKey: "high-policy-run",
        text: "Synthetic",
        mode: "auto" as const,
      };
      const first = yield* service.send(controlIdentity, original);
      yield* threads.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("reduce-runtime"),
        threadId,
        runtimeMode: "approval-required",
      });
      yield* threads.dispatch({
        type: "thread.interaction-mode.set",
        commandId: CommandId.make("reduce-interaction"),
        threadId,
        interactionMode: "plan",
      });
      const limited = {
        ...controlGrant,
        id: "limited-fixture",
        principalId: "limited-fixture",
        tokenHash: NodeCrypto.createHash("sha256")
          .update("limited-synthetic-fixture")
          .digest("hex"),
        controlPolicy: {
          runtimeModeCeiling: "approval-required" as const,
          interactionModeCeiling: "plan" as const,
        },
      };
      yield* (yield* GrantStore.ExternalReadGrantStore).register(Access.grantBinding(limited));
      const registry = Access.layer.pipe(
        Layer.fresh,
        Layer.provide(
          Layer.succeed(Access.ExternalReadSettings, { enabled: true, grants: [limited] }),
        ),
        Layer.provide(environmentLayer),
        Layer.provide(NodePlatformCrypto.layer),
      );
      const beforeEvents = yield* sql`SELECT COUNT(*) AS count FROM orchestration_v2_events`;
      const beforeEffects =
        yield* sql`SELECT COUNT(*) AS count FROM orchestration_v2_effect_outbox`;
      yield* Effect.gen(function* () {
        const controller = yield* Control.ExternalControlService;
        expect(
          yield* controller
            .send(
              { credentialId: limited.id, principalId: limited.principalId },
              { ...original, requestKey: "limited-active-send" },
            )
            .pipe(Effect.flip),
        ).toMatchObject({ code: "access_denied" });
      }).pipe(Effect.provide(Control.layer.pipe(Layer.fresh, Layer.provideMerge(registry))));
      expect(yield* sql`SELECT COUNT(*) AS count FROM orchestration_v2_events`).toEqual(
        beforeEvents,
      );
      expect(yield* sql`SELECT COUNT(*) AS count FROM orchestration_v2_effect_outbox`).toEqual(
        beforeEffects,
      );
      yield* sql`UPDATE external_control_requests SET result_json = NULL WHERE request_key = 'high-policy-run'`;
      expect(yield* service.send(controlIdentity, original)).toEqual(first);
      expect(
        (yield* service.messages(controlIdentity, { projectId: allowed, threadId })).total,
      ).toBe(1);
    }).pipe(Effect.provide(controlLayer())),
);

it.effect.each(["revoke", "expire"] as const)(
  "denies %s before replaying a durable result",
  (mode) =>
    Effect.gen(function* () {
      yield* seed;
      const service = yield* Control.ExternalControlService;
      const access = yield* Access.ExternalReadAccess;
      yield* service.create(controlIdentity, createInput);
      if (mode === "revoke") yield* access.revoke(controlGrant.id);
      else yield* TestClock.setTime(controlGrant.expiresAt);
      expect(yield* service.create(controlIdentity, createInput).pipe(Effect.flip)).toMatchObject({
        code: "access_denied",
      });
    }).pipe(Effect.provide(controlLayer())),
);

it.effect.each([
  [ExternalControlCreateInput, { ...createInput, parentThreadId: "foreign" }],
  [ExternalControlCreateInput, { ...createInput, "title\n": "invalid" }],
  [
    ExternalControlCreateInput,
    { ...createInput, modelSelection: { ...modelSelection, "model\n": "invalid" } },
  ],
  [
    ExternalControlSendInput,
    {
      projectId: allowed,
      threadId: "b",
      requestKey: "bad",
      text: "fixture",
      mode: "auto",
      attachments: [{ id: "foreign" }],
    },
  ],
  [
    ExternalControlSendInput,
    {
      projectId: allowed,
      threadId: "b",
      requestKey: "bad",
      text: "fixture",
      mode: "auto",
      context: { sourceThreadId: "foreign" },
    },
  ],
  [
    ExternalControlSendInput,
    { projectId: allowed, threadId: "b", requestKey: "bad", text: "fixture", mode: "queue" },
  ],
] as const)(
  "rejects unsupported references/attachments at the contract boundary %#",
  ([schema, input]) =>
    Effect.gen(function* () {
      const result = yield* Schema.decodeUnknownEffect(schema)(input).pipe(Effect.exit);
      expect(result._tag).toBe("Failure");
    }),
);

it.effect("bounds message pages across both MCP representations without skipping cursors", () =>
  Effect.gen(function* () {
    yield* seed;
    const service = yield* Control.ExternalControlService;
    const sql = yield* SqlClient.SqlClient;
    const { threadId } = yield* service.create(controlIdentity, {
      ...createInput,
      requestKey: "bounded-page",
    });
    const text = "\u0001".repeat(45000);
    const payload = encodeJson({ text });
    for (let index = 0; index < 5; index++)
      yield* sql`
      INSERT INTO orchestration_v2_projection_messages
        (message_id, thread_id, role, streaming, created_at, updated_at, payload_json)
      VALUES (${`large-${index}`}, ${threadId}, 'assistant', 0,
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', ${payload})
    `;
    const pages = [];
    let cursor = 0;
    do {
      const page = yield* service.messages(controlIdentity, {
        projectId: allowed,
        threadId,
        cursor,
      });
      expect(page.total).toBe(5);
      expect(page.items.length).toBeLessThanOrEqual(2);
      expect(page.items.every((message) => message.text === text && !message.truncated)).toBe(true);
      const encoded = encodeJson(page);
      expect(
        Buffer.byteLength(
          encodeJson({
            structuredContent: page,
            content: [{ type: "text", text: encoded }],
          }),
        ),
      ).toBeLessThan(2 * 1024 * 1024);
      pages.push(...page.items.map((message) => message.id));
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    } while (true);
    expect(pages).toEqual(["large-0", "large-1", "large-2", "large-3", "large-4"]);
  }).pipe(Effect.provide(controlLayer())),
);
