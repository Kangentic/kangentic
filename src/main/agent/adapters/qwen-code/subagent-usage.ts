import fs from 'node:fs';
import path from 'node:path';
import { streamJsonlRecords } from '../../shared/history-scan';
import type { ParsedSubagentUsage, SubagentSpawnLink, SubagentTranscriptSignature, SubagentUsageTurn } from '../../agent-adapter';
import type { CliPlace } from '../../shared/cli-target';
import { qwenProjectDir } from './session-history-parser';
import { qwenTurnUsage } from './transcript-parser';
import { QWEN_SUBAGENT_LAUNCH_TOOLS } from './hook-manager';

/**
 * Qwen Code writes each subagent's conversation to its own transcript, beside
 * the session's chats
 * (https://github.com/QwenLM/qwen-code/blob/v0.26.6/packages/core/src/agents/agent-transcript.ts):
 *
 *   <runtime>/projects/<slug>/subagents/<sessionId>/agent-<id>.jsonl
 *   <runtime>/projects/<slug>/subagents/<sessionId>/agent-<id>.meta.json
 *   <runtime>/projects/<slug>/subagents/<sessionId>/agent-<id>.jsonl.stream
 *
 * The `.jsonl` is ChatRecord-shaped. Each assistant record has its own `uuid`,
 * a `timestamp`, `message.parts` (tool calls as `functionCall` parts) and, on a
 * record that closes a model round, `usageMetadata`. The model is not on the
 * record: it is the sidecar's `model`. The sidecar also holds `agentId`,
 * `agentType`, `toolUseId` (the parent's call that launched it),
 * `parentAgentId` (null at the top level) and `depth`. The `.stream` file is
 * transient live text the writer removes, so it is never read or signed.
 *
 * The `agent` tool records its own `callId` as `toolUseId`
 * (https://github.com/QwenLM/qwen-code/blob/v0.26.6/packages/core/src/tools/agent/agent.ts),
 * and `callId` is the model's `functionCall.id` when the provider gives one
 * (`handlePendingFunctionCall` in
 * https://github.com/QwenLM/qwen-code/blob/v0.26.6/packages/core/src/core/turn.ts),
 * so the sidecar, the chat's `functionCall` and the spawn links name one call.
 * The hooks' `tool_use_id` is a different, synthetic id and is not used here.
 *
 * In the parent's chat, the `agent` tool's result has its tool calls stripped,
 * so these files are the only record of a subagent's spend. Built from Qwen's
 * source. The sidecar keys read here and the transcript's `usageMetadata` and
 * `functionCall { id }` fields match a real capture, but no real sample is
 * replayed in the tests yet.
 */

/** The tools that start a subagent (`QWEN_SUBAGENT_LAUNCH_TOOLS`). */
const SPAWN_TOOLS: ReadonlySet<string> = new Set(QWEN_SUBAGENT_LAUNCH_TOOLS);

/** `<projectDir>/subagents/<sessionId>`, the session's subagent folder. */
export function qwenSubagentDir(agentSessionId: string, cwd: string, place: CliPlace | null = null): string {
  return path.join(qwenProjectDir(cwd, place), 'subagents', agentSessionId);
}

/**
 * Staleness signature over the session's `agent-*.jsonl` files, without
 * parsing them. Null when the folder does not exist (the session never fanned
 * out, or it was pruned).
 */
export function statQwenSubagentDir(directory: string): SubagentTranscriptSignature | null {
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

interface QwenSubagentMeta {
  agentId: string | null;
  agentType: string | null;
  parentToolUseId: string | null;
  parentAgentId: string | null;
  depth: number | null;
  model: string | null;
}

/** A sidecar that is missing or unreadable. */
const EMPTY_META: QwenSubagentMeta = { agentId: null, agentType: null, parentToolUseId: null, parentAgentId: null, depth: null, model: null };

/** Read `agent-<id>.meta.json`. A missing or corrupt sidecar degrades to nulls, never to dropped tokens. */
function readMeta(metaPath: string): QwenSubagentMeta {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  } catch {
    return EMPTY_META;
  }
  if (!isRecord(raw)) return EMPTY_META;
  return {
    agentId: nonEmptyString(raw.agentId),
    agentType: nonEmptyString(raw.agentType),
    parentToolUseId: nonEmptyString(raw.toolUseId),
    parentAgentId: nonEmptyString(raw.parentAgentId),
    depth: typeof raw.depth === 'number' && Number.isFinite(raw.depth) ? raw.depth : null,
    model: nonEmptyString(raw.model),
  };
}

/**
 * Nesting depth, 1 for a subagent the session itself launched. Qwen's own
 * `depth` is "normalized on restore and never trusted raw", so the
 * `parentAgentId` chain decides when it resolves through the folder's
 * sidecars, and the recorded depth stands in only when it does not.
 *
 * The recorded depth counts from 0: a real 0.25.2 sidecar of a subagent the
 * session launched itself holds `"depth": 0` and `"parentAgentId": null`. The
 * ledger's `spawnDepth` counts from 1, as Claude's sidecar does, so the
 * fallback adds one.
 */
