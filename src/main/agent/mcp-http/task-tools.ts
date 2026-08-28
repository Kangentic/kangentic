import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v4';
import { callHandler, runHandler, withProject, appendNoticeLine, detectCrossProjectMention, sanitizeProjectName, PROJECT_SELECTOR_DESCRIPTION, type TaskCounter, type McpToolResult } from './handler-helpers';
import { READ_ONLY_ANNOTATIONS, MUTATING_ANNOTATIONS } from './annotations';
import type { RequestResolver } from './project-resolver';
import type { BoardHit, BacklogHit, SearchScope } from '../commands/search-commands';
import { TASK_DESCRIPTION_MAX_LENGTH, handleMoveTaskToProject } from '../commands/task-commands';
import { resolveModelSelector, resolveEffortSelector } from '../../../shared/model-id';
import { validateSpawnOverrides } from './spawn-override-validation';
import { resolveColumn } from '../commands/column-resolver';
import { TaskRepository } from '../../db/repositories/task-repository';
import { SwimlaneRepository } from '../../db/repositories/swimlane-repository';
import { resolveTask } from '../commands/task-resolver';
import type { ToolArgumentNotices } from './tool-call-logging';
import type { CommandContext } from '../commands';

const PERMISSION_MODE_SCHEMA = z.enum(['default', 'plan', 'acceptEdits', 'dontAsk', 'bypassPermissions', 'auto']);
/** Literals kept in lockstep with the shared `TaskRunMode` union by tests/unit/mcp-task-tools-run-mode-schema.test.ts. */
const RUN_MODE_SCHEMA = z.enum(['column_settings', 'agent_override']);

/**
 * Build the create_task routing-check refusal shown when the call
 * defaulted to the active project but the task text named one or more
 * other registered projects. Names a concrete re-run for each option:
 * file into a mentioned project, or confirm the active project. Names
 * are sanitized for safe single-line display.
 */
function buildRoutingCheckMessage(activeName: string, mentioned: string[]): string {
  const safeActive = sanitizeProjectName(activeName);
  const safeMentioned = mentioned.map((name) => `"${sanitizeProjectName(name)}"`);
  if (safeMentioned.length === 1) {
    return `Routing check: this task was about to be created in the active project "${safeActive}", but its text mentions the registered project ${safeMentioned[0]}. No task was created. Re-run kangentic_create_task with project: ${safeMentioned[0]} to file it there, or with project: "${safeActive}" to confirm the active project.`;
  }
  return `Routing check: this task was about to be created in the active project "${safeActive}", but its text mentions these other registered projects: ${safeMentioned.join(', ')}. No task was created. Re-run kangentic_create_task with project set to the intended one (e.g. project: ${safeMentioned[0]}), or with project: "${safeActive}" to confirm the active project.`;
}

/**
 * The `[a, b]` label suffix shared by every listing row - board rows in
 * list_tasks and search_tasks, and backlog rows in search_tasks - so the three
 * surfaces cannot drift into different shapes. Empty for an unlabelled item.
 */
function formatLabelSuffix(labels: readonly string[]): string {
  return labels.length > 0 ? ` [${labels.join(', ')}]` : '';
}

/** Case-insensitive test for the backlog pseudo-column, which never spawns. */
function isBacklogColumn(columnName: string | null | undefined): boolean {
  return (columnName ?? '').trim().toLowerCase() === 'backlog';
}

/**
 * Build the advisory line appended to a create/update whose raw arguments
 * carried no `labels` alongside a large description. Not an error: the write
 * succeeded and only the labels are missing, so this is a next step rather
 * than a refusal. `followUp` is the concrete next call, supplied by each tool
 * since only they know how to name the task without a lookup.
 */
function buildLabelsAbsentNotice(descriptionLength: number, followUp: string): string {
  return `[Labels not received] This call arrived with no 'labels' argument alongside a ${descriptionLength}-char `
    + 'description - the known large-payload drop upstream of Kangentic, in the MCP client\'s tool-call emission. '
    + `The write itself succeeded. If you meant to label this task, ${followUp} now. `
    + 'If you did not, ignore this line.';
}

/**
 * Append the labels-absent advisory when THIS request's raw arguments tripped
 * the large-description signature for `toolName`. A no-op otherwise, so a
 * caller who deliberately sent no labels never sees a line.
 */
function withLabelsAbsentNotice(
  result: McpToolResult,
  toolName: 'kangentic_create_task' | 'kangentic_update_task',
  notices: ToolArgumentNotices | undefined,
  followUp: string,
): McpToolResult {
  const descriptionLength = notices?.labelsAbsentWithLargeDescription[toolName];
  if (descriptionLength === undefined) return result;
  return appendNoticeLine(result, buildLabelsAbsentNotice(descriptionLength, followUp));
}

/**
 * Resolve the `agent_override` on the column a create is destined for, the
 * second rung of the spawn ladder. Best-effort: an unresolvable column just
 * drops that rung, because the handler will produce its own error for it.
 */
function laneAgentOverrideForColumn(context: CommandContext, columnName: string | null): string | null {
  try {
    const resolution = resolveColumn(context.getProjectDb(), columnName);
    return 'error' in resolution ? null : resolution.swimlane.agent_override;
  } catch {
    return null;
  }
}

/**
 * The two ladder rungs an EXISTING task supplies: its own `agent_override`
 * (rung 1) and the one on the column it currently sits in (rung 2). Both
 * matter - `lockAdvancedOverridesOnFirstSpawn` writes the pins onto the task at
 * first spawn, so a task that has ever run usually carries its own agent, and
 * reading only the column would validate a model against the wrong agent.
 */
function agentLadderRungsForTask(
  context: CommandContext,
  taskId: string,
): { taskAgentOverride: string | null; laneAgentOverride: string | null } {
  try {
    const db = context.getProjectDb();
    const task = resolveTask(new TaskRepository(db), taskId);
    if (!task) return { taskAgentOverride: null, laneAgentOverride: null };
    return {
      taskAgentOverride: task.agent_override ?? null,
      laneAgentOverride: new SwimlaneRepository(db).getById(task.swimlane_id)?.agent_override ?? null,
    };
  } catch {
    return { taskAgentOverride: null, laneAgentOverride: null };
  }
}

/**
 * Register the board/task/column management tools on an McpServer.
 * These are the mutation-heavy tools - creating, moving, updating tasks
 * and columns - plus read-side helpers that are specifically about the
 * board (list_columns, find_task, etc.).
 *
 * Every tool accepts an optional `project` argument (except
 * `kangentic_get_current_task`, which is inherently scoped to the
 * running agent's CWD/branch and therefore to its own project). When
 * `project` is set, the tool resolves to a different project's board
 * before executing and annotates the response with the target
 * project's name so the caller can confirm where the action landed.
 *
 * create_task is rate-limited via `taskCounter` to cap runaway agents.
 */
