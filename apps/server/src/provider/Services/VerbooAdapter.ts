/**
 * VerbooAdapter — shape type for the Verboo provider adapter.
 *
 * Verboo speaks the exact same protocol as the Claude Agent SDK, so its
 * adapter is constructed via {@link makeClaudeAdapter} parameterized with the
 * Verboo driver kind and environment. As with {@link ./ClaudeAdapter}, we only
 * retain the shape interface as a naming anchor for the driver bundle — the
 * adapter itself is captured per-instance as a closure inside
 * {@link ../Drivers/VerbooDriver}.
 *
 * @module VerbooAdapter
 */
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

/**
 * VerbooAdapterShape — per-instance Verboo adapter contract. Carries
 * a branded driver kind as the nominal discriminant.
 */
export interface VerbooAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {}
