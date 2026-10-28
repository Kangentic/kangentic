#!/usr/bin/env node
/**
 * The local model bake-off for translation refills (docs/contributing/translations.md).
 * MANUAL ONLY: every step makes real model calls.
 *
 *   node scripts/i18n/bake-off/run.mjs translate --arm gemma-4-31b [--url <server /v1>]
 *   node scripts/i18n/bake-off/run.mjs judge
 *   node scripts/i18n/bake-off/run.mjs score [--write]
 *
 * `translate` sends the fixed sample (sample.json) through the real harness
 * pipeline into each bake-off locale for one arm (arms.json), and records what
 * passed validation on the first try and after retries, why the rest failed, the
 * wall time, and peak GPU memory. A local arm needs its llama-server running.
 *
 * `judge` shows Claude every arm's translation of each string side by side, under
 * shuffled letters so it cannot tell which arm wrote which, and records a 1 to 5
 * accuracy and fluency score and a critical-error flag for each.
 *
 * `score` combines them, applies the winner rule fixed before any run, and with
 * --write saves results.json: numbers and failure categories only. Translated
 * text stays in --out (default a folder under the OS temp folder), because the
 * repo's writing-style scan covers scripts/ and other languages' punctuation is
 * not ours to restyle.
 *
 * Common options: --out <dir>, --locales a,b, --kinds plural,tags (sample kinds),
 * --limit <n> (first n sample strings), --cli <claude executable>, --judge-model <id>,
 * --concurrency <n> (model calls at once, default 1, so a run never competes with
 * the developer's own work; run one step at a time for the same reason).
 * A trial run with --kinds or --limit belongs in its own --out, since score reads
 * every arm file there.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import PQueue from 'p-queue';
import { isEntrypoint } from '../../lib/is-entrypoint.mjs';
import { loadAppModules, readFlags, refuseIfAutomated, sourceReader } from '../cli.mjs';
import { loadGlossary } from '../glossary.mjs';
import { DEFAULT_BATCH_SIZE, translateEntries } from '../translate-catalog.mjs';
import { languageName } from '../prompt.mjs';
import { createClaudeCaller, createClaudeEngine } from '../engines/claude.mjs';
import { createOpenAiCompatibleEngine, DEFAULT_LOCAL_URL } from '../engines/openai-compatible.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, '..', '..', '..');
const SAMPLE_PATH = path.join(here, 'sample.json');
const ARMS_PATH = path.join(here, 'arms.json');
const RESULTS_PATH = path.join(here, 'results.json');
const DEFAULT_OUT = path.join(os.tmpdir(), 'kangentic-i18n-bake-off');
const DEFAULT_JUDGE_MODEL = 'claude-opus-5-5';

/**
 * The winner rule, fixed before any arm ran: among eligible arms whose final pass
 * rate is at least this in every locale, the highest mean judge score wins, and an
 * arm within the tie margin of the best wins instead when it is faster.
 */
export const WINNER_RULE = { minimumFinalPass: 0.95, tieMargin: 0.15 };

const VALUE_FLAGS = ['--arm', '--out', '--locales', '--kinds', '--limit', '--url', '--cli', '--judge-model', '--concurrency'];
const SWITCH_FLAGS = ['--write'];

export function parseArgs(argv) {
  const flags = readFlags(argv, { valueFlags: VALUE_FLAGS, switchFlags: SWITCH_FLAGS, positionalCount: 1 });
  return {
    concurrency: flags.positive('--concurrency') ?? 1,
    command: flags.positionals[0] ?? null,
    arm: flags.value('--arm'),
    out: flags.value('--out') ?? DEFAULT_OUT,
    locales: flags.list('--locales'),
    kinds: flags.list('--kinds'),
    limit: flags.positive('--limit'),
    url: flags.value('--url') ?? DEFAULT_LOCAL_URL,
    cli: flags.value('--cli') ?? 'claude',
    judgeModel: flags.value('--judge-model') ?? DEFAULT_JUDGE_MODEL,
    write: flags.has('--write'),
  };
}

export function loadSample() {
  return JSON.parse(fs.readFileSync(SAMPLE_PATH, 'utf8')).entries;
}

export function loadArms() {
  return JSON.parse(fs.readFileSync(ARMS_PATH, 'utf8'));
}

/** The sample as catalog messages, the shape the pipeline reads from a PO file. */
export function sampleMessages(entries) {
  return Object.fromEntries(entries.map((entry) => [entry.id, {
    message: entry.message,
    context: entry.context,
    comments: entry.comment ? [entry.comment] : [],
    origin: [[entry.origin, null]],
    translation: '',
    budget: entry.budget ?? null,
  }]));
}

