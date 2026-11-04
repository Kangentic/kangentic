import fs from 'node:fs';
import path from 'node:path';
import { streamJsonlRecords } from '../../shared/history-scan';
import { hostPathForTarget, type CliPlace } from '../../shared/cli-target';
import type { ParsedSubagentUsage, SubagentTranscriptSignature, SubagentUsageTurn } from '../../agent-adapter';
import { geminiChatFilePattern, geminiChatsDir } from './session-history-parser';
import { locateGeminiTranscriptFile, turnUsageFromTokens } from './transcript-parser';

/**
 * Gemini CLI's subagent chats, for the turn-usage ledger.
 *
 * At v0.66.0 a subagent records its own chat file, `kind: 'subagent'` in its
 * header, nested under its parent session's id: `chats/<parent id>/<subagent
 * id>.jsonl`, both ids passed through `sanitizeFilenamePart` (anything outside
 * `[a-zA-Z0-9_-]` becomes `_`, which leaves a UUID as it is). Its replies carry
 * `tokens` as the main session's do. Source:
 * https://github.com/google-gemini/gemini-cli/blob/v0.66.0/packages/core/src/services/chatRecordingService.ts
 *
 * Nothing in the file names the subagent's type or the call that started it,
 * so a turn's `agentType` and `parentToolUseId` are null and there are no
 * spawn links. A file directly in the parent's folder is the parent's own
 * subagent, so its depth is 1; a subagent's own subagents nest under its id,
 * outside this folder, and are not read.
 *
 * Built from the CLI's source, not yet read off a real subagent run.
 */

/** Gemini's `sanitizeFilenamePart` (fileUtils.ts at v0.66.0). */
function sanitizeFilenamePart(part: string): string {
  return part.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * The folder holding a session's subagent chats: beside its own chat file.
 * The reported path decides where that is when it names this session, since
 * the agent wrote it; else the file Kangentic's reader finds; else the chats
 * folder the cwd maps to.
 */
export function geminiSubagentDirectory(
  agentSessionId: string,
  cwd: string,
  place: CliPlace | null,
  reportedPath?: string | null,
): string {
  const folderName = sanitizeFilenamePart(agentSessionId);
  if (reportedPath) {
    const onHost = hostPathForTarget(reportedPath, place);
    if (path.isAbsolute(onHost) && geminiChatFilePattern(agentSessionId).test(path.basename(onHost))) {
      return path.join(path.dirname(onHost), folderName);
    }
  }
  const mainFile = locateGeminiTranscriptFile(agentSessionId, cwd, place);
  return path.join(mainFile ? path.dirname(mainFile) : geminiChatsDir(cwd, place), folderName);
}

function subagentFiles(directory: string): string[] | null {
  let names: string[];
  try {
    names = fs.readdirSync(directory);
  } catch {
    return null;
  }
  return names.filter((name) => name.endsWith('.jsonl')).map((name) => path.join(directory, name));
}

/**
 * Count, total size and newest write of the session's subagent chats, without
 * parsing them. Null when the folder is missing or holds none.
 */
export function statGeminiSubagentTranscripts(
  agentSessionId: string,
  cwd: string,
  place: CliPlace | null,
  reportedPath?: string | null,
): SubagentTranscriptSignature | null {
  const files = subagentFiles(geminiSubagentDirectory(agentSessionId, cwd, place, reportedPath));
  if (!files || files.length === 0) return null;
  let fileCount = 0;
  let totalSize = 0;
  let maxMtimeMs = 0;
  for (const file of files) {
    try {
      const stat = fs.statSync(file);
      fileCount += 1;
      totalSize += stat.size;
      maxMtimeMs = Math.max(maxMtimeMs, stat.mtimeMs);
    } catch {
      // Removed between the listing and the stat.
    }
  }
  return fileCount > 0 ? { fileCount, totalSize, maxMtimeMs } : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Each subagent reply's tokens as a ledger turn. A reply appended again under
 * its id counts once, its last tokens winning. A reply whose counts are all
 * zero adds no row. `$rewindTo` and `$patch` records are not applied: a
 * rewound or removed reply was still billed, as in transcript-usage.ts.
 * Never throws.
 */
export async function parseGeminiSubagentUsage(
  agentSessionId: string,
  cwd: string,
  place: CliPlace | null,
  reportedPath?: string | null,
): Promise<ParsedSubagentUsage> {
  const directory = geminiSubagentDirectory(agentSessionId, cwd, place, reportedPath);
  const files = subagentFiles(directory);
  if (files === null) return { directoryPresent: false, complete: true, sourcePath: directory, turns: [], spawnLinks: [] };

  const turns: SubagentUsageTurn[] = [];
  let complete = true;
  for (const file of files) {
    let subagentId = path.basename(file, '.jsonl');
    // Only the fields the ledger reads, so a reply's content and tool results
    // are not held for the whole file.
    const replies = new Map<string, Pick<Record<string, unknown>, 'tokens' | 'timestamp' | 'model'>>();
    const take = (message: unknown, fallbackKey: string): void => {
      if (!isRecord(message) || message.type !== 'gemini') return;
      const key = typeof message.id === 'string' && message.id.length > 0 ? message.id : fallbackKey;
      replies.set(key, { tokens: message.tokens, timestamp: message.timestamp, model: message.model });
    };
    const readWhole = await streamJsonlRecords(file, (record, lineIndex) => {
      if (typeof record.sessionId === 'string' && typeof record.projectHash === 'string') {
        subagentId = record.sessionId;
        return;
      }
      const seeded = isRecord(record.$set) ? record.$set.messages : undefined;
      if (Array.isArray(seeded)) {
        seeded.forEach((message, index) => take(message, `${lineIndex}.${index}`));
        return;
      }
      take(record, `${lineIndex}`);
    });
    if (!readWhole) complete = false;

    for (const [key, message] of replies) {
      const usage = turnUsageFromTokens(message.tokens);
      if (!usage) continue;
      if (usage.inputTokens + usage.outputTokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens === 0) continue;
      const timeMs = typeof message.timestamp === 'string' ? Date.parse(message.timestamp) : Number.NaN;
      turns.push({
        // Prefixed with the subagent's id, so it never meets a main-thread uuid.
        turnUuid: `${subagentId}:${key}`,
        subagentId,
        agentType: null,
        spawnDepth: 1,
        parentToolUseId: null,
        ts: Number.isFinite(timeMs) ? timeMs : null,
        model: typeof message.model === 'string' && message.model.length > 0 ? message.model : null,
        usage,
      });
    }
  }
  return { directoryPresent: true, complete, sourcePath: directory, turns, spawnLinks: [] };
}
