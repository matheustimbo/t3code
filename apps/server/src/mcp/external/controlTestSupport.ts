// @effect-diagnostics nodeBuiltinImport:off -- fixtures hash tokens synchronously, as grants store them.
import * as NodeCrypto from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ServerConfig from "../../config.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as ProviderAdapterRegistry from "../../orchestration-v2/ProviderAdapterRegistry.ts";
import type { ProviderAdapterV2Shape } from "../../orchestration-v2/ProviderAdapter.ts";
import { CodexProviderCapabilitiesV2 } from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as ProviderReplayHarness from "../../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as Store from "../../persistence/ExternalControlStore.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as Access from "./ExternalReadAccess.ts";
import * as Control from "./ExternalControlService.ts";
import { accessLayer, grant } from "./testSupport.ts";

export const controlToken = "external-control-synthetic-fixture";
export const controlIdentity = {
  credentialId: "control-fixture",
  principalId: "external-control-fixture",
};
export const controlGrant: Access.ExternalReadGrant = {
  ...grant,
  id: controlIdentity.credentialId,
  principalId: controlIdentity.principalId,
  tokenHash: NodeCrypto.createHash("sha256").update(controlToken).digest("hex"),
  audience: Access.CONTROL_AUDIENCE,
  operations: [
    "projects.list",
    "threads.list",
    "threads.status",
    "threads.messages",
    "threads.create",
    "threads.send",
    "threads.interrupt",
  ],
  controlPolicy: { runtimeModeCeiling: "full-access", interactionModeCeiling: "default" },
};
export const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.1-codex",
};
const adapter = {
  instanceId: modelSelection.instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("External controller fixtures never start providers"),
} as ProviderAdapterV2Shape;
export const nativeLayerFor = (
  database: ReturnType<typeof SqlitePersistence.layerFromPath> = SqlitePersistence.layerMemory,
) =>
  ProviderReplayHarness.layerWithRegistry(
    { name: "external-control-fixture" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { runEffectWorker: false, databaseLayer: database.pipe(Layer.provide(NodeServices.layer)) },
  );
export const controlLayer = (
  policy = controlGrant,
  database: ReturnType<typeof SqlitePersistence.layerFromPath> = SqlitePersistence.layerMemory,
) => {
  const native = nativeLayerFor(database);
  const stores = Layer.mergeAll(ProjectStore.layer, ProjectionStore.layer).pipe(
    Layer.provideMerge(database),
  );
  return Control.layer.pipe(
    Layer.provideMerge(Store.layer),
    Layer.provideMerge(ThreadManagement.layer.pipe(Layer.provide(native))),
    Layer.provideMerge(stores),
    Layer.provideMerge(accessLayer([policy, grant], true, database)),
    // No attachments are accepted. This external config boundary must never be read.
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "external-control-intake-" }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );
};