/** A failure message's category, for the failure table. */
export function errorCategory(error) {
  if (/tokens must be|not a token|number token/.test(error)) return 'placeholders';
  if (/tags must/.test(error)) return 'tags';
  if (/brace outside|"#" outside|not valid ICU/.test(error)) return 'icu';
  if (/missing the forms/.test(error)) return 'plural-forms';
  if (/keep the name|translate ".*" as/.test(error)) return 'glossary';
  if (/columns wide/.test(error)) return 'width';
  if (/engine call failed/.test(error)) return 'engine';
  return 'reply';
}

function countCategories(errors) {
  const counts = {};
  for (const category of new Set(errors.map(errorCategory))) counts[category] = (counts[category] ?? 0) + 1;
  return counts;
}

/** Sample GPU memory in use every two seconds; `stop()` returns the peak in MiB, or null without nvidia-smi. */
function startVramSampler() {
  let peak = null;
  const sample = () => {
    try {
      const output = execFileSync('nvidia-smi', ['--query-gpu=memory.used', '--format=csv,noheader,nounits'], { encoding: 'utf8', windowsHide: true });
      const used = Number(output.trim().split(/\r?\n/)[0]);
      if (Number.isFinite(used)) peak = Math.max(peak ?? 0, used);
    } catch {
      // No NVIDIA GPU, or no driver tool on PATH.
    }
  };
  sample();
  const timer = setInterval(sample, 2000);
  return { stop: () => { clearInterval(timer); sample(); return peak; } };
}

async function translateArm(options) {
  const config = loadArms();
  const arm = config.arms.find((candidate) => candidate.name === options.arm);
  if (!arm) throw new Error(`--arm: ${options.arm} is not in arms.json (${config.arms.map((candidate) => candidate.name).join(', ')})`);
  const locales = options.locales.length > 0 ? options.locales : config.locales;
  const entries = loadSample()
    .filter((entry) => options.kinds.length === 0 || options.kinds.includes(entry.kind))
    .slice(0, options.limit ?? undefined);
  const messages = sampleMessages(entries);
  const appModules = await loadAppModules();
  const glossary = loadGlossary();
  const engine = arm.engine === 'claude'
    ? createClaudeEngine({ cli: options.cli, model: arm.model })
    : createOpenAiCompatibleEngine({ url: options.url, model: arm.name, promptStyle: arm.promptStyle });
  const isLocal = arm.engine !== 'claude';
  const vram = isLocal ? startVramSampler() : null;
  const record = { arm: arm.name, startedAt: new Date().toISOString(), sampleSize: entries.length, locales: {} };
  try {
    for (const locale of locales) {
      const started = performance.now();
      const { outcomes, usage } = await translateEntries({
        locale,
        entries: entries.map((entry) => ({ id: entry.id, message: messages[entry.id] })),
        allMessages: messages,
        engine,
        glossary,
        budgetFor: (message) => (message.budget ? appModules.DESCRIPTION_BUDGET[message.budget] : null),
        widthOfCodepoint: appModules.wcwidthV11,
        readSource: sourceReader(REPO_ROOT),
        batchSize: DEFAULT_BATCH_SIZE[isLocal ? 'local' : 'claude'],
        concurrency: options.concurrency,
      });
      const wallMs = performance.now() - started;
      record.locales[locale] = {
        wallMs,
        usage,
        entries: Object.fromEntries([...outcomes].map(([id, outcome]) => [id, {
          status: outcome.status,
          attempts: outcome.attempts,
          icu: outcome.icu ?? null,
          errors: outcome.errors,
          firstErrors: outcome.firstErrors ?? [],
          ...(outcome.status === 'flagged' ? { lastReply: outcome.lastReply ?? null } : {}),
        }])),
      };
      const translated = [...outcomes.values()].filter((outcome) => outcome.status === 'translated').length;
      console.log(`[bake-off] ${arm.name} ${locale}: ${translated}/${entries.length} in ${(wallMs / 1000).toFixed(0)}s`);
    }
  } finally {
    engine.close();
    record.vramPeakMiB = vram?.stop() ?? null;
  }
  fs.mkdirSync(options.out, { recursive: true });
  const file = path.join(options.out, `arm-${arm.name}.json`);
  fs.writeFileSync(file, `${JSON.stringify(record, null, 1)}\n`);
  console.log(`[bake-off] ${file}`);
}

