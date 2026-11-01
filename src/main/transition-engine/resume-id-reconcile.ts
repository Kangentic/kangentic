import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import type { AdapterRuntimeStrategy, SessionStartReport, StoredCliTarget } from '../../shared/types';
import type { AgentAdapter } from '../agent/agent-adapter';
import { PLAUSIBLE_AGENT_SESSION_ID } from '../agent/shared/agent-session-id';
import { toStoredCliTarget, type CliPlace } from '../agent/shared/cli-target';
import { sessionStartOfLine } from '../agent/shared/session-start-hook';
import type { SessionRepository } from '../db/repositories/session-repository';
import { sessionOutputPaths } from './session-paths';

type StatusFileHook = NonNullable<AdapterRuntimeStrategy['statusFile']>;

/** A record's SessionStart reports, read when first asked for (`readSessionStarts`). */
type SessionStartsReader = () => Promise<readonly SessionStartReport[]>;

/**
 * Every SessionStart report in an events file, in order. Streamed line by line,
 * so a long session's file is never held whole, and a tool or turn line is
 * skipped unparsed (`sessionStartOfLine`). Read only on the paths that need it
 * (a status report that disagrees with the stored id, a resume or a terminal
 * transition of a conversation), never on every status write. A missing or
 * unreadable file yields nothing, which proves nothing. A read that fails
 * partway yields what it read.
 */
async function readSessionStarts(statusFileHook: StatusFileHook, eventsOutputPath: string): Promise<SessionStartReport[]> {
  const sessionStarts: SessionStartReport[] = [];
  if (!statusFileHook.parseSessionStart) return sessionStarts;
  // An absent file is the common miss. Checked first, because a stream error
  // would otherwise throw inside the loop below.
  try {
    await fs.promises.access(eventsOutputPath, fs.constants.R_OK);
  } catch {
    return sessionStarts;
  }
  const stream = fs.createReadStream(eventsOutputPath, { encoding: 'utf8' });
  // A file removed mid-read, or EBUSY on Windows, ends the scan where it is.
  stream.on('error', () => undefined);
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      const sessionStart = sessionStartOfLine(statusFileHook, line);
      if (sessionStart) sessionStarts.push(sessionStart);
    }
  } catch {
    // A mid-stream failure surfaced through the iterator: the scan ends there.
  } finally {
    lines.close();
    if (!stream.destroyed) stream.destroy();
  }
  return sessionStarts;
}

function eventsPathOfRecord(projectPath: string, recordId: string): string {
  return sessionOutputPaths(path.join(projectPath, '.kangentic', 'sessions', recordId)).eventsOutputPath;
}

/**
 * The id of the agent CLI's own background session (Claude Code's `/bg`) that
 * holds the conversation `agentSessionId`, by the session record `recordId`'s
 * own events file, or null. Null for an adapter that cannot read its hooks or
 * stop such a session, and on any failure.
 *
 * Two cases prove one. A background session's SessionStart (the hook it fired
 * with the record's --settings) names `agentSessionId` itself: the live switch
 * followed the move. Or one names another id that the conversation moved to,
 * by the CLI's own record of the move (`statusFile.confirmsBackgroundMove`):
 * the stored id is still the conversation the move left, because a pause or a
 * terminal transition landed between that hook and the first status write the
 * live switch waits for. The CLI's record is what tells a move from a `/fork`
 * copy, whose hook reads the same.
 *
 * This is the gate in front of `AgentAdapter.stopBackgroundSession`, so a
 * resume or a terminal transition of a conversation that never moved runs no
 * CLI at all (listing Claude's background sessions takes about 220 ms and can
 * start its supervisor).
 */
