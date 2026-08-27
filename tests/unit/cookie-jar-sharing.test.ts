/**
 * Enforces .claude/rules/cookie-jar-sharing.md: browser jar cookies are copied
 * only through cookie-seed.ts, and the localhost exclusion (isLocalCookieDomain)
 * cannot be silently removed. A stray cookie-copy path, or a copy that skips the
 * localhost check, would leak one task's dev-server session into another's jar.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SRC_ROOT = path.join(__dirname, '..', '..', 'src');

// Files sanctioned to call the cookie API directly (paths relative to src/).
const ALLOWLIST = new Set([
  path.join('main', 'browser', 'cookie-seed.ts'),
  path.join('main', 'browser', 'jar-seeder.ts'),
  path.join('devtools', 'main', 'cookie-jar-routes.ts'),
]);

// Tolerates a line-wrapped `.cookies\n  .set(` by allowing whitespace between tokens.
const COOKIE_API_RE = /\.cookies\s*\.\s*(?:set|get)\s*\(/;

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
    const offenders: string[] = [];
    for (const file of walk(SRC_ROOT)) {
      const relative = path.relative(SRC_ROOT, file);
      if (ALLOWLIST.has(relative)) continue;
      const content = fs.readFileSync(file, 'utf-8');
      if (COOKIE_API_RE.test(content) && !content.includes('cookie-copy-ok:')) {
        offenders.push(relative);
      }
    }
    expect(offenders, `route jar cookie access through cookie-seed.ts (or mark // cookie-copy-ok:): ${offenders.join(', ')}`).toEqual([]);
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