export function registerTaskTools(
  server: McpServer,
  resolver: RequestResolver,
  taskCounter: TaskCounter,
  toolArgumentNotices?: ToolArgumentNotices,
): void {
  // --- kangentic_create_task ---
  server.registerTool(
    'kangentic_create_task',
    {
      description: 'Create a task on the Kangentic board (default: the To Do column on the active board) or in the backlog. This is the only task-creation tool - use it whenever the user asks to "create a task", "add a todo", "add to backlog", or similar. ATTACHMENTS RULE: When the user\'s prompt references local files by absolute path (design handoffs, mockups, screenshots, specs, READMEs, transcripts), pass those paths in `attachments` on this same call. Default to attaching, not omitting. Do not require a second user request to add them. The only exception is files the user explicitly named as "for context only, don\'t attach." With no `column` argument, the task always lands in the active board\'s To Do column - never the backlog. Pass `column: "Backlog"` (case-insensitive) to create a backlog item instead. Pass any other column name (e.g. "Planning", "Code Review") to land directly in that board column. Board tasks are ready to work on immediately; with worktrees on (the project default) each gets its own worktree and branch, and with `useWorktree: false` the agent works in the project directory on the branch already checked out. If the user\'s prompt names a different Kangentic project, pass that name as `project` to route the task to that project instead of the active default - do not rely on the active default when the user clearly targeted another project. The name counts however it is phrased, not just the explicit "create a task in X" form: "create a task in X to fix ...", "the X to do board", "add a bug to the X board", "in X", and "X\'s backlog" all target project X. Use kangentic_list_projects to find valid selectors. LABELS WITH A LONG DESCRIPTION: due to a known large-payload limitation, when this call carries both a long description (roughly 1KB or more) and labels, the labels can be dropped before they reach the server. In that case create the task here (you may omit labels), then set labels with a separate labels-only kangentic_update_task call right after.',
      inputSchema: z.object({
        title: z.string().max(200).describe('Task title (max 200 characters)'),
        description: z.string().max(TASK_DESCRIPTION_MAX_LENGTH).optional().describe('Task description. Supports markdown.'),
        column: z.string().optional().describe('Target column name. Defaults to the To Do column on the active board. Use kangentic_list_columns to see board columns. Pass "Backlog" (case-insensitive) to create a backlog item instead of a board task. Only route to the backlog when the user explicitly asks for the backlog.'),
        priority: z.number().int().min(0).max(4).optional().describe('Priority: 0=none (default), 1=low, 2=medium, 3=high, 4=urgent. Applies to both board tasks and backlog items.'),
        labels: z.array(z.union([
          z.string(),
          z.object({
            name: z.string(),
            color: z.string().regex(/^#[0-9a-fA-F]{6}$/).describe('Hex color (e.g. "#ef4444")'),
          }),
        ])).optional().describe('Labels for categorization. Each entry can be a plain string or an object with name and hex color (e.g. ["bug", { "name": "frontend", "color": "#3b82f6" }]). Applies to both board tasks and backlog items. Use kangentic_board_summary to see the labels this board already uses, and reuse one rather than inventing a near-duplicate. Passing an existing label as a plain string keeps the color it already has.'),
        branchName: z.string().optional().describe('Custom git branch name for the task (e.g. "bugfix/login-screen"). If omitted, a branch name is auto-generated from the title. Recorded on the task and checked out when its worktree is created; with `useWorktree: false` nothing is checked out, but the conflict check below still applies, since the task can gain a worktree later. Board tasks only - ignored for backlog. Git allows a branch in only one working tree at a time, so if this branch is already checked out anywhere (including the user\'s main checkout) the call is REJECTED and no task is created - the response names the path holding it.'),
        baseBranch: z.string().optional().describe('Base branch to create the task branch from (e.g. "develop", "main"). Defaults to the project setting. Board tasks only - ignored for backlog.'),
        useWorktree: z.boolean().optional().describe('Whether to use a git worktree for isolation. Omit to follow the project setting. Set true and the task gets its own worktree checked out on its own branch. Set false and nothing is checked out at all: no worktree is created, the user\'s working tree is untouched, and the agent runs in the project directory on whatever branch the repo currently has out. Board tasks only - ignored for backlog.'),
        attachments: z.array(z.object({
          filePath: z.string().describe('Absolute path to the file to attach'),
          filename: z.string().optional().describe('Override display filename'),
        })).optional().describe('File attachments. Always include here any local files the user referenced in the prompt by absolute path - reading a file for context does not replace attaching it. Each entry needs `filePath` (absolute) and may override the display `filename`. Skip only when the user explicitly said the file is "for context only, don\'t attach."'),
        agentOverride: z.string().optional().describe('Pin a specific agent for this task\'s entire lifetime (e.g. "claude", "codex"). Locks against column moves, same as the New Task dialog\'s Advanced section. Rejected at once if it is not a registered agent, with the valid names listed. Omit to resolve through the normal chain: column override -> project default -> app default.'),
        modelOverride: z.string().max(200).optional().describe('Model to spawn this task with (e.g. "opus", "claude-opus-4-8", or the friendly "Opus 4.8"). A friendly name is converted to the CLI id, then checked against the models the resolved agent actually offers; an unknown one is rejected here with the valid list, rather than failing later at spawn. When that agent enumerates no models, the value is accepted as given and its CLI remains the final validator. Omit to resolve through the normal chain: column override -> project default -> agent default.'),
        effortOverride: z.string().max(50).optional().describe('Effort/reasoning level to spawn this task with (e.g. "xhigh", "high"). Valid values are agent-specific and are checked here against the resolved agent, so an unknown one is rejected with the valid list instead of failing later at spawn. An agent with no effort levels (several have none) accepts any value. Omit to resolve through the normal chain: column override -> project default -> agent default.'),
        permissionMode: PERMISSION_MODE_SCHEMA.optional().describe('Permission mode to spawn this task with. Omit to resolve through the normal chain: column override -> project default -> app default.'),
        autoCommand: z.string().max(4000).optional().describe('Slash command to run once the agent spawns for this task (e.g. "/code-review", "/release"). Overrides the destination column\'s auto_command for this task only. Not surfaced in the UI - MCP-only.'),
        profile: z.string().optional().describe('Board Profile this task rides (name or id) - an alternate set of per-column agent/model/effort settings, applied as the task moves. Mutually exclusive with the four *Override fields above: a profile changes per column, those pin one value for the task\'s whole life, so passing both is rejected. Omit for "Default" (every column uses its own settings). Use kangentic_list_board_profiles to see the board\'s profiles.'),
        runMode: RUN_MODE_SCHEMA.optional().describe('How this task gets its agent settings. "column_settings" (the default) follows each column the task moves through. "agent_override" pins agent/model/effort/permission for the task\'s whole life; any field you leave unset is resolved dynamically until the task first spawns, which then locks all four. Pass "agent_override" on its own to pin whatever the task would resolve to today. Passing any of the four *Override fields implies "agent_override", so you only need this to choose override mode without pinning anything - and pairing a pin with "column_settings" is rejected as a contradiction. Mutually exclusive with `profile`.'),
        prUrl: z.string().url().optional().describe('Pull request URL this task is about (e.g. https://github.com/owner/repo/pull/123). Set this when filing a review task for an existing PR - it is what links the task to that PR. Writing the URL into `description` instead does NOT link it. Board tasks only - ignored for backlog.'),
        prNumber: z.number().int().positive().optional().describe('Pull request number this task is about. Pass alongside `prUrl`. Board tasks only - ignored for backlog.'),
        project: z.string().optional().describe(PROJECT_SELECTOR_DESCRIPTION),
      }),
      annotations: MUTATING_ANNOTATIONS,
    },
    async ({ title, description, column, priority, labels, branchName, baseBranch, useWorktree, attachments, agentOverride, modelOverride, effortOverride, permissionMode, autoCommand, profile, runMode, prUrl, prNumber, project }) => withProject(resolver, project, async (ctx, resolved) => {
      // Rejected rather than silently resolved: the repository enforces
      // exclusivity by clearing whichever side the write did not set, so
      // accepting both would quietly discard half of what the caller asked for.
      // `runMode: 'agent_override'` is the same claim as a pin - it is the one
      // way to select override mode without setting one - so it is rejected
      // beside them. `runMode: 'column_settings'` agrees with a profile and is
      // allowed through.
      if (profile !== undefined && (agentOverride !== undefined || modelOverride !== undefined || effortOverride !== undefined || permissionMode !== undefined || runMode === 'agent_override')) {
        return Promise.resolve({
          content: [{ type: 'text' as const, text: 'Pass either `profile` (per-column settings as the task moves) or the agentOverride/modelOverride/effortOverride/permissionMode pins, or runMode: "agent_override" (one set for the task\'s whole life), not both. No task was created.' }],
          isError: true,
        });
      }
      // The mirror image, and rejected for the same reason: setting a pin IS
      // asking for override mode, so pairing it with 'column_settings' is a
      // contradiction the repository would resolve silently in the pin's
      // favour, discarding the mode the caller actually named.
      if (runMode === 'column_settings' && (agentOverride !== undefined || modelOverride !== undefined || effortOverride !== undefined || permissionMode !== undefined)) {
        return Promise.resolve({
          content: [{ type: 'text' as const, text: 'Pass either the agentOverride/modelOverride/effortOverride/permissionMode pins (which already imply runMode: "agent_override") or runMode: "column_settings" (follow each column, pinning nothing), not both. No task was created.' }],
          isError: true,
        });
      }
      // Routing guardrail: when the caller defaulted to the active
      // project (no explicit selector) but the task text names a
      // DIFFERENT registered project, refuse instead of silently filing
      // into the active project. Runs BEFORE tryReserve so a tripped
      // guardrail doesn't burn a quota slot (same reasoning as the
      // resolution-failure path). Only fires on the default path; an
      // explicit `project` selector is a deliberate choice we honor.
      // The raw `project` check is load-bearing, not redundant with
      // resolved.isDefault: resolveProject also returns isDefault=true for
      // an explicit selector that names the active project (makeResolved
      // short-circuits to the default context), so without this clause an
      // explicit self-targeting create would wrongly trip the guardrail.
      if (resolved.isDefault && (project === undefined || project.trim() === '')) {
        const mentioned = detectCrossProjectMention(resolver, `${title} ${description ?? ''}`);
        if (mentioned.length > 0) {
          return Promise.resolve({
            content: [{ type: 'text' as const, text: buildRoutingCheckMessage(resolved.projectName, mentioned) }],
            isError: true,
          });
        }
      }
      // Validate the agent/model/effort pins against the live agent capability
      // surface BEFORE reserving quota, for the same reason as the guardrail
      // above: a rejected call must not burn a slot. Skipped for the backlog,
      // whose items never spawn and carry no pins.
      const normalizedModel = modelOverride ? resolveModelSelector(modelOverride) : null;
      const normalizedEffort = effortOverride ? resolveEffortSelector(effortOverride) : null;
      // Gated on something actually being pinned, so an ordinary create - the
      // overwhelming majority - touches neither config nor the column lookup.
      if ((agentOverride || normalizedModel || normalizedEffort) && !isBacklogColumn(column)) {
        const agentConfig = resolver.getAgentValidationConfig();
        const rejection = await validateSpawnOverrides({
          agentOverride,
          modelOverride: normalizedModel,
          effortOverride: normalizedEffort,
          laneAgentOverride: laneAgentOverrideForColumn(ctx, column ?? null),
          projectDefaultAgent: resolver.getProjectDefaultAgent(resolved.projectId),
          cliPathOverrides: agentConfig.cliPathOverrides,
          discoveredModelsByAgent: agentConfig.discoveredModelsByAgent,
        });
        if (rejection) {
          return { content: [{ type: 'text' as const, text: `${rejection} No task was created.` }], isError: true };
        }
      }
      // Atomic reserve AFTER project resolution so typoed project
      // selectors (which fail in resolveProject above) don't burn
      // quota slots meant to cap actual task creations.
      // No await between the check and the increment, so this can't race.
      if (!taskCounter.tryReserve()) {
        return Promise.resolve({
          content: [{ type: 'text' as const, text: `Task-creation limit reached: this Kangentic MCP server already created its maximum of ${taskCounter.limit()} tasks since the app launched (a runaway-loop safeguard). Restart Kangentic to reset.` }],
          isError: true,
        });
      }
      const result = await callHandler('create_task', {
        title,
        description: description ?? '',
        column: column ?? null,
        priority: priority ?? null,
        labels: labels ?? null,
        branchName: branchName ?? null,
        baseBranch: baseBranch ?? null,
        useWorktree: useWorktree ?? null,
        attachments: attachments ?? null,
        agentOverride: agentOverride ?? null,
        modelOverride: normalizedModel,
        effortOverride: normalizedEffort,
        permissionMode: permissionMode ?? null,
        autoCommand: autoCommand ?? null,
        profile: profile ?? null,
        runMode: runMode ?? null,
        prUrl: prUrl ?? null,
        prNumber: prNumber ?? null,
      }, ctx, 'Failed to create task');
      // The create message ends with the new row's id - `(#N, id: <uuid>)` for a
      // board task, `(priority: <p>, id: <uuid>)` for a backlog item - and the
      // notice is appended directly under it, so pointing at that line is enough
      // for the follow-up to be constructible with no extra lookup. The two
      // surfaces need DIFFERENT follow-up tools: kangentic_update_task resolves
      // only against the tasks table, so handing it a backlog id answers
      // `Task "<uuid>" not found` and the advisory would send the agent in a
      // circle.
      return withLabelsAbsentNotice(
        result,
        'kangentic_create_task',
        toolArgumentNotices,
        isBacklogColumn(column)
          ? 'send a labels-only kangentic_update_backlog_item for the backlog id shown above'
          : 'send a labels-only kangentic_update_task for the task id shown above',
      );
    }, { alwaysAnnotate: true }),
  );

  // --- kangentic_list_columns ---
  server.registerTool(
    'kangentic_list_columns',
    {
      description: 'List all columns (swimlanes) on the Kangentic board. Returns column names, roles, and task counts. Pass `project` to list columns from a different project.',
      inputSchema: z.object({
        project: z.string().optional().describe(PROJECT_SELECTOR_DESCRIPTION),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ project }) => withProject(resolver, project, async (ctx) => {
      const response = await runHandler('list_columns', {}, ctx);
      if (!response.success) {
        return { content: [{ type: 'text' as const, text: `Failed to list columns: ${response.error}` }], isError: true };
      }
      const columns = response.data as Array<{ name: string; role: string | null; taskCount: number }>;
      const lines = columns.map((column) => {
        const roleTag = column.role ? ` (${column.role})` : '';
        return `- ${column.name}${roleTag}: ${column.taskCount} task(s)`;
      });
      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    }),
  );

  // --- kangentic_list_tasks ---
  server.registerTool(
    'kangentic_list_tasks',
    {
      description: 'List tasks on the Kangentic board, in board order (top to bottom within each column). Optionally filter by column name. Each task reports `position`, its zero-based ordinal slot within its own column - the same slot kangentic_move_task and kangentic_reorder_tasks accept, so a listing can be read and handed straight back. Pass `project` to list tasks from a different project.',
      inputSchema: z.object({
        column: z.string().optional().describe('Filter by column name. If omitted, returns all tasks.'),
        project: z.string().optional().describe(PROJECT_SELECTOR_DESCRIPTION),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ column, project }) => withProject(resolver, project, async (ctx) => {
      const response = await runHandler('list_tasks', { column: column ?? null }, ctx);
      if (!response.success) {
        return { content: [{ type: 'text' as const, text: `Failed to list tasks: ${response.error}` }], isError: true };
      }
      const tasks = response.data as Array<{ id: string; displayId: number; title: string; description: string; column: string; position: number; labels: string[] }>;
      if (tasks.length === 0) {
        const filterNote = column ? ` in "${column}"` : '';
        return { content: [{ type: 'text' as const, text: `No tasks found${filterNote}.` }] };
      }
      const lines = tasks.map((task) => {
        const descriptionPreview = task.description
          ? ` - ${task.description.slice(0, 100)}${task.description.length > 100 ? '...' : ''}`
          : '';
        const labelString = formatLabelSuffix(task.labels);
        return `- [${task.column}] ${task.title}${labelString}${descriptionPreview} (#${task.displayId}, id: ${task.id}, position: ${task.position})`;
      });
      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    }),
  );

  // --- kangentic_search_tasks ---
  server.registerTool(
    'kangentic_search_tasks',
    {
      description: 'Search by keyword across BOTH the board (active + completed/archived tasks) AND the backlog. This is the default tool to reach for when you want to find a task by title, description, or backlog label - it covers items regardless of whether they have been promoted from backlog to board. Use `scope` to narrow to one surface, and `status` to narrow board hits to active or completed. Pass `project` to search a different project.',
      inputSchema: z.object({
        query: z.string().describe('Search keyword or phrase to match against task titles and descriptions (case-insensitive). Backlog hits also match on labels. A "#<number>" query (e.g. "#42") is a ticket lookup instead of a text search: it matches board tasks whose display ID prefix-matches the number ("#4" matches #4, #40, #400) and returns no backlog hits, since backlog items have no display ID. A bare number with no "#" stays a text search; for an exact single-task lookup by number, kangentic_find_task with displayId is more direct.'),
        scope: z.enum(['board', 'backlog', 'both']).optional().describe('Which surface to search. "both" (default) covers board tasks and backlog items in one call. "board" restricts to the kanban board. "backlog" restricts to backlog items - note that pairing "backlog" with a "#<number>" ticket query always returns empty, since backlog items have no display ID; drop the "#" to text-search the backlog.'),
        status: z.enum(['active', 'completed', 'all']).optional().describe('Filter board hits by status. "active" = on the board, "completed" = in Done/archived. Ignored for backlog hits. Defaults to "all".'),
        project: z.string().optional().describe(PROJECT_SELECTOR_DESCRIPTION),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ query, scope, status, project }) => withProject(resolver, project, async (ctx) => {
      const effectiveScope: SearchScope = scope ?? 'both';
      const response = await runHandler('search_tasks', {
        query,
        status: status ?? 'all',
        scope: effectiveScope,
      }, ctx);
      if (!response.success) {
        return { content: [{ type: 'text' as const, text: `Failed to search tasks: ${response.error}` }], isError: true };
      }
      const results = response.data as {
        tasks: BoardHit[];
        backlog: BacklogHit[];
        totalActive: number;
        totalCompleted: number;
        totalBacklog: number;
        scope: SearchScope;
      };

      const totalHits = results.tasks.length + results.backlog.length;
      if (totalHits === 0) {
        return { content: [{ type: 'text' as const, text: `No tasks matching "${query}" found (scope: ${results.scope}).` }] };
      }

      const sections: string[] = [];

      if (effectiveScope === 'both') {
        sections.push(`Found ${totalHits} item(s) matching "${query}" (${results.totalActive} active, ${results.totalCompleted} completed, ${results.totalBacklog} backlog):`);
      } else if (effectiveScope === 'board') {
        sections.push(`Found ${results.tasks.length} board task(s) matching "${query}" (${results.totalActive} active, ${results.totalCompleted} completed):`);
      } else {
        sections.push(`Found ${results.totalBacklog} backlog item(s) matching "${query}":`);
      }

      if (results.tasks.length > 0) {
        if (effectiveScope === 'both') sections.push(`\nBoard (${results.tasks.length}):`);
        const taskLines = results.tasks.map((task) => {
          const descriptionPreview = task.description
            ? ` - ${task.description.slice(0, 100)}${task.description.length > 100 ? '...' : ''}`
            : '';
          const statusTag = task.status === 'completed' ? ' [completed]' : ` [${task.column}]`;
          const labelString = formatLabelSuffix(task.labels);
          return `- ${task.title}${statusTag}${labelString}${descriptionPreview} (#${task.displayId}, id: ${task.id})`;
        });
        sections.push(taskLines.join('\n'));
      }

      if (results.backlog.length > 0) {
        if (effectiveScope === 'both') sections.push(`\nBacklog (${results.backlog.length}):`);
        const backlogLines = results.backlog.map((item) => {
          const labelString = formatLabelSuffix(item.labels);
          const descriptionPreview = item.description
            ? ` - ${item.description.slice(0, 100)}${item.description.length > 100 ? '...' : ''}`
            : '';
          return `- ${item.title} (${item.priorityLabel})${labelString}${descriptionPreview} (id: ${item.id})`;
        });
        sections.push(backlogLines.join('\n'));
      }

      return { content: [{ type: 'text' as const, text: sections.join('\n') }] };
    }),
  );

  // --- kangentic_get_task_stats ---
  server.registerTool(
    'kangentic_get_task_stats',
    {
      description: 'Get session metrics and statistics for tasks. Returns token usage, cost, duration, tool calls, and lines changed. Can query a specific task or get a summary across all completed tasks, optionally filtered by keyword. Pass `project` to query a different project.',
      inputSchema: z.object({
        taskId: z.string().optional().describe('Task ID (numeric display ID like "42" or full UUID). If omitted, returns aggregate stats across completed tasks.'),
        query: z.string().optional().describe('Filter completed tasks by keyword in title/description before aggregating stats.'),
        sortBy: z.enum(['tokens', 'cost', 'duration', 'toolCalls', 'linesChanged']).optional().describe('Sort results by this metric (descending). Defaults to "tokens". Only applies when querying multiple tasks.'),
        project: z.string().optional().describe(PROJECT_SELECTOR_DESCRIPTION),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ taskId, query, sortBy, project }) => withProject(resolver, project, (ctx) => callHandler('get_task_stats', {
      taskId: taskId ?? null,
      query: query ?? null,
      sortBy: sortBy ?? 'tokens',
    }, ctx, 'Failed to get task stats')),
  );

  // --- kangentic_find_task ---
  server.registerTool(
    'kangentic_find_task',
    {
      description: 'Find a task or backlog item by display ID (e.g. 24, the "#24" shown in the UI), UUID, branch name, title keyword, or PR number. Returns full board-task details (branch_name, worktree, PR info, column) and/or matching backlog items. The `id` (UUID) and `title` filters span both board and backlog; `displayId`, `branch`, and `prNumber` are board-only since backlog items don\'t carry those fields. Use displayId for the fastest exact lookup when the user references a task by its "#N" identifier. Pass `project` to look up a task in a different project.',
      inputSchema: z.object({
        displayId: z.number().int().positive().optional().describe('Numeric task display ID shown in the UI (e.g. 24 for "#24"). Board-only, exact match.'),
        id: z.string().optional().describe('Full UUID. Matches against board-task UUIDs and backlog-item UUIDs.'),
        branch: z.string().optional().describe('Git branch name to search for (matches the tasks.branch_name column, exact or partial, e.g. "feature/92294"). Board-only.'),
        title: z.string().optional().describe('Keyword to search in titles (case-insensitive). Matches board tasks and backlog items.'),
        prNumber: z.number().optional().describe('Pull request number to search for. Board-only.'),
        project: z.string().optional().describe(PROJECT_SELECTOR_DESCRIPTION),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ displayId, id, branch, title, prNumber, project }) => {
      if (displayId === undefined && !id && !branch && !title && prNumber === undefined) {
        return {
          content: [{ type: 'text' as const, text: 'Provide at least one search parameter: displayId, id, branch, title, or prNumber.' }],
          isError: true,
        };
      }
      return withProject(resolver, project, (ctx) => callHandler('find_task', {
        displayId: displayId ?? null,
        id: id ?? null,
        branch: branch ?? null,
        title: title ?? null,
        prNumber: prNumber ?? null,
      }, ctx, 'Failed to find task'));
    },
  );

  // --- kangentic_get_current_task ---
  // Intentionally does NOT accept `project`. This tool resolves the task
  // that owns the agent's own CWD/branch, which is by definition in the
  // project the agent is running inside. Cross-project lookup makes no
  // sense here.
  server.registerTool(
    'kangentic_get_current_task',
    {
      description: 'Resolve the Kangentic task that corresponds to the current working directory and/or git branch. Use this at the start of work in a worktree to confirm which task you are operating on (e.g. before commits, PRs, or merge-back). Pass the agent\'s CWD and/or current branch name. Matches against tasks.worktree_path (full path or .kangentic/worktrees/<folder> segment) and tasks.branch_name. Returns the same shape as kangentic_find_task. It does not report dev-server ports - use kangentic_check_dev_ports for those, which probes each port besides. Nothing is reserved automatically - use kangentic_reserve_dev_ports when you are about to start a dev server and the project\'s configured port might already be taken by a sibling task running at the same time.',
      inputSchema: z.object({
        cwd: z.string().optional().describe('Absolute working directory path. The tool extracts the worktree folder name from .kangentic/worktrees/<folder> and matches against tasks.worktree_path.'),
        branch: z.string().optional().describe('Current git branch name. Exact (case-insensitive) match against tasks.branch_name.'),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ cwd, branch }) => {
      if (!cwd && !branch) {
        return {
          content: [{ type: 'text' as const, text: 'Provide at least one of: cwd, branch.' }],
          isError: true,
        };
      }
      const defaultContext = resolver.defaultContextResolved().context;
      return callHandler('get_current_task', { cwd: cwd ?? null, branch: branch ?? null }, defaultContext, 'Failed to get current task');
    },
  );

  // --- kangentic_board_summary ---
  server.registerTool(
    'kangentic_board_summary',
    {
      description: 'Get a high-level summary of the Kangentic board: task counts per column, the board\'s label vocabulary with use counts, active sessions, completed task count, and aggregate cost/token usage across all sessions. Call this before labelling a task to see what labels the board already uses (counted across active, completed, and backlog items) instead of inventing a near-duplicate. Pass `project` to summarize a different project.',
      inputSchema: z.object({
        project: z.string().optional().describe(PROJECT_SELECTOR_DESCRIPTION),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ project }) => withProject(resolver, project, (ctx) => callHandler('board_summary', {}, ctx, 'Failed to get board summary')),
  );

  // --- kangentic_get_column_detail ---
  server.registerTool(
    'kangentic_get_column_detail',
    {
      description: 'Get detailed configuration for a board column: automation settings (auto-spawn, auto-command, permission mode), plan exit target, role, and visual settings. Also returns `taskOrder`, the column\'s tasks top to bottom with their zero-based ordinal `position`, which makes this a complete read-before-write call for kangentic_reorder_tasks. Pass `project` to inspect a column in a different project.',
      inputSchema: z.object({
        column: z.string().describe('Column name (case-insensitive).'),
        project: z.string().optional().describe(PROJECT_SELECTOR_DESCRIPTION),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ column, project }) => withProject(resolver, project, (ctx) => callHandler('get_column_detail', { column }, ctx, 'Failed to get column detail')),
  );

  // --- kangentic_update_task ---
  server.registerTool(
    'kangentic_update_task',
    {
      description: 'Update an existing task. Supports title, description (full replace, in-place find/replace edits, or append), PR info, agent assignment, priority, labels, base branch, worktree toggle, and attaching files. To move a task between columns, use kangentic_move_task instead. Find the task ID first with kangentic_find_task. Pass `project` to update a task in a different project.',
      inputSchema: z.object({
        taskId: z.string().describe('Task ID (numeric display ID like "42" or full UUID).'),
        title: z.string().max(200).optional().describe('New task title (max 200 characters).'),
        description: z.string().max(TASK_DESCRIPTION_MAX_LENGTH).optional().describe('New task description (markdown). Replaces the entire description. For an incremental change to a long description, prefer descriptionEdits or appendDescription instead - they cost far fewer tokens and cannot silently drop untouched sections. Mutually exclusive with descriptionEdits and appendDescription.'),
        descriptionEdits: z.array(z.object({
          find: z.string().min(1).max(TASK_DESCRIPTION_MAX_LENGTH).describe('Exact text to find in the current description. Must appear exactly once.'),
          replace: z.string().max(TASK_DESCRIPTION_MAX_LENGTH).describe('Text to replace it with.'),
        })).min(1).max(100).describe('Ordered exact-string replacements applied to the current description, like the file Edit tool. Each edit\'s `find` must be present and unique in the text as it stands after the prior edits in the list; a missing or non-unique `find` fails the entire call and writes nothing. Mutually exclusive with `description`; may be combined with `appendDescription` (edits apply first, then the append).').optional(),
        appendDescription: z.string().max(TASK_DESCRIPTION_MAX_LENGTH).optional().describe('Text appended to the end of the current description, exactly as given (no separator is inserted). Mutually exclusive with `description`; may be combined with `descriptionEdits` (edits apply first, then this append).'),
        prUrl: z.string().url().optional().describe('Pull request URL (e.g. https://github.com/owner/repo/pull/123).'),
        prNumber: z.number().int().positive().optional().describe('Pull request number.'),
        agent: z.string().optional().describe('Agent name to assign (e.g. "claude", "codex"). Rejected if it is not a registered agent, with the valid names listed. Pass empty string to clear.'),
        priority: z.number().int().min(0).max(4).optional().describe('Task priority 0-4 (0 = none, 4 = highest).'),
        labels: z.array(z.string()).optional().describe('Replace the task\'s label list. Pass [] to clear all labels. Use kangentic_board_summary to see the labels this board already uses. If this same call also sets a long description (roughly 1KB or more), set labels in a separate labels-only update instead, or they may be dropped before reaching the server.'),
        baseBranch: z.string().optional().describe('Base branch the task\'s worktree branches from (e.g. "main").'),
        useWorktree: z.boolean().optional().describe('Whether the task uses an isolated git worktree. Set false and nothing is checked out: no worktree is created, the user\'s working tree is untouched, and the agent runs in the project directory on whatever branch the repo currently has out.'),
        model: z.string().max(200).optional().describe('Model override for this task (e.g. "opus", "claude-opus-4-8", or the friendly "Opus 4.8"). A friendly name is converted to the CLI id, then checked against the models the resolved agent offers; an unknown one is rejected here with the valid list. When that agent enumerates no models, the value is accepted as given. Pass empty string to clear.'),
        effort: z.string().max(50).optional().describe('Effort/reasoning level override for this task (e.g. "xhigh"). Valid values are agent-specific and checked here against the resolved agent; an agent with no effort levels accepts any value. Pass empty string to clear.'),
        permissionMode: z.union([PERMISSION_MODE_SCHEMA, z.literal('')]).optional().describe('Permission mode override for this task. Pass empty string to clear.'),
        profile: z.string().optional().describe('Board Profile this task rides (name or id) - an alternate set of per-column agent/model/effort settings, applied as the task moves. Pass empty string to clear it back to "Default". Mutually exclusive with the model/effort/agent/permissionMode pins: setting a profile clears them and setting any of them clears the profile. Use kangentic_list_board_profiles to see the board\'s profiles.'),
        runMode: RUN_MODE_SCHEMA.optional().describe('How this task gets its agent settings. "column_settings" follows each column the task moves through, and clears the model/effort/permissionMode pins. "agent_override" pins them for the task\'s whole life and clears the profile; fields left unset resolve dynamically until the task first spawns, which then locks all four. Setting any pin implies "agent_override", so you only need this to switch modes without pinning anything - and setting a pin alongside "column_settings" is rejected as a contradiction (pass the pin as an empty string to clear it instead). Omit to leave the task\'s current mode alone.'),
        attachments: z.array(z.object({
          filePath: z.string().describe('Absolute path to the file to attach'),
          filename: z.string().optional().describe('Override display filename'),
        })).optional().describe('File attachments to ADD to the task. This is additive - existing attachments are kept, not replaced. Each entry needs `filePath` (absolute) and may override the display `filename`. Use kangentic_remove_task_attachment to remove one.'),
        project: z.string().optional().describe(PROJECT_SELECTOR_DESCRIPTION),
      }),
      annotations: MUTATING_ANNOTATIONS,
    },
    async ({ taskId, title, description, descriptionEdits, appendDescription, prUrl, prNumber, agent, priority, labels, baseBranch, useWorktree, model, effort, permissionMode, profile, runMode, attachments, project }) => {
      if (
        title === undefined && description === undefined && descriptionEdits === undefined && appendDescription === undefined &&
        prUrl === undefined && prNumber === undefined &&
        agent === undefined && priority === undefined && labels === undefined && baseBranch === undefined &&
        useWorktree === undefined && model === undefined && effort === undefined && permissionMode === undefined &&
        profile === undefined && runMode === undefined && attachments === undefined
      ) {
        return { content: [{ type: 'text' as const, text: 'Provide at least one field to update.' }], isError: true };
      }
      if (description !== undefined && (descriptionEdits !== undefined || appendDescription !== undefined)) {
        return { content: [{ type: 'text' as const, text: 'Pass either `description` (full replace) or `descriptionEdits`/`appendDescription` (in-place edits), not both.' }], isError: true };
      }
      // Same reasoning as create_task: the repository clears whichever side this
      // write did not set, so accepting both would discard half the request.
      // `runMode: 'agent_override'` counts as a pin here - it is the one way to
      // claim override mode without setting one.
      if (profile && (model || effort || permissionMode || runMode === 'agent_override')) {
        return { content: [{ type: 'text' as const, text: 'Pass either `profile` (per-column settings as the task moves) or the model/effort/permissionMode pins, or runMode: "agent_override" (one set for the task\'s whole life), not both.' }], isError: true };
      }
      // The mirror image, and rejected for the same reason: setting a pin IS
      // asking for override mode, so pairing it with 'column_settings' is a
      // contradiction the repository would resolve silently in the pin's
      // favour. Truthiness, not `!== undefined`, so the empty-string CLEAR
      // sentinel still pairs legally with 'column_settings' - clearing a pin
      // and following the columns agree.
      if (runMode === 'column_settings' && (model || effort || permissionMode)) {
        return { content: [{ type: 'text' as const, text: 'Pass either the model/effort/permissionMode pins (which already imply runMode: "agent_override") or runMode: "column_settings" (follow each column, clearing the pins), not both.' }], isError: true };
      }
      return withProject(resolver, project, async (ctx, resolved) => {
        // Only the pins present on THIS call are validated. Re-checking the
        // task's stored values would make a labels-only follow-up start failing
        // on a task carrying a since-deprecated model pin - which is exactly
        // the follow-up the labels notice below asks for.
        const normalizedModel = model !== undefined ? (model ? resolveModelSelector(model) : null) : undefined;
        const normalizedEffort = effort !== undefined ? (effort ? resolveEffortSelector(effort) : null) : undefined;
        if (normalizedModel || normalizedEffort || agent) {
          const agentConfig = resolver.getAgentValidationConfig();
          const ladderRungs = agentLadderRungsForTask(ctx, taskId);
          // An explicit `agent: ""` CLEARS the task's pin, so the stored value is
          // about to disappear and must not anchor the ladder. Leaving it in
          // place would validate a model against the OLD agent on a call whose
          // whole point is to move off it, rejecting a value the post-write
          // resolution accepts - the false-rejection direction this module
          // promises never to take.
          const clearsAgentPin = agent === '';
          const rejection = await validateSpawnOverrides({
            agentOverride: agent || null,
            modelOverride: normalizedModel ?? null,
            effortOverride: normalizedEffort ?? null,
            taskAgentOverride: clearsAgentPin ? null : ladderRungs.taskAgentOverride,
            laneAgentOverride: ladderRungs.laneAgentOverride,
            projectDefaultAgent: resolver.getProjectDefaultAgent(resolved.projectId),
            cliPathOverrides: agentConfig.cliPathOverrides,
            discoveredModelsByAgent: agentConfig.discoveredModelsByAgent,
          });
          if (rejection) {
            return { content: [{ type: 'text' as const, text: `${rejection} The task was not updated.` }], isError: true };
          }
        }
        const result = await callHandler('update_task', {
          taskId,
          title: title ?? null,
          description: description ?? null,
          descriptionEdits: descriptionEdits ?? null,
          appendDescription: appendDescription ?? null,
          prUrl: prUrl ?? null,
          prNumber: prNumber ?? null,
          agent: agent ?? null,
          priority: priority ?? null,
          labels: labels ?? null,
          baseBranch: baseBranch ?? null,
          useWorktree: useWorktree ?? null,
          model: normalizedModel,
          effort: normalizedEffort,
          permissionMode: permissionMode !== undefined ? (permissionMode || null) : undefined,
          profile: profile !== undefined ? (profile || null) : undefined,
          runMode: runMode ?? undefined,
          attachments: attachments ?? null,
        }, ctx, 'Failed to update task');
        return withLabelsAbsentNotice(
          result,
          'kangentic_update_task',
          toolArgumentNotices,
          `send a labels-only kangentic_update_task for taskId "${taskId}"`,
        );
      });
    },
  );

  // --- kangentic_link_pr ---
  server.registerTool(
    'kangentic_link_pr',
    {
      description: 'Authoritatively resolve and link the pull request for a task\'s git branch using the gh CLI (`gh pr list --head <branch>`). Unlike the terminal-scraping auto-linker, this finds PRs opened by a human, the web UI, `git push`, scripts, or `gh api`, and works even when the task has no live session. Re-running refreshes the linked PR\'s state (open/draft/merged/closed). Use after opening a PR, or to backfill a task whose PR was never linked. Find the task ID first with kangentic_find_task. Pass `project` to target a different project.',
      inputSchema: z.object({
        taskId: z.string().describe('Task ID (numeric display ID like "42" or full UUID).'),
        project: z.string().optional().describe(PROJECT_SELECTOR_DESCRIPTION),
      }),
      annotations: MUTATING_ANNOTATIONS,
    },
    async ({ taskId, project }) => withProject(resolver, project, (ctx) => callHandler('link_pr', { taskId }, ctx, 'Failed to resolve PR')),
  );

  // --- kangentic_move_task ---
  server.registerTool(
    'kangentic_move_task',
    {
      description: 'Move a task to a different column, optionally placing it at a chosen slot in that column. Triggers the same lifecycle as a UI drag: spawning/suspending agents, creating/cleaning up worktrees, and running configured transition actions. Moving to the Done column auto-archives the task. Moving to To Do kills the session and removes the worktree. Naming the task\'s CURRENT column together with `position` repositions it in place, which changes nothing but its order - no session, worktree, or lifecycle effects. To re-sequence several tasks at once, use kangentic_reorder_tasks. If the user\'s prompt names a different Kangentic project, pass that name as `project` to route the move to that project instead of the active default. The name counts however it is phrased: "move task #7 in X to Done", "on the X board", and "in X" all target project X.',
      inputSchema: z.object({
        taskId: z.string().describe('Task ID (numeric display ID like "42" or full UUID).'),
        column: z.string().describe('Target column name (case-insensitive, e.g. "Review", "In Progress", "Done").'),
        position: z.number().int().min(0).optional().describe('Zero-based ordinal slot among the column\'s tasks (not a raw stored position); the tasks at and below it shift down. Clamped to the column, so a value past the end lands last. Repositioning within the task\'s current column counts slots among the OTHER tasks there, so 0 is the top. Omit to append to the end of the column, which is the default. Has no useful effect when moving into Done, which archives the task.'),
        project: z.string().optional().describe(PROJECT_SELECTOR_DESCRIPTION),
      }),
      annotations: MUTATING_ANNOTATIONS,
    },
    async ({ taskId, column, position, project }) => withProject(resolver, project, (ctx) => callHandler('move_task', { taskId, column, position: position ?? null }, ctx, 'Failed to move task')),
  );

  // --- kangentic_reorder_tasks ---
  server.registerTool(
    'kangentic_reorder_tasks',
    {
      description: 'Set the order of tasks within one column, top to bottom, in a single call. Use this to sequence a column by priority or execution order ("order To Do so the auth work comes first"). The listed tasks take the top slots in the order given; any task in the column you do not list keeps its relative order below them, so you can pass every task to set the full order or just a few to pin them to the top. Read the current order first with kangentic_list_tasks or kangentic_get_column_detail. This never moves a task between columns and never spawns, suspends, or otherwise touches a session or worktree - use kangentic_move_task to change a task\'s column. Pass `project` to reorder a column in a different project.',
      inputSchema: z.object({
        column: z.string().describe('Column name whose tasks are being reordered (case-insensitive).'),
        taskIds: z.array(z.string()).min(1).describe('Task IDs (numeric display IDs like "42" or full UUIDs), in the order they should appear from the top of the column. Every ID must already be in that column.'),
        project: z.string().optional().describe(PROJECT_SELECTOR_DESCRIPTION),
      }),
      annotations: MUTATING_ANNOTATIONS,
    },
    async ({ column, taskIds, project }) => withProject(resolver, project, (ctx) => callHandler('reorder_tasks', { column, taskIds }, ctx, 'Failed to reorder tasks')),
  );

  // --- kangentic_move_task_to_project ---
  server.registerTool(
    'kangentic_move_task_to_project',
    {
      description: 'Relocate a task from the To Do column of one project\'s board to a different project\'s board. Only tasks in To Do can be moved (a task outside To Do may have a live session or worktree that cannot cross projects - move it to To Do first). Preserves title, description, labels, priority, creation time, and attachments; assigns a new task ID and display number in the target project. Lands in the target board\'s To Do column by default, or pass `column` to land in a different target column. `targetProject` is required - use kangentic_list_projects to find valid names. `project` optionally selects the source project (defaults to the active one) the same way it does on other tools.',
      inputSchema: z.object({
        taskId: z.string().describe('Task ID (numeric display ID like "42" or full UUID) of the To Do task in the source project.'),
        targetProject: z.string().min(1, 'targetProject is required and must name a different project than the source.').describe('Destination project name (case-insensitive) or UUID. Must be a different project than the source.'),
        column: z.string().optional().describe('Target column on the destination board (case-insensitive). Defaults to the destination board\'s To Do column.'),
        project: z.string().optional().describe(PROJECT_SELECTOR_DESCRIPTION),
      }),
      annotations: MUTATING_ANNOTATIONS,
    },
    async ({ taskId, targetProject, column, project }) => {
      const target = resolver.resolveProject(targetProject);
      if ('error' in target) {
        return { content: [{ type: 'text' as const, text: target.error }], isError: true };
      }
      const sourceResolved = resolver.resolveProject(project);
      if ('error' in sourceResolved) {
        return { content: [{ type: 'text' as const, text: sourceResolved.error }], isError: true };
      }
      if (sourceResolved.projectId === target.projectId) {
        return {
          content: [{ type: 'text' as const, text: 'Source and target are the same project. Use kangentic_move_task to move a task between columns within a project.' }],
          isError: true,
        };
      }
      try {
        const response = handleMoveTaskToProject({ taskId, column }, sourceResolved.context, target.context);
        return response.success
          ? { content: [{ type: 'text' as const, text: response.message ?? JSON.stringify(response.data ?? {}) }] }
          : { content: [{ type: 'text' as const, text: response.error ?? 'Failed to move task to project' }], isError: true };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }], isError: true };
      }
    },
  );

  // --- kangentic_update_column ---
  server.registerTool(
    'kangentic_update_column',
    {
      description: 'Update a swimlane (column) configuration. Supports renaming, setting a free-form description, recoloring, toggling auto-spawn, setting an auto-command template, overriding the agent for the column, changing permission mode, enabling handoff context, and setting a plan-exit target column. Use kangentic_get_column_detail to inspect current values first. Pass `project` to update a column in a different project.',
      inputSchema: z.object({
        column: z.string().describe('Column name to update (case-insensitive, e.g. "Review").'),
        name: z.string().max(100).optional().describe('New column name.'),
        description: z.string().max(1000).nullable().optional().describe('Free-form description of the column\'s purpose, shown as a header tooltip and shared with the team via kangentic.json. Null to clear.'),
        color: z.string().optional().describe('Hex color (e.g. "#71717a").'),
        icon: z.string().nullable().optional().describe('Lucide icon name, or null to clear.'),
        autoSpawn: z.boolean().optional().describe('Whether moving a task into this column auto-spawns an agent.'),
        autoCommand: z.string().max(4000).nullable().optional().describe('Slash command template injected when an agent spawns in this column (e.g. "/review --strict"). Null to clear.'),
        agentOverride: z.string().nullable().optional().describe('Force a specific agent for this column (e.g. "codex"). Null to use project default.'),
        modelOverride: z.string().max(200).nullable().optional().describe('Adapter-specific model identifier passed at spawn time (e.g. Claude "opus", "sonnet", "claude-opus-4-7"). Null to inherit the agent default.'),
        effortOverride: z.string().max(50).nullable().optional().describe('Adapter-specific effort/reasoning level passed at spawn time (e.g. Claude "low", "medium", "high", "xhigh", "max"). Valid values are agent-specific. Null to inherit the agent default.'),
        permissionMode: PERMISSION_MODE_SCHEMA.nullable().optional().describe('Permission mode for agents spawned in this column. Null to use project default.'),
        handoffContext: z.boolean().optional().describe('Enable multi-agent handoff context preservation when entering this column.'),
        planExitTargetColumn: z.string().nullable().optional().describe('Column to auto-move the task to when an agent in plan mode exits planning. Null to disable.'),
        project: z.string().optional().describe(PROJECT_SELECTOR_DESCRIPTION),
      }),
      annotations: MUTATING_ANNOTATIONS,
    },
    async ({ column, name, description, color, icon, autoSpawn, autoCommand, agentOverride, modelOverride, effortOverride, permissionMode, handoffContext, planExitTargetColumn, project }) => withProject(resolver, project, (ctx) => callHandler('update_column', {
      column,
      name: name ?? undefined,
      description: description === undefined ? undefined : description,
      color: color ?? undefined,
      icon: icon === undefined ? undefined : icon,
      autoSpawn: autoSpawn ?? undefined,
      autoCommand: autoCommand === undefined ? undefined : autoCommand,
      agentOverride: agentOverride === undefined ? undefined : agentOverride,
      modelOverride: modelOverride === undefined ? undefined : modelOverride,
      effortOverride: effortOverride === undefined ? undefined : effortOverride,
      permissionMode: permissionMode === undefined ? undefined : permissionMode,
      handoffContext: handoffContext ?? undefined,
      planExitTargetColumn: planExitTargetColumn === undefined ? undefined : planExitTargetColumn,
    }, ctx, 'Failed to update column')),
  );

  // --- kangentic_create_column ---
  server.registerTool(
    'kangentic_create_column',
    {
      description: 'Add a new swimlane (column) to the Kangentic board. By default it lands just before Done, which is where a new workflow stage almost always belongs. Column names must be unique (case-insensitive). Roles are structural and cannot be set: To Do and Done already exist on every board. Pass `project` to add a column to a different project.',
      inputSchema: z.object({
        name: z.string().max(100).describe('Column name, unique on this board (case-insensitive).'),
        description: z.string().max(1000).optional().describe('Free-form description of the column\'s purpose, shown as a header tooltip and shared with the team via kangentic.json.'),
        color: z.string().optional().describe('Hex color (e.g. "#71717a"). Defaults to blue.'),
        icon: z.string().optional().describe('Lucide icon name.'),
        autoSpawn: z.boolean().optional().describe('Whether moving a task into this column auto-spawns an agent. Defaults to true.'),
        autoCommand: z.string().max(4000).optional().describe('Slash command template injected when an agent spawns in this column (e.g. "/review --strict").'),
        agentOverride: z.string().optional().describe('Force a specific agent for this column (e.g. "codex"). Omit to use the project default.'),
        modelOverride: z.string().max(200).optional().describe('Adapter-specific model identifier passed at spawn time (e.g. Claude "opus", "sonnet"). Omit to inherit the agent default.'),
        effortOverride: z.string().max(50).optional().describe('Adapter-specific effort/reasoning level passed at spawn time (e.g. Claude "low", "high", "xhigh"). Omit to inherit the agent default.'),
        permissionMode: PERMISSION_MODE_SCHEMA.optional().describe('Permission mode for agents spawned in this column. Omit to use the project default.'),
        handoffContext: z.boolean().optional().describe('Enable multi-agent handoff context preservation when entering this column.'),
        planExitTargetColumn: z.string().optional().describe('Column to auto-move the task to when an agent in plan mode exits planning.'),
        position: z.number().int().min(0).optional().describe('Zero-based ordinal slot among the board\'s columns (not a raw stored position); later columns shift right. Clamped between the role columns: a value below the lowest legal slot lands immediately after To Do, and a value at or past Done lands immediately before Done, never after it. Omit for the default placement just before Done.'),
        project: z.string().optional().describe(PROJECT_SELECTOR_DESCRIPTION),
      }),
      annotations: MUTATING_ANNOTATIONS,
    },
    async ({ name, description, color, icon, autoSpawn, autoCommand, agentOverride, modelOverride, effortOverride, permissionMode, handoffContext, planExitTargetColumn, position, project }) => withProject(resolver, project, (ctx) => callHandler('create_column', {
      name,
      description,
      color,
      icon,
      autoSpawn,
      autoCommand,
      agentOverride,
      modelOverride,
      effortOverride,
      permissionMode,
      handoffContext,
      planExitTargetColumn,
      position,
    }, ctx, 'Failed to create column'), { alwaysAnnotate: true }),
  );

  // --- kangentic_delete_column ---
  server.registerTool(
    'kangentic_delete_column',
    {
      description: 'Delete a swimlane (column) from the Kangentic board. Refused in two cases, deliberately: a column that still holds tasks (move them with kangentic_move_task first - this tool never touches a task), and a role column (To Do / Done), which the board depends on. Everything pointing at the deleted column is cleaned up in the same operation: lane transitions, other columns\' plan-exit targets, and Board Profile entries. The response reports what was cleaned. Pass `project` to delete a column from a different project.',
      inputSchema: z.object({
        column: z.string().describe('Column name to delete (case-insensitive, e.g. "Brand Review").'),
        project: z.string().optional().describe(PROJECT_SELECTOR_DESCRIPTION),
      }),
      annotations: MUTATING_ANNOTATIONS,
    },
    async ({ column, project }) => withProject(resolver, project, (ctx) => callHandler('delete_column', {
      column,
    }, ctx, 'Failed to delete column'), { alwaysAnnotate: true }),
  );

  // --- kangentic_delete_task ---
  server.registerTool(
    'kangentic_delete_task',
    {
      description: 'Permanently delete a task from the Kangentic board. This removes the task, its attachments, and session records. The associated worktree and branch may also be cleaned up. Find the task ID first with kangentic_find_task or kangentic_search_tasks. Pass `project` to delete a task in a different project.',
      inputSchema: z.object({
        taskId: z.string().describe('Task ID (numeric display ID like "42" or full UUID).'),
        project: z.string().optional().describe(PROJECT_SELECTOR_DESCRIPTION),
      }),
      annotations: MUTATING_ANNOTATIONS,
    },
    async ({ taskId, project }) => withProject(resolver, project, (ctx) => callHandler('delete_task', { taskId }, ctx, 'Failed to delete task')),
  );

  // --- kangentic_remove_task_attachment ---
  server.registerTool(
    'kangentic_remove_task_attachment',
    {
      description: 'Remove one attachment by its attachment ID, from a board task or a backlog item - the ID alone determines which. Find attachment IDs with kangentic_query_db (e.g. `SELECT id, filename, task_id FROM task_attachments` for board tasks, or `SELECT id, filename, backlog_task_id FROM backlog_attachments` for backlog items). Pass `project` to remove an attachment in a different project.',
      inputSchema: z.object({
        attachmentId: z.string().describe('Attachment UUID (board task_attachments.id or backlog backlog_attachments.id).'),
        project: z.string().optional().describe(PROJECT_SELECTOR_DESCRIPTION),
      }),
      annotations: MUTATING_ANNOTATIONS,
    },
    async ({ attachmentId, project }) => withProject(resolver, project, (ctx) => callHandler('remove_attachment', { attachmentId }, ctx, 'Failed to remove attachment')),
  );
}
