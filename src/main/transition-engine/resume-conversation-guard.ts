import fs from 'node:fs';
import path from 'node:path';
import type { AgentAdapter } from '../agent/agent-adapter';
import { isConfirmedMissing } from '../agent/shared/confirmed-missing';
import { hostPathForTarget, isSameCliPlace, placeOfRecord, type CliPlace } from '../agent/shared/cli-target';
import type { SessionRecord, SessionUsage } from '../../shared/types';
import { sessionOutputPaths } from './session-paths';

/**
 * What a `--resume` would find, decided before the spawn.
 *
 * - `never-started`: the conversation never had a turn, so the agent never
 *   wrote it. Start fresh with the spawn's own prompt; there is nothing to lose
 *   and nothing to carry.
 * - `expired`: the conversation had turns and its file is proven gone (Claude
 *   deletes transcripts older than `cleanupPeriodDays`), or it is in the home
 *   of a place the spawn's CLI no longer runs in. Start fresh with a recap of
 *   what the task holds.
 * - `unknown`: anything else. Resume exactly as before.
 */
export type ResumeConversationVerdict = 'never-started' | 'expired' | 'unknown';

/** Why a requested resume became a fresh spawn: every verdict but `unknown`. */
export type StartOverReason = Exclude<ResumeConversationVerdict, 'unknown'>;

/** The fields of a session record the verdict reads. */
export type ResumeLineageRecord = Pick<
  SessionRecord,
  'id' | 'transcript_path' | 'total_input_tokens' | 'total_output_tokens' | 'total_cost_usd'
> & Partial<Pick<SessionRecord, 'cli_target'>>;

/**
 * A transcript path an agent reported, as Kangentic can open it: a Linux path
 * from a CLI that ran in a WSL distro is read through the distro's share. Left
 * as it was otherwise, where a Linux path never confirms anything missing.
 */
function reportedPathOnHost(candidate: string | null | undefined, place: CliPlace | null): string | null | undefined {
  return candidate ? hostPathForTarget(candidate, place) : candidate;
}

/** A record known only by its id: the verdict reads its session folder and nothing else. */
export function folderOnlyRecord(id: string): ResumeLineageRecord {
  return { id, transcript_path: null, total_input_tokens: null, total_output_tokens: null, total_cost_usd: null };
}

/**
 * The records the check reads for one resume, shared by both spawn
 * chokepoints (transition-engine.ts, prepare-spawn.ts) so the board and
 * startup paths never disagree about a conversation's lineage.
 *
 * The lineage is the retiring record, then every other record of the task
 * that ran the same conversation, newest first. A record whose CLI died on a
 * failed resume wrote no status file, so the evidence can only be on an older
 * one. Keyed on the RECONCILED id: after a /clear fork, the older records with
 * the stored id belong to another conversation. The retiring record is read
 * by its folder alone when the task's list does not hold it: its status file
 * is still evidence.
 *
 * `lastActiveAt` is when the retiring record's conversation last ran, for an
 * `expired` notice; null when the list does not hold that record.
 */
export function resolveResumeLineage(params: {
  taskRecords: ReadonlyArray<SessionRecord>;
  retiringRecordId: string | null;
  resumedAgentSessionId: string;
}): { lineage: Array<ResumeLineageRecord | null>; lastActiveAt: string | null } {
  const { taskRecords, retiringRecordId, resumedAgentSessionId } = params;
  const retiringRecord = taskRecords.find((record) => record.id === retiringRecordId) ?? null;
  return {
    lineage: [
      retiringRecord ?? (retiringRecordId ? folderOnlyRecord(retiringRecordId) : null),
      ...taskRecords.filter((record) => record.id !== retiringRecordId && record.agent_session_id === resumedAgentSessionId),
    ],
    lastActiveAt: retiringRecord
      ? (retiringRecord.suspended_at ?? retiringRecord.exited_at ?? retiringRecord.started_at)
      : null,
  };
}

/**
 * Decide what a `--resume` of `agentSessionId` would find, so the spawn can
 * start fresh instead of handing the user a CLI that prints "No conversation
 * found" and exits.
 *
 * Two cases reach that dead end:
 *
 *  1. A conversation that ended before its first turn. Kangentic pre-specifies
 *     `--session-id` for Claude and persists that id at spawn time, but the
 *     CLI writes its transcript on the first turn. Drag a task out of Done
 *     (the recovery move spawns it command-free) and back before typing, and
 *     the record is resumable with nothing behind it.
 *  2. A conversation the agent deleted. Claude Code removes transcripts older
 *     than `cleanupPeriodDays` (30 by default), so any task idle that long hits
 *     it on its next resume.
 *
 * ## Why this is not the guard that was reverted in #255
 *
 * The `canResumeSession` guard (see docs/integrations/agents/session-history.md) gated
 * EVERY resume on a path Kangentic COMPUTED by slugifying the cwd, and a false
 * miss discarded a real conversation. This one differs on every count:
 *
 *  - The path is one the AGENT reported (its status line, its SessionStart
 *    hook, or the copy of it kept on the session record), never one derived
 *    here.
 *  - `never-started` also needs the agent's own report that nothing
 *    ever happened. `expired` needs the adapter's proof that the file is gone
 *    from every place it could be (`proveConversationGone`), which only an
 *    adapter that knows its layout can give.
 *  - Absence of evidence is never evidence. A missing session folder, a
 *    malformed report, an adapter with no status pipeline, or no reported path
 *    all give `unknown`. Mocked E2E resumes hit that structurally (mock-claude
 *    writes no status file), which is what broke the ten session-resume specs
 *    the first time around.
 *
 * A wrong `expired` costs a new conversation in place of the resume and
 * deletes nothing: the caller retires and keeps the old record.
 *
 * Call it AFTER the resume-time id reconcile and the cwd migration: the id is
 * the one actually being resumed, and a migrated file is where the locator and
 * the folder scan find it.
 */
