/**
 * How many bytes of tool output a real agent reads to answer questions from `docs/`, measured before
 * and after a docs restructure (the OKF bundle, task 889). What it counts is what the agent's
 * context actually received, not the size of the file that holds the answer, because a split always
 * wins that comparison while an agent that greps and reads a line range may not gain at all.
 *
 * MANUAL ONLY, like `eval-condition-check.mjs`: every question in `run` is a real agent call, so
 * `run` refuses to start where a CI variable is set. `summary` and `compare` spend nothing.
 *
 *   node scripts/eval-docs-reads.mjs run --ref <git ref> --label baseline --out <dir> [--runs 3]
 *     [--model sonnet] [--effort medium] [--concurrency 4] [--only id,...] [--cli <path>]
 *   node scripts/eval-docs-reads.mjs summary --out <dir>/<label>
 *   node scripts/eval-docs-reads.mjs compare --baseline <dir>/<label> --candidate <dir>/<label>
 *
 * RUN checks out `--ref` as a detached worktree under `<out>/<label>/checkout`, so a rerun reads the
 * docs of that commit and no other, and removes it by its exact path afterwards. Each question goes to
 * `claude -p` from that checkout with only the Read, Grep and Glob tools, no MCP servers, no auto
 * memory and no session file, and the stream-json output is tallied:
 *
 *   - `toolResultBytes`: UTF-8 bytes of every tool result the main agent got, deduped by
 *     `tool_use_id`, with subagent (sidechain) lines left out.
 *   - `reminderBytes`: the `<system-reminder>` text inside those results or beside them (a
 *     path-scoped rule injected because a read file matched its `paths:`), split out because moving
 *     a doc changes which rules inject, which is not the cost of reading the doc.
 *   - `gateBytes`: tool result bytes less reminder bytes. The gate sums these.
 *   - `docsBytes`: the share of `gateBytes` whose tool input path sits under `docs/`.
 *
 * Every answer is graded by the question's `expect` patterns (all must match, case-insensitive) and
 * kept in `records.jsonl` for a read by hand. Raw output holds the checkout's absolute paths, so the
 * records stay out of the repository; only the numbers go in `docs/log.md`.
 *
 * The gate (fixed before the pilot run, task 889): the candidate passes when the drop in summed median
 * `gateBytes` over the `pilot` questions is larger than the largest absolute change any `control`
 * question shows between the two runs, and no pilot question passes fewer runs than it did before.
 * With three runs, "any drop" would pass on noise; the controls' own drift is the noise estimate.
 *
 * The second round (`--questions scripts/eval-docs-reads-questions-v2.json`) asks what the first could
 * not: questions with no keyword to grep for, and questions that span several concepts. Its prompt
 * prefix names the docs index, the same in both arms. Each record also carries `trace` (every call's
 * tool, target relative to the checkout, and result bytes) and `contextTokens` (every input token the
 * run's requests carried). `compare` on such a set prints `pairedComparison`: per-measure
 * candidate-over-baseline ratios with a 95% bootstrap interval. How to read it was fixed in
 * docs/log.md before the runs.
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { isEntrypoint } from './lib/is-entrypoint.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '..');
/** Every file of this harness starts with this name: the script, its question sets, its test. */
export const HARNESS_FILE_PREFIX = path.basename(fileURLToPath(import.meta.url), '.mjs');
const QUESTIONS_PATH = path.join(HERE, 'eval-docs-reads-questions.json');
/** The second round's set: questions with no greppable keyword, and questions that span concepts. */
export const SECOND_ROUND_QUESTIONS_PATH = path.join(HERE, 'eval-docs-reads-questions-v2.json');
/** Past this, a run counts as failed and its CLI is stopped. */
const RUN_TIMEOUT_MS = 6 * 60_000;
const EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh', 'max'];
const MODEL_IDS = { haiku: 'claude-haiku-5-5', sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5' };
/** What every run's settings file holds: no advisor, no auto memory (both would vary the context). */
export const RUN_SETTINGS = { advisorModel: '', autoMemoryEnabled: false };
const PROMPT_PREFIX = 'Answer from this repository\'s documentation. Name the exact identifiers, flags and values you find.\n\n';
const REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

/** The question list: `{ id, group: 'pilot' | 'control', question, expect: string[] }`. */
export function loadQuestions() {
  return loadQuestionSet(QUESTIONS_PATH).questions;
}

/**
 * A question file: a bare list (the first round's file, which uses the default prompt prefix), or
 * `{ promptPrefix, questions }`. Every run of a set gets the same prefix in both arms, so a prefix
 * that names the docs index is a choice of the set, never of one arm.
 */
export function loadQuestionSet(file) {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (Array.isArray(parsed)) return { promptPrefix: PROMPT_PREFIX, questions: parsed };
  if (!parsed || !Array.isArray(parsed.questions)) throw new Error(`${file}: expected a list of questions or { promptPrefix, questions }`);
  return { promptPrefix: typeof parsed.promptPrefix === 'string' ? parsed.promptPrefix : PROMPT_PREFIX, questions: parsed.questions };
}

/** The flags each run passes: file tools only, no MCP, no session file, stream-json on stdout. */
export function runArgs({ settingsPath, model, effort }) {
  return [
    '--print',
    '--no-session-persistence',
    '--permission-prompts', 'none',
    '--tools', 'Read,Grep,Glob',
    '--strict-mcp-config',
    '--settings', settingsPath,
    '--output-format', 'stream-json',
    '--verbose',
    '--model', model,
    '--effort', effort,
  ];
}

function byteLength(text) {
  return Buffer.byteLength(text, 'utf8');
}

/** A tool result's text as the model saw it: a string, or text blocks joined (an image counts as nothing). */
function toolResultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((part) => part && part.type === 'text' && typeof part.text === 'string').map((part) => part.text).join('\n');
}

