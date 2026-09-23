import type { ServerConfig } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveEnvironmentRenameLock } from "./EnvironmentRenameDialog";

const config = (environmentRename: boolean | undefined) =>
  ({
    environment: { capabilities: environmentRename === undefined ? {} : { environmentRename } },
  }) as unknown as ServerConfig;

describe("resolveEnvironmentRenameLock", () => {
  it("locks until the environment is connected", () => {
    expect(resolveEnvironmentRenameLock({ serverConfig: null, operateAccess: "granted" })).toMatch(
      /Connect/,
    );
  });

  it("locks on servers that predate the setting, before looking at permissions", () => {
    expect(
      resolveEnvironmentRenameLock({ serverConfig: config(undefined), operateAccess: "denied" }),
    ).toMatch(/too old/);
  });

  it("locks when the session cannot operate the environment", () => {
    expect(
      resolveEnvironmentRenameLock({ serverConfig: config(true), operateAccess: "denied" }),
    ).toMatch(/cannot change/);
  });

  it("stays open while access is still resolving so a slow session does not flicker", () => {
    expect(
      resolveEnvironmentRenameLock({ serverConfig: config(true), operateAccess: "pending" }),
    ).toBeNull();
    expect(
      resolveEnvironmentRenameLock({ serverConfig: config(true), operateAccess: "granted" }),
    ).toBeNull();
  });
});
