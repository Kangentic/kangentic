// Dev-only: what a workflow's own agent would start with, for the demo capture rig.
//
// scripts/lib/demo-mcp-capture.mjs records a workflow agent planning against a seeded /preview,
// in a PTY of its own at the web demo's pane size. That recording is only the desktop's if its
// launch is: the first message built from the configured template over the preview's own board,
// and the MCP URL whose `workflow-` caller segment scopes the agent to the read-only and planning
// tools. The board's columns, its history and the workflow's brief live in the project database,
// so this route reads them with the helpers `startWorkflowAgent` uses rather than leaving the rig
// to retype them.
//
// Dev-only: this whole tree is build-excluded via __KANGENTIC_DEV__, and the route is gated
// behind Allow Unsafe Operations like /eval, since its answer carries the MCP server's token.

import type { IpcContext } from '../../main/ipc/ipc-context';
import { getExistingProjectDb } from '../../main/db/database';
import { WorkflowRepository } from '../../main/db/repositories/workflow-repository';
import { buildWorkflowAgentFirstMessage } from '../../main/workflows/workflow-agent-prompt';
import { appendWorkflowAgentCaller } from '../../main/agent/mcp-http/caller-url';
import { workflowAgentPromptTemplate } from '../../shared/workflow-agent-prompt';
import { resolveProjectRoot } from '../../shared/git-utils';

interface JsonResponder {
  json: (statusCode: number, body: unknown) => void;
  error: (statusCode: number, kind: string, detail: string) => void;
}

/** A new conversation's launch, as `startWorkflowAgent` builds it for a workflow with no agent yet. */
interface WorkflowAgentLaunch {
  /** The project's checkout: the agent runs there, with no worktree. */
  cwd: string;
  /** The first message, from the configured template with its variables filled in. */
  prompt: string;
  /** The project's MCP URL with the workflow's own caller segment. */
  mcpServerUrl: string;
  /** The per-launch token every client sends as `X-Kangentic-Token`. */
  mcpServerToken: string;
}

type LaunchErrorKind = 'missing-field' | 'unknown-workflow' | 'unknown-project' | 'mcp-server-off';

/** A request the route can name what is wrong with; anything else is the server's own error. */
class WorkflowAgentLaunchError extends Error {
  constructor(public readonly kind: LaunchErrorKind, message: string) {
    super(message);
  }
}

const STATUS_BY_KIND: Record<LaunchErrorKind, number> = {
  'missing-field': 400,
  'unknown-workflow': 404,
  'unknown-project': 404,
  'mcp-server-off': 503,
};

function readString(body: unknown, key: string): string {
  const value = typeof body === 'object' && body !== null ? (body as Record<string, unknown>)[key] : undefined;
  if (typeof value === 'string' && value) return value;
  throw new WorkflowAgentLaunchError('missing-field', `Provide "${key}".`);
}

function describeWorkflowAgentLaunch(context: IpcContext, projectId: string, workflowId: string): WorkflowAgentLaunch {
  // The registry first: a project id names its database file, so an id the app does not hold
  // never reaches the disk.
  const project = context.projectRepo.getById(projectId);
  if (!project) throw new WorkflowAgentLaunchError('unknown-project', `No project ${projectId}.`);
  const database = getExistingProjectDb(projectId);
  const workflow = database ? new WorkflowRepository(database).getById(workflowId) : undefined;
  if (!workflow) throw new WorkflowAgentLaunchError('unknown-workflow', `Project ${projectId} has no workflow ${workflowId}.`);
  const handle = context.mcpServerHandle;
  const mcpServerUrl = handle ? appendWorkflowAgentCaller(handle.urlForProject(projectId), workflow.id) : undefined;
  if (!handle || !mcpServerUrl) throw new WorkflowAgentLaunchError('mcp-server-off', 'The MCP server is off. Turn it on in Settings, MCP Server.');
  const template = workflowAgentPromptTemplate(context.configManager.load().workflows?.agentPrompt);
  return {
    cwd: resolveProjectRoot(project.path),
    prompt: buildWorkflowAgentFirstMessage(context, projectId, workflow, template),
    mcpServerUrl,
    mcpServerToken: handle.token,
  };
}

/** `POST /workflow-agent-launch` with `{ projectId, workflowId }`. */
export function respondWorkflowAgentLaunch(body: unknown, context: IpcContext | null, responder: JsonResponder): void {
  if (!context) {
    responder.error(503, 'no-ipc-context', 'The app has not finished starting.');
    return;
  }
  try {
    responder.json(200, describeWorkflowAgentLaunch(context, readString(body, 'projectId'), readString(body, 'workflowId')));
  } catch (error) {
    if (error instanceof WorkflowAgentLaunchError) {
      responder.error(STATUS_BY_KIND[error.kind], error.kind, error.message);
      return;
    }
    throw error;
  }
}
