#!/usr/bin/env node
/**
 * Draft translations into the Lingui PO catalogs (`npm run i18n:translate`).
 *
 * Picks every entry with no translation (and with --redraft, every machine draft
 * still marked for review), translates it with Claude or a local model, checks
 * the result, and writes it marked `fuzzy` for review. A reviewed translation is
 * never touched. docs/contributing/translations.md is the guide.
 *
 *   npm run i18n:translate -- --engine claude --locales de,ja --areas settings
 *   npm run i18n:translate -- --engine local --url http://127.0.0.1:9931/v1
 *
 * Options:
 *   --engine claude|local     who translates (default claude)
 *   --locales a,b             locales to fill (default: every one but English)
 *   --areas a,b               catalog areas, the PO file names (default: all)
 *   --base <ref>              where a reworded string's old translation is read
 *                             (default: the merge-base with origin/main)
 *   --redraft                 also re-draft entries still marked for review
 *   --limit <n>               translate at most n entries in all (a trial run)
 *   --dry-run                 list what would be translated, call no engine
 *   --concurrency <n>         engine calls at once (default 4 for claude, 1 local)
 *   --batch-size <n>          strings per call (default 30 for claude, 10 local)
 *   --model <id>              Claude model or local model name
 *   --effort <level>          Claude effort (default medium)
 *   --cli <path>              the claude executable (default claude)
 *   --url <url>               the local server's /v1 base URL
 *   --out <dir>               where the run report goes (default a temp folder)
 *
 * After a run that wrote anything, it runs the catalog gate (`npm run
 * i18n:check`) and fails loudly if the catalogs no longer match the source.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { isEntrypoint } from '../lib/is-entrypoint.mjs';
import { applyOutcomes, loadCatalogs, readCatalogAt, resolveBaseRef, selectEntryIds } from './catalogs.mjs';
import { loadAppModules, readFlags, refuseIfAutomated, sourceReader } from './cli.mjs';
import { removedEntries } from './context.mjs';
import { loadGlossary } from './glossary.mjs';
import { DEFAULT_BATCH_SIZE, translateEntries } from './translate-catalog.mjs';
import { createClaudeEngine, DEFAULT_CLAUDE_EFFORT, DEFAULT_CLAUDE_MODEL } from './engines/claude.mjs';
import { createOpenAiCompatibleEngine, DEFAULT_LOCAL_URL, REFILL_MODEL } from './engines/openai-compatible.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, '..', '..');

const VALUE_FLAGS = ['--engine', '--locales', '--areas', '--base', '--limit', '--concurrency', '--batch-size', '--model', '--effort', '--cli', '--url', '--out'];
const SWITCH_FLAGS = ['--redraft', '--dry-run'];

export function parseArgs(argv) {
  const flags = readFlags(argv, { valueFlags: VALUE_FLAGS, switchFlags: SWITCH_FLAGS });
  const engine = flags.value('--engine') ?? 'claude';
  if (engine !== 'claude' && engine !== 'local') throw new Error(`--engine: ${engine} is not claude or local`);
  const isLocal = engine === 'local';
  return {
    engine,
    locales: flags.list('--locales'),
    areas: flags.list('--areas'),
    base: flags.value('--base'),
    redraft: flags.has('--redraft'),
    dryRun: flags.has('--dry-run'),
    limit: flags.positive('--limit'),
    concurrency: flags.positive('--concurrency') ?? (isLocal ? 1 : 4),
    batchSize: flags.positive('--batch-size') ?? DEFAULT_BATCH_SIZE[engine],
    model: flags.value('--model') ?? (isLocal ? REFILL_MODEL.name : DEFAULT_CLAUDE_MODEL),
    effort: flags.value('--effort') ?? DEFAULT_CLAUDE_EFFORT,
    cli: flags.value('--cli') ?? 'claude',
    url: flags.value('--url') ?? DEFAULT_LOCAL_URL,
    out: flags.value('--out'),
  };
}

/**
 * The one-line budget, in columns, of every description a settings card shows,
 * keyed by its English. A sentence shown in two places takes the tighter budget.
 */
