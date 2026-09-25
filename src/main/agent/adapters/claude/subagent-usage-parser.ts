import fs from 'node:fs';
import path from 'node:path';
import { streamJsonlRecords } from '../../shared/history-scan';
import { locateClaudeTranscriptFile } from './transcript-parser';
import type { SubagentSpawnLink, SubagentTranscriptSignature, SubagentUsageTurn } from '../../agent-adapter';

/**
 * Claude writes every Task-tool subagent's conversation to its OWN transcript,
 * in a directory the main session JSONL does not mention:
 *
 *   ~/.claude/projects/<slug>/<agentSessionId>/subagents/agent-<id>.jsonl
 *   ~/.claude/projects/<slug>/<agentSessionId>/subagents/agent-<id>.meta.json
 *
 * Nothing in the main transcript stands in for those turns. Measured across 877
 * real main transcripts on a dogfooding machine: ZERO carry an
 * `isSidechain: true` record, so subagent usage is absent from the file the
 * conversation indexer walks rather than filtered out of it. On one real
 * /code-review session that is 83% of the turns and 71% of the cache-read
 * tokens.
 *
 * The sidecar carries the prize:
 *
 *   {"agentType":"test-builder","description":"...","toolUseId":"toolu_01...",
 *    "spawnDepth":1,"requestShape":"background","requestNonInteractive":true}
 *
 * `agentType` makes per-finder attribution free, so the board can answer "which
 * reviewer costs the most" instead of only "this review cost $41.26".
 */

/** Directory name Claude uses for a session's subagent transcripts. */
const SUBAGENTS_DIR = 'subagents';
/** Claude's placeholder model on synthetic assistant records (API-error notices). */
const SYNTHETIC_MODEL = '<synthetic>';
/**
 * The tool Claude spawns a subagent with. A subagent's sidecar records the id of
 * the `Task` call that created it as `toolUseId`, so matching this name in a
 * transcript's `tool_use` blocks is how the spawning turn is found again.
 *
 * Exported for `claude-adapter.ts` to declare as `subagentSpawnToolName`, so the
 * literal lives once beside the sidecar format it belongs to.
 */
export const CLAUDE_SUBAGENT_SPAWN_TOOL = 'Task';

/**
 * Locate a session's subagent transcript directory.
 *
 * Derived from the RESOLVED main transcript path rather than by recomputing the
 * project slug, so a relocated project (see `claude-project-relocation.ts`)
 * keeps working: whatever directory the main JSONL was found in is the one whose
 * sibling we want.
 */
export function locateClaudeSubagentDir(agentSessionId: string, cwd: string): string {
  const transcriptPath = locateClaudeTranscriptFile(agentSessionId, cwd);
  return path.join(path.dirname(transcriptPath), agentSessionId, SUBAGENTS_DIR);
}

/**
 * Cheap staleness signature for a subagent directory, without parsing anything.
 *
 * The main transcript's mtime/size do NOT move while a subagent is running (its
 * bytes go to a different file), so the directory needs its own signature or a
 * fan-out's turns would never be seen as stale. `fileCount` is part of it
 * because a new subagent starting adds a file without necessarily changing the
 * largest mtime within the same millisecond.
 *
 * Returns null when the directory does not exist, which is how a pruned (or
 * never-fanned-out) session is distinguished from one with zero-token
 * subagents.
 */
export function statClaudeSubagentDir(directory: string): SubagentTranscriptSignature | null {
  let entries: string[];
  try {
    entries = fs.readdirSync(directory);
  } catch {
    return null;
  }
  let fileCount = 0;
  let totalSize = 0;
  let maxMtimeMs = 0;
  for (const entry of entries) {
    if (!entry.endsWith('.jsonl')) continue;
    let stats: fs.Stats;
    try {
      stats = fs.statSync(path.join(directory, entry));
    } catch {
      continue;
    }
    fileCount += 1;
    totalSize += stats.size;
    if (stats.mtimeMs > maxMtimeMs) maxMtimeMs = stats.mtimeMs;
  }
  return { fileCount, totalSize, maxMtimeMs };
}

interface SubagentMeta {
  agentType: string | null;
  spawnDepth: number | null;
  parentToolUseId: string | null;
}

/** Read `agent-<id>.meta.json`. Every field is optional: a missing or corrupt
 *  sidecar degrades to nulls rather than dropping the subagent's tokens. */
