import fs from 'node:fs';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import type { IpcContext } from '../ipc/ipc-context';
import type { ActivityState, Session, Workflow, WorkflowAgentStatus, WorkflowAgentSummary } from '../../shared/types';
import { resolveProjectRoot } from '../../shared/git-utils';
import { workflowAgentPromptTemplate } from '../../shared/workflow-agent-prompt';
import { workflowAgentChoice, workflowAgentSetupGap } from '../../shared/workflow-agent-choice';
import { awaitsFirstAgent } from '../../shared/workflow-agent-first-open';
import { WORKFLOW_REFUSALS } from '../../shared/workflow-refusals';
import { isActive } from '../../shared/activity-state';
import { getExistingProjectDb, getProjectDb } from '../db/database';
import { WorkflowRepository } from '../db/repositories/workflow-repository';
import { UsageHistoryRepository } from '../db/repositories/usage-history-repository';
import { captureWorkflowAgentUsage } from '../ipc/handlers/session-metrics';
import { agentRegistry } from '../agent/agent-registry';
import { listAgents } from '../agent/agent-list';
import { canBeWorkflowAgent } from '../agent/shared/workflow-agent-capability';
import { retrievalClient } from '../retrieval/retrieval-client';
import { collectRemoteTargets } from '../retrieval/remote-targets';
import { resolveShimLaunch } from '../agent/shared/shim-launch';
import { resolveCliTarget, shellForTarget, toStoredCliTarget, type CliTarget } from '../agent/shared/cli-target';
import { appendWorkflowAgentCaller } from '../agent/mcp-http/caller-url';
import { releaseCommandHold } from '../pty/lifecycle/adapter-lifecycle';
import { buildWorkflowAgentContinueMessage, buildWorkflowAgentFirstMessage } from './workflow-agent-prompt';
import { workflowTasks } from './workflow-tasks';
import { notifyWorkflowChanged } from './workflow-changed';
import { forgetWorkflowAgentEffort, recordWorkflowAgentEffort } from './workflow-agent-effort';

/**
 * A workflow's own agent: the agent that plans it, in the Workflows view's left
 * pane (#732, boards 1b and J2).
 *
 * It runs as a transient session, which keeps it out of everything a task
 * session drives (the `sessions` table, whose `task_id` is a foreign key to
 * tasks; turn-end automations; activity intervals; notifications), and carries
 * `workflowId`, which keeps it out of everything a Command Terminal has (a window
 * slot, the title-bar count, the Monitor). See src/shared/session-owner.ts. Its
 * conversation is recorded on the workflow itself (`agent_name`,
 * `agent_session_id`), so it resumes by id however its session ended.
 *
 * It runs in the home project's checkout with no worktree and changes only its
 * own workflow's plan, through the MCP server's `workflow-` caller scope. Any
 * agent that reaches that server with a URL of its own and can resume its
 * conversation can be it (`canBeWorkflowAgent`). Where the adapter can enforce
 * it, the launch is read-only (`readOnly`: no edit or shell tools); every other
 * agent runs in its own default mode, and the first message asks it to leave
 * files alone.
 *
 * It is not resumed at boot, since nothing reads it until its view does: the
 * view's pane opens it, which resumes the conversation when there is one and
 * otherwise starts it with the first message.
 */

/** The grid the pane measured, so the agent's first frame is drawn at its size. */
export interface WorkflowAgentGrid {
  cols?: number;
  rows?: number;
}

/** One open at a time per workflow: a pane remount must not start a second agent. */
const opening = new Map<string, Promise<WorkflowAgentStatus>>();

/** The home project of each open in flight, so a project delete waits for it too. */
const openingProjects = new Map<string, string>();

/**
 * Workflows whose agent the user paused, until they resume it. A restart for
 * read access suspends the agent and starts it again; a Pause pressed in that
 * window must win, not be undone by the restart.
 */
const userPaused = new Set<string>();

/** Sessions spawned as a resume, until they end. A resume the CLI cannot honour ends here. */
const resumedSessions = new Map<string, { homeProjectId: string; workflowId: string; grid: WorkflowAgentGrid }>();

/** The other checkouts each workflow's running agent was started able to read, by workflow id. */
const grantedDirectories = new Map<string, ReadonlySet<string>>();

/** A restart owed at the agent's next idle, to read more checkouts, with the line it is told after it. */
const pendingAccess = new Map<string, { homeProjectId: string; message: string }>();

/** The grid each workflow's agent last started at, so a restart keeps the pane's size. */
const lastGrid = new Map<string, WorkflowAgentGrid>();

/** When each workflow's agent last finished a turn, in this run of the app. */
const lastReplyAt = new Map<string, string>();

/** Each workflow agent session's last activity, so a turn's end is told from a resume settling idle. */
const agentActivity = new Map<string, ActivityState>();

/**
 * The session each workflow's agent started over in, by workflow id, after its
 * conversation could not be resumed. The pane says so while that session is the
 * agent's; a normal resume forgets it.
 */
const startedOverSessions = new Map<string, string>();

/** The agent as the picker's note names it: active, idle (and since when), or paused; and the session it started over in, if it did. */
export function workflowAgentSummary(context: IpcContext, workflowId: string): WorkflowAgentSummary | null {
  const session = findWorkflowAgentSession(context, workflowId);
  if (!session) return null;
  const replied = lastReplyAt.get(workflowId) ?? null;
  const startedOverSessionId = startedOverSessions.get(workflowId) === session.id ? session.id : null;
  if (session.status === 'suspended') return { state: 'paused', lastReplyAt: replied, startedOverSessionId };
  if (session.status !== 'running') return null;
  const active = isActive(context.sessionManager.getActivityCache()[session.id]);
  return { state: active ? 'active' : 'idle', lastReplyAt: replied, startedOverSessionId };
}

/** Another project's checkout the workflow agent reads. */
export interface ReadableProject {
  projectId: string;
  name: string;
  path: string;
}

