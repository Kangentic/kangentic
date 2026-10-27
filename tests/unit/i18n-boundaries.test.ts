/**
 * The i18n invariants that fail silently when broken (.claude/rules/i18n.md):
 *
 * - every source file that declares messages belongs to exactly one catalog, and
 *   no two catalogs write one file: a file in none is never extracted, so a
 *   production build shows its raw message IDs while every gate stays green;
 * - no `.ts` module imports a build-time macro: main bundles with plain esbuild,
 *   and Playwright and the capture rig load `.ts` modules outside Vite;
 * - MCP and agent command code never translates: text an agent reads stays English;
 * - main's esbuild bundle carries a shared list's descriptors and resolves them;
 * - a shipped language translates the first-launch suggestion's strings;
 * - one message ID never reads translated in one area and untranslated in
 *   another, since the renderer merges a locale's areas and the last one wins;
 * - settings search matches the text as displayed, in the session's language.
 *
 * Tier: Unit.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as esbuild from 'esbuild';
import { getConfig } from '@lingui/conf';
import { getCatalogs } from '@lingui/cli/api';
import { i18n } from '@lingui/core';
import { SHIPPED_LOCALES, SOURCE_LOCALE } from '../../src/shared/i18n/locales';
import { englishText } from '../../src/shared/i18n/english';
import { TASK_TEMPLATE_VARS } from '../../src/shared/task-template-vars';
import { LANGUAGE_PROMPT_MESSAGES } from '../../src/renderer/components/language/language-messages';
import { SETTINGS_REGISTRY, SETTINGS_BY_ID } from '../../src/renderer/components/settings/settings-registry';
import { computeSearchResults } from '../../src/renderer/components/settings/settings-search';

const REPO_ROOT = path.resolve(__dirname, '../..');
const SOURCE_ROOT = path.join(REPO_ROOT, 'src');
/** Dev-only tooling, built out of production and never extracted. */
const DEV_ONLY_DIRECTORIES = ['src/devtools/', 'src/renderer/components/debug/'];
const MACRO_IMPORT = /from\s+['"]@lingui\/(core\/macro|react\/macro|core\/runtime-macro)['"]/;
const BUILD_TIME_MACRO_IMPORT = /from\s+['"]@lingui\/(core\/macro|react\/macro)['"]/;
/** Languages whose catalogs carry the suggestion strings now: zh-CN's are the design's own. */
const SEEDED_SUGGESTION_LOCALES = ['zh-CN'];

function toPosix(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

function relativePath(filePath: string): string {
  return toPosix(path.relative(REPO_ROOT, filePath));
}

function collectSourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'locales' && directory === SOURCE_ROOT) continue;
      files.push(...collectSourceFiles(fullPath));
    } else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      files.push(fullPath);
    }
  }
  return files;
}

const sourceFiles = collectSourceFiles(SOURCE_ROOT);
const isDevOnly = (relative: string): boolean => DEV_ONLY_DIRECTORIES.some((directory) => relative.startsWith(directory));

type LinguiCatalogs = Awaited<ReturnType<typeof getCatalogs>>;
let catalogs: LinguiCatalogs = [];

beforeAll(async () => {
  const config = getConfig({ configPath: path.join(REPO_ROOT, 'lingui.config.ts'), skipValidation: true });
  catalogs = await getCatalogs(config);
});

describe('catalog layout', () => {
  it('finds the configured catalogs', () => {
    // components/ alone has twenty-odd folders, plus the three source-root catalogs.
    expect(catalogs.length).toBeGreaterThan(20);
  });

  it('gives every catalog a file of its own', () => {
    const byPath = new Map<string, string[]>();
    for (const catalog of catalogs) {
      const key = toPosix(catalog.path);
      byPath.set(key, [...(byPath.get(key) ?? []), catalog.name ?? '(unnamed)']);
    }
    const shared = [...byPath.entries()].filter(([, names]) => names.length > 1);
    expect(shared, `Two catalogs write one PO file, so extract and check sync disagree: ${JSON.stringify(shared)}`).toEqual([]);
  });

  it('puts every file that declares messages in exactly one catalog', () => {
    const sourcePathsByCatalog = catalogs.map((catalog) => new Set(catalog.sourcePaths.map((file) => relativePath(path.resolve(REPO_ROOT, file)))));
    const declaring = sourceFiles
      .map(relativePath)
      .filter((relative) => !isDevOnly(relative))
      .filter((relative) => MACRO_IMPORT.test(fs.readFileSync(path.join(REPO_ROOT, relative), 'utf8')));
    // Vacuity guard: the proof sites and the Language UI declare messages today.
    expect(declaring.length).toBeGreaterThan(5);
    const misplaced = declaring
      .map((relative) => ({ relative, count: sourcePathsByCatalog.filter((paths) => paths.has(relative)).length }))
      .filter(({ count }) => count !== 1)
      .map(({ relative, count }) => `${relative} is in ${count} catalogs`);
    expect(misplaced, 'Adjust the catalogs in lingui.config.ts so each file lands in one').toEqual([]);
  });
});

