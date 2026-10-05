import fs from 'node:fs';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import type { IpcContext } from '../ipc/ipc-context';
import { DEFAULT_AGENT } from '../../shared/types';
import type { ActivityState, Session, Workflow, WorkflowAgentStatus, WorkflowAgentSummary } from '../../shared/types';
import { resolveProjectRoot } from '../../shared/git-utils';
import { workflowAgentPromptTemplate } from '../../shared/workflow-agent-prompt';
import { WORKFLOW_REFUSALS } from '../../shared/workflow-refusals';
import { isActive } from '../../shared/activity-state';
import { getProjectDb } from '../db/database';
import { WorkflowRepository } from '../db/repositories/workflow-repository';
import { UsageHistoryRepository } from '../db/repositories/usage-history-repository';
import { captureWorkflowAgentUsage } from '../ipc/handlers/session-metrics';
import { agentRegistry } from '../agent/agent-registry';
import { retrievalClient } from '../retrieval/retrieval-client';
import { collectRemoteTargets } from '../retrieval/remote-targets';
import { resolveShimLaunch } from '../agent/shared/shim-launch';
import { appendWorkflowAgentCaller } from '../agent/mcp-http/caller-url';
import { buildWorkflowAgentFirstMessage } from './workflow-agent-prompt';
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
 * It runs in the home project's checkout with no worktree, launched read-only
 * (`readOnly`): it reads the code and the board and changes only its own
 * workflow's plan, through the MCP server's `workflow-` caller scope.
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
  new WorkflowRepository(getProjectDb(homeProjectId)).addAgentReadProject(workflowId, projectId);
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
  const workflow = new WorkflowRepository(getProjectDb(homeProjectId)).getById(workflowId);
  if (!workflow) return 'next-start';
  const granted = grantedDirectories.get(workflowId) ?? new Set<string>();
  const missing = readableProjectsOf(context, homeProjectId, workflow).filter((readable) => !granted.has(readable.path));
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
  try {
    captureSpend(context, session);
    await context.sessionManager.suspend(session.id);
    // A Pause pressed while it stopped is the user's, and stands. The resume
    // reads the grant from the workflow row; only this one line is not said.
    if (userPaused.has(workflowId)) return;
    // An open already in flight (the user's Resume) starts it with the grant,
    // so this start joins that one, and the line is not said either.
    await startOnce(context, pending.homeProjectId, workflowId, lastGrid.get(workflowId) ?? {}, pending.message);
  } catch (error) {
    console.error('[WORKFLOW-AGENT] Could not restart with the new project access:', error);
  }
}

