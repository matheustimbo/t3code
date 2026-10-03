// oxlint-disable t3code/namespace-node-imports, t3code/no-global-process-runtime -- Standalone Node SEA builder embeds a test-only preload and never starts the server Effect runtime.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [bundle, builder, output] = process.argv.slice(2);
assert(
  bundle && builder && output && [bundle, builder, output].every(path.isAbsolute),
  "Usage: node buildMainPoolFaultSea.mjs <absolute-production-standalone-bundle> <absolute-node-25.7+> <absolute-output>",
);
assert.notEqual(bundle, output);
assert.notEqual(builder, output);
const directory = await fs.mkdtemp(path.join(os.tmpdir(), "t3-main-pool-sea-build-"));
const original = await fs.readFile(bundle, "utf8");
const preload = fileURLToPath(new URL("./mainPoolFaultPreload.mjs", import.meta.url));
const hookSource = await fs.readFile(preload, "utf8");
// Embed the exact test hook so the SEA does not depend on external source files.
// Wrap it to avoid collisions with names emitted by the production bundler.
const prefix = `import * as testFaultFs from "node:fs/promises";\nimport testFaultPath from "node:path";\nimport testFaultNativeFs from "node:fs";\nimport { syncBuiltinESMExports as testFaultSyncExports } from "node:module";\nimport testFaultChildProcess from "node:child_process";\n{\n${hookSource
  .replace('import * as fs from "node:fs/promises";\n', "const fs = testFaultFs;\n")
  .replace('import path from "node:path";\n', "const path = testFaultPath;\n")
  .replace('import nativeFs from "node:fs";\n', "const nativeFs = testFaultNativeFs;\n")
  .replace(
    'import { syncBuiltinESMExports } from "node:module";\n',
    "const syncBuiltinESMExports = testFaultSyncExports;\n",
  )
  .replace(
    'import nativeChildProcess from "node:child_process";\n',
    "const nativeChildProcess = testFaultChildProcess;\n",
  )}\n}\n`;
const instrumented = original.startsWith("#!")
  ? original.replace(/^(#![^\n]*\n)/, `$1${prefix}`)
  : prefix + original;
const main = path.join(directory, "test-only-bin.mjs");
await fs.writeFile(main, instrumented);
const config = path.join(directory, "sea.json");
await fs.writeFile(
  config,
  JSON.stringify({
    main,
    mainFormat: "module",
    executable: builder,
    output,
    disableExperimentalSEAWarning: true,
    useCodeCache: false,
  }),
);
execFileSync(builder, ["--build-sea", config], { stdio: "inherit" });
if (process.platform === "darwin")
  execFileSync("/usr/bin/codesign", ["--sign", "-", "--force", output]);
await fs.chmod(output, 0o755);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
console.log(
  JSON.stringify(
    {
      testOnly: true,
      productionBundle: bundle,
      productionBundleSha256: sha256(original),
      testBundleSha256: sha256(instrumented),
      faultHookSha256: sha256(hookSource),
      output,
      directory,
    },
    null,
    2,
  ),
);
