// @effect-diagnostics nodeBuiltinImport:off - This process deliberately has an independent libuv pool.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { isPublishingRequest, PUBLISHING_SECRET_NAMES } from "./publishingObserverProtocol.ts";

const MAX_SECRET_BYTES = 64 * 1_024;

async function readSecret(directory: string, name: (typeof PUBLISHING_SECRET_NAMES)[number]) {
  const file = await NodeFSP.open(NodePath.join(directory, `${name}.bin`), "r");
  try {
    const bytes = Buffer.alloc(MAX_SECRET_BYTES + 1);
    let size = 0;
    while (size < bytes.length) {
      const result = await file.read(bytes, size, bytes.length - size, null);
      if (result.bytesRead === 0) break;
      size += result.bytesRead;
    }
    if (size > MAX_SECRET_BYTES) return null;
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size));
  } finally {
    await file.close();
  }
}

/** Hidden CLI entry: authority is fixed at bootstrap; requests cannot choose files. */
export function runPublishingObserver(directory: string | undefined): void {
  if (!directory || !NodePath.isAbsolute(directory) || !process.send) {
    process.exitCode = 1;
    return;
  }
  let busy = false;
  // process.exit() can join libuv workers that are blocked in native NodeFSP.open().
  // On parent death, terminate this exact helper without running Node teardown.
  process.on("disconnect", () => process.kill(process.pid, "SIGKILL"));
  process.on("message", (request: unknown) => {
    if (!isPublishingRequest(request) || busy) {
      process.exit(1);
      return;
    }
    busy = true;
    void Promise.allSettled(PUBLISHING_SECRET_NAMES.map((name) => readSecret(directory, name)))
      .then((results) => {
        const [enabled, url, credential] = results.map((result) =>
          result.status === "fulfilled" ? result.value : null,
        );
        return enabled === "true" && !!url && !!credential;
      })
      .catch(() => false)
      .then((active) => {
        busy = false;
        if (process.connected) {
          process.send?.({ id: request.id, active }, (error) => {
            if (error) process.exit(1);
          });
        }
      });
  });
  process.send({ kind: "ready" }, (error) => {
    if (error) process.exit(1);
  });
}
