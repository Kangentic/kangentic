/**
 * What the completed task view shows (`sessions.getTaskReport`), read in one
 * call so the view does not stitch it together from a dozen IPC round trips.
 *
 * `readTaskReport` reads the rows: the project database on main (sessions,
 * column moves, automation runs, background calls) and the retrieval worker for
 * what only the index holds (the turn ledger, the written summary, linked
 * commits and changed files). A worker that is down or restarting costs those
 * sections, never the report. `assembleTaskReport` (`task-report-assemble.ts`)
 * turns the rows into the report.
 */

import type { AppConfig, TaskLastMessage, TaskReport, TaskReportRouteColumn, TaskReportSummaryState } from '../../../shared/types';
import { taskSummariesOn } from '../../../shared/answer-agent';
import { SessionRepository } from '../../db/repositories/session-repository';
import { getProjectDb } from '../../db/database';
import { retrievalClient } from '../../retrieval/retrieval-client';
import { collectRemoteTargets } from '../../retrieval/remote-targets';
import { agentRegistry } from '../../agent/agent-registry';
import { getProjectRepos } from './project-repos';
import { assembleTaskReport, assembleTaskRoute } from './task-report-assemble';
import type { IpcContext } from '../ipc-context';

/** How long the view waits on the index before it shows the report without it. */
const INDEX_WAIT_MS = 8_000;
/** The closing message is a transcript parse; a long one is worth waiting for, within reason. */
const LAST_MESSAGE_TIMEOUT_MS = 15_000;
/** Runs from a single automation-runs page: the log keeps at most a few hundred rows. */
const AUTOMATION_RUNS_READ = 1_000;

/**
 * Null on any failure, or once the view has waited `INDEX_WAIT_MS`: a worker
 * that is down, restarting or busy costs its section only. The wait is the
 * view's own and the read keeps the client's interactive budget, because a
 * call that runs out of its budget restarts the worker for every caller.
 */
async function readFromIndex<Result>(read: () => Promise<Result>): Promise<Result | null> {
  const reading = read().catch((error: unknown) => {
    console.warn('[task-report] index read failed:', error instanceof Error ? error.message : error);
    return null;
  });
  let waitTimer: ReturnType<typeof setTimeout> | undefined;
  const waited = new Promise<null>((resolve) => {
    waitTimer = setTimeout(() => resolve(null), INDEX_WAIT_MS);
  });
  try {
    return await Promise.race([reading, waited]);
  } finally {
    clearTimeout(waitTimer);
  }
}

/** Read every row the report needs, then assemble it. */
export async function readTaskReport(context: IpcContext, projectId: string, taskId: string): Promise<TaskReport> {
  const repos = getProjectRepos(context, projectId);
  const sessionRepo = new SessionRepository(getProjectDb(projectId));
  const sessions = sessionRepo.listTaskReportRecords(taskId);
  const automationRuns = repos.automationRuns.listForTask(taskId, AUTOMATION_RUNS_READ);
  const conditionsByAutomationId = new Map<string, string>();
  for (const automation of repos.automations.listAll()) {
    if (automation.condition) conditionsByAutomationId.set(automation.id, automation.condition);
  }

  let knowledgeGraph: AppConfig['knowledgeGraph'];
  try {
    knowledgeGraph = context.configManager.load().knowledgeGraph;
  } catch {
    knowledgeGraph = undefined;
  }
  const indexingOn = knowledgeGraph?.indexingEnabled !== false;

  // The index holds the ledger, the written summary, and the linked commits and
  // files. With indexing off it is not read at all, as MCP's task reads do.
  const [ledger, knowledgeByTask, summaryText] = indexingOn
    ? await Promise.all([
      readFromIndex(() => retrievalClient.call('usage.taskModels', { projectId, taskId })),
      readFromIndex(() => retrievalClient.call('task.knowledge', { projectId, taskIds: [taskId], limits: { commits: 20, files: null } })),
      readFromIndex(() => retrievalClient.call('summary.forTask', { projectId, taskId })),
    ])
    : [null, null, null];

  // A written summary shows whatever the switch says now, as MCP shows it.
  let summaryState: TaskReportSummaryState;
  if (summaryText) summaryState = { kind: 'written', text: summaryText };
  else if (!indexingOn) summaryState = { kind: 'indexing-off' };
  else if (knowledgeGraph?.enabled !== true || !taskSummariesOn(knowledgeGraph)) summaryState = { kind: 'off' };
  else summaryState = { kind: 'pending' };

  return assembleTaskReport({
    sessions,
    swimlanes: repos.swimlanes.list(),
    moves: repos.taskMoves.listForTask(taskId),
    summary: sessionRepo.getSummaryForTask(taskId),
    automationRuns,
    conditionsByAutomationId,
    backgroundCalls: repos.backgroundCalls.listForTask(taskId),
    ledger,
    knowledge: knowledgeByTask?.get(taskId) ?? null,
    summaryState,
    nowMs: Date.now(),
  });
}

/**
 * The task's route alone (`sessions.getTaskRoute`): the conversation window's
 * column tabs. Database rows only, so it is cheap enough to re-read on every
 * new transcript revision of a live task, where `readTaskReport` waits on the
 * index.
 */
export function readTaskRoute(context: IpcContext, projectId: string, taskId: string): TaskReportRouteColumn[] {
  const repos = getProjectRepos(context, projectId);
  return assembleTaskRoute({
    swimlanes: repos.swimlanes.list(),
    moves: repos.taskMoves.listForTask(taskId),
    nowMs: Date.now(),
  });
}

/**
 * The agent's last message in the task's newest conversation: its final reply,
 * from the transcript reader, which works with indexing off. Read only when no
 * summary is written, and apart from the report, so a long transcript never
 * holds the view up. Null when there is none or it cannot be read.
 */
export async function readTaskLastMessage(projectId: string, taskId: string): Promise<TaskLastMessage | null> {
  // An empty id would open a database file named for nothing.
  if (!projectId) return null;
  const sessionRepo = new SessionRepository(getProjectDb(projectId));
  const newest = sessionRepo.getLatestAgentSessionForTask(taskId);
  if (!newest?.agent_session_id) return null;
  try {
    const reply = await retrievalClient.call(
      'transcript.finalReply',
      {
        facts: { sessionType: newest.session_type, agentSessionId: newest.agent_session_id, cwd: newest.cwd },
        remoteTargets: collectRemoteTargets(agentRegistry),
      },
      { timeoutMs: LAST_MESSAGE_TIMEOUT_MS },
    );
    if (!reply) return null;
    return { text: reply.text, writtenAt: Number.isFinite(reply.ts) ? new Date(reply.ts).toISOString() : null };
  } catch (error) {
    console.warn('[task-report] last message read failed:', error instanceof Error ? error.message : error);
    return null;
  }
}
