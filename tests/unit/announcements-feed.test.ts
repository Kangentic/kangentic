/**
 * Pure-function tests for the announcements feed (src/shared/announcements.ts):
 * tolerant parsing (malformed items skipped without poisoning siblings,
 * unknown fields ignored for forward compat, https-only links), the dotted
 * version comparator, active-selection targeting (version window, platform,
 * publish/expiry with fail-closed dates, deterministic ordering), and the
 * prune-on-write dismissal helper.
 */
import { describe, it, expect } from 'vitest';
import {
  parseAnnouncement,
  parseAnnouncementsFeed,
  compareVersions,
  selectActiveAnnouncements,
  computeDismissedIdsAfterDismiss,
  type Announcement,
} from '../../src/shared/announcements';

const NOW = new Date('2026-08-04T12:00:00Z');

function makeAnnouncement(overrides: Partial<Announcement> = {}): Announcement {
  return {
    id: 'a1',
    title: 'Title',
    body: 'Body',
    links: [],
    ...overrides,
  };
}

function contextFor(overrides: Partial<{ appVersion: string; platform: NodeJS.Platform; now: Date }> = {}) {
  return {
    appVersion: '0.32.1',
    platform: 'win32' as NodeJS.Platform,
    now: NOW,
    ...overrides,
  };
}

