export const PUBLISHING_SECRET_NAMES = [
  "cloud-publish-agent-activity",
  "cloud-relay-url",
  "cloud-relay-environment-credential",
] as const;

export const OBSERVATION_DEADLINE_MS = 1_000;

export interface PublishingObserveRequest {
  readonly kind: "observe-publishing";
  readonly id: number;
}
export interface PublishingObserveResult {
  readonly id: number;
  readonly active: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isId = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

export const isPublishingRequest = (value: unknown): value is PublishingObserveRequest =>
  isRecord(value) &&
  Object.keys(value).length === 2 &&
  value.kind === "observe-publishing" &&
  isId(value.id);
export const isPublishingResult = (value: unknown): value is PublishingObserveResult =>
  isRecord(value) &&
  Object.keys(value).length === 2 &&
  isId(value.id) &&
  typeof value.active === "boolean";
export const isPublishingReady = (value: unknown): boolean =>
  isRecord(value) && Object.keys(value).length === 1 && value.kind === "ready";