export async function assessResumeConversation(params: {
  adapter: AgentAdapter;
  /** The conversation being resumed, after the reconcile. */
  agentSessionId: string;
  /**
   * Every record that ran this conversation, NEWEST FIRST: the retiring record,
   * then the rest of its lineage (each id is its `.kangentic/sessions/` folder
   * name).
   *
   * A list rather than just the retiring record, because a failed resume is
   * self-perpetuating otherwise: the CLI dies before its status line runs, so
   * that record has no status file, and the next spawn retires IT and finds no
   * evidence either. The evidence stays on an older record of the lineage, so
   * an already-poisoned task heals on its next spawn.
   */
  records: ReadonlyArray<ResumeLineageRecord | null | undefined>;
  /** The cwd the spawn runs in. */
  cwd: string;
  projectPath: string | null | undefined;
  /**
   * Where the spawn's CLI runs (its WSL distro, or null for this machine). A
   * conversation lives in the home of the place its CLI ran in, as the newest
   * record that kept a `cli_target` says, so a CLI moved into, out of, or
   * between distros since then cannot resume it. Omitted: not checked.
   */
  place?: CliPlace | null;
}): Promise<ResumeConversationVerdict> {
  const { adapter, agentSessionId, records, cwd, projectPath, place: spawnPlace } = params;
  if (!projectPath) return 'unknown';

  // Adapters with no status-file pipeline never report a transcript path.
  // Optional-chained because a partially-shaped adapter stub may lack `runtime`.
  const parseStatus = adapter.runtime?.statusFile?.parseStatus;

  let hadTurns = false;
  /** The first record whose folder holds the agent's own report decides `never-started`. */
  let firstAgentReport: ConversationEvidence | null = null;
  const reportedPaths: string[] = [];
  const addReportedPath = (candidate: string | null | undefined): void => {
    if (candidate && !reportedPaths.includes(candidate)) reportedPaths.push(candidate);
  };
  /** Where the newest record's CLI ran, for the agent's own locator. */
  let newestPlace: CliPlace | null | undefined;

  for (const record of records) {
    if (!record) continue;
    // Each record's CLI ran where its own row says (a WSL distro, or here).
    const place = placeOfRecord(record);
    if (newestPlace === undefined) newestPlace = place;
    // Token totals on the row prove turns. Zero totals prove nothing: the
    // path is written on the first status tick, before any metrics capture.
    if (rowHadTurns(record)) hadTurns = true;
    addReportedPath(reportedPathOnHost(record.transcript_path, place));
    if (!parseStatus) continue;
    try {
      const sessionDir = path.join(projectPath, '.kangentic', 'sessions', record.id);
      // Two independent reports, both agent-written. The status line is
      // preferred (richest usage), but it only runs once the TUI is up: a CLI
      // killed in its first second leaves none. The SessionStart hook fires
      // far earlier and carries the same `transcript_path`.
      const reported = readStatusEvidence(sessionDir, parseStatus, agentSessionId) ?? readSessionStartEvidence(sessionDir);
      if (!reported) continue;
      const evidence = { ...reported, transcriptPath: reportedPathOnHost(reported.transcriptPath, place) ?? '' };
      if (evidence.hadTurns) hadTurns = true;
      addReportedPath(evidence.transcriptPath);
      if (!firstAgentReport) firstAgentReport = evidence;
    } catch (error) {
      console.warn(`[SESSION_LIFECYCLE] Resume conversation probe failed for record ${record.id.slice(0, 8)}:`, error);
    }
  }

  // A record read by its folder alone keeps no `cli_target`, so it decides
  // nothing about where the conversation is.
  const placeRecord = records.find((record) => record?.cli_target !== undefined);
  if (spawnPlace !== undefined && placeRecord && !isSameCliPlace(placeRecord.cli_target, spawnPlace)) {
    return hadTurns ? 'expired' : 'never-started';
  }

  if (!hadTurns) {
    // The agent's own report says nothing ever happened, and the transcript it
    // named is not on disk.
    if (firstAgentReport && firstAgentReport.transcriptPath && await isConfirmedMissing(firstAgentReport.transcriptPath)) {
      return 'never-started';
    }
    return 'unknown';
  }

  if (!adapter.proveConversationGone || reportedPaths.length === 0) return 'unknown';
  try {
    return await adapter.proveConversationGone({ agentSessionId, reportedPaths, cwd, place: newestPlace ?? null }) ? 'expired' : 'unknown';
  } catch (error) {
    console.warn(`[SESSION_LIFECYCLE] Conversation-gone probe failed for ${agentSessionId.slice(0, 8)}:`, error);
    return 'unknown';
  }
}