export function descriptionBudgets(appModules, repoRoot) {
  const budgets = new Map();
  for (const description of appModules.scanRealSettings(repoRoot).descriptions) {
    if (typeof description.text !== 'string') continue;
    const budget = appModules.DESCRIPTION_BUDGET[description.context];
    budgets.set(description.text, Math.min(budgets.get(description.text) ?? budget, budget));
  }
  return budgets;
}

function createEngine(options) {
  if (options.engine === 'claude') return createClaudeEngine({ cli: options.cli, model: options.model, effort: options.effort });
  return createOpenAiCompatibleEngine({ url: options.url, model: options.model });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.dryRun) refuseIfAutomated('Every translation is a real model call.');
  // Lingui resolves catalog and source paths from the working directory.
  process.chdir(REPO_ROOT);

  const { config, catalogs } = await loadCatalogs(REPO_ROOT);
  const sourceLocale = config.sourceLocale;
  const knownLocales = config.locales.filter((locale) => locale !== sourceLocale);
  const locales = options.locales.length > 0 ? options.locales : knownLocales;
  const unknownLocales = locales.filter((locale) => !knownLocales.includes(locale));
  if (unknownLocales.length > 0) throw new Error(`Unknown locale ${unknownLocales.join(', ')}. Known: ${knownLocales.join(', ')}`);
  const knownAreas = catalogs.map(({ area }) => area);
  const unknownAreas = options.areas.filter((area) => !knownAreas.includes(area));
  if (unknownAreas.length > 0) throw new Error(`Unknown area ${unknownAreas.join(', ')}. Known: ${knownAreas.join(', ')}`);
  const selectedCatalogs = options.areas.length > 0 ? catalogs.filter(({ area }) => options.areas.includes(area)) : catalogs;

  const appModules = await loadAppModules();
  const budgets = descriptionBudgets(appModules, REPO_ROOT);
  const glossary = loadGlossary();
  const readSource = sourceReader(REPO_ROOT);
  const baseRef = resolveBaseRef(REPO_ROOT, options.base);
  const engine = options.dryRun ? null : createEngine(options);
  const outDirectory = options.out ?? fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-i18n-run-'));
  fs.mkdirSync(outDirectory, { recursive: true });

  const report = { startedAt: new Date().toISOString(), engine: engine?.name ?? 'dry-run', baseRef, catalogs: [] };
  let remaining = options.limit ?? Number.POSITIVE_INFINITY;
  let wroteAny = false;
  try {
    for (const locale of locales) {
      for (const { area, catalog } of selectedCatalogs) {
        if (remaining <= 0) break;
        const messages = (await catalog.read(locale)) ?? {};
        const ids = selectEntryIds(messages, { redraft: options.redraft }).slice(0, remaining);
        if (ids.length === 0) continue;
        remaining -= ids.length;
        console.log(`[i18n] ${locale} ${area}: ${ids.length} to translate`);
        if (options.dryRun) {
          report.catalogs.push({ locale, area, selected: ids.length, entries: ids.map((id) => messages[id].message) });
          continue;
        }
        const removed = removedEntries(await readCatalogAt(catalog, locale, baseRef, REPO_ROOT), messages);
        const { outcomes, usage } = await translateEntries({
          locale,
          entries: ids.map((id) => ({ id, message: messages[id] })),
          allMessages: messages,
          engine,
          glossary,
          budgetFor: (message) => budgets.get(message.message) ?? null,
          widthOfCodepoint: appModules.wcwidthV11,
          readSource,
          removed,
          batchSize: options.batchSize,
          concurrency: options.concurrency,
        });
        const { counts, problems } = applyOutcomes(messages, outcomes);
        if (counts.translated > 0) {
          await catalog.write(locale, messages);
          wroteAny = true;
        }
        console.log(`[i18n] ${locale} ${area}: ${counts.translated} translated, ${counts.flagged} flagged, ${counts.manual} left for a person`);
        report.catalogs.push({ locale, area, selected: ids.length, ...counts, usage, problems });
      }
    }
  } finally {
    engine?.close();
    const reportPath = path.join(outDirectory, 'translate-report.json');
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`[i18n] Report: ${reportPath}`);
  }

  if (wroteAny) {
    const { checkCatalogs } = createRequire(import.meta.url)('../i18n-catalogs.js');
    checkCatalogs(REPO_ROOT);
  }
}

if (isEntrypoint(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
