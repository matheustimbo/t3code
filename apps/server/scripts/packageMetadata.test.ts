import { assert, describe, it } from "@effect/vitest";

import { createServerReleasePackageManifest } from "./packageMetadata.ts";

describe("server release package metadata", () => {
  it("resolves workspace catalogs and keeps only releasable fields", () => {
    const manifest = createServerReleasePackageManifest({
      packageJson: {
        name: "t3",
        repository: {
          type: "git",
          url: "https://github.com/matheustimbo/t3code.git",
          directory: "apps/server",
        },
        bin: { t3: "./dist/bin.mjs" },
        type: "module",
        engines: { node: ">=24" },
        files: ["dist"],
        dependencies: {
          effect: "catalog:",
          "node-pty": "^1.1.0",
        },
      },
      version: "0.1.4",
      workspaceCatalog: { effect: "4.0.0-beta.103" },
      workspaceOverrides: { effect: "catalog:" },
    });

    assert.equal(manifest.version, "0.1.4");
    assert.equal(manifest.repository.url, "https://github.com/matheustimbo/t3code.git");
    assert.deepStrictEqual(manifest.dependencies, {
      effect: "4.0.0-beta.103",
      "node-pty": "^1.1.0",
    });
    assert.deepStrictEqual(manifest.overrides, { effect: "4.0.0-beta.103" });
    assert.notProperty(manifest, "devDependencies");
  });
});