/** Bytes of the `<system-reminder>` blocks inside `text`. */
function reminderBytesOf(text) {
  return (text.match(REMINDER) ?? []).reduce((sum, block) => sum + byteLength(block), 0);
}

/** Whether a tool call's input points under `<checkout>/docs`. Case folds only where the filesystem does. */
export function readsDocs(input, checkout) {
  const target = input?.file_path ?? input?.path ?? null;
  if (typeof target !== 'string' || target.length === 0) return false;
  const foldCase = process.platform === 'win32' || process.platform === 'darwin';
  const normalize = (value) => {
    const forward = value.replace(/\\/g, '/').replace(/\/+$/, '');
    return foldCase ? forward.toLowerCase() : forward;
  };
  const docsRoot = `${normalize(path.resolve(checkout))}/docs`;
  // Resolved even when absolute, so `<checkout>/docs/../src/x.ts` is not counted as a docs read.
  const resolved = normalize(path.resolve(checkout, target.replace(/\\/g, '/')));
  return resolved === docsRoot || resolved.startsWith(`${docsRoot}/`);
}

/**
 * What a tool call aimed at, for the trace: a path relative to the checkout (forward slashes), or
 * for a search its pattern with the path it searched. Absolute paths would put machine paths in the
 * records, so a path outside the checkout keeps only its file name.
 */
export function callTarget(name, input, checkout) {
  const relative = (value) => {
    if (typeof value !== 'string' || value.length === 0) return null;
    const resolved = path.resolve(checkout, value.replace(/\\/g, '/'));
    const inside = path.relative(path.resolve(checkout), resolved);
    if (inside.startsWith('..') || path.isAbsolute(inside)) return path.basename(resolved);
    return inside.replace(/\\/g, '/') || '.';
  };
  const where = relative(input?.file_path ?? input?.path ?? null);
  if (name === 'Grep' || name === 'Glob') {
    const pattern = typeof input?.pattern === 'string' ? input.pattern : '';
    return where ? `${pattern} @ ${where}` : pattern;
  }
  return where ?? '';
}

