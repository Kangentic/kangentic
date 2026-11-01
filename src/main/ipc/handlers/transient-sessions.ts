import fs from 'node:fs';
import path from 'node:path';
import { ipcMain } from 'electron';
import { v4 as uuidv4 } from 'uuid';
import { IPC } from '../../../shared/ipc-channels';
import { resolveProjectRoot } from '../../../shared/git-utils';
import { isCommandTerminalSession } from '../../../shared/session-owner';
import {
  MAX_COMMAND_TERMINALS,
  commandTerminalSlotId,
  commandTerminalSlotNumber,
  commandTerminalTitle,
} from '../../../shared/command-terminal-name';
import { fetchIfStale } from '../../git/fetch-throttle';
import { gitAt, type GitClient } from '../../git/git-client';
import { resolveProjectDefaultBaseBranch } from '../helpers/default-base-branch';
import { trackFeatureUsed } from '../../analytics/usage';
import { agentRegistry } from '../../agent/agent-registry';
import { AgentCliNotFoundError } from '../../agent/shared/agent-cli-not-found';
import { resolveShimLaunch } from '../../agent/shared/shim-launch';
import { isSameCliPlace, resolveCliTarget, shellForTarget, toStoredCliTarget } from '../../agent/shared/cli-target';
import { canResumeConversationById } from '../../agent/shared/workflow-agent-capability';
import { heldByLiveSession, settleCommandTerminalResume } from '../helpers/command-terminal-background-session';
import { DEFAULT_AGENT } from '../../../shared/types';
import type {
  SpawnTransientSessionInput,
  SpawnTransientSessionResult,
  PermissionMode,
  SessionInjectSettingsInput,
  SessionInjectSettingsResult,
} from '../../../shared/types';
import type { SettingsChangeSpec } from '../../agent/agent-adapter';
import { releaseCommandHold } from '../../pty/lifecycle/adapter-lifecycle';
import type { IpcContext } from '../ipc-context';

/**
 * How long a phone's fetch may take. The phone gives every verb 10 s, and the
 * start answers only once the session exists, so the fetch cannot take the
 * 15 s `fetchIfStale` allows a desk user.
 */
const UNATTENDED_FETCH_TIMEOUT_MS = 5_000;

/**
 * The whole git phase of a phone's start (fetch, the dirty-tree probe, the
 * checkout and the fast-forward) gets this much. A step that has not begun by
 * then is skipped and the terminal starts on whatever HEAD is checked out, the
 * same fallback a git failure takes, so a large repo can delay a phone's start
 * but never fail it. A step already running is never cut short: abandoning a
 * checkout halfway would leave the working tree half switched.
 */
const UNATTENDED_GIT_BUDGET_MS = 6_000;

/**
 * Why a Command Terminal start was refused. The codes the mobile bridge reports
 * to a phone come from here, mapped in its `START_REFUSAL_CODES`. `slot-taken`
 * is internal (a desktop window asked for a slot a phone's terminal holds) and
 * only ever reaches the renderer's toast. `spawn-failed` (the shell did not
 * start) reaches a phone only as the generic start failure. `conversation-gone`
 * refuses a resume of a conversation with no record, or whose agent cannot
 * resume it; `conversation-open` one that a live terminal already holds, or
 * that another resume is starting.
 */
export type CommandTerminalStartErrorCode =
  | 'unknown-project'
  | 'command-terminal-limit'
  | 'slot-taken'
  | 'spawn-failed'
  | 'conversation-gone'
  | 'conversation-open';

export class CommandTerminalStartError extends Error {
  readonly code: CommandTerminalStartErrorCode;

  constructor(code: CommandTerminalStartErrorCode, message: string) {
    super(message);
    this.name = 'CommandTerminalStartError';
    this.code = code;
  }
}

export interface StartCommandTerminalInput extends SpawnTransientSessionInput {
  /**
   * Nobody is at the desk (a phone started it). The start runs the same steps
   * as the desktop's Add terminal, made unable to block: the fetch is
   * non-interactive and short, the git phase has one deadline, and it never
   * checks out under another agent that is live in the project folder.
   */
  unattended?: boolean;
}

