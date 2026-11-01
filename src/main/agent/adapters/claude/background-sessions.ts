import path from 'node:path';
import { runClaudeCli } from './cli-run';
import { findClaudeTranscriptFile } from './transcript-locator';
import { listMostRecentFiles, parseJsonlRecords, readHeadBytes, readTailBytes } from '../../shared/history-scan';
import { placeFromStored, type CliPlace } from '../../shared/cli-target';
import type { StoredCliTarget } from '../../../../shared/types';

/**
 * Claude Code's own background sessions (`/bg` or `/background` in a terminal,
 * `claude --bg`), which its supervisor runs outside the terminal that started
 * them.
 *
 * A Kangentic task's conversation moves into one when the user runs `/bg` in
 * the task's terminal. Measured on Claude Code 2.1.316 (2026-10-31): the
 * conversation continues under a NEW id (SessionStart `fork`), the task's PTY
 * keeps only a `claude agents` client, and the background session outlives
 * that client, so suspending or ending the task's PTY leaves it working in the
 * task's folder. `claude agents --json` lists it (`kind: "background"`, the
 * full `sessionId`, a `pid` while its process is alive) in about 220 ms, and
 * `claude stop <id>` ends it in about 450 ms through Claude's own exit: its
 * SessionEnd hook ran, its process and its pty host were gone, and its
 * conversation was kept.
 */

const LIST_TIMEOUT_MS = 5_000;
const STOP_TIMEOUT_MS = 10_000;
/**
 * Everything one stop may take, listing, stopping and waiting together, so a
 * supervisor that does not answer holds a resume or a Done move for at most
 * this long. Measured: about 0.9 s for the whole round.
 */
const STOP_BUDGET_MS = 10_000;
const STOP_SETTLE_POLL_MS = 250;

/**
 * A background session's short id, the only value Kangentic passes to `claude
 * stop`. It starts with a letter or digit, so the CLI never reads it as a flag.
 */
const SHORT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

interface BackgroundSessionEntry {
  id: string;
  sessionId: string;
  alive: boolean;
}

/** The background sessions `claude agents --json` lists. Throws when the CLI fails or prints something else. */
async function listBackgroundSessions(cliPath: string, timeoutMs: number): Promise<BackgroundSessionEntry[]> {
  const stdout = await runClaudeCli(cliPath, ['agents', '--json'], timeoutMs);
  const parsed: unknown = JSON.parse(stdout);
  if (!Array.isArray(parsed)) throw new Error('claude agents --json did not print a list');
  const entries: BackgroundSessionEntry[] = [];
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) continue;
    const { kind, id, sessionId, pid } = item as { kind?: unknown; id?: unknown; sessionId?: unknown; pid?: unknown };
    // Interactive sessions are terminals, a task's own PTY among them.
    if (kind !== 'background' || typeof id !== 'string' || typeof sessionId !== 'string') continue;
    // `pid` is listed only while the session's process is alive.
    entries.push({ id, sessionId, alive: typeof pid === 'number' });
  }
  return entries;
}

/**
 * Stop each live background session holding `agentSessionId`, matched by the
 * full session id only: the listing covers every session on the machine, of
 * every project. Then wait, within the budget, for the listing to show it gone.
 *
 * Resolves true once `claude stop` ran for a session holding the conversation,
 * whether or not the wait saw it end (a listing that fails or still shows it
 * alive is logged). Resolves false when nothing held it or the stop never ran.
 * Both callers go on either way. Never throws.
 */
export async function stopClaudeBackgroundSession(options: { agentSessionId: string; cliPath: string }): Promise<boolean> {
  const { agentSessionId, cliPath } = options;
  const deadline = Date.now() + STOP_BUDGET_MS;
  /** A step's timeout: its own cap, and never past the whole stop's budget. */
  const within = (capMs: number): number => Math.max(1, Math.min(capMs, deadline - Date.now()));
  let stopRan = false;
  try {
    const holding = (await listBackgroundSessions(cliPath, within(LIST_TIMEOUT_MS)))
      .filter((entry) => entry.alive && entry.sessionId === agentSessionId && SHORT_ID.test(entry.id));
    if (holding.length === 0) return false;
    for (const entry of holding) {
      await runClaudeCli(cliPath, ['stop', entry.id], within(STOP_TIMEOUT_MS));
      stopRan = true;
      console.log(`[claude] stopped background session ${entry.id} holding conversation ${agentSessionId.slice(0, 8)}`);
    }
    const stoppedIds = new Set(holding.map((entry) => entry.id));
    while (Date.now() < deadline) {
      const stillAlive = (await listBackgroundSessions(cliPath, within(LIST_TIMEOUT_MS))).some((entry) => entry.alive && stoppedIds.has(entry.id));
      if (!stillAlive) return true;
      await new Promise((resolve) => setTimeout(resolve, STOP_SETTLE_POLL_MS));
    }
    console.warn(`[claude] background session for ${agentSessionId.slice(0, 8)} still listed alive at the end of the stop's ${STOP_BUDGET_MS} ms`);
    return true;
  } catch (error) {
    const reason = error instanceof Error ? error.message.split('\n')[0] : String(error);
    console.warn(stopRan
      ? `[claude] stopped a background session for ${agentSessionId.slice(0, 8)} but could not confirm it ended: ${reason}`
      : `[claude] could not stop a background session for ${agentSessionId.slice(0, 8)}: ${reason}`);
    return stopRan;
  }
}