describe('parseAnnouncementsFeed', () => {
  it('round-trips a valid feed', () => {
    const feed = parseAnnouncementsFeed({
      announcements: [{
        id: 'mobile-launch-status-2026-08',
        title: 'Try Kangentic Mobile',
        body: 'Status of both platforms.',
        links: [{ label: 'Blog post', url: 'https://kangentic.com/blog' }],
        sections: [
          { heading: 'iOS', body: 'In **review**.' },
          {
            heading: 'Android',
            body: 'Closed testing.',
            links: [{ label: 'Become a tester', url: 'https://play.google.com/apps/testing/com.kangentic.mobile', qr: true }],
          },
        ],
        minVersion: '0.30.0',
        platforms: ['win32', 'darwin'],
        publishedAt: '2026-08-01T00:00:00Z',
        expiresAt: '2026-09-15T00:00:00Z',
        priority: 5,
      }],
    });
    expect(feed).toEqual([{
      id: 'mobile-launch-status-2026-08',
      title: 'Try Kangentic Mobile',
      body: 'Status of both platforms.',
      links: [{ label: 'Blog post', url: 'https://kangentic.com/blog' }],
      sections: [
        { heading: 'iOS', body: 'In **review**.' },
        {
          heading: 'Android',
          body: 'Closed testing.',
          links: [{ label: 'Become a tester', url: 'https://play.google.com/apps/testing/com.kangentic.mobile', qr: true }],
        },
      ],
      minVersion: '0.30.0',
      platforms: ['win32', 'darwin'],
      publishedAt: '2026-08-01T00:00:00Z',
      expiresAt: '2026-09-15T00:00:00Z',
      priority: 5,
    }]);
  });

  it('ignores unknown top-level and per-item fields (forward compat)', () => {
    const feed = parseAnnouncementsFeed({
      schemaVersion: 99,
      futureTopLevelField: { nested: true },
      announcements: [{
        id: 'a1', title: 'T', body: 'B',
        futureItemField: 'ignored',
        style: 'takeover',
      }],
    });
    expect(feed).toEqual([{ id: 'a1', title: 'T', body: 'B', links: [] }]);
  });

  it('skips a malformed item while its siblings survive', () => {
    const feed = parseAnnouncementsFeed({
      announcements: [
        { id: 'good-1', title: 'T', body: 'B' },
        { id: 'missing-body', title: 'T' },
        { id: '', title: 'T', body: 'B' },
        'not-an-object',
        null,
        { id: 'good-2', title: 'T', body: 'B' },
      ],
    });
    expect(feed?.map((announcement) => announcement.id)).toEqual(['good-1', 'good-2']);
  });

  it('returns null for a structurally unusable feed', () => {
    expect(parseAnnouncementsFeed(null)).toBeNull();
    expect(parseAnnouncementsFeed('nonsense')).toBeNull();
    expect(parseAnnouncementsFeed([])).toBeNull();
    expect(parseAnnouncementsFeed({})).toBeNull();
    expect(parseAnnouncementsFeed({ announcements: 'not-an-array' })).toBeNull();
  });

  it('drops non-https links but keeps the item', () => {
    const announcement = parseAnnouncement({
      id: 'a1', title: 'T', body: 'B',
      links: [
        { label: 'Ok', url: 'https://example.com' },
        { label: 'Http', url: 'http://example.com' },
        { label: 'File', url: 'file:///etc/passwd' },
        { label: 'NoUrl' },
      ],
    });
    expect(announcement).toEqual({
      id: 'a1', title: 'T', body: 'B',
      links: [{ label: 'Ok', url: 'https://example.com' }],
    });
  });

  it('carries the qr flag only when it is literally true', () => {
    const announcement = parseAnnouncement({
      id: 'a1', title: 'T', body: 'B',
      links: [
        { label: 'Scannable', url: 'https://example.com/a', qr: true },
        { label: 'StringTruthy', url: 'https://example.com/b', qr: 'yes' },
        { label: 'Plain', url: 'https://example.com/c' },
      ],
    });
    expect(announcement?.links).toEqual([
      { label: 'Scannable', url: 'https://example.com/a', qr: true },
      { label: 'StringTruthy', url: 'https://example.com/b' },
      { label: 'Plain', url: 'https://example.com/c' },
    ]);
  });

  it('skips malformed and empty sections while keeping real ones', () => {
    const announcement = parseAnnouncement({
      id: 'a1', title: 'T', body: 'B',
      sections: [
        { heading: 'Real', body: 'content' },
        {},
        'not-an-object',
        null,
        { links: [{ label: 'Only link', url: 'https://example.com' }] },
        { heading: '', body: '   ' },
      ],
    });
    expect(announcement?.sections).toEqual([
      { heading: 'Real', body: 'content' },
      { links: [{ label: 'Only link', url: 'https://example.com' }] },
    ]);
  });

  it('omits sections entirely when absent or all-empty', () => {
    expect(parseAnnouncement({ id: 'a1', title: 'T', body: 'B' })?.sections).toBeUndefined();
    expect(parseAnnouncement({ id: 'a2', title: 'T', body: 'B', sections: [{}] })?.sections).toBeUndefined();
    expect(parseAnnouncement({ id: 'a3', title: 'T', body: 'B', sections: 'nope' })?.sections).toBeUndefined();
  });

  it('drops unknown platform strings, failing closed when none remain', () => {
    const known = parseAnnouncement({ id: 'a1', title: 'T', body: 'B', platforms: ['win32', 'fuchsia'] });
    expect(known?.platforms).toEqual(['win32']);
    const allUnknown = parseAnnouncement({ id: 'a2', title: 'T', body: 'B', platforms: ['fuchsia'] });
    // Empty (not undefined): matches no platform, rather than all of them.
    expect(allUnknown?.platforms).toEqual([]);
  });
});

describe('compareVersions', () => {
  it('compares numerically per dotted part, not lexically', () => {
    expect(compareVersions('1.2.3', '1.10.0')).toBe(-1);
    expect(compareVersions('1.10.0', '1.2.3')).toBe(1);
    expect(compareVersions('0.32.1', '0.32.1')).toBe(0);
  });

  it('treats missing parts as zero', () => {
    expect(compareVersions('1.2', '1.2.0')).toBe(0);
    expect(compareVersions('1.2', '1.2.1')).toBe(-1);
  });

  it('strips pre-release and build suffixes', () => {
    expect(compareVersions('0.4.0-beta.1', '0.4.0')).toBe(0);
    expect(compareVersions('0.4.0+build.7', '0.4.0')).toBe(0);
  });
});

