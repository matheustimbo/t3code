import * as NodeAssert from "node:assert/strict";

import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import { describe, it, vi } from "vite-plus/test";

function byteChunks(source: string, cuts: readonly number[]): ReadonlyArray<Uint8Array> {
  const encoded = new TextEncoder().encode(source);
  const boundaries = [...cuts, encoded.byteLength].toSorted((left, right) => left - right);
  let offset = 0;

  return boundaries.map((boundary) => {
    const chunk = encoded.slice(offset, boundary);
    offset = boundary;
    return chunk;
  });
}

function subscribe(
  chunks: ReadonlyArray<Uint8Array>,
  options?: { readonly onSseEvent?: (event: { readonly data: unknown }) => void },
) {
  const client = createOpencodeClient({
    baseUrl: "http://opencode.test",
    fetch: async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (const chunk of chunks) {
              controller.enqueue(chunk);
            }
            controller.close();
          },
        }),
      ),
  });

  return client.event.subscribe(undefined, options);
}

describe("OpenCode SDK SSE parser", () => {
  it("keeps CRLF split across chunks, multiline data, and UTF-8 event payloads intact", async () => {
    const source =
      'event: message\r\nid: 42\r\nretry: 7\r\ndata: {"text":"olá 👋"}\r\ndata: {"more":true}\r\n\r\n';
    const encoded = new TextEncoder().encode(source);
    const carriageReturns = [...encoded.entries()]
      .filter(([, byte]) => byte === "\r".charCodeAt(0))
      .map(([index]) => index + 1);
    const emoji = new TextEncoder().encode("👋");
    const emojiStart = encoded.findIndex((_, index) =>
      emoji.every((byte, emojiIndex) => encoded[index + emojiIndex] === byte),
    );
    const streamedEvents: unknown[] = [];

    const { stream } = await subscribe(byteChunks(source, [...carriageReturns, emojiStart + 2]), {
      onSseEvent: (event) => streamedEvents.push(event),
    });

    const received = [];
    for await (const event of stream) {
      received.push(event);
    }

    NodeAssert.deepEqual(received, ['{"text":"olá 👋"}\n{"more":true}']);
    NodeAssert.deepEqual(streamedEvents, [
      {
        data: '{"text":"olá 👋"}\n{"more":true}',
        event: "message",
        id: "42",
        retry: 7,
      },
    ]);
  });

  it("keeps framing work bounded by each fragment while an event is still incomplete", async () => {
    const dataLines = Array.from(
      { length: 512 },
      (_, index) => `data: ${JSON.stringify({ index, payload: "x".repeat(1024) })}`,
    );
    const source = `${dataLines.join("\r\n")}\r\n\r\n`;
    const chunks = byteChunks(
      source,
      Array.from({ length: 512 }, (_, index) => (index + 1) * 1024),
    );
    const originalReplace = String.prototype.replace;
    const originalSplit = String.prototype.split;
    let normalizedCharacters = 0;
    let delimiterCharacters = 0;

    const replaceSpy = vi.spyOn(String.prototype, "replace").mockImplementation(function (
      this: string,
      searchValue: unknown,
      replaceValue: unknown,
    ) {
      if (
        searchValue instanceof RegExp &&
        (searchValue.source === "\\r\\n" || searchValue.source === "\\r")
      ) {
        normalizedCharacters += this.length;
      }
      return Reflect.apply(originalReplace, this, [searchValue, replaceValue]) as string;
    } as typeof String.prototype.replace);
    const splitSpy = vi.spyOn(String.prototype, "split").mockImplementation(function (
      this: string,
      separator: unknown,
      limit?: number,
    ) {
      if (separator === "\n\n") {
        delimiterCharacters += this.length;
      }
      return Reflect.apply(originalSplit, this, [separator, limit]) as string[];
    } as typeof String.prototype.split);

    try {
      const { stream } = await subscribe(chunks);
      const received = [];
      for await (const event of stream) {
        received.push(event);
      }

      NodeAssert.deepEqual(received, [
        dataLines.map((line) => line.slice("data: ".length)).join("\n"),
      ]);
    } finally {
      replaceSpy.mockRestore();
      splitSpy.mockRestore();
    }

    NodeAssert.ok(
      normalizedCharacters + delimiterCharacters <= source.length * 2,
      `SSE framing scanned ${normalizedCharacters + delimiterCharacters} characters for a ${source.length}-character event`,
    );
  });

  it("retries after an error without losing event metadata", async () => {
    const errors: unknown[] = [];
    const metadata: unknown[] = [];
    let disconnect: (() => void) | undefined;
    let attempts = 0;
    const client = createOpencodeClient({
      baseUrl: "http://opencode.test",
      fetch: async () => {
        attempts++;
        if (attempts === 1) {
          return new Response(
            new ReadableStream({
              start: (controller) => {
                controller.enqueue(
                  new TextEncoder().encode('id: 42\nretry: 7\ndata: {"connected":true}\n\n'),
                );
                disconnect = () => controller.error(new Error("connection lost"));
              },
            }),
          );
        }
        return new Response(new ReadableStream({ start: (controller) => controller.close() }));
      },
    });
    const { stream } = await client.event.subscribe(undefined, {
      onSseError: (error) => errors.push(error),
      onSseEvent: (event) => {
        metadata.push(event);
        disconnect?.();
      },
      sseDefaultRetryDelay: 0,
      sseMaxRetryAttempts: 2,
    });

    const received = [];
    for await (const event of stream) {
      received.push(event);
    }

    NodeAssert.equal(attempts, 2);
    NodeAssert.equal(errors.length, 1);
    NodeAssert.match((errors[0] as Error).message, /connection lost/);
    NodeAssert.deepEqual(received, [{ connected: true }]);
    NodeAssert.deepEqual(metadata, [
      { data: { connected: true }, event: undefined, id: "42", retry: 7 },
    ]);
  });

  it("yields a completed event before a later callback error in the same chunk", async () => {
    const errors: unknown[] = [];
    const client = createOpencodeClient({
      baseUrl: "http://opencode.test",
      fetch: async () =>
        new Response(
          new ReadableStream({
            start: (controller) => {
              controller.enqueue(
                new TextEncoder().encode('data: {"first":true}\n\ndata: {"second":true}\n\n'),
              );
              controller.close();
            },
          }),
        ),
    });
    const { stream } = await client.event.subscribe(undefined, {
      onSseEvent: ({ data }) => {
        if ((data as { readonly second?: boolean }).second) {
          throw new Error("second event callback failed");
        }
      },
      onSseError: (error) => errors.push(error),
      sseMaxRetryAttempts: 1,
    });

    NodeAssert.deepEqual(await stream.next(), { done: false, value: { first: true } });
    NodeAssert.deepEqual(await stream.next(), { done: true, value: undefined });
    NodeAssert.match((errors[0] as Error).message, /second event callback failed/);
  });

  it("does not dispatch a pending CR-delimited event after abort", async () => {
    const abortController = new AbortController();
    const client = createOpencodeClient({
      baseUrl: "http://opencode.test",
      fetch: async () =>
        new Response(
          new ReadableStream({
            start: (controller) => {
              controller.enqueue(
                new TextEncoder().encode('data: {"first":true}\n\ndata: {"partial":true}\r'),
              );
            },
          }),
        ),
    });
    const { stream } = await client.event.subscribe(undefined, {
      signal: abortController.signal,
      sseMaxRetryAttempts: 1,
    });

    NodeAssert.deepEqual(await stream.next(), { done: false, value: { first: true } });
    abortController.abort();
    NodeAssert.deepEqual(await stream.next(), { done: true, value: undefined });
  });

  it("dispatches a CR-delimited event without waiting for another chunk", async () => {
    const client = createOpencodeClient({
      baseUrl: "http://opencode.test",
      fetch: async () =>
        new Response(
          new ReadableStream({
            start: (controller) => {
              controller.enqueue(new TextEncoder().encode('data: {"event":"delivered"}\r\r'));
            },
          }),
        ),
    });
    const { stream } = await client.event.subscribe();

    NodeAssert.deepEqual(await stream.next(), { done: false, value: { event: "delivered" } });
    await stream.return(undefined);
  });
});
