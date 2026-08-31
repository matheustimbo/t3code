import { assert, it } from "@effect/vitest";

import { detectCliRunner, formatCliCommand, suggestedPackageSpec } from "./invocation.ts";

it("detects package runners from their cache entry paths", () => {
  assert.equal(detectCliRunner("/home/theo/.npm/_npx/abc123/node_modules/t3/dist/bin.mjs"), "npx");
  assert.equal(
    detectCliRunner(
      "C:\\Users\\theo\\AppData\\Local\\npm-cache\\_npx\\abc\\node_modules\\t3\\dist\\bin.mjs",
    ),
    "npx",
  );
  assert.equal(
    detectCliRunner("/home/theo/.cache/pnpm/dlx/abc/node_modules/t3/dist/bin.mjs"),
    "pnpm dlx",
  );
  assert.equal(
    detectCliRunner("/home/theo/.local/share/pnpm/.pnpm/dlx/abc/node_modules/t3/dist/bin.mjs"),
    "pnpm dlx",
  );
  assert.equal(
    detectCliRunner(
      "C:\\Users\\theo\\AppData\\Local\\pnpm-cache\\dlx\\abc\\node_modules\\t3\\dist\\bin.mjs",
    ),
    "pnpm dlx",
  );
  assert.equal(detectCliRunner("/home/theo/.bun/install/cache/t3@0.0.31/dist/bin.mjs"), "bunx");
  assert.equal(detectCliRunner("/tmp/bunx-1000-t3@latest/node_modules/t3/dist/bin.mjs"), "bunx");
  assert.equal(
    detectCliRunner(
      "C:\\Users\\theo\\AppData\\Local\\Temp\\bunx-0-t3@latest\\node_modules\\t3\\dist\\bin.mjs",
    ),
    "bunx",
  );
});

it("treats stable installs as direct invocations", () => {
  assert.isNull(detectCliRunner("/usr/local/lib/node_modules/t3/dist/bin.mjs"));
  assert.isNull(detectCliRunner("/home/theo/Code/work/t3code/apps/server/dist/bin.mjs"));
  assert.isNull(detectCliRunner("/home/theo/.t3/runtime/0.0.31/node_modules/t3/dist/bin.mjs"));
  assert.isNull(detectCliRunner(""));
});

it("re-suggests the exact fork release package", () => {
  assert.equal(
    suggestedPackageSpec("0.0.31-nightly.20260729"),
    "https://github.com/matheustimbo/t3code/releases/download/v0.0.31-nightly.20260729/t3-0.0.31-nightly.20260729.tgz",
  );
  assert.equal(
    suggestedPackageSpec("0.0.31"),
    "https://github.com/matheustimbo/t3code/releases/download/v0.0.31/t3-0.0.31.tgz",
  );
});

it("formats serve suggestions to match the launching command", () => {
  assert.equal(
    formatCliCommand({
      subcommand: "serve",
      entryPath: "/home/theo/.npm/_npx/abc/node_modules/t3/dist/bin.mjs",
      version: "0.0.31-nightly.20260729",
    }),
    "npx --yes --package=https://github.com/matheustimbo/t3code/releases/download/v0.0.31-nightly.20260729/t3-0.0.31-nightly.20260729.tgz t3 serve",
  );
  assert.equal(
    formatCliCommand({
      subcommand: "serve",
      entryPath: "/tmp/bunx-1000-t3@latest/node_modules/t3/dist/bin.mjs",
      version: "0.0.31",
    }),
    "bunx https://github.com/matheustimbo/t3code/releases/download/v0.0.31/t3-0.0.31.tgz serve",
  );
  assert.equal(
    formatCliCommand({
      subcommand: "serve",
      entryPath: "/usr/local/lib/node_modules/t3/dist/bin.mjs",
      version: "0.0.31-nightly.20260729",
    }),
    "t3 serve",
  );
});