/**
 * One run's numbers from its stream-json stdout. Tool calls come from assistant lines and their
 * results from user lines; a line with a `parent_tool_use_id` is a subagent's and is left out.
 * `trace` lists each call in order with what it aimed at and the bytes it returned, so a run can show
 * whether the agent read an index, grepped, or opened a concept.
 */
export function tallyStream(stdout, checkout) {
  const calls = new Map();
  const seenResults = new Set();
  const tally = {
    toolCalls: 0,
    toolCallsByName: {},
    toolResultBytes: 0,
    reminderBytes: 0,
    gateBytes: 0,
    docsBytes: 0,
    contextTokens: null,
    outputTokens: null,
    trace: [],
    answer: null,
    costUsd: null,
    models: [],
    durationMs: null,
    isError: true,
  };
  for (const line of String(stdout).split(/\r?\n/)) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (!record || typeof record !== 'object') continue;
    if (record.parent_tool_use_id) continue;
    if (record.type === 'assistant') {
      for (const block of record.message?.content ?? []) {
        if (block?.type !== 'tool_use' || calls.has(block.id)) continue;
        const entry = { tool: block.name, target: callTarget(block.name, block.input, checkout), bytes: 0 };
        calls.set(block.id, { name: block.name, input: block.input, entry });
        tally.trace.push(entry);
        tally.toolCalls += 1;
        tally.toolCallsByName[block.name] = (tally.toolCallsByName[block.name] ?? 0) + 1;
      }
    } else if (record.type === 'user') {
      const content = record.message?.content;
      if (typeof content === 'string') {
        tally.reminderBytes += reminderBytesOf(content);
        continue;
      }
      for (const block of content ?? []) {
        if (block?.type === 'tool_result') {
          if (seenResults.has(block.tool_use_id)) continue;
          seenResults.add(block.tool_use_id);
          const text = toolResultText(block.content);
          const bytes = byteLength(text);
          const reminder = reminderBytesOf(text);
          tally.toolResultBytes += bytes;
          tally.reminderBytes += reminder;
          tally.gateBytes += bytes - reminder;
          const call = calls.get(block.tool_use_id);
          if (call) call.entry.bytes = bytes - reminder;
          if (readsDocs(call?.input, checkout)) tally.docsBytes += bytes - reminder;
        } else if (block?.type === 'text' && typeof block.text === 'string') {
          tally.reminderBytes += reminderBytesOf(block.text);
        }
      }
    } else if (record.type === 'result') {
      tally.answer = typeof record.result === 'string' ? record.result : null;
      tally.costUsd = typeof record.total_cost_usd === 'number' ? record.total_cost_usd : null;
      tally.models = Object.keys(record.modelUsage ?? {});
      tally.durationMs = typeof record.duration_ms === 'number' ? record.duration_ms : null;
      tally.isError = record.is_error === true;
      // Every token of context the run's requests carried (system prompt and tool results included),
      // cached or not: what the run cost in context, apart from which run happened to warm the cache.
      const usage = record.usage;
      if (usage && typeof usage === 'object') {
        const count = (value) => (typeof value === 'number' ? value : 0);
        tally.contextTokens = count(usage.input_tokens) + count(usage.cache_read_input_tokens) + count(usage.cache_creation_input_tokens);
        tally.outputTokens = typeof usage.output_tokens === 'number' ? usage.output_tokens : null;
      }
    }
  }
  return tally;
}

