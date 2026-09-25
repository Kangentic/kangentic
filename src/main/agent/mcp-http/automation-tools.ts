import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v4';
import { callHandler, withProject, PROJECT_SELECTOR_DESCRIPTION } from './handler-helpers';
import { READ_ONLY_ANNOTATIONS, MUTATING_ANNOTATIONS } from './annotations';
import {
  AUTOMATION_MANIFEST,
  DEFAULT_SCRIPT_TIMEOUT_MINUTES,
  stableAutomationTypes,
} from '../../../shared/automation-manifest';
import type { RequestResolver } from './project-resolver';

/** The manifest's own bounds for the script budget, so this tool cannot drift from the dialog. */
const SCRIPT_TIMEOUT_FIELD = AUTOMATION_MANIFEST.run_script.fields
  .find((field) => field.key === 'timeoutMinutes') ?? { min: 1, max: 120 };

/**
 * The types an agent may write. Built from the manifest rather than restated,
 * so a new adapter is offered the day it registers and a retired one stops
 * being offered the day it is removed. `send_command` rides along as the one
 * accepted alias: it was this type's id before its field became `message`, and
 * an older skill still spells it that way.
 */
const [FIRST_STABLE_TYPE, ...OTHER_STABLE_TYPES] = stableAutomationTypes();
const AUTOMATION_TYPE_VALUES: [string, ...string[]] = [FIRST_STABLE_TYPE, ...OTHER_STABLE_TYPES, 'send_command'];

/**
 * One automation row, in the shape `kangentic.json` uses: the reserved keys
 * (`name`, `type`, `on`, `enabled`) plus the type's own fields flat on the
 * object. Flat rather than nested under a `with` key because a row usually has
 * one field, and `{"type": "webhook", "url": "..."}` reads better than wrapping
 * it. The reserved keys are pinned by a parity test, so an adapter cannot
 * declare a field that collides with one.
 */
const AUTOMATION_ROW_SCHEMA = z.object({
  id: z.string().optional().describe('Existing automation id, to keep this row\'s identity and run history across the write. Omit for a new row. Read one from kangentic_list_automations.'),
  name: z.string().max(200).describe('Label for this automation, unique on its column ignoring case. Shown in the Column Manager and in the run log.'),
  type: z.enum(AUTOMATION_TYPE_VALUES).describe('What this automation does. send_message types a message at the column\'s agent; run_script runs a shell script in the task\'s worktree; webhook calls a URL; notify raises a desktop notification.'),
  on: z.enum(['enter', 'exit']).optional().describe('Whether it runs when a task ENTERS this column or LEAVES it. Defaults to "enter". To Do and Done can only run exit automations.'),
  enabled: z.boolean().optional().describe('Defaults to true. A switched-off automation stays in the list and is skipped.'),

  // The per-type fields. Every type's keys live on one object because the row
  // shape is flat; a key belonging to another type is dropped on write rather
  // than stored, so a copied row cannot smuggle a stale field through.
  message: z.string().max(4000).optional().describe('send_message: the text typed at the agent. Supports template variables ({{title}}, {{taskNumber}}, {{baseBranch}}, {{fromColumn}}, {{toColumn}}).'),
  mode: z.enum(['immediate', 'deferred']).optional().describe('send_message: "immediate" types it as soon as the agent is ready, "deferred" waits for the agent to finish its current turn.'),
  script: z.string().max(8000).optional().describe('run_script: the script body, run in the task\'s worktree (or the project checkout when it has none). Every template variable is also exported as a KANGENTIC_* environment variable, which is the quoting-safe way to read one.'),
  // Bounds copied from the manifest field rather than restated, so an agent can
  // set exactly what a human can in the Column Manager. They were 1..60 here
  // against the manifest's 1..120, which made the tool refuse a value the UI
  // accepts, with nothing in either place pointing at the other.
  timeoutMinutes: z.number().int()
    .min(SCRIPT_TIMEOUT_FIELD.min ?? 1)
    .max(SCRIPT_TIMEOUT_FIELD.max ?? 120)
    .optional()
    .describe(`run_script: give up after this many minutes. Defaults to ${DEFAULT_SCRIPT_TIMEOUT_MINUTES}.`),
  url: z.string().max(2000).optional().describe('webhook: the URL to call.'),
  method: z.enum(['GET', 'POST', 'PUT']).optional().describe('webhook: defaults to POST.'),
  body: z.string().max(8000).optional().describe('webhook: request body. Empty sends the default JSON envelope.'),
  headers: z.string().max(4000).optional().describe('webhook: one per line, as "Name: Value".'),
  title: z.string().max(200).optional().describe('notify: the notification title. Defaults to {{title}}.'),
  promptTemplate: z.string().max(8000).optional().describe('spawn_agent (legacy, cannot be created): the prompt a legacy Start agent row spawns with.'),
}).describe('One automation. The type\'s own fields sit flat on this object beside name/type/on/enabled.');

