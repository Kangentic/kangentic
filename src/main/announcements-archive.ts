import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteJson } from './config/board-config/atomic-write';
import { PATHS } from './config/paths';
import { parseAnnouncement, type AnnouncementArchiveEntry } from '../shared/announcements';

/**
 * The local announcements archive: this client's own copy of every
 * announcement that was ever active for it, plus per-entry read-state.
 *
 * It exists for three reasons the live feed cannot cover:
 *   1. `cachedActive` in announcements.ts is in-memory and empty for the first
 *      10 seconds of every launch, and stays empty offline. A permanent
 *      megaphone backed by the feed alone would show an empty history on every
 *      boot.
 *   2. Read-state needs somewhere durable that is NOT
 *      config.dismissedAnnouncementIds, which prunes itself to ids still in the
 *      active feed on every write (see computeDismissedIdsAfterDismiss).
 *   3. Announcements can be deleted from the feed upstream once expired.
 *
 * A sidecar under configDir rather than a config.json key: entries carry full
 * markdown bodies, which do not belong in the blob that dismissAnnouncement
 * rewrites fire-and-forget.
 *
 * EVERY archive mutation goes through this module. The poll's append and a
 * mark-read both do read-mutate-write on one file, so a second writer
 * elsewhere would clobber. Paths are injected (like resolveClientId's
 * cacheFilePath) so unit tests can point at a temp dir.
 */

/** True for a value shaped like a stored entry, with a parseable announcement. */
function parseEntry(raw: unknown): AnnouncementArchiveEntry | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const candidate = raw as Record<string, unknown>;
  // Reuse the feed parser so the archive can never hold something the live
  // feed itself would have rejected.
  const announcement = parseAnnouncement(candidate.announcement);
  if (announcement === null) return null;
  if (typeof candidate.firstSeenAt !== 'string' || candidate.firstSeenAt.length === 0) return null;
  // An absent key reads as unread, the same as an explicit null: `readAt` is
  // `string | null`, so a writer that omits null-valued keys still produced a
  // valid entry, and dropping it would lose the announcement rather than just
  // its read-state. Only a present-but-wrong-typed value is malformed.
  const readAt = candidate.readAt === undefined ? null : candidate.readAt;
  if (readAt !== null && typeof readAt !== 'string') return null;
  return {
    announcement,
    firstSeenAt: candidate.firstSeenAt,
    readAt: readAt === null || readAt.length === 0 ? null : readAt,
  };
}

/**
 * Read the archive. A missing, unreadable, or corrupt file loads as empty, and
 * individual malformed entries are dropped while their siblings survive, the
 * same tolerant posture the feed parser takes.
 */
export function readArchive(filePath: string): AnnouncementArchiveEntry[] {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const entries: AnnouncementArchiveEntry[] = [];
    for (const item of parsed) {
      const entry = parseEntry(item);
      if (entry) entries.push(entry);
    }
    return entries;
  } catch {
    // Corrupt file -> treat as empty.
    return [];
  }
}

/**
 * Write the archive atomically (tmp + rename, via the shared primitive so a
 * crash mid-write cannot truncate it). Best-effort: a failed write is logged
 * and swallowed, matching checkAnnouncements' documented silent-degrade
 * posture. Losing the archive costs a badge count, never a user action.
 */
export function writeArchive(filePath: string, entries: AnnouncementArchiveEntry[]): void {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    atomicWriteJson(filePath, entries);
  } catch (error) {
    console.log('[ANNOUNCEMENTS] archive write skipped:',
      error instanceof Error ? error.message : String(error));
  }
}

/** Production read, bound to the configDir sidecar. */
export function readAnnouncementArchive(): AnnouncementArchiveEntry[] {
  return readArchive(PATHS.announcementsArchiveFile);
}

/** Production write, bound to the configDir sidecar. */
export function writeAnnouncementArchive(entries: AnnouncementArchiveEntry[]): void {
  writeArchive(PATHS.announcementsArchiveFile, entries);
}