export async function backgroundSessionHoldingConversation(params: {
  adapter: AgentAdapter;
  projectPath: string;
  recordId: string;
  agentSessionId: string;
  /** The cwd the record's CLI ran in. Without it only the first case is checked. */
  cwd: string | null;
  /** Where the record's CLI ran, for the move check's transcript read. */
  cliTarget?: StoredCliTarget | null;
  /** The record's SessionStart reports, from a reader the caller shares with its own checks. Read here when absent. */
  sessionStarts?: SessionStartsReader;
}): Promise<string | null> {
  const statusFileHook = params.adapter.runtime?.statusFile;
  if (!statusFileHook?.parseSessionStart || !params.adapter.stopBackgroundSession) return null;
  const sessionStarts = params.sessionStarts
    ? await params.sessionStarts()
    : await readSessionStarts(statusFileHook, eventsPathOfRecord(params.projectPath, params.recordId));
  const backgroundIds: string[] = [];
  for (const sessionStart of sessionStarts) {
    if (!sessionStart.inBackgroundSession || !PLAUSIBLE_AGENT_SESSION_ID.test(sessionStart.agentSessionId)) continue;
    if (!backgroundIds.includes(sessionStart.agentSessionId)) backgroundIds.push(sessionStart.agentSessionId);
  }
  if (backgroundIds.includes(params.agentSessionId)) return params.agentSessionId;
  const { cwd } = params;
  if (!cwd || !statusFileHook.confirmsBackgroundMove) return null;
  // Newest first: a conversation moved twice continues in the later one.
  for (const backgroundId of [...backgroundIds].reverse()) {
    const moved = await statusFileHook.confirmsBackgroundMove({
      cwd,
      fromAgentSessionId: params.agentSessionId,
      toAgentSessionId: backgroundId,
      cliTarget: params.cliTarget ?? null,
    });
    if (moved) return backgroundId;
  }
  return null;
}

interface ReconcileParams {
  adapter: AgentAdapter;
  /** The resume-eligible record's id (= its `.kangentic/sessions/` dir name). */
  recordId: string | null | undefined;
  storedAgentSessionId: string | null | undefined;
  /** The cwd the resumed conversation ran in (locates the reported id's transcript). */
  cwd: string | null | undefined;
  projectPath: string | null | undefined;
  /** Persists the swap so later resumes agree. Optional: null still returns the corrected id. */
  sessionRepo: Pick<SessionRepository, 'updateAgentSessionId'> | null | undefined;
  /** Where the record's CLI ran when it was not this machine (`placeOfRecord`): its transcript is there. */
  place?: CliPlace | null;
  /** The CLI this spawn resolved, which stops a background session holding the conversation. */
  cliPath?: string | null;
}

/**
 * Reconcile WHICH agent session id a resume targets against the retiring
 * record's own on-disk status file.
 *
 * The live reconcile (SessionTelemetry's change-sensitive status-file capture
 * -> recoverStaleSessionId) keeps `sessions.agent_session_id` tracking a
 * mid-session fork (Claude /clear moves the conversation to a NEW id and the
 * statusline re-reports it). But suspend() closes the status watcher (with a
 * 100ms debounce) BEFORE the CLI exits, so a fork within the final ~2s of a
 * session - or one from before the live reconcile shipped - can leave the DB
 * holding the pre-fork id while the record's own
 * `.kangentic/sessions/<recordId>/status.json` holds the real one. This
 * helper runs at resume time, reads that Kangentic-owned file, and swaps the
 * resumed id when the agent's own last report disagrees with the DB.
 *
 * Deliberately NOT the `canResumeSession` transcript-presence guard that was
 * built and reverted in #255 (see docs/integrations/agents/session-history.md): it reads
 * ONLY Kangentic's own session directory (never the agent CLI's storage as a
 * gate), it can only swap WHICH id is resumed (the spawn stays `--resume`,
 * never downgraded to fresh), and on every failure path (missing dir or file,
 * malformed JSON, no reported id, same id) it silently returns the stored id,
 * degrading to exactly today's behavior. Mocked E2E resumes hit the
 * missing-file path structurally (mock-claude writes no status.json).
 *
 * Two positive checks before swapping. For an adapter that declares
 * `statusFile.parseSessionStart`, a SessionStart hook in the same record's
 * events file must have moved the conversation to the reported id, because
 * another process running the record's --settings can have written the status
 * file last. Then the reported id's transcript must actually exist
 * (`adapter.locateSessionHistoryFile`, a fast existence probe). If the CLI
 * died right after forking and never persisted the new conversation, swapping
 * would resume an empty thread while the stored id still reaches the pre-fork
 * one - so a locate miss keeps the stored id.
 *
 * Then the id is settled against the agent CLI's own background sessions
 * (`settleResumeTarget`), when the record's hooks show the conversation moved
 * into one.
 */
