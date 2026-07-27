/**
 * Unit coverage for pasted-attachment filename numbering.
 *
 * Pasting two images in quick succession used to produce two files both named
 * `pasted-image-1.png`: the old scheme counted existing attachments plus an
 * in-flight counter that was decremented once the save resolved, but the
 * attachment list only reflects that save after React re-renders and rebinds the
 * paste handler. A paste landing in that gap saw a decremented counter AND a
 * stale list, and reissued a taken index. These tests pin the replacement,
 * whose contract is that an index is never handed out twice.
 */
import { describe, it, expect } from 'vitest';
import {
  PASTED_FILE_PREFIX,
  PASTED_IMAGE_PREFIX,
  pastedAttachmentPrefix,
  reserveNextPastedIndex,
} from '../../src/renderer/components/dialogs/attachment-utils';

describe('pastedAttachmentPrefix', () => {
  it('uses the image prefix for image media types', () => {
    expect(pastedAttachmentPrefix('image/png')).toBe(PASTED_IMAGE_PREFIX);
  });

  it('uses the file prefix for everything else', () => {
    expect(pastedAttachmentPrefix('application/pdf')).toBe(PASTED_FILE_PREFIX);
  });
});

describe('reserveNextPastedIndex', () => {
  it('starts at 1 with nothing attached and nothing issued', () => {
    expect(reserveNextPastedIndex(PASTED_IMAGE_PREFIX, [], 0)).toBe(1);
  });

  it('continues past filenames already attached', () => {
    expect(reserveNextPastedIndex(PASTED_IMAGE_PREFIX, ['pasted-image-1.png'], 0)).toBe(2);
  });

  it('never reissues an index while the list is still stale', () => {
    // The exact regression: the first paste has been saved (so the high-water
    // mark is 1) but the attachment list the handler closed over has not caught
    // up yet. The old count-based scheme returned 1 here a second time.
    expect(reserveNextPastedIndex(PASTED_IMAGE_PREFIX, [], 1)).toBe(2);
  });

  it('keeps advancing across a burst of pastes that have not saved yet', () => {
    let issued = 0;
    const reserved: number[] = [];
    for (let paste = 0; paste < 4; paste += 1) {
      issued = reserveNextPastedIndex(PASTED_IMAGE_PREFIX, [], issued);
      reserved.push(issued);
    }

    expect(reserved).toEqual([1, 2, 3, 4]);
    expect(new Set(reserved).size).toBe(reserved.length);
  });

  it('numbers images and other files independently', () => {
    const existing = ['pasted-image-1.png', 'pasted-image-2.png'];

    expect(reserveNextPastedIndex(PASTED_IMAGE_PREFIX, existing, 2)).toBe(3);
    expect(reserveNextPastedIndex(PASTED_FILE_PREFIX, existing, 0)).toBe(1);
  });

  it('resumes from the highest saved index when the ref is fresh after a remount', () => {
    // A reopened dialog starts with issuedHighest at 0 but real attachments
    // loaded from disk, so the existing filenames have to be consulted.
    expect(reserveNextPastedIndex(PASTED_IMAGE_PREFIX, ['pasted-image-7.png'], 0)).toBe(8);
  });

  it('ignores gaps left by removed attachments rather than refilling them', () => {
    // Refilling a gap would collide with the removed file's name if an undo or
    // a late save ever brought it back; unique beats gapless.
    expect(reserveNextPastedIndex(PASTED_IMAGE_PREFIX, ['pasted-image-1.png', 'pasted-image-3.png'], 0)).toBe(4);
  });

  it('ignores unrelated and lookalike filenames', () => {
    const existing = ['screenshot.png', 'pasted-image-notanumber.png', 'pasted-images-9.png'];

    expect(reserveNextPastedIndex(PASTED_IMAGE_PREFIX, existing, 0)).toBe(1);
  });

  it('does not treat the prefix as a regular expression', () => {
    // Guards the escaping in the matcher: a prefix with regex metacharacters
    // must match literally, not as a pattern.
    expect(reserveNextPastedIndex('a.b-', ['axb-4.png'], 0)).toBe(1);
    expect(reserveNextPastedIndex('a.b-', ['a.b-4.png'], 0)).toBe(5);
  });
});
