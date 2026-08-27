import { describe, expect, it } from "vite-plus/test";

import {
  extractUniqueTicketReference,
  normalizeTicketThreadTitle,
  renderTicketThreadTitle,
} from "./ticketTitles.ts";

describe("extractUniqueTicketReference", () => {
  it.each([
    ["https://github.com/t3tools/t3code/issues/123", "github", "t3tools/t3code#123"],
    ["https://gitlab.com/acme/widgets/-/issues/42", "gitlab", "acme/widgets#42"],
    ["https://dev.azure.com/acme/widgets/_workitems/edit/77", "azure-devops", "acme/widgets#77"],
    ["https://bitbucket.org/acme/widgets/issues/8", "bitbucket", "acme/widgets#8"],
    ["https://acme.atlassian.net/browse/WEB-12", "jira", "WEB-12"],
    ["https://app.clickup.com/t/901/abc123", "clickup", "abc123"],
  ])("parses %s", (url, driver, identifier) => {
    expect(extractUniqueTicketReference(`Please fix ${url}.`)).toMatchObject({
      driver,
      identifier,
    });
  });

  it("deduplicates canonical references after removing query and fragments", () => {
    const reference = extractUniqueTicketReference(
      "https://github.com/acme/widgets/issues/12/?notification=1 https://github.com/acme/widgets/issues/12#issuecomment-1",
    );
    expect(reference?.identifier).toBe("acme/widgets#12");
  });

  it("returns no reference when distinct tickets are present", () => {
    expect(
      extractUniqueTicketReference(
        "https://github.com/acme/widgets/issues/12 https://acme.atlassian.net/browse/WEB-2",
      ),
    ).toBeUndefined();
  });

  it("ignores links in code and blockquotes", () => {
    expect(
      extractUniqueTicketReference(
        "`https://github.com/acme/widgets/issues/1`\n> https://github.com/acme/widgets/issues/2\nhttps://github.com/acme/widgets/issues/3",
      )?.identifier,
    ).toBe("acme/widgets#3");
  });

  it("uses configured hosts for self-hosted providers", () => {
    expect(
      extractUniqueTicketReference("http://git.internal/acme/widgets/-/issues/9", [
        { driver: "gitlab" as never, baseUrl: "http://git.internal" },
      ]),
    ).toMatchObject({ driver: "gitlab", identifier: "acme/widgets#9" });
  });

  it("removes a configured GitLab base path from the project identifier", () => {
    expect(
      extractUniqueTicketReference("https://tools.internal/gitlab/acme/widgets/-/issues/9", [
        { driver: "gitlab" as never, baseUrl: "https://tools.internal/gitlab" },
      ]),
    ).toMatchObject({ driver: "gitlab", identifier: "acme/widgets#9" });
  });

  it("parses Azure DevOps Server links relative to their collection URL", () => {
    expect(
      extractUniqueTicketReference(
        "https://devops.internal/tfs/DefaultCollection/Widgets/_workitems/edit/77",
        [
          {
            driver: "azure-devops" as never,
            baseUrl: "https://devops.internal/tfs/DefaultCollection",
          },
        ],
      ),
    ).toMatchObject({
      driver: "azure-devops",
      identifier: "DefaultCollection/Widgets#77",
      project: "DefaultCollection/Widgets",
    });
  });
});

describe("renderTicketThreadTitle", () => {
  const metadata = {
    title: "Fix reconnect failures",
    identifier: "acme/widgets#12",
    provider: "GitHub",
    project: "acme/widgets",
  };

  it("renders built-in and custom policies", () => {
    expect(renderTicketThreadTitle({ mode: "title", customTemplate: "" }, metadata)).toBe(
      "Fix reconnect failures",
    );
    expect(
      renderTicketThreadTitle({ mode: "identifier_title", customTemplate: "" }, metadata),
    ).toBe("acme/widgets#12 — Fix reconnect failures");
    expect(
      renderTicketThreadTitle(
        { mode: "custom", customTemplate: "[{provider}] {project}: {title}" },
        metadata,
      ),
    ).toBe("[GitHub] acme/widgets: Fix reconnect failures");
  });

  it("supports literal braces and rejects unknown variables", () => {
    expect(
      renderTicketThreadTitle(
        { mode: "custom", customTemplate: "{{{identifier}}} {title}" },
        metadata,
      ),
    ).toBe("{acme/widgets#12} Fix reconnect failures");
    expect(
      renderTicketThreadTitle({ mode: "custom", customTemplate: "{unknown}" }, metadata),
    ).toBeUndefined();
  });

  it("normalizes control characters and bounds output", () => {
    expect(normalizeTicketThreadTitle(`  First\n\tSecond ${"x".repeat(600)}`)).toHaveLength(512);
  });
});
