import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import type { ProviderConcurrentSend } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveOutboxTurnDelivery } from "./queued-turn-delivery";

const provider = (instanceId: string, concurrentSend: ProviderConcurrentSend) => ({
  instanceId: ProviderInstanceId.make(instanceId),
  driver: ProviderDriverKind.make("codex"),
  concurrentSend,
});

const thread = (status: "idle" | "running", providerInstanceId: string) => ({
  session: { status, providerInstanceId: ProviderInstanceId.make(providerInstanceId) },
  modelSelection: { instanceId: ProviderInstanceId.make(providerInstanceId) },
});

describe("outbox turn delivery", () => {
  it("omits the field for an idle thread so the payload is unchanged", () => {
    expect(
      resolveOutboxTurnDelivery({
        thread: thread("idle", "codex"),
        providers: [provider("codex", "provider-queue")],
        preferences: { "provider-queue": "queued" },
      }),
    ).toBe(null);
  });

  it("omits the field for a thread with no session at all", () => {
    expect(
      resolveOutboxTurnDelivery({
        thread: { session: null, modelSelection: { instanceId: ProviderInstanceId.make("codex") } },
        providers: [provider("codex", "provider-queue")],
        preferences: undefined,
      }),
    ).toBe(null);
  });

  it("takes the provider default while the agent works and nothing is stored", () => {
    const providers = [provider("codex", "provider-queue"), provider("claude", "steer")];
    expect(
      resolveOutboxTurnDelivery({
        thread: thread("running", "codex"),
        providers,
        preferences: undefined,
      }),
    ).toBe("queued");
    expect(
      resolveOutboxTurnDelivery({
        thread: thread("running", "claude"),
        providers,
        preferences: undefined,
      }),
    ).toBe(null);
  });

  it("takes the stored preference for the running provider's behavior class", () => {
    const providers = [provider("codex", "provider-queue"), provider("claude", "steer")];
    const preferences = { steer: "queued", "provider-queue": "now" } as const;
    expect(
      resolveOutboxTurnDelivery({ thread: thread("running", "claude"), providers, preferences }),
    ).toBe("queued");
    expect(
      resolveOutboxTurnDelivery({ thread: thread("running", "codex"), providers, preferences }),
    ).toBe(null);
  });

  it("reads the session's provider, not the draft's model selection", () => {
    expect(
      resolveOutboxTurnDelivery({
        thread: {
          session: {
            status: "running",
            providerInstanceId: ProviderInstanceId.make("claude"),
          },
          modelSelection: { instanceId: ProviderInstanceId.make("codex") },
        },
        providers: [provider("codex", "provider-queue"), provider("claude", "steer")],
        preferences: undefined,
      }),
    ).toBe(null);
  });

  it("omits the field when the provider refuses a concurrent send", () => {
    expect(
      resolveOutboxTurnDelivery({
        thread: thread("running", "cursor"),
        providers: [provider("cursor", "unsupported")],
        preferences: { unsupported: "queued" },
      }),
    ).toBe(null);
  });

  it("omits the field when the provider is not in the catalog", () => {
    expect(
      resolveOutboxTurnDelivery({
        thread: thread("running", "codex"),
        providers: [],
        preferences: { unknown: "queued" },
      }),
    ).toBe(null);
  });
});
