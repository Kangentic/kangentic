/**
 * Which model, effort and wording a column's turn-end Conditions should run at, measured by replaying
 * the replies the app really judged.
 *
 * MANUAL ONLY, like `eval-answer-models.mjs`: every judged reply in `run` is a real agent call, so
 * `run` refuses to start where a CI variable is set. `build` and `summary` spend nothing.
 *
 *   node scripts/eval-condition-check.mjs build --db <project.db> --column Executing --since 2026-10-12 --out <dir>
 *   node scripts/eval-condition-check.mjs run --cases <dir>/cases.json --expect <expect.json> \
 *     --designs <designs.json> --arms haiku:low,haiku:medium,haiku:high --runs 3 --out <dir>
 *   node scripts/eval-condition-check.mjs summary --out <dir>
 *
 * BUILD reads the project database read-only: every turn end the column's Conditions judged, the
 * session that ended it, and its task. The reply comes from the app's own Claude transcript parser
 * and `finalAgentReply`, bundled on the fly and cut at the moment the app judged it, so a case holds
 * the text the check was given rather than a reconstruction of it.
 *
 * RUN builds each prompt with the shipped `buildConditionPrompt` and sends it the way the Claude
 * adapter sends a Condition check: the same flags and settings file, the prompt on stdin, from an
 * empty folder, with `MAX_THINKING_TOKENS=0` at low as `answerEnv` sets it. The reply is read with
 * the shipped `parseConditionReply`. Each design lists its rows in board order, and the outcome is
 * what the runner would do with the answers: rows run top to bottom, an unconditional row or one
 * answered yes runs, and a move ends the group.
 *
 * The expectation file holds one hand label per case, `leftWork`: the reply leaves findings,
 * recommendations or follow-up changes unapplied, offers to make them, or asks the user to decide.
 * Each row names the truth it should match (`leftWork`, `done` or `endsWithLine`), so one label
 * grades every wording. A case a careful reader could send either way carries `acceptEither`.
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isEntrypoint } from './lib/is-entrypoint.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '..');
/** Past this, a call counts as failed and its CLI is stopped. */
const RUN_TIMEOUT_MS = 3 * 60_000;
const EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh', 'max'];
/** The model id an alias is sent as, the way the Automation agent setting stores it. */
const MODEL_IDS = { haiku: 'claude-haiku-5-5', sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5' };
/** Rows of one task judged within this long of the first answered one turn end: the runner runs them in a row. */
const TURN_END_GROUP_MS = 5_000;
/** What the Claude adapter's `writeAnswerSettings` writes for every answer call (pinned by its test). */
export const ANSWER_SETTINGS = { advisorModel: '', autoMemoryEnabled: false };
/** The line the Apply findings message asks the agent to end on. */
const FINDINGS_LINE = 'Findings: applied';

/**
 * One task's judged rows grouped into turn ends. `rows` must be sorted by task, then time.
 * @param {Array<{ task_id: string, started_at: string, automation_name: string }>} rows
 */
export function groupTurnEnds(rows) {
  const groups = [];
  for (const row of rows) {
    const atMs = Date.parse(row.started_at);
    const last = groups[groups.length - 1];
    if (last && last.taskId === row.task_id && atMs - last.atMs <= TURN_END_GROUP_MS) {
      last.rows.push(row);
    } else {
      groups.push({ taskId: row.task_id, atMs, at: row.started_at, rows: [row] });
    }
  }
  return groups;
}

/** Whether the reply's last non-empty line reads `line`, ignoring markdown emphasis and case. */
export function lastLineIs(reply, line) {
  const lines = String(reply ?? '').split(/\r?\n/).map((text) => text.trim()).filter(Boolean);
  const bare = (text) => text.replace(/[*_`]/g, '').trim().toLowerCase();
  return lines.length > 0 && bare(lines[lines.length - 1]) === bare(line);
}

/**
 * What the runner does with a turn end's answers: rows in board order, an unconditional row or one
 * answered yes runs, and a row that moves the task ends the group. 'none' when nothing runs.
 * @param {Array<{ key: string, condition: string | null, endsGroup?: boolean }>} rows
 * @param {Map<string, boolean>} metByKey
 */
export function outcomeOf(rows, metByKey) {
  const ran = [];
  for (const row of rows) {
    if (row.condition !== null && metByKey.get(row.key) !== true) continue;
    ran.push(row.key);
    if (row.endsGroup) break;
  }
  return ran.length > 0 ? ran.join('+') : 'none';
}

/**
 * The answer a row should get on a case. `leftWork` is the hand label; a reply that ends on the
 * findings line has nothing left by definition, since the agent said so. `label` reads the row's
 * own hand answer (`rows` in the expectation file), for a column whose rows judge something else.
 * @param {'leftWork' | 'done' | 'endsWithLine' | 'label'} truth
 */
export function truthOf(truth, { leftWork, endsWithLine, rows = {} }, rowName = '') {
  if (truth === 'endsWithLine') return endsWithLine;
  if (truth === 'done') return endsWithLine || !leftWork;
  if (truth === 'leftWork') return leftWork && !endsWithLine;
  if (truth === 'label') {
    if (typeof rows[rowName] !== 'boolean') throw new Error(`no hand answer for the row ${rowName}`);
    return rows[rowName];
  }
  throw new Error(`unknown truth ${truth}`);
}

/**
 * Whether an outcome passes. A case labelled `acceptEither` is one a careful reader could send
 * either way, so applying or moving both pass and only a stall fails. That leniency covers only a
 * judgment row (`leftWork`, `done`); a literal check is graded strictly.
 */
export function outcomePasses({ got, expected, acceptEither, judgedTruths }) {
  if (got === expected) return true;
  const judgment = judgedTruths.some((truth) => truth === 'leftWork' || truth === 'done');
  const settled = new Set(['apply', 'move']);
  return Boolean(acceptEither) && judgment && settled.has(got) && settled.has(expected);
}

/** A design's rows still pending at a case: the ones whose board row the app judged at that turn end, so had not run this visit. */
export function pendingRows(design, testCase) {
  return design.rows.filter((row) => testCase.pendingNames.includes(row.name));
}

/** The flags the Claude adapter's `answerArgs` passes a non-streaming answer with no search tool (pinned by its test). */
export function conditionCheckArgs({ settingsPath, model, effort }) {
  return [
    '--print',
    '--no-session-persistence',
    '--permission-prompts', 'none',
    '--tools', '',
    '--strict-mcp-config',
    '--settings', settingsPath,
    '--output-format', 'json',
    '--model', model,
    '--effort', effort,
  ];
}

/** This shell's env minus Claude session markers, with thinking off at low as the adapter's `answerEnv` does. */
export function conditionCheckEnv(baseEnv, effort) {
  const env = { ...baseEnv };
  for (const name of Object.keys(env)) if (name.startsWith('CLAUDE')) delete env[name];
  delete env.MAX_THINKING_TOKENS;
  if (effort === 'low') env.MAX_THINKING_TOKENS = '0';
  return env;
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Per design and arm: how many outcomes matched, how many stalled the task (nothing ran where
 * something should have), how many rows went unanswered, and what the calls cost.
 */
export function summarize(records) {
  const groups = new Map();
  for (const record of records) {
    const key = `${record.design}|${record.model}:${record.effort}`;
    const group = groups.get(key) ?? { design: record.design, arm: `${record.model}:${record.effort}`, records: [] };
    group.records.push(record);
    groups.set(key, group);
  }
  return [...groups.values()].map(({ design, arm, records: armRecords }) => {
    const costs = armRecords.map((record) => record.costUsd).filter((cost) => typeof cost === 'number');
    return {
      design,
      arm,
      calls: armRecords.length,
      correct: armRecords.filter((record) => record.correct).length,
      stalls: armRecords.filter((record) => record.outcome === 'none' && record.expected !== 'none').length,
      unansweredRows: armRecords.reduce((sum, record) => sum + record.unanswered.length, 0),
      failedCalls: armRecords.filter((record) => record.isError || record.exitCode !== 0).length,
      totalCostUsd: costs.reduce((sum, cost) => sum + cost, 0),
      medianCostUsd: median(costs),
      medianDurationMs: median(armRecords.map((record) => record.durationMs).filter((value) => typeof value === 'number')),
      medianOutputTokens: median(armRecords.map((record) => record.tokens?.output).filter((value) => typeof value === 'number')),
      cacheWriteCalls: armRecords.filter((record) => (record.tokens?.cacheWrite ?? 0) > 0).length,
      wrongCases: [...new Set(armRecords.filter((record) => !record.correct).map((record) => record.caseId))],
    };
  });
}

/** The shipped prompt builder, reply parser, transcript parser and reply reader, bundled on the fly. */
async function loadAppModules() {
  const esbuild = await import('esbuild');
  const entry = [
    "export { buildConditionPrompt, parseConditionReply } from './src/main/automations/condition-check/condition-prompt.ts';",
    "export { finalAgentReply } from './src/main/agent/shared/agent-reply.ts';",
    "export { parseClaudeTranscript, locateClaudeTranscriptFile } from './src/main/agent/adapters/claude/transcript-parser.ts';",
  ].join('\n');
  const built = await esbuild.build({
    stdin: { contents: entry, resolveDir: PROJECT_ROOT, loader: 'ts', sourcefile: 'eval-condition-check-entry.ts' },
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
  });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-condition-check-'));
  const file = path.join(directory, 'app-modules.mjs');
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

/** Stop the CLI and anything it started. On Windows `child.kill()` ends only the CLI. */
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

/** One call from an empty temp folder. Never rejects: a CLI that cannot start resolves with code -1. */
function runOnce(cli, argv, stdinText, env) {
  return new Promise((resolve) => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-condition-check-cwd-'));
    const started = performance.now();
    let child;
    try {
      child = spawn(cli, argv, { cwd, env, shell: false, windowsHide: true });
    } catch (error) {
      removeDirectory(cwd);
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
      removeDirectory(cwd);
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
    child.stdin.end(stdinText);
  });
}

/** What one `--output-format json` call returned. */
export function readJsonResult(stdout) {
  const lines = String(stdout).trim().split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const record = JSON.parse(lines[index]);
      if (record && record.type === 'result') {
        const usage = record.usage ?? {};
        const count = (value) => (typeof value === 'number' ? value : 0);
        return {
          answer: typeof record.result === 'string' ? record.result : null,
          costUsd: typeof record.total_cost_usd === 'number' ? record.total_cost_usd : null,
          models: Object.keys(record.modelUsage ?? {}),
          durationMs: typeof record.duration_ms === 'number' ? record.duration_ms : null,
          isError: record.is_error === true,
          // Split out because a cold prompt cache bills its first call's prompt as cache writes, so cost alone
          // ranks arms by which one ran first.
          tokens: {
            input: count(usage.input_tokens),
            cacheWrite: count(usage.cache_creation_input_tokens),
            cacheRead: count(usage.cache_read_input_tokens),
            output: count(usage.output_tokens),
          },
        };
      }
    } catch {
      // Not the result line.
    }
  }
  return { answer: null, costUsd: null, models: [], durationMs: null, isError: true, tokens: null };
}

/** The command line, refusing an arm or run count that would spend agent calls on nothing. */
export function parseArgs(argv) {
  const value = (flag) => {
    const at = argv.indexOf(flag);
    return at === -1 ? null : argv[at + 1] ?? null;
  };
  const arms = (value('--arms') ?? '').split(',').filter(Boolean).map((arm) => {
    const [model, effort] = arm.split(':');
    if (!MODEL_IDS[model] || !EFFORT_ORDER.includes(effort)) {
      throw new Error(`--arms: ${arm} is not model:effort with model one of ${Object.keys(MODEL_IDS).join(', ')} and effort one of ${EFFORT_ORDER.join(', ')}`);
    }
    return { model, effort };
  });
  const runs = Number(value('--runs') ?? 1);
  if (!Number.isInteger(runs) || runs < 1) throw new Error(`--runs: ${value('--runs')} is not a positive whole number`);
  const concurrency = Number(value('--concurrency') ?? 4);
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error(`--concurrency: ${value('--concurrency')} is not a positive whole number`);
  return {
    mode: argv[0],
    db: value('--db'),
    column: value('--column'),
    since: value('--since'),
    cases: value('--cases'),
    expect: value('--expect'),
    designs: value('--designs'),
    only: (value('--only') ?? '').split(',').filter(Boolean),
    caseIds: (value('--case-ids') ?? '').split(',').filter(Boolean),
    cli: value('--cli') ?? 'claude',
    arms,
    runs,
    concurrency,
    out: value('--out'),
  };
}

function refuseIfAutomated() {
  const automated = ['CI', 'CONTINUOUS_INTEGRATION', 'GITHUB_ACTIONS', 'BUILD_NUMBER'].find((name) => process.env[name]);
  if (automated) throw new Error(`Refusing to run: ${automated} is set. Every judged reply is a real agent call.`);
}

/**
 * Throws when the CLI cannot start, before any call is queued. Without a shell a bare name reaches
 * only a real executable on PATH: on Windows an npm install puts only the `claude.cmd` shim there,
 * so the default `claude` would fail every queued call with ENOENT and a table of failed calls.
 */
export function assertCliStarts(cli) {
  try {
    execFileSync(cli, ['--version'], { stdio: 'ignore', windowsHide: true, timeout: 30_000 });
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error && error.code ? ` (${error.code})` : '';
    throw new Error(`--cli ${cli} did not start${code}. Pass the path to the CLI's own executable; on Windows the npm shim claude.cmd cannot start without a shell.`);
  }
}

/** Every turn end the column judged since `since`, with the reply the app read. Spends nothing. */
async function build(options) {
  const { DatabaseSync } = await import('node:sqlite');
  const app = await loadAppModules();
  const db = new DatabaseSync(options.db, { readOnly: true });
  try {
    const rows = db.prepare(`
      SELECT r.task_id, r.started_at, r.automation_name, r.condition_met, r.condition_reason, r.background_call_id
      FROM automation_runs r JOIN swimlanes s ON s.id = r.swimlane_id
      WHERE s.name = ? AND r.trigger = 'turn_end' AND r.condition_reason IS NOT NULL AND r.started_at >= ?
      ORDER BY r.task_id, r.started_at
    `).all(options.column, options.since);
    const taskQuery = db.prepare('SELECT display_id, title, description, labels, pr_url, pr_state, pr_merge_readiness FROM tasks WHERE id = ?');
    const sessionQuery = db.prepare(`
      SELECT id, agent_session_id, cwd, session_type FROM sessions
      WHERE task_id = ? AND started_at <= ? ORDER BY started_at DESC LIMIT 1
    `);
    const cases = [];
    /** A session's transcript, parsed once: a task's turn ends share it, and a long one is large. */
    const transcripts = new Map();
    const transcriptOf = (session) => {
      const key = `${session.agent_session_id}|${session.cwd}`;
      let parsed = transcripts.get(key);
      if (!parsed) {
        parsed = Promise.resolve().then(() => app.parseClaudeTranscript(app.locateClaudeTranscriptFile(session.agent_session_id, session.cwd)));
        transcripts.set(key, parsed);
      }
      return parsed;
    };
    for (const group of groupTurnEnds(rows)) {
      const task = taskQuery.get(group.taskId);
      const session = sessionQuery.get(group.taskId, group.at);
      const id = `${task?.display_id ?? group.taskId.slice(0, 8)}-${group.at.slice(11, 19).replace(/:/g, '')}`;
      let reply = null;
      let replyError = null;
      // Session types are the adapter's own (`claude_agent`); only the Claude parser is bundled.
      if (session?.session_type?.startsWith('claude') && session.agent_session_id) {
        try {
          const entries = (await transcriptOf(session)).filter((entry) => entry.ts <= group.atMs);
          reply = app.finalAgentReply(entries)?.text ?? null;
        } catch (error) {
          replyError = error instanceof Error ? error.message : String(error);
        }
      } else {
        replyError = `no Claude session for the task at ${group.at}`;
      }
      cases.push({
        id,
        taskDisplayId: task?.display_id ?? null,
        at: group.at,
        sessionId: session?.id ?? null,
        pendingNames: group.rows.map((row) => row.automation_name),
        production: Object.fromEntries(group.rows.map((row) => [row.automation_name, { met: row.condition_met === null ? null : row.condition_met === 1, reason: row.condition_reason }])),
        task: {
          title: task?.title ?? '',
          description: task?.description ?? '',
          labels: JSON.parse(task?.labels ?? '[]'),
          prUrl: task?.pr_url ?? null,
          prState: task?.pr_state ?? null,
          prMergeReadiness: task?.pr_merge_readiness ?? null,
        },
        endsWithLine: lastLineIs(reply, FINDINGS_LINE),
        reply,
        replyError,
      });
    }
    fs.mkdirSync(options.out, { recursive: true });
    fs.writeFileSync(path.join(options.out, 'cases.json'), JSON.stringify(cases, null, 2));
    for (const testCase of cases) {
      const tail = (testCase.reply ?? `(no reply: ${testCase.replyError})`).trim().slice(-160).replace(/\s+/g, ' ');
      console.log(`${testCase.id} [${testCase.pendingNames.join(', ')}] ends-with-line=${testCase.endsWithLine} ... ${tail}`);
    }
    console.log(`${cases.length} turn ends written to ${path.join(options.out, 'cases.json')}`);
  } finally {
    db.close();
  }
  return 0;
}

/** Judge every case under every design and arm, `runs` times each, and append one record per call. */
async function run(options) {
  refuseIfAutomated();
  // Node will not start a .cmd or .bat without a shell, and a shell drops the empty `--tools ''`.
  if (process.platform === 'win32' && /\.(cmd|bat|ps1)$/i.test(options.cli)) {
    throw new Error(`--cli names the shim ${options.cli}; pass the CLI's own executable`);
  }
  assertCliStarts(options.cli);
  const app = await loadAppModules();
  const cases = JSON.parse(fs.readFileSync(options.cases, 'utf8'));
  const labels = JSON.parse(fs.readFileSync(options.expect, 'utf8'));
  const designs = JSON.parse(fs.readFileSync(options.designs, 'utf8')).filter((design) => options.only.length === 0 || options.only.includes(design.name));
  fs.mkdirSync(options.out, { recursive: true });
  const settingsDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-condition-check-settings-'));
  const settingsPath = path.join(settingsDirectory, 'settings.json');
  fs.writeFileSync(settingsPath, JSON.stringify(ANSWER_SETTINGS));
  const recordsPath = path.join(options.out, 'records.jsonl');

  const jobs = [];
  for (const testCase of cases) {
    if (!testCase.reply) continue;
    if (options.caseIds.length > 0 && !options.caseIds.includes(testCase.id)) continue;
    const label = labels[testCase.id];
    if (!label || (typeof label.leftWork !== 'boolean' && !label.rows)) {
      throw new Error(`${testCase.id} has no leftWork label or row answers in ${options.expect}`);
    }
    const facts = { leftWork: label.leftWork === true, endsWithLine: testCase.endsWithLine, rows: label.rows ?? {} };
    for (const design of designs) {
      const rows = pendingRows(design, testCase);
      const judged = rows.filter((row) => row.condition !== null);
      if (judged.length === 0) continue;
      const expected = outcomeOf(rows, new Map(judged.map((row) => [row.key, truthOf(row.truth, facts, row.name)])));
      for (const arm of options.arms) {
        for (let attempt = 1; attempt <= options.runs; attempt += 1) {
          jobs.push({ testCase, design, rows, judged, expected, facts, arm, attempt, acceptEither: label.acceptEither === true });
        }
      }
    }
  }
  console.log(`${jobs.length} calls queued`);

  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const job = jobs[next];
      next += 1;
      const { testCase, design, rows, judged, expected, facts, arm, attempt } = job;
      const prompt = app.buildConditionPrompt({
        task: testCase.task,
        column: options.column ?? 'Executing',
        trigger: 'turn_end',
        move: null,
        agentReply: testCase.reply,
        rows: judged.map((row) => ({ automationId: row.key, name: row.name, condition: row.condition })),
      });
      const model = MODEL_IDS[arm.model];
      const outcome = await runOnce(options.cli, conditionCheckArgs({ settingsPath, model, effort: arm.effort }), prompt, conditionCheckEnv(process.env, arm.effort));
      const result = readJsonResult(outcome.stdout);
      const parsed = result.answer ? app.parseConditionReply(result.answer, judged.length) : new Map();
      const answers = {};
      const metByKey = new Map();
      const unanswered = [];
      judged.forEach((row, index) => {
        const answer = parsed.get(index);
        if (!answer) unanswered.push(row.key);
        answers[row.key] = answer ?? null;
        metByKey.set(row.key, answer?.met === true);
      });
      const got = outcomeOf(rows, metByKey);
      const record = {
        caseId: testCase.id,
        design: design.name,
        model: arm.model,
        effort: arm.effort,
        attempt,
        expected,
        outcome: got,
        acceptEither: Boolean(job.acceptEither),
        correct: outcomePasses({ got, expected, acceptEither: job.acceptEither, judgedTruths: judged.map((row) => row.truth) }),
        rowsCorrect: Object.fromEntries(judged.map((row) => [row.key, answers[row.key] ? answers[row.key].met === truthOf(row.truth, facts, row.name) : false])),
        answers,
        unanswered,
        costUsd: result.costUsd,
        tokens: result.tokens,
        durationMs: result.durationMs,
        models: result.models,
        wrongModel: result.models.some((name) => !name.startsWith(model)),
        isError: result.isError,
        exitCode: outcome.code,
        reply: result.answer,
        ...(outcome.code !== 0 ? { stderr: outcome.stderr } : {}),
      };
      fs.appendFileSync(recordsPath, `${JSON.stringify(record)}\n`);
      done += 1;
      const mark = record.correct ? 'ok  ' : 'MISS';
      console.log(`${String(done).padStart(4)}/${jobs.length} ${mark} ${design.name} ${arm.model}:${arm.effort} ${testCase.id} #${attempt} expected=${expected} got=${got} $${result.costUsd ?? '?'} ${result.durationMs ?? '?'}ms${unanswered.length ? ` unanswered=${unanswered.join(',')}` : ''}`);
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(options.concurrency, jobs.length) }, worker));
  } finally {
    removeDirectory(settingsDirectory);
  }
  return summary(options);
}

