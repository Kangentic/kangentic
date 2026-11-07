/**
 * /upgrade-deps decides from version numbers what may move, so a wrong answer here files a task that
 * downgrades a crash fix or spends a research pass nobody needed. The downgrade cases are the ones
 * npm's own `outdated` report gets wrong for this repo: `latest` for node-pty and every @xterm
 * package sits behind the beta we run.
 *
 * Tier: Unit.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildInventory,
  CACHE_FOLDER,
  changeKind,
  chooseTarget,
  collectDeclared,
  diffLockfile,
  groupOf,
  newPeerConflicts,
  researchState,
  splitAudit,
  supplyChainSignals,
  targetsAgree,
  watchedVersion,
  withBlocker,
} from '../../scripts/upgrade-deps.mjs';

const NOW = Date.parse('2026-11-06T12:00:00.000Z');
const OLD = '2026-09-01T00:00:00.000Z';

function versionsOf(...versions: string[]): Record<string, { deprecated?: string }> {
  return Object.fromEntries(versions.map((version) => [version, {}]));
}

function timesOf(...versions: string[]): Record<string, string> {
  return Object.fromEntries(versions.map((version) => [version, OLD]));
}

function choose(installed: string, latest: string, versions: string[]) {
  return chooseTarget({ installed, distTags: { latest }, versions: versionsOf(...versions) });
}

describe('the research cache', () => {
  it('is gitignored, so briefs never reach the public repo', () => {
    const gitignore = fs.readFileSync(path.join(__dirname, '..', '..', '.gitignore'), 'utf8');
    expect(gitignore.split(/\r?\n/)).toContain(`${CACHE_FOLDER}/`);
  });
});

describe('chooseTarget', () => {
  it('never moves a prerelease pin down to a lower latest', () => {
    expect(choose('1.2.0-beta.15', '1.1.0', ['1.0.0', '1.1.0', '1.2.0-beta.15'])).toBeNull();
  });

  it('follows a prerelease pin along its own channel', () => {
    const versions = ['1.1.0', '1.2.0-alpha.99', '1.2.0-beta.15', '1.2.0-beta.20'];
    expect(choose('1.2.0-beta.15', '1.1.0', versions)).toBe('1.2.0-beta.20');
  });

  it('takes the stable release of a prerelease line once it is latest', () => {
    expect(choose('1.2.0-beta.15', '1.2.0', ['1.2.0-beta.15', '1.2.0-beta.20', '1.2.0'])).toBe('1.2.0');
  });

  it('leaves a beta line for the stable release, not the next line\'s beta', () => {
    const versions = ['1.2.0-beta.15', '1.2.0', '1.3.0-beta.1'];
    expect(choose('1.2.0-beta.15', '1.2.0', versions)).toBe('1.2.0');
  });

  it('never jumps from one prerelease line to a later one', () => {
    expect(choose('1.2.0-beta.15', '1.1.0', ['1.1.0', '1.2.0-beta.15', '1.3.0-beta.1'])).toBeNull();
  });

  it('keeps a stable install off prereleases and past latest', () => {
    const versions = ['6.0.0', '6.0.1', '6.1.0-beta.1', '7.0.0'];
    expect(choose('6.0.0', '6.0.1', versions)).toBe('6.0.1');
  });

  it('follows a stable dist-tag on our own major when latest trails it', () => {
    const target = chooseTarget({
      installed: '26.15.3',
      distTags: { latest: '26.18.0', v26: '26.18.1' },
      versions: versionsOf('26.15.3', '26.18.0', '26.18.1'),
    });
    expect(target).toBe('26.18.1');
  });

  it('ignores a dist-tag for another major', () => {
    const target = chooseTarget({
      installed: '1.0.0',
      distTags: { latest: '1.2.0', v2: '2.0.0' },
      versions: versionsOf('1.0.0', '1.2.0', '2.0.0'),
    });
    expect(target).toBe('1.2.0');
  });

  it('skips a deprecated release', () => {
    const target = chooseTarget({
      installed: '1.0.0',
      distTags: { latest: '1.2.0' },
      versions: { '1.0.0': {}, '1.1.0': {}, '1.2.0': { deprecated: 'broken build' } },
    });
    expect(target).toBe('1.1.0');
  });
});

describe('changeKind', () => {
  it.each([
    ['9.3.5', '10.0.0', 'major'],
    ['0.185.1', '0.187.0', 'major'],
    ['0.7.1', '0.8.0', 'major'],
    ['0.0.3', '0.0.4', 'major'],
    ['1.2.0-beta.15', '1.2.0-beta.20', 'prerelease'],
    ['6.10.1', '6.12.0', 'minor'],
    ['0.8.3', '0.8.4', 'patch'],
    ['45.1.0', '45.2.3', 'minor'],
    ['8.3.5', '8.3.6', 'patch'],
  ])('%s to %s is %s', (installed, target, expected) => {
    expect(changeKind(installed, target)).toBe(expected);
  });
});

describe('groupOf', () => {
  it.each([
    ['@lingui/cli', 'lingui'],
    ['@xterm/addon-webgl', 'xterm'],
    ['tailwindcss', 'tailwind'],
    ['@tailwindcss/vite', 'tailwind'],
    ['@playwright/test', 'playwright'],
    ['@types/three', 'three'],
    ['three', 'three'],
    ['@types/react-dom', 'react'],
    ['@modelcontextprotocol/sdk', 'modelcontextprotocol-sdk'],
    ['electron-updater', 'electron-builder'],
  ])('%s moves with %s', (packageName, expected) => {
    expect(groupOf(packageName)).toBe(expected);
  });

  it('keeps TypeScript apart from eslint, so a blocked major does not hold a patch', () => {
    expect(groupOf('typescript')).not.toBe(groupOf('typescript-eslint'));
  });
});

describe('supplyChainSignals', () => {
  const clean = {
    dependencies: { 'follow-redirects': '^1.0.0' },
    installScripts: [],
    gypfile: false,
    attested: true,
    publisher: 'release-bot',
  };

  it('says nothing when a release changes none of them', () => {
    expect(supplyChainSignals(clean, { ...clean })).toEqual([]);
  });

  it('names the shape of the axios compromise: a new dependency and lost provenance', () => {
    const compromised = {
      ...clean,
      dependencies: { ...clean.dependencies, 'plain-crypto-js': '^4.2.1' },
      attested: false,
      publisher: 'stolen-account',
    };
    expect(supplyChainSignals(clean, compromised)).toEqual([
      'new dependencies (1): plain-crypto-js',
      'provenance dropped',
      'publisher changed: release-bot to stolen-account',
    ]);
  });

  it('catches install-time code with and without an install script', () => {
    expect(supplyChainSignals(clean, { ...clean, installScripts: ['postinstall'] }))
      .toEqual(['new install scripts: postinstall']);
    expect(supplyChainSignals(clean, { ...clean, gypfile: true })).toEqual(['a binding.gyp build appeared']);
  });

  it('caps a long list, so a package with 20 platform builds stays one line', () => {
    const dependencies = Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`platform-${index}`, '1.0.0']));
    const [signal] = supplyChainSignals({ ...clean, dependencies: {} }, { ...clean, dependencies });
    expect(signal.startsWith('new dependencies (20): ')).toBe(true);
    expect(signal.split(', ')).toHaveLength(5);
  });

  it('has nothing to compare when a version is missing', () => {
    expect(supplyChainSignals(undefined, clean)).toEqual([]);
  });
});

describe('targetsAgree', () => {
  const targets = (...versions: string[]) => versions.map((target) => ({ target }));

  it('asks a set published under one number to match exactly', () => {
    expect(targetsAgree('lingui', targets('6.11.0', '6.11.0'))).toBe(true);
    expect(targetsAgree('lingui', targets('6.11.0', '6.12.0'))).toBe(false);
  });

  it('asks a tracking types package for the same minor only', () => {
    expect(targetsAgree('three', targets('0.187.0', '0.187.4'))).toBe(true);
    expect(targetsAgree('three', targets('0.187.0', '0.186.0'))).toBe(false);
  });

  it('leaves alone a group whose members number themselves', () => {
    expect(targetsAgree('xterm', targets('6.1.0-beta.336', '0.20.0-beta.329'))).toBe(true);
  });
});

describe('collectDeclared', () => {
  const lockPackages = {
    'node_modules/electron': { version: '45.1.0' },
    'node_modules/better-sqlite3': { version: '13.0.3' },
    'node_modules/typescript': { version: '6.0.3' },
    'packages/protocol/node_modules/typescript': { version: '6.0.1' },
    'node_modules/kangentic': { link: true },
  };

  it('marks exact pins and runtime dependencies, and reports the lowest of two copies', () => {
    const declared = collectDeclared([
      {
        location: '',
        manifest: {
          dependencies: { 'better-sqlite3': '^13.0.3' },
          devDependencies: { electron: '45.1.0', typescript: '^6.0.3' },
        },
      },
      { location: 'packages/protocol', manifest: { devDependencies: { typescript: '^6.0.1' } } },
    ], lockPackages);

    expect(declared.find(({ name }) => name === 'electron')).toMatchObject({ pinned: true, runtime: false });
    expect(declared.find(({ name }) => name === 'better-sqlite3')).toMatchObject({ pinned: false, runtime: true });
    expect(declared.find(({ name }) => name === 'typescript')).toMatchObject({
      installed: '6.0.1',
      locations: ['.', 'packages/protocol'],
    });
  });

  it('skips a workspace link and a spec that is not a registry range', () => {
    const declared = collectDeclared([{
      location: '',
      manifest: { dependencies: { kangentic: '*', electron: 'github:electron/electron' } },
    }], lockPackages);
    expect(declared).toEqual([]);
  });
});

describe('newPeerConflicts', () => {
  const peers: Record<string, Record<string, string>> = {
    'typescript-eslint@8.72.1': { typescript: '>=4.8.4 <6.1.0' },
    'lib@1.0.0': { react: '^18.0.0' },
    'addon@0.15.0-beta.310': { xterm: '^6.1.0-beta.304' },
  };
  const peersOf = (name: string, version: string) => peers[`${name}@${version}`] ?? {};

  it('reports a major its dependents cannot accept', () => {
    const conflicts = newPeerConflicts(
      { typescript: '6.0.3', 'typescript-eslint': '8.72.1' },
      { typescript: '7.0.2' },
      peersOf,
    );
    expect(conflicts).toEqual(['typescript-eslint@8.72.1 needs typescript >=4.8.4 <6.1.0, planned 7.0.2']);
  });

  it('stays quiet about a conflict the tree already has', () => {
    expect(newPeerConflicts({ lib: '1.0.0', react: '19.2.7' }, { react: '19.2.8' }, peersOf)).toEqual([]);
  });

  it('accepts a prerelease a caret range names', () => {
    const conflicts = newPeerConflicts(
      { addon: '0.15.0-beta.310', xterm: '6.1.0-beta.304' },
      { xterm: '6.1.0-beta.305' },
      peersOf,
    );
    expect(conflicts).toEqual([]);
  });
});

describe('splitAudit', () => {
  it('separates an advisory against a package from one that reached it from below', () => {
    expect(splitAudit({
      vulnerabilities: {
        dompurify: { name: 'dompurify', severity: 'high', isDirect: true, via: [{ source: 1 }] },
        '@sentry/vite-plugin': {
          name: '@sentry/vite-plugin', severity: 'moderate', isDirect: true, via: ['@sentry/bundler-plugin-core'],
        },
        glob: { name: 'glob', severity: 'low', isDirect: false, via: [{ source: 2 }] },
      },
    })).toEqual({
      advisories: { dompurify: 'high' },
      inheritedAdvisories: { '@sentry/vite-plugin': 'moderate' },
      transitiveCount: 1,
    });
  });
});

describe('researchState', () => {
  const targets = { typescript: '7.0.2' };
  const brief = {
    targets,
    verdict: 'ready',
    evaluatedAt: OLD,
  };
  const base = { targets, watchedVersions: {}, refresh: false };

  it('researches a group with no usable brief', () => {
    expect(researchState({ ...base, brief: undefined })).toBe('research');
    expect(researchState({ ...base, brief: { targets } })).toBe('research');
  });

  it('reuses research of any age while the versions match, so a repeat run spends nothing', () => {
    expect(researchState({ ...base, brief })).toBe('reuse');
  });

  it('asks only for the new releases when the target moved', () => {
    expect(researchState({ ...base, brief, targets: { typescript: '7.0.3' } })).toBe('delta');
  });

  it('leaves a known blocker alone until what it waits on moves', () => {
    const blocked = {
      ...brief,
      verdict: 'blocked',
      blocker: { reason: 'peer range', blockedOn: { 'typescript-eslint': '8.72.1' } },
    };
    expect(researchState({ ...base, brief: blocked, watchedVersions: { 'typescript-eslint': '8.72.1' } })).toBe('blocked');
    expect(researchState({ ...base, brief: blocked, watchedVersions: { 'typescript-eslint': '9.0.0' } })).toBe('recheck');
  });

  it('keeps a blocker with nothing to watch until a new version moves the target', () => {
    const blocked = { ...brief, verdict: 'blocked', blocker: { reason: 'upstream bug' } };
    expect(researchState({ ...base, brief: blocked })).toBe('blocked');
    expect(researchState({ ...base, brief: blocked, targets: { typescript: '7.0.3' } })).toBe('delta');
  });

  it('treats a filed brief as handled, and --refresh as no brief at all', () => {
    expect(researchState({ ...base, brief: { ...brief, task: { displayId: 12 } } })).toBe('filed');
    expect(researchState({ ...base, brief, refresh: true })).toBe('research');
  });

  it('never reuses a draft a stopped agent left', () => {
    expect(researchState({ ...base, brief: { ...brief, draft: true } })).toBe('research');
  });

  it('leaves a brief a task agent blocked alone on the next run', () => {
    const blocked = withBlocker(
      { ...brief, task: { displayId: 12 } },
      { reason: 'peer range', recheck: 'range opens', blockedOn: { 'app-builder-lib': '26.18.0' } },
      NOW,
    );
    expect(blocked.task).toBeNull();
    expect(researchState({ ...base, brief: blocked, watchedVersions: { 'app-builder-lib': '26.18.0' } })).toBe('blocked');
  });
});

describe('watchedVersion', () => {
  const addon = {
    distTags: { latest: '0.19.0' },
    versions: versionsOf('0.19.0', '0.20.0-beta.329', '0.20.0-beta.336'),
  };

  it('follows a recorded beta along its own line, where latest would never move', () => {
    expect(watchedVersion('0.20.0-beta.329', addon)).toBe('0.20.0-beta.336');
    expect(watchedVersion('0.20.0-beta.336', addon)).toBe('0.20.0-beta.336');
  });

  it('never moves a recorded stable version onto a beta', () => {
    expect(watchedVersion('0.19.0', addon)).toBe('0.19.0');
  });

  it('follows latest for an ordinary package', () => {
    const eslintPlugin = { distTags: { latest: '9.0.0' }, versions: versionsOf('8.72.1', '9.0.0') };
    expect(watchedVersion('8.72.1', eslintPlugin)).toBe('9.0.0');
  });
});

describe('diffLockfile', () => {
  const before = {
    '': { name: 'kangentic' },
    'packages/protocol': { version: '1.0.0' },
    'node_modules/better-sqlite3': { version: '13.0.0', hasInstallScript: true },
    'node_modules/ws': { version: '8.22.0' },
    'node_modules/gone': { version: '1.0.0' },
  };

  it('reports what a phase moved, added and removed', () => {
    const diff = diffLockfile(before, {
      '': { name: 'kangentic' },
      'packages/protocol': { version: '1.0.0' },
      'node_modules/better-sqlite3': { version: '13.0.0', hasInstallScript: true },
      'node_modules/ws': { version: '8.22.1' },
      'node_modules/fresh': { version: '2.0.0', hasInstallScript: true },
    });
    expect(diff.changed).toEqual([{ name: 'ws', from: '8.22.0', to: '8.22.1' }]);
    expect(diff.added).toEqual([{ name: 'fresh', version: '2.0.0', hasInstallScript: true }]);
    expect(diff.removed).toEqual([{ name: 'gone', version: '1.0.0' }]);
    expect(diff.installScriptFlips).toEqual([]);
    expect(diff.workspaceDrift).toEqual([]);
  });

  it('catches better-sqlite3 losing its install script flag, which npm update does silently', () => {
    const diff = diffLockfile(before, { ...before, 'node_modules/better-sqlite3': { version: '13.0.0' } });
    expect(diff.installScriptFlips).toEqual([{ name: 'better-sqlite3', had: true }]);
  });

  it('catches a workspace version that drifted, which only the release skills may change', () => {
    const diff = diffLockfile(before, { ...before, 'packages/protocol': { version: '1.0.1' } });
    expect(diff.workspaceDrift).toEqual(['packages/protocol']);
  });
});

describe('buildInventory', () => {
  function packument(latest: string, versions: string[], times?: Record<string, string>) {
    return {
      distTags: { latest },
      versions: versionsOf(...versions),
      times: times ?? timesOf(...versions),
    };
  }
  const record = (name: string, installed: string) => ({
    name, installed, pinned: false, runtime: false, locations: ['.'],
  });
  const base = {
    advisories: {},
    briefs: {},
    now: NOW,
    refresh: false,
  };

  it('moves a lockstep group as one, and counts a package already current', () => {
    const inventory = buildInventory({
      ...base,
      declared: [record('@lingui/core', '6.10.1'), record('@lingui/cli', '6.10.1'), record('ws', '8.22.1')],
      packuments: {
        '@lingui/core': packument('6.12.0', ['6.10.1', '6.12.0']),
        '@lingui/cli': packument('6.12.0', ['6.10.1', '6.12.0']),
        ws: packument('8.22.1', ['8.22.1']),
      },
    });
    expect(inventory.currentCount).toBe(1);
    expect(inventory.groups).toHaveLength(1);
    expect(inventory.groups[0]).toMatchObject({ group: 'lingui', kind: 'minor', research: 'research' });
    expect(inventory.groups[0].members.map(({ name }) => name)).toEqual(['@lingui/core', '@lingui/cli']);
  });

  it('rechecks a blocker when the beta it waits on moves, though latest never did', () => {
    const blockedBrief = {
      targets: { electron: '45.2.3' },
      verdict: 'blocked',
      evaluatedAt: OLD,
      blocker: { reason: 'font', blockedOn: { '@xterm/addon-webgl': '0.20.0-beta.329' } },
    };
    const electron = packument('45.2.3', ['45.1.0', '45.2.3']);
    const inventoryWith = (betas: string[]) => buildInventory({
      ...base,
      briefs: { electron: blockedBrief },
      declared: [record('electron', '45.1.0')],
      packuments: { electron, '@xterm/addon-webgl': packument('0.19.0', ['0.19.0', ...betas]) },
    });
    expect(inventoryWith(['0.20.0-beta.329']).groups[0].research).toBe('blocked');
    expect(inventoryWith(['0.20.0-beta.329', '0.20.0-beta.340']).groups[0].research).toBe('recheck');
  });

  it('never lists a beta pin whose latest is older as something to move', () => {
    const inventory = buildInventory({
      ...base,
      declared: [record('node-pty', '1.2.0-beta.15')],
      packuments: { 'node-pty': packument('1.1.0', ['1.1.0', '1.2.0-beta.15']) },
    });
    expect(inventory.groups).toEqual([]);
    expect(inventory.currentCount).toBe(1);
  });

  it('targets a release published moments ago, and says when it was published', () => {
    const published = new Date(NOW - 60 * 1000).toISOString();
    const inventory = buildInventory({
      ...base,
      declared: [record('vite', '8.3.5')],
      packuments: {
        vite: packument('8.3.6', ['8.3.5', '8.3.6'], { '8.3.5': OLD, '8.3.6': published }),
      },
    });
    expect(inventory.groups[0].members[0]).toMatchObject({ target: '8.3.6', published });
  });

  it('reports a package whose latest is deprecated instead of calling it current', () => {
    const inventory = buildInventory({
      ...base,
      declared: [record('@types/uuid', '10.0.0')],
      packuments: {
        '@types/uuid': {
          distTags: { latest: '11.0.0' },
          versions: { '10.0.0': {}, '11.0.0': { deprecated: 'uuid ships its own types' } },
          times: timesOf('10.0.0', '11.0.0'),
        },
      },
    });
    expect(inventory.currentCount).toBe(0);
    expect(inventory.groups[0]).toMatchObject({ group: 'uuid', kind: 'deprecated' });
    expect(inventory.groups[0].members[0]).toMatchObject({ target: '10.0.0', deprecated: 'uuid ships its own types' });
  });

  it('caches a deprecated package, so the same answer is not researched every run', () => {
    const inventory = buildInventory({
      ...base,
      briefs: {
        uuid: {
          targets: { '@types/uuid': '10.0.0' },
          verdict: 'ready',
          evaluatedAt: OLD,
        },
      },
      declared: [record('@types/uuid', '10.0.0')],
      packuments: {
        '@types/uuid': {
          distTags: { latest: '11.0.0' },
          versions: { '10.0.0': {}, '11.0.0': { deprecated: 'stub' } },
          times: timesOf('10.0.0', '11.0.0'),
        },
      },
    });
    expect(inventory.groups[0].research).toBe('reuse');
  });

  it('flags a group whose target changed what the attacks changed', () => {
    const inventory = buildInventory({
      ...base,
      declared: [record('axios', '1.14.0')],
      packuments: {
        axios: {
          distTags: { latest: '1.14.1' },
          versions: {
            '1.14.0': { attested: true },
            '1.14.1': { attested: false, dependencies: { 'plain-crypto-js': '^4.2.1' } },
          },
          times: timesOf('1.14.0', '1.14.1'),
        },
      },
    });
    expect(inventory.groups[0].signals).toBe(true);
    expect(inventory.groups[0].members[0].signals).toHaveLength(2);
  });

  it('flags a set caught mid-publish, so research picks versions that match', () => {
    const inventory = buildInventory({
      ...base,
      declared: [record('playwright', '1.64.1'), record('@playwright/test', '1.64.1')],
      packuments: {
        playwright: packument('1.65.0', ['1.64.1', '1.65.0']),
        '@playwright/test': packument('1.64.2', ['1.64.1', '1.64.2']),
      },
    });
    expect(inventory.groups[0]).toMatchObject({ group: 'playwright', targetsDisagree: true });
  });

  it('flags a types package that lags the library it tracks', () => {
    const inventory = buildInventory({
      ...base,
      declared: [record('three', '0.185.1'), record('@types/three', '0.185.4')],
      packuments: {
        three: packument('0.187.0', ['0.185.1', '0.187.0']),
        '@types/three': packument('0.186.0', ['0.185.4', '0.186.0']),
      },
    });
    expect(inventory.groups[0]).toMatchObject({ group: 'three', targetsDisagree: true });
  });

  it('settles a blocker on a package nothing declares', () => {
    const targets = { vite: '8.3.6' };
    const inventory = buildInventory({
      ...base,
      briefs: {
        vite: {
          targets,
          verdict: 'blocked',
          evaluatedAt: OLD,
          blocker: { reason: 'upstream', blockedOn: { 'app-builder-lib': '26.18.0' } },
        },
      },
      declared: [record('vite', '8.3.5')],
      packuments: {
        vite: packument('8.3.6', ['8.3.5', '8.3.6']),
        'app-builder-lib': packument('26.18.0', ['26.18.0']),
      },
    });
    expect(inventory.groups[0].research).toBe('blocked');
  });

  it('keeps a filed task visible when a new release moves the target', () => {
    const inventory = buildInventory({
      ...base,
      briefs: {
        vite: { targets: { vite: '8.3.5' }, verdict: 'ready', evaluatedAt: OLD, task: { displayId: 12 } },
      },
      declared: [record('vite', '8.3.4')],
      packuments: { vite: packument('8.3.6', ['8.3.4', '8.3.5', '8.3.6']) },
    });
    expect(inventory.groups[0]).toMatchObject({ research: 'delta', task: { displayId: 12 } });
  });

  it('marks a group for its own researcher only when the advisory is against the package itself', () => {
    const declared = [record('vite', '8.3.5')];
    const packuments = { vite: packument('8.3.6', ['8.3.5', '8.3.6']) };
    const own = buildInventory({ ...base, advisories: { vite: 'high' }, declared, packuments });
    expect(own.groups[0]).toMatchObject({ group: 'vite', advisory: true });
    const inherited = buildInventory({ ...base, inheritedAdvisories: { vite: 'moderate' }, declared, packuments });
    expect(inherited.groups[0].advisory).toBe(false);
    expect(inherited.groups[0].members[0].inheritedAdvisory).toBe('moderate');
  });
});
