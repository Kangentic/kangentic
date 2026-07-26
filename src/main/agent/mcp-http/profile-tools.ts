import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v4';
import { callHandler, runHandler, withProject, PROJECT_SELECTOR_DESCRIPTION } from './handler-helpers';
import { READ_ONLY_ANNOTATIONS, MUTATING_ANNOTATIONS } from './annotations';
import type { RequestResolver } from './project-resolver';

const PERMISSION_MODE_SCHEMA = z.enum(['default', 'plan', 'acceptEdits', 'dontAsk', 'bypassPermissions', 'auto']);

/**
 * One column's settings inside a profile.
 *
 * THREE STATES, and the difference is load-bearing:
 *   - omit the key   -> inherit whatever the column itself is configured with
 *   - pass `null`    -> clear to the agent default, overriding the column's own pin
 *   - pass a value   -> use that value in this column
 * `.nullable().optional()` is what preserves all three across the wire: an
 * omitted key never reaches the handler, while an explicit null does.
 */
const PROFILE_ENTRY_SCHEMA = z.object({
  agentOverride: z.string().nullable().optional().describe('Agent to run this column with (e.g. "claude", "codex").'),
  modelOverride: z.string().max(200).nullable().optional().describe('Model to run this column with (e.g. "opus", "claude-opus-5").'),
  effortOverride: z.string().max(50).nullable().optional().describe('Effort/reasoning level for this column (e.g. "xhigh", "high"). Valid values are agent-specific.'),
  permissionMode: PERMISSION_MODE_SCHEMA.nullable().optional().describe('Permission mode for this column.'),
  autoCommand: z.string().max(4000).nullable().optional().describe('Slash command run when the agent spawns in this column (e.g. "/code-review").'),
  autoSpawn: z.boolean().nullable().optional().describe('Whether moving a task into this column spawns an agent.'),
  handoffContext: z.boolean().nullable().optional().describe('Whether this column hands the previous session\'s context to the new agent.'),
  sessionTarget: z.enum(['main', 'isolated']).nullable().optional().describe('Whether this column reuses the task\'s main session or gets its own isolated one.'),
  sessionSpawnStrategy: z.enum(['create_or_resume', 'always_spawn_new']).nullable().optional().describe('Whether this column resumes an existing session or always starts a fresh one.'),
  planExitTarget: z.string().nullable().optional().describe('Column NAME a task moves to when the agent exits plan mode in this column.'),
}).describe('Settings this profile applies to one column. Omit a key to inherit the column\'s own setting; pass null to clear it to the agent default.');

const COLUMNS_DESCRIPTION =
  'Per-column settings, keyed by COLUMN NAME (e.g. {"Planning": {"modelOverride": "opus", "effortOverride": "xhigh"}}). '
  + 'Use kangentic_list_columns for valid names. Sparse by design: list only the columns this profile changes. '
  + 'An unknown column name fails the whole call rather than being silently dropped. '
  + 'To Do and Done columns never spawn agents, so entries for them have no effect.';

/**
 * Register the Board Profile tools.
 *
 * A Board Profile is a named alternate ladder of per-column strategy settings,
 * so one task can run Planning in Opus xhigh and Merge in Sonnet high while
 * another rides a cheaper ladder over the same board. A task selects one via
 * `profile` on kangentic_create_task / kangentic_update_task.
 *
 * These tools exist mainly to keep profiles in sync as models and strategies
 * change, which is tedious by hand and spans projects: "change Opus 4.8 to Opus
 * 5 everywhere", "copy this board's Heavy profile into project X", "what differs
 * between project A's and B's profiles". Every tool takes `project`, so a diff
 * or a copy is two calls against different boards.
 *
 * Profiles are addressed by NAME (or id) and their entries are keyed by COLUMN
 * NAME, never by uuid - names are what an agent can read from a listing, and
 * they are the only key that means anything when copying between projects.
 */
