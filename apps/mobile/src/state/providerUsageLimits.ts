import { useAtomValue } from "@effect/atom-react";
import { collectProviderUsageLimits } from "@t3tools/client-runtime/providerUsageLimits";
import { Atom } from "effect/unstable/reactivity";

import { environmentPresentations } from "./presentation";
import { serverEnvironment } from "./server";

const providerUsageLimitsAtom = Atom.make((get) => {
  const presentations = get(environmentPresentations.presentationsAtom);
  return collectProviderUsageLimits(
    [...presentations].map(([environmentId, presentation]) => ({
      environmentId,
      label: presentation.entry.target.label,
      providers: get(serverEnvironment.configValueAtom(environmentId))?.providers ?? [],
    })),
  );
}).pipe(Atom.withLabel("mobile-provider-usage-limits"));

export function useProviderUsageLimits() {
  return useAtomValue(providerUsageLimitsAtom);
}
