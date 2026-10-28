/**
 * The i18n invariants that fail silently when broken (.claude/rules/i18n.md):
 *
 * - every source file that declares messages belongs to exactly one catalog, and
 *   no two catalogs write one file: a file in none is never extracted, so a
 *   production build shows its raw message IDs while every gate stays green;
 * - no `.ts` module imports a build-time macro: main bundles with plain esbuild,
 *   and Playwright and the capture rig load `.ts` modules outside Vite;
 * - the runtime macro gets labeled placeholders (`plural({ count }, ...)`,
 *   `${{ name }}`): its raw-value form throws under plain esbuild, which no
 *   Vite-compiled test can see;
 * - MCP and agent command code never translates: text an agent reads stays English;
 * - main's esbuild bundle carries a shared list's descriptors and resolves them;
 * - a shipped language translates the first-launch suggestion's strings;
 * - one message ID reads the same in every area of a locale, translated or not,
 *   since the renderer merges a locale's areas and the last one wins;
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
import * as ts from 'typescript';
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
const RUNTIME_MACRO_IMPORT = /from\s+['"]@lingui\/core\/runtime-macro['"]/;
const RUNTIME_MACRO_MODULE = '@lingui/core/runtime-macro';
/** The runtime macro's functions whose first argument is a labeled object: `plural({ count }, ...)`. */
const LABELED_FIRST_ARGUMENT_MACROS = new Set(['plural', 'select', 'selectOrdinal']);
/** The runtime macro's tags, whose placeholders are `${{ name }}` or a nested macro call. */
const MESSAGE_TAG_MACROS = new Set(['msg', 'defineMessage']);

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

interface RuntimeMacroScan {
  violations: Array<{ line: number; reason: string }>;
  /** `plural`, `select` and `selectOrdinal` calls looked at. */
  callsChecked: number;
  /** `${...}` slots of a `msg` template looked at. */
  placeholdersChecked: number;
}

/**
 * Reads how a file uses the runtime macro, by syntax tree rather than by pattern,
 * since a regex cannot tell `plural(` the macro from `.plural(` or a local
 * function, nor see a template slot's expression whole.
 *
 * The runtime macro throws on a raw value ("plural(): A raw value (number) was
 * passed as first argument"). Vitest compiles the macro with the Lingui Vite
 * plugin, which accepts it, so only plain esbuild (main's bundle) shows the throw.
 */
