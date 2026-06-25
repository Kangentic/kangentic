/**
 * Drift guards for the shipped browser-automation surface (see
 * .claude/rules/browser-automation-driver.md):
 *
 *  1. SINGLE CDP DRIVER - every `webContents.debugger.*` call goes through the
 *     one shipped module `src/main/browser/cdp/cdp.ts`. A second copy would let
 *     the two consumers (the user-facing browser-pane driver and the dev-only
 *     inspection bridge) diverge.
 *
 *  2. SHIPPED STAYS SHIPPED - the shipped browser-automation code must never
 *     import the dev-only `src/devtools/` tree (which is build-excluded from
 *     production via __KANGENTIC_DEV__). A prod -> dev import would drag dev
 *     tooling into the product bundle.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_DIR = fileURLToPath(new URL('../../src', import.meta.url));

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile() && /\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

function relative(file: string): string {
  return path.relative(SRC_DIR, file).split(path.sep).join('/');
}

describe('browser-automation invariants', () => {
  const allFiles = walk(SRC_DIR);

  it('routes every CDP debugger call through the single shipped driver', () => {
    const offenders = allFiles.filter((file) => {
      if (relative(file) === 'main/browser/cdp/cdp.ts') return false;
      return /\.debugger\.(sendCommand|attach|detach|on|removeListener)\b/.test(
        fs.readFileSync(file, 'utf-8'),
      );
    });
    expect(offenders.map(relative)).toEqual([]);
  });

  it('keeps the shipped browser-automation code free of src/devtools imports', () => {
    const shipped = allFiles.filter((file) => {
      const rel = relative(file);
      return (
        rel.startsWith('main/browser/') ||
        rel === 'main/agent/mcp-http/browser-tools.ts' ||
        rel === 'main/agent/mcp-http/tool-result.ts'
      );
    });
    const offenders = shipped.filter((file) =>
      /(from|require\()\s*['"][^'"]*devtools[^'"]*['"]/.test(fs.readFileSync(file, 'utf-8')),
    );
    expect(offenders.map(relative)).toEqual([]);
  });
});
