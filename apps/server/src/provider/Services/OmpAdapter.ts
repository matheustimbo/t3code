import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

/**
 * OmpAdapterShape — per-instance omp adapter contract. Carries
 * no extra surface today; the alias keeps instance wiring explicit.
 *
 * @module provider/Services/OmpAdapter
 */
export interface OmpAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {}