/**
 * The other projects' checkouts a workflow's agent reads beyond its own: every
 * project one of its tasks is on (planned or created), and every one it asked
 * for (`agent_read_project_ids`). A checkout gone from disk is left out, since
 * the CLI refuses to start with a directory that does not exist.
 */
export function readableProjectsOf(context: IpcContext, homeProjectId: string, workflow: Workflow): ReadableProject[] {
  const projectIds = new Set<string>();
  for (const planned of workflow.draft?.tasks ?? []) {
    if (planned.project_id) projectIds.add(planned.project_id);
  }
  for (const { projectId } of workflowTasks(context, homeProjectId, workflow.id)) projectIds.add(projectId);
  for (const projectId of workflow.agent_read_project_ids) projectIds.add(projectId);
  projectIds.delete(homeProjectId);
  const readable: ReadableProject[] = [];
  for (const projectId of projectIds) {
    const project = context.projectRepo.getById(projectId);
    if (!project) continue;
    const projectRoot = resolveProjectRoot(project.path);
    if (!fs.existsSync(projectRoot)) continue;
    readable.push({ projectId, name: project.name, path: projectRoot });
  }
  return readable;
}

/** What a request for another project's code came to. */
export interface ProjectAccessResult {
  name: string;
  path: string;
  /**
   * `home`: its own project. `already`: its running agent reads it. `now` and
   * `next-turn`: its agent restarts with it, at once (idle) or when its turn
   * ends. `next-start`: no agent runs; the next start reads it. `unsupported`:
   * the agent's CLI cannot read another checkout.
   */
  when: 'home' | 'already' | 'now' | 'next-turn' | 'next-start' | 'unsupported';
}

/**
 * Let a workflow's agent read another registered project's checkout: granted at
 * once with no approval, and kept on the workflow so a resume reads it too (#732,
 * the user's call: the workflow's projects, plus any registered project it needs,
 * automatically). A running agent picks it up at its next idle, resumed on its
 * own conversation with the directory added and told it is ready, so it carries
 * on by itself.
 */
export function requestWorkflowAgentProjectAccess(
  context: IpcContext,
  homeProjectId: string,
  workflowId: string,
  projectId: string,
): ProjectAccessResult {
  const project = context.projectRepo.getById(projectId);
  if (!project) throw new Error('That project is no longer in Kangentic.');
  const projectRoot = resolveProjectRoot(project.path);
  if (projectId === homeProjectId) return { name: project.name, path: projectRoot, when: 'home' };
  // The home is the id the agent's scope names, which can outlive its project.
  const homeDb = getExistingProjectDb(homeProjectId);
  if (!homeDb) throw new Error('This workflow no longer exists.');
  new WorkflowRepository(homeDb).addAgentReadProject(workflowId, projectId);
  return { name: project.name, path: projectRoot, when: syncWorkflowAgentAccess(context, homeProjectId, workflowId) };
}

/**
 * Compare what the workflow's running agent reads with what it should, and owe
 * it a restart when it lacks a checkout: at once when it is idle, otherwise at
 * its next idle (the `'activity'` listener in `registerWorkflowAgentLifecycle`).
 */
function syncWorkflowAgentAccess(context: IpcContext, homeProjectId: string, workflowId: string): ProjectAccessResult['when'] {
  const session = findWorkflowAgentSession(context, workflowId);
  if (!session || session.status !== 'running') return 'next-start';
  const agentName = context.sessionManager.getSessionAgentName(session.id);
  const adapter = agentName ? agentRegistry.get(agentName) : undefined;
  if (!adapter?.supportsReadableDirectories) return 'unsupported';
  // A restart resumes the agent's conversation by its recorded id. With none
  // recorded yet it would begin a new conversation and drop the one running,
  // so the grant waits for the agent's next start.
  if (!recordedConversationId(homeProjectId, workflowId)) return 'next-start';
  const missing = missingCheckouts(context, homeProjectId, workflowId);
  if (!missing) return 'next-start';
  if (missing.length === 0) return 'already';
  const list = missing.map((readable) => `${readable.name} at ${readable.path}`).join(', ');
  pendingAccess.set(workflowId, {
    homeProjectId,
    message: `Kangentic restarted you on this conversation so you can read ${list}. Carry on where you left off.`,
  });
  if (isActive(context.sessionManager.getActivityCache()[session.id])) return 'next-turn';
  setImmediate(() => void restartWithAccess(context, workflowId));
  return 'now';
}

/**
 * The checkouts the workflow's agent should read that its running process was
 * not started with, or null when the workflow is gone.
 */
function missingCheckouts(context: IpcContext, homeProjectId: string, workflowId: string): ReadableProject[] | null {
  const homeDb = getExistingProjectDb(homeProjectId);
  const workflow = homeDb ? new WorkflowRepository(homeDb).getById(workflowId) : undefined;
  if (!workflow) return null;
  const granted = grantedDirectories.get(workflowId) ?? new Set<string>();
  return readableProjectsOf(context, homeProjectId, workflow).filter((readable) => !granted.has(readable.path));
}

