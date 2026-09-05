import { assert, it } from "@effect/vitest";

import { formatCliCommand, suggestedPackageSpec } from "./invocation.ts";

// The fork ships release tarballs rather than a registry package, so every
// runner suggestion carries the full download URL for the running version.
const SPEC = "https://github.com/matheustimbo/t3code/releases/download/v0.0.31/t3-0.0.31.tgz";

it("formats package runner commands from their cache entry paths", () => {
  for (const [entryPath, expected] of [
    [
      "/home/theo/.npm/_npx/abc123/node_modules/t3/dist/bin.mjs",
      `npx --yes --package=${SPEC} t3 serve`,
    ],
    [
      "C:\\Users\\theo\\AppData\\Local\\npm-cache\\_npx\\abc\\node_modules\\t3\\dist\\bin.mjs",
      `npx --yes --package=${SPEC} t3 serve`,
    ],
    ["/home/theo/.cache/pnpm/dlx/abc/node_modules/t3/dist/bin.mjs", `pnpm dlx ${SPEC} serve`],
    [
      "/home/theo/.local/share/pnpm/.pnpm/dlx/abc/node_modules/t3/dist/bin.mjs",
      `pnpm dlx ${SPEC} serve`,
    ],
    [
      "C:\\Users\\theo\\AppData\\Local\\pnpm-cache\\dlx\\abc\\node_modules\\t3\\dist\\bin.mjs",
      `pnpm dlx ${SPEC} serve`,
    ],
    ["/home/theo/.bun/install/cache/t3@0.0.31/dist/bin.mjs", `bunx ${SPEC} serve`],
    ["/tmp/bunx-1000-t3@latest/node_modules/t3/dist/bin.mjs", `bunx ${SPEC} serve`],
    [
      "C:\\Users\\theo\\AppData\\Local\\Temp\\bunx-0-t3@latest\\node_modules\\t3\\dist\\bin.mjs",
      `bunx ${SPEC} serve`,
    ],
  ] as const) {
    assert.equal(formatCliCommand({ subcommand: "serve", entryPath, version: "0.0.31" }), expected);
  }
});

it("treats stable installs as direct invocations", () => {
  for (const entryPath of [
    "/usr/local/lib/node_modules/t3/dist/bin.mjs",
    "/home/theo/Code/work/t3code/apps/server/dist/bin.mjs",
    "/home/theo/.t3/runtime/0.0.31/node_modules/t3/dist/bin.mjs",
    "",
  ]) {
    assert.equal(
      formatCliCommand({ subcommand: "serve", entryPath, version: "0.0.31" }),
      "t3 serve",
    );
  }
});

it("re-suggests the exact fork release package", () => {
  assert.equal(
    suggestedPackageSpec("0.0.31-nightly.20260729"),
    "https://github.com/matheustimbo/t3code/releases/download/v0.0.31-nightly.20260729/t3-0.0.31-nightly.20260729.tgz",
  );
  assert.equal(suggestedPackageSpec("0.0.31"), SPEC);
});
