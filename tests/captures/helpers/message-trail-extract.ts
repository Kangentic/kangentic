/**
 * Derive a recording's agent message trail from the transcript the agent wrote during its capture.
 *
 * The board card's Card Preview default is `agent-latest-message`, so a default install prints the
 * agent's newest message where the description used to be. That text is not in a recording's
 * terminal bytes in any recoverable form: the stream carries TUI chrome, and parsing prose back out
 * of it is the fragile path `.claude/rules/web-demo-parity.md` exists to avoid. The agent's own
 * transcript has it, already structured, and main reads exactly the same file to build the real
 * trail (`src/main/agent/message-trail-tracker.ts`).
 *
 * So this module imports the real parsers and the real collapse function rather than restating
 * either. A change to what counts as decoration in `collapseToPreviewText` reaches the demo and the
 * desktop together, which is the whole point.
 *
 * Timestamps map onto the recording's own clock. `capturedAt` is the END of a capture, so the run
 * started at `capturedAt - durationMs` and an entry's offset is `entryTs - start`. That is the same
 * clock `peekTimeline` and `frameTimeline` use, so the card and the Monitor peek move together.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { TranscriptEntry } from '../../../src/shared/types';
import { assistantMessagePreviews } from '../../../src/main/agent/shared/message-preview';
import { MESSAGE_TRAIL_ENTRY_MAX_CHARS } from '../../../src/main/agent/message-trail-tracker';
import { claudeProjectSlug, parseClaudeTranscript } from '../../../src/main/agent/adapters/claude/transcript-parser';
import { parseCodexTranscript } from '../../../src/main/agent/adapters/codex/transcript-parser';
import { parseGeminiTranscript } from '../../../src/main/agent/adapters/gemini/transcript-parser';
import { parseOpenCodeTranscriptAtPath } from '../../../src/main/agent/adapters/opencode/transcript-parser';
import { loadBetterSqlite3, openCodeDbPath } from '../../../src/main/agent/adapters/opencode/session-history-parser';

/** One line of a recording's trail, on the recording's own clock. */
export interface RecordedMessageTrailEntry {
  /** Offset in ms from the recording's first byte, the same clock as `peekTimeline`. */
  t: number;
  /** The transcript entry's own id, which is what the card uses as a React key. */
  uuid: string;
  /** The transcript entry's wall-clock ms, kept because `AssistantMessageTrailEntry` carries it. */
  ts: number;
  text: string;
}

/** The recording fields this derivation needs. */
export interface RecordingFacts {
  agent: string;
  prompt: string;
  capturedAt: string;
  durationMs: number;
}

/**
 * Agents whose sessions carry no trail, with the reason.
 *
 * These are not gaps to be closed here. `cursor-adapter.ts` and `copilot-adapter.ts` both return
 * null from `locateSessionHistoryFile` and implement no `parseTranscript`, so a real install shows
 * these agents' cards their description too. Seeding a trail for them would be the divergence.
 */
export const AGENTS_WITHOUT_TRANSCRIPTS: Readonly<Record<string, string>> = Object.freeze({
  cursor: 'cursor-adapter.ts returns null from locateSessionHistoryFile and has no parseTranscript',
  copilot: 'copilot-adapter.ts returns null from locateSessionHistoryFile and has no parseTranscript',
});

/** Thrown when a transcript cannot be identified. Never guessed at: the caller reports and stops. */
export class TranscriptMatchError extends Error {}

/** How far a transcript's start may sit from the recording's and still be the same run. */
const START_TOLERANCE_MS = 120_000;
/** How much of the prompt has to appear in the first user message for a match to count. */
const PROMPT_MATCH_CHARS = 80;