/** Resume the agent on its conversation with the checkouts it is owed, and tell it so. */
async function restartWithAccess(context: IpcContext, workflowId: string): Promise<void> {
  const pending = pendingAccess.get(workflowId);
  if (!pending) return;
  pendingAccess.delete(workflowId);
  const session = findWorkflowAgentSession(context, workflowId);
  // A paused agent reads the grant when it is resumed, from the workflow row.
  if (!session || session.status !== 'running' || userPaused.has(workflowId)) return;
  // The idle edge that scheduled this ran a tick ago: a prompt the user sent
  // since has started a turn, and a restart now would cut it off. Owe it again
  // for the next idle.
  if (isActive(context.sessionManager.getActivityCache()[session.id])) {
    pendingAccess.set(workflowId, pending);
    return;
  }
  // A start since this was owed (a Resume after a Pause) read the grant from
  // the workflow row, so the running agent may already have every checkout.
  let missing: ReadableProject[] | null;
  try {
    missing = missingCheckouts(context, pending.homeProjectId, workflowId);
  } catch {
    // Its project's database is closing under a delete.
    return;
  }
  if (!missing?.length) return;
  let suspended = false;
  try {
    captureSpend(context, session);
    await context.sessionManager.suspend(session.id);
    suspended = true;
    // A Pause pressed while it stopped is the user's, and stands. The resume
    // reads the grant from the workflow row; only this one line is not said.
    // One pressed while the start below finds the CLI stands too: the start
    // checks again before it spawns.
    if (userPaused.has(workflowId)) return;
    // An open already in flight (the user's Resume) starts it with the grant,
    // so this start joins that one, and the line is not said either.
    const restarted = await startOnce(context, pending.homeProjectId, workflowId, lastGrid.get(workflowId) ?? {}, pending.message);
    // A start that cannot run (the MCP server turned off, the CLI gone, the
    // Workflow agent setting no longer complete) leaves the agent suspended, as
    // a Pause would, and the pane offers Resume or asks for the setting. Nothing
    // is owed: that start reads the grant. A start a Pause stopped after the
    // agent ended has no reason to give.
    if (restarted.unavailable || restarted.setupNeeded) {
      const reason = restarted.unavailable ?? 'the Workflow agent setting is not complete';
      console.warn(`[WORKFLOW-AGENT] Stopped to read new project access, but could not start again: ${reason}`);
    }
  } catch (error) {
    console.error('[WORKFLOW-AGENT] Could not restart with the new project access:', error);
    // A suspend that failed leaves the agent running without the access it was
    // promised. Owe it again, so its next idle edge retries. Once the suspend
    // worked nothing is owed: a start that threw after its spawn left an agent
    // that has the access, and one that threw before it left the agent
    // suspended, so its next start reads the grant from the workflow row.
    if (!suspended && findWorkflowAgentSession(context, workflowId)?.status === 'running' && !pendingAccess.has(workflowId)) {
      pendingAccess.set(workflowId, pending);
    }
  }
}

function unavailable(reason: string): WorkflowAgentStatus {
  return { session: null, unavailable: reason, setupNeeded: false, startsOnRequest: false };
}

/** Nothing started because the Workflow agent setting is not complete: the pane asks for it. */
function setupNeeded(): WorkflowAgentStatus {
  return { session: null, unavailable: null, setupNeeded: true, startsOnRequest: false };
}

/** Nothing started because no agent has seen the workflow's plan (`planNoAgentHasSeen`): the pane offers Ask for changes. */
function startsOnRequest(): WorkflowAgentStatus {
  return { session: null, unavailable: null, setupNeeded: false, startsOnRequest: true };
}

/** The agent as it is: a session (running, queued or paused), or none when a Pause stopped the start. */
function sessionStatus(session: Session | null): WorkflowAgentStatus {
  return { session, unavailable: null, setupNeeded: false, startsOnRequest: false };
}

/**
 * Refuse a change to the plan made in the view while the workflow's agent is
 * mid-turn (#732, board 2c): it works from what it read when the turn began, so
 * a hand edit meanwhile would leave it building on a plan that no longer exists.
 * The view disables these controls; this is the check a stale click cannot slip
 * past. The agent's own saves come over MCP and are never held.
 */
export function requireWorkflowAgentIdle(context: IpcContext, workflowId: string): void {
  const session = findWorkflowAgentSession(context, workflowId);
  if (!session || session.status !== 'running') return;
  if (isActive(context.sessionManager.getActivityCache()[session.id])) {
    throw new Error(`${WORKFLOW_REFUSALS.agentWorking}.`);
  }
}

/** The workflow's agent session that has not exited, if any (running, queued or paused). */
export function findWorkflowAgentSession(context: IpcContext, workflowId: string): Session | null {
  return context.sessionManager.listSessions()
    .find((session) => session.workflowId === workflowId && session.status !== 'exited') ?? null;
}

/**
 * What the view's pane shows when it opens: the agent as it is, or, when it has
 * no session at all (a new workflow, a restart, an agent that exited), started.
 * A paused agent stays paused; Resume is the user's. A plan no agent has seen
 * starts nothing until the user asks (`planNoAgentHasSeen`).
 */
export function openWorkflowAgent(
  context: IpcContext,
  homeProjectId: string,
  workflowId: string,
  grid: WorkflowAgentGrid,
): Promise<WorkflowAgentStatus> {
  const existing = findWorkflowAgentSession(context, workflowId);
  if (existing) return Promise.resolve(sessionStatus(existing));
  // A start already on its way (Ask for changes, then the pane remounted before
  // it spawned) has no session or recorded agent yet: join it, rather than
  // answer that nothing started. Joining starts nothing of its own, so a Pause
  // pressed during that start stands (`honorPausePressedDuringSpawn`).
  const pending = opening.get(workflowId);
  if (pending) return pending;
  if (planNoAgentHasSeen(context, homeProjectId, workflowId)) return Promise.resolve(startsOnRequest());
  // A Pause recorded with no agent to stop, or for one since gone, is not this
  // new agent's: kept, it would turn away every restart for read access.
  userPaused.delete(workflowId);
  return startOnce(context, homeProjectId, workflowId, grid);
}

/**
 * A plan that no workflow agent has seen (`awaitsFirstAgent`). Opening the view
 * starts nothing for it, since the agent's first turn would hold Start and every
 * plan edit while it read a plan the user came to run. A missing workflow is
 * left to the start, which says why it cannot run. The boards are read only for
 * a started workflow with no agent, since a draft's tasks are on its row.
 */
