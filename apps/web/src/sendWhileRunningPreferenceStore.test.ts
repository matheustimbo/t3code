import { resolveSendWhileRunning } from "@t3tools/client-runtime/composer/send-while-running";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { useSendWhileRunningPreferenceStore } from "./sendWhileRunningPreferenceStore";

const interruptProvider = {
  instanceId: ProviderInstanceId.make("provider-1"),
  driver: ProviderDriverKind.make("claude"),
  displayName: "Claude Code",
  concurrentSend: "interrupt",
} as const;

describe("sendWhileRunningPreferenceStore", () => {
  beforeEach(() => useSendWhileRunningPreferenceStore.setState({ deliveryByBehavior: {} }));

  it("writes one behavior class without disturbing another", () => {
    const { setDelivery } = useSendWhileRunningPreferenceStore.getState();
    setDelivery("steer", "queued");
    setDelivery("interrupt", "now");

    expect(useSendWhileRunningPreferenceStore.getState().deliveryByBehavior).toEqual({
      steer: "queued",
      interrupt: "now",
    });

    setDelivery("steer", "now");

    expect(useSendWhileRunningPreferenceStore.getState().deliveryByBehavior).toEqual({
      steer: "now",
      interrupt: "now",
    });
  });

  it("omits an unset behavior class rather than storing an explicit undefined", () => {
    useSendWhileRunningPreferenceStore.getState().setDelivery("steer", "queued");
    const stored = useSendWhileRunningPreferenceStore.getState().deliveryByBehavior;

    expect(Object.keys(stored)).toEqual(["steer"]);
    expect("interrupt" in stored).toBe(false);
  });

  it("keeps the record referentially stable when a write changes nothing", () => {
    const { setDelivery } = useSendWhileRunningPreferenceStore.getState();
    setDelivery("interrupt", "queued");
    const first = useSendWhileRunningPreferenceStore.getState().deliveryByBehavior;

    setDelivery("interrupt", "queued");

    expect(useSendWhileRunningPreferenceStore.getState().deliveryByBehavior).toBe(first);
  });

  it("drives what resolveSendWhileRunning selects for that behavior class", () => {
    const read = () =>
      resolveSendWhileRunning({
        isRunning: true,
        provider: interruptProvider,
        preferences: useSendWhileRunningPreferenceStore.getState().deliveryByBehavior,
      });

    expect(read()?.selected.turnDelivery).toBe("queued");

    useSendWhileRunningPreferenceStore.getState().setDelivery("interrupt", "now");

    expect(read()?.selected.turnDelivery).toBe("now");
    expect(read()?.selected.label).toBe("Interrupt");
    expect(read()?.alternate?.turnDelivery).toBe("queued");
  });
});
