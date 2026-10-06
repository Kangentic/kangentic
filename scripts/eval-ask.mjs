/**
 * Measures whether Ask answers correctly, and what it costs to do so.
 *
 * MANUAL ONLY. Every question is one real agent call, so this must never be
 * reachable from `/test`, from CI, or from any automated path. Run it yourself,
 * against a running preview, when you want the number.
 *
 *   node scripts/eval-ask.mjs                    # grade every question
 *   node scripts/eval-ask.mjs --only=superlative # a subset, by id substring
 *   node scripts/eval-ask.mjs --dry              # ground truth only, no calls
 *
 * `--dry` is the one to reach for first: it computes every expected answer and
 * spends nothing, so a broken provider is found before any quota is.
 *
 * WHY IT DRIVES A LIVE PREVIEW rather than importing the pipeline. Ask spans
 * retrieval, the embedder, the projection cache and an agent adapter, all of
 * which live in the Electron main process. A standalone harness would have to
 * reimplement that chain and would then be measuring its own copy. Driving the
 * running app through the preview's inspection bridge measures the code that
 * actually ships, and costs about two hundred lines less.
 *
 * ON GROUND TRUTH. Nothing here is a stored expectation. Each question computes
 * its answer from the same live projection the prompt was built from, so the
 * two cannot disagree about the corpus. The rollup below is a small local copy
 * of what `buildAnswerTaskTable` does, and `tests/unit/eval-ask-rollup.test.ts`
 * pins that the two agree - the same self-check the clustering rig used, which
 * earned its keep by catching a real divergence the first time it ran.
 *
 * TWO MORE NUMBERS PER QUESTION since the answer started streaming and the
 * agent started searching for itself: time to FIRST TOKEN, which is what the
 * streaming exists to move, and TURNS (one plus the agent's tool calls), which
 * is the "a transcript question takes 2 to 4 turns" claim made measurable. A
 * transcript question can also require that a search HAPPENED and that the
 * answer quoted what it read, graded from the same record.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as url from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { QUESTIONS } from './eval-ask-questions.mjs';
import { evaluateInPreview, readPreviewPort as readPreviewPortOf } from './lib/preview-bridge.mjs';
// The answer table's own query, not a copy. Node strips the types on import.
import { BOARD_TASK_FACTS_SQL, toBoardTaskFacts } from '../src/main/retrieval/board-task-facts.ts';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '..');

/** Where a running preview announces its inspection port. */
function readPreviewPort() {
  return readPreviewPortOf(PROJECT_ROOT);
}

/**
 * Evaluate an expression in the preview's renderer. Thirty seconds by default: a
 * single wedged agent would otherwise hang the whole run silently, which on a
 * ten-question pass is the difference between one bad result and no results.
 */
function evaluate(port, expression, timeoutMs = 30_000) {
  return evaluateInPreview(port, expression, timeoutMs);
}

/**
 * Conversations rolled up per TASK.
 *
 * A local copy of the shipped rollup, kept honest by a unit test rather than by
 * discipline. Sums are nullable throughout: a task that recorded no cost is not
 * a free one, and turning that into a zero would make it the cheapest thing on
 * the board and silently wrong every superlative.
 *
 * `boardTasks` are the board's own records. Since task records joined the
 * index, the answer's table holds every board task, and one with no indexed
 * conversation joins as its own row. Without them this rolled up 516 tasks
 * against the answer's 683, and failed three answers that were right.
 */
