/**
 * Which model and effort the Knowledge Graph's agent should run at, measured by replaying prompts the
 * app really sent.
 *
 * MANUAL ONLY, like `eval-ask.mjs` and `probe-cache.mjs`: every run is a real agent call, so this
 * refuses to start where a CI variable is set.
 *
 *   node scripts/eval-answer-models.mjs ask --capture <dir> --expect <expect.json> \
 *     --arms sonnet:low,haiku:low,haiku:high --runs 3 --out <dir>
 *   node scripts/eval-answer-models.mjs summary --capture <dir> --arms sonnet:low,haiku:low --out <dir>
 *
 * WHY A REPLAY. `eval-ask.mjs` drives the running app and grades what it answers, but it never sees
 * which model answered or what the call cost: the renderer's stream carries text and tool events
 * only. A replay sends the exact prompt and arguments the app sent, captured from one real call,
 * through the CLI with only `--model` and `--effort` changed, and reads the CLI's own stream. So the
 * model is read from `message_start.model` (an answer) or the result's `modelUsage` (a summary),
 * never from the init line, which names the model asked for rather than the one that answered. On
 * CLI 2.1.260 plan mode with `--model haiku` answered from Sonnet, and only `message_start` showed it.
 *
 * A capture directory holds what a tee wrapper (set as the preview's `agent.cliPaths.claude`)
 * recorded for one call: `call.json` ({ argv, cli, envNames }), `stdin.txt`, and copies of the files
 * the call's `--settings` and `--mcp-config` named, as `settings.json` and `mcp.json`. The settings
 * file matters: it sets `advisorModel: ''`, and without it an advisor call would land in the timings.
 *
 * Every replay runs from an empty temp directory, never the repo, so no CLAUDE.md or rules load, as
 * the app runs answers in its own answer home. `MAX_THINKING_TOKENS=0` is set at low only, as the
 * Claude adapter's `answerEnv` does.
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { isEntrypoint } from './lib/is-entrypoint.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '..');
/** Past this, a replay counts as failed and its CLI is stopped. */
const RUN_TIMEOUT_MS = 5 * 60_000;
/**
 * Lower effort first: on an exact tie between passing levels, the lower one is recommended. Kept
 * apart from the copy in `review-eval/decide.mjs` on purpose: each belongs to its own pre-registered
 * rule, and a shared list would let an edit for one rule change the other.
 */
const EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * The model id a CLI alias is expected to answer from. Checked against the stream, never assumed.
 * A new model generation needs its ids here, or every run of that alias throws in assertAnsweredBy.
 */