function normalizeForMatch(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Does this transcript's first user message carry the recording's prompt?
 *
 * Substring rather than equality in both directions: an agent may prepend its own preamble to the
 * first user turn, and several CLIs echo the prompt with the trailing newline stripped.
 */
function promptMatches(firstUserText: string, prompt: string): boolean {
  const haystack = normalizeForMatch(firstUserText);
  const needle = normalizeForMatch(prompt).slice(0, PROMPT_MATCH_CHARS);
  return needle.length > 0 && haystack.includes(needle);
}

function firstUserText(entries: readonly TranscriptEntry[]): string {
  for (const entry of entries) {
    if (entry.kind === 'user' && entry.text.trim().length > 0) return entry.text;
  }
  return '';
}

function firstTimestamp(entries: readonly TranscriptEntry[]): number | null {
  for (const entry of entries) {
    if (entry.ts > 0) return entry.ts;
  }
  return null;
}

interface Candidate {
  sourcePath: string;
  entries: TranscriptEntry[];
}

/**
 * Pick the one candidate that is this recording's run.
 *
 * The prompt has to match, and among the ones that do the nearest start wins. The capture matrix
 * retried several prompts, so same-prompt siblings are normal and the start time is what separates
 * them. Zero matches is an error rather than an empty trail: a silently empty trail is exactly the
 * failure this whole change exists to remove.
 */
function chooseCandidate(candidates: Candidate[], facts: RecordingFacts, startMs: number, where: string): Candidate {
  const matching = candidates.filter((candidate) => promptMatches(firstUserText(candidate.entries), facts.prompt));
  if (matching.length === 0) {
    throw new TranscriptMatchError(
      `no ${facts.agent} transcript in ${where} carries this recording's prompt `
      + `(${candidates.length} candidate(s) read)`,
    );
  }
  let best: Candidate | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of matching) {
    const started = firstTimestamp(candidate.entries);
    if (started === null) continue;
    const distance = Math.abs(started - startMs);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  if (!best || bestDistance > START_TOLERANCE_MS) {
    throw new TranscriptMatchError(
      `${matching.length} ${facts.agent} transcript(s) match the prompt but none starts within `
      + `${START_TOLERANCE_MS / 1000}s of the recording (nearest ${Math.round(bestDistance / 1000)}s off)`,
    );
  }
  return best;
}

function readDirSafely(directory: string): string[] {
  try {
    return fs.readdirSync(directory);
  } catch {
    return [];
  }
}

async function claudeCandidates(cwd: string): Promise<{ candidates: Candidate[]; where: string }> {
  const directory = path.join(os.homedir(), '.claude', 'projects', claudeProjectSlug(cwd));
  const candidates: Candidate[] = [];
  for (const name of readDirSafely(directory)) {
    if (!name.endsWith('.jsonl')) continue;
    const sourcePath = path.join(directory, name);
    candidates.push({ sourcePath, entries: await parseClaudeTranscript(sourcePath) });
  }
  return { candidates, where: directory };
}

async function codexCandidates(startMs: number): Promise<{ candidates: Candidate[]; where: string }> {
  // Codex files itself under sessions/<yyyy>/<mm>/<dd>/rollout-<iso>-<id>.jsonl. Reading only the
  // capture's own day and the one before keeps this to a handful of files instead of the whole
  // archive, and a capture never straddles more than one midnight.
  const root = path.join(os.homedir(), '.codex', 'sessions');
  const days = [new Date(startMs - 86_400_000), new Date(startMs)];
  const candidates: Candidate[] = [];
  const searched: string[] = [];
  for (const day of days) {
    const directory = path.join(
      root,
      String(day.getFullYear()),
      String(day.getMonth() + 1).padStart(2, '0'),
      String(day.getDate()).padStart(2, '0'),
    );
    searched.push(directory);
    for (const name of readDirSafely(directory)) {
      if (!name.endsWith('.jsonl')) continue;
      const sourcePath = path.join(directory, name);
      const sessionId = /-([0-9a-f-]{36})\.jsonl$/i.exec(name)?.[1] ?? name;
      candidates.push({ sourcePath, entries: await parseCodexTranscript(sessionId, sourcePath) });
    }
  }
  return { candidates, where: searched.join(' and ') };
}

async function geminiCandidates(cwd: string): Promise<{ candidates: Candidate[]; where: string }> {
  // Gemini's project directory name is the repo folder, optionally suffixed with a hash of the
  // path, so match on the prefix rather than recomputing the hash.
  const root = path.join(os.homedir(), '.gemini', 'tmp');
  const folder = path.basename(cwd);
  const candidates: Candidate[] = [];
  const searched: string[] = [];
  for (const projectDir of readDirSafely(root)) {
    if (projectDir !== folder && !projectDir.startsWith(`${folder}-`)) continue;
    const directory = path.join(root, projectDir, 'chats');
    searched.push(directory);
    for (const name of readDirSafely(directory)) {
      if (!/\.jsonl?$/.test(name)) continue;
      const sourcePath = path.join(directory, name);
      const sessionId = /-([0-9a-f]{8})\.jsonl?$/i.exec(name)?.[1] ?? name;
      candidates.push({ sourcePath, entries: await parseGeminiTranscript(sessionId, sourcePath) });
    }
  }
  return { candidates, where: searched.join(' and ') || root };
}

interface OpenCodeSessionRow {
  id: string;
  directory: string;
  time_created: number;
}

async function openCodeCandidates(cwd: string, startMs: number): Promise<{ candidates: Candidate[]; where: string }> {
  // OpenCode keeps conversations in SQLite rather than files, so the candidate set comes from the
  // session table: rows whose directory is this capture's cwd, near its start.
  const dbPath = openCodeDbPath();
  if (!fs.existsSync(dbPath)) return { candidates: [], where: dbPath };
  const DatabaseConstructor = loadBetterSqlite3();
  if (!DatabaseConstructor) {
    throw new TranscriptMatchError('better-sqlite3 is unavailable, so the OpenCode database cannot be read');
  }
  const normalized = path.normalize(cwd).replace(/[\\/]+$/, '').toLowerCase();
  const database = new DatabaseConstructor(dbPath, { readonly: true, fileMustExist: true });
  const candidates: Candidate[] = [];
  try {
    // time_created has been seen in both seconds and milliseconds; normalize before comparing.
    const rows = database
      .prepare('SELECT id, directory, time_created FROM session')
      .all() as OpenCodeSessionRow[];
    for (const row of rows) {
      const rowCwd = path.normalize(row.directory ?? '').replace(/[\\/]+$/, '').toLowerCase();
      if (rowCwd !== normalized) continue;
      const created = row.time_created > 1e11 ? row.time_created : row.time_created * 1000;
      if (Math.abs(created - startMs) > START_TOLERANCE_MS) continue;
      candidates.push({ sourcePath: `${dbPath}#${row.id}`, entries: parseOpenCodeTranscriptAtPath(dbPath, row.id) });
    }
  } finally {
    database.close();
  }
  return { candidates, where: dbPath };
}

/**
 * The trail for one recording, oldest first, or `null` when the agent has no transcript at all.
 *
 * `cwd` is the directory the agent ran in during the capture (`~/work/<repo>`, `~/oss/<repo>`).
 * Throws `TranscriptMatchError` when a trail-capable agent's transcript cannot be identified.
 */
export async function extractMessageTrail(
  facts: RecordingFacts,
  cwd: string,
): Promise<RecordedMessageTrailEntry[] | null> {
  if (facts.agent in AGENTS_WITHOUT_TRANSCRIPTS) return null;
  const capturedAtMs = Date.parse(facts.capturedAt);
  if (!Number.isFinite(capturedAtMs)) throw new TranscriptMatchError(`unparseable capturedAt ${facts.capturedAt}`);
  const startMs = capturedAtMs - facts.durationMs;

  let found: { candidates: Candidate[]; where: string };
  switch (facts.agent) {
    case 'claude': found = await claudeCandidates(cwd); break;
    case 'codex': found = await codexCandidates(startMs); break;
    case 'gemini': found = await geminiCandidates(cwd); break;
    case 'opencode': found = await openCodeCandidates(cwd, startMs); break;
    default:
      throw new TranscriptMatchError(
        `no transcript reader wired for agent "${facts.agent}"; add one here or record it in `
        + 'AGENTS_WITHOUT_TRANSCRIPTS with the adapter line that proves it has none',
      );
  }
  const chosen = chooseCandidate(found.candidates, facts, startMs, found.where);
  return buildMessageTrail(chosen.entries, startMs, facts.durationMs);
}

/**
 * Collapse every prose-bearing assistant entry onto the recording's clock.
 *
 * The count is deliberately unbounded here, unlike main's `MESSAGE_TRAIL_MAX_ENTRIES` read: this is
 * the whole timeline, and the consumer keeps the newest few at each moment the way
 * `MessageTrailTracker.merge` does. The per-line cap is main's, shared rather than restated.
 *
 * Entries outside the recording's span are dropped rather than clamped. An agent that kept talking
 * after the capture was cut (stop-after, stop-when) has nothing to show on a clock that already
 * ended, and clamping would stack several lines onto the final millisecond.
 */
export function buildMessageTrail(
  entries: readonly TranscriptEntry[],
  startMs: number,
  durationMs: number,
): RecordedMessageTrailEntry[] {
  const previews = assistantMessagePreviews(entries, {
    count: Number.MAX_SAFE_INTEGER,
    maxChars: MESSAGE_TRAIL_ENTRY_MAX_CHARS,
  });
  const trail: RecordedMessageTrailEntry[] = [];
  for (const preview of previews) {
    const offset = preview.ts - startMs;
    if (offset < 0 || offset > durationMs) continue;
    trail.push({ t: Math.round(offset), uuid: preview.uuid, ts: preview.ts, text: preview.text });
  }
  return trail;
}
