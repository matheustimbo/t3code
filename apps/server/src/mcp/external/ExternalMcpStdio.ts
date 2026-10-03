import { ExternalMcpClientCall } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as CoreStdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import { ExternalMcpClientError } from "./ExternalMcpClient.ts";

const decode = Schema.decodeUnknownSync(Schema.fromJsonString(ExternalMcpClientCall));
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const input = Stream.unwrap(
  Effect.map(CoreStdio.Stdio, (stdio) =>
    Stream.suspend(() => {
      let pending = "";
      const decoder = new TextDecoder("utf8", { fatal: true });
      // The platform's cancellable byte stream lets signal cleanup finish while
      // stdin is idle; async-generator return() waits for its pending next() read.
      return Stream.concat(stdio.stdin, Stream.succeed(new TextEncoder().encode("\n"))).pipe(
        Stream.mapError(() => new ExternalMcpClientError({ code: "invalid_input" })),
        Stream.mapEffect((bytes) =>
          Effect.try({
            try: () => {
              pending += decoder.decode(bytes, { stream: true });
              const calls: ExternalMcpClientCall[] = [];
              while (pending.includes("\n")) {
                const index = pending.indexOf("\n");
                const line = pending.slice(0, index);
                pending = pending.slice(index + 1);
                if (Buffer.byteLength(line) > 131072) throw new Error("oversized input");
                if (line.trim()) calls.push(decode(line, { onExcessProperty: "error" }));
              }
              if (Buffer.byteLength(pending) > 131072) throw new Error("oversized input");
              return calls;
            },
            catch: () => new ExternalMcpClientError({ code: "invalid_input" }),
          }),
        ),
        Stream.flatMap((calls) => Stream.fromIterable(calls)),
      );
    }),
  ),
);
/** Injectable external stdio boundary; stdout contains JSON only, never credentials. */
export class ExternalMcpStdio extends Context.Reference<{
  readonly input: Stream.Stream<ExternalMcpClientCall, ExternalMcpClientError, CoreStdio.Stdio>;
  readonly write: (value: unknown) => ReturnType<typeof Console.log>;
}>("t3/mcp/external/ExternalMcpStdio", {
  defaultValue: () => ({ input, write: (value) => Console.log(encode(value)) }),
}) {}
