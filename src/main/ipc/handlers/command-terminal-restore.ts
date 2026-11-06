/**
 * Brings back the Command Terminals that were running when the app last went
 * away, in the same slot, with the same name, conversation, grid, tag, model and
 * effort. Tasks resume through `resumeSuspendedSessions`; this is the other half
 * of "the workspace comes back".
 *
 * The signal is a `command_terminal_history` row with no end. A quit removes no
 * registry row, so a terminal open at a quit keeps its row open, and a crash or
 * an OS kill leaves the same state. Nothing is written at quit, so the
 * synchronous shutdown path stays out of it.
 *
 * Reading the Earlier list erases that signal: it deletes untouched open rows and
 * stamps the rest ended. So the pass has two halves:
 *
 * - The CLAIM is synchronous and runs on the first touch, from whichever comes
 *   first: a cold open, the list, a phone's `list-earlier`, the panel's wait. A
 *   claimed row reads as live, so the list leaves it alone. The list never waits
 *   for more than this: a spawn phase can run past a phone's 10 s budget.
 * - The START is the spawn phase. Only a cold open runs it, after that project's
 *   tasks have resumed, so tasks keep first claim on `maxConcurrentSessions`.
 *
 * Every start goes through `startCommandTerminal`, so the cap, the slot
 * reservation, the name seed and the rule that a resume never fetches or checks
 * out all hold, and a `/bg` background session is stopped first, as task recovery
 * stops one. With the panel closed a restored terminal behaves like a phone's: the
 * toggle and sidebar count update live and the next open adopts it.
 *
 * Gated on `agent.autoResumeSessionsOnRestart`. Off, the rows stay for the list,
 * and the terminals land in Earlier. A refused restore is quiet: one log line, and
 * the conversation stays in Earlier. Nothing to resume means nothing restored: a
 * fresh terminal in its place would run a cold start's checkout with nobody at
 * the desk.
 */
import fs from 'node:fs';
import { ipcMain } from 'electron';
import { IPC } from '../../../shared/ipc-channels';
import { MAX_COMMAND_TERMINALS, commandTerminalDisplayName, commandTerminalSlotNumber } from '../../../shared/command-terminal-name';
import { PTY_HOST_LOST_EXIT_CODE } from '../../../shared/pty-host';
import { isCommandTerminalSession } from '../../../shared/session-owner';
import type { Session } from '../../../shared/types';
import type { CommandTerminalHistoryRow } from '../../db/repositories/command-terminal-history-repository';
import { parseWslShellSpec } from '../../pty/process-tag/task-process-tag';
import { isShuttingDown } from '../../shutdown-state';
import {
  stopEndedCommandTerminalBackgroundSession,
  type EndedCommandTerminal,
} from '../helpers/command-terminal-background-session';
import { endCommandTerminalBrowserIfSlotEmpty } from '../helpers/command-terminal-browser';
import type { CommandTerminalLeftoverTask } from '../helpers/command-terminal-leftovers';
import { reapTaskLeftovers } from '../helpers/task-cleanup';
import type { IpcContext } from '../ipc-context';
import { CommandTerminalStartError, startCommandTerminal } from './transient-sessions';

/**
 * How long a panel open waits for the restore. Long enough for a boot's task
 * recovery and a few starts, short enough that a wedged pass never leaves
 * Ctrl+Shift+P dead: past it the panel opens, and a restore that finds its slot
 * taken by then falls back to the lowest free one.
 */
const RESTORE_WAIT_CEILING_MS = 10_000;

interface CommandTerminalRestorePass {
  /** The rows the claim holds, until the start takes them. */
  claimed: CommandTerminalHistoryRow[];
  started: boolean;
  done: Promise<void>;
  markDone: () => void;
}

/** A pty host crash's restore of a project's terminals, while it is coming. */
interface LostTerminalsRestore {
  done: Promise<void>;
  markDone: () => void;
}

/** Each launch's passes, per project. A WeakMap dies with the context, as `recoveredProjects` does. */
const passesByContext = new WeakMap<object, Map<string, CommandTerminalRestorePass>>();
const lostRestoresByContext = new WeakMap<object, Map<string, LostTerminalsRestore>>();

function passesOf(context: IpcContext): Map<string, CommandTerminalRestorePass> {
  const existing = passesByContext.get(context);
  if (existing) return existing;
  const passes = new Map<string, CommandTerminalRestorePass>();
  passesByContext.set(context, passes);
  return passes;
}

