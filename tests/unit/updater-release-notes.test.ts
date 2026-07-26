/**
 * Unit tests for the updater release-notes normalizer.
 *
 * normalizeReleaseNotes is pure - no browser globals, no Electron, no async.
 *
 * Coverage:
 *   - Plain string passthrough (the real-world shape: fullChangelog is false).
 *   - null / undefined -> ''.
 *   - '' (GitHub's "No content." sentinel, per GitHubProvider.js) -> ''.
 *   - The ReleaseNoteInfo[] branch: joins notes, tolerates a null note, and
 *     drops empty-string notes.
 */

import { describe, it, expect } from 'vitest';
import { normalizeReleaseNotes } from '../../src/main/updater-release-notes';

describe('normalizeReleaseNotes', () => {
  it('passes a plain string through unchanged', () => {
    expect(normalizeReleaseNotes('## What\'s New\n- Dark mode')).toBe('## What\'s New\n- Dark mode');
  });

  it('returns empty string for null', () => {
    expect(normalizeReleaseNotes(null)).toBe('');
  });

  it('returns empty string for undefined', () => {
    expect(normalizeReleaseNotes(undefined)).toBe('');
  });

  it('returns empty string for the GitHub "No content." sentinel (already empty string)', () => {
    expect(normalizeReleaseNotes('')).toBe('');
  });

  it('joins ReleaseNoteInfo[] notes with a blank line between entries', () => {
    const result = normalizeReleaseNotes([
      { version: '1.1.0', note: 'Second release notes' },
      { version: '1.0.0', note: 'First release notes' },
    ]);
    expect(result).toBe('Second release notes\n\nFirst release notes');
  });

  it('tolerates a null note inside the array', () => {
    const result = normalizeReleaseNotes([
      { version: '1.1.0', note: null },
      { version: '1.0.0', note: 'Only real notes' },
    ]);
    expect(result).toBe('Only real notes');
  });

  it('drops empty-string notes inside the array', () => {
    const result = normalizeReleaseNotes([
      { version: '1.1.0', note: '' },
      { version: '1.0.0', note: 'Only real notes' },
    ]);
    expect(result).toBe('Only real notes');
  });

  it('returns empty string for an empty array', () => {
    expect(normalizeReleaseNotes([])).toBe('');
  });
});