/** Bytes read from the head of a transcript to tell whether it holds a turn. */
const TURN_SCAN_HEAD_BYTES = 64 * 1024;
/** Bytes read from the tail of a candidate transcript for its `continued-in` record, the last one it writes. */
const CONTINUED_IN_TAIL_BYTES = 16 * 1024;
/** Most recent transcripts in the folder searched for the conversation a fork continued. */
const PREDECESSOR_CANDIDATES = 50;
/** A fork of a fork: how many links back the search follows. */
const MAX_PREDECESSOR_HOPS = 4;

async function holdsATurn(transcriptPath: string): Promise<boolean> {
  const head = await readHeadBytes(transcriptPath, TURN_SCAN_HEAD_BYTES);
  const records = parseJsonlRecords(head, head.length >= TURN_SCAN_HEAD_BYTES);
  return records.some((record) => record.type === 'user' || record.type === 'assistant');
}

/** Does this transcript end by continuing in `agentSessionId` (its `continued-in` record)? */
async function continuesIn(transcriptPath: string, agentSessionId: string): Promise<boolean> {
  const tail = await readTailBytes(transcriptPath, CONTINUED_IN_TAIL_BYTES);
  return parseJsonlRecords(tail, false)
    .some((record) => record.type === 'continued-in' && record.continuedInSessionId === agentSessionId);
}

type TranscriptListing = Awaited<ReturnType<typeof listMostRecentFiles>>;

/**
 * The newest transcripts in a folder, listed once per folder for the whole
 * predecessor search: a listing stats every transcript in the folder, and a
 * chain of forks would otherwise list the same folder at every hop.
 */
function transcriptListingCache(): (folder: string) => Promise<TranscriptListing> {
  const listings = new Map<string, Promise<TranscriptListing>>();
  return (folder) => {
    let listing = listings.get(folder);
    if (!listing) {
      // One more than the candidates, so leaving out the fork's own file still leaves enough.
      listing = listMostRecentFiles(folder, (name) => name.endsWith('.jsonl'), PREDECESSOR_CANDIDATES + 1);
      listings.set(folder, listing);
    }
    return listing;
  };
}

/** The id of the transcript in the same folder whose `continued-in` record names `agentSessionId`, or null. */
async function findContinuedFrom(
  transcriptPath: string,
  agentSessionId: string,
  listFolder: (folder: string) => Promise<TranscriptListing>,
): Promise<string | null> {
  const ownName = path.basename(transcriptPath);
  const candidates = (await listFolder(path.dirname(transcriptPath)))
    .filter((candidate) => path.basename(candidate.fullPath) !== ownName)
    .slice(0, PREDECESSOR_CANDIDATES);
  for (const candidate of candidates) {
    if (await continuesIn(candidate.fullPath, agentSessionId)) return path.basename(candidate.fullPath, '.jsonl');
  }
  return null;
}

/**
 * Did the terminal's conversation `fromAgentSessionId` move into the background
 * session `toAgentSessionId` (`statusFile.confirmsBackgroundMove`)? `/bg` moves
 * it and ends the old transcript with a `continued-in` record naming the new
 * id; `/fork` starts a copy beside it and writes no such record, and the two
 * SessionStart hooks are identical (`source: fork`, the same fields). Measured
 * on 2.1.316: on a live task the record landed about 2 s before the background
 * session's hook. Never throws; any doubt is false.
 */
export async function claudeConfirmsBackgroundMove(options: {
  cwd: string;
  fromAgentSessionId: string;
  toAgentSessionId: string;
  cliTarget?: StoredCliTarget | null;
  transcriptPath?: string | null;
}): Promise<boolean> {
  try {
    const transcriptPath = await findClaudeTranscriptFile({
      agentSessionId: options.fromAgentSessionId,
      cwd: options.cwd,
      place: placeFromStored(options.cliTarget),
      reportedPath: options.transcriptPath ?? null,
    });
    return transcriptPath !== null && await continuesIn(transcriptPath, options.toAgentSessionId);
  } catch {
    return false;
  }
}

/**
 * The id a `--resume` reaches the conversation `agentSessionId` by
 * (`resolveResumableSessionId`).
 *
 * Moving a conversation into a background session continues it under a new id,
 * and that id's transcript holds only its title and name until the session's
 * first turn. Measured on 2.1.316: `/bg`, then `claude stop` before a turn,
 * left `--resume <new id>` answering "No conversation found", while
 * `--resume <old id>` resumed the whole conversation. The old transcript's
 * last record, `continued-in`, names the new id, which is how it is found.
 *
 * Anything unproven returns `agentSessionId`: a transcript that is missing
 * (the resume check decides that case), one with a turn, or a fork whose
 * predecessor is not in its folder.
 */
export async function resolveClaudeResumableSessionId(options: {
  agentSessionId: string;
  cwd: string;
  place?: CliPlace | null;
}): Promise<string> {
  let resumable = options.agentSessionId;
  const listFolder = transcriptListingCache();
  try {
    for (let hop = 0; hop < MAX_PREDECESSOR_HOPS; hop++) {
      const transcriptPath = await findClaudeTranscriptFile({ agentSessionId: resumable, cwd: options.cwd, place: options.place ?? null });
      if (!transcriptPath || await holdsATurn(transcriptPath)) return resumable;
      const predecessor = await findContinuedFrom(transcriptPath, resumable, listFolder);
      if (!predecessor) return resumable;
      resumable = predecessor;
    }
    return resumable;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`[claude] could not check whether ${options.agentSessionId.slice(0, 8)} is resumable: ${reason}`);
    return options.agentSessionId;
  }
}
