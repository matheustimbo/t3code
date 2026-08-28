import { resolveCatalogDependencies } from "../../../scripts/lib/resolve-catalog.ts";

export interface ServerPackageManifestSource {
  readonly name: string;
  readonly repository: {
    readonly type: string;
    readonly url: string;
    readonly directory: string;
  };
  readonly bin: Record<string, string>;
  readonly type: string;
  readonly engines: Record<string, string>;
  readonly files: ReadonlyArray<string>;
  readonly dependencies: Record<string, string>;
}

export function createServerReleasePackageManifest(input: {
  readonly packageJson: ServerPackageManifestSource;
  readonly version: string;
  readonly workspaceCatalog: Record<string, string>;
  readonly workspaceOverrides: Record<string, string>;
}) {
  return {
    name: input.packageJson.name,
    repository: input.packageJson.repository,
    bin: input.packageJson.bin,
    type: input.packageJson.type,
    version: input.version,
    engines: input.packageJson.engines,
    files: input.packageJson.files,
    dependencies: resolveCatalogDependencies(
      input.packageJson.dependencies,
      input.workspaceCatalog,
      "apps/server",
    ),
    overrides: resolveCatalogDependencies(
      input.workspaceOverrides,
      input.workspaceCatalog,
      "apps/server",
    ),
  };
}
