/**
 * Completeness guard for the PREVIEW_STORES registry in
 * src/devtools/renderer/state-mirror.ts.
 *
 * The dev-only `kangentic_devtools_store_state` tool can only read stores
 * listed in PREVIEW_STORES. A new Zustand store is therefore silently
 * unreadable until it is registered there. This test fails CI if any
 * `src/renderer/stores/*-store.ts` is missing from the registry, turning
 * a "forgot to register" drift into a red build instead of a confusing
 * gap discovered at /preview time.
 *
 * It is a static source scan (not an import) so it stays a plain-node
 * unit test without pulling in the renderer store graph.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../..');
const STATE_MIRROR_PATH = path.join(REPO_ROOT, 'src/devtools/renderer/state-mirror.ts');
const STORE_DIR = path.join(REPO_ROOT, 'src/renderer/stores');

/**
 * Stores intentionally excluded from PREVIEW_STORES. Keep empty unless a
 * `*-store.ts` genuinely should not be agent-readable; add a comment with
 * the reason when adding one.
 */
const INTENTIONAL_EXCLUSIONS = new Set<string>();

function registeredStoreNames(): string[] {
  const source = fs.readFileSync(STATE_MIRROR_PATH, 'utf-8');
  const block = source.match(/const PREVIEW_STORES[^=]*=\s*\{([\s\S]*?)\};/);
  if (!block) throw new Error('Could not locate the PREVIEW_STORES object literal in state-mirror.ts.');
  // Keys are the store name -> a bare identifier (`board:`) OR, for a
  // kebab-case store file, a quoted key (`'usage-dashboard':`). Match both so
  // the guard covers multi-word store filenames, not just single-word ones.
  return [...block[1].matchAll(/['"]?([\w-]+)['"]?\s*:/g)].map((match) => match[1]);
}

function storeFileNames(): string[] {
  return fs
    .readdirSync(STORE_DIR)
    .filter((entry) => entry.endsWith('-store.ts'))
    .map((entry) => entry.replace(/-store\.ts$/, ''));
}

describe('PREVIEW_STORES registry completeness', () => {
  it('registers every src/renderer/stores/*-store.ts', () => {
    const registered = new Set(registeredStoreNames());
    const expected = storeFileNames().filter((name) => !INTENTIONAL_EXCLUSIONS.has(name));
    const missing = expected.filter((name) => !registered.has(name));
    expect(missing, `Unregistered stores (add to PREVIEW_STORES in state-mirror.ts): ${missing.join(', ')}`).toEqual([]);
  });

  it('finds at least the known core stores', () => {
    // Sanity check that the scan actually parsed something, so a regex
    // regression cannot make the test vacuously pass.
    const registered = registeredStoreNames();
    expect(registered).toEqual(expect.arrayContaining(['board', 'session', 'config']));
  });
});