function scanRuntimeMacroUse(fileName: string, source: string): RuntimeMacroScan {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  // Local name -> the macro's own name, so an aliased import is still read as the macro.
  const macroNameByLocalName = new Map<string, string>();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (statement.moduleSpecifier.text !== RUNTIME_MACRO_MODULE) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      macroNameByLocalName.set(element.name.text, (element.propertyName ?? element.name).text);
    }
  }
  const macroNameOf = (expression: ts.Expression): string => (
    ts.isIdentifier(expression) ? macroNameByLocalName.get(expression.text) ?? '' : ''
  );
  const lineOf = (node: ts.Node): number => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;

  const scan: RuntimeMacroScan = { violations: [], callsChecked: 0, placeholdersChecked: 0 };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && LABELED_FIRST_ARGUMENT_MACROS.has(macroNameOf(node.expression))) {
      scan.callsChecked += 1;
      const firstArgument = node.arguments[0];
      if (!firstArgument || !ts.isObjectLiteralExpression(firstArgument)) {
        const name = macroNameOf(node.expression);
        scan.violations.push({
          line: lineOf(node),
          reason: `${name}() takes a labeled object first (${name}({ name }, ...)), got ${firstArgument ? firstArgument.getText(sourceFile) : 'nothing'}`,
        });
      }
    }
    if (ts.isTaggedTemplateExpression(node) && MESSAGE_TAG_MACROS.has(macroNameOf(node.tag)) && ts.isTemplateExpression(node.template)) {
      for (const span of node.template.templateSpans) {
        scan.placeholdersChecked += 1;
        let slot = span.expression;
        while (ts.isParenthesizedExpression(slot)) slot = slot.expression;
        const isLabeledObject = ts.isObjectLiteralExpression(slot);
        const isNestedMacro = ts.isCallExpression(slot) && LABELED_FIRST_ARGUMENT_MACROS.has(macroNameOf(slot.expression));
        if (!isLabeledObject && !isNestedMacro) {
          scan.violations.push({
            line: lineOf(span.expression),
            reason: `a msg placeholder takes \${{ name }} or a nested plural/select, got \${${span.expression.getText(sourceFile)}}`,
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return scan;
}

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

  it('every runtime-macro plural, select and selectOrdinal takes a labeled object, and every msg placeholder is labeled', () => {
    const importing = sourceFiles.filter((file) => RUNTIME_MACRO_IMPORT.test(fs.readFileSync(file, 'utf8')));
    // Vacuity guard: the shared lists and a dozen renderer modules import the runtime macro today.
    expect(importing.length).toBeGreaterThan(5);
    let callsChecked = 0;
    let placeholdersChecked = 0;
    const offenders: string[] = [];
    for (const file of importing) {
      const scan = scanRuntimeMacroUse(file, fs.readFileSync(file, 'utf8'));
      callsChecked += scan.callsChecked;
      placeholdersChecked += scan.placeholdersChecked;
      offenders.push(...scan.violations.map(({ line, reason }) => `${relativePath(file)}:${line} ${reason}`));
    }
    expect(callsChecked, 'the scan found no plural, select or selectOrdinal call to check').toBeGreaterThan(0);
    expect(placeholdersChecked, 'the scan found no msg placeholder to check').toBeGreaterThan(0);
    expect(
      offenders,
      'The runtime macro throws on a raw value under plain esbuild (main, MCP, the phone): '
      + 'write plural({ count }, ...) and ${{ name }}, never plural(count, ...) or ${name}.',
    ).toEqual([]);
  });

  it('the placeholder scan reports a raw plural, a raw select and a raw msg value, and passes the labeled forms', () => {
    const scan = scanRuntimeMacroUse('known-bad.ts', [
      "import { msg, plural, select as pick } from '@lingui/core/runtime-macro';",
      'const maxRuns = 3;',
      "export const rawPlural = msg`${plural(maxRuns, { one: 'once', other: '# times' })}`;",
      'export const rawValue = msg`Hello ${maxRuns}`;',
      "export const rawSelect = pick(maxRuns, { a: 'x', other: 'y' });",
      "export const labeled = msg`Hello ${{ maxRuns }} ${plural({ maxRuns }, { one: 'once', other: '# times' })}`;",
      "export const unrelated = otherPlural(maxRuns, { one: 'x', other: 'y' });",
    ].join('\n'));
    expect(scan.violations.map((violation) => violation.line)).toEqual([3, 4, 5]);
    expect(scan.callsChecked).toBe(3);
    expect(scan.placeholdersChecked).toBe(4);
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

  const importPath = (relative: string) => JSON.stringify(toPosix(path.join(REPO_ROOT, relative)));

  /** Bundles `entryLines` with the options main ships with, then runs the bundle under Node. */
  async function bundleAndRun(name: string, entryLines: string[]) {
    // One sandbox for every case in the block, removed once by afterAll.
    sandbox = sandbox || fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-i18n-bundle-'));
    const entry = path.join(sandbox, `${name}.ts`);
    fs.writeFileSync(entry, entryLines.join('\n'));
    const outfile = path.join(sandbox, `${name}.js`);
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
    return spawnSync(process.execPath, [outfile], { encoding: 'utf8' });
  }

  /** A crashed minified bundle prints its source line first. The thrown error is the part worth reading. */
  const failureText = (run: { stderr: string }): string => run.stderr.split('\n').find((line) => line.startsWith('Error:')) ?? run.stderr.slice(-500);

  it('bundles a shared list of descriptors with the build options and resolves them in English', async () => {
    const run = await bundleAndRun('entry', [
      `import { KEYBINDINGS } from ${importPath('src/shared/keybindings')};`,
      `import { TASK_TEMPLATE_VARS } from ${importPath('src/shared/task-template-vars')};`,
      `import { translateText } from ${importPath('src/main/i18n/main-i18n')};`,
      `import { englishText } from ${importPath('src/shared/i18n/english')};`,
      "const label = KEYBINDINGS.find((binding) => binding.id === 'settings.toggle').label;",
      "const description = TASK_TEMPLATE_VARS.find((templateVar) => templateVar.name === 'task_xml').description;",
      'console.log(JSON.stringify({ label: translateText(label), english: englishText(label), description: englishText(description) }));',
    ]);
    expect(run.status, failureText(run)).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({
      label: 'Toggle settings',
      english: 'Toggle settings',
      description: 'Task title and description wrapped in a <task> XML envelope. Default seeded prompt template is {{task_xml}}{{workflow_xml}}{{attachments}}.',
    });
  });

  it('resolves the values, plurals and selects main reads from the shared lists', async () => {
    // Main writes these for agents and the run log, so a message that stops
    // resolving in the shipped bundle would reach them as an id or an object.
    // The Frequency plural is the one the runtime macro threw on when it took a
    // raw number: Vitest compiles the macro with the Vite plugin and never saw it.
    const run = await bundleAndRun('entry-values', [
      `import { WORKFLOW_REFUSALS } from ${importPath('src/shared/workflow-refusals')};`,
      `import { describeAutomationFrequency, describeAutomationMarksInWords } from ${importPath('src/shared/automation-describe')};`,
      `import { KNOWLEDGE_GRAPH_TASK_FIELDS } from ${importPath('src/shared/knowledge-graph-task-fields')};`,
      `import { waitingLabel } from ${importPath('src/shared/workflow-waiting')};`,
      `import { translateText } from ${importPath('src/main/i18n/main-i18n')};`,
      `import { englishI18n, englishText } from ${importPath('src/shared/i18n/english')};`,
      "const pullRequest = KNOWLEDGE_GRAPH_TASK_FIELDS.find((field) => field.key === 'pr');",
      "const row = { type: 'notify', trigger: 'turn_end', config: { title: 'Hi' }, condition: 'the review is clean', final_line: null, max_runs: 3 };",
      'console.log(JSON.stringify({',
      "  refusal: WORKFLOW_REFUSALS.locked('#12', 'Release'),",
      '  once: describeAutomationFrequency(1, englishI18n),',
      '  several: describeAutomationFrequency(3, englishI18n),',
      '  words: describeAutomationMarksInWords(row, englishI18n),',
      "  pullRequest: englishText(pullRequest.display({ prNumber: 417, prState: 'merged' })),",
      "  waiting: translateText(waitingLabel(['#1', '#2'], false).label),",
      '}));',
    ]);
    expect(run.status, failureText(run)).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({
      refusal: '#12 is locked while Release runs.',
      once: 'At most once until you move the task.',
      several: 'At most 3 times until you move the task.',
      words: 'only if the review is clean; at most 3 times until you move the task',
      pullRequest: 'PR 417 merged',
      waiting: 'Blocked by 2 tasks...',
    });
  });

  it('renders the quoted template keywords literally through the renderer catalogs too', () => {
    const description = TASK_TEMPLATE_VARS.find((templateVar) => templateVar.name === 'task_xml')?.description;
    expect(description).toBeDefined();
    expect(englishText(description ?? '')).toContain('{{task_xml}}{{workflow_xml}}{{attachments}}');
  });
});

describe('the sandboxed preload', () => {
  it('bundles nothing from Lingui, whose runtime macro hashes ids with node:crypto', async () => {
    // A sandboxed preload can require only a few modules, and a missing one
    // fails the whole script: window.electronAPI never exists and the app
    // renders nothing. Only the E2E tier launches the real preload, so this
    // is the fast check. The preload reads text only through shared modules
    // that hold no msg descriptors (pop-out-arg, i18n/locales).
    const result = await esbuild.build({
      entryPoints: [path.join(REPO_ROOT, 'src/preload/preload.ts')],
      bundle: true,
      write: false,
      metafile: true,
      platform: 'node',
      target: 'node24',
      format: 'cjs',
      conditions: ['require'],
      external: ['electron'],
      define: { __KANGENTIC_DEV__: 'false' },
      logLevel: 'silent',
    });
    const reached = Object.keys(result.metafile.inputs).map(toPosix);
    const lingui = reached.filter((input) => input.includes('node_modules/@lingui/'));
    expect(
      lingui,
      'The preload imports a module that holds msg descriptors. Import the constant from a module with no Lingui import (see src/shared/pop-out-arg.ts).',
    ).toEqual([]);
  });
});

describe('translated catalogs', () => {
  it('every shipped language translates the first-launch suggestion strings', async () => {
    const languageCatalog = catalogs.find((catalog) => toPosix(catalog.path).endsWith('/language'));
    expect(languageCatalog, 'the components/language catalog').toBeDefined();
    const locales = SHIPPED_LOCALES.filter((locale) => locale !== SOURCE_LOCALE);
    expect(locales.length, 'a shipped language other than English, or this check runs over nothing').toBeGreaterThan(0);
    for (const locale of locales) {
      const messages = (await languageCatalog?.read(locale)) ?? {};
      for (const [key, descriptor] of Object.entries(LANGUAGE_PROMPT_MESSAGES)) {
        const translation = messages[descriptor.id]?.translation ?? '';
        expect(translation, `${locale} does not translate the ${key} prompt string`).not.toBe('');
      }
    }
  });

  it('no message reads one way in one area and another way, or untranslated, in another', async () => {
    const config = getConfig({ configPath: path.join(REPO_ROOT, 'lingui.config.ts'), skipValidation: true });
    const conflicts: string[] = [];
    for (const locale of config.locales.filter((candidate) => candidate !== config.sourceLocale)) {
      const copies = new Map<string, Map<string, string[]>>();
      for (const catalog of catalogs) {
        const messages = (await catalog.read(locale)) ?? {};
        for (const [id, entry] of Object.entries(messages)) {
          const translation = entry.translation ?? '';
          const byTranslation = copies.get(id) ?? new Map<string, string[]>();
          byTranslation.set(translation, [...(byTranslation.get(translation) ?? []), path.basename(catalog.path)]);
          copies.set(id, byTranslation);
        }
      }
      for (const [id, byTranslation] of copies) {
        if (byTranslation.size < 2) continue;
        const readings = [...byTranslation].map(([translation, areas]) => (
          `${translation === '' ? 'untranslated' : JSON.stringify(translation)} in ${areas.join(', ')}`
        ));
        conflicts.push(`${locale} ${id}: ${readings.join('; ')}`);
      }
    }
    expect(
      conflicts,
      'The renderer merges a locale\'s areas and the last wins, so a copy that reads differently, or not at all, '
      + 'hides the other, and a correction to one copy does not show. Give every copy the same translation, or give '
      + 'the message a context of its own.',
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
