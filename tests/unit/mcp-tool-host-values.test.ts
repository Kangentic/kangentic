/**
 * Enforces `.claude/rules/mcp-tool-host-values.md`: an MCP tool answers from the layer its fact belongs to.
 *
 * For a remote project `worktree_path`, `sessions.cwd` and `project.path` are an empty stand-in on this computer.
 * Nothing fails when one reaches an agent: it takes the path at its word. A scan cannot prove what a value means, so
 * this one makes a decision visible in two places.
 *
 * Every registered tool is classified here, so a new tool fails until someone says which layer it answers from. And
 * every line that reads one of those values goes through `agentPaths` or says why it may not, so a new read of one
 * fails where it is written. The per-tool fixtures (`mcp-remote-*.test.ts`) pin the values themselves.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { hasOptOutMarker } from './helpers/opt-out-marker';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const MCP_HTTP_DIR = path.join(REPO_ROOT, 'src/main/agent/mcp-http');
const COMMANDS_DIR = path.join(REPO_ROOT, 'src/main/agent/commands');

type ToolClass =
  /** Where the agent works: answers with the host's value, through `agentPaths`, a host read or a `location` label. */
  | 'host-value'
  /** About this computer: returned as it is, with `location: 'local'`. */
  | 'local'
  /** Carries no path, pid, port or URL. */
  | 'no-path';

const TOOLS: Record<string, ToolClass> = {
  // A path, a git fact or a port of where the agent works, or a path the agent passes in.
  kangentic_find_task: 'host-value',
  kangentic_get_current_task: 'host-value',
  kangentic_list_worktrees: 'host-value',
  kangentic_list_projects: 'host-value',
  kangentic_search: 'host-value',
  kangentic_list_sessions: 'host-value',
  kangentic_get_session_files: 'host-value',
  kangentic_get_session_events: 'host-value',
  kangentic_get_session_history: 'host-value',
  kangentic_get_handoff_context: 'host-value',
  kangentic_get_transcript: 'host-value',
  kangentic_create_task: 'host-value',
  kangentic_update_task: 'host-value',
  kangentic_update_backlog_item: 'host-value',
  kangentic_request_project_access: 'host-value',
  kangentic_reserve_dev_ports: 'host-value',
  kangentic_check_dev_ports: 'host-value',
  kangentic_query_db: 'host-value',
  kangentic_browser_screenshot: 'host-value',
  kangentic_browser_screenshot_element: 'host-value',
  kangentic_browser_query_dom: 'host-value',
  kangentic_browser_eval: 'host-value',
  kangentic_browser_drop_files: 'host-value',

  // The app's own logs and processes, and the pane's URLs, which are the user's computer wherever the agent runs.
  kangentic_tail_logs: 'local',
  kangentic_get_recent_crashes: 'local',
  kangentic_get_ipc_log: 'local',
  kangentic_get_process_metrics: 'local',
  kangentic_browser_list_panes: 'local',
  kangentic_browser_open_pane: 'local',
  kangentic_browser_navigate: 'local',
  kangentic_browser_history: 'local',
  kangentic_browser_network: 'local',
};

/** Tools that carry no path, pid, port or URL, by why. */
const NO_PATH: Record<string, readonly string[]> = {
  'board and task rows, read or written by id, and counts': [
    'kangentic_list_tasks', 'kangentic_search_tasks', 'kangentic_board_summary', 'kangentic_list_columns', 'kangentic_get_column_detail',
    'kangentic_create_column', 'kangentic_update_column', 'kangentic_delete_column', 'kangentic_delete_task', 'kangentic_move_task',
    'kangentic_move_task_to_project', 'kangentic_reorder_tasks', 'kangentic_link_pr', 'kangentic_remove_task_attachment', 'kangentic_set_task_route',
  ],
  'the backlog, by id': ['kangentic_list_backlog', 'kangentic_delete_backlog_item', 'kangentic_promote_backlog'],
  'board profiles and automations, which are configuration': [
    'kangentic_list_board_profiles', 'kangentic_create_board_profile', 'kangentic_update_board_profile', 'kangentic_delete_board_profile',
    'kangentic_list_automations', 'kangentic_set_automations', 'kangentic_run_automation', 'kangentic_get_automation_runs',
  ],
  'workflows, by id and title': [
    'kangentic_list_workflows', 'kangentic_get_workflow', 'kangentic_save_workflow', 'kangentic_start_workflow', 'kangentic_pause_workflow',
    'kangentic_resume_workflow', 'kangentic_delete_workflow', 'kangentic_add_workflow_task', 'kangentic_remove_from_workflow',
    'kangentic_link_workflow_tasks', 'kangentic_unlink_workflow_tasks',
  ],
  'counts and spans of time': ['kangentic_get_task_stats', 'kangentic_get_usage_stats', 'kangentic_get_activity_intervals'],
  'commits and files by their repository paths, which name the same thing on both machines': ['kangentic_get_task_report'],
  'text sent to and read from an agent': ['kangentic_send_session_message', 'kangentic_get_session_messages_sent'],
  'the agent\'s own shell ids': ['kangentic_mark_background_service'],
  'the page in the pane, by selector and pixel, with no path or URL of its own': [
    'kangentic_browser_close_pane', 'kangentic_browser_click', 'kangentic_browser_type', 'kangentic_browser_keypress', 'kangentic_browser_hover',
    'kangentic_browser_scroll', 'kangentic_browser_drag', 'kangentic_browser_select_option', 'kangentic_browser_wait', 'kangentic_browser_query_all',
    'kangentic_browser_bounding_box', 'kangentic_browser_console', 'kangentic_browser_handle_dialog', 'kangentic_browser_set_viewport',
    'kangentic_browser_dock', 'kangentic_browser_pop_out',
  ],
};

