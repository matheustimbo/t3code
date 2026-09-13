import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type {
  SendWhileRunningDelivery,
  SendWhileRunningPreferences,
} from "@t3tools/client-runtime/composer/send-while-running";
import type { TurnDelivery } from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback } from "react";

import { appAtomRegistry } from "./atom-registry";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "./preferences";

/**
 * What the user last chose for a send made while the agent is working. The
 * stored object goes straight to `resolveSendWhileRunning`, which memoizes on
 * it, so both readers below hand back the persisted reference itself and
 * `undefined` when nothing is stored. Building a fresh object per render, or
 * substituting an empty one for "nothing stored", would defeat that memo.
 */
/**
 * Picking a delivery also sends, in one gesture, and the drain reads the
 * preference back to decide that send. The persisted patch is scheduled rather
 * than applied inline, so the pick is held here too and the drain sees it on
 * the same tick. Both hold the same value once the write lands, and only this
 * module writes the preference, so the local copy cannot go stale.
 */
let lastPicked: SendWhileRunningPreferences | undefined;

/** For the outbox drain, which runs outside React. Components use the hook. */
export function readSendWhileRunningPreferences(): SendWhileRunningPreferences | undefined {
  if (lastPicked) return lastPicked;
  const preferences = appAtomRegistry.get(mobilePreferencesAtom);
  return AsyncResult.isSuccess(preferences)
    ? preferences.value.sendWhileRunningDelivery
    : undefined;
}

export function useSendWhileRunningPreferences(): {
  readonly preferences: SendWhileRunningPreferences | undefined;
  readonly remember: (behavior: SendWhileRunningDelivery, delivery: TurnDelivery) => void;
} {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const preferences = AsyncResult.isSuccess(preferencesResult)
    ? preferencesResult.value.sendWhileRunningDelivery
    : undefined;

  const remember = useCallback(
    (behavior: SendWhileRunningDelivery, delivery: TurnDelivery) => {
      const current = readSendWhileRunningPreferences();
      if (current?.[behavior] === delivery) return;
      const next: SendWhileRunningPreferences = { ...current, [behavior]: delivery };
      lastPicked = next;
      savePreferences({ sendWhileRunningDelivery: next });
    },
    [savePreferences],
  );

  return { preferences, remember };
}
