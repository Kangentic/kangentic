import fs from 'node:fs';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import type { IpcContext } from '../ipc/ipc-context';
import { DEFAULT_AGENT } from '../../shared/types';
import type { Session, WorkflowAgentStatus } from '../../shared/types';
import { resolveProjectRoot } from '../../shared/git-utils';
import { workflowAgentPromptTemplate } from '../../shared/workflow-agent-prompt';
import { WORKFLOW_REFUSALS } from '../../shared/workflow-refusals';
import { isActive } from '../../shared/activity-state';
import { getProjectDb } from '../db/database';
import { WorkflowRepository } from '../db/repositories/workflow-repository';
import { agentRegistry } from '../agent/agent-registry';
import { resolveShimLaunch } from '../agent/shared/shim-launch';
import { appendWorkflowAgentCaller } from '../agent/mcp-http/caller-url';
import { buildWorkflowAgentFirstMessage } from './workflow-agent-prompt';

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

/** Sessions spawned as a resume, until they end. A resume the CLI cannot honour ends here. */
const resumedSessions = new Map<string, { homeProjectId: string; workflowId: string; grid: WorkflowAgentGrid }>();

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
  const existing = findWorkflowAgentSession(context, workflowId);
  if (existing && existing.status !== 'suspended') return Promise.resolve({ session: existing, unavailable: null });
  return startOnce(context, homeProjectId, workflowId, grid);
}

/** The pane's Pause: the agent stops and frees its slot; its conversation is kept. */
export async function pauseWorkflowAgent(context: IpcContext, workflowId: string): Promise<void> {
  const session = findWorkflowAgentSession(context, workflowId);
  if (!session || session.status === 'suspended') return;
  await context.sessionManager.suspend(session.id);
}

/**
 * End the agent for good, when its workflow is deleted or finishes, or its
 * project is deleted. Kill, capture the exit, then remove (the row must still
 * exist when the exit is awaited), and delete its session folder once the
 * process is gone.
 */
export async function endWorkflowAgent(context: IpcContext, workflowId: string): Promise<void> {
  const sessions = context.sessionManager.listSessions().filter((session) => session.workflowId === workflowId);
  const exits: Promise<void>[] = [];
  for (const session of sessions) {
    resumedSessions.delete(session.id);
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
  await Promise.all([...workflowIds].map((workflowId) => endWorkflowAgent(context, workflowId)));
}

function startOnce(context: IpcContext, homeProjectId: string, workflowId: string, grid: WorkflowAgentGrid): Promise<WorkflowAgentStatus> {
  const pending = opening.get(workflowId);
  if (pending) return pending;
  const started = startWorkflowAgent(context, homeProjectId, workflowId, grid)
    .finally(() => opening.delete(workflowId));
  opening.set(workflowId, started);
  return started;
}

async function startWorkflowAgent(
  context: IpcContext,
  homeProjectId: string,
  workflowId: string,
  grid: WorkflowAgentGrid,
): Promise<WorkflowAgentStatus> {
  const repository = new WorkflowRepository(getProjectDb(homeProjectId));
  const workflow = repository.getById(workflowId);
  if (!workflow) return unavailable('This workflow no longer exists.');
  if (workflow.state === 'done') return unavailable(`${workflow.title} is complete.`);
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
  // A resumed agent gets no message: its conversation already holds the first one.
  const prompt = resume
    ? undefined
    : buildWorkflowAgentFirstMessage(context, homeProjectId, workflow, readWorkflowAgentTemplate(context));

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
  };
  const command = adapter.buildCommand(commandOptions);
  const extraEnv = adapter.buildEnv?.(commandOptions) ?? null;

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
  if (!resume) repository.setAgentConversation(workflow.id, { agentName, agentSessionId });
  if (resume) resumedSessions.set(session.id, { homeProjectId, workflowId: workflow.id, grid });
  return { session, unavailable: null };
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
 * fails the same way every time.
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
      try {
        new WorkflowRepository(getProjectDb(resumed.homeProjectId)).setAgentConversation(resumed.workflowId, null);
      } catch {
        return;
      }
      console.warn(`[WORKFLOW-AGENT] Resume of ${resumed.workflowId.slice(0, 8)} found no conversation; starting a new one.`);
      void startOnce(context, resumed.homeProjectId, resumed.workflowId, resumed.grid)
        .catch((error: unknown) => console.error('[WORKFLOW-AGENT] Could not start over:', error));
    }).catch(() => {
      // The host is gone (a quit or a crash): there is nothing to read.
    });
  };
  // The sweep that retires a session whose CLI is gone kills it on purpose, so
  // its exit arrives intentional; this is the moment the CLI's last words are read.
  context.sessionManager.on('agent-absent', (sessionId: string) => startOverIfResumeFailed(sessionId, 0));
  context.sessionManager.on('exit', (sessionId: string, exitCode: number, intentional?: boolean) => {
    if (intentional) {
      resumedSessions.delete(sessionId);
      return;
    }
    startOverIfResumeFailed(sessionId, exitCode);
  });
}
