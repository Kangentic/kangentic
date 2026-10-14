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
 *
 * A design row may carry `finalLine` in place of `condition`: a Text match, judged in code with the
 * shipped `matchFinalLine` exactly as the runner judges it. A design made only of those rows makes no
 * agent call, needs no `--arms`, and reports as the `code` arm at no cost. Every record also carries
 * the outcome the case's production answers give under the design, so a run says how often it would
 * have routed the task the way the board did. `run` writes `disagreements.json`: every case where the
 * shipped matcher and the strict `lastLineIs` read a design's line differently. The `endsWithLine`
 * truth is `lastLineIs`, so those cases are the ones to read by hand before trusting that truth.
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
/** The arm a design of only Text match rows runs on: the shipped matcher, no agent. */
export const CODE_ARM = { model: 'code', effort: 'none' };

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

/** Whether a design row has a Condition an agent judges. */
function hasConditionRow(row) {
  return (row.condition ?? null) !== null;
}

/** Whether a design row has a Text match, judged in code. */
function hasFinalLineRow(row) {
  return (row.finalLine ?? null) !== null;
}

/** Whether a design row only runs when a check says yes: a Condition, or a Text match. */
export function isGuarded(row) {
  return hasConditionRow(row) || hasFinalLineRow(row);
}

/**
 * What production decided for one judged run row: its Agent evaluation's answer when it had one,
 * otherwise its Text match's. The two are separate columns, and a Text match leaves the first
 * pair null, so reading only `condition_met` would score every Text match as not met.
 * @param {{ condition_met: number | null, condition_reason: string | null, final_line_met?: number | null, final_line_reason?: string | null }} row
 */
export function productionAnswerOf(row) {
  if (row.condition_reason !== null || row.condition_met !== null) {
    return { met: row.condition_met === null ? null : row.condition_met === 1, reason: row.condition_reason };
  }
  const finalLineMet = row.final_line_met ?? null;
  return { met: finalLineMet === null ? null : finalLineMet === 1, reason: row.final_line_reason ?? null };
}

/**
 * Throws on a design the runner could never hold: a row with both a Condition and a Text match. The
 * repository keeps one kind per row, so grading such a row would measure nothing the board does.
 */
export function assertDesignRows(design) {
  for (const row of design.rows) {
    if (hasConditionRow(row) && hasFinalLineRow(row)) {
      throw new Error(`${design.name}: the row ${row.name} has both a condition and a finalLine; a row holds one kind`);
    }
  }
}

/**
 * What the runner does with a turn end's answers: rows in board order, an unconditional row or one
 * answered yes runs, and a row that moves the task ends the group. 'none' when nothing runs.
 * @param {Array<{ key: string, condition?: string | null, finalLine?: string | null, endsGroup?: boolean }>} rows
 * @param {Map<string, boolean>} metByKey
 */
export function outcomeOf(rows, metByKey) {
  const ran = [];
  for (const row of rows) {
    if (isGuarded(row) && metByKey.get(row.key) !== true) continue;
    ran.push(row.key);
    if (row.endsGroup) break;
  }
  return ran.length > 0 ? ran.join('+') : 'none';
}

/**
 * Each Text match row's answer on a reply, from the shipped matcher: what the runner decides for it,
 * with no agent asked. `matchFinalLine` is passed in so a test can hand it the real module.
 */
export function matchRowsInCode(rows, reply, matchFinalLine) {
  const metByKey = new Map();
  for (const row of rows) {
    if (hasFinalLineRow(row)) metByKey.set(row.key, matchFinalLine(row.finalLine, reply).met);
  }
  return metByKey;
}

/** The outcome a case's production answers give under a design's rows: what the board did, as far as these rows go. */
export function productionOutcomeOf(rows, testCase) {
  const production = testCase.production ?? {};
  return outcomeOf(rows, new Map(rows.filter(isGuarded).map((row) => [row.key, production[row.name]?.met === true])));
}

