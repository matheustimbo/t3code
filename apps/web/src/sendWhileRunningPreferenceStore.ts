/**
 * What the user last chose to do when sending into a turn that is already
 * running, keyed by the provider's BEHAVIOR CLASS rather than by provider, so a
 * preference learned once applies everywhere it means the same thing.
 *
 * An absent key is not "now" — it means the user never expressed a preference,
 * so `resolveSendWhileRunning` gets to pick the default for that class. That is
 * why this never stores an explicit `undefined`.
 */
import type {
  SendWhileRunningDelivery,
  SendWhileRunningPreferences,
} from "@t3tools/client-runtime/composer/send-while-running";
import type { TurnDelivery } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";

export const SEND_WHILE_RUNNING_PREFERENCE_STORAGE_KEY = "t3code:send-while-running-delivery:v1";

interface SendWhileRunningPreferenceState {
  /**
   * Handed straight to `resolveSendWhileRunning`, which memoizes on it, so it
   * has to stay referentially stable while unchanged. Select this field itself
   * rather than rebuilding a record from the store.
   */
  deliveryByBehavior: SendWhileRunningPreferences;
  setDelivery: (behavior: SendWhileRunningDelivery, delivery: TurnDelivery) => void;
}

export const useSendWhileRunningPreferenceStore = create<SendWhileRunningPreferenceState>()(
  persist(
    (set) => ({
      deliveryByBehavior: {},
      setDelivery: (behavior, delivery) =>
        set((state) =>
          state.deliveryByBehavior[behavior] === delivery
            ? state
            : { deliveryByBehavior: { ...state.deliveryByBehavior, [behavior]: delivery } },
        ),
    }),
    {
      name: SEND_WHILE_RUNNING_PREFERENCE_STORAGE_KEY,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ deliveryByBehavior: state.deliveryByBehavior }),
    },
  ),
);