export async function reconcileResumeAgentSessionId(params: ReconcileParams): Promise<string | null> {
  const sessionStarts = sessionStartsOnce(params);
  const reconciled = await reconcileReportedId(params, sessionStarts);
  if (!reconciled) return reconciled;
  return settleResumeTarget(params, reconciled, sessionStarts);
}

/** The record's SessionStart reports, read on the first ask and shared by both checks, so one resume reads its events file once. */
function sessionStartsOnce(params: ReconcileParams): SessionStartsReader {
  let reading: Promise<readonly SessionStartReport[]> | null = null;
  return () => {
    if (!reading) {
      const statusFileHook = params.adapter.runtime?.statusFile;
      reading = statusFileHook && params.projectPath && params.recordId
        ? readSessionStarts(statusFileHook, eventsPathOfRecord(params.projectPath, params.recordId))
        : Promise.resolve([]);
    }
    return reading;
  };
}

/**
 * A conversation the record saw move into the agent CLI's own background
 * session (Claude Code's `/bg`) can still be running there: that session
 * outlives the task's PTY, so the suspend that ended the PTY left it working.
 * It is stopped through the CLI's own stop before the resume, or the resume
 * would run a second process on the conversation beside it. Then the id is
 * asked for the one a `--resume` reaches (a conversation moved before its
 * first turn there resumes by the id it continued from).
 *
 * Both steps run only on that evidence in the record's own events file
 * (`backgroundSessionHoldingConversation`), so an ordinary resume runs no CLI
 * and reads no transcript here. A record still stored on the conversation the
 * move left is pointed at the background session, as the status swap is, once
 * both steps are done: a step that throws leaves the record and the returned id
 * on the conversation it stored. Never throws.
 */
async function settleResumeTarget(params: ReconcileParams, agentSessionId: string, sessionStarts: SessionStartsReader): Promise<string> {
  const { adapter, recordId, projectPath, cwd, cliPath } = params;
  if (!recordId || !projectPath) return agentSessionId;
  try {
    const backgroundId = await backgroundSessionHoldingConversation({
      adapter,
      projectPath,
      recordId,
      agentSessionId,
      cwd: cwd ?? null,
      // The move check reads the transcript where the record's CLI ran.
      cliTarget: toStoredCliTarget(params.place ?? null),
      sessionStarts,
    });
    if (!backgroundId) return agentSessionId;
    if (cliPath) {
      const stopRan = await adapter.stopBackgroundSession?.({ agentSessionId: backgroundId, cliPath });
      if (stopRan === false) {
        console.log(`[SESSION_LIFECYCLE] Resume target: no background session holding ${backgroundId.slice(0, 8)} was stopped. Resuming it anyway.`);
      }
    }
    let resumable = backgroundId;
    if (cwd && adapter.resolveResumableSessionId) {
      const resolved = await adapter.resolveResumableSessionId({ agentSessionId: backgroundId, cwd, place: params.place ?? null });
      if (resolved !== backgroundId && PLAUSIBLE_AGENT_SESSION_ID.test(resolved)) {
        console.log(
          `[SESSION_LIFECYCLE] Resume target: ${backgroundId.slice(0, 8)} moved into a background session and took`
          + ` no turn there, so it resumes as ${resolved.slice(0, 8)}, the conversation it continued.`,
        );
        resumable = resolved;
      }
    }
    if (backgroundId !== agentSessionId) {
      console.log(
        `[SESSION_LIFECYCLE] Resume target: record ${recordId.slice(0, 8)} stored ${agentSessionId.slice(0, 8)},`
        + ` which moved into the background session ${backgroundId.slice(0, 8)}. Following the move.`,
      );
      params.sessionRepo?.updateAgentSessionId(recordId, backgroundId);
    }
    return resumable;
  } catch (error) {
    console.warn(`[SESSION_LIFECYCLE] Resume target check failed for ${agentSessionId.slice(0, 8)}:`, error);
    return agentSessionId;
  }
}

