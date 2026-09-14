export const T3CODE_DISTRIBUTION = {
  githubRepository: "matheustimbo/t3code",
  releaseBranch: "fork-main",
} as const;

const githubRepositoryUrl = `https://github.com/${T3CODE_DISTRIBUTION.githubRepository}`;

export const T3CODE_DISTRIBUTION_URLS = {
  repository: githubRepositoryUrl,
  releases: `${githubRepositoryUrl}/releases`,
  releaseTags: `${githubRepositoryUrl}/releases/tag`,
  installScript: `https://raw.githubusercontent.com/${T3CODE_DISTRIBUTION.githubRepository}/${T3CODE_DISTRIBUTION.releaseBranch}/scripts/install.sh`,
  modelManifest: `https://raw.githubusercontent.com/${T3CODE_DISTRIBUTION.githubRepository}/${T3CODE_DISTRIBUTION.releaseBranch}/apps/server/src/provider/model-manifest.json`,
} as const;

function normalizedVersion(version: string): string {
  const value = version.trim();
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value)) {
    throw new Error("A valid release version is required.");
  }
  return value;
}

export function forkServerCommand(version: string): string {
  return `curl -fsSL ${T3CODE_DISTRIBUTION_URLS.installScript} | T3CODE_VERSION=${normalizedVersion(version)} sh`;
}