/** The table `run` ends with, from the records on disk. Spends nothing. */
function summary(options) {
  const recordsPath = path.join(options.out, 'records.jsonl');
  const records = fs.readFileSync(recordsPath, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  const rows = summarize(records);
  fs.writeFileSync(path.join(options.out, 'summary.json'), JSON.stringify(rows, null, 2));
  console.log('\ndesign | arm | correct | stalls | unanswered rows | failed calls | median $ | total $ | median ms | median output tokens | calls writing cache | wrong cases');
  for (const row of rows) {
    console.log([
      row.design,
      row.arm,
      `${row.correct}/${row.calls}`,
      row.stalls,
      row.unansweredRows,
      row.failedCalls,
      row.medianCostUsd?.toFixed(5) ?? '-',
      row.totalCostUsd.toFixed(4),
      row.medianDurationMs ?? '-',
      row.medianOutputTokens ?? '-',
      row.cacheWriteCalls,
      row.wrongCases.join(' ') || '-',
    ].join(' | '));
  }
  return 0;
}

async function main(argv) {
  const options = parseArgs(argv);
  if (options.mode === 'build' && options.db && options.column && options.since && options.out) return build(options);
  if (options.mode === 'run' && options.cases && options.expect && options.designs && options.out && options.arms.length > 0) return run(options);
  if (options.mode === 'summary' && options.out) return summary(options);
  console.error([
    'usage: node scripts/eval-condition-check.mjs build --db <project.db> --column <name> --since <iso> --out <dir>',
    '       node scripts/eval-condition-check.mjs run --cases <cases.json> --expect <expect.json> --designs <designs.json>',
    '         --arms model:effort,... [--runs N] [--concurrency N] [--only design,...] [--case-ids id,...]',
    '         [--cli <path>] [--column <name>] --out <dir>',
    '       node scripts/eval-condition-check.mjs summary --out <dir>',
  ].join('\n'));
  return 2;
}

if (isEntrypoint(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
