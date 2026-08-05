/**
 * In-app announcements: schema, tolerant feed parsing, and targeting.
 *
 * The desktop app polls a static JSON feed on the public repo
 * (`announcements.json` on `main`, served via raw.githubusercontent.com) and
 * shows the highest-priority active announcement as a dismissible banner.
 * There is no backend: an unreachable or malformed feed simply means no
 * announcement is shown. Everything here is pure and shared so the main
 * process (fetch + filter), the renderer (types + dismissal), and unit tests
 * consume one definition.
 *
 * Publishing contract: edits to `announcements.json` on `main` reach every
 * released client within one poll cycle (about 4 hours, plus ~5 minutes of
 * raw.githubusercontent CDN cache). See docs/configuration.md.
 */

export const ANNOUNCEMENTS_URL =
  'https://raw.githubusercontent.com/Kangentic/kangentic/main/announcements.json';

export type AnnouncementPlatform = 'win32' | 'darwin' | 'linux';

export interface AnnouncementLink {
  label: string;
  /** https:// only; the parser drops links with any other scheme. */
  url: string;
  /** Render a large scannable QR code for this link in the dialog. Opt-in
   *  because it is the exception: most announcements carry desktop-destined
   *  links where a QR is noise. Reserve it for links meant to be opened on a
   *  phone (store opt-in pages, TestFlight invites). */
  qr?: boolean;
}

/**
 * One titled message inside an announcement, for announcements that carry
 * several at once (e.g. an iOS status and an Android status, each with its
 * own links). A section needs at least one of heading / body / links to
 * survive parsing. Rendered after the announcement's intro `body`, in order.
 */
export interface AnnouncementSection {
  heading?: string;
  /** Markdown, like the announcement body. */
  body?: string;
  links?: AnnouncementLink[];
}

export interface Announcement {
  /** Stable unique id, e.g. 'mobile-closed-test-2026-08'. Dismissal is keyed on this. */
  id: string;
  /** Banner strip text (one line). */
  title: string;
  /** Markdown body for the "Learn more" dialog. With sections present this
   *  reads as the intro; sections follow it. */
  body: string;
  /** External links rendered as buttons at the end of the dialog (with a
   *  large QR code above any link flagged `qr: true`). May be empty; a
   *  sectioned announcement usually scopes its links to sections instead. */
  links: AnnouncementLink[];
  /** Optional titled sub-messages rendered between body and links. */
  sections?: AnnouncementSection[];
  /** Inclusive semver floor/ceiling on the running app version. Omitted = unbounded. */
  minVersion?: string;
  maxVersion?: string;
  /** Electron process.platform values. Omitted = all platforms. */
  platforms?: AnnouncementPlatform[];
  /** ISO 8601 UTC. Omitted publishedAt = live immediately; omitted expiresAt = never expires. */
  publishedAt?: string;
  expiresAt?: string;
  /** Higher wins when several are active. Default 0. Ties broken by newest publishedAt. */
  priority?: number;
}

export interface AnnouncementTargetContext {
  appVersion: string;
  platform: NodeJS.Platform;
  now: Date;
}

const KNOWN_PLATFORMS: readonly AnnouncementPlatform[] = ['win32', 'darwin', 'linux'];

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function asOptionalString(value: unknown): string | undefined {
  return isNonEmptyString(value) ? value : undefined;
}

function isHttpsUrl(value: string): boolean {
  return value.startsWith('https://');
}

function parseLinks(raw: unknown): AnnouncementLink[] {
  if (!Array.isArray(raw)) return [];
  const links: AnnouncementLink[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const candidate = entry as Record<string, unknown>;
    if (!isNonEmptyString(candidate.label) || !isNonEmptyString(candidate.url)) continue;
    // https only: these URLs are handed to shell.openExternal on click, so the
    // parser is the choke point that keeps non-web schemes out of the feed.
    if (!isHttpsUrl(candidate.url)) continue;
    const link: AnnouncementLink = { label: candidate.label, url: candidate.url };
    if (candidate.qr === true) link.qr = true;
    links.push(link);
  }
  return links;
}

function parseSections(raw: unknown): AnnouncementSection[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const sections: AnnouncementSection[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const candidate = entry as Record<string, unknown>;
    const section: AnnouncementSection = {};
    const heading = asOptionalString(candidate.heading);
    if (heading !== undefined) section.heading = heading;
    const body = asOptionalString(candidate.body);
    if (body !== undefined) section.body = body;
    const links = parseLinks(candidate.links);
    if (links.length > 0) section.links = links;
    // An empty section renders nothing; drop it rather than emit a blank gap.
    if (section.heading !== undefined || section.body !== undefined || section.links !== undefined) {
      sections.push(section);
    }
  }
  return sections.length > 0 ? sections : undefined;
}

function parsePlatforms(raw: unknown): AnnouncementPlatform[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  // Unknown platform strings are dropped. An announcement targeting ONLY
  // unknown platforms ends up with an empty array, which matches nothing:
  // fail closed rather than showing it everywhere.
  return raw.filter((entry): entry is AnnouncementPlatform =>
    typeof entry === 'string' && (KNOWN_PLATFORMS as readonly string[]).includes(entry));
}

/**
 * Parse one feed item. Returns null for a malformed item, which the caller
 * skips without poisoning its siblings. Unknown fields are ignored so future
 * feed additions never break released clients; a future item type that needs
 * new client behavior sets `minVersion` to the first version that understands
 * it instead of bumping a schema version.
 */
