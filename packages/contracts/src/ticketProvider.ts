import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString, TrimmedString } from "./baseSchemas.ts";
import { ProviderInstanceEnvironment } from "./providerInstance.ts";

const TICKET_PROVIDER_SLUG_MAX_CHARS = 64;
const TICKET_PROVIDER_SLUG_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

const ticketProviderSlug = TrimmedNonEmptyString.check(
  Schema.isMaxLength(TICKET_PROVIDER_SLUG_MAX_CHARS),
  Schema.isPattern(TICKET_PROVIDER_SLUG_PATTERN),
);

export const TicketProviderDriverKind = ticketProviderSlug.pipe(
  Schema.brand("TicketProviderDriverKind"),
);
export type TicketProviderDriverKind = typeof TicketProviderDriverKind.Type;

export const TicketProviderInstanceId = ticketProviderSlug.pipe(
  Schema.brand("TicketProviderInstanceId"),
);
export type TicketProviderInstanceId = typeof TicketProviderInstanceId.Type;

export const TicketTitleMode = Schema.Literals(["disabled", "title", "identifier_title", "custom"]);
export type TicketTitleMode = typeof TicketTitleMode.Type;

export const DEFAULT_TICKET_TITLE_TEMPLATE = "{identifier} — {title}";
export const MAX_TICKET_THREAD_TITLE_CHARS = 512;

export const TicketTitlePolicy = Schema.Struct({
  mode: TicketTitleMode.pipe(
    Schema.withDecodingDefault(Effect.succeed("identifier_title" as const)),
  ),
  customTemplate: TrimmedString.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_TICKET_TITLE_TEMPLATE)),
  ),
});
export type TicketTitlePolicy = typeof TicketTitlePolicy.Type;

const TicketProviderBaseUrl = TrimmedNonEmptyString.check(
  Schema.makeFilter((value) => {
    try {
      const url = new URL(value);
      return (
        ((url.protocol === "https:" || url.protocol === "http:") &&
          url.username.length === 0 &&
          url.password.length === 0 &&
          url.search.length === 0 &&
          url.hash.length === 0 &&
          !value.includes("?") &&
          !value.includes("#")) ||
        "Ticket provider base URL must use HTTP or HTTPS and must not contain credentials, a query, or a fragment."
      );
    } catch {
      return "Ticket provider base URL must be a valid URL.";
    }
  }),
);

export const TicketProviderInstanceConfig = Schema.Struct({
  driver: TicketProviderDriverKind,
  displayName: Schema.optional(TrimmedNonEmptyString),
  baseUrl: TicketProviderBaseUrl,
  enabled: Schema.optionalKey(Schema.Boolean),
  isDefault: Schema.optionalKey(Schema.Boolean),
  environment: Schema.optionalKey(ProviderInstanceEnvironment),
  config: Schema.optionalKey(Schema.Unknown),
});
export type TicketProviderInstanceConfig = typeof TicketProviderInstanceConfig.Type;

export const TicketProviderInstanceConfigMap = Schema.Record(
  TicketProviderInstanceId,
  TicketProviderInstanceConfig,
);
export type TicketProviderInstanceConfigMap = typeof TicketProviderInstanceConfigMap.Type;

export const TicketProviderBinding = Schema.Struct({
  driver: TicketProviderDriverKind,
  host: TrimmedNonEmptyString,
  basePath: Schema.optional(TrimmedNonEmptyString),
  instanceId: TicketProviderInstanceId,
});
export type TicketProviderBinding = typeof TicketProviderBinding.Type;

export const TicketProviderBindings = Schema.Array(TicketProviderBinding);
export type TicketProviderBindings = typeof TicketProviderBindings.Type;

export const TicketProviderAvailability = Schema.Literals([
  "available",
  "unavailable",
  "unauthenticated",
  "unknown_driver",
]);
export type TicketProviderAvailability = typeof TicketProviderAvailability.Type;

export const TicketProviderProbeResult = Schema.Struct({
  instanceId: TicketProviderInstanceId,
  availability: TicketProviderAvailability,
  detail: Schema.optional(TrimmedNonEmptyString),
});
export type TicketProviderProbeResult = typeof TicketProviderProbeResult.Type;