/**
 * Every case where the shipped matcher and the strict `lastLineIs` read a line differently. A line
 * with a wildcard is left out: `lastLineIs` reads it as literal text, so it would differ everywhere.
 */
export function lineDisagreements(cases, lines, matchFinalLine) {
  const found = [];
  for (const testCase of cases) {
    if (!testCase.reply) continue;
    for (const line of lines) {
      if (line.includes('*')) continue;
      const code = matchFinalLine(line, testCase.reply).met;
      const strict = lastLineIs(testCase.reply, line);
      if (code !== strict) found.push({ caseId: testCase.id, line, code, strict });
    }
  }
  return found;
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
 * something should have), how many rows went unanswered, and what the calls cost. `calls` counts the
 * judged cases; `agentCalls` counts the ones that asked an agent, which is none on the code arm.
 */
export function summarize(records) {
  const groups = new Map();
  for (const record of records) {
    const arm = record.model === CODE_ARM.model ? CODE_ARM.model : `${record.model}:${record.effort}`;
    const key = `${record.design}|${arm}`;
    const group = groups.get(key) ?? { design: record.design, arm, records: [] };
    group.records.push(record);
    groups.set(key, group);
  }
  return [...groups.values()].map(({ design, arm, records: armRecords }) => {
    const costs = armRecords.map((record) => record.costUsd).filter((cost) => typeof cost === 'number');
    return {
      design,
      arm,
      calls: armRecords.length,
      agentCalls: armRecords.filter((record) => record.agentCall !== false).length,
      correct: armRecords.filter((record) => record.correct).length,
      matchesProduction: armRecords.filter((record) => record.matchesProduction === true).length,
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

/** The shipped prompt builder, reply parser, Text matcher, transcript parser and reply reader, bundled on the fly. */
async function loadAppModules() {
  const esbuild = await import('esbuild');
  const entry = [
    "export { buildConditionPrompt, parseConditionReply } from './src/main/automations/condition-check/condition-prompt.ts';",
    "export { matchFinalLine } from './src/shared/final-line-match.ts';",
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
    // A Text match run carries its answer in its own columns, which a database from before them lacks.
    const runColumns = new Set(db.prepare("SELECT name FROM pragma_table_info('automation_runs')").all().map((column) => column.name));
    const hasTextMatch = runColumns.has('final_line_met') && runColumns.has('final_line_reason');
    const rows = db.prepare(`
      SELECT r.task_id, r.started_at, r.automation_name, r.condition_met, r.condition_reason, r.background_call_id,
        ${hasTextMatch ? 'r.final_line_met, r.final_line_reason' : 'NULL AS final_line_met, NULL AS final_line_reason'}
      FROM automation_runs r JOIN swimlanes s ON s.id = r.swimlane_id
      WHERE s.name = ? AND r.trigger = 'turn_end'
        AND (r.condition_reason IS NOT NULL${hasTextMatch ? ' OR r.final_line_reason IS NOT NULL' : ''}) AND r.started_at >= ?
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
        production: Object.fromEntries(group.rows.map((row) => [row.automation_name, productionAnswerOf(row)])),
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

/**
 * Judge every case under every design: a design with a Condition once per arm, `runs` times each; a
 * design of only Text match rows once, in code. Appends one record per judgment.
 */
async function run(options) {
  const cases = JSON.parse(fs.readFileSync(options.cases, 'utf8'));
  const labels = JSON.parse(fs.readFileSync(options.expect, 'utf8'));
  const designs = JSON.parse(fs.readFileSync(options.designs, 'utf8')).filter((design) => options.only.length === 0 || options.only.includes(design.name));
  for (const design of designs) assertDesignRows(design);
  const asksAgent = designs.some((design) => design.rows.some(hasConditionRow));
  if (asksAgent) {
    refuseIfAutomated();
    if (options.arms.length === 0) throw new Error('A design has a condition the Automation agent answers: pass --arms model:effort,...');
    // Node will not start a .cmd or .bat without a shell, and a shell drops the empty `--tools ''`.
    if (process.platform === 'win32' && /\.(cmd|bat|ps1)$/i.test(options.cli)) {
      throw new Error(`--cli names the shim ${options.cli}; pass the CLI's own executable`);
    }
    assertCliStarts(options.cli);
  }
  const app = await loadAppModules();
  fs.mkdirSync(options.out, { recursive: true });
  const recordsPath = path.join(options.out, 'records.jsonl');
  const selected = cases.filter((testCase) => options.caseIds.length === 0 || options.caseIds.includes(testCase.id));

  const lines = [...new Set(designs.flatMap((design) => design.rows.map((row) => row.finalLine ?? null)).filter((line) => line !== null))];
  const disagreements = lineDisagreements(selected, lines, app.matchFinalLine);
  fs.writeFileSync(path.join(options.out, 'disagreements.json'), JSON.stringify(disagreements, null, 2));
  if (lines.length > 0) {
    console.log(`matchFinalLine and lastLineIs disagree on ${disagreements.length} case line(s)`);
    for (const entry of disagreements) console.log(`  ${entry.caseId} "${entry.line}" code=${entry.code} strict=${entry.strict}`);
  }

  const jobs = [];
  for (const testCase of selected) {
    if (!testCase.reply) continue;
    const label = labels[testCase.id];
    if (!label || (typeof label.leftWork !== 'boolean' && !label.rows)) {
      throw new Error(`${testCase.id} has no leftWork label or row answers in ${options.expect}`);
    }
    const facts = { leftWork: label.leftWork === true, endsWithLine: testCase.endsWithLine, rows: label.rows ?? {} };
    for (const design of designs) {
      const rows = pendingRows(design, testCase);
      const guarded = rows.filter(isGuarded);
      if (guarded.length === 0) continue;
      const judged = rows.filter(hasConditionRow);
      const expected = outcomeOf(rows, new Map(guarded.map((row) => [row.key, truthOf(row.truth, facts, row.name)])));
      const job = { testCase, design, rows, guarded, judged, expected, facts, acceptEither: label.acceptEither === true };
      if (judged.length === 0) {
        jobs.push({ ...job, arm: CODE_ARM, attempt: 1 });
        continue;
      }
      for (const arm of options.arms) {
        for (let attempt = 1; attempt <= options.runs; attempt += 1) jobs.push({ ...job, arm, attempt });
      }
    }
  }
  const agentJobs = jobs.filter((job) => job.arm !== CODE_ARM).length;
  console.log(`${jobs.length} judgments queued, ${agentJobs} of them agent calls`);

  let settingsDirectory = null;
  let settingsPath = null;
  if (agentJobs > 0) {
    settingsDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-condition-check-settings-'));
    settingsPath = path.join(settingsDirectory, 'settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify(ANSWER_SETTINGS));
  }

  /** The agent's answers to the judged rows, or none at all on the code arm. */
  const askAgent = async (job) => {
    if (job.arm === CODE_ARM) {
      return { answers: {}, unanswered: [], result: { answer: null, costUsd: 0, tokens: null, durationMs: 0, models: [], isError: false }, exitCode: 0, stderr: '' };
    }
    const prompt = app.buildConditionPrompt({
      task: job.testCase.task,
      column: options.column ?? 'Executing',
      trigger: 'turn_end',
      move: null,
      agentReply: job.testCase.reply,
      rows: job.judged.map((row) => ({ automationId: row.key, name: row.name, condition: row.condition })),
    });
    const outcome = await runOnce(options.cli, conditionCheckArgs({ settingsPath, model: MODEL_IDS[job.arm.model], effort: job.arm.effort }), prompt, conditionCheckEnv(process.env, job.arm.effort));
    const result = readJsonResult(outcome.stdout);
    const parsed = result.answer ? app.parseConditionReply(result.answer, job.judged.length) : new Map();
    const answers = {};
    const unanswered = [];
    job.judged.forEach((row, index) => {
      const answer = parsed.get(index);
      if (!answer) unanswered.push(row.key);
      answers[row.key] = answer ?? null;
    });
    return { answers, unanswered, result, exitCode: outcome.code, stderr: outcome.stderr };
  };

  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const job = jobs[next];
      next += 1;
      const { testCase, design, rows, guarded, expected, facts, arm, attempt } = job;
      const { answers, unanswered, result, exitCode, stderr } = await askAgent(job);
      const metByKey = matchRowsInCode(rows, testCase.reply, app.matchFinalLine);
      for (const row of job.judged) metByKey.set(row.key, answers[row.key]?.met === true);
      const got = outcomeOf(rows, metByKey);
      const production = productionOutcomeOf(rows, testCase);
      const model = arm === CODE_ARM ? null : MODEL_IDS[arm.model];
      const record = {
        caseId: testCase.id,
        design: design.name,
        model: arm.model,
        effort: arm.effort,
        attempt,
        agentCall: arm !== CODE_ARM,
        expected,
        outcome: got,
        production,
        matchesProduction: got === production,
        acceptEither: Boolean(job.acceptEither),
        correct: outcomePasses({ got, expected, acceptEither: job.acceptEither, judgedTruths: guarded.map((row) => row.truth) }),
        rowsCorrect: Object.fromEntries(guarded.map((row) => [row.key, unanswered.includes(row.key) ? false : metByKey.get(row.key) === truthOf(row.truth, facts, row.name)])),
        answers,
        textMatches: Object.fromEntries(guarded.filter(hasFinalLineRow).map((row) => [row.key, metByKey.get(row.key)])),
        unanswered,
        costUsd: result.costUsd,
        tokens: result.tokens,
        durationMs: result.durationMs,
        models: result.models,
        wrongModel: model !== null && result.models.some((name) => !name.startsWith(model)),
        isError: result.isError,
        exitCode,
        reply: result.answer,
        ...(exitCode !== 0 ? { stderr } : {}),
      };
      fs.appendFileSync(recordsPath, `${JSON.stringify(record)}\n`);
      done += 1;
      const mark = record.correct ? 'ok  ' : 'MISS';
      const armName = arm === CODE_ARM ? CODE_ARM.model : `${arm.model}:${arm.effort}`;
      console.log(`${String(done).padStart(4)}/${jobs.length} ${mark} ${design.name} ${armName} ${testCase.id} #${attempt} expected=${expected} got=${got} production=${production} $${result.costUsd ?? '?'} ${result.durationMs ?? '?'}ms${unanswered.length ? ` unanswered=${unanswered.join(',')}` : ''}`);
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(options.concurrency, jobs.length) }, worker));
  } finally {
    if (settingsDirectory) removeDirectory(settingsDirectory);
  }
  return summary(options);
}

/** The table `run` ends with, from the records on disk. Spends nothing. */
function summary(options) {
  const recordsPath = path.join(options.out, 'records.jsonl');
  const records = fs.readFileSync(recordsPath, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  const rows = summarize(records);
  fs.writeFileSync(path.join(options.out, 'summary.json'), JSON.stringify(rows, null, 2));
  console.log('\ndesign | arm | correct | matches production | agent calls | stalls | unanswered rows | failed calls | median $ | total $ | median ms | median output tokens | calls writing cache | wrong cases');
  for (const row of rows) {
    console.log([
      row.design,
      row.arm,
      `${row.correct}/${row.calls}`,
      `${row.matchesProduction}/${row.calls}`,
      row.agentCalls,
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
  if (options.mode === 'run' && options.cases && options.expect && options.designs && options.out) return run(options);
  if (options.mode === 'summary' && options.out) return summary(options);
  console.error([
    'usage: node scripts/eval-condition-check.mjs build --db <project.db> --column <name> --since <iso> --out <dir>',
    '       node scripts/eval-condition-check.mjs run --cases <cases.json> --expect <expect.json> --designs <designs.json>',
    '         [--arms model:effort,...] [--runs N] [--concurrency N] [--only design,...] [--case-ids id,...]',
    '         [--cli <path>] [--column <name>] --out <dir>',
    '         (--arms is needed when a design has a condition; a design of only finalLine rows runs in code)',
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