function rollUpConversations(nodes, boardTasks = []) {
  const byTask = new Map();
  for (const node of nodes) {
    const key = node.taskId ?? `conversation:${node.docKey}`;
    const existing = byTask.get(key);
    if (!existing) {
      byTask.set(key, {
        taskId: node.taskId,
        displayId: node.displayId,
        title: node.title ?? 'Untitled',
        sessions: 1,
        costUsd: node.costUsd,
        durationMs: node.durationMs,
        tokens: node.tokens,
        outcome: node.outcome,
        lastActivityMs: node.lastActivityMs,
        // The conversations behind the row, so a SELECTED line (which the
        // handler resolves to docKeys) can be mapped back to the task it names.
        docKeys: [node.docKey],
      });
      continue;
    }
    existing.sessions += 1;
    existing.docKeys.push(node.docKey);
    existing.costUsd = addMetric(existing.costUsd, node.costUsd);
    existing.durationMs = addMetric(existing.durationMs, node.durationMs);
    existing.tokens = addMetric(existing.tokens, node.tokens);
    if (node.lastActivityMs !== null
      && (existing.lastActivityMs === null || node.lastActivityMs > existing.lastActivityMs)) {
      existing.lastActivityMs = node.lastActivityMs;
    }
    if (existing.outcome === null) existing.outcome = node.outcome;
    if (existing.displayId === null) existing.displayId = node.displayId;
  }
  // A task's pull request belongs to the TASK, so every row takes it from the
  // board's record, as the shipped table does.
  const boardByTask = new Map(boardTasks.map((task) => [task.taskId, task]));
  for (const row of byTask.values()) {
    const board = row.taskId ? boardByTask.get(row.taskId) : undefined;
    row.prState = board?.prState ?? null;
  }
  for (const task of boardTasks) {
    if (byTask.has(task.taskId)) continue;
    byTask.set(task.taskId, {
      taskId: task.taskId,
      displayId: task.displayId,
      title: task.title,
      sessions: task.sessions,
      costUsd: task.costUsd,
      durationMs: task.durationMs,
      tokens: task.tokens,
      outcome: task.outcome,
      lastActivityMs: task.lastActivityMs,
      prState: task.prState ?? null,
      docKeys: [],
    });
  }
  return [...byTask.values()];
}

/**
 * Every board task with its facts, read from the preview's database with the
 * answer table's own query. A `/preview` keeps its databases inside the
 * worktree (`scripts/dev.js`, `--ephemeral`). Read-only, so the running app
 * keeps its lock.
 */
function readBoardTasks(projectId) {
  if (!projectId) throw new Error('The preview has no project open.');
  const dbPath = path.join(PROJECT_ROOT, '.kangentic', 'data', 'projects', `${projectId}.db`);
  if (!fs.existsSync(dbPath)) {
    throw new Error(`No project database at ${dbPath}. Start the preview with /preview, which keeps it there.`);
  }
  const database = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return database.prepare(BOARD_TASK_FACTS_SQL).all().map(toBoardTaskFacts);
  } finally {
    database.close();
  }
}

function addMetric(current, next) {
  if (next === null || next === undefined) return current;
  return (current ?? 0) + next;
}

/** Ground-truth providers, one per corpus. The seam the repo corpus plugs into. */
const ROLLUPS = {
  conversation: async (port) => {
    const { nodes, projectId } = await evaluate(
      port,
      // The wire carries the map as `projectionJson`; only the renderer store
      // parses it, so this read does the same.
      '(async () => { const s = await window.electronAPI.knowledgeGraph.graphSnapshot(null);'
      + ' const projection = s.projectionJson ? JSON.parse(s.projectionJson) : s.projection;'
      + ' const project = await window.electronAPI.projects.getCurrent();'
      + ' return { nodes: projection ? projection.nodes : null, projectId: project ? project.id : null }; })()',
    );
    if (!nodes) throw new Error('The preview has no projection yet. Let the map finish building.');
    return rollUpConversations(nodes, readBoardTasks(projectId));
  },
  // What the code corpus holds. A code question's truth is a fact of the
  // repository, written with the question; this says only whether the code is
  // indexed and embedded, so a run without it skips them rather than failing.
  code: async (port) => {
    const snapshot = await evaluate(port, 'window.electronAPI.knowledgeGraph.graphSnapshot(null)');
    const code = snapshot?.index?.corpora?.find((entry) => entry.corpus === 'code');
    return { files: code?.documents ?? 0, chunks: code?.chunks ?? 0, embedded: code?.embeddedChunks ?? 0 };
  },
};

/**
 * Ask the running app, through the same IPC the panel uses.
 *
 * The generous deadline is deliberate: the answer path spawns a real CLI, and a
 * cold one on a large prompt has been measured near a minute. Five minutes
 * bounds a wedge without failing a slow but working call.
 */