function planNoAgentHasSeen(context: IpcContext, homeProjectId: string, workflowId: string): boolean {
  const homeDb = getExistingProjectDb(homeProjectId);
  const workflow = homeDb ? new WorkflowRepository(homeDb).getById(workflowId) : undefined;
  if (!workflow || workflow.agent_name !== null) return false;
  const taskCount = workflow.state === 'draft'
    ? workflow.draft?.tasks.length ?? 0
    : workflowTasks(context, homeProjectId, workflowId).length;
  return awaitsFirstAgent(workflow, taskCount);
}

/**
 * The pane's Resume: a paused or exited agent comes back on its conversation.
 * Also its Ask for changes, which starts the agent on a plan no agent has seen.
 */
export function resumeWorkflowAgent(
  context: IpcContext,
  homeProjectId: string,
  workflowId: string,
  grid: WorkflowAgentGrid,
): Promise<WorkflowAgentStatus> {
  userPaused.delete(workflowId);
  const existing = findWorkflowAgentSession(context, workflowId);
  if (existing && existing.status !== 'suspended') return Promise.resolve(sessionStatus(existing));
  return startOnce(context, homeProjectId, workflowId, grid);
}

/** The pane's Pause: the agent stops and frees its slot; its conversation is kept. */
export async function pauseWorkflowAgent(context: IpcContext, workflowId: string): Promise<void> {
  // Recorded even when the agent already reads suspended: a restart for read
  // access suspends it on the way to starting it again, and must not.
  userPaused.add(workflowId);
  const session = findWorkflowAgentSession(context, workflowId);
  if (!session || session.status === 'suspended') return;
  captureSpend(context, session);
  await context.sessionManager.suspend(session.id);
}

/**
 * Write the agent's spend to its home project's ledger (Stats), before a stop
 * clears its live usage. The 45-second snapshot covers it while it runs.
 */
function captureSpend(context: IpcContext, session: Session): void {
  const tracked = withConversationId(session);
  try {
    captureWorkflowAgentUsage(context.sessionManager, new UsageHistoryRepository(getProjectDb(tracked.projectId)), tracked);
  } catch {
    // Best-effort: a project database closing under a quit or a delete.
  }
  recordTurnTokens(context, tracked);
}

/**
 * The session with the conversation id its spend and turns are filed under:
 * its own, else the one its workflow recorded. A resumed agent whose CLI chose
 * its own id may not report it again on that run, which would leave the live
 * session's id empty and its spend unrecorded. A new conversation not yet
 * reported has no recorded id either, so nothing is filed under an old one.
 */
function withConversationId(session: Session): Session {
  if (session.agentSessionId || !session.workflowId) return session;
  try {
    const recorded = recordedConversationId(session.projectId, session.workflowId);
    return recorded ? { ...session, agentSessionId: recorded } : session;
  } catch {
    // A project database closing under a quit or a delete.
    return session;
  }
}

/** The conversation id the workflow resumes its agent by, or null when none is recorded. */
function recordedConversationId(homeProjectId: string, workflowId: string): string | null {
  const homeDb = getExistingProjectDb(homeProjectId);
  return homeDb ? new WorkflowRepository(homeDb).getById(workflowId)?.agent_session_id ?? null : null;
}

/**
 * Its turns' tokens into the ledger Stats reads, in the retrieval worker, off
 * main. A task's turns get there through the conversation indexer; this agent
 * has no session record, and its planning conversation stays out of the
 * Knowledge Graph. Fire and forget: a missed write is recovered by the next
 * stop of the same conversation, since the ledger upserts by turn.
 */
function recordTurnTokens(context: IpcContext, session: Session): void {
  const warn = (error: unknown): void => {
    console.warn(`[WORKFLOW-AGENT] Could not record the agent's turn tokens for ${session.id.slice(0, 8)}:`, error);
  };
  // Never throws: it runs on Pause, on end and in the exit listener.
  try {
    const agentName = context.sessionManager.getSessionAgentName(session.id);
    const sessionType = agentName ? agentRegistry.get(agentName)?.sessionType : undefined;
    if (!sessionType || !session.agentSessionId || !session.cwd) return;
    retrievalClient.call('index.workflowAgentTurns', {
      projectId: session.projectId,
      sessionId: session.id,
      agentSessionId: session.agentSessionId,
      sessionType,
      cwd: session.cwd,
      cliTarget: context.sessionManager.getSessionCliTarget(session.id),
      remoteTargets: collectRemoteTargets(agentRegistry),
    }).catch(warn);
  } catch (error) {
    warn(error);
  }
}

/**
 * End the agent for good, when its workflow is deleted or finishes, or its
 * project is deleted. Kill, capture the exit, then remove (the row must still
 * exist when the exit is awaited), and delete its session folder once the
 * process is gone.
 */
export async function endWorkflowAgent(context: IpcContext, workflowId: string): Promise<void> {
  // An open still on its way (detection, trust, the shim) spawns after this
  // call would have looked, so wait for it and end what it started.
  const inFlight = opening.get(workflowId);
  if (inFlight) await inFlight.catch(() => undefined);
  const sessions = context.sessionManager.listSessions().filter((session) => session.workflowId === workflowId);
  userPaused.delete(workflowId);
  grantedDirectories.delete(workflowId);
  pendingAccess.delete(workflowId);
  lastGrid.delete(workflowId);
  lastReplyAt.delete(workflowId);
  startedOverSessions.delete(workflowId);
  const exits: Promise<void>[] = [];
  for (const session of sessions) {
    resumedSessions.delete(session.id);
    captureSpend(context, session);
    context.sessionManager.kill(session.id);
    exits.push(context.sessionManager.awaitExit(session.id));
    context.sessionManager.remove(session.id);
  }
  await Promise.all(exits);
  for (const session of sessions) {
    try {
      fs.rmSync(path.join(session.cwd, '.kangentic', 'sessions', workflowId), { recursive: true, force: true });
    } catch {
      // Best-effort cleanup.
    }
  }
}