function rowHadTurns(record: ResumeLineageRecord): boolean {
  return (record.total_input_tokens ?? 0) > 0
    || (record.total_output_tokens ?? 0) > 0
    || (record.total_cost_usd ?? 0) > 0;
}

/** What one record's on-disk reports say about its conversation. */
interface ConversationEvidence {
  /** The transcript path the AGENT reported, never one Kangentic derived. Empty when unknown. */
  transcriptPath: string;
  /** Whether anything beyond starting and stopping ever happened. */
  hadTurns: boolean;
}

/**
 * The status line's report. Null when absent, malformed, pathless, or about
 * another conversation.
 *
 * Every process started with the record's --settings writes this one file, so
 * its last write can be a sibling's: Claude Code's background daemon runs an
 * empty spare (no turns, no transcript on disk) beside the conversation it
 * moved. A report that names another id says nothing about the conversation
 * being resumed, and read as its evidence it would claim that nothing ever
 * happened. A report with no id is kept, as before.
 */
function readStatusEvidence(
  sessionDir: string,
  // The adapter's own signature, not a re-declared subset: a local structural
  // copy typechecks against today's SessionUsage and then silently stops
  // tracking it.
  parseStatus: (raw: string) => SessionUsage | null,
  agentSessionId: string,
): ConversationEvidence | null {
  const { statusOutputPath } = sessionOutputPaths(sessionDir);
  let raw: string;
  try {
    raw = fs.readFileSync(statusOutputPath, 'utf8');
  } catch {
    return null;
  }
  const usage = parseStatus(raw);
  const transcriptPath = usage?.transcriptPath;
  if (!usage || typeof transcriptPath !== 'string' || transcriptPath.length === 0) return null;
  if (usage.sessionId !== undefined && usage.sessionId !== agentSessionId) return null;
  return {
    transcriptPath,
    hadTurns: usage.contextWindow.usedTokens > 0
      || usage.contextWindow.totalInputTokens > 0
      || usage.contextWindow.totalOutputTokens > 0
      || usage.cost.totalCostUsd > 0,
  };
}

/**
 * The SessionStart hook's report, from Kangentic's own events file.
 *
 * The hook payload is stored as a JSON STRING under `hookContext`, and carries
 * the same `transcript_path` the status line would have. Turn detection is by
 * elimination: a conversation that ran has prompt / tool / idle events, so
 * anything beyond the two lifecycle markers counts as a turn. Erring that way
 * is the safe direction for `never-started`, and a turn alone never makes a
 * conversation `expired`: that still needs the adapter's proof.
 *
 * Mocked CLIs stay structurally clear of this: `mock-claude` writes an events
 * file only under an opt-in env flag, and even then writes activity events with
 * no `session_start` hook payload, so this returns null for them exactly as the
 * status-file reader does, or a turn with no path, which proves nothing.
 */
function readSessionStartEvidence(sessionDir: string): ConversationEvidence | null {
  const { eventsOutputPath } = sessionOutputPaths(sessionDir);
  let raw: string;
  try {
    raw = fs.readFileSync(eventsOutputPath, 'utf8');
  } catch {
    return null;
  }

  const LIFECYCLE_ONLY = new Set(['session_start', 'session_end']);
  let transcriptPath: string | null = null;
  let hadTurns = false;

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: { type?: unknown; hookContext?: unknown };
    try {
      event = JSON.parse(trimmed) as { type?: unknown; hookContext?: unknown };
    } catch {
      // A torn final line is normal for an append-only file being written.
      continue;
    }
    const type = typeof event.type === 'string' ? event.type : '';
    if (!LIFECYCLE_ONLY.has(type)) {
      hadTurns = true;
      // The path comes before any turn: the hook fires at session start.
      break;
    }
    if (type === 'session_start' && typeof event.hookContext === 'string' && !transcriptPath) {
      try {
        const context = JSON.parse(event.hookContext) as { transcript_path?: unknown };
        if (typeof context.transcript_path === 'string' && context.transcript_path.length > 0) {
          transcriptPath = context.transcript_path;
        }
      } catch {
        // Not the payload shape we know: no evidence, not a turn.
      }
    }
  }

  if (hadTurns) return { transcriptPath: transcriptPath ?? '', hadTurns: true };
  if (!transcriptPath) return null;
  return { transcriptPath, hadTurns: false };
}
