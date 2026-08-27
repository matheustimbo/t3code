import {
  DEFAULT_TICKET_TITLE_TEMPLATE,
  MAX_TICKET_THREAD_TITLE_CHARS,
  type TicketProviderDriverKind,
  type TicketTitlePolicy,
} from "@t3tools/contracts";

export interface TicketReference {
  readonly driver: TicketProviderDriverKind;
  readonly host: string;
  readonly url: string;
  readonly identifier: string;
  readonly project: string;
  readonly resourceId: string;
}

export interface TicketTitleMetadata {
  readonly title: string;
  readonly identifier: string;
  readonly provider: string;
  readonly project: string;
}

const BUILT_IN_HOST_DRIVERS = new Map<string, string>([
  ["github.com", "github"],
  ["gitlab.com", "gitlab"],
  ["dev.azure.com", "azure-devops"],
  ["bitbucket.org", "bitbucket"],
  ["app.clickup.com", "clickup"],
]);

const URL_PATTERN = /https?:\/\/[^\s<>"']+/giu;
const TRAILING_URL_PUNCTUATION = /[),.;!?\]}]+$/u;

function stripInlineCode(line: string): string {
  let result = "";
  let cursor = 0;
  while (cursor < line.length) {
    if (line[cursor] !== "`") {
      result += line[cursor];
      cursor += 1;
      continue;
    }
    let markerEnd = cursor + 1;
    while (line[markerEnd] === "`") markerEnd += 1;
    const marker = line.slice(cursor, markerEnd);
    const closing = line.indexOf(marker, markerEnd);
    if (closing === -1) {
      result += marker;
      cursor = markerEnd;
      continue;
    }
    result += " ";
    cursor = closing + marker.length;
  }
  return result;
}

function stripIgnoredMarkdown(message: string): string {
  const visible: string[] = [];
  let fence: { readonly marker: "`" | "~"; readonly length: number } | undefined;
  for (const line of message.split(/\r?\n/u)) {
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/u.exec(line);
    if (fence) {
      if (
        fenceMatch &&
        fenceMatch[1]![0] === fence.marker &&
        fenceMatch[1]!.length >= fence.length
      ) {
        fence = undefined;
      }
      visible.push(" ");
      continue;
    }
    if (fenceMatch) {
      fence = {
        marker: fenceMatch[1]![0] as "`" | "~",
        length: fenceMatch[1]!.length,
      };
      visible.push(" ");
      continue;
    }
    if (/^(?: {4}|\t)/u.test(line) || /^\s{0,3}>/u.test(line)) {
      visible.push(" ");
      continue;
    }
    visible.push(stripInlineCode(line));
  }
  return visible.join("\n");
}

function normalizedUrl(raw: string): URL | undefined {
  try {
    const url = new URL(raw.replace(TRAILING_URL_PUNCTUATION, ""));
    url.hash = "";
    url.search = "";
    if (url.pathname !== "/") {
      url.pathname = url.pathname.replace(/\/+$/u, "");
    }
    return url;
  } catch {
    return undefined;
  }
}

function configuredDriverForUrl(
  url: URL,
  configuredBaseUrls: ReadonlyArray<{
    readonly driver: TicketProviderDriverKind;
    readonly baseUrl: string;
  }>,
): { readonly driver: TicketProviderDriverKind; readonly basePath: string } | undefined {
  const matching = configuredBaseUrls
    .flatMap((entry) => {
      const base = normalizedUrl(entry.baseUrl);
      if (!base || base.host !== url.host) return [];
      const basePath = base.pathname.replace(/\/$/u, "");
      if (basePath && !url.pathname.startsWith(`${basePath}/`) && url.pathname !== basePath) {
        return [];
      }
      return [{ ...entry, basePath }];
    })
    .sort((left, right) => right.basePath.length - left.basePath.length);
  return matching[0];
}