describe('macro boundaries', () => {
  it('no .ts module imports a build-time macro', () => {
    const offenders = sourceFiles
      .filter((file) => file.endsWith('.ts'))
      .filter((file) => BUILD_TIME_MACRO_IMPORT.test(fs.readFileSync(file, 'utf8')))
      .map(relativePath);
    expect(
      offenders,
      'A .ts module uses @lingui/core/runtime-macro (msg plus i18n._): main bundles with plain esbuild and '
      + 'Playwright loads .ts modules outside Vite, where @lingui/core/macro and @lingui/react/macro throw.',
    ).toEqual([]);
  });

  it('MCP and agent command code never imports the UI translator', () => {
    const agentFacing = sourceFiles
      .map(relativePath)
      .filter((relative) => relative.startsWith('src/main/agent/commands/') || relative.startsWith('src/main/agent/mcp-http/'));
    expect(agentFacing.length).toBeGreaterThan(5);
    const offenders = agentFacing.filter((relative) => {
      const source = fs.readFileSync(path.join(REPO_ROOT, relative), 'utf8');
      return /i18n\/main-i18n['"]/.test(source) || /\btranslateText\b/.test(source);
    });
    expect(offenders, 'Text an agent reads stays English: resolve a descriptor with englishText (src/shared/i18n/english.ts).').toEqual([]);
  });
});

describe("main's esbuild bundle", () => {
  let sandbox = '';

  afterAll(() => {
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('bundles a shared list of descriptors with the build options and resolves them in English', async () => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-i18n-bundle-'));
    const entry = path.join(sandbox, 'entry.ts');
    const importPath = (relative: string) => JSON.stringify(toPosix(path.join(REPO_ROOT, relative)));
    fs.writeFileSync(entry, [
      `import { KEYBINDINGS } from ${importPath('src/shared/keybindings')};`,
      `import { TASK_TEMPLATE_VARS } from ${importPath('src/shared/task-template-vars')};`,
      `import { translateText } from ${importPath('src/main/i18n/main-i18n')};`,
      `import { englishText } from ${importPath('src/shared/i18n/english')};`,
      "const label = KEYBINDINGS.find((binding) => binding.id === 'settings.toggle').label;",
      "const description = TASK_TEMPLATE_VARS.find((templateVar) => templateVar.name === 'task_xml').description;",
      'console.log(JSON.stringify({ label: translateText(label), english: englishText(label), description: englishText(description) }));',
    ].join('\n'));
    const outfile = path.join(sandbox, 'out.js');
    // scripts/build.js's esbuildCommon, the options main ships with.
    await esbuild.build({
      entryPoints: [entry],
      outfile,
      bundle: true,
      platform: 'node',
      target: 'node24',
      format: 'cjs',
      conditions: ['require'],
      minify: true,
      logLevel: 'silent',
    });
    const run = spawnSync(process.execPath, [outfile], { encoding: 'utf8' });
    expect(run.status, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({
      label: 'Toggle settings',
      english: 'Toggle settings',
      description: 'Task title and description wrapped in a <task> XML envelope. Default seeded prompt template is {{task_xml}}{{workflow_xml}}{{attachments}}.',
    });
  });

  it('renders the quoted template keywords literally through the renderer catalogs too', () => {
    const description = TASK_TEMPLATE_VARS.find((templateVar) => templateVar.name === 'task_xml')?.description;
    expect(description).toBeDefined();
    expect(englishText(description ?? '')).toContain('{{task_xml}}{{workflow_xml}}{{attachments}}');
  });
});

describe('translated catalogs', () => {
  it('every shipped language translates the first-launch suggestion strings', async () => {
    const languageCatalog = catalogs.find((catalog) => toPosix(catalog.path).endsWith('/language'));
    expect(languageCatalog, 'the components/language catalog').toBeDefined();
    const locales = [...new Set([...SHIPPED_LOCALES.filter((locale) => locale !== SOURCE_LOCALE), ...SEEDED_SUGGESTION_LOCALES])];
    for (const locale of locales) {
      const messages = (await languageCatalog?.read(locale)) ?? {};
      for (const [key, descriptor] of Object.entries(LANGUAGE_PROMPT_MESSAGES)) {
        const translation = messages[descriptor.id]?.translation ?? '';
        expect(translation, `${locale} does not translate the ${key} prompt string`).not.toBe('');
      }
    }
  });

  it('no message reads translated in one area and untranslated in another', async () => {
    const config = getConfig({ configPath: path.join(REPO_ROOT, 'lingui.config.ts'), skipValidation: true });
    const conflicts: string[] = [];
    for (const locale of config.locales.filter((candidate) => candidate !== config.sourceLocale)) {
      const translatedness = new Map<string, Map<boolean, string[]>>();
      for (const catalog of catalogs) {
        const messages = (await catalog.read(locale)) ?? {};
        for (const [id, entry] of Object.entries(messages)) {
          const translated = (entry.translation ?? '') !== '';
          const byState = translatedness.get(id) ?? new Map<boolean, string[]>();
          byState.set(translated, [...(byState.get(translated) ?? []), path.basename(catalog.path)]);
          translatedness.set(id, byState);
        }
      }
      for (const [id, byState] of translatedness) {
        if (byState.size > 1) conflicts.push(`${locale} ${id}: translated in ${byState.get(true)?.join(', ')}, not in ${byState.get(false)?.join(', ')}`);
      }
    }
    expect(
      conflicts,
      'The renderer merges a locale\'s areas and the last wins, so an untranslated copy can hide a translation. '
      + 'Translate every copy, or give the message a context of its own.',
    ).toEqual([]);
  });
});

describe('settings search', () => {
  afterAll(() => {
    i18n.activate(SOURCE_LOCALE);
  });

  it('matches a row by its text as displayed in the session language', () => {
    const label = SETTINGS_BY_ID.displayLanguage?.label;
    expect(label && typeof label !== 'string').toBe(true);
    if (!label || typeof label === 'string') return;
    i18n.loadAndActivate({ locale: 'zh-CN', messages: { [label.id]: '显示语言' } });
    expect(computeSearchResults('显示语言', SETTINGS_REGISTRY).matchingIds.has('displayLanguage')).toBe(true);
    // The English keywords still find it in any language.
    expect(computeSearchResults('display language', SETTINGS_REGISTRY).matchingIds.has('displayLanguage')).toBe(true);
  });
});
