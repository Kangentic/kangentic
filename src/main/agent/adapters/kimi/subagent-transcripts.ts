import fs from 'node:fs';
import path from 'node:path';
import { streamJsonlRecords } from '../../shared/history-scan';
import type { ParsedSubagentUsage, SubagentSpawnLink, SubagentTranscriptSignature, SubagentUsageTurn } from '../../agent-adapter';
import { parseRecordTime } from './wire-parser';

/**
 * A session's subagent transcripts in Kimi Code CLI: each subagent keeps its
 * own `<sessionDir>/agents/<subagentId>/wire.jsonl` beside `agents/main/`
 * (`docs/en/configuration/data-locations.md`, Kimi Code CLI 2.4.1, read
 * 2026-11-03). Its steps end with a `step.end` loop event carrying that step's
 * `usage`, and the main agent's wire records `subagent.spawned` with
 * `subagentName` and `parentToolCallId`
 * (`packages/agent-core-v2/docs/wire-manifest.d.ts`). Built from the source,
 * not yet checked against a real file.
 */
const MAIN_AGENT_FOLDER = 'main';
const WIRE_FILE = 'wire.jsonl';

/** The spawning tool, whose calls are the links a nested subagent resolves through. */
export const KIMI_SUBAGENT_TOOL = 'Agent';

function agentsDirectory(sessionDir: string): string {
  return path.join(sessionDir, 'agents');
}

/** The subagent folders that hold a wire file, or null when `agents/` cannot be read. */
function subagentWireFiles(sessionDir: string): Array<{ subagentId: string; filePath: string; size: number; mtimeMs: number }> | null {
  let folders: string[];
  try {
    folders = fs.readdirSync(agentsDirectory(sessionDir));
  } catch {
    return null;
  }
  const files: Array<{ subagentId: string; filePath: string; size: number; mtimeMs: number }> = [];
  for (const folder of folders) {
    if (folder === MAIN_AGENT_FOLDER) continue;
    const filePath = path.join(agentsDirectory(sessionDir), folder, WIRE_FILE);
    try {
      const stat = fs.statSync(filePath);
      files.push({ subagentId: folder, filePath, size: stat.size, mtimeMs: stat.mtimeMs });
    } catch {
      // A folder with no wire file is no subagent transcript.
    }
  }
  return files;
}

/** Cheap staleness signature for a session's subagent files. Null when it has none. */
export function statKimiSubagentTranscripts(sessionDir: string): SubagentTranscriptSignature | null {
  const files = subagentWireFiles(sessionDir);
  if (!files || files.length === 0) return null;
  return {
    fileCount: files.length,
    totalSize: files.reduce((sum, file) => sum + file.size, 0),
    maxMtimeMs: files.reduce((latest, file) => Math.max(latest, file.mtimeMs), 0),
  };
}

interface SubagentSpawn {
  name: string | null;
  parentToolCallId: string | null;
  depth: number | null;
}

/**
 * What the main agent's wire recorded about each subagent it spawned, and
 * whether the whole file was read.
 */
async function readSpawns(mainWirePath: string): Promise<{ spawns: Map<string, SubagentSpawn>; readWholeFile: boolean }> {
  const spawns = new Map<string, SubagentSpawn>();
  const readWholeFile = await streamJsonlRecords(mainWirePath, (record) => {
    if (record.type !== 'subagent.spawned' || typeof record.subagentId !== 'string') return;
    const parentAgentId = stringField(record.parentAgentId);
    spawns.set(record.subagentId, {
      name: stringField(record.subagentName),
      parentToolCallId: stringField(record.parentToolCallId),
      depth: parentAgentId === null || parentAgentId === MAIN_AGENT_FOLDER ? 1 : null,
    });
  });
  return { spawns, readWholeFile };
}

/**
 * Each subagent's model steps as turns for the usage ledger, one per `step.end`
 * with counts, keyed by the step's own uuid, so a re-walk of an appended file
 * writes the same rows. Spawn links are collected whether or not their step
 * made a row.
 */
export async function parseKimiSubagentUsage(sessionDir: string, mainWirePath: string): Promise<ParsedSubagentUsage> {
  const sourcePath = agentsDirectory(sessionDir);
  const files = subagentWireFiles(sessionDir);
  if (!files || files.length === 0) {
    return { directoryPresent: false, complete: true, sourcePath, turns: [], spawnLinks: [] };
  }
  const { spawns, readWholeFile: readMainWire } = await readSpawns(mainWirePath);
  const turns: SubagentUsageTurn[] = [];
  const spawnLinks: SubagentSpawnLink[] = [];
  // A turn read without its spawn has no parent, so a partial main file is not done.
  let complete = readMainWire;

  for (const { subagentId, filePath } of files) {
    const spawn = spawns.get(subagentId);
    let model: string | null = null;
    const readWholeFile = await streamJsonlRecords(filePath, (record) => {
      if (record.type === 'llm.request' && typeof record.model === 'string') model = record.model;
      if (record.type !== 'context.append_loop_event' || !isRecord(record.event)) return;
      const loopEvent = record.event;
      if (loopEvent.type === 'tool.call' && loopEvent.name === KIMI_SUBAGENT_TOOL) {
        const toolUseId = stringField(loopEvent.toolCallId);
        const stepUuid = stringField(loopEvent.stepUuid);
        if (toolUseId && stepUuid) spawnLinks.push({ toolUseId, turnUuid: `sub:${subagentId}:${stepUuid}` });
        return;
      }
      if (loopEvent.type !== 'step.end' || !isRecord(loopEvent.usage)) return;
      const stepUuid = stringField(loopEvent.uuid);
      if (!stepUuid) return;
      const usage = {
        inputTokens: count(loopEvent.usage.inputOther),
        outputTokens: count(loopEvent.usage.output),
        cacheCreationInputTokens: count(loopEvent.usage.inputCacheCreation),
        cacheReadInputTokens: count(loopEvent.usage.inputCacheRead),
      };
      if (usage.inputTokens + usage.outputTokens + usage.cacheCreationInputTokens + usage.cacheReadInputTokens === 0) return;
      turns.push({
        turnUuid: `sub:${subagentId}:${stepUuid}`,
        subagentId,
        agentType: spawn?.name ?? null,
        spawnDepth: spawn?.depth ?? null,
        parentToolUseId: spawn?.parentToolCallId ?? null,
        ts: typeof record.time === 'number' ? parseRecordTime(record.time) : null,
        model,
        usage,
      });
    });
    if (!readWholeFile) complete = false;
  }
  return { directoryPresent: true, complete, sourcePath, turns, spawnLinks };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}