function unavailable(reason: string): WorkflowAgentStatus {
  return { session: null, unavailable: reason };
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
 * A paused agent stays paused; Resume is the user's.
 */
export function openWorkflowAgent(
  context: IpcContext,
  homeProjectId: string,
  workflowId: string,
  grid: WorkflowAgentGrid,
): Promise<WorkflowAgentStatus> {
  const existing = findWorkflowAgentSession(context, workflowId);
  if (existing) return Promise.resolve({ session: existing, unavailable: null });
  return startOnce(context, homeProjectId, workflowId, grid);
}

/** The pane's Resume: a paused or exited agent comes back on its conversation. */
export function resumeWorkflowAgent(
  context: IpcContext,
  homeProjectId: string,
  workflowId: string,
  grid: WorkflowAgentGrid,
): Promise<WorkflowAgentStatus> {
  userPaused.delete(workflowId);
  const existing = findWorkflowAgentSession(context, workflowId);
  if (existing && existing.status !== 'suspended') return Promise.resolve({ session: existing, unavailable: null });
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
  try {
    captureWorkflowAgentUsage(context.sessionManager, new UsageHistoryRepository(getProjectDb(session.projectId)), session);
  } catch {
    // Best-effort: a project database closing under a quit or a delete.
  }
  recordTurnTokens(context, session);
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
 */
async function startWorkflowAgent(
  context: IpcContext,
  homeProjectId: string,
  workflowId: string,
  grid: WorkflowAgentGrid,
  continuation?: string,
): Promise<WorkflowAgentStatus> {
  const repository = new WorkflowRepository(getProjectDb(homeProjectId));
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
  const projectDefaultAgent = project.default_agent || DEFAULT_AGENT;
  // A conversation belongs to the agent that holds it, so a resume keeps that
  // agent even after the project's default changed.
  const agentName = workflow.agent_name ?? projectDefaultAgent;
  const adapter = agentRegistry.get(agentName);
  if (!adapter) return unavailable(`Kangentic does not know the agent "${agentName}".`);
  if (!adapter.supportsReadOnlyLaunch || !adapter.supportsCallerSessionId) {
    return unavailable(`${adapter.displayName} cannot be a workflow's agent, because Kangentic cannot launch it read-only. Plan on the canvas, or choose another default agent in Settings.`);
  }
  if (!config.mcpServer.enabled || !context.mcpServerHandle) {
    return unavailable('The workflow agent works through Kangentic\'s MCP server, which is off. Turn it on in Settings, MCP Server.');
  }
  const detection = await adapter.detect(config.agent.cliPaths[agentName] ?? null);
  if (!detection.found || !detection.path) return unavailable(`Kangentic cannot find ${adapter.displayName} on this machine.`);

  const resume = workflow.agent_session_id !== null && workflow.agent_name === agentName;
  const agentSessionId = resume && workflow.agent_session_id ? workflow.agent_session_id : uuidv4();
  // A resumed agent gets no first message (its conversation holds it), only the
  // reason Kangentic restarted it, when there is one.
  const prompt = resume
    ? continuation
    : buildWorkflowAgentFirstMessage(context, homeProjectId, workflow, readWorkflowAgentTemplate(context));
  // The other boards' checkouts it may read; an agent whose CLI cannot widen
  // its reads gets none, and its own project only.
  const readable = adapter.supportsReadableDirectories ? readableProjectsOf(context, homeProjectId, workflow) : [];

  const shell = await context.sessionManager.getShell();
  const sessionDirectory = path.join(projectRoot, '.kangentic', 'sessions', workflow.id);
  // sync-write-ok: the agent's status and events bridges write into this
  // folder from the moment it starts; a failure throws to the IPC handler,
  // which rejects and the pane shows the reason.
  fs.mkdirSync(sessionDirectory, { recursive: true });
  const statusOutputPath = path.join(sessionDirectory, 'status.json');
  const eventsOutputPath = path.join(sessionDirectory, 'activity.json');

  // The same pre-spawn steps every spawn path runs before building a command.
  await adapter.ensureTrust(projectRoot);
  const launch = await resolveShimLaunch({ agentPath: detection.path, shell, prompt });
  // The project's model tier applies to the project's own default agent only
  // (a model id is the agent's own), as for a task spawn.
  const projectTierApplies = agentName === projectDefaultAgent;
  const commandOptions = {
    agentPath: launch.agentPath,
    taskId: workflow.id,
    prompt: launch.prompt,
    cwd: projectRoot,
    permissionMode: 'default' as const,
    projectRoot,
    sessionId: agentSessionId,
    resume,
    statusOutputPath,
    eventsOutputPath,
    shell,
    mcpServerEnabled: true,
    mcpServerUrl: appendWorkflowAgentCaller(context.mcpServerHandle.urlForProject(homeProjectId), workflow.id),
    mcpServerToken: context.mcpServerHandle.token,
    model: projectTierApplies ? project.default_model ?? undefined : undefined,
    effort: projectTierApplies ? project.default_effort ?? undefined : undefined,
    readOnly: true,
    readableDirectories: readable.map((entry) => entry.path),
  };
  const command = adapter.buildCommand(commandOptions);
  const extraEnv = adapter.buildEnv?.(commandOptions) ?? null;

  // Read again after the awaits above: the workflow may have finished, or been
  // deleted with its project, while the CLI was being found.
  if (!workflowStillOpen(context, homeProjectId, workflowId)) return unavailable('This workflow no longer exists.');
  // The rows this start replaces leave the registry with no removal push (the
  // spawn's sibling drain), so what is kept per session id goes with them here.
  const replacedSessionIds = context.sessionManager.listSessions()
    .filter((existing) => existing.workflowId === workflowId)
    .map((existing) => existing.id);

  const session = await context.sessionManager.spawn({
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
  });
  for (const replacedId of replacedSessionIds) {
    if (replacedId === session.id) continue;
    forgetWorkflowAgentEffort(replacedId);
    agentActivity.delete(replacedId);
    resumedSessions.delete(replacedId);
  }
  // Recorded on every start, so a conversation from before `agent_cwd` existed
  // gains its checkout on its next resume.
  repository.setAgentConversation(workflow.id, { agentName, agentSessionId, cwd: projectRoot });
  recordWorkflowAgentEffort(session.id, commandOptions.effort ?? null);
  if (resume) {
    resumedSessions.set(session.id, { homeProjectId, workflowId: workflow.id, grid });
    // A resume ends what the pane said about an earlier start-over. One that
    // fails too starts over again, which says it again.
    startedOverSessions.delete(workflow.id);
  }
  grantedDirectories.set(workflow.id, new Set(readable.map((entry) => entry.path)));
  lastGrid.set(workflow.id, grid);
  return { session, unavailable: null };
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
 * saying so (`describeStartupFailure`). The agent then starts over with the first
 * message, which the pane shows, rather than leaving a dead pane whose Resume
 * fails the same way every time, and the pane says it started over
 * (`WorkflowAgentSummary.startedOverSessionId`).
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
        new WorkflowRepository(getProjectDb(resumed.homeProjectId)).setAgentConversation(resumed.workflowId, null);
      } catch {
        return;
      }
      console.warn(`[WORKFLOW-AGENT] Resume of ${resumed.workflowId.slice(0, 8)} found no conversation; starting a new one.`);
      void startOnce(context, resumed.homeProjectId, resumed.workflowId, resumed.grid)
        .then((status) => {
          if (!status.session) return;
          // The pane says the agent started over, from the summary this push reloads.
          startedOverSessions.set(resumed.workflowId, status.session.id);
          notifyWorkflowChanged(resumed.homeProjectId, resumed.workflowId);
        })
        .catch((error: unknown) => console.error('[WORKFLOW-AGENT] Could not start over:', error));
    }).catch(() => {
      // The host is gone (a quit or a crash): there is nothing to read.
    });
  };
  // The sweep that retires a session whose CLI is gone kills it on purpose, so
  // its exit arrives intentional; this is the moment the CLI's last words are read.
  context.sessionManager.on('agent-absent', (sessionId: string) => startOverIfResumeFailed(sessionId, 0));
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
    recordTurnTokens(context, session);
    notifyWorkflowChanged(session.projectId, session.workflowId);
  });
  // Every capture of a session's spend happens while its row is registered.
  context.sessionManager.on('session-removed', (sessionId: string) => forgetWorkflowAgentEffort(sessionId));
}