/** Every workflow agent of a project, for the project's delete. */
export async function endWorkflowAgentsOfProject(context: IpcContext, projectId: string): Promise<void> {
  const workflowIds = new Set(
    context.sessionManager.listSessions()
      .filter((session) => session.projectId === projectId && session.workflowId)
      .map((session) => session.workflowId as string),
  );
  // An agent still opening has no session yet; it would start in a project being deleted.
  for (const [workflowId, homeProjectId] of openingProjects) {
    if (homeProjectId === projectId) workflowIds.add(workflowId);
  }
  await Promise.all([...workflowIds].map((workflowId) => endWorkflowAgent(context, workflowId)));
}

function startOnce(
  context: IpcContext,
  homeProjectId: string,
  workflowId: string,
  grid: WorkflowAgentGrid,
  continuation?: string,
): Promise<WorkflowAgentStatus> {
  const pending = opening.get(workflowId);
  if (pending) return pending;
  const started = startWorkflowAgent(context, homeProjectId, workflowId, grid, continuation)
    .finally(() => {
      opening.delete(workflowId);
      openingProjects.delete(workflowId);
    });
  opening.set(workflowId, started);
  openingProjects.set(workflowId, homeProjectId);
  return started;
}

/**
 * `continuation` is the message a resumed agent gets on starting, when
 * Kangentic restarted it for a reason it should hear (new checkouts to read).
 * Only that restart passes one, so it also marks the start as Kangentic's own.
 */