const ASK_TIMEOUT_MS = 5 * 60_000;

async function ask(port, question) {
  const started = Date.now();
  try {
    // Driven the way the panel drives it: a request id the stream is keyed
    // on, and a subscription that records WHEN the first text landed and how
    // many tool calls the agent made. Measured in the renderer, so the numbers
    // are what a user would see rather than what this script observed over
    // the bridge.
    const outcome = await evaluate(
      port,
      `(async () => {
        const requestId = crypto.randomUUID();
        const started = performance.now();
        let firstTextMs = null;
        let setMs = null;
        let toolCalls = 0;
        const off = window.electronAPI.knowledgeGraph.onAnswerStream((event) => {
          if (event.requestId !== requestId) return;
          if (event.kind === 'set' && setMs === null) setMs = performance.now() - started;
          if (event.kind === 'text' && firstTextMs === null) firstTextMs = performance.now() - started;
          if (event.kind === 'tool') toolCalls += 1;
        });
        try {
          const result = await window.electronAPI.knowledgeGraph.answerFromGraph(${JSON.stringify(question)}, null, 'balanced', requestId, { chatId: requestId, history: [], scopeDocKeys: null });
          return { result, firstTextMs, setMs, toolCalls };
        } finally {
          off();
        }
      })()`,
      ASK_TIMEOUT_MS,
    );
    return { ...outcome, elapsedMs: Date.now() - started };
  } catch (error) {
    if (error.name === 'TimeoutError') {
      return { result: null, timedOut: true, elapsedMs: Date.now() - started };
    }
    throw error;
  }
}

/**
 * A few consecutive words that are IN a transcript of this task, and in no
 * task title.
 *
 * Read out of the task's own conversation through the same transcript call the
 * viewer makes, which in a preview is rebuilt from the indexed chunks - so the
 * phrase is in the search index by construction and answerable only by
 * searching. Chosen deterministically, so the same corpus asks the same
 * question: the first run of seven plain words in the conversation's PROSE,
 * starting a third of the way in. Tool calls, tool results and the opening
 * task brief are skipped - the brief is the title and description the table
 * already carries, and tool traffic is paths and code rather than words. Null
 * when nothing usable exists, and the question is then skipped, never failed.
 */
