/**
 * The Copy files and Link folders fields hold their lists as one line of text.
 * A plain split on commas turned `*.{local,dev}.json` into two broken globs.
 */
import { describe, it, expect } from 'vitest';
import { splitPathList } from '../../src/shared/split-path-list';

describe('splitPathList', () => {
  it('splits, trims and drops empty entries', () => {
    expect(splitPathList('.env, , .env.local,')).toEqual(['.env', '.env.local']);
  });

  it('keeps a comma inside braces with its glob, nested braces included', () => {
    expect(splitPathList('*.{local,dev}.json, config/{a,{b,c}}/*.env')).toEqual(['*.{local,dev}.json', 'config/{a,{b,c}}/*.env']);
  });

  it('round-trips through the join the field shows', () => {
    const entries = ['.env', 'config/local', '*.{local,dev}.json'];
    expect(splitPathList(entries.join(', '))).toEqual(entries);
  });

  it('still splits after a stray closing brace', () => {
    expect(splitPathList('a}, b')).toEqual(['a}', 'b']);
  });

  it('is empty for an empty field', () => {
    expect(splitPathList('  ')).toEqual([]);
  });
});
