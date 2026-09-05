import { describe, expect, it } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  resolveEnvironmentIdentificationPillLabel,
  resolveSidebarStageBackdropVariant,
  resolveSidebarStageFocusRingOffsetClass,
  shouldShowEnvironmentIdentificationPill,
  StageBackdropArt,
} from "./SidebarStageBackdrop";

describe("SidebarStageBackdrop", () => {
  it("resolves stage artwork only when enabled", () => {
    expect(resolveSidebarStageBackdropVariant("Dev")).toBe("dev");
    expect(resolveSidebarStageBackdropVariant("Nightly")).toBe("nightly");
    expect(resolveSidebarStageBackdropVariant("Dev", false)).toBeNull();
    expect(resolveSidebarStageBackdropVariant("Alpha")).toBeNull();
  });

  it("resolves supported environment pill labels", () => {
    expect(resolveEnvironmentIdentificationPillLabel("Dev")).toBe("Dev");
    expect(resolveEnvironmentIdentificationPillLabel(" fork ")).toBe("Fork");
    expect(resolveEnvironmentIdentificationPillLabel("nightly")).toBe("Nightly");
    expect(resolveEnvironmentIdentificationPillLabel("Fork", false)).toBeNull();
    expect(resolveEnvironmentIdentificationPillLabel("Latest")).toBeNull();
    expect(resolveEnvironmentIdentificationPillLabel("Alpha")).toBeNull();
  });

  it("falls back to a pill when a stage has no artwork", () => {
    expect(
      shouldShowEnvironmentIdentificationPill({ mode: "artwork", backdropVariant: null }),
    ).toBe(true);
    expect(
      shouldShowEnvironmentIdentificationPill({ mode: "artwork", backdropVariant: "nightly" }),
    ).toBe(false);
    expect(shouldShowEnvironmentIdentificationPill({ mode: "pill", backdropVariant: "dev" })).toBe(
      true,
    );
    expect(shouldShowEnvironmentIdentificationPill({ mode: "none", backdropVariant: null })).toBe(
      false,
    );
  });

  it("matches the focus-ring offset to each artwork palette", () => {
    expect(resolveSidebarStageFocusRingOffsetClass("nightly")).toBe(
      "focus-visible:ring-offset-(--stage-night-bottom)",
    );
    expect(resolveSidebarStageFocusRingOffsetClass("dev")).toBe(
      "focus-visible:ring-offset-(--stage-art-bottom)",
    );
  });

  it.each(["nightly", "dev"] as const)(
    "uses unique SVG definition ids when %s artwork is rendered more than once",
    (variant) => {
      const markup = renderToStaticMarkup(
        <>
          <StageBackdropArt variant={variant} />
          <StageBackdropArt variant={variant} />
        </>,
      );
      const ids = Array.from(markup.matchAll(/\sid="([^"]+)"/g), (match) => match[1]);

      expect(ids.length).toBeGreaterThan(0);
      expect(new Set(ids).size).toBe(ids.length);
    },
  );
});