const EXPECTED_MODEL_PREFIX = { haiku: 'claude-haiku-5-5', sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5' };

/**
 * A task ref as the answer prompt writes it: a ticket (`#561`), a cross-project ticket
 * (`mobile#88`), or a conversation (`C12`). The same pattern as `parseAnswerRefs` in
 * `src/main/retrieval/answer-prompt.ts`, which a unit test compares character for character.
 */
export const REF_PATTERN = /(?<![\w#])((?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,38}[A-Za-z0-9])?)?#\d{1,6}|C\d{1,4})\b/g;

function normalizeRef(ref) {
  const hash = ref.indexOf('#');
  return hash > 0 ? `${ref.slice(0, hash).toLowerCase()}${ref.slice(hash)}` : ref;
}

function parseJsonLine(line) {
  try {
    const value = JSON.parse(line);
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

/**
 * What one streamed answer run said and when, from its stdout lines as they arrived.
 * @param {Array<{ atMs: number, line: string }>} timedLines `atMs` measured from the spawn
 */
export function readAnswerStream(timedLines) {
  const models = [];
  let firstTextMs = null;
  let doneMs = null;
  let costUsd = null;
  let usageModels = [];
  let answer = null;
  let isError = false;
  let toolCalls = 0;
  for (const { atMs, line } of timedLines) {
    const record = parseJsonLine(line);
    if (!record) continue;
    if (record.type === 'stream_event' && record.event && typeof record.event === 'object') {
      const event = record.event;
      if (event.type === 'message_start' && event.message && typeof event.message.model === 'string') models.push(event.message.model);
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta.text && firstTextMs === null) firstTextMs = atMs;
      if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') toolCalls += 1;
    }
    if (record.type === 'result') {
      doneMs = atMs;
      costUsd = typeof record.total_cost_usd === 'number' ? record.total_cost_usd : null;
      usageModels = Object.keys(record.modelUsage ?? {});
      answer = typeof record.result === 'string' ? record.result : null;
      isError = record.is_error === true;
    }
  }
  return { models, firstTextMs, doneMs, costUsd, usageModels, answer, isError, toolCalls };
}

/** What one `--output-format json` run (a summary batch) returned. */
export function readJsonResult(stdout) {
  const record = parseJsonLine(stdout.trim());
  if (!record) return { answer: null, costUsd: null, usageModels: [], durationMs: null, isError: true };
  return {
    answer: typeof record.result === 'string' ? record.result : null,
    costUsd: typeof record.total_cost_usd === 'number' ? record.total_cost_usd : null,
    usageModels: Object.keys(record.modelUsage ?? {}),
    durationMs: typeof record.duration_ms === 'number' ? record.duration_ms : null,
    isError: record.is_error === true,
  };
}

/**
 * The prompt text a captured stdin carries. The Ask path writes it as `--input-format stream-json`,
 * one JSON user message per line, so its newlines arrive escaped; a summary call writes plain text.
 */
export function promptTextOf(stdinText) {
  const texts = [];
  for (const line of stdinText.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const message = parseJsonLine(line);
    if (!message || message.type !== 'user' || !Array.isArray(message.message?.content)) return stdinText;
    for (const block of message.message.content) if (block?.type === 'text' && typeof block.text === 'string') texts.push(block.text);
  }
  return texts.length > 0 ? texts.join('\n') : stdinText;
}

/**
 * Every ref that opens a row of a table in the prompt: the task table and the related work, written
 * `#529|...`, or a markdown row, written `| #529 | ...`.
 */
export function tableRefsOf(prompt) {
  const refs = new Set();
  for (const line of promptTextOf(prompt).split(/\r?\n/)) {
    const match = line.match(/^\s*([^|\s]+)\|/) ?? line.match(/^\s*\|\s*([^|\s]+)\s*\|/);
    if (!match) continue;
    for (const ref of match[1].matchAll(REF_PATTERN)) if (ref[0] === match[1]) refs.add(normalizeRef(ref[0]));
  }
  return refs;
}

/** The refs an answer names, in the prose or on its SELECTED line, that no table row in its prompt holds. */
export function inventedRefs(answer, tableRefs) {
  const invented = [];
  for (const match of String(answer ?? '').matchAll(REF_PATTERN)) {
    const ref = normalizeRef(match[1]);
    if (!tableRefs.has(ref) && !invented.includes(ref)) invented.push(ref);
  }
  return invented;
}

/** The refs on an answer's SELECTED line, as eval-ask's grader reads a result's rows. */
export function selectedRefs(answer) {
  const line = String(answer ?? '').match(/^[ \t]*SELECTED:[ \t]*(.*)$/im);
  if (!line) return [];
  return [...line[1].matchAll(REF_PATTERN)].map((match) => normalizeRef(match[1]));
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Throws when a run answered from a model other than the one its arm asked for, or cannot be
 * scored: a run with no result line has no time to put in a median, and an ungraded run (no
 * `--expect`, or graded by hand but not filled in) has no right or wrong to count.
 */
function assertAnsweredBy(run, label) {
  const models = run.models ?? [];
  if (models.length === 0) throw new Error(`${label}: a run has no answering model recorded`);
  const stray = models.filter((model) => !model.startsWith(run.expectedModel));
  if (stray.length > 0) throw new Error(`${label}: a run asked for ${run.expectedModel} answered from ${stray.join(', ')}`);
  if (!Number.isFinite(run.doneMs)) throw new Error(`${label}: a run has no result line, so no done time; rerun it`);
  if (typeof run.right !== 'boolean') throw new Error(`${label}: a run is not graded right or wrong`);
}

/**
 * The Ask rule, fixed on 2026-10-07 before any run. A Haiku level is recommended only if, over the
 * same questions and run count as Sonnet at low (today's default), it is right at least as often,
 * names no ref its prompt's tables do not hold, and its median time to the result line is no longer.
 * Of the levels that pass: more right first, then the shorter median, then the lower effort. Sonnet
 * at max is the accuracy reference and decides nothing.
 * @param {Array<{ right: boolean, inventedRefs: string[], doneMs: number, models: string[], expectedModel: string }>} baselineRuns
 * @param {Record<string, typeof baselineRuns>} candidateRunsByEffort
 */
export function recommendAnswerLevel(baselineRuns, candidateRunsByEffort) {
  if (baselineRuns.length === 0) throw new Error('recommendAnswerLevel needs baseline runs');
  for (const run of baselineRuns) assertAnsweredBy(run, 'baseline');
  const statsOf = (runs) => ({
    right: runs.filter((run) => run.right).length,
    invented: runs.reduce((sum, run) => sum + run.inventedRefs.length, 0),
    medianDoneMs: median(runs.map((run) => run.doneMs)),
    runs: runs.length,
  });
  const baseline = statsOf(baselineRuns);
  const stats = {};
  const passing = [];
  for (const [effort, runs] of Object.entries(candidateRunsByEffort)) {
    if (!EFFORT_ORDER.includes(effort)) throw new Error(`recommendAnswerLevel: unknown effort ${effort}`);
    if (runs.length !== baselineRuns.length) throw new Error(`recommendAnswerLevel: ${effort} has ${runs.length} runs, the baseline ${baselineRuns.length}`);
    for (const run of runs) assertAnsweredBy(run, effort);
    const candidate = statsOf(runs);
    stats[effort] = candidate;
    if (candidate.right >= baseline.right && candidate.invented === 0 && candidate.medianDoneMs <= baseline.medianDoneMs) passing.push(effort);
  }
  passing.sort((left, right) => stats[right].right - stats[left].right
    || stats[left].medianDoneMs - stats[right].medianDoneMs
    || EFFORT_ORDER.indexOf(left) - EFFORT_ORDER.indexOf(right));
  return { recommended: passing[0] ?? null, passing, baseline, stats };
}

/**
 * The summary rule, fixed on 2026-10-07 before any run. Over the same batches, adopt the candidate
 * model only with zero invented details (claims its task's inputs do not support, counted blind to
 * the model), AND no more tasks passed over than the incumbent. The second bar is an addition to the
 * task's rule, agreed before the run: a task passed over gets no summary, so a model that writes
 * nothing for a thin task cannot invent anything about it either.
 * @param {{ tasks: number, inventedDetails: number, passedOver: number }} incumbent
 * @param {{ tasks: number, inventedDetails: number, passedOver: number }} candidate
 */
export function adoptSummaryModel(incumbent, candidate) {
  for (const [label, side] of [['incumbent', incumbent], ['candidate', candidate]]) {
    for (const field of ['tasks', 'inventedDetails', 'passedOver']) {
      if (typeof side[field] !== 'number') throw new Error(`adoptSummaryModel: the ${label} has no ${field}`);
    }
  }
  if (incumbent.tasks !== candidate.tasks) throw new Error('adoptSummaryModel: both sides must cover the same tasks');
  const nothingInvented = candidate.inventedDetails === 0;
  const coverageHeld = candidate.passedOver <= incumbent.passedOver;
  return { adopt: nothingInvented && coverageHeld, nothingInvented, coverageHeld };
}

/** The captured argv with only the model, effort, settings and MCP config replaced. */
export function replayArgv(argv, { model, effort, settingsPath, mcpPath, jsonOutput }) {
  const next = [...argv];
  const setFlag = (flag, value) => {
    const at = next.indexOf(flag);
    if (at === -1) next.push(flag, value);
    else next[at + 1] = value;
  };
  setFlag('--model', model);
  setFlag('--effort', effort);
  if (settingsPath && next.includes('--settings')) setFlag('--settings', settingsPath);
  if (mcpPath && next.includes('--mcp-config')) setFlag('--mcp-config', mcpPath);
  if (jsonOutput && !next.includes('--output-format')) next.push('--output-format', 'json');
  return next;
}

/** The env a replay runs with: this shell's, minus the Claude session markers the app did not pass. */
export function replayEnv(baseEnv, capturedEnvNames, effort) {
  const env = { ...baseEnv };
  for (const name of Object.keys(env)) {
    if (name.startsWith('CLAUDE') && !capturedEnvNames.includes(name)) delete env[name];
  }
  delete env.MAX_THINKING_TOKENS;
  if (effort === 'low') env.MAX_THINKING_TOKENS = '0';
  return env;
}

/** The shipped summary-reply parser, bundled on the fly so this script grades with the real one. */
async function loadSummaryParser() {
  const esbuild = await import('esbuild');
  const built = await esbuild.build({
    entryPoints: [path.join(PROJECT_ROOT, 'src/main/retrieval/summary/summary-prompt.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
  });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-answer-models-'));
  const file = path.join(directory, 'summary-prompt.mjs');
  fs.writeFileSync(file, built.outputFiles[0].text);
  try {
    return await import(pathToFileURL(file).href);
  } finally {
    removeDirectory(directory);
  }
}

/** A temp folder removal that never throws: on Windows a CLI's leftover child can still hold it. */
function removeDirectory(directory) {
  try {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    // Left in the temp folder; the OS clears it.
  }
}

/** Stop the CLI and the MCP servers it started. On Windows `child.kill()` ends only the CLI. */
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

/** One replay from an empty temp folder. Never rejects: a CLI that cannot start resolves with code -1. */
export function runOnce(cli, argv, stdinText, env) {
  return new Promise((resolve) => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-answer-models-cwd-'));
    const started = performance.now();
    let child;
    try {
      child = spawn(cli, argv, { cwd, env, shell: false, windowsHide: true });
    } catch (error) {
      // Node throws at once, rather than emitting `error`, for an argument it refuses outright.
      removeDirectory(cwd);
      resolve({ code: -1, timedLines: [], stdout: '', stderr: error instanceof Error ? error.message : String(error), wallMs: 0 });
      return;
    }
    const timedLines = [];
    let pending = '';
    let stdout = '';
    let stderr = '';
    let settled = false;
    // A spawn failure fires `error` and may also fire `close`, so the run settles once, on whichever comes first.
    const settle = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (pending) timedLines.push({ atMs: performance.now() - started, line: pending.replace(/\r$/, '') });
      removeDirectory(cwd);
      resolve({ code, timedLines, stdout, stderr: stderr.slice(-2000), wallMs: performance.now() - started });
    };
    const timer = setTimeout(() => stopTree(child), RUN_TIMEOUT_MS);
    child.on('error', (error) => {
      stderr += `${error.message}\n`;
      settle(-1);
    });
    // A CLI that exits before reading its prompt closes the pipe; the exit code reports that run.
    child.stdin.on('error', () => {});
    child.stdout.on('data', (chunk) => {
      const atMs = performance.now() - started;
      const text = chunk.toString('utf8');
      stdout += text;
      pending += text;
      let newline = pending.indexOf('\n');
      while (newline !== -1) {
        timedLines.push({ atMs, line: pending.slice(0, newline).replace(/\r$/, '') });
        pending = pending.slice(newline + 1);
        newline = pending.indexOf('\n');
      }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('close', (code) => settle(code));
    child.stdin.end(stdinText);
  });
}

/** The command line, refusing an arm or run count that would spend agent calls on nothing. */
export function parseArgs(argv) {
  const value = (flag) => {
    const at = argv.indexOf(flag);
    return at === -1 ? null : argv[at + 1] ?? null;
  };
  const arms = (value('--arms') ?? '').split(',').filter(Boolean).map((arm) => {
    const [model, effort] = arm.split(':');
    if (!model || !EFFORT_ORDER.includes(effort)) throw new Error(`--arms: ${arm} is not model:effort with effort one of ${EFFORT_ORDER.join(', ')}`);
    return { model, effort };
  });
  const runs = Number(value('--runs') ?? 1);
  if (!Number.isInteger(runs) || runs < 1) throw new Error(`--runs: ${value('--runs')} is not a positive whole number`);
  return { mode: argv[0], capture: value('--capture'), expect: value('--expect'), arms, runs, out: value('--out') };
}

/** The tag each task in a summary prompt opens with, as `buildSummaryPrompt` writes it. */
export function summaryTaskCountOf(stdinText) {
  const count = (stdinText.match(/<task label="D\d+">/g) ?? []).length;
  if (count === 0) throw new Error('The captured summary prompt has no <task label="D1"> tags; buildSummaryPrompt\'s format changed');
  return count;
}

function refuseIfAutomated() {
  const automated = ['CI', 'CONTINUOUS_INTEGRATION', 'GITHUB_ACTIONS', 'BUILD_NUMBER'].find((name) => process.env[name]);
  if (automated) throw new Error(`Refusing to run: ${automated} is set. Every replay is a real agent call.`);
}

async function main(argv) {
  const options = parseArgs(argv);
  if (!['ask', 'summary'].includes(options.mode) || !options.capture || !options.out || options.arms.length === 0) {
    console.error('usage: node scripts/eval-answer-models.mjs ask|summary --capture <dir> --arms model:effort,... [--runs N] [--expect <file>] --out <dir>');
    return 2;
  }
  refuseIfAutomated();
  const call = JSON.parse(fs.readFileSync(path.join(options.capture, 'call.json'), 'utf8'));
  // Node will not start a .cmd or .bat without a shell, and a shell drops the captured argv's empty
  // values (`--tools ''`), so a shim has to be replaced by the executable it launches.
  if (process.platform === 'win32' && /\.(cmd|bat|ps1)$/i.test(call.cli)) {
    throw new Error(`call.json names the shim ${call.cli}; set "cli" to the CLI's own executable`);
  }
  const stdinText = fs.readFileSync(path.join(options.capture, 'stdin.txt'), 'utf8');
  const settingsPath = path.join(options.capture, 'settings.json');
  const mcpPath = path.join(options.capture, 'mcp.json');
  fs.mkdirSync(options.out, { recursive: true });
  const ask = options.mode === 'ask';
  const expectation = ask && options.expect ? JSON.parse(fs.readFileSync(options.expect, 'utf8')) : null;
  const grade = expectation ? (await import('./eval-ask.mjs')).__testing.grade : null;
  const tableRefs = ask ? tableRefsOf(stdinText) : null;
  const parser = ask ? null : await loadSummaryParser();
  const taskCount = ask ? 0 : summaryTaskCountOf(stdinText);

  const records = [];
  for (const arm of options.arms) {
    for (let run = 1; run <= options.runs; run += 1) {
      const args = replayArgv(call.argv, {
        model: arm.model,
        effort: arm.effort,
        settingsPath: fs.existsSync(settingsPath) ? settingsPath : null,
        mcpPath: fs.existsSync(mcpPath) ? mcpPath : null,
        jsonOutput: !ask,
      });
      const outcome = await runOnce(call.cli, args, stdinText, replayEnv(process.env, call.envNames ?? [], arm.effort));
      const base = { model: arm.model, effort: arm.effort, run, expectedModel: EXPECTED_MODEL_PREFIX[arm.model] ?? arm.model, exitCode: outcome.code, wallMs: Math.round(outcome.wallMs) };
      let record;
      if (ask) {
        const stream = readAnswerStream(outcome.timedLines);
        const invented = inventedRefs(stream.answer, tableRefs);
        const verdict = grade && stream.answer ? grade(stream.answer, expectation, { toolCalls: stream.toolCalls, namedTasks: selectedRefs(stream.answer) }) : null;
        record = { ...base, ...stream, inventedRefs: invented, right: verdict ? verdict.pass : null, verdict };
      } else {
        const result = readJsonResult(outcome.stdout);
        const parsed = result.answer ? parser.parseSummaryReply(result.answer, taskCount) : new Map();
        record = {
          ...base,
          ...result,
          models: result.usageModels,
          tasks: taskCount,
          written: parsed.size,
          passedOver: taskCount - parsed.size,
          summaries: Object.fromEntries([...parsed.entries()].map(([position, text]) => [`D${position + 1}`, text])),
        };
      }
      if (outcome.code !== 0) record.stderr = outcome.stderr;
      records.push(record);
      fs.writeFileSync(path.join(options.out, `${arm.model}-${arm.effort}-${run}.json`), JSON.stringify(record, null, 2));
      const timing = ask ? `first ${record.firstTextMs?.toFixed(0)}ms done ${record.doneMs?.toFixed(0)}ms` : `${record.durationMs}ms written ${record.written}/${taskCount}`;
      console.log(`${arm.model}:${arm.effort} #${run} model=${(record.models ?? []).join(',')} ${timing} cost=$${record.costUsd} right=${record.right ?? '-'} invented=${(record.inventedRefs ?? []).join(',') || 0}`);
    }
  }
  fs.writeFileSync(path.join(options.out, 'records.json'), JSON.stringify(records, null, 2));
  return 0;
}

if (isEntrypoint(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
