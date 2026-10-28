#!/usr/bin/env node
/**
 * Translate README.md into every shipped language (`npm run i18n:translate-readme`).
 *
 * Writes `README.<locale>.md` at the repo root for each non-English entry in
 * SHIPPED_LOCALES, with headless `claude -p` (engines/claude.mjs). Each one opens
 * with a stamp naming the README.md blob it was translated from, and every README
 * carries the language switcher this script renders. A translation is checked
 * (readme.mjs) and retried with its problems up to two more times. A run writes
 * nothing unless every locale it translates passes, so a failed run leaves the
 * tree as it was. docs/contributing/translations.md is the guide.
 *
 *   npm run i18n:translate-readme
 *   npm run i18n:translate-readme -- --stale
 *   npm run i18n:translate-readme -- --check
 *
 * Options:
 *   --locales a,b        locales to translate (default: every shipped one but English)
 *   --stale              translate only those whose file is missing or stale
 *   --check              list each locale's state; write nothing, call no model
 *   --concurrency <n>    translations at once (default 4)
 *   --model <id>         Claude model (default the harness's)
 *   --effort <level>     Claude effort (default medium)
 *   --cli <path>         the claude executable (default claude)
 *
 * A translation whose stamped README differs from the current one only in the
 * switcher is restamped without a model call. Every run that writes re-renders
 * the switcher in README.md and every translation.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import PQueue from 'p-queue';
import { importTsModule } from '../lib/bundle-ts-module.mjs';
import { gitOutput } from '../lib/git-output.mjs';
import { isEntrypoint } from '../lib/is-entrypoint.mjs';
import { readFlags, refuseIfAutomated } from './cli.mjs';
import { createClaudeCaller, DEFAULT_CLAUDE_EFFORT, DEFAULT_CLAUDE_MODEL } from './engines/claude.mjs';
import { loadGlossary } from './glossary.mjs';
import { languageName } from './prompt.mjs';
import { DEFAULT_MAX_RETRIES } from './translate-catalog.mjs';
import {
  composeTranslation,
  documentTerms,
  ENGLISH_NOTICE,
  gitBlobHash,
  normalizeNewlines,
  readmeFileName,
  readmeProblems,
  readStamp,
  renderSwitcher,
  replaceSwitcher,
  restamp,
  shortHash,
  translatableSource,
} from './readme.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, '..', '..');
const LOCALES_MODULE = path.join(REPO_ROOT, 'src', 'shared', 'i18n', 'locales.ts');

const VALUE_FLAGS = ['--locales', '--concurrency', '--model', '--effort', '--cli'];
const SWITCH_FLAGS = ['--stale', '--check'];
/** The states a `--stale` run translates. */
const NEEDS_TRANSLATION = ['missing', 'stale'];

export function parseArgs(argv) {
  const flags = readFlags(argv, { valueFlags: VALUE_FLAGS, switchFlags: SWITCH_FLAGS });
  return {
    locales: [...new Set(flags.list('--locales'))],
    stale: flags.has('--stale'),
    check: flags.has('--check'),
    concurrency: flags.positive('--concurrency') ?? 4,
    model: flags.value('--model') ?? DEFAULT_CLAUDE_MODEL,
    effort: flags.value('--effort') ?? DEFAULT_CLAUDE_EFFORT,
    cli: flags.value('--cli') ?? 'claude',
  };
}

/** The reply, as JSON Schema for `--json-schema`. */
const REPLY_SCHEMA = {
  type: 'object',
  properties: {
    markdown: { type: 'string' },
    notice: { type: 'string' },
  },
  required: ['markdown', 'notice'],
  additionalProperties: false,
};

function readmeSystemPrompt(locale) {
  const language = languageName(locale);
  return [
    `You translate the README of Kangentic, an open-source desktop app where developers run AI coding agents as tasks on a kanban board, from English into ${language} (${locale}).`,
    '',
    'The user message is JSON: the README as "markdown" and a one-line "notice". Reply with JSON only: {"markdown": ..., "notice": ...}, both translated.',
    '',
    'Rules:',
    '1. Keep the document line for line: the same number of lines, each starting with the same Markdown or HTML (heading marks, list marks, tags, comments, blank lines). Translate the words of each line in place.',
    '2. Copy exactly, never translate: fenced code blocks, text in backticks, URLs and link targets, email addresses, HTML comments, and every HTML tag with its attributes. The one attribute to translate is alt="...".',
    '3. Translate headings, prose, list items, link text and alt text. Keep each [text](target) link with its target unchanged.',
    '4. "glossary": keep each "keep" name exactly as written, and use the given word for each "terms" entry, inflected as the sentence needs.',
    `5. Write the plain, direct register of ${language} developer documentation, as VS Code's documentation reads in ${language}. Keep the meaning: add nothing and drop nothing.`,
    '6. The notice holds the tokens {readme} and {revision}. Write each token once, exactly as given.',
    '7. "problems" lists what was wrong with your last answer. Fix every one.',
  ].join('\n');
}