/** Whether every `expect` pattern matches the answer, case-insensitive. */
export function grade(answer, expect) {
  if (typeof answer !== 'string' || answer.length === 0) return false;
  return expect.every((pattern) => new RegExp(pattern, 'i').test(answer));
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Per question: runs, passes, and the medians the gate reads. */
export function summarize(records) {
  const groups = new Map();
  for (const record of records) {
    const group = groups.get(record.questionId) ?? { questionId: record.questionId, group: record.group, records: [] };
    group.records.push(record);
    groups.set(record.questionId, group);
  }
  return [...groups.values()].map(({ questionId, group, records: questionRecords }) => {
    const numbers = (key) => questionRecords.map((record) => record[key]).filter((value) => typeof value === 'number');
    return {
      questionId,
      group,
      runs: questionRecords.length,
      passes: questionRecords.filter((record) => record.passed).length,
      failedRuns: questionRecords.filter((record) => record.isError || record.exitCode !== 0).length,
      medianGateBytes: median(numbers('gateBytes')),
      medianDocsBytes: median(numbers('docsBytes')),
      medianReminderBytes: median(numbers('reminderBytes')),
      medianToolCalls: median(numbers('toolCalls')),
      medianCostUsd: median(numbers('costUsd')),
      totalCostUsd: numbers('costUsd').reduce((sum, cost) => sum + cost, 0),
    };
  });
}

/**
 * The pre-registered gate over two summaries. A question present in only one summary is reported
 * and leaves the gate failed, since the two runs did not ask the same thing.
 */
export function gate(baseline, candidate) {
  const byId = (rows) => new Map(rows.map((row) => [row.questionId, row]));
  const before = byId(baseline);
  const after = byId(candidate);
  const missing = [...new Set([...before.keys(), ...after.keys()])].filter((id) => !before.has(id) || !after.has(id));
  const pairs = [...before.keys()].filter((id) => after.has(id)).map((id) => ({ before: before.get(id), after: after.get(id) }));
  const pilot = pairs.filter((pair) => pair.before.group === 'pilot');
  const control = pairs.filter((pair) => pair.before.group === 'control');
  const pilotBefore = pilot.reduce((sum, pair) => sum + (pair.before.medianGateBytes ?? 0), 0);
  const pilotAfter = pilot.reduce((sum, pair) => sum + (pair.after.medianGateBytes ?? 0), 0);
  const pilotDrop = pilotBefore - pilotAfter;
  const controlNoise = control.reduce((largest, pair) => Math.max(largest, Math.abs((pair.after.medianGateBytes ?? 0) - (pair.before.medianGateBytes ?? 0))), 0);
  const fewerPasses = pilot.filter((pair) => pair.after.passes < pair.before.passes).map((pair) => pair.before.questionId);
  const reasons = [];
  if (missing.length > 0) reasons.push(`questions in only one run: ${missing.join(', ')}`);
  if (pilot.length === 0) reasons.push('no pilot questions in both runs');
  if (!(pilotDrop > controlNoise)) reasons.push(`pilot drop ${pilotDrop} is not above the control noise ${controlNoise}`);
  if (fewerPasses.length > 0) reasons.push(`fewer passes on: ${fewerPasses.join(', ')}`);
  return { pilotBefore, pilotAfter, pilotDrop, controlNoise, fewerPasses, passed: reasons.length === 0, reasons };
}

/** Deterministic PRNG, so a comparison's interval is the same on every read of the same records. */
function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

/** The measures a paired comparison reports, each a per-run number on a record. */
export const PAIRED_MEASURES = ['gateBytes', 'toolCalls', 'contextTokens', 'costUsd'];

function mean(values) {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * Two runs of one question set (the second round, task 889): per question the mean of each measure in
 * each arm, and overall the candidate-over-baseline ratio of the summed question means, with a 95%
 * bootstrap interval from resampling questions (fixed seed). A ratio under 1 means the candidate spent
 * less; an interval that spans 1 is no detectable difference. Pass rates are compared, not ratioed.
 * Only questions run in both arms count.
 */
export function pairedComparison(baselineRecords, candidateRecords, { draws = 2000, seed = 889 } = {}) {
  const byQuestion = (records) => {
    const groups = new Map();
    for (const record of records) {
      const entry = groups.get(record.questionId) ?? { group: record.group, records: [] };
      entry.records.push(record);
      groups.set(record.questionId, entry);
    }
    return groups;
  };
  const before = byQuestion(baselineRecords);
  const after = byQuestion(candidateRecords);
  const ids = [...before.keys()].filter((id) => after.has(id));
  const questionMeans = ids.map((id) => {
    const row = { questionId: id, group: before.get(id).group };
    for (const [arm, groups] of [['baseline', before], ['candidate', after]]) {
      const records = groups.get(id).records;
      row[arm] = { runs: records.length, passes: records.filter((record) => record.passed).length };
      for (const measure of PAIRED_MEASURES) {
        row[arm][measure] = mean(records.map((record) => record[measure]).filter((value) => typeof value === 'number'));
      }
    }
    return row;
  });
  const ratioOf = (rows, measure) => {
    const usable = rows.filter((row) => typeof row.baseline[measure] === 'number' && typeof row.candidate[measure] === 'number');
    const baseSum = usable.reduce((sum, row) => sum + row.baseline[measure], 0);
    const candidateSum = usable.reduce((sum, row) => sum + row.candidate[measure], 0);
    return baseSum > 0 ? candidateSum / baseSum : null;
  };
  const random = mulberry32(seed);
  const resamples = Array.from({ length: draws }, () => Array.from({ length: questionMeans.length }, () => questionMeans[Math.floor(random() * questionMeans.length)]));
  const percentile = (sorted, share) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(share * (sorted.length - 1))))];
  const measures = {};
  for (const measure of PAIRED_MEASURES) {
    const ratio = ratioOf(questionMeans, measure);
    const drawn = resamples.map((rows) => ratioOf(rows, measure)).filter((value) => typeof value === 'number').sort((left, right) => left - right);
    measures[measure] = { ratio, low: drawn.length > 0 ? percentile(drawn, 0.025) : null, high: drawn.length > 0 ? percentile(drawn, 0.975) : null };
  }
  const passRate = (arm) => {
    const runs = questionMeans.reduce((sum, row) => sum + row[arm].runs, 0);
    return runs > 0 ? questionMeans.reduce((sum, row) => sum + row[arm].passes, 0) / runs : null;
  };
  const groups = [...new Set(questionMeans.map((row) => row.group))].map((group) => {
    const rows = questionMeans.filter((row) => row.group === group);
    return { group, questions: rows.length, ...Object.fromEntries(PAIRED_MEASURES.map((measure) => [measure, ratioOf(rows, measure)])) };
  });
  return { questions: questionMeans, measures, groups, passRate: { baseline: passRate('baseline'), candidate: passRate('candidate') } };
}