/**
 * Slots a start in flight has claimed but not yet spawned into, per project.
 * Filled synchronously on entry, before the first await, so two starts racing
 * through detect, fetch and checkout cannot both take the same slot or both
 * pass the cap.
 */
const reservedSlotsByProject = new Map<string, Set<string>>();

/** Forget every in-flight reservation (for tests). */
export function clearCommandTerminalReservations(): void {
  reservedSlotsByProject.clear();
}

/**
 * A path as `projectRootIsShared` compares it. Not run through
 * `resolveProjectRoot`: that maps a task's worktree to the project root, and a
 * worktree has its own HEAD, so its agent never shares the root's checkout.
 */
function normalizeComparablePath(rawPath: string): string {
  const resolved = path.resolve(rawPath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function commandTerminalLimitError(): CommandTerminalStartError {
  return new CommandTerminalStartError(
    'command-terminal-limit',
    `This project already has ${MAX_COMMAND_TERMINALS} Command Terminals running.`,
  );
}

function gitTookTooLong(currentBranch: string, targetBranch: string): { branch: string; checkoutError: string } {
  return {
    branch: currentBranch,
    checkoutError: `Staying on "${currentBranch}": git took too long, so this terminal did not switch to "${targetBranch}".`,
  };
}

/**
 * Claim a slot for a new Command Terminal in `projectId`, or throw the refusal.
 *
 * Occupied means a live transient row of the project (main removes a terminal's
 * row when it ends, so every row is live) or another start's reservation. The
 * cap counts the same set, so a crashed terminal never holds a phone at the cap,
 * and a start whose row has registered but whose reservation is not yet
 * released counts once. Returns the claimed slot and the function that releases
 * the reservation.
 */
function reserveCommandTerminalSlot(
  context: IpcContext,
  projectId: string,
  requestedSlot: string | undefined,
): { slot: string; release: () => void } {
  if (requestedSlot) {
    const requestedNumber = commandTerminalSlotNumber(requestedSlot);
    if (
      requestedNumber === null
      || requestedNumber < 1
      || requestedNumber > MAX_COMMAND_TERMINALS
      || requestedSlot !== commandTerminalSlotId(requestedNumber)
    ) {
      throw new Error(`Not a Command Terminal slot: ${requestedSlot}`);
    }
  }
  const reserved = reservedSlotsByProject.get(projectId) ?? new Set<string>();
  const occupied = new Set<string>(reserved);
  let unslottedLiveCount = 0;
  for (const session of context.sessionManager.listSessions()) {
    // A workflow's own agent is transient too, but holds no terminal slot and
    // never counts against the terminal cap.
    if (!isCommandTerminalSession(session) || session.projectId !== projectId || session.status === 'exited') continue;
    if (session.commandTerminalSlot) occupied.add(session.commandTerminalSlot);
    else unslottedLiveCount += 1;
  }

  if (occupied.size + unslottedLiveCount >= MAX_COMMAND_TERMINALS) throw commandTerminalLimitError();

  let slot: string | null = null;
  if (requestedSlot) {
    if (occupied.has(requestedSlot)) {
      throw new CommandTerminalStartError('slot-taken', `${commandTerminalTitle(requestedSlot)} is already running.`);
    }
    slot = requestedSlot;
  } else {
    for (let slotNumber = 1; slotNumber <= MAX_COMMAND_TERMINALS; slotNumber += 1) {
      const candidate = commandTerminalSlotId(slotNumber);
      if (!occupied.has(candidate)) {
        slot = candidate;
        break;
      }
    }
  }
  if (!slot) throw commandTerminalLimitError();

  reserved.add(slot);
  reservedSlotsByProject.set(projectId, reserved);
  const claimedSlot = slot;
  return {
    slot: claimedSlot,
    release: () => {
      const current = reservedSlotsByProject.get(projectId);
      if (!current) return;
      current.delete(claimedSlot);
      if (current.size === 0) reservedSlotsByProject.delete(projectId);
    },
  };
}

/**
 * Whether another live session already runs in this project folder: a sibling
 * Command Terminal, or a task agent with no worktree. An unattended start must
 * not move HEAD under it.
 */
function projectRootIsShared(context: IpcContext, projectRoot: string): boolean {
  const comparableRoot = normalizeComparablePath(projectRoot);
  return context.sessionManager.listSessions().some((session) =>
    (session.status === 'running' || session.status === 'queued')
    && normalizeComparablePath(session.cwd) === comparableRoot);
}

/**
 * Start a Command Terminal: the project's default agent at the project root,
 * with no task and no database row. The desktop's Ctrl+Shift+P layer and a
 * phone's `command-terminal` start both come through here, so the cap, the slot
 * allocation, the checkout, and the spawn are the same for both.
 *
 * Works for any known project, open on the desktop or not: every input is read
 * from the named project (its path, config, agent, MCP URL), never from the
 * desktop's current one.
 */
export async function startCommandTerminal(
  context: IpcContext,
  input: StartCommandTerminalInput,
): Promise<SpawnTransientSessionResult> {
  const project = context.projectRepo.getById(input.projectId);
  if (!project) throw new CommandTerminalStartError('unknown-project', 'Cannot spawn transient session: project not found');

  const reservation = reserveCommandTerminalSlot(context, input.projectId, input.slot);
  // The conversation this start claimed for a resume, and the terminal that
  // took it; settled in the `finally`, whichever way the start ends.
  let claimedConversation: string | null = null;
  // The conversation the claimed one continued, when that is the id that
  // resumes it (settleCommandTerminalResume): claimed too, and settled with it.
  let claimedPredecessor: string | null = null;
  let resumedSessionId: string | null = null;
  try {
    const projectRoot = resolveProjectRoot(project.path);
    const config = context.configManager.getEffectiveConfig(projectRoot);

    // A resume runs on the agent that held the conversation, which may not be
    // the project's default any more.
    const resume = input.resumeAgentSessionId
      ? await resolveResumedConversation(context, input.projectId, input.resumeAgentSessionId)
      : null;
    if (resume) {
      if (!context.commandTerminalHistory?.claimResume(input.projectId, resume.agentSessionId)) {
        throw new CommandTerminalStartError('conversation-open', 'That conversation is already open in another terminal.');
      }
      claimedConversation = resume.agentSessionId;
    }
    const agentName = resume?.agentName ?? (project.default_agent || DEFAULT_AGENT);
    const adapter = agentRegistry.getOrThrow(agentName);
    const cliPathOverride = config.agent.cliPaths[agentName] ?? null;

    const detection = await adapter.detect(cliPathOverride);
    if (!detection.found || !detection.path) throw new AgentCliNotFoundError(agentName, adapter.displayName);
    // Where the CLI runs (a WSL distro, for a CLI installed in one), resolved
    // once for this start, as the task spawns do.
    const cliTarget = await resolveCliTarget(detection.path, adapter.supportsWslCli === true);
    // The conversation is in the home of the place its CLI ran in. A CLI path
    // moved into, out of, or between WSL distros since then would hand the CLI
    // a `--resume` it cannot find.
    if (resume && !isSameCliPlace(resume.cliTarget, cliTarget)) {
      throw new CommandTerminalStartError('conversation-gone', 'That conversation ran where the agent\'s CLI path no longer points.');
    }
    // A conversation moved into the agent CLI's own background session (Claude
    // Code's `/bg`) can still be running there: a quit stops none, and a resume
    // beside it would put a second process on it. It is stopped first, unless a
    // live terminal still holds it, and the resume names the id a `--resume`
    // reaches. Both run only when the agent's own files show the move, so an
    // ordinary resume runs no CLI here. The stop comes before the resolve, so
    // the background session cannot take a turn between the two, and a start
    // refused below because another terminal holds the resolved id has stopped
    // it already. The CLI's stop keeps its conversation.
    let resumeAgentSessionId: string | null = null;
    if (resume) {
      const cliPath = detection.path;
      resumeAgentSessionId = await settleCommandTerminalResume({
        adapter,
        agentSessionId: resume.agentSessionId,
        cwd: resume.cwd,
        place: cliTarget,
        resolveCliPath: async () => cliPath,
        isHeldLive: (backgroundId) => heldByLiveSession(context, backgroundId),
      });
      if (resumeAgentSessionId !== resume.agentSessionId) {
        if (!context.commandTerminalHistory?.claimResume(input.projectId, resumeAgentSessionId)) {
          throw new CommandTerminalStartError('conversation-open', 'That conversation is already open in another terminal.');
        }
        claimedPredecessor = resumeAgentSessionId;
      }
    }
    // The shell the PTY types the command into: it decides the quoting style
    // and which shim variant a `.cmd` head is swapped for (shim-launch.ts). A
    // distro CLI runs in that distro's shell, whatever the Terminal setting says.
    const shell = shellForTarget(cliTarget) ?? await context.sessionManager.getShell();
    const permissionMode = config.agent.permissionMode as PermissionMode;
    const transientTaskId = uuidv4();
    const sessionId = uuidv4();

    // A resume never fetches or checks out: it picks a conversation up where
    // the project is, and moving HEAD could move it under a sibling terminal.
    const { branch, checkoutError } = resume
      ? { branch: await readCheckedOutBranch(gitAt(projectRoot)), checkoutError: undefined }
      : await checkOutStartBranch(context, projectRoot, input);
    if (checkoutError && input.unattended) {
      console.log(`[COMMAND_TERMINAL] phone start in ${input.projectId.slice(0, 8)}: ${checkoutError}`);
    }

    // Create session directory for status/events bridge files so the
    // shimmer overlay can detect when Claude Code is ready.
    const sessionDirectory = path.join(projectRoot, '.kangentic', 'sessions', transientTaskId);
    // sync-write-ok: this must throw, not degrade, for the same reason as
    // prepare-spawn.ts's session directory - a Command Terminal with no
    // session directory has nowhere to write status/events. This function
    // already throws plain Errors above for earlier preconditions (unknown
    // project, the cap, CLI not found), and both callers catch the rejection:
    // the desktop's spawnTransientSession callers (CommandTerminalWindow.tsx)
    // toast it, and the mobile bridge's command-terminal handler answers the
    // phone with `command-terminal-start-failed`.
    fs.mkdirSync(sessionDirectory, { recursive: true });
    const statusOutputPath = path.join(sessionDirectory, 'status.json');
    const eventsOutputPath = path.join(sessionDirectory, 'activity.json');

    // The same pre-spawn global-config step the task chokepoints run: trust
    // for the project root, kangentic pre-enabled in the agent's MCP list, and
    // Claude's diff panel closed. A Command Terminal is the likeliest maximized
    // pane, so it needs the diff-panel write most of all. Pinned by
    // tests/unit/spawn-entry-point-parity.test.ts (line order) and
    // tests/unit/transient-session-spawn-ensure-trust.test.ts (the runtime
    // guarantee: awaited, called once, with projectRoot, before buildCommand).
    await adapter.ensureTrust(projectRoot, cliTarget);
    // A `.cmd` head under a PowerShell or Git Bash host launches through
    // cmd.exe; hand the builder the sibling shim the shell can run instead
    // (shim-launch.ts). No prompt here, but the head must match what task
    // spawns use, so a Command Terminal never runs a different process shape.
    const launch = await resolveShimLaunch({ agentPath: detection.path, shell, prompt: undefined });
    const commandOptions = {
      agentPath: launch.agentPath,
      taskId: transientTaskId,
      cwd: projectRoot,
      permissionMode,
      projectRoot,
      statusOutputPath,
      eventsOutputPath,
      // The namer (command-terminal-namer.ts) names the terminal from its
      // first prompt's text, which a prompt hook reports only when asked.
      capturePromptText: true,
      // The terminal's own KANGENTIC_TASK_ID, for an agent CLI that strips
      // inherited variables from its tool shells (Codex). The PTY carries it
      // from performSpawn; its leftovers are reaped when the terminal ends.
      taskProcessTag: transientTaskId,
      // The session's own id, minted here so the spawn below uses it too: a
      // folder-shared adapter file is held under it until the session ends.
      ptySessionId: sessionId,
      shell,
      mcpServerEnabled: config.mcpServer.enabled,
      mcpServerUrl: context.mcpServerHandle?.urlForProject(input.projectId),
      mcpServerToken: context.mcpServerHandle?.token,
      // Project default model/effort, same tier board-task spawns apply. A
      // fresh Command Terminal starts on the project's preferred combo
      // instead of the CLI's own default.
      model: project.default_model ?? undefined,
      effort: project.default_effort ?? undefined,
      // The conversation to pick up, through the CLI's own resume.
      ...(resumeAgentSessionId ? { sessionId: resumeAgentSessionId, resume: true } : {}),
      cliTarget,
    };
    const command = adapter.buildCommand(commandOptions);

    let extraEnv: Record<string, string> | null;
    try {
      extraEnv = adapter.buildEnv?.(commandOptions) ?? null;
    } catch (error) {
      // The built command never reached spawn(), so release its hold. From the
      // spawn() call on, spawn() releases a spawn that never runs.
      releaseCommandHold(adapter, projectRoot, sessionId);
      throw error;
    }
    const session = await context.sessionManager.spawn({
      id: sessionId,
      taskId: transientTaskId,
      projectId: input.projectId,
      command,
      cwd: projectRoot,
      env: extraEnv ?? undefined,
      statusOutputPath,
      eventsOutputPath,
      transient: true,
      commandTerminalSlot: reservation.slot,
      // The RESOLVED branch, not `input.branch`: the checkout above falls back to
      // whatever is actually checked out when the requested branch cannot be
      // switched to, and the monitor must report where the terminal really is.
      commandTerminalBranch: branch,
      agentParser: adapter,
      agentName: adapter.name,
      exitSequence: adapter.getExitSequence?.() ?? ['\x03'],
      cols: input.cols,
      rows: input.rows,
      // A resumed terminal holds a conversation from its first frame, so it is
      // used already: another Earlier click never replaces it.
      ...(resumeAgentSessionId ? { agentSessionId: resumeAgentSessionId, resuming: true, hasUserInput: true } : {}),
      // The shell the command was built for, and where its CLI runs.
      shell,
      cliTarget: toStoredCliTarget(cliTarget),
    });

    // A shell that could not start (a configured shell not on PATH) comes back
    // as an exited row with no PTY, and its exit was announced before this
    // returned, so neither caller would ever see it: the desktop window waited
    // on its launch shimmer for good. End the row here, as a PTY that exits on
    // its own ends, and fail the start so both callers report it.
    if (session.status === 'exited') {
      context.sessionManager.endCommandTerminal(session.id);
      throw new CommandTerminalStartError(
        'spawn-failed',
        `The terminal's shell "${shell}" did not start; check it in Settings > Terminal.`,
      );
    }

    resumedSessionId = session.id;
    // A resumed terminal keeps the name it had. Seeded before any prompt, so
    // the namer (first write wins) leaves it alone.
    if (resume?.label) context.sessionManager.setCommandTerminalLabel(session.id, resume.label);

    // Volume for these sessions comes from session_spawn (isTransient: true),
    // adoption from this feature; the old transient_session_spawn event was a
    // third answer to the same question and was removed rather than renamed.
    trackFeatureUsed('command_terminal');
    return { session, slot: reservation.slot, branch, ...(checkoutError ? { checkoutError } : {}) };
  } finally {
    // The spawned row now holds the slot itself (it is in the registry), and a
    // failed start must free it.
    reservation.release();
    if (claimedConversation) context.commandTerminalHistory?.settleResume(input.projectId, claimedConversation, resumedSessionId);
    if (claimedPredecessor) context.commandTerminalHistory?.settleResume(input.projectId, claimedPredecessor, resumedSessionId);
  }
}

/**
 * The earlier conversation a resume picks up, or the refusal. Read from the
 * project's own history (command-terminal-history.ts), never from the renderer.
 */
async function resolveResumedConversation(
  context: IpcContext,
  projectId: string,
  agentSessionId: string,
): Promise<{ agentSessionId: string; agentName: string; label: string | null; cliTarget: string | null; cwd: string }> {
  const history = context.commandTerminalHistory;
  const row = history?.find(projectId, agentSessionId) ?? null;
  const adapter = row ? agentRegistry.get(row.agent_name) : undefined;
  // The transcript too: an agent purges old ones, and one gone since the list
  // was read would start a resume the CLI cannot find.
  const resumable = history && row && adapter && canResumeConversationById(adapter)
    ? await history.conversationAvailable(row)
    : false;
  if (!row || !resumable) {
    throw new CommandTerminalStartError('conversation-gone', 'That conversation can no longer be resumed.');
  }
  return { agentSessionId: row.agent_session_id, agentName: row.agent_name, label: row.label, cliTarget: row.cli_target ?? null, cwd: row.cwd };
}

/** The branch the checkout is on, or "unknown" when git cannot say. */
async function readCheckedOutBranch(git: GitClient): Promise<string> {
  try {
    return (await git.revparse(['--abbrev-ref', 'HEAD'])).trim();
  } catch {
    return 'unknown';
  }
}

/**
 * Fetch and check out the branch a COLD start runs on, and report where it
 * actually landed. Reattaching to a live PTY never comes through here, so a
 * reattach can never move HEAD out from under a running agent.
 *
 * Never throws: every failure falls back to whatever is checked out, with the
 * reason in `checkoutError`, because a terminal that will not launch over a git
 * problem is worse than one on the wrong branch.
 *
 * The checkout and merge run repository hooks, so git starts through `gitAt`
 * (`execFileAsync`), whose env never carries Crashpad's pipe name
 * (child-env.ts). simple-git can only be given an env through `.env()`, which
 * refuses one carrying `EDITOR`, `VISUAL`, `PAGER` or any `GIT_*` key.
 */
async function checkOutStartBranch(
  context: IpcContext,
  projectRoot: string,
  input: StartCommandTerminalInput,
): Promise<{ branch: string; checkoutError?: string }> {
  const git = gitAt(projectRoot);
  // The board-overlaid default, the same chain every task spawn and the
  // renderer's branch pill resolve, so main's checkout target and the pill's
  // default cannot disagree when kangentic.json sets the base.
  const targetBranch = input.branch || resolveProjectDefaultBaseBranch(context, projectRoot);
  const unattended = input.unattended === true;
  const gitDeadline = Date.now() + UNATTENDED_GIT_BUDGET_MS;
  const pastDeadline = (): boolean => unattended && Date.now() > gitDeadline;

  const readCurrentBranch = (): Promise<string> => readCheckedOutBranch(git);

  // A phone start never moves HEAD under another live agent in this folder.
  // Nobody is at the desk to see the branch change under it, so it starts
  // where that agent is working instead.
  if (unattended && projectRootIsShared(context, projectRoot)) {
    const currentBranch = await readCurrentBranch();
    if (currentBranch === targetBranch) return { branch: currentBranch };
    return {
      branch: currentBranch,
      checkoutError: `Staying on "${currentBranch}": another agent is running in the project folder, so this terminal did not switch to "${targetBranch}".`,
    };
  }

  // Fetch latest from origin and checkout the requested branch before spawning.
  // This ensures Claude Code loads up-to-date commands/skills from the remote.
  // Best-effort and throttled; an unattended fetch can neither prompt nor run
  // past the phone's budget.
  const startPoint = unattended
    ? await fetchIfStale(git, projectRoot, targetBranch, {
      nonInteractive: true,
      signal: AbortSignal.timeout(UNATTENDED_FETCH_TIMEOUT_MS),
    })
    : await fetchIfStale(git, projectRoot, targetBranch);

  try {
    const currentBranch = (await git.revparse(['--abbrev-ref', 'HEAD'])).trim();
    if (currentBranch !== targetBranch && pastDeadline()) return gitTookTooLong(currentBranch, targetBranch);
    // An AUTO checkout (no branch picked) has no user gesture behind it beyond
    // opening a terminal, and a plain `git checkout` carries non-conflicting
    // uncommitted changes onto the base branch silently, so someone with work
    // in progress on a feature branch would find it sitting on the base. Stay
    // put when tracked files are modified. An explicit picker choice keeps
    // git's own behavior (and the failure toast below). Probed only when a
    // switch is actually due; untracked files do not count, matching
    // WorktreeManager.checkoutBranch.
    const stayPut = currentBranch !== targetBranch && !input.branch && (await hasTrackedChanges(git));
    if (stayPut) {
      return {
        branch: currentBranch,
        checkoutError: `Staying on "${currentBranch}": the working tree has uncommitted changes, so this terminal did not switch to "${targetBranch}".`,
      };
    }
    if (currentBranch !== targetBranch) {
      if (pastDeadline()) return gitTookTooLong(currentBranch, targetBranch);
      await git.checkout(targetBranch);
    }

    // Fast-forward merge to incorporate fetched remote changes. Skipped on
    // the stay-put paths above: it would fast-forward the WRONG branch.
    if (startPoint.startsWith('origin/') && !pastDeadline()) {
      try {
        await git.merge([startPoint, '--ff-only']);
      } catch {
        // ff-only failed (dirty tree, diverged history) - use local state
      }
    }
    return { branch: targetBranch };
  } catch (error) {
    // Checkout may fail (dirty working tree, branch doesn't exist locally)
    // Fall back to whatever branch is currently checked out
    const branch = await readCurrentBranch();
    // Git's own text is multi-line and names paths, so it goes to the log and
    // the toast body stays one sentence, shaped like the refusals above.
    console.warn(`[COMMAND_TERMINAL] checkout of "${targetBranch}" failed:`, error);
    return {
      branch,
      checkoutError: `Staying on "${branch}": git could not switch this terminal to "${targetBranch}".`,
    };
  }
}

/**
 * Transient sessions are the agent terminals spawned from the command bar
 * (Ctrl+Shift+P) or a paired phone. They run at the project root with no task
 * association and no `sessions` row; the conversations they held are recorded
 * apart (command-terminal-history.ts) so an ended one can be resumed.
 */
export function registerTransientSessionHandlers(context: IpcContext): void {
  // The panel's Earlier list. A read: it changes nothing, and a project the
  // desktop does not have open answers too.
  // A project id that names no project gets an empty list, never a database
  // file opened (and created) for it.
  ipcMain.handle(IPC.COMMAND_TERMINAL_HISTORY_LIST, (_, projectId: unknown) => {
    if (typeof projectId !== 'string' || !context.projectRepo.getById(projectId)) return [];
    return context.commandTerminalHistory?.list(projectId) ?? [];
  });

  // Routed by the input's project, never the one the main window shows: a
  // detached Command Terminal window starts terminals for its own project
  // whatever the board is on, the welcome screen included. An unknown project
  // is refused inside, as a phone's start is.
  ipcMain.handle(IPC.SESSION_SPAWN_TRANSIENT, async (_, input: SpawnTransientSessionInput) =>
    startCommandTerminal(context, input));

  // The branch the terminal's checkout is actually on, re-derived from live
  // HEAD by the renderer. A passive holder, last write wins: the Monitor row
  // and a post-reload adopt read it back.
  ipcMain.handle(IPC.SESSION_SET_TRANSIENT_BRANCH, (_, sessionId: string, branch: string) => {
    context.sessionManager.setCommandTerminalBranch(sessionId, branch);
  });

  // The user renames a terminal, from its header, its ... menu or its rail row.
  // By session id: the history row the rename updates is found through the
  // session's own project, never the board the main window shows. Null is a
  // clear; anything else that is not a string is refused rather than read as
  // one, since a clear also turns the namer off for good.
  ipcMain.handle(IPC.SESSION_RENAME_TRANSIENT, (_, sessionId: unknown, name: unknown) => {
    if (typeof sessionId !== 'string' || (name !== null && typeof name !== 'string')) return false;
    return context.sessionManager.renameCommandTerminal(sessionId, name);
  });

  ipcMain.handle(IPC.SESSION_KILL_TRANSIENT, (_, sessionId: string) => {
    // The handler returns at once - the window closes at once - and only the
    // session directory's delete waits for the shell (endCommandTerminal). An
    // id with no live row is a no-op, as it always was; a task's session is
    // refused, since this channel ends a Command Terminal and nothing else.
    const outcome = context.sessionManager.endCommandTerminal(sessionId);
    if (outcome === 'not-command-terminal') throw new Error('Not a Command Terminal session');
  });

  // Session-keyed model/effort injection for transient (command-terminal)
  // sessions. These have no task row, so the task-keyed
  // TASK_SET_RUNTIME_OVERRIDE handler cannot serve them. A Command Terminal
  // keeps no settings record (a resumed one starts on the project defaults),
  // so this is a best-effort live slash-command inject only. Mutates no per-task state, so it does not
  // take a task lock.
  ipcMain.handle(
    IPC.SESSION_INJECT_SETTINGS,
    async (_, input: SessionInjectSettingsInput): Promise<SessionInjectSettingsResult> => {
      // Prefer the live session's actual agent (recorded at spawn); fall back
      // to the agent the renderer resolved (the project default) if the
      // registry has no record for this session.
      const resolvedAgentName = context.sessionManager.getSessionAgentName(input.sessionId) ?? input.agent;
      const adapter = agentRegistry.get(resolvedAgentName);
      if (!adapter) {
        return { ok: false, reason: `unknown agent "${resolvedAgentName}"` };
      }

      // The PTY must be live for an inject to land. Transient sessions live in
      // the session manager but carry no DB row, so look them up directly.
      const session = context.sessionManager.getSession(input.sessionId);
      if (!session) {
        return { ok: false, reason: 'session not found' };
      }

      const currentModel = input.currentModel ?? null;
      const currentEffort = input.currentEffort ?? null;
      const nextModel = input.model !== undefined ? input.model : currentModel;
      const nextEffort = input.effort !== undefined ? input.effort : currentEffort;
      const spec: SettingsChangeSpec = {
        model: nextModel,
        modelChanged: input.model !== undefined && input.model !== currentModel,
        effort: nextEffort,
        effortChanged: input.effort !== undefined && input.effort !== currentEffort,
      };

      const sequence = adapter.getInjectionSequence?.(spec) ?? [];
      if (sequence.length === 0) return { ok: true, injected: false };

      // Best-effort live injection. Transient sessions have no DB row, so the
      // command-injection verifier (which needs a SessionRepository + task id)
      // cannot be used; schedule without one, mirroring the auto_command path.
      // The scheduler keys its coalesce/cancel map by the first argument, so
      // we pass the sessionId there as well as the PTY target.
      // A Command Terminal has no task row, so there is nothing to persist an
      // outcome against and no escalation target: its delivery is inherently
      // `unconfirmed`. It still inherits the handshake chain and clear policy,
      // because those live in `submitKeystrokes` rather than here.
      context.terminalSubmitScheduler.scheduleKeystrokes(
        input.sessionId,
        input.sessionId,
        sequence.map((text) => ({ text, verify: 'none' as const })),
        {},
      );
      return { ok: true, injected: true };
    },
  );
}

/**
 * Whether the working tree has modifications to TRACKED files (staged or not).
 * Untracked files are ignored: a checkout carries them along harmlessly, and
 * counting them would pin every terminal to its current branch the moment a
 * build artifact appears. The same filter `WorktreeManager.checkoutBranch` and
 * `TASK_UPDATE_FROM_BASE` use.
 */
async function hasTrackedChanges(git: Pick<GitClient, 'status'>): Promise<boolean> {
  const status = await git.status();
  return status.files.some((file) => file.index !== '?' && file.working_dir !== '?');
}
