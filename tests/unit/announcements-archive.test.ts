/**
 * The local announcements archive: the pure fold/stamp/count helpers in
 * src/shared/announcements.ts, and the configDir sidecar reader/writer in
 * src/main/announcements-archive.ts.
 *
 * The archive is what makes history survive a feed deletion, an offline
 * launch, and the 10 seconds before the first poll, and it owns read-state
 * (which cannot live in dismissedAnnouncementIds, since that list prunes
 * itself to the active feed on every write).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ANNOUNCEMENT_ARCHIVE_CAP,
  appendToArchive,
  countUnreadAnnouncements,
  markArchiveEntryRead,
  reconcileOpenDialog,
  type Announcement,
  type AnnouncementArchiveEntry,
} from '../../src/shared/announcements';
import { readArchive, writeArchive } from '../../src/main/announcements-archive';

const NOW = new Date('2026-08-04T12:00:00Z');
const LATER = new Date('2026-08-05T12:00:00Z');

function makeAnnouncement(overrides: Partial<Announcement> & { id: string }): Announcement {
  return {
    title: `Title ${overrides.id}`,
    body: `Body ${overrides.id}`,
    links: [],
    ...overrides,
  };
}

function makeEntry(
  id: string,
  overrides: Partial<AnnouncementArchiveEntry> = {},
): AnnouncementArchiveEntry {
  return {
    announcement: makeAnnouncement({ id }),
    firstSeenAt: NOW.toISOString(),
    readAt: null,
    ...overrides,
  };
}

describe('appendToArchive', () => {
  it('adds unseen announcements newest-first, preserving the feed order', () => {
    // selectActiveAnnouncements already sorted these (priority, then recency),
    // so the archive head must come out in the same order.
    const active = [makeAnnouncement({ id: 'high' }), makeAnnouncement({ id: 'low' })];

    const archive = appendToArchive([], active, NOW);

    expect(archive.map((entry) => entry.announcement.id)).toEqual(['high', 'low']);
    expect(archive.every((entry) => entry.readAt === null)).toBe(true);
    expect(archive.every((entry) => entry.firstSeenAt === NOW.toISOString())).toBe(true);
  });

  it('prepends genuinely new announcements above the existing archive', () => {
    const existing = [makeEntry('old')];

    const archive = appendToArchive(existing, [makeAnnouncement({ id: 'fresh' })], LATER);

    expect(archive.map((entry) => entry.announcement.id)).toEqual(['fresh', 'old']);
    expect(archive[0].firstSeenAt).toBe(LATER.toISOString());
  });

  it('dedupes by id: a still-active announcement is not archived twice', () => {
    const existing = [makeEntry('a1')];

    const archive = appendToArchive(existing, [makeAnnouncement({ id: 'a1' })], LATER);

    expect(archive).toHaveLength(1);
  });

  it('dedupes a same-batch duplicate id: the feed itself repeating an id does not archive it twice', () => {
    // A self-hosted or overridden feed (KANGENTIC_ANNOUNCEMENTS_URL) never
    // passes through the committed feed's unique-id check, so a repeated id
    // within one batch must not permanently double-archive: both copies
    // would then match on every later poll and collide on the history
    // list's React key.
    const active = [makeAnnouncement({ id: 'dup' }), makeAnnouncement({ id: 'dup' })];

    const archive = appendToArchive([], active, NOW);

    expect(archive).toHaveLength(1);
    expect(archive[0].announcement.id).toBe('dup');
  });

  it('keeps a re-seen entry in its original position among its siblings', () => {
    // Every other test that touches an already-archived id uses an archive
    // of exactly one entry, so surviving order among multiple entries is
    // otherwise never asserted.
    const existing = [makeEntry('a1'), makeEntry('a2')];

    const archive = appendToArchive(existing, [makeAnnouncement({ id: 'a2' })], LATER);

    expect(archive.map((entry) => entry.announcement.id)).toEqual(['a1', 'a2']);
  });

  it('keeps firstSeenAt and readAt on a re-seen entry but refreshes its payload', () => {
    // An announcement edited in place upstream should show its new text, without
    // resetting when this client first saw it or whether it was read.
    const existing = [makeEntry('a1', { readAt: NOW.toISOString() })];
    const edited = makeAnnouncement({ id: 'a1', title: 'Edited title' });

    const [entry] = appendToArchive(existing, [edited], LATER);

    expect(entry.announcement.title).toBe('Edited title');
    expect(entry.firstSeenAt).toBe(NOW.toISOString());
    expect(entry.readAt).toBe(NOW.toISOString());
  });

  it('leaves an archived announcement in place once it drops out of the feed', () => {
    // The whole point: an expired or upstream-deleted announcement stays readable.
    const existing = [makeEntry('gone')];

    const archive = appendToArchive(existing, [], LATER);

    expect(archive.map((entry) => entry.announcement.id)).toEqual(['gone']);
  });

  it('caps the archive, dropping the oldest from the tail', () => {
    const existing = Array.from({ length: 5 }, (_unused, index) => makeEntry(`old-${index}`));

    const archive = appendToArchive(existing, [makeAnnouncement({ id: 'fresh' })], LATER, 3);

    expect(archive.map((entry) => entry.announcement.id)).toEqual(['fresh', 'old-0', 'old-1']);
  });

  it('defaults to the shared cap', () => {
    const active = Array.from({ length: ANNOUNCEMENT_ARCHIVE_CAP + 10 }, (_unused, index) =>
      makeAnnouncement({ id: `a${index}` }));

    expect(appendToArchive([], active, NOW)).toHaveLength(ANNOUNCEMENT_ARCHIVE_CAP);
  });
});

describe('markArchiveEntryRead', () => {
  it('stamps readAt on the matching entry only', () => {
    const entries = [makeEntry('a1'), makeEntry('a2')];

    const stamped = markArchiveEntryRead(entries, 'a1', NOW);

    expect(stamped[0].readAt).toBe(NOW.toISOString());
    expect(stamped[1].readAt).toBeNull();
  });

  it('is idempotent: an already-read entry keeps its original timestamp', () => {
    const entries = [makeEntry('a1', { readAt: NOW.toISOString() })];

    const stamped = markArchiveEntryRead(entries, 'a1', LATER);

    expect(stamped[0].readAt).toBe(NOW.toISOString());
    // Returns the SAME array, which the store and the IPC handler both use as
    // their "nothing to persist" check.
    expect(stamped).toBe(entries);
  });

  it('returns the input untouched for an unknown id', () => {
    const entries = [makeEntry('a1')];

    expect(markArchiveEntryRead(entries, 'never-archived', NOW)).toBe(entries);
  });
});

describe('countUnreadAnnouncements', () => {
  it('counts only unread entries', () => {
    const entries = [
      makeEntry('a1'),
      makeEntry('a2', { readAt: NOW.toISOString() }),
      makeEntry('a3'),
    ];

    expect(countUnreadAnnouncements(entries)).toBe(2);
  });

  it('counts an expired-but-unread entry, since expiry is not read', () => {
    const expired = makeEntry('old', {
      announcement: makeAnnouncement({ id: 'old', expiresAt: '2020-01-01T00:00:00Z' }),
    });

    expect(countUnreadAnnouncements([expired])).toBe(1);
  });

  it('is zero for an empty archive', () => {
    expect(countUnreadAnnouncements([])).toBe(0);
  });
});

describe('reconcileOpenDialog', () => {
  const open = makeAnnouncement({ id: 'a1' });

  it('closes a banner-opened dialog whose announcement left the active set', () => {
    expect(reconcileOpenDialog(open, 'banner', [])).toBeNull();
  });

  it('keeps a banner-opened dialog whose announcement is still active', () => {
    expect(reconcileOpenDialog(open, 'banner', [open])).toBe(open);
  });

  it('keeps a history-opened dialog whose announcement is NOT active', () => {
    // History exists to show announcements that are no longer active, and this
    // path runs on every poll AND every HMR resync. Reconciling it would close
    // the dialog out from under the user on every renderer edit in dev.
    expect(reconcileOpenDialog(open, 'history', [])).toBe(open);
  });

  it('is null when no dialog is open', () => {
    expect(reconcileOpenDialog(null, null, [open])).toBeNull();
  });
});

describe('archive file store', () => {
  let tempDir: string;
  let archivePath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'announcements-archive-test-'));
    archivePath = path.join(tempDir, 'announcements-archive.json');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('round-trips entries', () => {
    const entries = [makeEntry('a1', { readAt: NOW.toISOString() }), makeEntry('a2')];

    writeArchive(archivePath, entries);

    expect(readArchive(archivePath)).toEqual(entries);
  });

  it('reads a missing file as empty', () => {
    expect(readArchive(archivePath)).toEqual([]);
  });

  it('reads a corrupt file as empty rather than throwing', () => {
    fs.writeFileSync(archivePath, '{ not json');

    expect(readArchive(archivePath)).toEqual([]);
  });

  it('reads a non-array payload as empty', () => {
    fs.writeFileSync(archivePath, JSON.stringify({ entries: [] }));

    expect(readArchive(archivePath)).toEqual([]);
  });

  it('treats an absent readAt key as unread rather than malformed', () => {
    // A stored entry can legitimately omit `readAt` (it is `string | null`),
    // so an absent key must read as unread, the same as an explicit null.
    const entry = { announcement: makeAnnouncement({ id: 'no-read-key' }), firstSeenAt: NOW.toISOString() };
    fs.writeFileSync(archivePath, JSON.stringify([entry]));

    const archive = readArchive(archivePath);

    expect(archive).toHaveLength(1);
    expect(archive[0].readAt).toBeNull();
  });

  it('still rejects a present but wrong-typed readAt, with its siblings surviving', () => {
    // Guards against a permissive fix: only an ABSENT readAt key is unread.
    // A present value of the wrong type is still a malformed entry.
    fs.writeFileSync(archivePath, JSON.stringify([
      makeEntry('good'),
      { announcement: makeAnnouncement({ id: 'bad-read-type' }), firstSeenAt: NOW.toISOString(), readAt: 42 },
    ]));

    expect(readArchive(archivePath).map((entry) => entry.announcement.id)).toEqual(['good']);
  });

  it('drops malformed entries while their siblings survive', () => {
    fs.writeFileSync(archivePath, JSON.stringify([
      makeEntry('good'),
      { announcement: { id: 'no-title' }, firstSeenAt: NOW.toISOString(), readAt: null },
      { announcement: makeAnnouncement({ id: 'no-timestamp' }), readAt: null },
    ]));

    expect(readArchive(archivePath).map((entry) => entry.announcement.id)).toEqual(['good']);
  });

  it('creates the parent directory on write', () => {
    const nested = path.join(tempDir, 'nested', 'announcements-archive.json');

    writeArchive(nested, [makeEntry('a1')]);

    expect(readArchive(nested)).toHaveLength(1);
  });

  it('leaves no temp file behind (the write is tmp + rename)', () => {
    writeArchive(archivePath, [makeEntry('a1')]);

    expect(fs.readdirSync(tempDir)).toEqual(['announcements-archive.json']);
  });
});
