/**
 * Builds the top-level MCP `instructions` string surfaced to agents at
 * initialize time (Claude Code renders it as `## kangentic` in its
 * system prompt).
 *
 * Two jobs: (1) tell the agent how to route task-creation and other
 * cross-project tool calls when the user's prompt names a project that
 * differs from the URL-path-bound "active" project (without this guidance
 * the agent silently defaults to the active project and misfiles tasks,
 * e.g. filing a Kangentic bug into another project because that is the
 * project the Claude Code session is bound to); and (2) tell the agent
 * that the kangentic_browser_* tools are the only browser it drives,
 * advertising any Browser panes currently open in the active project.
 *
 * The registered-project list is embedded live so the agent sees real
 * routing candidates without needing a separate kangentic_list_projects
 * round-trip first. We cap the list length to keep the string short;
 * when truncated we point to kangentic_list_projects for the full set.
 */
import { sanitizeProjectName } from './handler-helpers';
import { browserPaneRegistry } from '../../browser/browser-pane-registry';
import type { RequestResolver } from './project-resolver';

/** Maximum number of project names embedded in the instructions string. */
export const INSTRUCTIONS_PROJECT_LIST_CAP = 20;

/** Maximum number of open Browser panes named in the instructions string. */
export const INSTRUCTIONS_PANE_LIST_CAP = 5;

/**
 * Claude Code cuts a server's instructions at 4,096 characters by default
 * (MCP docs, "Scale with MCP tool search"), and the agent sees only the text
 * before the cut. The builder never passes it: the project list is shortened
 * first. `tests/unit/mcp-server-instructions-cap.test.ts` fails when the fixed
 * text leaves too little room for a typical list.
 */
export const MCP_INSTRUCTIONS_CHARACTER_CAP = 4096;

/** A pane URL is cut to this many characters in the instructions. */
const INSTRUCTIONS_PANE_URL_CAP = 80;

function shortenUrl(url: string): string {
  return url.length > INSTRUCTIONS_PANE_URL_CAP ? `${url.slice(0, INSTRUCTIONS_PANE_URL_CAP - 3)}...` : url;
}

/**
 * The browser policy for the `kangentic_browser_*` tools (task #977): the
 * Agent Browser is the only browser, for any page and any purpose. Every agent
 * gets this channel; an agent CLI that takes system prompt text also gets the
 * longer `BROWSER_POLICY_PROMPT`, and Claude's PreToolUse hook denies the
 * other browser servers. A live advertisement of the panes open in the active
 * project follows, so no `list_panes` round trip is needed to find them.
 */
function buildBrowserSection(activeProjectId: string | null): string[] {
  const lines = [
    'BROWSER (kangentic_browser_* tools):',
    'The Kangentic Agent Browser is the only browser you drive, for any page (localhost, staging, production or a third-party site) and any purpose: checking the app, screenshots or DOM for your own work or an artifact, comparing sites, scraping. Do NOT use mcp__playwright__* or mcp__claude-in-chrome__* tools, chrome-devtools or puppeteer MCP servers, computer use, or a Playwright/Puppeteer/Selenium script: each drives a different browser from the pane the user watches. Open a browser only when the work needs one.',
    'OPEN THE PANE. If none is open, call kangentic_browser_open_pane with a url; you do not need to ask the user, even if they closed it. A task has exactly ONE browser surface. Omit sessionId and taskId to drive your own task\'s surface, or pass a handle from kangentic_browser_list_panes as sessionId. A gone tab fails with surface-gone and names the replacement. Panes in other projects are refused. kangentic_browser_screenshot, _screenshot_element, _query_dom and _eval take saveToFile for large output. Call kangentic_browser_close_pane when done.',
  ];
  const panes = browserPaneRegistry
    .list()
    .filter((pane) => pane.alive && (activeProjectId == null || pane.projectId === activeProjectId));
  if (panes.length === 1) {
    const pane = panes[0];
    lines.push(
      `A Browser pane is currently open${pane.url ? ` at ${shortenUrl(pane.url)}` : ''} (task ${pane.taskId}). Drive this pane, not a separate external browser.`,
    );
  } else if (panes.length > 1) {
    const summary = panes
      .slice(0, INSTRUCTIONS_PANE_LIST_CAP)
      .map((pane) => `task ${pane.taskId}${pane.url ? ` (${shortenUrl(pane.url)})` : ''}`)
      .join(', ');
    lines.push(
      `${panes.length} Browser panes are currently open: ${summary}. Drive one by passing its handle as sessionId or its taskId - drive these panes, not a separate external browser.`,
    );
  }
  return lines;
}