function depthOf(meta: QwenSubagentMeta, metaById: Map<string, QwenSubagentMeta>): number | null {
  const recordedDepth = meta.depth === null ? null : meta.depth + 1;
  let depth = 1;
  let parentId = meta.parentAgentId;
  const seen = new Set<string>();
  while (parentId) {
    if (seen.has(parentId)) return recordedDepth;
    seen.add(parentId);
    const parent = metaById.get(parentId);
    if (!parent) return recordedDepth;
    depth += 1;
    parentId = parent.parentAgentId;
  }
  return depth;
}

/** Parse one subagent transcript into ledger turns and the spawning calls it made. */
async function parseSubagentFile(
  filePath: string,
  subagentId: string,
  meta: QwenSubagentMeta,
  spawnDepth: number | null,
): Promise<{ ok: boolean; turns: SubagentUsageTurn[]; spawnLinks: SubagentSpawnLink[] }> {
  const turns: SubagentUsageTurn[] = [];
  const spawnLinks: SubagentSpawnLink[] = [];
  const seenRecords = new Set<string>();
  const readWholeFile = await streamJsonlRecords(filePath, (raw, physicalLineIndex) => {
    if (raw.type !== 'assistant') return;
    // Every record has its own uuid; the line index stands in for a record
    // that lacks one, which stays stable because the file is append-only.
    const recordId = nonEmptyString(raw.uuid) ?? `line-${physicalLineIndex}`;
    if (seenRecords.has(recordId)) return;
    seenRecords.add(recordId);
    const turnUuid = `sub:${subagentId}:${recordId}`;

    // Links before the usage check: a spawning call rides a tool-call record,
    // which carries no usage, and a lost link leaves its child unattributable.
    const message = raw.message;
    if (isRecord(message) && Array.isArray(message.parts)) {
      for (const part of message.parts) {
        if (!isRecord(part) || !isRecord(part.functionCall)) continue;
        const call = part.functionCall;
        const callId = nonEmptyString(call.id);
        if (callId && typeof call.name === 'string' && SPAWN_TOOLS.has(call.name)) {
          spawnLinks.push({ toolUseId: callId, turnUuid });
        }
      }
    }

    const usage = qwenTurnUsage(raw.usageMetadata);
    if (!usage) return;
    const timestamp = typeof raw.timestamp === 'string' ? Date.parse(raw.timestamp) : Number.NaN;
    turns.push({
      turnUuid,
      subagentId,
      agentType: meta.agentType,
      spawnDepth,
      parentToolUseId: meta.parentToolUseId,
      ts: Number.isFinite(timestamp) ? timestamp : null,
      model: nonEmptyString(raw.model) ?? meta.model,
      usage,
    });
  });
  return { ok: readWholeFile, turns, spawnLinks };
}

/**
 * Every subagent's tokens for one Qwen session, one ledger turn per assistant
 * record with usage (each is one API response, so no fold is needed).
 * `complete` is false when any file could not be read to the end, so the
 * caller retries instead of marking a partial walk indexed.
 */
export async function parseQwenSubagentUsage(
  agentSessionId: string,
  cwd: string,
  place: CliPlace | null = null,
): Promise<ParsedSubagentUsage> {
  const directory = qwenSubagentDir(agentSessionId, cwd, place);
  let entries: string[];
  try {
    entries = fs.readdirSync(directory);
  } catch {
    return { directoryPresent: false, complete: true, sourcePath: directory, turns: [], spawnLinks: [] };
  }

  const transcripts = entries.filter((entry) => entry.startsWith('agent-') && entry.endsWith('.jsonl'));
  const metaByFile = new Map<string, QwenSubagentMeta>();
  const metaById = new Map<string, QwenSubagentMeta>();
  for (const transcript of transcripts) {
    const meta = readMeta(path.join(directory, `${transcript.slice(0, -'.jsonl'.length)}.meta.json`));
    metaByFile.set(transcript, meta);
    if (meta.agentId) metaById.set(meta.agentId, meta);
  }

  let complete = true;
  const turns: SubagentUsageTurn[] = [];
  const spawnLinks: SubagentSpawnLink[] = [];
  for (const transcript of transcripts) {
    const meta = metaByFile.get(transcript) ?? EMPTY_META;
    // The sidecar's id, unsanitized; the file name's when the sidecar is gone.
    const subagentId = meta.agentId ?? transcript.slice('agent-'.length, -'.jsonl'.length);
    const parsed = await parseSubagentFile(path.join(directory, transcript), subagentId, meta, depthOf(meta, metaById));
    if (!parsed.ok) complete = false;
    turns.push(...parsed.turns);
    spawnLinks.push(...parsed.spawnLinks);
  }
  return { directoryPresent: true, complete, sourcePath: directory, turns, spawnLinks };
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
