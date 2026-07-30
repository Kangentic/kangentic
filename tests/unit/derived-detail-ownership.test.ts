/**
 * Task-detail ownership must stay DERIVED.
 *
 * Ownership used to be incremental: a host sent `claim` when it mounted a detail
 * window and `release` when that window closed, and main trusted the resulting map
 * forever. Any path that lost the release stranded a claim, and a stranded claim
 * made the task answer `focused-existing` for a window that no longer existed -
 * permanently unopenable, silently, with nothing on screen to explain it. Two such
 * paths were found in one afternoon (a layer that unmounts while its window store
 * survives, and a restored workspace nothing announced).
 *
 * The fix is that a host reports the COMPLETE set it has mounted and main
 * reconciles. That property is only worth anything if nobody quietly reintroduces
 * per-window bookkeeping later, which is what this scan is for.
 *
 * Most of the guarantee is already structural - `claim` / `release` do not exist on
 * the preload API, so calling them is a compile error. These checks cover what the
 * type system cannot see.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../..');

function read(relativePath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf-8');
}

/** Every `.ts` / `.tsx` file under a directory, recursively, excluding this file -
 *  a scan that names the patterns it forbids otherwise flags itself. */
function sourceFiles(relativeDir: string): string[] {
  const root = path.join(REPO_ROOT, relativeDir);
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name) && full !== __filename) found.push(full);
    }
  };
  walk(root);
  return found;
}

/** Source with comments removed, so prose explaining a retired pattern (including
 *  the doc comment that records WHY it was retired) is never read as a usage. */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
}

describe('task-detail ownership stays derived', () => {
  it('only syncOwned and releaseAllFor mutate the owner map', () => {
    // The registry is the chokepoint: any OTHER writer is incremental bookkeeping
    // by definition, whatever it is called.
    const source = read('src/main/task-detail/detail-owner-registry.ts');
    const methodBodies = source.split(/^\s{2}(?=[a-zA-Z_]+[(<])/m);

    const writers = methodBodies
      .filter((body) => /this\.owners\.(set|delete)\(/.test(body))
      .map((body) => body.match(/^([a-zA-Z_]+)/)?.[1] ?? 'unknown');

    expect(
      [...new Set(writers)].sort(),
      'Something other than syncOwned / releaseAllFor writes the owner map. '
      + 'Ownership must be derived from a host\'s reported set, not accumulated from '
      + 'individual mutations - that is what stranded a claim and made a task '
      + 'permanently unopenable.',
    ).toEqual(['releaseAllFor', 'syncOwned']);
  });

  it('the retired claim/release channels do not come back', () => {
    const offenders: string[] = [];
    for (const file of [...sourceFiles('src'), ...sourceFiles('tests')]) {
      if (!/DETAIL_CLAIM|DETAIL_RELEASE\b/.test(code(fs.readFileSync(file, 'utf-8')))) continue;
      offenders.push(path.relative(REPO_ROOT, file).replace(/\\/g, '/'));
    }
    expect(
      offenders,
      'DETAIL_CLAIM / DETAIL_RELEASE were removed deliberately. A per-detail claim or '
      + 'release channel reintroduces the bug class; report the full set with '
      + 'DETAIL_SYNC_OWNED instead. Offenders:\n' + offenders.join('\n'),
    ).toEqual([]);
  });

  it('exactly one renderer module reports ownership', () => {
    // Mirrors central-embedding-engine's "only embed-engine.ts embeds". One reporter
    // means one place that can get the derivation wrong, and one place to read.
    const reporters: string[] = [];
    for (const file of sourceFiles('src/renderer')) {
      const source = fs.readFileSync(file, 'utf-8');
      if (!/\.syncOwned\(/.test(source)) continue;
      reporters.push(path.relative(REPO_ROOT, file).replace(/\\/g, '/'));
    }
    expect(
      reporters,
      'Ownership must be reported only by the shared hook, which derives the whole set '
      + 'from a window store. A second caller can report a partial set, which reads as '
      + '"I no longer host these" and frees windows that are still open.',
    ).toEqual(['src/renderer/window-manager/bridge/useDetailOwnershipSync.ts']);
  });

  it('the reporter is mounted only where it outlives the window store', () => {
    // The bug this refactor fixed: the monitor's handlers lived inside a layer that
    // unmounts on close/detach while `monitorWindowManager`'s windows survive, so a
    // window stayed owned with nobody left to report on it or hear CLOSE_HERE.
    // Every mount site must therefore be renderer-lifetime, never inside a layer.
    const allowed = [
      'src/renderer/components/monitor/useMonitorDetailOwnership.ts',
      'src/renderer/window-manager/components/WindowLayer.tsx',
    ];
    const callSites: string[] = [];
    for (const file of sourceFiles('src/renderer')) {
      const source = fs.readFileSync(file, 'utf-8');
      if (!/useDetailOwnershipSync\(\{/.test(source)) continue;
      callSites.push(path.relative(REPO_ROOT, file).replace(/\\/g, '/'));
    }
    expect(
      callSites.sort(),
      'A new ownership host must be added deliberately, and mounted somewhere that '
      + 'outlives the window store it describes (a renderer root, not a layer).',
    ).toEqual(allowed);
  });

  it('the retired per-window bookkeeping identifiers do not reappear', () => {
    const retired = ['claimedRef', 'claimedAnchors', 'reconcileClaims'];
    const offenders: string[] = [];
    for (const file of sourceFiles('src/renderer')) {
      const source = code(fs.readFileSync(file, 'utf-8'));
      for (const identifier of retired) {
        if (!new RegExp(`\\b${identifier}\\b`).test(source)) continue;
        offenders.push(`${path.relative(REPO_ROOT, file).replace(/\\/g, '/')} -> ${identifier}`);
      }
    }
    expect(
      offenders,
      'These are the names of the bookkeeping that derived sync replaced. If one is '
      + 'back, so is the bug. Offenders:\n' + offenders.join('\n'),
    ).toEqual([]);
  });
});