async function startWorkflowAgent(
  context: IpcContext,
  homeProjectId: string,
  workflowId: string,
  grid: WorkflowAgentGrid,
  continuation?: string,
): Promise<WorkflowAgentStatus> {
  // The home is the id a pane or a resume named, which can outlive its project.
  const homeDb = getExistingProjectDb(homeProjectId);
  if (!homeDb) return unavailable('This workflow no longer exists.');
  const repository = new WorkflowRepository(homeDb);
  const workflow = repository.getById(workflowId);
  if (!workflow) return unavailable('This workflow no longer exists.');
  if (workflow.state === 'done') return unavailable(`${workflow.title} is complete.`);
  // With no grid measured for this start, the size it last ran at: the latest
  // resize recorded on the workflow, else this run's last start, so a start
  // after a restart draws its first frame at the pane's size rather than the
  // spawn default.
  if (grid.cols === undefined || grid.rows === undefined) {
    const recorded = repository.getAgentGrid(workflowId) ?? lastGrid.get(workflowId);
    if (recorded?.cols !== undefined && recorded.rows !== undefined) grid = { cols: recorded.cols, rows: recorded.rows };
  }
  const project = context.projectRepo.getById(homeProjectId);
  if (!project) return unavailable('This workflow\'s project is no longer in Kangentic.');

  const projectRoot = resolveProjectRoot(project.path);
  const config = context.configManager.getEffectiveConfig(projectRoot);
  // The Workflow agent setting, with no fallback to the project's default agent:
  // until it is complete nothing starts, and the pane asks for it
  // (`src/shared/workflow-agent-choice.ts`). The list is the cached inventory the
  // renderer reads too, warm from its bootstrap, so the pane and this check agree.
  const choice = workflowAgentChoice(config.workflows);
  const agents = await listAgents(config.agent.cliPaths);
  // `!choice.agent` repeats the gap's own first check so the line below reads it as a string.
  if (!choice.agent || workflowAgentSetupGap({ agents, choice })) return setupNeeded();
  // A conversation belongs to the agent that holds it, so a resume keeps that
  // agent even after the Workflow agent setting changed. Only while there is one
  // to resume: with no id recorded (the agent's own id was never captured), or
  // on an agent that can no longer be a workflow's agent, the next start is a
  // new conversation on the setting's agent, from the saved plan. The setting's
  // agent passed `workflowAgentSetupGap` above, so either way it can be one.
  const recordedAgentName = workflow.agent_session_id !== null ? workflow.agent_name : null;
  const recordedAdapter = recordedAgentName ? agentRegistry.get(recordedAgentName) : undefined;
  const keepsRecordedAgent = recordedAdapter !== undefined && canBeWorkflowAgent(recordedAdapter);
  const agentName = keepsRecordedAgent && recordedAgentName ? recordedAgentName : choice.agent;
  const adapter = agentRegistry.get(agentName);
  if (!adapter) return unavailable(`Kangentic does not know the agent "${agentName}".`);
  if (!config.mcpServer.enabled || !context.mcpServerHandle) {
    return unavailable('The workflow agent works through Kangentic\'s MCP server, which is off. Turn it on in Settings, MCP Server.');
  }
  const detection = await adapter.detect(config.agent.cliPaths[agentName] ?? null);
  if (!detection.found || !detection.path) return unavailable(`Kangentic cannot find ${adapter.displayName} on this machine.`);
  // Where the CLI runs (a WSL distro, for a CLI installed in one), resolved once
  // for this start, as the task spawns do. A distro that cannot be read says so
  // in the pane, in the distro's own words.
  let cliTarget: CliTarget | null;
  try {
    cliTarget = await resolveCliTarget(detection.path, adapter.supportsWslCli === true);
  } catch (error) {
    return unavailable(error instanceof Error ? error.message : String(error));
  }
  // An agent whose CLI would start here without Kangentic's tools could not save
  // a plan; it says why, and the user's fix is retried on the next Settings close.
  const mcpBlocked = adapter.kangenticMcpBlockedReason?.(projectRoot, cliTarget) ?? null;
  if (mcpBlocked) return unavailable(mcpBlocked);

  const resume = workflow.agent_session_id !== null && workflow.agent_name === agentName;
  // A new conversation's id, the safest way the CLI offers: Kangentic's own
  // where the CLI takes one, else one the CLI creates before launch, else none
  // yet. Without one the agent reports its own once it has it (hook, output or
  // session files), and the 'agent-session-id' listener records it.
  let agentSessionId: string | null = null;
  if (resume && workflow.agent_session_id) agentSessionId = workflow.agent_session_id;
  else if (adapter.supportsCallerSessionId) agentSessionId = uuidv4();
  else if (adapter.createSessionId) agentSessionId = await adapter.createSessionId(detection.path, projectRoot);
  // A new conversation for a workflow whose agent already ran (its id was never
  // captured, or its conversation could not be resumed) continues from the saved
  // plan, and the pane says it started over. `agent_name` outlives a lost id
  // (`forgetAgentSessionId`), so any start reads it the same way: the one that
  // replaces a failed resume, one that joined it, or a later one after it failed.
  const startsOver = !resume && workflow.agent_name !== null;
  // A resumed agent gets no first message (its conversation holds it), only the
  // reason Kangentic restarted it, when there is one. Any other start continues
  // from the saved plan when there is one: after a start-over, or on a plan no
  // agent has seen (another session saved it, or the user planned by hand). That
  // one says nothing in the pane, since nothing was lost. With no plan saved yet
  // the builder answers null, and the agent plans from the first message.
  let prompt: string | undefined = continuation;
  if (!resume) {
    const template = readWorkflowAgentTemplate(context);
    const continued = await buildWorkflowAgentContinueMessage(
      context, homeProjectId, workflow, template, startsOver ? 'not-resumed' : 'saved-elsewhere',
    );
    prompt = continued ?? buildWorkflowAgentFirstMessage(context, homeProjectId, workflow, template);
  }
  // The other boards' checkouts it may read; an agent whose CLI cannot widen
  // its reads gets none, and its own project only.
  const readable = adapter.supportsReadableDirectories ? readableProjectsOf(context, homeProjectId, workflow) : [];

  const shell = shellForTarget(cliTarget) ?? await context.sessionManager.getShell();
  const sessionDirectory = path.join(projectRoot, '.kangentic', 'sessions', workflow.id);
  // sync-write-ok: the agent's status and events bridges write into this
  // folder from the moment it starts; a failure throws to the IPC handler,
  // which rejects and the pane shows the reason.
  fs.mkdirSync(sessionDirectory, { recursive: true });
  const statusOutputPath = path.join(sessionDirectory, 'status.json');
  const eventsOutputPath = path.join(sessionDirectory, 'activity.json');

  // The same pre-spawn steps every spawn path runs before building a command.
  // The first message rides the command line, as a task's `{{task_xml}}` does,
  // with the same limits: 32,767 characters for a process, 8,191 under a
  // cmd.exe shell (the shim resolver moves PowerShell and Git Bash off a
  // `.cmd` shim, which cmd.exe would otherwise run).
  await adapter.ensureTrust(projectRoot, cliTarget);
  const launch = await resolveShimLaunch({ agentPath: detection.path, shell, prompt });
  // The chosen model and effort belong to the chosen agent (a model id means
  // nothing to another CLI), so a conversation kept on another agent runs at its
  // CLI's own defaults. Read on every start, so a Resume takes a changed setting.
  const choiceApplies = agentName === choice.agent;
  const sessionId = uuidv4();
  const commandOptions = {
    agentPath: launch.agentPath,
    taskId: workflow.id,
    prompt: launch.prompt,
    cwd: projectRoot,
    permissionMode: 'default' as const,
    projectRoot,
    sessionId: agentSessionId ?? undefined,
    resume,
    statusOutputPath,
    eventsOutputPath,
    shell,
    mcpServerEnabled: true,
    mcpServerUrl: appendWorkflowAgentCaller(context.mcpServerHandle.urlForProject(homeProjectId), workflow.id),
    mcpServerToken: context.mcpServerHandle.token,
    model: choiceApplies ? choice.model ?? undefined : undefined,
    effort: choiceApplies ? choice.effort ?? undefined : undefined,
    // Without edit or shell tools where the CLI can enforce it; every other
    // agent runs in its own default mode, and the prompt asks it to plan only.
    readOnly: adapter.supportsReadOnlyLaunch === true,
    readableDirectories: readable.map((entry) => entry.path),
    // The session's own id, minted here so the spawn below uses it too: a
    // folder-shared adapter file is held under it until the session ends.
    ptySessionId: sessionId,
    cliTarget,
  };
  const command = adapter.buildCommand(commandOptions);
  // From here until spawn() takes the command, a return or a throw releases
  // the hold it took. From the spawn() call on, spawn() releases a spawn that
  // never runs.
  let extraEnv: Record<string, string> | null;
  let replacedSessionIds: string[];
  try {
    extraEnv = adapter.buildEnv?.(commandOptions) ?? null;

    // Read again after the awaits above: the workflow may have finished, or been
    // deleted with its project, while the CLI was being found.
    if (!workflowStillOpen(context, homeProjectId, workflowId)) {
      releaseCommandHold(adapter, projectRoot, sessionId);
      return unavailable('This workflow no longer exists.');
    }
    // The restart for read access is the one start Kangentic makes on its own. A
    // Pause pressed while it found the CLI reached an agent that already read
    // suspended, so it stopped nothing, and it stands: the agent stays suspended,
    // and its next start reads the grant from the workflow row.
    const restartForAccess = continuation !== undefined;
    if (restartForAccess && userPaused.has(workflowId)) {
      releaseCommandHold(adapter, projectRoot, sessionId);
      return sessionStatus(findWorkflowAgentSession(context, workflowId));
    }
    // The rows this start replaces leave the registry with no removal push (the
    // spawn's sibling drain), so what is kept per session id goes with them here.
    replacedSessionIds = context.sessionManager.listSessions()
      .filter((existing) => existing.workflowId === workflowId)
      .map((existing) => existing.id);
  } catch (error) {
    releaseCommandHold(adapter, projectRoot, sessionId);
    throw error;
  }

  const session = await context.sessionManager.spawn({
    id: sessionId,
    taskId: workflow.id,
    projectId: homeProjectId,
    command,
    cwd: projectRoot,
    env: extraEnv ?? undefined,
    statusOutputPath,
    eventsOutputPath,
    resuming: resume,
    transient: true,
    workflowId: workflow.id,
    agentSessionId,
    agentParser: adapter,
    agentName: adapter.name,
    exitSequence: adapter.getExitSequence?.() ?? ['\x03'],
    cols: grid.cols,
    rows: grid.rows,
    // The shell the command was built for, and where its CLI runs.
    shell,
    cliTarget: toStoredCliTarget(cliTarget),
  });
  // What the spawned agent reads, recorded before anything below can throw:
  // it has these checkouts from here on, and a later grant compares against them.
  grantedDirectories.set(workflow.id, new Set(readable.map((entry) => entry.path)));
  lastGrid.set(workflow.id, grid);
  for (const replacedId of replacedSessionIds) {
    if (replacedId === session.id) continue;
    forgetWorkflowAgentEffort(replacedId);
    agentActivity.delete(replacedId);
    resumedSessions.delete(replacedId);
  }
  // The running agent's own bookkeeping comes before the one write below that
  // can throw, so a failed write still leaves an agent that is tracked.
  recordWorkflowAgentEffort(session.id, commandOptions.effort ?? null);
  // A resume that sends nothing is idle by contract, but `--resume` reloads the
  // conversation with no hooks while its token count grows, and the status
  // heartbeat forces that shape to thinking. Measured in the preview: 30 s of
  // "Workflow agent is working", with every plan edit held, until the
  // stale-thinking watchdog cleared it. Assert the idle, as the settings-change
  // restart does (`session-reconcile.ts`). Not sticky: a real turn clears it.
  if (resume && !prompt) context.sessionManager.markIdleAuthoritative(session.id);
  if (resume) {
    resumedSessions.set(session.id, { homeProjectId, workflowId: workflow.id, grid });
    // A resume ends what the pane said about an earlier start-over. One that
    // fails too starts over again, which says it again.
    startedOverSessions.delete(workflow.id);
  } else if (startsOver) {
    // The pane says the agent started a new conversation, from the summary this push reloads.
    startedOverSessions.set(workflow.id, session.id);
    notifyWorkflowChanged(homeProjectId, workflow.id);
  }
  try {
    // Recorded on every start, so a conversation from before `agent_cwd` existed
    // gains its checkout on its next resume. Recorded before a Pause below stops
    // the agent, so Resume finds the conversation to resume. An id the agent
    // reported while the spawn was awaited is already on the live row (and
    // recorded by the 'agent-session-id' listener); writing null over it would
    // lose the conversation.
    const knownAgentSessionId = agentSessionId ?? context.sessionManager.getSession(session.id)?.agentSessionId ?? null;
    repository.setAgentConversation(workflow.id, { agentName, agentSessionId: knownAgentSessionId, cwd: projectRoot });
  } finally {
    await honorPausePressedDuringSpawn(context, workflow.id, session.id);
  }
  return sessionStatus(context.sessionManager.getSession(session.id) ?? session);
}