/**
 * @param browserAutomationEnabled When false, the BROWSER section
 *   is omitted because the `kangentic_browser_*` tools are not registered (the
 *   global policy blocks them). Keeps the instructions consistent with the
 *   advertised tool set and sheds the section's tokens for opt-out users.
 *   Defaults to true so callers that do not gate on the policy (e.g. tests) get
 *   the section as before.
 */
export function buildServerInstructions(
  resolver: RequestResolver,
  browserAutomationEnabled = true,
): string {
  const projects = resolver.listProjects();
  const active = projects.find((project) => project.isActive);
  // Normalise every embedded name through the same sanitizer used by the
  // cross-project annotation (strips newlines and brackets, caps length).
  // Without this a project created with a newline in its name would
  // break the bulleted list into multiple visual entries and confuse the
  // agent about which names are real routing candidates.
  const activeLine = active
    ? `Active project (URL-path default when \`project\` is omitted): "${sanitizeProjectName(active.name)}".`
    : 'No active project is bound to this connection.';

  const lines: string[] = [
    'Kangentic MCP server. Provides task, column, backlog, and session tools for one or more Kangentic projects on this machine.',
    '',
    activeLine,
    '',
    'PROJECT ROUTING RULE (important):',
    'Tools that accept an optional `project` argument default to the active project above. Set `project` to the target project name whenever the user names a different registered project, however they phrase it. This includes phrase-embedded references, not just the explicit "create a task in X" form. Treat all of these as targeting project X: "in X", "in the X board", "on X\'s board", "the X to do", "X\'s backlog", "add it to X". When the target is any registered project other than the active one, pass its name as `project` rather than relying on the active default. Do not file a task into the active project when the user clearly targeted another one.',
    '',
    'LABELS WITH A LONG DESCRIPTION (known limitation):',
    'When a kangentic_create_task or kangentic_update_task call carries both a long description (roughly 1KB or more) and labels, the labels can be dropped before they reach the server. To make labels stick, set them in a separate labels-only kangentic_update_task call after creating or updating the task with the long description. You do not have to detect this yourself: when it happens the tool response says so and names the task to follow up on.',
    '',
    'EDITING A LONG TASK DESCRIPTION:',
    'For an incremental change to a long task description, prefer kangentic_update_task\'s `descriptionEdits` (exact find/replace, like the file Edit tool) or `appendDescription` over resending the whole `description`. They cost far fewer tokens and cannot silently drop or alter untouched sections. Reserve `description` for a genuine full rewrite.',
  ];

  if (browserAutomationEnabled) {
    lines.push('', ...buildBrowserSection(active?.id ?? null));
  }

  if (projects.length === 0) {
    lines.push('', 'Call kangentic_list_projects at any time to discover registered projects.');
    return lines.join('\n');
  }

  lines.push('', 'Registered projects (use any name or id below as the `project` argument):');
  const fixedText = lines.join('\n');
  const entries = projects.slice(0, INSTRUCTIONS_PROJECT_LIST_CAP).map((project) =>
    `- ${sanitizeProjectName(project.name)}${project.isActive ? ' [active]' : ''}`);
  const moreLine = (remaining: number): string => `- ... and ${remaining} more. Call kangentic_list_projects for the full list.`;
  // Keep as many names as fit under the cap with the "more" line after them.
  let listedCount = entries.length;
  const lengthWith = (count: number): number => {
    const omittedCount = projects.length - count;
    const listText = [...entries.slice(0, count), ...(omittedCount > 0 ? [moreLine(omittedCount)] : [])].join('\n');
    return fixedText.length + 1 + listText.length;
  };
  while (listedCount > 0 && lengthWith(listedCount) > MCP_INSTRUCTIONS_CHARACTER_CAP) listedCount -= 1;
  const remaining = projects.length - listedCount;
  lines.push(...entries.slice(0, listedCount));
  if (remaining > 0) lines.push(moreLine(remaining));
  return lines.join('\n');
}