function lostRestoresOf(context: IpcContext): Map<string, LostTerminalsRestore> {
  const existing = lostRestoresByContext.get(context);
  if (existing) return existing;
  const lostRestores = new Map<string, LostTerminalsRestore>();
  lostRestoresByContext.set(context, lostRestores);
  return lostRestores;
}

function settleLostTerminalsRestore(context: IpcContext, projectId: string): void {
  const lostRestores = lostRestoresOf(context);
  lostRestores.get(projectId)?.markDone();
  lostRestores.delete(projectId);
}

/** Whether the app brings terminals back at all. The same setting tasks read. */
function restoresEnabled(context: Pick<IpcContext, 'configManager'>): boolean {
  return context.configManager.load().agent.autoResumeSessionsOnRestart;
}

function projectFolderExists(context: IpcContext, projectId: string): boolean {
  const project = context.projectRepo.getById(projectId);
  return !!project && fs.existsSync(project.path);
}

/**
 * Claim what a restart will bring back for the project. Synchronous, once per
 * launch, and never throws: a pass that cannot read its rows claims nothing, and
 * a waiter is answered at once. Claims the newest rows the cap can hold; an older
 * open row is left to the list, which stamps it ended. A cold open
 * (`openProjectByPath`, `activateAllProjects`, the deferred `PROJECT_OPEN` body)
 * calls this before anything can list Earlier, and starts the pass after its
 * tasks have resumed.
 */
export function claimCommandTerminalRestore(context: IpcContext, projectId: string): void {
  const passes = passesOf(context);
  if (passes.has(projectId)) return;
  let markDone: () => void = () => undefined;
  const done = new Promise<void>((resolve) => { markDone = resolve; });
  const pass: CommandTerminalRestorePass = { claimed: [], started: false, done, markDone };
  passes.set(projectId, pass);

  try {
    const history = context.commandTerminalHistory;
    if (history && restoresEnabled(context) && projectFolderExists(context, projectId)) {
      // A row something else holds takes no place in the cap.
      for (const row of history.listOpen(projectId)) {
        if (pass.claimed.length === MAX_COMMAND_TERMINALS) break;
        if (history.claimResume(projectId, row.agent_session_id)) pass.claimed.push(row);
      }
    }
  } catch (error) {
    console.warn('[COMMAND_TERMINAL] restore claim failed (non-fatal):', error instanceof Error ? error.message : String(error));
  }
  if (pass.claimed.length === 0) {
    pass.started = true;
    pass.markDone();
  }
}

/**
 * Start what the claim holds. Once per launch, and only from a cold open, after
 * that project's tasks have resumed. Never rejects, so a caller can run it from a
 * `finally`, and every claim is settled whatever became of the chain around it.
 */
export async function startCommandTerminalRestore(context: IpcContext, projectId: string): Promise<void> {
  claimCommandTerminalRestore(context, projectId);
  const pass = passesOf(context).get(projectId);
  if (!pass || pass.started) return;
  pass.started = true;
  const rows = pass.claimed;
  pass.claimed = [];
  try {
    await restoreConversations(context, projectId, rows);
  } finally {
    pass.markDone();
  }
}

/**
 * Settle the launch's restore without starting anything, for a project this
 * instance does not own: a copied database must not bring agents back in another
 * instance's folder. The panel's wait ends at once, and the claimed conversations
 * stay open for the instance that owns them.
 */
export function skipCommandTerminalRestore(context: IpcContext, projectId: string): void {
  claimCommandTerminalRestore(context, projectId);
  const pass = passesOf(context).get(projectId);
  if (!pass || pass.started) return;
  pass.started = true;
  pass.claimed = [];
  pass.markDone();
}

/**
 * Resolves once the launch's restore and any pty host crash's restore are over,
 * or at the ceiling. Never rejects.
 */
export async function waitForCommandTerminalRestore(context: IpcContext, projectId: string): Promise<void> {
  claimCommandTerminalRestore(context, projectId);
  const pass = passesOf(context).get(projectId);
  if (!pass) return;
  let ceiling: ReturnType<typeof setTimeout> | undefined;
  const reachedCeiling = new Promise<void>((resolve) => {
    ceiling = setTimeout(resolve, RESTORE_WAIT_CEILING_MS);
    ceiling.unref?.();
  });
  await Promise.race([
    Promise.all([pass.done, lostRestoresOf(context).get(projectId)?.done]),
    reachedCeiling,
  ]);
  clearTimeout(ceiling);
}