describe('selectActiveAnnouncements', () => {
  it('applies the version window inclusively', () => {
    const feed = [
      makeAnnouncement({ id: 'below-min', minVersion: '0.33.0' }),
      makeAnnouncement({ id: 'at-min', minVersion: '0.32.1' }),
      makeAnnouncement({ id: 'at-max', maxVersion: '0.32.1' }),
      makeAnnouncement({ id: 'above-max', maxVersion: '0.32.0' }),
      makeAnnouncement({ id: 'unbounded' }),
    ];
    const active = selectActiveAnnouncements(feed, contextFor());
    expect(active.map((announcement) => announcement.id).sort()).toEqual(['at-max', 'at-min', 'unbounded']);
  });

  it('filters by platform, with omitted platforms matching everywhere', () => {
    const feed = [
      makeAnnouncement({ id: 'win-only', platforms: ['win32'] }),
      makeAnnouncement({ id: 'mac-only', platforms: ['darwin'] }),
      makeAnnouncement({ id: 'everywhere' }),
    ];
    const active = selectActiveAnnouncements(feed, contextFor({ platform: 'win32' }));
    expect(active.map((announcement) => announcement.id).sort()).toEqual(['everywhere', 'win-only']);
  });

  it('fails closed for a client platform outside the known trio: matches only untargeted announcements', () => {
    // NodeJS.Platform includes values beyond win32/darwin/linux (aix, freebsd,
    // openbsd, sunos, ...); AnnouncementPlatform only declares the three
    // Kangentic ships on. A client running on one of those other platforms
    // must never match a `platforms`-targeted announcement, only an
    // untargeted (omitted platforms) one.
    const feed = [
      makeAnnouncement({ id: 'win-targeted', platforms: ['win32'] }),
      makeAnnouncement({ id: 'untargeted' }),
    ];
    const active = selectActiveAnnouncements(
      feed,
      contextFor({ platform: 'freebsd' as NodeJS.Platform }),
    );
    expect(active.map((announcement) => announcement.id)).toEqual(['untargeted']);
  });

  it('excludes future publishedAt and past expiresAt', () => {
    const feed = [
      makeAnnouncement({ id: 'not-yet', publishedAt: '2026-08-05T00:00:00Z' }),
      makeAnnouncement({ id: 'expired', expiresAt: '2026-08-01T00:00:00Z' }),
      makeAnnouncement({ id: 'live', publishedAt: '2026-08-01T00:00:00Z', expiresAt: '2026-09-01T00:00:00Z' }),
    ];
    const active = selectActiveAnnouncements(feed, contextFor());
    expect(active.map((announcement) => announcement.id)).toEqual(['live']);
  });

  it('fails closed on unparseable date strings', () => {
    const feed = [
      makeAnnouncement({ id: 'bad-published', publishedAt: 'not-a-date' }),
      makeAnnouncement({ id: 'bad-expires', expiresAt: 'not-a-date' }),
    ];
    expect(selectActiveAnnouncements(feed, contextFor())).toEqual([]);
  });

  it('orders by priority desc, then publishedAt desc, then id (deterministic)', () => {
    const feed = [
      makeAnnouncement({ id: 'old-high', priority: 5, publishedAt: '2026-07-01T00:00:00Z' }),
      makeAnnouncement({ id: 'new-low', publishedAt: '2026-08-02T00:00:00Z' }),
      makeAnnouncement({ id: 'newer-low', publishedAt: '2026-08-03T00:00:00Z' }),
      makeAnnouncement({ id: 'tie-b' }),
      makeAnnouncement({ id: 'tie-a' }),
    ];
    const active = selectActiveAnnouncements(feed, contextFor());
    expect(active.map((announcement) => announcement.id)).toEqual([
      'old-high', 'newer-low', 'new-low', 'tie-a', 'tie-b',
    ]);
  });
});

describe('computeDismissedIdsAfterDismiss', () => {
  it('appends the dismissed id', () => {
    expect(computeDismissedIdsAfterDismiss([], ['a1'], 'a1')).toEqual(['a1']);
  });

  it('prunes stored ids no longer in the active feed', () => {
    expect(computeDismissedIdsAfterDismiss(
      ['gone-1', 'still-active', 'gone-2'],
      ['still-active', 'a2'],
      'a2',
    )).toEqual(['still-active', 'a2']);
  });

  it('does not duplicate an already-dismissed id', () => {
    expect(computeDismissedIdsAfterDismiss(['a1', 'a2'], ['a1', 'a2'], 'a2')).toEqual(['a1', 'a2']);
  });
});