function readSubagentMeta(metaPath: string): SubagentMeta {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  } catch {
    return { agentType: null, spawnDepth: null, parentToolUseId: null };
  }
  if (typeof raw !== 'object' || raw === null) {
    return { agentType: null, spawnDepth: null, parentToolUseId: null };
  }
  const record = raw as Record<string, unknown>;
  return {
    agentType: typeof record.agentType === 'string' && record.agentType.length > 0 ? record.agentType : null,
    spawnDepth: typeof record.spawnDepth === 'number' && Number.isFinite(record.spawnDepth) ? record.spawnDepth : null,
    parentToolUseId: typeof record.toolUseId === 'string' && record.toolUseId.length > 0 ? record.toolUseId : null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Finite number or 0 (for tolerant transcript `usage` field reads). */
function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** One message id's folded usage, plus the tie-breakers for a stable row. */
/**
 * Record every `Task` tool-use id this message emitted, keyed to the message that
 * emitted it.
 *
 * A Map rather than a list, so re-emitted records of one message (which is why
 * the usage fold exists at all) union instead of duplicating. That keeps a
 * re-walk of an appended file byte-identical, the same property `ts` and `model`
 * are held to above.
 */
function collectSpawnToolUseIds(content: unknown, messageId: string, into: Map<string, string>): void {
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type !== 'tool_use') continue;
    if (block.name !== CLAUDE_SUBAGENT_SPAWN_TOOL) continue;
    const toolUseId = typeof block.id === 'string' && block.id.length > 0 ? block.id : null;
    if (!toolUseId) continue;
    into.set(toolUseId, messageId);
  }
}

interface FoldedMessage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  /** Earliest timestamp seen for this message id, epoch ms, or null. */
  tsMs: number | null;
  model: string | null;
}

/**
 * Parse one subagent transcript into folded per-message usage.
 *
 * FIELD-WISE MAX PER `message.id`, never a sum and never first-wins. Both wrong
 * answers are easy to reach and neither is visible without measuring:
 *
 * - Summing per record double-counts. One API message is written as several
 *   JSONL records that EACH carry the message's full usage; 33,317 of 60,012
 *   usage-bearing records in a real corpus were repeats of an id already seen.
 * - First-wins (what `transcript-parser.ts` does for the main thread, via
 *   `usageAttributedMessageIds`) takes a MID-STREAM record. Subagent files
 *   re-emit a message as its output grows, e.g. `output_tokens` 1 then 253 under
 *   one id. Simulating that exact rule over 604 real subagent files undercounts
 *   output by 30.1% (10.31M against 14.74M) while every existing test stays
 *   green, because main transcripts show 7,508 duplicate ids with ZERO divergent
 *   usage. That is why this is a separate extractor rather than a reuse of the
 *   main parser: the main path's rule is exact for its own data and must not
 *   change, and it is silently wrong for this data.
 *
 * The rule is the one documented in `docs/code-review-fanout-audit.md` section 2.
 *
 * `ts` is the EARLIEST record of a group and `model` the first non-empty one, so
 * a re-walk of an appended file reproduces the same row byte for byte (the
 * indexer re-walks from the start on every signature change, and the ledger
 * upsert must be idempotent).
 *
 * Streamed, never read whole: peak is the distinct-message-id map, not the file.
 * Resolves `ok: false` when the file could not be read through to the end, so
 * the caller can retry instead of recording a partial walk as complete.
 */
