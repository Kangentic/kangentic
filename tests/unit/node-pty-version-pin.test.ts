/**
 * Sentry DESKTOP-1V: node-pty 1.1.0 keeps every ConPTY in one static vector
 * with no lock (src/win/conpty.cc), and each PTY's exit thread erased from it
 * with `remove_if` then `erase`. Two exits at once let one thread read a
 * moved-out `unique_ptr`, and the pty host died with every terminal in it
 * (scripts/probe-conpty-exit-race.js reproduces it). 1.2.0-beta.13 put
 * `g_ptyHandlesMutex` around every access.
 *
 * npm's `latest` is still 1.1.0 and a caret range never resolves to a
 * prerelease, so the fix rests on an exact pin. These fail when a range, a
 * lockfile refresh, or a node-pty without the lock would bring the crash back.
 *
 * The tarball ships src/win on every platform, so this runs on Linux CI, which
 * never loads conpty.node.
 *
 * Tier: Unit.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const REPOSITORY_ROOT = path.join(__dirname, '..', '..');
const NODE_PTY_ROOT = path.dirname(require.resolve('node-pty/package.json'));

interface PackageManifest {
  version: string;
  dependencies?: Record<string, string>;
}

interface Lockfile {
  packages: Record<string, { version?: string }>;
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
}

describe('node-pty carries the ConPTY handle lock (DESKTOP-1V)', () => {
  it('is pinned to one exact version, the one the lockfile resolves and npm installed', () => {
    const declared = readJson<PackageManifest>(path.join(REPOSITORY_ROOT, 'package.json')).dependencies?.['node-pty'];
    expect(declared, 'node-pty must be an exact version, not a range').toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/);
    const locked = readJson<Lockfile>(path.join(REPOSITORY_ROOT, 'package-lock.json')).packages['node_modules/node-pty']?.version;
    expect(locked).toBe(declared);
    expect(readJson<PackageManifest>(path.join(NODE_PTY_ROOT, 'package.json')).version).toBe(declared);
  });

  it('locks every access to the handle list, the exit thread\'s erase included', () => {
    const source = fs.readFileSync(path.join(NODE_PTY_ROOT, 'src', 'win', 'conpty.cc'), 'utf8');
    const exitThreadStart = source.indexOf('void SetupExitCallback(');
    const exitThreadEnd = source.indexOf('Napi::Error errorWithCode(');
    // Not vacuous. This is the file that holds the list and the exit thread.
    expect(source).toContain('static std::vector<std::unique_ptr<pty_baton>> ptyHandles;');
    expect(exitThreadStart).toBeGreaterThan(0);
    expect(exitThreadEnd).toBeGreaterThan(exitThreadStart);

    expect(source).toContain('static std::mutex g_ptyHandlesMutex;');
    // The exit thread erases under the lock. 1.1.0 called the unlocked
    // remove_pty_baton here, which is where every DESKTOP-1V dump stopped.
    expect(source.slice(exitThreadStart, exitThreadEnd)).toMatch(
      /WaitForSingleObject\(baton->hShell, INFINITE\);\s*\{\s*std::lock_guard<std::mutex> lock\(g_ptyHandlesMutex\);[\s\S]*?std::erase_if\(ptyHandles,/,
    );
    expect(source).not.toContain('remove_pty_baton');
    // A spawn appends under it, and the lookup the kill, resize, clear and
    // connect paths use cannot be called without holding it.
    expect(source).toMatch(/std::lock_guard<std::mutex> lock\(g_ptyHandlesMutex\);\s*ptyHandles\.emplace_back\(/);
    expect(source).toContain('static pty_baton* get_pty_baton(const std::lock_guard<std::mutex>&, int id)');
  });
});