function registeredTools(): string[] {
  const names: string[] = [];
  for (const entry of fs.readdirSync(MCP_HTTP_DIR)) {
    if (!entry.endsWith('-tools.ts')) continue;
    const content = fs.readFileSync(path.join(MCP_HTTP_DIR, entry), 'utf-8');
    for (const match of content.matchAll(/registerTool\(\s*['"]([^'"]+)['"]/g)) names.push(match[1]);
  }
  return names;
}

function classified(): Map<string, string> {
  const classes = new Map<string, string>(Object.entries(TOOLS));
  for (const [reason, names] of Object.entries(NO_PATH)) for (const name of names) classes.set(name, reason);
  return classes;
}

/** What reads a value that is this computer's stand-in on a remote project. */
const STAND_IN_READ = /\bworktree_path\b|\bgetProjectPath\(\)|\bproject\.path\b|\b(?:session|record|row)\.cwd\b/;
/** The line is going through the map. */
const THROUGH_AGENT_PATHS = /\bpaths\.(?:toAgent|fromAgent|sessionFileToAgent|mirrorToAgent)\(/;
/** A comment, a type's field, a query, or a tool's description, none of which reads anything into an answer. */
const NOT_A_READ = /^\s*(?:\/\/|\*|\/\*)|^\s*\w+\??:\s*(?:string|number|boolean)\b|^\s*`?\s*(?:SELECT|FROM|WHERE)\b|^\s*description: '|\.describe\('/;

/** Handlers and tool bodies, and the one module a tool answers from outside them. */
function scannedFiles(): string[] {
  const inFolder = (directory: string): string[] => fs.readdirSync(directory)
    .filter((entry) => entry.endsWith('.ts'))
    .map((entry) => path.join(directory, entry));
  return [...inFolder(COMMANDS_DIR), ...inFolder(MCP_HTTP_DIR), path.join(REPO_ROOT, 'src/main/git/worktree-list.ts')];
}

describe('an MCP tool answers from the layer its fact belongs to', () => {
  it('finds the tools it classifies', () => {
    expect(registeredTools().length).toBeGreaterThan(80);
  });

  it('classifies every registered tool, so a new one says which layer it answers from', () => {
    const classes = classified();
    const unclassified = registeredTools().filter((name) => !classes.has(name));
    expect(unclassified, 'Add these to TOOLS or NO_PATH in this test, and see .claude/rules/mcp-tool-host-values.md').toEqual([]);
  });

  it('classifies no tool that is gone', () => {
    const registered = new Set(registeredTools());
    expect([...classified().keys()].filter((name) => !registered.has(name))).toEqual([]);
  });

  it('classifies a tool once', () => {
    const names = [...Object.keys(TOOLS), ...Object.values(NO_PATH).flat()];
    expect(names.filter((name, index) => names.indexOf(name) !== index)).toEqual([]);
  });

  it('scans the files that read these values', () => {
    const lines = scannedFiles().flatMap((file) => fs.readFileSync(file, 'utf-8').split('\n'));
    expect(lines.filter((line) => STAND_IN_READ.test(line)).length).toBeGreaterThan(10);
    expect(lines.filter((line) => THROUGH_AGENT_PATHS.test(line)).length).toBeGreaterThan(5);
  });

  it('reads a stand-in value only through agentPaths, or says why it may', () => {
    const offenders: string[] = [];
    for (const file of scannedFiles()) {
      const lines = fs.readFileSync(file, 'utf-8').split('\n');
      lines.forEach((line, index) => {
        if (!STAND_IN_READ.test(line) || NOT_A_READ.test(line) || THROUGH_AGENT_PATHS.test(line)) return;
        if (hasOptOutMarker(lines, index, 'host-value-ok')) return;
        offenders.push(`${path.relative(REPO_ROOT, file).replace(/\\/g, '/')}:${index + 1}: ${line.trim()}`);
      });
    }
    expect(offenders, 'Map it with agentPathsOf(context), or mark a read that never reaches an answer with // host-value-ok: <reason>').toEqual([]);
  });
});