export function parseAnnouncement(raw: unknown): Announcement | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const candidate = raw as Record<string, unknown>;
  if (!isNonEmptyString(candidate.id)) return null;
  if (!isNonEmptyString(candidate.title)) return null;
  if (!isNonEmptyString(candidate.body)) return null;

  const announcement: Announcement = {
    id: candidate.id,
    title: candidate.title,
    body: candidate.body,
    links: parseLinks(candidate.links),
  };
  const sections = parseSections(candidate.sections);
  if (sections !== undefined) announcement.sections = sections;
  const minVersion = asOptionalString(candidate.minVersion);
  if (minVersion !== undefined) announcement.minVersion = minVersion;
  const maxVersion = asOptionalString(candidate.maxVersion);
  if (maxVersion !== undefined) announcement.maxVersion = maxVersion;
  const platforms = parsePlatforms(candidate.platforms);
  if (platforms !== undefined) announcement.platforms = platforms;
  const publishedAt = asOptionalString(candidate.publishedAt);
  if (publishedAt !== undefined) announcement.publishedAt = publishedAt;
  const expiresAt = asOptionalString(candidate.expiresAt);
  if (expiresAt !== undefined) announcement.expiresAt = expiresAt;
  if (typeof candidate.priority === 'number' && Number.isFinite(candidate.priority)) {
    announcement.priority = candidate.priority;
  }
  return announcement;
}

/**
 * Parse the whole feed (`{ "announcements": [...] }`). Returns null only when
 * the feed is structurally unusable, which callers treat exactly like a
 * network failure: silent, no banner, no telemetry.
 */
export function parseAnnouncementsFeed(raw: unknown): Announcement[] | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const feed = (raw as Record<string, unknown>).announcements;
  if (!Array.isArray(feed)) return null;
  const parsed: Announcement[] = [];
  for (const item of feed) {
    const announcement = parseAnnouncement(item);
    if (announcement) parsed.push(announcement);
  }
  return parsed;
}

/**
 * Numeric dotted-part version compare; pre-release/build suffixes after '-'
 * or '+' are stripped (0.4.0-beta.1 compares as 0.4.0), missing parts are 0.
 * Local because the only existing helper (`isVersionAtLeast` in
 * src/main/git/git-detector.ts) lives in the main process and shared code
 * cannot import it.
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const numericParts = (version: string): number[] =>
    version.split(/[-+]/, 1)[0].split('.').map((part) => {
      const parsed = Number.parseInt(part, 10);
      return Number.isFinite(parsed) ? parsed : 0;
    });
  const partsA = numericParts(a);
  const partsB = numericParts(b);
  const length = Math.max(partsA.length, partsB.length);
  for (let index = 0; index < length; index += 1) {
    const partA = partsA[index] ?? 0;
    const partB = partsB[index] ?? 0;
    if (partA < partB) return -1;
    if (partA > partB) return 1;
  }
  return 0;
}

/** Epoch millis for an ISO string; null when missing or unparseable. */
function parseTimestamp(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Filter the feed to announcements active for this client: inside the
 * inclusive min/max version window, matching the platform, already published,
 * and not expired. An item with an unparseable date string is disabled (fail
 * closed) rather than shown. The result is sorted priority desc, then
 * publishedAt desc, then id, and the sort lives HERE deliberately: the main
 * poller's change detection compares serialized lists, so ordering must be
 * deterministic for identical inputs.
 */
export function selectActiveAnnouncements(
  feed: Announcement[],
  context: AnnouncementTargetContext,
): Announcement[] {
  const nowMs = context.now.getTime();
  const active = feed.filter((announcement) => {
    if (announcement.minVersion !== undefined
        && compareVersions(context.appVersion, announcement.minVersion) < 0) {
      return false;
    }
    if (announcement.maxVersion !== undefined
        && compareVersions(context.appVersion, announcement.maxVersion) > 0) {
      return false;
    }
    if (announcement.platforms !== undefined
        && !(announcement.platforms as readonly string[]).includes(context.platform)) {
      return false;
    }
    if (announcement.publishedAt !== undefined) {
      const publishedMs = parseTimestamp(announcement.publishedAt);
      if (publishedMs === null || publishedMs > nowMs) return false;
    }
    if (announcement.expiresAt !== undefined) {
      const expiresMs = parseTimestamp(announcement.expiresAt);
      if (expiresMs === null || expiresMs <= nowMs) return false;
    }
    return true;
  });
  return active.sort((first, second) => {
    const priorityDelta = (second.priority ?? 0) - (first.priority ?? 0);
    if (priorityDelta !== 0) return priorityDelta;
    const publishedDelta =
      (parseTimestamp(second.publishedAt) ?? 0) - (parseTimestamp(first.publishedAt) ?? 0);
    if (publishedDelta !== 0) return publishedDelta;
    return first.id.localeCompare(second.id);
  });
}

/**
 * Prune-on-write dismissal: the stored list keeps only ids still present in
 * the active feed, plus the newly dismissed id, so stale ids from expired or
 * removed announcements drain out on the next dismissal and the config array
 * stays bounded with no separate cleanup pass. Accepted edge: an announcement
 * whose expiry is later extended re-appears if its id was pruned meanwhile.
 */
export function computeDismissedIdsAfterDismiss(
  existingDismissedIds: string[],
  activeAnnouncementIds: string[],
  dismissedId: string,
): string[] {
  const retained = existingDismissedIds.filter(
    (id) => id !== dismissedId && activeAnnouncementIds.includes(id));
  return [...retained, dismissedId];
}