/**
 * A Pause pressed while a start spawned found the row that start replaces,
 * already suspended, or no row at all, so it stopped nothing. It stands: the
 * new agent is suspended as soon as it exists. An open and a Resume clear the
 * Pause before they start (an open that joins this start clears nothing) and
 * the restart for read access checks it, so one recorded now was pressed during
 * this start, or, for a start-over, during the resume that failed. The row is read from the registry, since a Pause that
 * reached it suspended it already. Never throws: the start it ends has an agent
 * to report either way.
 */
async function honorPausePressedDuringSpawn(context: IpcContext, workflowId: string, sessionId: string): Promise<void> {
  if (!userPaused.has(workflowId)) return;
  const started = context.sessionManager.getSession(sessionId);
  if (!started || started.status === 'suspended' || started.status === 'exited') return;
  try {
    captureSpend(context, started);
    await context.sessionManager.suspend(started.id);
  } catch (error) {
    console.error('[WORKFLOW-AGENT] Could not pause the agent a Pause reached while it started:', error);
  }
}

/** The workflow is still there, unfinished, in a project still in Kangentic. */
function workflowStillOpen(context: IpcContext, homeProjectId: string, workflowId: string): boolean {
  if (!context.projectRepo.getById(homeProjectId)) return false;
  try {
    const workflow = new WorkflowRepository(getProjectDb(homeProjectId)).getById(workflowId);
    return Boolean(workflow) && workflow?.state !== 'done';
  } catch {
    // Its project's database is closing under a delete.
    return false;
  }
}

/** The first-message template: the user's own from Settings, or the default. */
function readWorkflowAgentTemplate(context: IpcContext): string {
  return workflowAgentPromptTemplate(context.configManager.load().workflows?.agentPrompt);
}

/**
 * Wire the agent's lifecycle to the session manager once, at startup.
 *
 * A resume whose conversation the CLI cannot find ends at once with the CLI
 * saying so (`describeStartupFailure`). The agent then starts a new
 * conversation from the saved plan, which the pane shows, rather than leaving a
 * dead pane whose Resume fails the same way every time, and the pane says it
 * started over (`WorkflowAgentSummary.startedOverSessionId`).
 *
 * An agent whose CLI chose its own session id reports it once it has one, and a
 * Claude conversation forked by `/clear` reports its new one; the workflow
 * records either, so a Resume reopens the conversation the agent is in.
 */
