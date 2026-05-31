/**
 * VerbooDriver — `ProviderDriver` for the Verboo Agent runtime.
 *
 * Verboo is a rebrand/fork of Claude Code that speaks the EXACT same protocol
 * as `@anthropic-ai/claude-agent-sdk`. The driver therefore reuses the Claude
 * adapter + text-generation layers, parameterized with the Verboo driver kind
 * and the Verboo HOME environment (so the `verboo` binary reads
 * `$HOME/.verboo`). Models are discovered at runtime via
 * `probeVerbooCapabilities` rather than hardcoded.
 *
 * Mirrors `ClaudeDriver`: a plain value whose `create()` returns one
 * `ProviderInstance` bundling `snapshot` / `adapter` / `textGeneration`
 * closures captured over the per-instance `VerbooSettings`. The capabilities
 * probe is per-instance and keyed by binary + resolved HOME so two concurrent
 * Verboo instances don't cross-contaminate account/model metadata.
 *
 * @module provider/Drivers/VerbooDriver
 */
import { ProviderDriverKind, type ServerProvider, VerbooSettings } from "@t3tools/contracts";
import * as Cache from "effect/Cache";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import { makeClaudeTextGeneration } from "../../textGeneration/ClaudeTextGeneration.ts";
import { ServerConfig } from "../../config.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeClaudeAdapter } from "../Layers/ClaudeAdapter.ts";
import {
  checkVerbooProviderStatus,
  makePendingVerbooProvider,
  probeVerbooCapabilities,
} from "../Layers/VerbooProvider.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  makeManualOnlyProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";
import {
  makeVerbooCapabilitiesCacheKey,
  makeVerbooContinuationGroupKey,
  makeVerbooEnvironment,
  withVerbooBinaryDirOnPath,
} from "./VerbooHome.ts";
const decodeVerbooSettings = Schema.decodeSync(VerbooSettings);

const DRIVER_KIND = ProviderDriverKind.make("verboo");
const SNAPSHOT_REFRESH_INTERVAL = Duration.minutes(5);
const CAPABILITIES_PROBE_TTL = Duration.minutes(5);

const MAINTENANCE = makeManualOnlyProviderMaintenanceCapabilities({
  provider: DRIVER_KIND,
  packageName: null,
});

export type VerbooDriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path
  | ProviderEventLoggers
  | ServerConfig;

const withInstanceIdentity =
  (input: {
    readonly instanceId: ProviderInstance["instanceId"];
    readonly displayName: string | undefined;
    readonly accentColor: string | undefined;
    readonly continuationGroupKey: string;
  }) =>
  (snapshot: ServerProviderDraft): ServerProvider => ({
    ...snapshot,
    instanceId: input.instanceId,
    driver: DRIVER_KIND,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    continuation: { groupKey: input.continuationGroupKey },
  });

export const VerbooDriver: ProviderDriver<VerbooSettings, VerbooDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Verboo",
    supportsMultipleInstances: true,
  },
  configSchema: VerbooSettings,
  defaultConfig: (): VerbooSettings => decodeVerbooSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const httpClient = yield* HttpClient.HttpClient;
      const eventLoggers = yield* ProviderEventLoggers;
      const processEnv = withVerbooBinaryDirOnPath(
        mergeProviderInstanceEnvironment(environment),
        config.binaryPath,
      );
      const fallbackContinuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const effectiveConfig = { ...config, enabled } satisfies VerbooSettings;
      const maintenanceCapabilities = MAINTENANCE;
      const continuationGroupKey = yield* makeVerbooContinuationGroupKey(effectiveConfig);
      const stampIdentity = withInstanceIdentity({
        instanceId,
        displayName,
        accentColor,
        continuationGroupKey,
      });

      const adapterOptions = {
        instanceId,
        environment: processEnv,
        providerKind: DRIVER_KIND,
        makeEnvironment: makeVerbooEnvironment,
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
      };
      const adapter = yield* makeClaudeAdapter(effectiveConfig, adapterOptions);
      const textGeneration = yield* makeClaudeTextGeneration(effectiveConfig, processEnv, {
        makeEnvironment: makeVerbooEnvironment,
      });

      // Per-instance capabilities cache: keyed on binary + resolved HOME so
      // account/model probes never share metadata across instances.
      const capabilitiesProbeCache = yield* Cache.make({
        capacity: 1,
        timeToLive: CAPABILITIES_PROBE_TTL,
        lookup: () =>
          probeVerbooCapabilities(effectiveConfig, processEnv).pipe(
            Effect.provideService(Path.Path, path),
          ),
      });
      const capabilitiesCacheKey = yield* makeVerbooCapabilitiesCacheKey(effectiveConfig);

      const checkProvider = checkVerbooProviderStatus(
        effectiveConfig,
        () => Cache.get(capabilitiesProbeCache, capabilitiesCacheKey),
        processEnv,
      ).pipe(
        Effect.map(stampIdentity),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(Path.Path, path),
      );

      const snapshot = yield* makeManagedServerProvider<VerbooSettings>({
        maintenanceCapabilities,
        getSettings: Effect.succeed(effectiveConfig),
        streamSettings: Stream.never,
        haveSettingsChanged: () => false,
        initialSnapshot: (settings) =>
          makePendingVerbooProvider(settings).pipe(Effect.map(stampIdentity)),
        checkProvider,
        enrichSnapshot: ({ snapshot, publishSnapshot }) =>
          enrichProviderSnapshotWithVersionAdvisory(snapshot, maintenanceCapabilities).pipe(
            Effect.provideService(HttpClient.HttpClient, httpClient),
            Effect.flatMap((enrichedSnapshot) => publishSnapshot(enrichedSnapshot)),
          ),
        refreshInterval: SNAPSHOT_REFRESH_INTERVAL,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build Verboo snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity: {
          ...fallbackContinuationIdentity,
          continuationKey: continuationGroupKey,
        },
        displayName,
        accentColor,
        enabled,
        snapshot,
        adapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
