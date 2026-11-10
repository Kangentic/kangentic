import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseKeyFileText, readKeyFile } from '../../src/main/accounts/key-file';

describe('parseKeyFileText', () => {
  const allowed = ['API_KEY'];

  it('drops a comment after a closing quote', () => {
    expect(parseKeyFileText('API_KEY="sk-1" # work', allowed).values.API_KEY).toBe('sk-1');
    expect(parseKeyFileText("API_KEY='sk-1' # work", allowed).values.API_KEY).toBe('sk-1');
  });

  it('drops a space-separated comment from an unquoted value', () => {
    expect(parseKeyFileText('API_KEY=sk-1 # note', allowed).values.API_KEY).toBe('sk-1');
  });

  it('keeps a hash with no space before it inside an unquoted value', () => {
    expect(parseKeyFileText('API_KEY=sk#1', allowed).values.API_KEY).toBe('sk#1');
  });

  it('keeps a hash inside quotes', () => {
    expect(parseKeyFileText('API_KEY="sk # 1"', allowed).values.API_KEY).toBe('sk # 1');
  });

  it('reads CRLF lines without a trailing carriage return', () => {
    const parsed = parseKeyFileText('# header\r\nAPI_KEY=sk-1\r\nOTHER=x\r\n', allowed);
    expect(parsed.values).toEqual({ API_KEY: 'sk-1' });
    expect(parsed.names).toEqual(['API_KEY']);
  });

  it('reads an exported name', () => {
    expect(parseKeyFileText('export API_KEY=sk-1', allowed).values.API_KEY).toBe('sk-1');
  });

  it('takes every name with an allowed prefix, in file order, and ignores other names', () => {
    const parsed = parseKeyFileText('OPENROUTER_API_KEY=a\nUNRELATED=b\nOPENROUTER_BASE=c\n', ['OPENROUTER_*']);
    expect(parsed.names).toEqual(['OPENROUTER_API_KEY', 'OPENROUTER_BASE']);
    expect(parsed.values).toEqual({ OPENROUTER_API_KEY: 'a', OPENROUTER_BASE: 'c' });
  });

  it('skips an empty value', () => {
    expect(parseKeyFileText('API_KEY=\nAPI_KEY=""', allowed).names).toEqual([]);
  });
});

describe('readKeyFile', () => {
  let folder: string;

  beforeEach(() => {
    folder = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-key-file-'));
  });

  afterEach(() => {
    fs.rmSync(folder, { recursive: true, force: true });
  });

  it('is null for a missing file', () => {
    expect(readKeyFile(path.join(folder, 'missing.env'), ['API_KEY'])).toBeNull();
  });

  it('is null for a file with none of the allowed names', () => {
    const file = path.join(folder, 'other.env');
    fs.writeFileSync(file, 'UNRELATED=1\n# API_KEY=commented\n');
    expect(readKeyFile(file, ['API_KEY'])).toBeNull();
  });

  it('returns the names and values of a file that has one', () => {
    const file = path.join(folder, 'work.env');
    fs.writeFileSync(file, 'API_KEY=sk-1\n');
    expect(readKeyFile(file, ['API_KEY'])).toEqual({ names: ['API_KEY'], values: { API_KEY: 'sk-1' } });
  });
});