export function parseArgs(argv) {
  const value = (flag) => {
    const at = argv.indexOf(flag);
    return at === -1 ? null : argv[at + 1] ?? null;
  };
  const runs = Number(value('--runs') ?? 3);
  if (!Number.isInteger(runs) || runs < 1) throw new Error(`--runs: ${value('--runs')} is not a positive whole number`);
  const concurrency = Number(value('--concurrency') ?? 4);
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error(`--concurrency: ${value('--concurrency')} is not a positive whole number`);
  const model = value('--model') ?? 'sonnet';
  if (!Object.hasOwn(MODEL_IDS, model)) throw new Error(`--model: ${model} is not one of ${Object.keys(MODEL_IDS).join(', ')}`);
  const effort = value('--effort') ?? 'medium';
  if (!EFFORT_ORDER.includes(effort)) throw new Error(`--effort: ${effort} is not one of ${EFFORT_ORDER.join(', ')}`);
  return {
    mode: argv[0],
    ref: value('--ref'),
    label: value('--label'),
    out: value('--out'),
    baseline: value('--baseline'),
    candidate: value('--candidate'),
    only: (value('--only') ?? '').split(',').filter(Boolean),
    questions: value('--questions'),
    cli: value('--cli') ?? 'claude',
    runs,
    concurrency,
    model,
    effort,
  };
}

