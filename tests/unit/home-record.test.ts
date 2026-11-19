import { describe, expect, it } from 'vitest';
import { countReplaced, fileParts, hashParts } from '../../src/main/accounts/home-record';

describe('fileParts', () => {
  it('reads non-JSON text with CRLF and LF line endings as the same content', () => {
    expect(hashParts(fileParts('# Notes\r\nline two\r\n'))).toEqual(hashParts(fileParts('# Notes\nline two\n')));
  });

  it('reads text that differs in a word as different content', () => {
    expect(hashParts(fileParts('# Notes\nline two\n'))).not.toEqual(hashParts(fileParts('# Notes\nline 2\n')));
  });
});

describe('countReplaced', () => {
  const held = hashParts({ a: 1, b: 2 });

  it('counts nothing when nothing was recorded for the entry', () => {
    expect(countReplaced(undefined, { a: 9 }, { a: 1 })).toBe(0);
  });

  it('counts a part the account changed that the refresh writes over', () => {
    expect(countReplaced(held, { a: 9, b: 2 }, { a: 1, b: 2 })).toBe(1);
  });

  it('counts nothing when the account kept what the home held', () => {
    expect(countReplaced(held, { a: 1, b: 2 }, { a: 5, b: 2 })).toBe(0);
  });

  it('counts nothing when the refresh keeps the account change', () => {
    expect(countReplaced(held, { a: 9, b: 2 }, { a: 9, b: 2 })).toBe(0);
  });

  it('counts a part the account removed when the refresh brings it back', () => {
    expect(countReplaced(held, { b: 2 }, { a: 1, b: 2 })).toBe(1);
  });

  it('counts a part only the account holds when the refresh drops it', () => {
    expect(countReplaced(held, { a: 1, b: 2, extra: 7 }, { a: 1, b: 2 })).toBe(1);
  });

  it('treats a null record as the home having held nothing', () => {
    expect(countReplaced(null, { a: 1 }, {})).toBe(1);
    expect(countReplaced(null, {}, { a: 1 })).toBe(0);
  });
});