/** The project is gone: nothing of its pass carries over to a project re-added at its id. */
export function forgetCommandTerminalRestore(context: IpcContext, projectId: string): void {
  passesOf(context).delete(projectId);
  settleLostTerminalsRestore(context, projectId);
}

/**
 * Whether a terminal a pty host crash took down comes back. Read by the capture
 * below and by the leftover reaper, which must not stop what the conversation
 * will come back to, so the two cannot disagree. A Stop removes its row at once,
 * so a terminal being ended never reaches here. No id, or nobody used it, means
 * nothing to resume.
 */
export function isRestorableAfterHostLoss(
  context: Pick<IpcContext, 'configManager'>,
  session: Session,
): session is Session & { agentSessionId: string } {
  return isCommandTerminalSession(session)
    && session.exitCode === PTY_HOST_LOST_EXIT_CODE
    && !!session.agentSessionId
    && session.hasUserInput === true
    && restoresEnabled(context);
}

/**
 * A terminal the pty host took down that comes back. It stays until the restore
 * answers: the leftover reaper skipped it, so one that does not come back is
 * reaped from here.
 */
export interface LostCommandTerminal {
  agentSessionId: string;
  /** The lost session, and the slot whose Browser pane it kept for the restore. */
  sessionId: string;
  slot: string | null;
  claimed: boolean;
  ended: EndedCommandTerminal;
  task: CommandTerminalLeftoverTask;
  wslDistros: string[];
}

/**
 * Claim the conversation of a terminal the pty host took down, from its
 * `session-removed`. In that emit, or the rail offers the row in Earlier while the
 * host restarts and a Resume click races the restore. Must run after the history's
 * own removal listener, which is what lets go of the conversation, and during
 * the removal, while the registry row still names its agent and place. A panel
 * opened from here on waits for the restore, or its default window starts fresh
 * in a slot the restore is about to take.
 */
export function claimLostCommandTerminal(context: IpcContext, session: Session | undefined): LostCommandTerminal | null {
  if (!session || !isRestorableAfterHostLoss(context, session)) return null;
  const agentSessionId = session.agentSessionId;
  const wslDistro = parseWslShellSpec(session.shell)?.distro;
  const lostRestores = lostRestoresOf(context);
  if (!lostRestores.has(session.projectId)) {
    let markDone: () => void = () => undefined;
    const done = new Promise<void>((resolve) => { markDone = resolve; });
    lostRestores.set(session.projectId, { done, markDone });
  }
  return {
    agentSessionId,
    sessionId: session.id,
    slot: session.commandTerminalSlot ?? null,
    claimed: context.commandTerminalHistory?.claimResume(session.projectId, agentSessionId) === true,
    ended: {
      agentName: context.sessionManager.getSessionAgentName(session.id),
      agentSessionId,
      cwd: session.cwd,
      cliTarget: context.sessionManager.getSessionCliTarget?.(session.id) ?? null,
    },
    task: {
      id: session.taskId,
      worktree_path: null,
      title: commandTerminalDisplayName(session.commandTerminalLabel, session.commandTerminalSlot),
    },
    wslDistros: wslDistro ? [wslDistro] : [],
  };
}

/**
 * Restore the terminals `claimLostCommandTerminal` took. One that does not come
 * back has ended, so what it left running goes the way a terminal's end sends
 * it, and nothing is reaped once the app is quitting. Never rejects.
 */
export async function restoreLostCommandTerminals(
  context: IpcContext,
  projectId: string,
  lostTerminals: readonly LostCommandTerminal[],
): Promise<void> {
  const history = context.commandTerminalHistory;
  try {
    if (!history) return;
    const byConversation = new Map(lostTerminals.map((lost) => [lost.agentSessionId, lost]));
    const reap = (agentSessionId: string): void => {
      const lost = byConversation.get(agentSessionId);
      if (lost && !isShuttingDown()) void reapLostCommandTerminal(context, lost);
    };
    const rows: CommandTerminalHistoryRow[] = [];
    for (const lost of lostTerminals) {
      const row = lost.claimed ? history.find(projectId, lost.agentSessionId) : null;
      if (row) {
        rows.push(row);
        continue;
      }
      if (lost.claimed) history.settleResume(projectId, lost.agentSessionId, null);
      reap(lost.agentSessionId);
    }
    await restoreConversations(context, projectId, rows, reap);
  } finally {
    settleLostTerminalsRestore(context, projectId);
    // The browser cleanup kept each lost slot's page, URL and layout for the
    // restore (`isRestorableAfterHostLoss`). A slot no terminal came back to,
    // refused or restored into another slot, ends them as its Stop would have.
    for (const lost of lostTerminals) {
      if (lost.slot) endCommandTerminalBrowserIfSlotEmpty(context, projectId, lost.slot, lost.sessionId);
    }
  }
}

