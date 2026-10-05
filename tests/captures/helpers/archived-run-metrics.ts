/**
 * What an archived task's run cost and did, measured from the run's own history file by main's
 * own parsers, so a Completed Tasks row in the web build is the number the desktop would write.
 *
 * On the desktop these come from `captureSessionMetrics` at suspend
 * (src/main/ipc/handlers/session-metrics.ts): cost and duration from the status line, then
 * `refineTranscriptTokens` and `refineTranscriptToolCounts`, which call exactly the two parsers
 * below. A headless run reports its cost and duration in its own result JSON, which is the same
 * pair the status line carries, so only the transcript half is computed here.
 *
 * Bundled by scripts/lib/bundle-ts-module.mjs, like message-trail-extract.ts, because the parsers
 * use extensionless specifiers Node cannot resolve.
 */
import fs from 'node:fs';
import { locateClaudeTranscriptFile, parseClaudeTranscriptToolCounts, parseClaudeTranscriptUsage } from '../../../src/main/agent/adapters/claude/transcript-parser';

export interface ArchivedRunTranscriptMetrics {
  /** The model the run's main conversation ran on, or null when no turn of it names one. */
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  /** Calls per tool name, as the run's tool breakdown reports them. */
  tools: Record<string, number>;
}

/** What a headless run's result (`claude -p --output-format json`) says about it. */
export interface HeadlessRunResult {
  /** The agent's own id for the run's history. */
  sessionId: string;
  durationMs: number;
  costUsd: number;
  numTurns: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * Where Claude wrote a run's history, located the way main locates it. Main reads the home
 * directory and never `CLAUDE_CONFIG_DIR`, so the run script refuses to start with that set.
 */
export function claudeHistoryPath(agentSessionId: string, cwd: string): string {
  return locateClaudeTranscriptFile(agentSessionId, cwd);
}

/**
 * Read the result a headless run prints, and refuse one that is not a finished, successful run:
 * its numbers would be a false record. Pinned to a real result in
 * tests/unit/archived-run-metrics.test.ts.
 */
export function readHeadlessRunResult(result: unknown): HeadlessRunResult {
  if (!isRecord(result)) throw new Error('the run printed no result object');
  if (result.is_error === true || result.subtype !== 'success') {
    throw new Error(`the run ended in ${String(result.subtype)}: ${String(result.result).slice(0, 400)}`);
  }
  const { session_id: sessionId, duration_ms: durationMs, total_cost_usd: costUsd, num_turns: numTurns } = result;
  if (typeof sessionId !== 'string' || sessionId.length === 0) throw new Error('the result names no session_id');
  if (!isNonNegativeNumber(durationMs)) throw new Error(`the result's duration_ms is ${String(durationMs)}`);
  if (!isNonNegativeNumber(costUsd)) throw new Error(`the result's total_cost_usd is ${String(costUsd)}`);
  if (!isNonNegativeNumber(numTurns)) throw new Error(`the result's num_turns is ${String(numTurns)}`);
  return { sessionId, durationMs, costUsd, numTurns };
}

/**
 * The model a run's main conversation ran on: the one most of its own assistant lines name, as
 * the CLI's status line names it on the desktop. Not the model with the most output in the
 * result's `modelUsage`: Claude Code's advisor tool answers on its own model and bills it to the
 * same run, so an advisor that out-writes the main conversation would name the row. A subagent's
 * line (`isSidechain`) and a synthetic one (`<synthetic>`, an API error or an interrupt) do not
 * count.
 */
export function mainLoopModel(transcript: string): string | null {
  const linesByModel = new Map<string, number>();
  for (const line of transcript.split('\n')) {
    if (line.trim().length === 0) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(record) || record.type !== 'assistant' || record.isSidechain === true) continue;
    const message = record.message;
    if (!isRecord(message) || typeof message.model !== 'string' || message.model.startsWith('<')) continue;
    linesByModel.set(message.model, (linesByModel.get(message.model) ?? 0) + 1);
  }
  let chosen: string | null = null;
  let chosenLines = 0;
  for (const [model, lines] of linesByModel) {
    if (lines > chosenLines) {
      chosen = model;
      chosenLines = lines;
    }
  }
  return chosen;
}

/** The run's model, tokens and tools, or null when either parser finds nothing (never a guessed zero). */
export async function measureClaudeRun(historyPath: string): Promise<ArchivedRunTranscriptMetrics | null> {
  const usage = await parseClaudeTranscriptUsage(historyPath);
  const toolCounts = await parseClaudeTranscriptToolCounts(historyPath);
  if (!usage || !toolCounts) return null;
  const tools: Record<string, number> = {};
  for (const toolStat of toolCounts.toolBreakdown) tools[toolStat.toolName] = toolStat.callCount;
  const model = mainLoopModel(fs.readFileSync(historyPath, 'utf-8'));
  return { model, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, tools };
}