function readArmRecords(out) {
  return fs.readdirSync(out)
    .filter((name) => name.startsWith('arm-') && name.endsWith('.json'))
    .map((name) => JSON.parse(fs.readFileSync(path.join(out, name), 'utf8')));
}

/** A stable shuffle per string and locale, so a re-run shows the judge the same letters. */
function shuffled(items, seed) {
  const keyed = items.map((item) => ({ item, key: createHash('sha256').update(`${seed}:${item.arm}`).digest('hex') }));
  return keyed.sort((left, right) => left.key.localeCompare(right.key)).map(({ item }) => item);
}

const JUDGE_SCHEMA = {
  type: 'object',
  properties: {
    scores: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          key: { type: 'string' },
          candidates: {
            type: 'object',
            additionalProperties: {
              type: 'object',
              properties: {
                accuracy: { type: 'integer', minimum: 1, maximum: 5 },
                fluency: { type: 'integer', minimum: 1, maximum: 5 },
                critical: { type: 'boolean' },
              },
              required: ['accuracy', 'fluency', 'critical'],
              additionalProperties: false,
            },
          },
        },
        required: ['key', 'candidates'],
        additionalProperties: false,
      },
    },
  },
  required: ['scores'],
  additionalProperties: false,
};

function judgeSystemPrompt(locale) {
  const language = languageName(locale);
  return [
    `You review ${language} (${locale}) translations of the user interface of Kangentic, a desktop app where developers run AI coding agents as tasks on a kanban board.`,
    '',
    'Each item is one English UI string in ICU MessageFormat with its context, and lettered candidate translations from different translators. Score every candidate on its own, compared with the English:',
    '- accuracy, 1 to 5: 5 says exactly what the English says; 3 loses or adds a detail; 1 says something else.',
    `- fluency, 1 to 5: 5 reads as native ${language} software UI, with correct grammar, a natural register for its place, and the usual ${language} software terms; 3 is understandable but stiff or literal; 1 is broken.`,
    `- critical: true when the candidate changes the meaning, leaves English that should be translated, or has a plural case whose sentence is wrong for the numbers ${language} uses that case for.`,
    '',
    'Braces such as {name}, the # in a plural, ICU plural and select syntax, quoted text such as \'{{cwd}}\', and tags such as <0>...</0> are app syntax the translator was told to keep. Do not mark down for keeping them. Product and tool names (Kangentic, Claude Code, Git, MCP) stay in English by design.',
    '',
    'Reply with JSON only: {"scores": [{"key": ..., "candidates": {"A": {"accuracy": ..., "fluency": ..., "critical": ...}, ...}}]}, scoring every candidate of every item.',
  ].join('\n');
}

async function judge(options) {
  const config = loadArms();
  const records = readArmRecords(options.out);
  if (records.length === 0) throw new Error(`No arm results in ${options.out}. Run translate first.`);
  const locales = options.locales.length > 0 ? options.locales : config.locales;
  const sample = loadSample();
  const caller = createClaudeCaller({ cli: options.cli, model: options.judgeModel, effort: 'medium' });
  const judgePath = path.join(options.out, 'judge.json');
  const verdicts = fs.existsSync(judgePath) ? JSON.parse(fs.readFileSync(judgePath, 'utf8')) : { judge: options.judgeModel, locales: {} };
  const queue = new PQueue({ concurrency: options.concurrency });
  try {
    for (const locale of locales) {
      verdicts.locales[locale] ??= {};
      const items = [];
      for (const entry of sample) {
        const candidates = records
          .map((record) => ({ arm: record.arm, icu: record.locales[locale]?.entries[entry.id]?.icu ?? null }))
          .filter((candidate) => candidate.icu !== null);
        const alreadyJudged = verdicts.locales[locale][entry.id];
        const pending = candidates.filter((candidate) => !alreadyJudged?.[candidate.arm]);
        if (pending.length === 0) continue;
        const lettered = shuffled(candidates, `${locale}:${entry.id}`).map((candidate, index) => ({ ...candidate, letter: String.fromCharCode(65 + index) }));
        items.push({ entry, lettered });
      }
      const batches = [];
      for (let index = 0; index < items.length; index += 10) batches.push(items.slice(index, index + 10));
      await Promise.all(batches.map((batch) => queue.add(async () => {
        const user = JSON.stringify(batch.map(({ entry, lettered }, index) => ({
          key: `k${index + 1}`,
          english: entry.message,
          ...(entry.context ? { context: entry.context } : {}),
          ...(entry.comment ? { comment: entry.comment } : {}),
          candidates: Object.fromEntries(lettered.map((candidate) => [candidate.letter, candidate.icu])),
        })), null, 1);
        const { reply } = await caller.ask({ system: judgeSystemPrompt(locale), user, schema: JUDGE_SCHEMA });
        if (!Array.isArray(reply?.scores)) throw new Error(`the judge's ${locale} reply has no "scores" list`);
        const byKey = new Map(reply.scores.map((score) => [score.key, score.candidates]));
        batch.forEach(({ entry, lettered }, index) => {
          const scores = byKey.get(`k${index + 1}`) ?? {};
          verdicts.locales[locale][entry.id] ??= {};
          for (const candidate of lettered) {
            const score = scores[candidate.letter];
            if (score) verdicts.locales[locale][entry.id][candidate.arm] = { accuracy: score.accuracy, fluency: score.fluency, critical: score.critical };
          }
        });
        fs.writeFileSync(judgePath, `${JSON.stringify(verdicts, null, 1)}\n`);
      })));
      console.log(`[bake-off] judged ${locale}: ${items.length} strings`);
    }
  } finally {
    caller.close();
  }
  console.log(`[bake-off] ${judgePath}`);
}

