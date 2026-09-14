import { describe, expect, it } from "vite-plus/test";

import { forkServerCommand, T3CODE_DISTRIBUTION_URLS } from "./distribution.ts";

describe("fork distribution", () => {
  it("resolves every downloadable artifact from the fork", () => {
    expect(T3CODE_DISTRIBUTION_URLS.releases).toBe(
      "https://github.com/matheustimbo/t3code/releases",
    );
    expect(T3CODE_DISTRIBUTION_URLS.installScript).toBe(
      "https://raw.githubusercontent.com/matheustimbo/t3code/fork-main/scripts/install.sh",
    );
    expect(T3CODE_DISTRIBUTION_URLS.modelManifest).toBe(
      "https://raw.githubusercontent.com/matheustimbo/t3code/fork-main/apps/server/src/provider/model-manifest.json",
    );
  });

  it("builds an exact-version command that installs from the fork", () => {
    expect(forkServerCommand("0.1.2")).toBe(
      "curl -fsSL https://raw.githubusercontent.com/matheustimbo/t3code/fork-main/scripts/install.sh | T3CODE_VERSION=0.1.2 sh",
    );
  });

  it("rejects values that could change the copied shell command", () => {
    expect(() => forkServerCommand("0.1.2; echo unsafe")).toThrow(
      "A valid release version is required.",
    );
  });
});
