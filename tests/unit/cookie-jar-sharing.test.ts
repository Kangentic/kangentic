/**
 * Enforces .claude/rules/cookie-jar-sharing.md: browser jar cookies are copied
 * only through cookie-seed.ts, and the localhost exclusion (isLocalCookieDomain)
 * cannot be silently removed. A stray cookie-copy path, or a copy that skips the
 * localhost check, would leak one task's dev-server session into another's jar.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { hasOptOutMarker } from './helpers/opt-out-marker';

const SRC_ROOT = path.join(__dirname, '..', '..', 'src');
const OPT_OUT = 'cookie-copy-ok';

// Files sanctioned to call the cookie API directly (paths relative to src/).
const ALLOWLIST = new Set([
  path.join('main', 'browser', 'cookie-seed.ts'),
  path.join('main', 'browser', 'jar-seeder.ts'),
  path.join('devtools', 'main', 'cookie-jar-routes.ts'),
]);

// Tolerates a line-wrapped `.cookies\n  .set(` by allowing whitespace between
// tokens, so it is matched against whole file text rather than line by line.
// Global, because every call site is exempted on its own line and the scan has
// to walk them all; `lastIndex` is reset per file below.
const COOKIE_API_RE = /\.cookies\s*\.\s*(?:set|get)\s*\(/g;

/**
 * The line a match starts on, so a wrapped call anchors its marker at the
 * `.cookies` line rather than at whichever line the `(` landed on.
 */
function lineIndexOfOffset(content: string, offset: number): number {
  let lineIndex = 0;
  for (let scan = 0; scan < offset; scan++) {
    if (content[scan] === '\n') lineIndex++;
  }
  return lineIndex;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile() && (full.endsWith('.ts') || full.endsWith('.tsx'))) out.push(full);
  }
  return out;
}

describe('cookie-jar-sharing rule', () => {
  it('no file outside the allowlist reads or writes jar cookies directly', () => {
    // Exempted per CALL SITE, not per file. This used to waive a whole file on
    // one bare `cookie-copy-ok:` anywhere in it, so a second, unreviewed cookie
    // call added later inherited the first one's exemption in silence.
    const offenders: string[] = [];
    for (const file of walk(SRC_ROOT)) {
      const relative = path.relative(SRC_ROOT, file);
      if (ALLOWLIST.has(relative)) continue;
      const content = fs.readFileSync(file, 'utf-8');
      const lines = content.split('\n');
      COOKIE_API_RE.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = COOKIE_API_RE.exec(content)) !== null) {
        const lineIndex = lineIndexOfOffset(content, match.index);
        if (hasOptOutMarker(lines, lineIndex, OPT_OUT)) continue;
        offenders.push(`${relative}:${lineIndex + 1}`);
      }
    }
    expect(
      offenders,
      'Route jar cookie access through cookie-seed.ts, or mark the call site (or the comment\n'
      + `block directly above it) "// ${OPT_OUT}: <reason>" - the reason is required:\n`
      + offenders.join('\n'),
    ).toEqual([]);
  });

  it('cookie-seed.ts defines the single localhost exclusion and copyCookies uses it', () => {
    const seed = fs.readFileSync(path.join(SRC_ROOT, 'main', 'browser', 'cookie-seed.ts'), 'utf-8');
    expect(seed).toMatch(/export function isLocalCookieDomain/);
    // Referenced at least twice: the definition and its use inside copyCookies.
    expect((seed.match(/isLocalCookieDomain\(/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it('the jar-seeder write-back excludes localhost via the shared check', () => {
    const seeder = fs.readFileSync(path.join(SRC_ROOT, 'main', 'browser', 'jar-seeder.ts'), 'utf-8');
    expect(seeder).toMatch(/isLocalCookieDomain\(/);
  });
});