const mean = (values) => (values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length);
const round = (value, digits = 3) => (value === null ? null : Number(value.toFixed(digits)));

/** Combine arm records and verdicts into the committed results, and pick the winner. */
export function scoreRecords({ records, verdicts, arms, sample, locales }) {
  const kinds = [...new Set(sample.map((entry) => entry.kind))];
  const kindOf = new Map(sample.map((entry) => [entry.id, entry.kind]));
  const armResults = records.map((record) => {
    const armConfig = arms.find((candidate) => candidate.name === record.arm) ?? {};
    const perLocale = {};
    const perString = {};
    const firstFailures = {};
    const finalFailures = {};
    const byKind = Object.fromEntries(kinds.map((kind) => [kind, { judged: [], passed: 0, total: 0 }]));
    let outputTokens = 0;
    let wallMs = 0;
    for (const locale of locales) {
      const localeRecord = record.locales[locale];
      if (!localeRecord) continue;
      const entries = Object.entries(localeRecord.entries);
      const judgeScores = [];
      let criticals = 0;
      perString[locale] = {};
      for (const [id, outcome] of entries) {
        const verdict = verdicts?.locales?.[locale]?.[id]?.[record.arm] ?? null;
        const passed = outcome.status === 'translated';
        const score = verdict ? (verdict.accuracy + verdict.fluency) / 2 : null;
        if (score !== null) judgeScores.push(score);
        if (verdict?.critical) criticals += 1;
        for (const [category, count] of Object.entries(countCategories(outcome.firstErrors ?? []))) firstFailures[category] = (firstFailures[category] ?? 0) + count;
        if (!passed) for (const [category, count] of Object.entries(countCategories(outcome.errors ?? []))) finalFailures[category] = (finalFailures[category] ?? 0) + count;
        const kind = byKind[kindOf.get(id)];
        if (kind) {
          kind.total += 1;
          if (passed) kind.passed += 1;
          if (score !== null) kind.judged.push(score);
        }
        perString[locale][id] = [passed ? 1 : 0, outcome.attempts, verdict?.accuracy ?? null, verdict?.fluency ?? null, verdict ? (verdict.critical ? 1 : 0) : null];
      }
      const total = entries.length;
      perLocale[locale] = {
        firstTryPass: round(entries.filter(([, outcome]) => outcome.status === 'translated' && outcome.attempts === 1).length / total),
        finalPass: round(entries.filter(([, outcome]) => outcome.status === 'translated').length / total),
        judgeMean: round(mean(judgeScores)),
        criticalRate: judgeScores.length === 0 ? null : round(criticals / judgeScores.length),
        wallSeconds: round(localeRecord.wallMs / 1000, 1),
      };
      outputTokens += localeRecord.usage?.outputTokens ?? 0;
      wallMs += localeRecord.wallMs;
    }
    const localeValues = Object.values(perLocale);
    return {
      arm: record.arm,
      role: armConfig.role ?? null,
      license: armConfig.license ?? null,
      eligible: armConfig.eligible === true,
      huggingFace: armConfig.huggingFace ?? null,
      quant: armConfig.quant ?? null,
      overall: {
        firstTryPass: round(mean(localeValues.map((value) => value.firstTryPass))),
        finalPass: round(mean(localeValues.map((value) => value.finalPass))),
        worstLocaleFinalPass: localeValues.length === 0 ? null : round(Math.min(...localeValues.map((value) => value.finalPass))),
        judgeMean: round(mean(localeValues.map((value) => value.judgeMean).filter((value) => value !== null))),
        criticalRate: round(mean(localeValues.map((value) => value.criticalRate).filter((value) => value !== null))),
        wallSeconds: round(wallMs / 1000, 1),
        outputTokensPerSecond: wallMs === 0 ? null : round(outputTokens / (wallMs / 1000), 1),
        vramPeakMiB: record.vramPeakMiB ?? null,
      },
      perLocale,
      byKind: Object.fromEntries(Object.entries(byKind).map(([kind, values]) => [kind, {
        finalPass: values.total === 0 ? null : round(values.passed / values.total),
        judgeMean: round(mean(values.judged)),
      }])),
      firstTryFailures: firstFailures,
      finalFailures,
      perString,
    };
  });

  const qualified = armResults.filter((result) => result.eligible && (result.overall.worstLocaleFinalPass ?? 0) >= WINNER_RULE.minimumFinalPass && result.overall.judgeMean !== null);
  let winner = null;
  if (qualified.length > 0) {
    const best = Math.max(...qualified.map((result) => result.overall.judgeMean));
    const contenders = qualified.filter((result) => best - result.overall.judgeMean <= WINNER_RULE.tieMargin);
    contenders.sort((left, right) => left.overall.wallSeconds - right.overall.wallSeconds);
    winner = contenders[0].arm;
  }
  return {
    about: 'Bake-off results (scripts/i18n/bake-off/run.mjs). Numbers and failure categories only. perString holds, per arm, locale and sample id: [passed, attempts, accuracy, fluency, critical]. The translated text stays out of the repo.',
    generatedAt: new Date().toISOString(),
    sampleSize: sample.length,
    locales,
    judge: verdicts?.judge ?? null,
    winnerRule: WINNER_RULE,
    winner,
    arms: armResults,
  };
}