export function readmeUserPrompt({ source, terms, problems }) {
  const request = { markdown: source, notice: ENGLISH_NOTICE };
  if (terms.keep.length > 0 || terms.terms.length > 0) request.glossary = terms;
  if (problems.length > 0) request.problems = problems;
  return JSON.stringify(request, null, 1);
}

/**
 * Where a translation stands against README.md:
 * - `missing`: no file (`text` is null);
 * - `current`: stamped with README.md's blob;
 * - `restampable`: stamped with a blob that differs from README.md only in the switcher;
 * - `stale`: anything else, including no stamp and a stamped blob git cannot read.
 *
 * `readBlob(blob)` returns that README.md blob's text, or null when git cannot read it.
 */
export function translationState({ text, englishBlob, englishSource, readBlob }) {
  if (text === null) return 'missing';
  const stampedBlob = readStamp(text);
  if (stampedBlob === englishBlob) return 'current';
  if (!stampedBlob) return 'stale';
  const stampedReadme = readBlob(stampedBlob);
  if (stampedReadme === null) return 'stale';
  try {
    return translatableSource(stampedReadme).trimEnd() === englishSource.trimEnd() ? 'restampable' : 'stale';
  } catch {
    // A README.md from before the switcher has no block to empty.
    return 'stale';
  }
}

/** Reads README.md blobs through git, once each, since the translations usually share one stamp. */
function gitBlobReader() {
  const texts = new Map();
  return (blob) => {
    if (!texts.has(blob)) {
      try {
        texts.set(blob, gitOutput(REPO_ROOT, ['cat-file', 'blob', blob]));
      } catch {
        texts.set(blob, null);
      }
    }
    return texts.get(blob);
  };
}

/**
 * One locale's translation, checked and retried with its problems. Resolves
 * `{ ok: true, markdown, notice, usage }`, or `{ ok: false, problems, usage }`
 * with the last attempt's problems.
 */
export async function translateLocale({ caller, locale, source, glossary }) {
  const terms = documentTerms(source, locale, glossary);
  const system = readmeSystemPrompt(locale);
  const usage = { calls: 0, costUsd: 0 };
  let problems = [];
  for (let attempt = 1; attempt <= DEFAULT_MAX_RETRIES + 1; attempt += 1) {
    let reply;
    usage.calls += 1;
    try {
      const result = await caller.ask({ system, user: readmeUserPrompt({ source, terms, problems }), schema: REPLY_SCHEMA });
      reply = result.reply;
      usage.costUsd += result.usage.costUsd;
    } catch (error) {
      // A failed call can still be billed, and the engine puts that cost on the error.
      if (error instanceof Error && typeof error.costUsd === 'number') usage.costUsd += error.costUsd;
      problems = [`the call failed: ${error instanceof Error ? error.message : String(error)}`];
      console.log(`[readme] ${locale}: attempt ${attempt} failed: ${problems[0]}`);
      continue;
    }
    const markdown = normalizeNewlines(typeof reply?.markdown === 'string' ? reply.markdown : '');
    const notice = typeof reply?.notice === 'string' ? reply.notice.trim() : '';
    problems = readmeProblems({ source, translated: markdown, notice, locale, glossary });
    if (problems.length === 0) {
      console.log(`[readme] ${locale}: translated on attempt ${attempt} ($${usage.costUsd.toFixed(2)})`);
      return { ok: true, markdown, notice, usage };
    }
    console.log(`[readme] ${locale}: attempt ${attempt} has ${problems.length} problem(s)`);
  }
  return { ok: false, problems, usage };
}

/**
 * An existing translation the run does not redraft, under a fresh switcher and
 * restamped when its state is `restampable`. Throws when the file has lost its
 * switcher block or its notice's hash.
 */
export function keptTranslation({ text, state, englishBlob, switcher }) {
  const withSwitcher = replaceSwitcher(text, switcher);
  return state === 'restampable' ? restamp(withSwitcher, englishBlob) : withSwitcher;
}

/** The line a run ends with, which /release Step 1.6 keeps for its report. */
export function runSummary({ shortBlob, translatedLocales, states, translated, restamped, updated, costUsd }) {
  const leftStale = translatedLocales.filter((locale) => !translated.includes(locale) && NEEDS_TRANSLATION.includes(states.get(locale)));
  const current = translatedLocales.length - translated.length - restamped.length - leftStale.length;
  const parts = [];
  if (translated.length > 0) parts.push(`translated ${translated.join(', ')}`);
  if (restamped.length > 0) parts.push(`restamped ${restamped.join(', ')}`);
  if (leftStale.length > 0) parts.push(`still stale or missing ${leftStale.join(', ')}`);
  parts.push(current === translatedLocales.length ? `all ${current} current` : `${current} already current`);
  if (updated.length > 0) parts.push(`updated ${updated.join(', ')}`);
  return `README translations at ${shortBlob}: ${parts.join('; ')} ($${costUsd.toFixed(2)})`;
}

function readNormalized(filePath) {
  return normalizeNewlines(fs.readFileSync(filePath, 'utf8'));
}