async function parseSubagentFile(
  filePath: string,
  subagentId: string,
  meta: SubagentMeta,
): Promise<{ ok: boolean; turns: SubagentUsageTurn[]; spawnLinks: SubagentSpawnLink[] }> {
  const byMessageId = new Map<string, FoldedMessage>();
  /** toolUseId -> the message id that emitted it. */
  const spawnToolUseIds = new Map<string, string>();
  let inlineAgentType: string | null = null;

  const readWholeFile = await streamJsonlRecords(filePath, (raw) => {
    if (raw.type !== 'assistant') return;
    const message = raw.message;
    if (!isRecord(message)) return;
    const messageId = typeof message.id === 'string' ? message.id : null;
    if (!messageId) return;
    const model = typeof message.model === 'string' && message.model.length > 0 ? message.model : null;
    // Claude writes synthetic assistant entries for API-error notices. They
    // carry all-zero usage and a UUID-shaped message id rather than a `msg_`
    // one, so they are neither real spend nor a well-formed key. Skipped for
    // the same reason `session-history-parser.ts` skips them.
    if (model === SYNTHETIC_MODEL) return;

    // Spawn links are collected ABOVE the usage filter below, and above the
    // all-zero-group skip further down, on purpose. A depth-2 subagent names its
    // parent by the tool-use id of the `Task` call that created it; if that call
    // rode a message the ledger drops, the link is never written and a re-walk
    // drops it identically, so the whole subtree beneath it becomes permanently
    // unattributable. Tokens can be absent and recovered later. This cannot.
    collectSpawnToolUseIds(message.content, messageId, spawnToolUseIds);

    const usage = message.usage;
    if (!isRecord(usage)) return;

    // Fallback for a missing/corrupt sidecar: every record names its own
    // subagent type inline.
    if (!inlineAgentType && typeof raw.attributionAgent === 'string' && raw.attributionAgent.length > 0) {
      inlineAgentType = raw.attributionAgent;
    }

    const timestamp = typeof raw.timestamp === 'string' ? Date.parse(raw.timestamp) : NaN;
    const tsMs = Number.isFinite(timestamp) ? timestamp : null;

    const previous = byMessageId.get(messageId);
    if (!previous) {
      byMessageId.set(messageId, {
        inputTokens: numberOrZero(usage.input_tokens),
        outputTokens: numberOrZero(usage.output_tokens),
        cacheCreationInputTokens: numberOrZero(usage.cache_creation_input_tokens),
        cacheReadInputTokens: numberOrZero(usage.cache_read_input_tokens),
        tsMs,
        model,
      });
      return;
    }
    previous.inputTokens = Math.max(previous.inputTokens, numberOrZero(usage.input_tokens));
    previous.outputTokens = Math.max(previous.outputTokens, numberOrZero(usage.output_tokens));
    previous.cacheCreationInputTokens = Math.max(
      previous.cacheCreationInputTokens,
      numberOrZero(usage.cache_creation_input_tokens),
    );
    previous.cacheReadInputTokens = Math.max(
      previous.cacheReadInputTokens,
      numberOrZero(usage.cache_read_input_tokens),
    );
    if (previous.tsMs === null || (tsMs !== null && tsMs < previous.tsMs)) previous.tsMs = tsMs;
    if (previous.model === null) previous.model = model;
  });

  const agentType = meta.agentType ?? inlineAgentType;
  const turns: SubagentUsageTurn[] = [];
  for (const [messageId, folded] of byMessageId) {
    // A group with nothing on any of the four counts is not spend; writing it
    // would only add empty rows, matching the main ledger's "turns without usage
    // produce no row" contract.
    if (
      folded.inputTokens === 0 &&
      folded.outputTokens === 0 &&
      folded.cacheCreationInputTokens === 0 &&
      folded.cacheReadInputTokens === 0
    ) {
      continue;
    }
    turns.push({
      // Stable across re-walks (the file is append-only, and the fold is
      // order-independent) and structurally disjoint from the main path's keys,
      // which are the JSONL records' own uuids. The prefix also makes a subagent
      // row identifiable in the raw table.
      turnUuid: `sub:${subagentId}:${messageId}`,
      subagentId,
      agentType,
      spawnDepth: meta.spawnDepth,
      parentToolUseId: meta.parentToolUseId,
      ts: folded.tsMs,
      model: folded.model,
      usage: {
        inputTokens: folded.inputTokens,
        outputTokens: folded.outputTokens,
        cacheCreationInputTokens: folded.cacheCreationInputTokens,
        cacheReadInputTokens: folded.cacheReadInputTokens,
      },
    });
  }
  // Built from the same `sub:<subagentId>:<messageId>` key the turns use, so a
  // link resolves to a real ledger row whenever that message produced one, and
  // resolves to nothing (rather than to a wrong row) when it did not.
  const spawnLinks: SubagentSpawnLink[] = [];
  for (const [toolUseId, messageId] of spawnToolUseIds) {
    spawnLinks.push({ toolUseId, turnUuid: `sub:${subagentId}:${messageId}` });
  }
  return { ok: readWholeFile, turns, spawnLinks };
}

/**
 * Parse every subagent transcript of one Claude session into ledger-ready turns.
 *
 * `complete` is false when ANY file could not be read through to the end. Rows
 * are idempotent by `turnUuid`, so a later walk completes them; the caller uses
 * this to avoid marking a partial walk as indexed (which would mean it never
 * retries). `directoryPresent` is false when the directory is gone, which is
 * what the agent pruning its transcripts looks like and is recorded as a
 * coverage gap rather than a quiet period.
 *
 * Depth-2 subagents live flat in the same directory as depth-1 ones (measured:
 * 2,238 at depth 1, 50 at depth 2, no nested directories), so there is no
 * recursion here; `spawnDepth` carries the nesting.
 */
export async function parseClaudeSubagentUsage(
  agentSessionId: string,
  cwd: string,
): Promise<{
  directoryPresent: boolean;
  complete: boolean;
  sourcePath: string;
  turns: SubagentUsageTurn[];
  spawnLinks: SubagentSpawnLink[];
}> {
  const directory = locateClaudeSubagentDir(agentSessionId, cwd);
  let entries: string[];
  try {
    entries = fs.readdirSync(directory);
  } catch {
    return { directoryPresent: false, complete: true, sourcePath: directory, turns: [], spawnLinks: [] };
  }

  const turns: SubagentUsageTurn[] = [];
  const spawnLinks: SubagentSpawnLink[] = [];
  let complete = true;
  for (const entry of entries) {
    if (!entry.endsWith('.jsonl')) continue;
    const subagentId = entry.slice(0, -'.jsonl'.length);
    const meta = readSubagentMeta(path.join(directory, `${subagentId}.meta.json`));
    const parsed = await parseSubagentFile(path.join(directory, entry), subagentId, meta);
    if (!parsed.ok) complete = false;
    turns.push(...parsed.turns);
    spawnLinks.push(...parsed.spawnLinks);
  }
  return { directoryPresent: true, complete, sourcePath: directory, turns, spawnLinks };
}
