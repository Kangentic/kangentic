import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeConfig } from '@lingui/conf';
import { getCatalogs } from '@lingui/cli/api';
import { formatter } from '@lingui/format-po';
import { generateMessageId } from '@lingui/message-utils/generateMessageId';
import { areaOf, readCatalogAt, resolveBaseRef } from '../../scripts/i18n/catalogs.mjs';
import { loadAppModules, refuseIfAutomated, sourceReader } from '../../scripts/i18n/cli.mjs';
import { descriptionBudgets } from '../../scripts/i18n/translate.mjs';

// The translation harness's catalog and app-module plumbing (scripts/i18n/): the
// esbuild bundle of the app code `npm run i18n:translate` borrows, the description
// budgets built from it, a catalog's area name, reading a catalog at a git ref, the
// cached source reader, and the CI refusal. Engines are never called. Every file
// and repo lives under the OS temp folder, so nothing touches src/locales.

const REPO_ROOT = path.resolve(__dirname, '../..');

type AppModules = Awaited<ReturnType<typeof loadAppModules>>;

/** Remove a temp tree. Git writes its loose objects read-only, which Windows needs retries to delete. */
function removeTree(directory: string): void {
  fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

/** Runs git with an identity and signing pinned on the command line, so a runner with no git config can still commit. */
function runGit(repository: string, args: string[]): string {
  return execFileSync(
    'git',
    [
      '-c', 'user.name=Test',
      '-c', 'user.email=test@example.invalid',
      '-c', 'commit.gpgsign=false',
      '-c', 'core.autocrlf=false',
      ...args,
    ],
    { cwd: repository, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
  ).trim();
}

function writeUnder(root: string, relativePath: string, content: string): void {
  fs.mkdirSync(path.dirname(path.join(root, relativePath)), { recursive: true });
  fs.writeFileSync(path.join(root, relativePath), content);
}

/** Commit everything in the work tree and return the new commit's full sha. */
function commitAll(repository: string, message: string): string {
  runGit(repository, ['add', '-A']);
  runGit(repository, ['commit', '-q', '-m', message]);
  return runGit(repository, ['rev-parse', 'HEAD']);
}

function newRepository(prefix: string): string {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  runGit(repository, ['init', '-q', '-b', 'main']);
  return repository;
}

describe('the app modules the harness bundles', () => {
  let appModules: AppModules;

  beforeAll(async () => {
    appModules = await loadAppModules();
  }, 60_000);

  it('bundles app-modules.ts with the width table, the description budgets and the settings scan', () => {
    expect(typeof appModules.wcwidthV11).toBe('function');
    expect(appModules.wcwidthV11('a'.codePointAt(0))).toBe(1);
    expect(appModules.wcwidthV11('重'.codePointAt(0))).toBe(2);

    expect(typeof appModules.DESCRIPTION_BUDGET).toBe('object');
    const budgets = Object.values(appModules.DESCRIPTION_BUDGET);
    expect(budgets.length).toBeGreaterThan(0);
    for (const budget of budgets) expect(typeof budget).toBe('number');

    expect(typeof appModules.scanRealSettings).toBe('function');
  });

  describe('descriptionBudgets', () => {
    const wide = { text: 'Same sentence.', context: 'wide' };
    const narrow = { text: 'Same sentence.', context: 'narrow' };
    const notText = { text: 42, context: 'wide' };
    const other = { text: 'Other.', context: 'wide' };

    function stubModules(descriptions: Array<{ text: unknown; context: string }>) {
      return {
        scanRealSettings: () => ({ descriptions }),
        DESCRIPTION_BUDGET: { wide: 70, narrow: 50 } as Record<string, number>,
      };
    }

    it('gives a sentence shown in two places the tighter budget, wide context first', () => {
      const budgets = descriptionBudgets(stubModules([wide, narrow, notText, other]), REPO_ROOT);
      expect(budgets.get('Same sentence.')).toBe(50);
      expect(budgets.get('Other.')).toBe(70);
    });

    it('gives a sentence shown in two places the tighter budget, narrow context first', () => {
      const budgets = descriptionBudgets(stubModules([narrow, wide, notText, other]), REPO_ROOT);
      expect(budgets.get('Same sentence.')).toBe(50);
      expect(budgets.get('Other.')).toBe(70);
    });

    it('skips a description whose text is not a string', () => {
      const budgets = descriptionBudgets(stubModules([wide, narrow, notText, other]), REPO_ROOT);
      expect(budgets.size).toBe(2);
      expect([...budgets.keys()].sort()).toEqual(['Other.', 'Same sentence.']);
    });

    it('reads the real settings cards into a positive budget for every description', () => {
      const budgets = descriptionBudgets(appModules, REPO_ROOT);
      expect(budgets.size).toBeGreaterThan(0);
      for (const [text, budget] of budgets) {
        expect(typeof text).toBe('string');
        expect(Number.isFinite(budget) && budget > 0).toBe(true);
      }
    });
  });
});

describe('areaOf', () => {
  it('is the PO file name without its extension, so a dashed name keeps its dash', () => {
    const catalog = { getFilename: (locale: string) => path.join('locales', locale, 'src-main.po') };
    expect(areaOf(catalog)).toBe('src-main');
  });

  it('reads the area from a Lingui catalog built on a temp config', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-area-of-'));
    try {
      writeUnder(root, 'src/settings/a.ts', '');
      const config = makeConfig({
        rootDir: root,
        locales: ['en', 'de'],
        sourceLocale: 'en',
        fallbackLocales: { default: 'en' },
        catalogs: [{ path: '<rootDir>/locales/{locale}/settings', include: ['<rootDir>/src/settings/'] }],
        format: formatter({ origins: true, lineNumbers: false }),
      }, { skipValidation: true });
      const [catalog] = await getCatalogs(config);
      expect(areaOf(catalog)).toBe('settings');
    } finally {
      removeTree(root);
    }
  });
});

describe('resolveBaseRef', () => {
  let repository: string;
  let firstSha: string;
  let secondSha: string;

  beforeAll(() => {
    repository = newRepository('i18n-base-ref-');
    writeUnder(repository, 'file.txt', 'one\n');
    firstSha = commitAll(repository, 'first');
    writeUnder(repository, 'file.txt', 'two\n');
    secondSha = commitAll(repository, 'second');
    runGit(repository, ['branch', 'older', firstSha]);
  });

  afterAll(() => removeTree(repository));

  it('returns the full sha of a sha the caller names', () => {
    expect(firstSha).toMatch(/^[0-9a-f]{40}$/);
    expect(resolveBaseRef(repository, firstSha)).toBe(firstSha);
  });

  it('expands an abbreviated sha to the full one', () => {
    expect(resolveBaseRef(repository, firstSha.slice(0, 7))).toBe(firstSha);
  });

  it('resolves a branch name to the commit it points at', () => {
    expect(resolveBaseRef(repository, 'older')).toBe(firstSha);
  });

  it('falls back to HEAD when nothing is named and there is no origin/main', () => {
    expect(resolveBaseRef(repository, undefined)).toBe(secondSha);
    expect(resolveBaseRef(repository, null)).toBe(secondSha);
  });

  it('throws for a ref that does not exist', () => {
    expect(() => resolveBaseRef(repository, 'no-such-ref')).toThrow();
  });

  it('uses the merge-base with origin/main when that ref exists', () => {
    runGit(repository, ['update-ref', 'refs/remotes/origin/main', firstSha]);
    try {
      expect(resolveBaseRef(repository, undefined)).toBe(firstSha);
    } finally {
      runGit(repository, ['update-ref', '-d', 'refs/remotes/origin/main']);
    }
  });
});

describe('readCatalogAt', () => {
  const header = (locale: string) => `msgid ""\nmsgstr ""\n"Content-Type: text/plain; charset=utf-8\\n"\n"Language: ${locale}\\n"\n\n`;
  const entry = (source: string, translation: string) => `#: src/area/a.ts\nmsgid "${source}"\nmsgstr "${translation}"\n`;
  const poFile = (locale: string, translation: string) => `${header(locale)}${entry('Save', translation)}`;

  let repository: string;
  let commitOneSha: string;
  let commitTwoSha: string;
  let catalog: Awaited<ReturnType<typeof getCatalogs>>[number];

  beforeAll(async () => {
    repository = newRepository('i18n-read-catalog-at-');
    writeUnder(repository, 'src/area/a.ts', '');
    writeUnder(repository, 'locales/en/area.po', poFile('en', 'Save'));
    writeUnder(repository, 'locales/de/area.po', poFile('de', 'Speichern'));
    commitOneSha = commitAll(repository, 'de translated');

    // The ja file arrives in the second commit, so it exists at HEAD and in the
    // work tree but not at the first commit.
    writeUnder(repository, 'locales/ja/area.po', poFile('ja', '保存'));
    writeUnder(repository, 'locales/de/area.po', poFile('de', 'Sichern'));
    commitTwoSha = commitAll(repository, 'ja added, de reworded');

    // Then the work tree moves on again, uncommitted.
    writeUnder(repository, 'locales/de/area.po', poFile('de', 'Ablegen'));

    const config = makeConfig({
      rootDir: repository,
      locales: ['en', 'de', 'ja'],
      sourceLocale: 'en',
      fallbackLocales: { default: 'en' },
      catalogs: [{ path: '<rootDir>/locales/{locale}/area', include: ['<rootDir>/src/area/'] }],
      format: formatter({ origins: true, lineNumbers: false }),
    }, { skipValidation: true });
    [catalog] = await getCatalogs(config);
  }, 30_000);

  afterAll(() => removeTree(repository));

  const saveId = generateMessageId('Save');

  it('returns the translation committed at the ref, not the work tree\'s', async () => {
    const atCommitOne = await readCatalogAt(catalog, 'de', commitOneSha, repository);
    expect(atCommitOne[saveId].translation).toBe('Speichern');

    const current = await catalog.read('de');
    expect(current[saveId].translation).toBe('Ablegen');
  });

  it('follows the ref it is given', async () => {
    const atCommitTwo = await readCatalogAt(catalog, 'de', commitTwoSha, repository);
    expect(atCommitTwo[saveId].translation).toBe('Sichern');
  });

  it('is empty for a locale whose PO file did not exist at that ref', async () => {
    expect(await readCatalogAt(catalog, 'ja', commitOneSha, repository)).toEqual({});
    const atCommitTwo = await readCatalogAt(catalog, 'ja', commitTwoSha, repository);
    expect(atCommitTwo[saveId].translation).toBe('保存');
  });
});

describe('sourceReader', () => {
  it('reads a file relative to the root once and serves the cached text afterwards', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-source-reader-'));
    try {
      writeUnder(root, 'nested/file.txt', 'first text');
      const readSource = sourceReader(root);
      expect(readSource('nested/file.txt')).toBe('first text');

      fs.rmSync(path.join(root, 'nested', 'file.txt'));
      expect(readSource('nested/file.txt')).toBe('first text');
    } finally {
      removeTree(root);
    }
  });

  it('returns null for a missing file, and stays null once it has been looked up', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-source-reader-'));
    try {
      const readSource = sourceReader(root);
      expect(readSource('never/written.txt')).toBeNull();

      writeUnder(root, 'never/written.txt', 'late text');
      expect(readSource('never/written.txt')).toBeNull();
    } finally {
      removeTree(root);
    }
  });

  it('keeps each root\'s cache apart', () => {
    const firstRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-source-reader-'));
    const secondRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-source-reader-'));
    try {
      writeUnder(firstRoot, 'file.txt', 'from first');
      writeUnder(secondRoot, 'file.txt', 'from second');
      expect(sourceReader(firstRoot)('file.txt')).toBe('from first');
      expect(sourceReader(secondRoot)('file.txt')).toBe('from second');
    } finally {
      removeTree(firstRoot);
      removeTree(secondRoot);
    }
  });
});

describe('refuseIfAutomated', () => {
  const AUTOMATION_VARIABLES = ['CI', 'CONTINUOUS_INTEGRATION', 'GITHUB_ACTIONS', 'BUILD_NUMBER'];

  // The check is a truthiness test, so an empty string counts as not set. CI's
  // runner sets CI, so every case starts by clearing all four.
  function clearAutomationVariables(): void {
    for (const name of AUTOMATION_VARIABLES) vi.stubEnv(name, '');
  }

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('does not throw when none of the automation variables is set', () => {
    clearAutomationVariables();
    expect(() => refuseIfAutomated('Every translation is a real model call.')).not.toThrow();
  });

  it('throws naming CI and carrying the reason when CI is set', () => {
    clearAutomationVariables();
    vi.stubEnv('CI', 'true');
    expect(() => refuseIfAutomated('Every translation is a real model call.')).toThrow(
      'Refusing to run: CI is set. Every translation is a real model call.',
    );
  });

  it.each(AUTOMATION_VARIABLES)('refuses and names %s when only that variable is set', (name) => {
    clearAutomationVariables();
    vi.stubEnv(name, '1');
    expect(() => refuseIfAutomated('Why.')).toThrow(`Refusing to run: ${name} is set. Why.`);
  });
});
