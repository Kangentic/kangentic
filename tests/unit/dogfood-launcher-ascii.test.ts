import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// scripts/dogfood-launcher.ps1 is read by Windows PowerShell 5.1, which decodes a BOM-less UTF-8
// file as the ANSI code page. A single non-ASCII character in it is mangled on the machines it
// exists for. The shortcut name's .gitignore coupling is pinned separately in
// dogfood-launcher-gitignore-parity.test.ts.

const LAUNCHER_SCRIPT = path.resolve(__dirname, '../../scripts/dogfood-launcher.ps1');

describe('dogfood launcher encoding', () => {
  it('the script is plain ASCII, so Windows PowerShell 5.1 reads it intact', () => {
    // eslint-disable-next-line no-control-regex -- the point is to match everything outside 0x00-0x7F
    const nonAscii = [...fs.readFileSync(LAUNCHER_SCRIPT, 'utf-8')].filter((character) => /[^\x00-\x7F]/.test(character));
    expect(nonAscii).toEqual([]);
  });
});