function refuseIfAutomated() {
  const automated = ['CI', 'CONTINUOUS_INTEGRATION', 'GITHUB_ACTIONS', 'BUILD_NUMBER'].find((name) => process.env[name]);
  if (automated) throw new Error(`Refusing to run: ${automated} is set. Every question is a real agent call.`);
}

/** This shell's env minus Claude and Kangentic session markers, which would leak into the run. */
function runEnv() {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name.startsWith('CLAUDE') || name.startsWith('KANGENTIC')) delete env[name];
  }
  return env;
}

function removeDirectory(directory) {
  try {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    // Left in place; the OS temp sweep or the next run clears it.
  }
}

/**
 * Stop the CLI and anything it started. On Windows `child.kill()` ends only the CLI. On macOS and
 * Linux it also ends only the CLI, so a timed-out run's own children (ripgrep) can outlive it; this
 * matches the stopTree of eval-answer-models.mjs and eval-condition-check.mjs.
 */
function stopTree(child) {
  if (process.platform !== 'win32') {
    child.kill();
    return;
  }
  try {
    execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } catch {
    // Already gone.
  }
}

/** One question from the checkout. Never rejects: a CLI that cannot start resolves with code -1. */
function runOnce(cli, argv, prompt, cwd) {
  return new Promise((resolve) => {
    const started = performance.now();
    let child;
    try {
      child = spawn(cli, argv, { cwd, env: runEnv(), shell: false, windowsHide: true });
    } catch (error) {
      resolve({ code: -1, stdout: '', stderr: error instanceof Error ? error.message : String(error), wallMs: 0 });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const settle = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr: stderr.slice(-2000), wallMs: performance.now() - started });
    };
    const timer = setTimeout(() => stopTree(child), RUN_TIMEOUT_MS);
    child.on('error', (error) => {
      stderr += `${error.message}\n`;
      settle(-1);
    });
    child.stdin.on('error', () => {});
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('close', (code) => settle(code));
    child.stdin.end(prompt);
  });
}

/**
 * This harness's own files inside a checkout: its script, its question sets and its test. They hold
 * the answers' keywords, so an agent that greps the whole repository could find an answer there
 * instead of in docs/. Both arms delete them before the first question.
 */
export function harnessFilesIn(checkout) {
  const found = [];
  for (const folder of ['scripts', path.join('tests', 'unit')]) {
    const directory = path.join(checkout, folder);
    if (!fs.existsSync(directory)) continue;
    for (const name of fs.readdirSync(directory)) {
      if (name.startsWith(HARNESS_FILE_PREFIX)) found.push(path.join(directory, name));
    }
  }
  return found;
}

