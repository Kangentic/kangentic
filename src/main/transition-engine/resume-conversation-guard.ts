import fs from 'node:fs';
import path from 'node:path';
import type { AgentAdapter } from '../agent/agent-adapter';
import { sessionOutputPaths } from './session-paths';

/**
 * Detect a `--resume` that would target a conversation the agent never
 * persisted, so the spawn can be downgraded to fresh instead.
 *
 * Kangentic pre-specifies `--session-id` for Claude and persists that id on the
 * session record AT SPAWN TIME, before the agent has done anything. A session
 * that ends before its first turn therefore leaves a resumable-looking record
 * pointing at a conversation that does not exist: the agent CLI writes its
 * transcript on the first turn, not at boot.
 *
 * That is reachable in a few seconds of ordinary board use. Drag a task out of
 * Done and the recovery move spawns it command-free (`skipPromptTemplate`), so
 * the agent comes up idle with nothing to do; drag it back before typing and
 * the record is suspended with its id intact. Every later entry into an
 * auto-spawn column then resolves to `--resume <id>`, the CLI answers "No
 * conversation found with session ID", and the user lands on a bare shell with
 * the agent gone - while the session record still reads `running`, because the
 * shell PTY outlived the CLI.
 *
 * ## Why this is not the guard that was reverted in #255
 *
 * The `canResumeSession` transcript-presence guard (see
 * docs/adapter-session-history.md) gated EVERY resume on `fs.accessSync` of a
 * path Kangentic COMPUTED by slugifying the cwd. Its failure mode is fatal and
 * silent: a false miss (a mocked CLI, or one of the more fragile per-agent
 * locators) discards a real conversation. This is a different predicate on
 * three counts, and all three have to hold before anything is downgraded:
 *
 *  1. The path is the one the AGENT reported in its own status file
 *     (`transcript_path`), never one we derived. No locator heuristics.
 *  2. The same status report must independently say the conversation never
 *     started (no tokens, no cost). Downgrading a zero-turn conversation cannot
 *     lose anything, because there is nothing in it. A session that had turns is
 *     never downgraded, even if its transcript has moved.
 *  3. Absence of evidence is never evidence: a missing session dir, missing or
 *     malformed status file, an adapter with no status pipeline, or a status
 *     report carrying no transcript path all return false and leave today's
 *     behavior exactly as it was. Mocked E2E resumes hit that path structurally
 *     (mock-claude writes no status.json), which is what broke the ten
 *     session-resume specs the first time around.
 *
 * Both the read and the decision stay inside Kangentic's own session directory
 * plus one existence check of a path the agent handed us.
 */
export async function isResumeConversationAbsent(params: {
  adapter: AgentAdapter;
  /**
   * Every record that has run this conversation, NEWEST FIRST (each id is its
   * `.kangentic/sessions/` dir name). The first one carrying a usable status
   * report decides.
   *
   * A list rather than just the retiring record, because a failed resume is
   * self-perpetuating otherwise: the CLI dies before its status line runs, so
   * that record has no status file, and the next spawn retires IT and finds no
   * evidence either. The proof of emptiness stays on the first record of the
   * lineage, so an already-poisoned task heals on its next spawn instead of
   * being stuck forever.
   */
  recordIds: ReadonlyArray<string | null | undefined>;
  projectPath: string | null | undefined;
}): Promise<boolean> {
  const { adapter, recordIds, projectPath } = params;
  if (!projectPath) return false;

  // Adapters with no status-file pipeline never report a transcript path, so
  // there is nothing to check: structural no-op, same as the resume-time id
  // reconcile. Optional-chained because a partially-shaped adapter stub may
  // lack `runtime` entirely.
  const statusFileHook = adapter.runtime?.statusFile;
  if (!statusFileHook) return false;

  for (const recordId of recordIds) {
    if (!recordId) continue;
    try {
      const sessionDir = path.join(projectPath, '.kangentic', 'sessions', recordId);
      // Two independent reports, both agent-written and both Kangentic-owned.
      // The status line is preferred (richest usage), but it only runs once the
      // TUI is up: a CLI killed in its first second leaves none, which used to
      // blind the whole lineage. The SessionStart hook fires far earlier and
      // carries the same `transcript_path`, so it covers that window.
      const evidence = readStatusEvidence(sessionDir, statusFileHook.parseStatus)
        ?? readSessionStartEvidence(sessionDir);
      // Nothing usable here (mocked CLI, pruned dir, or the agent died before
      // writing anything at all). Try an older record of the same conversation.
      if (!evidence) continue;

      // Signal 2: the agent's own report says nothing ever happened. A
      // conversation that had turns keeps today's behavior no matter what the
      // file check below would say.
      if (evidence.hadTurns) return false;

      // Signal 1: the transcript the agent named is not on disk. Checked last so
      // a conversation with turns never pays for the stat.
      return !fs.existsSync(evidence.transcriptPath);
    } catch (error) {
      console.warn(`[SESSION_LIFECYCLE] Resume conversation probe failed for record ${recordId.slice(0, 8)}:`, error);
      return false;
    }
  }

  // No record produced a usable report: unknown, so resume exactly as before.
  return false;
}

/** What one record's on-disk reports say about its conversation. */
interface ConversationEvidence {
  /** The transcript path the AGENT reported, never one Kangentic derived. */
  transcriptPath: string;
  /** Whether anything beyond starting and stopping ever happened. */
  hadTurns: boolean;
}

/** The status line's report. Null when absent, malformed, or pathless. */
function readStatusEvidence(
  sessionDir: string,
  parseStatus: (raw: string) => { transcriptPath?: string; contextWindow: { usedTokens: number; totalInputTokens: number; totalOutputTokens: number }; cost: { totalCostUsd: number } } | null,
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
 * is the safe direction, since "had turns" always means "resume as before".
 *
 * Mocked CLIs stay structurally clear of this: `mock-claude` writes an events
 * file only under an opt-in env flag, and even then writes activity events with
 * no `session_start` hook payload, so this returns null for them exactly as the
 * status-file reader does.
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
      // A turn is decisive on its own; the path is only needed when there is none.
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
