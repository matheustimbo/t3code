import { describe, expect, it } from "vite-plus/test";

import {
  forkServerCommand,
  forkServerPackageSpec,
  latestForkServerCommand,
  latestForkServerPackageSpec,
  T3CODE_DISTRIBUTION_URLS,
} from "./distribution.ts";

describe("fork distribution", () => {
  it("resolves every downloadable artifact from the fork", () => {
    expect(T3CODE_DISTRIBUTION_URLS.releases).toBe(
      "https://github.com/matheustimbo/t3code/releases",
    );
    expect(forkServerPackageSpec("0.1.2")).toBe(
      "https://github.com/matheustimbo/t3code/releases/download/v0.1.2/t3-0.1.2.tgz",
    );
    expect(latestForkServerPackageSpec()).toBe(
      "https://github.com/matheustimbo/t3code/releases/latest/download/t3-latest.tgz",
    );
    expect(T3CODE_DISTRIBUTION_URLS.modelManifest).toBe(
      "https://raw.githubusercontent.com/matheustimbo/t3code/fork-main/apps/server/src/provider/model-manifest.json",
    );
  });

  it("builds commands that cannot fall back to the public t3 package", () => {
    expect(forkServerCommand("0.1.2")).toBe(
      "npx --yes --package=https://github.com/matheustimbo/t3code/releases/download/v0.1.2/t3-0.1.2.tgz t3",
    );
    expect(latestForkServerCommand("service update")).toBe(
      "npx --yes --package=https://github.com/matheustimbo/t3code/releases/latest/download/t3-latest.tgz t3 service update",
    );
  });
});
