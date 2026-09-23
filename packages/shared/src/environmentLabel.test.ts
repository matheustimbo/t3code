import { describe, expect, it } from "vite-plus/test";

import { environmentDisplayLabel } from "./environmentLabel.ts";

const presentation = (
  catalogLabel: string,
  serverConfig: {
    environment?: { label?: string };
    settings?: { environmentLabel?: string };
  } | null,
) => ({ entry: { target: { label: catalogLabel } }, serverConfig });

describe("environmentDisplayLabel", () => {
  it("prefers the name the machine's own settings carry", () => {
    expect(
      environmentDisplayLabel(
        presentation("rog-fedora", {
          environment: { label: "rog-fedora" },
          settings: { environmentLabel: "Fedora da sala" },
        }),
      ),
    ).toBe("Fedora da sala");
  });

  it("falls back to the descriptor when no name was set", () => {
    expect(
      environmentDisplayLabel(
        presentation("old-hostname", {
          environment: { label: "rog-fedora" },
          settings: { environmentLabel: "" },
        }),
      ),
    ).toBe("rog-fedora");
  });

  it("treats a blank name as no name", () => {
    expect(
      environmentDisplayLabel(
        presentation("old-hostname", {
          environment: { label: "rog-fedora" },
          settings: { environmentLabel: "   " },
        }),
      ),
    ).toBe("rog-fedora");
  });

  it("uses the label this client saved while the machine is unreachable", () => {
    expect(environmentDisplayLabel(presentation("rog-fedora", null))).toBe("rog-fedora");
  });
});
