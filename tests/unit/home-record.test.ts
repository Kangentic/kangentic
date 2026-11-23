import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { countReplaced, fileParts, hashParts, HOME_RECORD_FILE, loadHomeRecord } from '../../src/main/accounts/home-record';

describe('the home record file', () => {
  let folder: string;
  let recordPath: string;
  const absoluteHome = path.resolve(os.tmpdir(), 'some-default-home');

  beforeEach(() => {
    folder = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-home-record-'));
    recordPath = path.join(folder, HOME_RECORD_FILE);
  });

  afterEach(() => {
    fs.rmSync(folder, { recursive: true, force: true });
  });

  it('loads the linked home of a record that holds no entries', () => {
    fs.writeFileSync(recordPath, JSON.stringify({ version: 1, linkedHome: absoluteHome }));
    expect(loadHomeRecord(folder).linkedHome()).toBe(absoluteHome);
  });

  it.each([
    ['a relative path', 'relative/home'],
    ['a non-string value', 42],
  ])('loads %s as no linked home', (_label, linkedHome) => {
    fs.writeFileSync(recordPath, JSON.stringify({ version: 1, linkedHome }));
    expect(loadHomeRecord(folder).linkedHome()).toBeNull();
  });

  it('loads a record from before the linked home with its entries intact and no home', () => {
    const held = hashParts({ a: 1 });
    fs.writeFileSync(recordPath, JSON.stringify({ version: 1, entries: { 'settings.json': held } }));
    const record = loadHomeRecord(folder);
    expect(record.linkedHome()).toBeNull();
    expect(record.get('settings.json')).toEqual(held);
  });

  it('writes a linked home set on a fresh folder, and reads it back', () => {
    const record = loadHomeRecord(folder);
    record.setLinkedHome(absoluteHome);
    record.save();
    expect(JSON.parse(fs.readFileSync(recordPath, 'utf8')).linkedHome).toBe(absoluteHome);
    expect(loadHomeRecord(folder).linkedHome()).toBe(absoluteHome);
  });

  it('does not rewrite a record that nothing changed', () => {
    const first = loadHomeRecord(folder);
    first.setLinkedHome(absoluteHome);
    first.save();
    // Marker content a rewrite would remove: a save that skips leaves it as it is.
    const marked = `${fs.readFileSync(recordPath, 'utf8')}\n`;
    fs.writeFileSync(recordPath, marked);
    const second = loadHomeRecord(folder);
    second.save();
    expect(fs.readFileSync(recordPath, 'utf8')).toBe(marked);
    // The same home set again is no change either.
    second.setLinkedHome(absoluteHome);
    second.save();
    expect(fs.readFileSync(recordPath, 'utf8')).toBe(marked);
  });

  it('writes no file for a fresh folder with nothing set', () => {
    loadHomeRecord(folder).save();
    expect(fs.existsSync(recordPath)).toBe(false);
  });
});

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