function writeIfChanged(filePath, text) {
  const before = fs.existsSync(filePath) ? readNormalized(filePath) : null;
  if (before === text) return false;
  fs.writeFileSync(filePath, text);
  return true;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.check) refuseIfAutomated('Every translation is a real model call.');

  const { SHIPPED_LOCALES, LOCALE_NATIVE_NAMES, SOURCE_LOCALE } = await importTsModule(LOCALES_MODULE);
  const translatedLocales = SHIPPED_LOCALES.filter((locale) => locale !== SOURCE_LOCALE);
  const unknownLocales = options.locales.filter((locale) => !translatedLocales.includes(locale));
  if (unknownLocales.length > 0) throw new Error(`Not a shipped translation locale: ${unknownLocales.join(', ')}. Shipped: ${translatedLocales.join(', ')}`);
  const requestedLocales = options.locales.length > 0 ? options.locales : translatedLocales;
  const fileFor = (locale) => readmeFileName(locale, SOURCE_LOCALE);
  const pathFor = (locale) => path.join(REPO_ROOT, fileFor(locale));
  const switcherFor = (locale) => renderSwitcher(locale, SHIPPED_LOCALES, LOCALE_NATIVE_NAMES, SOURCE_LOCALE);

  const englishOnDisk = readNormalized(pathFor(SOURCE_LOCALE));
  const english = replaceSwitcher(englishOnDisk, switcherFor(SOURCE_LOCALE));
  const englishBlob = gitBlobHash(english);
  const englishSource = translatableSource(english);
  const shortBlob = shortHash(englishBlob);
  const readBlob = gitBlobReader();
  const texts = new Map(translatedLocales.map((locale) => [locale, fs.existsSync(pathFor(locale)) ? readNormalized(pathFor(locale)) : null]));
  const states = new Map(translatedLocales.map((locale) => [locale, translationState({ text: texts.get(locale), englishBlob, englishSource, readBlob })]));

  if (options.check) {
    if (english !== englishOnDisk) console.log('[readme] README.md: switcher out of date');
    const counts = new Map();
    for (const [locale, state] of states) {
      console.log(`[readme] ${fileFor(locale)}: ${state}`);
      counts.set(state, (counts.get(state) ?? 0) + 1);
    }
    console.log(`README translations at ${shortBlob}: ${[...counts].map(([state, count]) => `${count} ${state}`).join(', ')}`);
    return;
  }

  const toTranslate = requestedLocales.filter((locale) => !options.stale || NEEDS_TRANSLATION.includes(states.get(locale)));
  // The files that need no model call are built first, so a broken one stops the run before it spends anything.
  const kept = new Map(translatedLocales
    .filter((locale) => !toTranslate.includes(locale) && states.get(locale) !== 'missing')
    .map((locale) => [locale, keptTranslation({ text: texts.get(locale), state: states.get(locale), englishBlob, switcher: switcherFor(locale) })]));

  const results = new Map();
  if (toTranslate.length > 0) {
    const glossary = loadGlossary();
    const caller = createClaudeCaller({ cli: options.cli, model: options.model, effort: options.effort });
    try {
      const queue = new PQueue({ concurrency: options.concurrency });
      await Promise.all(toTranslate.map((locale) => queue.add(async () => {
        results.set(locale, await translateLocale({ caller, locale, source: englishSource, glossary }));
      })));
    } finally {
      caller.close();
    }
  }
  const totalCost = [...results.values()].reduce((sum, result) => sum + result.usage.costUsd, 0);

  const failed = toTranslate.filter((locale) => !results.get(locale).ok);
  if (failed.length > 0) {
    for (const locale of failed) {
      console.error(`[readme] ${locale} failed after ${DEFAULT_MAX_RETRIES + 1} attempts:`);
      for (const problem of results.get(locale).problems) console.error(`  - ${problem}`);
    }
    console.error(`README translations at ${shortBlob}: FAILED for ${failed.join(', ')}. Nothing was written ($${totalCost.toFixed(2)} spent).`);
    process.exit(1);
  }

  // Every file is built before the first write.
  const files = new Map([[SOURCE_LOCALE, english], ...kept]);
  for (const locale of toTranslate) {
    const { markdown, notice } = results.get(locale);
    files.set(locale, composeTranslation({ blob: englishBlob, notice, body: replaceSwitcher(markdown, switcherFor(locale)) }));
  }
  const restamped = [...kept.keys()].filter((locale) => states.get(locale) === 'restampable');
  const updated = [];
  for (const [locale, text] of files) {
    const switcherOnly = locale === SOURCE_LOCALE || (kept.has(locale) && !restamped.includes(locale));
    if (writeIfChanged(pathFor(locale), text) && switcherOnly) updated.push(`${fileFor(locale)} switcher`);
  }

  const translated = translatedLocales.filter((locale) => results.has(locale));
  console.log(runSummary({ shortBlob, translatedLocales, states, translated, restamped, updated, costUsd: totalCost }));
}

if (isEntrypoint(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