function driverForUrl(
  url: URL,
  configuredBaseUrls: ReadonlyArray<{
    readonly driver: TicketProviderDriverKind;
    readonly baseUrl: string;
  }>,
): { readonly driver: TicketProviderDriverKind; readonly basePath: string } | undefined {
  const configured = configuredDriverForUrl(url, configuredBaseUrls);
  if (configured) return configured;
  if (url.hostname.endsWith(".atlassian.net")) {
    return { driver: "jira" as TicketProviderDriverKind, basePath: "" };
  }
  if (url.hostname.endsWith(".visualstudio.com")) {
    return { driver: "azure-devops" as TicketProviderDriverKind, basePath: "" };
  }
  const driver = BUILT_IN_HOST_DRIVERS.get(url.hostname) as TicketProviderDriverKind | undefined;
  return driver ? { driver, basePath: "" } : undefined;
}

function pathnameRelativeToBase(url: URL, basePath: string): string {
  if (!basePath) return url.pathname;
  const relative = url.pathname.slice(basePath.length);
  return relative.startsWith("/") ? relative : `/${relative}`;
}

function parseGitHub(url: URL, basePath: string): TicketReference | undefined {
  const match = /^\/([^/]+)\/([^/]+)\/issues\/(\d+)\/?$/u.exec(
    pathnameRelativeToBase(url, basePath),
  );
  if (!match) return undefined;
  const project = `${match[1]}/${match[2]}`;
  return {
    driver: "github" as TicketProviderDriverKind,
    host: url.host,
    url: url.toString(),
    identifier: `${project}#${match[3]}`,
    project,
    resourceId: match[3]!,
  };
}

function parseGitLab(url: URL, basePath: string): TicketReference | undefined {
  const match = /^\/(.+)\/-\/issues\/(\d+)\/?$/u.exec(pathnameRelativeToBase(url, basePath));
  if (!match) return undefined;
  const project = match[1]!;
  return {
    driver: "gitlab" as TicketProviderDriverKind,
    host: url.host,
    url: url.toString(),
    identifier: `${project}#${match[2]}`,
    project,
    resourceId: match[2]!,
  };
}

function parseAzureDevOps(url: URL, basePath: string): TicketReference | undefined {
  const cloudMatch = /^\/([^/]+)\/([^/]+)\/_workitems\/edit\/(\d+)\/?$/u.exec(url.pathname);
  const legacyMatch = /^\/([^/]+)\/_workitems\/edit\/(\d+)\/?$/u.exec(url.pathname);
  const serverMatch = /^\/([^/]+)\/_workitems\/edit\/(\d+)\/?$/u.exec(
    pathnameRelativeToBase(url, basePath),
  );
  const baseOrganization = /([^/]+)\/?$/u.exec(basePath)?.[1];
  const organization = url.hostname.endsWith(".visualstudio.com")
    ? url.hostname.slice(0, -".visualstudio.com".length)
    : (cloudMatch?.[1] ?? baseOrganization);
  const project = url.hostname.endsWith(".visualstudio.com")
    ? legacyMatch?.[1]
    : (cloudMatch?.[2] ?? serverMatch?.[1]);
  const resourceId = url.hostname.endsWith(".visualstudio.com")
    ? legacyMatch?.[2]
    : (cloudMatch?.[3] ?? serverMatch?.[2]);
  if (!organization || !project || !resourceId) return undefined;
  return {
    driver: "azure-devops" as TicketProviderDriverKind,
    host: url.host,
    url: url.toString(),
    identifier: `${organization}/${project}#${resourceId}`,
    project: `${organization}/${project}`,
    resourceId,
  };
}

function parseBitbucket(url: URL): TicketReference | undefined {
  const match = /^\/([^/]+)\/([^/]+)\/issues\/(\d+)\/?$/u.exec(url.pathname);
  if (!match) return undefined;
  const project = `${match[1]}/${match[2]}`;
  return {
    driver: "bitbucket" as TicketProviderDriverKind,
    host: url.host,
    url: url.toString(),
    identifier: `${project}#${match[3]}`,
    project,
    resourceId: match[3]!,
  };
}

function parseJira(url: URL, basePath: string): TicketReference | undefined {
  const match = /^(.*?)\/browse\/([A-Za-z][A-Za-z0-9_]*-\d+)\/?$/u.exec(
    pathnameRelativeToBase(url, basePath),
  );
  if (!match) return undefined;
  const identifier = match[2]!.toUpperCase();
  return {
    driver: "jira" as TicketProviderDriverKind,
    host: url.host,
    url: url.toString(),
    identifier,
    project: identifier.slice(0, identifier.lastIndexOf("-")),
    resourceId: identifier,
  };
}