export function registerWorkflowAgentLifecycle(context: IpcContext): void {
  const startOverIfResumeFailed = (sessionId: string, exitCode: number): void => {
    const resumed = resumedSessions.get(sessionId);
    if (!resumed) return;
    resumedSessions.delete(sessionId);
    const agentName = context.sessionManager.getSessionAgentName(sessionId);
    const adapter = agentName ? agentRegistry.get(agentName) : undefined;
    const describeStartupFailure = adapter?.describeStartupFailure?.bind(adapter);
    if (!describeStartupFailure) return;
    void context.sessionManager.getRawScrollback(sessionId).then((rawScrollback) => {
      if (!describeStartupFailure(rawScrollback, exitCode)) return;
      // The user may have resumed it while the scrollback was read. Starting
      // over then would replace a live, young agent with no exit grace.
      const live = findWorkflowAgentSession(context, resumed.workflowId);
      if (live && live.id !== sessionId) return;
      try {
        // Read after an async scrollback read, by which time the home may be deleted.
        const homeDb = getExistingProjectDb(resumed.homeProjectId);
        if (!homeDb) return;
        // Only the id: the agent that ran stays recorded, which is what makes
        // the next start continue from the saved plan, even when this one
        // cannot start or another start already in flight takes its place.
        new WorkflowRepository(homeDb).forgetAgentSessionId(resumed.workflowId);
      } catch {
        return;
      }
      console.warn(`[WORKFLOW-AGENT] Resume of ${resumed.workflowId.slice(0, 8)} found no conversation; starting a new one.`);
      // The start marks the pane's start-over line itself.
      void startOnce(context, resumed.homeProjectId, resumed.workflowId, resumed.grid)
        .catch((error: unknown) => console.error('[WORKFLOW-AGENT] Could not start over:', error));
    }).catch(() => {
      // The host is gone (a quit or a crash): there is nothing to read.
    });
  };
  // The sweep that retires a session whose CLI is gone kills it on purpose, so
  // its exit arrives intentional; this is the moment the CLI's last words are
  // read, and its spend too, since the exit listener skips an intentional exit.
  context.sessionManager.on('agent-absent', (sessionId: string) => {
    const absent = context.sessionManager.getSession(sessionId);
    if (absent?.workflowId) captureSpend(context, absent);
    startOverIfResumeFailed(sessionId, 0);
  });
  // An agent owed new checkouts restarts when it goes idle, which is when the
  // turn that asked for them has ended. A transient session gets no
  // 'turn-ended', so this reads the idle edge itself; an interrupt ends the
  // turn too, and is as good a moment.
  // The same edge also dates its last reply and refreshes the picker's note.
  context.sessionManager.on('activity', (sessionId: string, activity: ActivityState) => {
    // One lookup, not a list: this runs on every activity edge of every session.
    const session = context.sessionManager.getSession(sessionId);
    const workflowId = session?.workflowId;
    if (!session || !workflowId) return;
    const idle = activity === 'idle'; // activity-state-ok: a permission prompt is mid-turn, and only an idle agent may be restarted
    // A reply is a turn that ended; a resumed agent settling idle is not one.
    const wasActive = isActive(agentActivity.get(sessionId));
    agentActivity.set(sessionId, activity);
    if (idle && wasActive) lastReplyAt.set(workflowId, new Date().toISOString());
    notifyWorkflowChanged(session.projectId, workflowId);
    if (idle && pendingAccess.has(workflowId)) setImmediate(() => void restartWithAccess(context, workflowId));
  });
  context.sessionManager.on('exit', (sessionId: string, exitCode: number, intentional?: boolean) => {
    agentActivity.delete(sessionId);
    // A stop Kangentic made captured the spend first; one the CLI made is
    // caught here, while its usage is still in the manager.
    const ended = context.sessionManager.getSession(sessionId);
    if (!intentional && ended?.workflowId) captureSpend(context, ended);
    if (intentional) {
      resumedSessions.delete(sessionId);
      return;
    }
    startOverIfResumeFailed(sessionId, exitCode);
  });
  // The idle auto-suspend applies to this agent as to any session. Its spend
  // since the last snapshot is nothing (it sat idle for the whole timeout), so
  // only its turns go to the ledger, and the pane hears it is paused.
  context.sessionManager.on('idle-timeout', (sessionId: string) => {
    const session = context.sessionManager.getSession(sessionId);
    if (!session?.workflowId) return;
    recordTurnTokens(context, withConversationId(session));
    notifyWorkflowChanged(session.projectId, session.workflowId);
  });
  // Every capture of a session's spend happens while its row is registered.
  context.sessionManager.on('session-removed', (sessionId: string) => forgetWorkflowAgentEffort(sessionId));
  context.sessionManager.on('agent-session-id', (sessionId: string, _taskId: string, projectId: string, agentSessionId: string) => {
    recordReportedConversation(context, sessionId, projectId, agentSessionId);
  });
}

/**
 * Record the id the workflow's agent reported as the conversation the workflow
 * resumes by. Only for the workflow's current agent, so a late report from a
 * session this start replaced never names a conversation the workflow has left.
 * A paused session counts: some CLIs report their id as they shut down.
 */
function recordReportedConversation(context: IpcContext, sessionId: string, homeProjectId: string, agentSessionId: string): void {
  const session = context.sessionManager.getSession(sessionId);
  const workflowId = session?.workflowId;
  if (!session || !workflowId) return;
  if (findWorkflowAgentSession(context, workflowId)?.id !== sessionId) return;
  try {
    const homeDb = getExistingProjectDb(homeProjectId);
    if (!homeDb) return;
    const repository = new WorkflowRepository(homeDb);
    const workflow = repository.getById(workflowId);
    if (!workflow || workflow.state === 'done' || workflow.agent_session_id === agentSessionId) return;
    const agentName = context.sessionManager.getSessionAgentName(sessionId) ?? workflow.agent_name;
    if (!agentName) return;
    repository.setAgentConversation(workflowId, { agentName, agentSessionId, cwd: session.cwd });
  } catch (error) {
    console.warn('[WORKFLOW-AGENT] Could not record the conversation the agent reported:', error);
    return;
  }
  notifyWorkflowChanged(homeProjectId, workflowId);
}