export function registerProfileTools(server: McpServer, resolver: RequestResolver): void {
  // --- kangentic_list_board_profiles ---
  server.registerTool(
    'kangentic_list_board_profiles',
    {
      description: 'List the board\'s Board Profiles - named alternate sets of per-column agent/model/effort settings that a task can ride as it moves across the board. Returns each profile\'s id, name, description, and its per-column settings keyed by column name (only the columns it overrides; every other column uses its own settings). "Default" is not listed: it is the synthetic profile meaning "every column uses its own settings", and a task on it simply has no profile. Pass `project` to read another project\'s profiles - call twice to compare two boards.',
      inputSchema: z.object({
        project: z.string().optional().describe(PROJECT_SELECTOR_DESCRIPTION),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ project }) => withProject(resolver, project, async (ctx) => {
      const response = await runHandler('list_board_profiles', {}, ctx);
      if (!response.success) {
        return { content: [{ type: 'text' as const, text: `Failed to list board profiles: ${response.error}` }], isError: true };
      }
      const profiles = response.data as Array<{
        id: string;
        name: string;
        description?: string;
        columns: Record<string, Record<string, unknown>>;
      }>;
      if (profiles.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No Board Profiles on this board. Every task runs each column\'s own settings ("Default").' }] };
      }
      // JSON rather than prose: the primary consumers are diff and copy, both of
      // which need the exact structure back out, and a null (clear) must stay
      // visibly distinct from an absent key.
      return { content: [{ type: 'text' as const, text: JSON.stringify(profiles, null, 2) }] };
    }),
  );

  // --- kangentic_create_board_profile ---
  server.registerTool(
    'kangentic_create_board_profile',
    {
      description: 'Create a Board Profile on the board: a named alternate set of per-column agent/model/effort settings a task can ride. Only list the columns the profile changes - every column you omit keeps its own settings. Names must be unique on the board. Pass `project` to create it on another project\'s board (the usual way to copy a profile between projects: read it with kangentic_list_board_profiles, then create it there by column name).',
      inputSchema: z.object({
        name: z.string().max(100).describe('Profile name, unique on this board (e.g. "Heavy", "Frugal").'),
        description: z.string().max(500).optional().describe('What this profile is for.'),
        columns: z.record(z.string(), PROFILE_ENTRY_SCHEMA).optional().describe(COLUMNS_DESCRIPTION),
        project: z.string().optional().describe(PROJECT_SELECTOR_DESCRIPTION),
      }),
      annotations: MUTATING_ANNOTATIONS,
    },
    async ({ name, description, columns, project }) => withProject(resolver, project, (ctx) => callHandler('create_board_profile', {
      name,
      description: description ?? null,
      columns: columns ?? {},
    }, ctx, 'Failed to create board profile'), { alwaysAnnotate: true }),
  );

  // --- kangentic_update_board_profile ---
  server.registerTool(
    'kangentic_update_board_profile',
    {
      description: 'Update a Board Profile: rename it, change its description, or change its per-column settings. `columns` MERGES by default, so you can retune one column without restating the rest - which is what makes a sweep like "change every profile\'s Opus 4.8 to Opus 5" safe. Pass replaceColumns: true to swap the whole set instead (use when copying a profile wholesale from another board). Within a column, omit a key to leave it alone, or pass null to clear it to the agent default. Pass `project` to update a profile on another project\'s board.',
      inputSchema: z.object({
        profile: z.string().describe('Profile name (case-insensitive) or id. Use kangentic_list_board_profiles to see them.'),
        name: z.string().max(100).optional().describe('New profile name. Must stay unique on the board.'),
        description: z.string().max(500).optional().describe('New description. Pass an empty string to clear it.'),
        columns: z.record(z.string(), PROFILE_ENTRY_SCHEMA).optional().describe(COLUMNS_DESCRIPTION),
        replaceColumns: z.boolean().optional().describe('Replace the profile\'s entire column set with `columns` instead of merging into it. Default false (merge).'),
        project: z.string().optional().describe(PROJECT_SELECTOR_DESCRIPTION),
      }),
      annotations: MUTATING_ANNOTATIONS,
    },
    async ({ profile, name, description, columns, replaceColumns, project }) => {
      if (name === undefined && description === undefined && columns === undefined) {
        return { content: [{ type: 'text' as const, text: 'Provide at least one of name, description, or columns to update.' }], isError: true };
      }
      return withProject(resolver, project, (ctx) => callHandler('update_board_profile', {
        profile,
        name: name ?? null,
        description,
        columns: columns ?? null,
        replaceColumns: replaceColumns ?? false,
      }, ctx, 'Failed to update board profile'), { alwaysAnnotate: true });
    },
  );

  // --- kangentic_delete_board_profile ---
  server.registerTool(
    'kangentic_delete_board_profile',
    {
      description: 'Delete a Board Profile from the board. Tasks currently riding it are left alone and fall back to each column\'s own settings ("Default"); the response reports how many. Pass `project` to delete from another project\'s board.',
      inputSchema: z.object({
        profile: z.string().describe('Profile name (case-insensitive) or id.'),
        project: z.string().optional().describe(PROJECT_SELECTOR_DESCRIPTION),
      }),
      annotations: MUTATING_ANNOTATIONS,
    },
    async ({ profile, project }) => withProject(resolver, project, (ctx) => callHandler('delete_board_profile', {
      profile,
    }, ctx, 'Failed to delete board profile'), { alwaysAnnotate: true }),
  );
}