function parseClickUp(url: URL): TicketReference | undefined {
  const match = /^\/t\/(?:([^/]+)\/)?([^/]+)\/?$/u.exec(url.pathname);
  if (!match) return undefined;
  const workspace = match[1] ?? "ClickUp";
  const resourceId = match[2]!;
  return {
    driver: "clickup" as TicketProviderDriverKind,
    host: url.host,
    url: url.toString(),
    identifier: resourceId,
    project: workspace,
    resourceId,
  };
}

function parseByDriver(
  driver: TicketProviderDriverKind,
  url: URL,
  basePath: string,
): TicketReference | undefined {
  switch (driver) {
    case "github":
      return parseGitHub(url, basePath);
    case "gitlab":
      return parseGitLab(url, basePath);
    case "azure-devops":
      return parseAzureDevOps(url, basePath);
    case "bitbucket":
      return parseBitbucket(url);
    case "jira":
      return parseJira(url, basePath);
    case "clickup":
      return parseClickUp(url);
    default:
      return undefined;
  }
}

export function extractUniqueTicketReference(
  message: string,
  configuredBaseUrls: ReadonlyArray<{
    readonly driver: TicketProviderDriverKind;
    readonly baseUrl: string;
  }> = [],
): TicketReference | undefined {
  const references = new Map<string, TicketReference>();
  for (const rawUrl of stripIgnoredMarkdown(message).match(URL_PATTERN) ?? []) {
    const url = normalizedUrl(rawUrl);
    if (!url) continue;
    const match = driverForUrl(url, configuredBaseUrls);
    if (!match) continue;
    const reference = parseByDriver(match.driver, url, match.basePath);
    if (!reference) continue;
    references.set(`${reference.driver}:${reference.url}`, reference);
  }
  return references.size === 1 ? [...references.values()][0] : undefined;
}

export function normalizeTicketThreadTitle(value: string): string {
  let withoutControlCharacters = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    withoutControlCharacters += codePoint <= 0x1f || codePoint === 0x7f ? " " : character;
  }
  return withoutControlCharacters
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, MAX_TICKET_THREAD_TITLE_CHARS);
}

const TEMPLATE_TOKEN_PATTERN = /\{(title|identifier|provider|project)\}/gu;
const UNKNOWN_TEMPLATE_TOKEN_PATTERN = /\{[^{}]+\}/u;

export function renderTicketThreadTitle(
  policy: TicketTitlePolicy,
  metadata: TicketTitleMetadata,
): string | undefined {
  if (policy.mode === "disabled") return undefined;
  if (policy.mode === "title") return normalizeTicketThreadTitle(metadata.title) || undefined;
  if (policy.mode === "identifier_title") {
    return normalizeTicketThreadTitle(`${metadata.identifier} — ${metadata.title}`) || undefined;
  }

  const openSentinel = "\u0000T3_OPEN_BRACE\u0000";
  const closeSentinel = "\u0000T3_CLOSE_BRACE\u0000";
  const template = (policy.customTemplate || DEFAULT_TICKET_TITLE_TEMPLATE)
    .replace(
      /\{\{\{(title|identifier|provider|project)\}\}\}/gu,
      `${openSentinel}{$1}${closeSentinel}`,
    )
    .replace(/\{\{/gu, openSentinel)
    .replace(/\}\}/gu, closeSentinel);
  if (UNKNOWN_TEMPLATE_TOKEN_PATTERN.test(template.replace(TEMPLATE_TOKEN_PATTERN, ""))) {
    return undefined;
  }

  const values = metadata as Record<"title" | "identifier" | "provider" | "project", string>;
  const rendered = template
    .replace(TEMPLATE_TOKEN_PATTERN, (_whole, token: keyof typeof values) => values[token])
    .replaceAll(openSentinel, "{")
    .replaceAll(closeSentinel, "}");
  return normalizeTicketThreadTitle(rendered) || undefined;
}