function git(args) {
  return execFileSync('git', ['-C', PROJECT_ROOT, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

async function run(options) {
  // First, before anything is read or checked out: every question is a real agent call.
  refuseIfAutomated();
  if (process.platform === 'win32' && /\.(cmd|bat|ps1)$/i.test(options.cli)) {
    throw new Error(`--cli names the shim ${options.cli}; pass the CLI's own executable`);
  }
  try {
    execFileSync(options.cli, ['--version'], { stdio: 'ignore', windowsHide: true, timeout: 30_000 });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    // Without a shell, Windows resolves only .exe and .com on PATH, so an npm `claude.cmd` is not found.
    throw new Error(`--cli ${options.cli} was not found; pass the CLI's own executable (--cli <path to claude${process.platform === 'win32' ? '.exe' : ''}>)`);
  }
  const questionSet = loadQuestionSet(options.questions ? path.resolve(options.questions) : QUESTIONS_PATH);
  const questions = questionSet.questions
    .filter((question) => options.only.length === 0 || options.only.includes(question.id));
  const commit = git(['rev-parse', '--verify', `${options.ref}^{commit}`]);
  const labelDirectory = path.resolve(options.out, options.label);
  if (fs.existsSync(path.join(labelDirectory, 'records.jsonl'))) {
    throw new Error(`${labelDirectory} already holds records; pick a new --label or --out`);
  }
  fs.mkdirSync(labelDirectory, { recursive: true });
  const checkout = path.join(labelDirectory, 'checkout');
  git(['worktree', 'add', '--detach', checkout, commit]);
  // Everything after the checkout exists runs inside the try, so a failure removes it.
  let settingsDirectory = null;
  try {
    for (const file of harnessFilesIn(checkout)) fs.rmSync(file, { force: true });
    settingsDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-docs-reads-settings-'));
    const settingsPath = path.join(settingsDirectory, 'settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify(RUN_SETTINGS));
    fs.writeFileSync(path.join(labelDirectory, 'run.json'), JSON.stringify({ ref: options.ref, commit, model: options.model, effort: options.effort, runs: options.runs, questions: options.questions ?? 'default' }, null, 2));
    await runQuestions({ options, questions, promptPrefix: questionSet.promptPrefix, commit, checkout, settingsPath, recordsPath: path.join(labelDirectory, 'records.jsonl') });
  } finally {
    if (settingsDirectory !== null) removeDirectory(settingsDirectory);
    try {
      git(['worktree', 'remove', '--force', checkout]);
    } catch (error) {
      console.error(`left the checkout at ${checkout}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return summary({ out: labelDirectory });
}

/** Every question `options.runs` times, `options.concurrency` at once, each record appended as it lands. */
async function runQuestions({ options, questions, promptPrefix, commit, checkout, settingsPath, recordsPath }) {
  const jobs = [];
  for (let attempt = 1; attempt <= options.runs; attempt += 1) {
    for (const question of questions) jobs.push({ question, attempt });
  }
  console.log(`${jobs.length} runs queued at ${commit.slice(0, 9)} (${options.model}:${options.effort})`);
  const modelId = MODEL_IDS[options.model];
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const { question, attempt } = jobs[next];
      next += 1;
      const outcome = await runOnce(options.cli, runArgs({ settingsPath, model: modelId, effort: options.effort }), `${promptPrefix}${question.question}`, checkout);
      const tally = tallyStream(outcome.stdout, checkout);
      const record = {
        questionId: question.id,
        group: question.group,
        attempt,
        passed: grade(tally.answer, question.expect),
        ...tally,
        wrongModel: tally.models.some((name) => !name.startsWith(modelId)),
        exitCode: outcome.code,
        wallMs: Math.round(outcome.wallMs),
        ...(outcome.code !== 0 ? { stderr: outcome.stderr } : {}),
      };
      fs.appendFileSync(recordsPath, `${JSON.stringify(record)}\n`);
      done += 1;
      console.log(`${String(done).padStart(3)}/${jobs.length} ${record.passed ? 'ok  ' : 'MISS'} ${question.id} #${attempt} gate=${tally.gateBytes}B docs=${tally.docsBytes}B reminders=${tally.reminderBytes}B calls=${tally.toolCalls} context=${tally.contextTokens ?? '?'}tok $${tally.costUsd ?? '?'}`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(options.concurrency, jobs.length) }, worker));
}

function readRecords(directory) {
  return fs.readFileSync(path.join(directory, 'records.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

/** The per-question table, from the records on disk. Spends nothing. */
function summary(options) {
  const rows = summarize(readRecords(options.out));
  fs.writeFileSync(path.join(options.out, 'summary.json'), JSON.stringify(rows, null, 2));
  console.log('\nquestion | group | passes | failed runs | median gate bytes | median docs bytes | median reminder bytes | median tool calls | median $ | total $');
  for (const row of rows) {
    console.log([
      row.questionId,
      row.group,
      `${row.passes}/${row.runs}`,
      row.failedRuns,
      row.medianGateBytes,
      row.medianDocsBytes,
      row.medianReminderBytes,
      row.medianToolCalls,
      row.medianCostUsd?.toFixed(4) ?? '-',
      row.totalCostUsd.toFixed(4),
    ].join(' | '));
  }
  return 0;
}

/**
 * Two runs side by side. A first-round set (pilot and control groups) gets the gate's verdict; any
 * other set gets the paired comparison, which has no verdict of its own: its pre-registered reading is
 * in docs/log.md. Spends nothing.
 */
function compare(options) {
  const baselineRecords = readRecords(options.baseline);
  const candidateRecords = readRecords(options.candidate);
  if (!baselineRecords.some((record) => record.group === 'pilot' || record.group === 'control')) {
    return comparePaired(baselineRecords, candidateRecords);
  }
  const baseline = summarize(baselineRecords);
  const candidate = summarize(candidateRecords);
  const after = new Map(candidate.map((row) => [row.questionId, row]));
  console.log('question | group | passes before | passes after | gate bytes before | gate bytes after | docs bytes before | docs bytes after');
  for (const row of baseline) {
    const other = after.get(row.questionId);
    console.log([
      row.questionId,
      row.group,
      `${row.passes}/${row.runs}`,
      other ? `${other.passes}/${other.runs}` : '-',
      row.medianGateBytes,
      other?.medianGateBytes ?? '-',
      row.medianDocsBytes,
      other?.medianDocsBytes ?? '-',
    ].join(' | '));
  }
  const verdict = gate(baseline, candidate);
  console.log(`\npilot gate bytes ${verdict.pilotBefore} -> ${verdict.pilotAfter} (drop ${verdict.pilotDrop}); largest control change ${verdict.controlNoise}`);
  console.log(verdict.passed ? 'gate: PASS' : `gate: FAIL (${verdict.reasons.join('; ')})`);
  return verdict.passed ? 0 : 1;
}

function comparePaired(baselineRecords, candidateRecords) {
  const result = pairedComparison(baselineRecords, candidateRecords);
  const format = (value, digits = 0) => (typeof value === 'number' ? value.toFixed(digits) : '-');
  console.log('question | group | passes before | passes after | mean bytes before | after | mean calls before | after | mean context tokens before | after');
  for (const row of result.questions) {
    console.log([
      row.questionId,
      row.group,
      `${row.baseline.passes}/${row.baseline.runs}`,
      `${row.candidate.passes}/${row.candidate.runs}`,
      format(row.baseline.gateBytes),
      format(row.candidate.gateBytes),
      format(row.baseline.toolCalls, 1),
      format(row.candidate.toolCalls, 1),
      format(row.baseline.contextTokens),
      format(row.candidate.contextTokens),
    ].join(' | '));
  }
  console.log(`\npass rate ${format(result.passRate.baseline, 3)} -> ${format(result.passRate.candidate, 3)}`);
  for (const [measure, { ratio, low, high }] of Object.entries(result.measures)) {
    console.log(`${measure}: candidate/baseline ${format(ratio, 3)} (95% interval ${format(low, 3)} to ${format(high, 3)})`);
  }
  for (const group of result.groups) {
    console.log(`group ${group.group} (${group.questions} questions): ${PAIRED_MEASURES.map((measure) => `${measure} ${format(group[measure], 3)}`).join(', ')}`);
  }
  return 0;
}

async function main(argv) {
  const options = parseArgs(argv);
  if (options.mode === 'run' && options.ref && options.label && options.out) return run(options);
  if (options.mode === 'summary' && options.out) return summary(options);
  if (options.mode === 'compare' && options.baseline && options.candidate) return compare(options);
  console.error([
    'usage: node scripts/eval-docs-reads.mjs run --ref <git ref> --label <name> --out <dir>',
    '         [--questions <file>] [--runs N] [--model haiku|sonnet|opus] [--effort low..max] [--concurrency N]',
    '         [--only id,...] [--cli <path>]',
    '       node scripts/eval-docs-reads.mjs summary --out <dir>/<label>',
    '       node scripts/eval-docs-reads.mjs compare --baseline <dir>/<label> --candidate <dir>/<label>',
  ].join('\n'));
  return 2;
}

if (isEntrypoint(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