const JSON_PRIMITIVE = String.raw`(?:"(?:[^"\\]|\\.)*"|-?\d[\d.eE+-]*|true|false|null)`;
/**
 * An indented array whose elements are all numbers, strings, booleans or null.
 * It opens with `[` and a line break, which never occurs inside a string, since
 * JSON escapes a newline there, so a bracket in a string value never matches.
 */
const PRIMITIVE_ARRAY = new RegExp(String.raw`\[\n\s*(${JSON_PRIMITIVE}(?:,\n\s*${JSON_PRIMITIVE})*)\n\s*\]`, 'g');

/**
 * results.json as written: indented, with each array of numbers or strings on
 * one line, so a string's five scores stay one line instead of seven.
 */
export function formatResults(results) {
  const indented = JSON.stringify(results, null, 1);
  return `${indented.replace(PRIMITIVE_ARRAY, (match, elements) => `[${elements.replace(/,\n\s*/g, ', ')}]`)}\n`;
}

function printTable(results) {
  const rows = results.arms.map((result) => `| ${result.arm} | ${result.role} | ${result.overall.firstTryPass} | ${result.overall.finalPass} | ${result.overall.worstLocaleFinalPass} | ${result.overall.judgeMean} | ${result.overall.criticalRate} | ${result.overall.wallSeconds} | ${result.overall.vramPeakMiB ?? ''} |`);
  console.log('| Arm | Role | First-try pass | Final pass | Worst locale | Judge mean | Critical rate | Wall seconds | Peak VRAM MiB |');
  console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const row of rows) console.log(row);
  console.log(`Winner: ${results.winner ?? 'none qualified'}`);
}

async function score(options) {
  const config = loadArms();
  const records = readArmRecords(options.out);
  const judgePath = path.join(options.out, 'judge.json');
  const verdicts = fs.existsSync(judgePath) ? JSON.parse(fs.readFileSync(judgePath, 'utf8')) : null;
  const locales = options.locales.length > 0 ? options.locales : config.locales;
  const results = scoreRecords({ records, verdicts, arms: config.arms, sample: loadSample(), locales });
  printTable(results);
  if (options.write) {
    fs.writeFileSync(RESULTS_PATH, formatResults(results));
    console.log(`[bake-off] ${RESULTS_PATH}`);
  }
}

async function main() {
  refuseIfAutomated('The bake-off makes real model calls.');
  const options = parseArgs(process.argv.slice(2));
  if (options.command === 'translate') await translateArm(options);
  else if (options.command === 'judge') await judge(options);
  else if (options.command === 'score') await score(options);
  else throw new Error('Usage: run.mjs translate --arm <name> | judge | score [--write]');
}

if (isEntrypoint(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