/** The reaper's end for a terminal it skipped. Never rejects. */
async function reapLostCommandTerminal(context: IpcContext, lost: LostCommandTerminal): Promise<void> {
  try {
    await stopEndedCommandTerminalBackgroundSession(context, lost.ended);
    await reapTaskLeftovers(context, lost.ended.cwd, [lost.task], { wslDistros: lost.wslDistros, skipStopScript: true });
  } catch (error) {
    console.warn('[COMMAND_TERMINAL] leftover reap failed (non-fatal):', error instanceof Error ? error.message : String(error));
  }
}

/** A saved slot first, ascending, so a row with none cannot take one a later row saved. */
function byRestoreOrder(first: CommandTerminalHistoryRow, second: CommandTerminalHistoryRow): number {
  const firstSlot = first.slot ? commandTerminalSlotNumber(first.slot) : null;
  const secondSlot = second.slot ? commandTerminalSlotNumber(second.slot) : null;
  return (firstSlot ?? Number.MAX_SAFE_INTEGER) - (secondSlot ?? Number.MAX_SAFE_INTEGER);
}

async function restoreConversations(
  context: IpcContext,
  projectId: string,
  rows: readonly CommandTerminalHistoryRow[],
  onRefused?: (agentSessionId: string) => void,
): Promise<void> {
  // One at a time: a slot-less row must see the slots the rows before it took.
  const usedTags = new Set<string>();
  for (const row of [...rows].sort(byRestoreOrder)) {
    if (isShuttingDown()) {
      context.commandTerminalHistory?.settleResume(projectId, row.agent_session_id, null);
      continue;
    }
    // A tag no other session shares (`task-process-tag.md`). Two open rows can
    // carry one only through a crash mid-`/clear`; the second takes a new tag.
    const processTag = row.task_tag && !usedTags.has(row.task_tag) ? row.task_tag : null;
    if (processTag) usedTags.add(processTag);
    const restored = await restoreConversation(context, projectId, row, processTag);
    if (!restored) onRefused?.(row.agent_session_id);
  }
}

/** Whether the terminal came back. Never rejects. */
async function restoreConversation(
  context: IpcContext,
  projectId: string,
  row: CommandTerminalHistoryRow,
  processTag: string | null,
): Promise<boolean> {
  const agentSessionId = row.agent_session_id;
  const grid = row.last_pty_cols !== null && row.last_pty_rows !== null
    ? { cols: row.last_pty_cols, rows: row.last_pty_rows }
    : null;
  const start = (slot: string | undefined) => startCommandTerminal(
    context,
    { projectId, slot, resumeAgentSessionId: agentSessionId },
    { processTag, grid },
  );
  try {
    // Asked again here: rows start one at a time, long after the claim, and a
    // host crash's restore never claimed through the check.
    if (!projectFolderExists(context, projectId)) {
      throw new CommandTerminalStartError('conversation-gone', 'The project folder is gone.');
    }
    let result;
    try {
      result = await start(row.slot ?? undefined);
    } catch (error) {
      // A phone start got there first, or two rows saved one slot.
      if (!(error instanceof CommandTerminalStartError) || error.code !== 'slot-taken') throw error;
      result = await start(undefined);
    }
    console.log(`[COMMAND_TERMINAL] restored ${agentSessionId.slice(0, 8)} in ${result.slot}`);
    return true;
  } catch (error) {
    context.commandTerminalHistory?.settleResume(projectId, agentSessionId, null);
    const reason = error instanceof CommandTerminalStartError ? error.code : (error instanceof Error ? error.message : String(error));
    console.log(`[COMMAND_TERMINAL] did not restore ${agentSessionId.slice(0, 8)}, it stays in Earlier: ${reason}`);
    return false;
  }
}

/**
 * The panel, and the detached window's mount, wait on this before they look for a
 * project's terminals: a window that opened first would start fresh in a slot the
 * restore is about to take. A project id that names no project resolves at once,
 * with nothing opened for it.
 */
export function registerCommandTerminalRestoreHandlers(context: IpcContext): void {
  ipcMain.handle(IPC.COMMAND_TERMINAL_RESTORE_WAIT, async (_, projectId: unknown) => {
    if (typeof projectId !== 'string' || !context.projectRepo.getById(projectId)) return;
    await waitForCommandTerminalRestore(context, projectId);
  });
}
