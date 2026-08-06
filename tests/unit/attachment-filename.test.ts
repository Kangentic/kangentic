/**
 * Unit tests for the shared attachment on-disk naming helpers
 * (src/shared/attachment-filename.ts).
 *
 * Both AttachmentRepository and BacklogAttachmentRepository derive an
 * attachment's disk filename from `attachmentDiskName(id, filename)`, and
 * the win32 branch of the attachment-open helper reuses the same builder to
 * name its temp copy. Board imports name attachments from a remote URL path
 * or issue alt text, neither of which is length-bounded, so the 255-char
 * clamp and its extension-preserving truncation are pinned here.
 *
 * Tier: Unit (vitest, no browser, no Electron, no filesystem).
 */
import { describe, it, expect } from 'vitest';
import { sanitizeAttachmentFilename, attachmentDiskName } from '../../src/shared/attachment-filename';

describe('sanitizeAttachmentFilename', () => {
  it('passes a safe name through unchanged', () => {
    expect(sanitizeAttachmentFilename('report.pdf')).toBe('report.pdf');
    expect(sanitizeAttachmentFilename('file-name_v2.1.tar.gz')).toBe('file-name_v2.1.tar.gz');
  });

  it('replaces reserved characters with an underscore', () => {
    expect(sanitizeAttachmentFilename('a:b')).toBe('a_b');
    expect(sanitizeAttachmentFilename('a/b\\c')).toBe('a_b_c');
    expect(sanitizeAttachmentFilename('a*b?c"d<e>f|g')).toBe('a_b_c_d_e_f_g');
  });

  it('replaces spaces', () => {
    expect(sanitizeAttachmentFilename('my report (v2).pdf')).toBe('my_report__v2_.pdf');
  });

  it('replaces unicode characters that fall outside the safe set', () => {
    expect(sanitizeAttachmentFilename('café.png')).toBe('caf_.png');
    expect(sanitizeAttachmentFilename('日本.txt')).toBe('__.txt');
  });

  it('returns an empty string for an empty input', () => {
    expect(sanitizeAttachmentFilename('')).toBe('');
  });
});

describe('attachmentDiskName', () => {
  it('composes exactly `${id}_${sanitized filename}` for a normal name', () => {
    expect(attachmentDiskName('a1', 'report.pdf')).toBe('a1_report.pdf');
    expect(attachmentDiskName('task-99', 'My File (v2).png')).toBe('task-99_My_File__v2_.png');
  });

  it('returns a name that already fits within the limit untouched', () => {
    const filename = 'report.pdf';
    const diskName = attachmentDiskName('a1', filename);
    expect(diskName.length).toBeLessThanOrEqual(255);
    expect(diskName).toBe('a1_report.pdf');
  });

  it('caps an over-long name at exactly 255 characters', () => {
    const longFilename = 'x'.repeat(300) + '.pdf';
    const diskName = attachmentDiskName('a1', longFilename);

    expect(diskName.length).toBe(255);
  });

  it('preserves the trailing extension when truncating', () => {
    const longFilename = 'x'.repeat(300) + '.pdf';
    const diskName = attachmentDiskName('a1', longFilename);

    expect(diskName.endsWith('.pdf')).toBe(true);
    expect(diskName.length).toBe(255);
  });

  it('treats an absurdly long "extension" (over 16 chars) as having none', () => {
    const bogusExtension = '.' + 'y'.repeat(20); // 21 chars, over the 16-char cutoff
    const longFilename = 'x'.repeat(300) + bogusExtension;
    const diskName = attachmentDiskName('a1', longFilename);

    expect(diskName.length).toBe(255);
    // The 'y' run only appears past character 300, well beyond the clamp -
    // if the bogus extension had been preserved, the result would end with
    // it instead of being cut off mid-run of 'x' characters.
    expect(diskName.includes('y')).toBe(false);
    expect(diskName.endsWith('x')).toBe(true);
  });
});