async function reconcileReportedId(params: ReconcileParams, sessionStarts: SessionStartsReader): Promise<string | null> {
  const { adapter, recordId, storedAgentSessionId, cwd, projectPath, sessionRepo } = params;
  const storedId = storedAgentSessionId ?? null;

  if (!recordId || !storedId || !cwd || !projectPath) return storedId;

  // Adapters without a status-file pipeline have no on-disk id report to
  // consult: structural no-op. Optional-chained: a partially-shaped adapter
  // stub may lack `runtime` entirely, and every failure path here must
  // degrade to the stored id rather than throw.
  const statusFileHook = adapter.runtime?.statusFile;
  if (!statusFileHook) return storedId;

  try {
    const sessionDir = path.join(projectPath, '.kangentic', 'sessions', recordId);
    const { statusOutputPath } = sessionOutputPaths(sessionDir);
    let raw: string;
    try {
      raw = fs.readFileSync(statusOutputPath, 'utf8');
    } catch {
      // No status.json (mocked CLI, pruned dir, agent never wrote one).
      return storedId;
    }

    const usage = statusFileHook.parseStatus(raw);
    const reportedId = usage?.sessionId;
    if (typeof reportedId !== 'string' || reportedId === storedId) return storedId;
    // Defense in depth against a hand-edited or corrupted file: only accept a
    // plausibly id-shaped value before pointing --resume at it.
    if (!PLAUSIBLE_AGENT_SESSION_ID.test(reportedId)) return storedId;

    // Every process started with this record's --settings writes this status
    // file, so its last report can name a sibling rather than the
    // conversation (Claude Code's background daemon runs an empty spare beside
    // the conversation it moved). An adapter that reads its SessionStart hooks
    // follows only an id a hook that moves the conversation named, the same
    // rule the live reconcile applies (ConversationSwitchGate).
    if (statusFileHook.parseSessionStart) {
      const moveHook = (await sessionStarts()).find((sessionStart) =>
        sessionStart.movesConversation && sessionStart.agentSessionId === reportedId);
      if (!moveHook) {
        console.log(
          `[SESSION_LIFECYCLE] Resume-time reconcile: record ${recordId.slice(0, 8)}'s status file last reported`
          + ` ${reportedId.slice(0, 8)}, but no SessionStart moved the conversation there. Keeping the stored id.`,
        );
        return storedId;
      }
      // A background session's hook reads the same for a move (Claude's /bg)
      // and a copy started beside the conversation (/fork); the adapter tells
      // them apart, as the live switch does, reading the transcript where the
      // record's CLI ran.
      if (
        moveHook.inBackgroundSession
        && statusFileHook.confirmsBackgroundMove
        && !(await statusFileHook.confirmsBackgroundMove({
          cwd,
          fromAgentSessionId: storedId,
          toAgentSessionId: reportedId,
          cliTarget: toStoredCliTarget(params.place ?? null),
        }))
      ) {
        console.log(
          `[SESSION_LIFECYCLE] Resume-time reconcile: record ${recordId.slice(0, 8)}'s status file last reported`
          + ` ${reportedId.slice(0, 8)}, a background copy of the conversation. Keeping the stored id.`,
        );
        return storedId;
      }
    }

    // The same status file names the transcript it is writing; a fork of a
    // resumed conversation can sit outside the folder `cwd` maps to.
    const locatedTranscript = await adapter.locateSessionHistoryFile(reportedId, cwd, params.place ?? null, usage?.transcriptPath ?? null);
    if (!locatedTranscript) return storedId;

    console.log(
      `[SESSION_LIFECYCLE] Resume-time reconcile: record ${recordId.slice(0, 8)} stored`
      + ` agent_session_id=${storedId.slice(0, 8)} but its status file last reported`
      + ` ${reportedId.slice(0, 8)} (mid-session fork, e.g. /clear). Resuming the reported id.`,
    );
    sessionRepo?.updateAgentSessionId(recordId, reportedId);
    return reportedId;
  } catch (error) {
    console.warn(`[SESSION_LIFECYCLE] Resume-time reconcile failed for record ${recordId.slice(0, 8)}:`, error);
    return storedId;
  }
}