async function phraseFromTranscript(port, target) {
  const bodies = await evaluate(
    port,
    `(async () => {
      const snapshot = await window.electronAPI.knowledgeGraph.graphSnapshot(null);
      const projection = snapshot?.projectionJson ? JSON.parse(snapshot.projectionJson) : snapshot?.projection;
      const node = (projection?.nodes ?? []).find((entry) => entry.taskId === ${JSON.stringify(target.taskId)});
      if (!node?.sessionId) return [];
      const response = await window.electronAPI.transcripts.get({ sessionId: node.sessionId, projectId: null });
      return (response.entries ?? []).map((entry) => {
        if (typeof entry.text === 'string') return entry.text;
        return (entry.blocks ?? [])
          .filter((block) => block.type === 'text' && typeof block.text === 'string')
          .map((block) => block.text)
          .join(' ');
      });
    })()`,
  );
  const plainWord = /^[A-Za-z][A-Za-z'-]*[.,;:]?$/;
  const prose = (bodies ?? [])
    .map((text) => String(text ?? '').replace(/^(User|Assistant):\s*/, ''))
    .filter((text) => text.length > 80 && !/^(Tool|<task)/.test(text));
  for (let index = Math.floor(prose.length / 3); index < prose.length; index += 1) {
    const tokens = prose[index].split(/\s+/);
    for (let at = 0; at + 7 <= tokens.length; at += 1) {
      const window = tokens.slice(at, at + 7);
      if (!window.every((token) => plainWord.test(token))) continue;
      // A run of short function words ("and so it is in the way") matches
      // half the corpus; three real words keep the phrase distinctive.
      if (window.filter((token) => token.length >= 5).length < 3) continue;
      return window.map((token) => token.replace(/[.,;:]$/, '')).join(' ');
    }
  }
  return null;
}

/**
 * Every name a result gives a task beyond its prose.
 *
 * An answer names a task in two places the reader can see: the prose, and the
 * source rows under it, which are the tasks the prose named plus the rest of
 * its SELECTED line. A grader reading the prose alone failed answers whose rows
 * held exactly the right task. That is a correct answer by any reading a person
 * would give it.
 */
function namedTasks(result) {
  const names = (result.rows ?? [])
    .filter((row) => row.displayId != null)
    .map((row) => `#${row.displayId}`);
  return [...new Set(names)];
}

/**
 * A straight or an opening curly double quote. Built from the code point so
 * the source carries no typographic quote of its own.
 */
const QUOTE_MARK = new RegExp(`["${String.fromCharCode(0x201c)}]`);

/**
 * Containment grading. Deterministic, no model, no human.
 *
 * Case-insensitive because an answer is prose and the facts are numbers and
 * tickets; commas are stripped from the haystack so `1,234` matches `1234`
 * without every provider having to guess which the agent wrote.
 */
function grade(answerText, expectation, evidence = {}) {
  const normalize = (text) => String(text).toLowerCase().replace(/,/g, '');
  const prose = normalize(answerText);
  // A FACT may sit in the rows as well as in the prose, since both reach the
  // reader. A FORBIDDEN claim is judged on the prose alone.
  const supporting = normalize([
    answerText,
    ...(evidence.namedTasks ?? []),
  ].join('\n'));
  const carries = (fact) => supporting.includes(normalize(fact));
  const says = (fact) => prose.includes(normalize(fact));

  const missing = (expectation.all ?? []).filter((fact) => !carries(fact));
  const forbidden = (expectation.none ?? []).filter(says);
  // `any` is for a fact the answer may legitimately phrase more than one way -
  // a total the agent rounded differently, a refusal worded its own way. A
  // grader that demands one exact spelling of those measures punctuation, not
  // correctness, and fails answers that are right.
  const alternatives = expectation.any ?? [];
  if (alternatives.length > 0 && !alternatives.some(carries)) {
    missing.push(`any of ${JSON.stringify(alternatives)}`);
  }
  // `allOf` is several `any` groups at once: every group must be carried under
  // one of its spellings. A relatedness question's recall floor is this shape -
  // each of the busiest title-named tasks must appear, in the prose or the rows.
  for (const group of expectation.allOf ?? []) {
    if (!group.some(carries)) missing.push(`any of ${JSON.stringify(group)}`);
  }
  // Evidence beyond the prose. A transcript question that the agent answered
  // WITHOUT searching answered from the table or from thin air, and either is
  // the failure this round exists to catch.
  if (expectation.searched && !(evidence.toolCalls > 0)) {
    missing.push('a kangentic_search call');
  }
  // A QUOTED passage in the answer: a quote is what proves something was read,
  // where a summary could have come from the table row alone.
  if (expectation.grounded && !QUOTE_MARK.test(String(answerText))) {
    missing.push('a quoted passage');
  }

  return {
    pass: missing.length === 0 && forbidden.length === 0,
    missing,
    forbidden,
  };
}

function parseArgs(argv) {
  const only = argv.find((arg) => arg.startsWith('--only='))?.slice('--only='.length) ?? null;
  const regrade = argv.find((arg) => arg.startsWith('--regrade='))?.slice('--regrade='.length) ?? null;
  return { only, regrade, dry: argv.includes('--dry') };
}

/**
 * Refuse to run anywhere automated.
 *
 * This spends real subscription quota per question, so it is a thing a person
 * runs deliberately while optimizing something - never a step in a pipeline. A
 * comment saying so is not a guarantee; this is. `--dry` and `--regrade` are
 * exempt because they spend nothing.
 */
function refuseIfAutomated(spendsQuota) {
  if (!spendsQuota) return;
  const automated = ['CI', 'CONTINUOUS_INTEGRATION', 'GITHUB_ACTIONS', 'BUILD_NUMBER']
    .find((name) => process.env[name]);
  if (automated) {
    throw new Error(
      `Refusing to run: ${automated} is set.\n`
      + 'This harness spends a real agent call per question and is for on-demand use only.\n'
      + 'Use --dry (free) or --regrade=<file> (free) in an automated context.',
    );
  }
}

/**
 * Every answer, verbatim, written beside the verdicts.
 *
 * Re-grading is then free. That matters more here than anywhere else in the
 * repo: the first run of this harness produced six failures of which THREE were
 * bad graders, and finding that out cost ten agent calls. With a saved run,
 * fixing a grader and re-scoring costs nothing.
 */
function saveRun(runs) {
  // NOT under the worktree's `.kangentic/`, which looks like the natural home
  // and is not: a preview running in ephemeral mode wipes that directory when
  // it exits, so the record of a run that cost ten agent calls would vanish
  // with the window that produced it. The temp dir outlives the preview, and
  // the absolute path is printed so it is findable.
  const directory = path.join(os.tmpdir(), 'kangentic-eval-ask');
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `run-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify(runs, null, 2), 'utf-8');
  return file;
}

async function main() {
  const { only, dry, regrade } = parseArgs(process.argv.slice(2));
  refuseIfAutomated(!dry && !regrade);

  // Re-scoring a saved run. Free, and it exists because on any given first run
  // a grader is far likelier to be wrong than the product.
  if (regrade) return regradeSavedRun(regrade, only);

  const port = readPreviewPort();
  const selected = QUESTIONS.filter((entry) => !only || entry.id.includes(only));
  if (selected.length === 0) throw new Error(`No question id matches "${only}".`);

  const rollupCache = new Map();
  const tools = { phraseFrom: (target) => phraseFromTranscript(port, target) };
  const rows = [];
  const runs = [];
  let passed = 0;
  let skipped = 0;
  let totalTokens = 0;
  // Questions that reported their prompt tokens: a hung or failed one has none,
  // and averaging over it understated the figure.
  let tokenRows = 0;

  for (const entry of selected) {
    if (!rollupCache.has(entry.corpus)) {
      const provider = ROLLUPS[entry.corpus];
      if (!provider) throw new Error(`No ground-truth provider for corpus "${entry.corpus}".`);
      rollupCache.set(entry.corpus, await provider(port));
    }
    // One question whose truth cannot be computed on this board is reported,
    // not allowed to end the whole run.
    let expectation;
    try {
      expectation = await entry.truth(rollupCache.get(entry.corpus), tools);
    } catch (error) {
      rows.push({ id: entry.id, verdict: 'ERROR', note: `ground truth failed: ${error instanceof Error ? error.message : String(error)}` });
      continue;
    }

    // A question that cannot apply to this board is SKIPPED, never failed.
    if (!expectation) {
      skipped += 1;
      rows.push({ id: entry.id, verdict: 'SKIP', note: 'not applicable to this index' });
      continue;
    }
    // A transcript question is WRITTEN at run time from the corpus, so the
    // expectation may carry the question it computed the truth for.
    const question = expectation.question ?? entry.question;
    if (dry) {
      // Every clause printed, so a dry run is genuinely reviewable. A question
      // whose only assertion lives in `any` would otherwise read as "expects
      // nothing" and look broken while being correct.
      const clauses = [
        expectation.all.length ? `needs ${JSON.stringify(expectation.all)}` : '',
        expectation.any.length ? `needs one of ${JSON.stringify(expectation.any)}` : '',
        expectation.allOf?.length ? `needs each of ${JSON.stringify(expectation.allOf)}` : '',
        expectation.none.length ? `forbids ${JSON.stringify(expectation.none)}` : '',
        expectation.searched ? 'must search' : '',
        expectation.grounded ? 'must quote a passage' : '',
      ].filter(Boolean);
      const asked = expectation.question ? ` asks ${JSON.stringify(question)} /` : '';
      rows.push({ id: entry.id, verdict: 'DRY', note: `${asked} ${clauses.join(' / ') || 'NO ASSERTION'}`.trim() });
      continue;
    }

    const { result, elapsedMs, timedOut, firstTextMs, setMs, toolCalls } = await ask(port, question);
    if (timedOut) {
      rows.push({ id: entry.id, verdict: 'HUNG', elapsedMs, note: 'no answer within the deadline' });
      continue;
    }
    if (!result?.ok) {
      rows.push({ id: entry.id, verdict: 'ERROR', note: result?.reason ?? 'no result' });
      continue;
    }
    const evidence = {
      toolCalls: toolCalls ?? 0,
      namedTasks: namedTasks(result),
    };
    const verdict = grade(result.answer, expectation, evidence);
    // Recorded BEFORE grading enters into it, so a later re-score judges the
    // answer rather than what this run happened to conclude about it.
    runs.push({
      id: entry.id,
      question,
      answer: result.answer,
      // The rows, as task names, so a re-score can see a task the prose never
      // spelled out.
      namedTasks: evidence.namedTasks,
      // How many related tasks the agent was handed, which is what its
      // "Reading N related tasks" line said.
      handedCount: result.handedCount ?? null,
      promptTokens: result.promptTokens ?? null,
      elapsedMs,
      // When the related set reached the map, before the agent started.
      setMs: setMs ?? null,
      firstTextMs: firstTextMs ?? null,
      toolCalls: evidence.toolCalls,
    });
    if (verdict.pass) passed += 1;
    // Reported when the payload carries it, so the token line is a measurement
    // rather than an estimate. Absent is printed as absent.
    const tokens = result.promptTokens ?? null;
    if (tokens) {
      totalTokens += tokens;
      tokenRows += 1;
    }
    rows.push({
      id: entry.id,
      verdict: verdict.pass ? 'PASS' : 'FAIL',
      elapsedMs,
      setMs: setMs ?? null,
      firstTextMs: firstTextMs ?? null,
      turns: evidence.toolCalls + 1,
      tokens,
      note: verdict.pass
        ? ''
        : [
          verdict.missing.length ? `missing ${JSON.stringify(verdict.missing)}` : '',
          verdict.forbidden.length ? `should not have said ${JSON.stringify(verdict.forbidden)}` : '',
        ].filter(Boolean).join(' / '),
      answer: verdict.pass ? '' : result.answer.slice(0, 160).replace(/\s+/g, ' '),
    });
  }

  for (const row of rows) {
    const timing = row.elapsedMs ? ` ${(row.elapsedMs / 1000).toFixed(1)}s` : '';
    const set = row.setMs != null ? ` set ${(row.setMs / 1000).toFixed(1)}s` : '';
    const first = `${set}${row.firstTextMs != null ? ` first ${(row.firstTextMs / 1000).toFixed(1)}s` : ''}`;
    const turns = row.turns ? ` ${row.turns} turn${row.turns === 1 ? '' : 's'}` : '';
    const tokens = row.tokens ? ` ${row.tokens}tok` : '';
    console.log(`${row.verdict.padEnd(5)} ${row.id.padEnd(26)}${timing}${first}${turns}${tokens} ${row.note}`);
    if (row.answer) console.log(`      got: ${row.answer}`);
  }

  if (dry) {
    console.log(`\n${rows.length} question(s) resolved. No agent calls made.`);
    return;
  }
  const graded = rows.length - skipped;
  console.log(`\n${passed}/${graded} passed, ${skipped} skipped`);
  if (tokenRows) console.log(`${Math.round(totalTokens / tokenRows)} prompt tokens per question`);
  const timed = runs.filter((run) => run.elapsedMs).map((run) => run.elapsedMs).sort((a, b) => a - b);
  const firsts = runs.filter((run) => run.firstTextMs != null).map((run) => run.firstTextMs).sort((a, b) => a - b);
  const median = (values) => values[Math.floor(values.length / 2)];
  if (timed.length) {
    console.log(`total: median ${(median(timed) / 1000).toFixed(1)}s, slowest ${(timed[timed.length - 1] / 1000).toFixed(1)}s`);
  }
  const sets = runs.filter((run) => run.setMs != null).map((run) => run.setMs).sort((a, b) => a - b);
  if (sets.length) {
    console.log(`related set: median ${(median(sets) / 1000).toFixed(1)}s, slowest ${(sets[sets.length - 1] / 1000).toFixed(1)}s`);
  }
  if (firsts.length) {
    console.log(`first token: median ${(median(firsts) / 1000).toFixed(1)}s, slowest ${(firsts[firsts.length - 1] / 1000).toFixed(1)}s`);
  }
  const searched = runs.filter((run) => run.toolCalls > 0);
  if (searched.length) {
    const most = Math.max(...searched.map((run) => run.toolCalls + 1));
    console.log(`turns: ${searched.length} of ${runs.length} questions searched, at most ${most} turns`);
  }
  if (runs.length > 0) console.log(`answers saved to ${saveRun(runs)}`);
}

/**
 * Re-score a saved run against the CURRENT graders, spending nothing.
 *
 * Ground truth is still recomputed live, so a re-score is only meaningful while
 * the corpus has not moved underneath it. A question whose expectation no
 * longer applies is reported rather than quietly counted.
 */
async function regradeSavedRun(file, only) {
  const saved = JSON.parse(fs.readFileSync(file, 'utf-8'));
  const port = readPreviewPort();
  const rollupCache = new Map();
  const tools = { phraseFrom: (target) => phraseFromTranscript(port, target) };
  let passed = 0;
  let graded = 0;

  for (const run of saved) {
    if (only && !run.id.includes(only)) continue;
    const entry = QUESTIONS.find((question) => question.id === run.id);
    if (!entry) {
      console.log(`GONE  ${run.id.padEnd(24)} no longer in the question set`);
      continue;
    }
    if (!rollupCache.has(entry.corpus)) {
      rollupCache.set(entry.corpus, await ROLLUPS[entry.corpus](port));
    }
    let expectation;
    try {
      expectation = await entry.truth(rollupCache.get(entry.corpus), tools);
    } catch (error) {
      console.log(`ERROR ${run.id.padEnd(24)} ground truth failed: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (!expectation) {
      console.log(`SKIP  ${run.id.padEnd(24)} not applicable to this index`);
      continue;
    }
    // A run-time question is re-scored only against the question it asked. If
    // the corpus moved and the harness would now ask something else, the saved
    // answer is about a different question and is reported rather than graded.
    if (expectation.question && expectation.question !== run.question) {
      console.log(`MOVED ${run.id.padEnd(24)} the corpus now asks a different question`);
      continue;
    }
    graded += 1;
    const verdict = grade(run.answer, expectation, {
      toolCalls: run.toolCalls ?? 0,
      namedTasks: run.namedTasks ?? [],
    });
    if (verdict.pass) passed += 1;
    const note = verdict.pass ? '' : [
      verdict.missing.length ? `missing ${JSON.stringify(verdict.missing)}` : '',
      verdict.forbidden.length ? `should not have said ${JSON.stringify(verdict.forbidden)}` : '',
    ].filter(Boolean).join(' / ');
    console.log(`${verdict.pass ? 'PASS ' : 'FAIL '}${run.id.padEnd(24)} ${note}`);
    if (!verdict.pass) console.log(`      got: ${run.answer.slice(0, 160).replace(/\s+/g, ' ')}`);
  }
  console.log(`\n${passed}/${graded} re-scored from ${path.basename(file)}. No agent calls made.`);
}

/**
 * The pure halves, exported so `tests/unit/eval-ask-rollup.test.ts` can pin the
 * rollup against the shipped one. Nothing else imports these.
 */
export const __testing = { rollUpConversations, grade, refuseIfAutomated };

// Only when run as a command. Without this guard, importing the module for the
// self-check test would fire the whole harness - and the self-check exists
// precisely so the harness does not have to run to catch drift.
/** Whether node was asked to run this file. Compared by real path, as
 *  `package-smoke.mjs` does: node resolves the entry through links, so a
 *  checkout under a link or junction never matched by URL and ran nothing. */
function isEntrypoint() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(url.fileURLToPath(import.meta.url)) === fs.realpathSync(path.resolve(process.argv[1]));
  } catch {
    return url.pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
  }
}

if (isEntrypoint()) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