/**
 * Register the column automation tools.
 *
 * A column's behavior used to be two swimlane fields (`auto_command` and its
 * mode) and a table of named actions nothing could edit. It is now an ordered
 * list of typed rows per column, split into On enter and On exit. These tools
 * are how an agent reads and writes that list; `kangentic_update_column`'s
 * `autoCommand` still works and writes the first send_message enter row, which
 * covers the common case in one argument.
 */
export function registerAutomationTools(server: McpServer, resolver: RequestResolver): void {
  // --- kangentic_list_automations ---
  server.registerTool(
    'kangentic_list_automations',
    {
      description: 'Read what happens when a task enters or leaves a column: the ordered On enter and On exit automations, their types, settings, and whether each one can actually run. Omit `column` to read the whole board, which is the right first call for "what does this board do". Pair with kangentic_set_automations to change them.',
      inputSchema: z.object({
        column: z.string().optional().describe('Column name (case-insensitive, e.g. "Code Review"). Omit to read every column.'),
        project: z.string().optional().describe(PROJECT_SELECTOR_DESCRIPTION),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ column, project }) => withProject(resolver, project, (ctx) => callHandler('list_automations', {
      column: column ?? null,
    }, ctx, 'Failed to list automations')),
  );

  // --- kangentic_set_automations ---
  server.registerTool(
    'kangentic_set_automations',
    {
      description: 'Replace one column\'s automations WHOLESALE. The array you pass becomes that column\'s entire list, in order, so read the current rows with kangentic_list_automations first and send them back with your change applied. Pass [] to remove them all. Array order is the run order within each trigger group. Carry each existing row\'s `id` through so it keeps its identity and run history; a row with no id is created fresh. Names must be unique within the column, ignoring case.',
      inputSchema: z.object({
        column: z.string().describe('Column name (case-insensitive) whose automations to replace.'),
        automations: z.array(AUTOMATION_ROW_SCHEMA).max(50).describe('The column\'s complete new list, in run order. This REPLACES what is there.'),
        project: z.string().optional().describe(PROJECT_SELECTOR_DESCRIPTION),
      }),
      annotations: MUTATING_ANNOTATIONS,
    },
    async ({ column, automations, project }) => withProject(resolver, project, (ctx) => callHandler('set_automations', {
      column,
      automations,
    }, ctx, 'Failed to set automations')),
  );

  // --- kangentic_get_automation_runs ---
  server.registerTool(
    'kangentic_get_automation_runs',
    {
      description: 'Read the automation run log: what ran, when, whether it succeeded, and why it did not. This is how to answer "did my automation work" and how to see a failure\'s detail after the fact. Ask by task (everything that ran for one card) or by column (every run of that column\'s automations). A run left "interrupted" was in flight when Kangentic last quit; the shutdown path is synchronous, so it could not be finished, and nothing is retried automatically.',
      inputSchema: z.object({
        task: z.string().optional().describe('Task id or #number. Returns every automation run recorded for that task, newest first.'),
        column: z.string().optional().describe('Column name. Returns runs of the automations that column holds now, newest first.'),
        limit: z.number().int().min(1).max(50).optional().describe('Maximum runs to return. Defaults to 50.'),
        project: z.string().optional().describe(PROJECT_SELECTOR_DESCRIPTION),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ task, column, limit, project }) => withProject(resolver, project, (ctx) => callHandler('get_automation_runs', {
      task: task ?? null,
      column: column ?? null,
      limit,
    }, ctx, 'Failed to read automation runs')),
  );

  // --- kangentic_run_automation ---
  server.registerTool(
    'kangentic_run_automation',
    {
      description: 'Run ONE automation now, against the named task\'s CURRENT state. Use it to retry a failed automation or to test one you just wrote. Current state, not the state of the move that first ran it: the task may have moved since, and template variables such as {{toColumn}} resolve against where it is now, while {{fromColumn}} and {{trigger}} resolve empty because there is no move. It writes a fresh run row either way. It will NOT start an agent, so a send_message automation on a task with no live session is recorded skipped rather than spawning one.',
      inputSchema: z.object({
        column: z.string().describe('Column name the automation belongs to.'),
        automation: z.string().describe('Automation name on that column (case-insensitive). Read the names from kangentic_list_automations.'),
        task: z.string().describe('Task id or #number to run it against.'),
        project: z.string().optional().describe(PROJECT_SELECTOR_DESCRIPTION),
      }),
      annotations: MUTATING_ANNOTATIONS,
    },
    async ({ column, automation, task, project }) => withProject(resolver, project, (ctx) => callHandler('run_automation', {
      column,
      automation,
      task,
    }, ctx, 'Failed to run the automation')),
  );
}
