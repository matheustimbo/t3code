export const T3CODE_DISTRIBUTION = {
  githubRepository: "matheustimbo/t3code",
  releaseBranch: "fork-main",
} as const;

const githubRepositoryUrl = `https://github.com/${T3CODE_DISTRIBUTION.githubRepository}`;

export const T3CODE_DISTRIBUTION_URLS = {
  repository: githubRepositoryUrl,
  releases: `${githubRepositoryUrl}/releases`,
  releaseTags: `${githubRepositoryUrl}/releases/tag`,
  modelManifest: `https://raw.githubusercontent.com/${T3CODE_DISTRIBUTION.githubRepository}/${T3CODE_DISTRIBUTION.releaseBranch}/apps/server/src/provider/model-manifest.json`,
} as const;

function normalizedVersion(version: string): string {
  const value = version.trim();
  if (!value) {
    throw new Error("A release version is required.");
  }
  return value;
}

export function forkServerPackageSpec(version: string): string {
  const value = encodeURIComponent(normalizedVersion(version));
  return `${T3CODE_DISTRIBUTION_URLS.releases}/download/v${value}/t3-${value}.tgz`;
}

export function latestForkServerPackageSpec(): string {
  return `${T3CODE_DISTRIBUTION_URLS.releases}/latest/download/t3-latest.tgz`;
}

export function forkServerCommand(version: string, subcommand = ""): string {
  const suffix = subcommand.trim();
  return `npx --yes --package=${forkServerPackageSpec(version)} t3${suffix ? ` ${suffix}` : ""}`;
}

export function latestForkServerCommand(subcommand = ""): string {
  const suffix = subcommand.trim();
  return `npx --yes --package=${latestForkServerPackageSpec()} t3${suffix ? ` ${suffix}` : ""}`;
}
