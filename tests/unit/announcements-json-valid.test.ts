/**
 * Validates the COMMITTED announcements feed (announcements.json at the repo
 * root) through the real parser. The feed's tolerant parsing is a feature in
 * production (a malformed entry is silently dropped rather than breaking the
 * app) but a trap at authoring time: a typo'd entry would ship, drop, and
 * show nothing, with no error anywhere. This test makes that failure loud on
 * the PR that introduces it - every content-only announcement PR runs it via
 * the unit tier in CI.
 *
 * Publishing contract reminder (docs/configuration.md): edits to this file on
 * main reach every released client within one poll cycle. Ids are dismissal
 * keys - never reuse or rename one.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { parseAnnouncementsFeed } from '../../src/shared/announcements';

const FEED_PATH = path.join(__dirname, '..', '..', 'announcements.json');

function readRawFeed(): { raw: unknown; rawEntries: unknown[] } {
  const raw: unknown = JSON.parse(fs.readFileSync(FEED_PATH, 'utf-8'));
  const rawEntries = (raw as { announcements?: unknown[] }).announcements ?? [];
  return { raw, rawEntries };
}

function readRawFeedText(): string {
  return fs.readFileSync(FEED_PATH, 'utf-8');
}

describe('committed announcements.json', () => {
  it('is a structurally valid feed', () => {
    const { raw } = readRawFeed();
    expect(parseAnnouncementsFeed(raw)).not.toBeNull();
  });

  it('loses NOTHING to tolerant parsing: every authored entry and link survives', () => {
    const { raw, rawEntries } = readRawFeed();
    const parsed = parseAnnouncementsFeed(raw)!;

    // Entry count: a malformed entry (missing id/title/body) would be dropped
    // silently in production; here it fails the build instead.
    expect(parsed.length).toBe(rawEntries.length);

    // Link count, including section links: a non-https URL or missing label
    // would silently drop just that link.
    const countRawLinks = (entry: unknown): number => {
      const candidate = entry as { links?: unknown[]; sections?: Array<{ links?: unknown[] }> };
      return (candidate.links?.length ?? 0)
        + (candidate.sections ?? []).reduce((sum, section) => sum + (section.links?.length ?? 0), 0);
    };
    const countParsedLinks = (entry: (typeof parsed)[number]): number =>
      entry.links.length
      + (entry.sections ?? []).reduce((sum, section) => sum + (section.links?.length ?? 0), 0);

    for (let index = 0; index < parsed.length; index += 1) {
      expect(countParsedLinks(parsed[index])).toBe(countRawLinks(rawEntries[index]));
    }

    // Section count: an all-empty section would be dropped silently.
    for (let index = 0; index < parsed.length; index += 1) {
      const rawSections = (rawEntries[index] as { sections?: unknown[] }).sections?.length ?? 0;
      expect(parsed[index].sections?.length ?? 0).toBe(rawSections);
    }
  });

  it('follows the authoring contract: unique ids, expiry on every entry, parseable dates', () => {
    const { raw } = readRawFeed();
    const parsed = parseAnnouncementsFeed(raw)!;

    const ids = parsed.map((announcement) => announcement.id);
    expect(new Set(ids).size).toBe(ids.length);

    for (const announcement of parsed) {
      // Every entry carries an expiry (docs/configuration.md): a forgotten
      // announcement must age out on its own, not linger for years.
      expect(announcement.expiresAt, `announcement "${announcement.id}" needs expiresAt`).toBeDefined();
      // Unparseable dates fail closed (the entry never shows); catch at author time.
      expect(Number.isNaN(Date.parse(announcement.expiresAt!))).toBe(false);
      if (announcement.publishedAt !== undefined) {
        expect(Number.isNaN(Date.parse(announcement.publishedAt))).toBe(false);
      }
    }
  });

  it('follows house style: no em-dash and no " -- " separator in authored copy', () => {
    // Content-only PRs (announcements.json is the one file non-engineering
    // contributors edit directly) can ship house-style violations that no
    // lint rule catches. .claude/rules/text-formatting.md's em-dash scan only
    // covers src/ and scripts/. The character renders as mojibake on Windows
    // console code pages, which the team dogfoods on. The escape below keeps
    // this authored assertion itself free of a literal em-dash character.
    const EM_DASH = String.fromCharCode(0x2014);
    const rawText = readRawFeedText();
    expect(rawText.includes(EM_DASH)).toBe(false);
    expect(rawText.includes(' -- ')).toBe(false);
  });
});
