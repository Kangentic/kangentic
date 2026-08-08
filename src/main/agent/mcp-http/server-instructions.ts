/**
 * Builds the top-level MCP `instructions` string surfaced to agents at
 * initialize time (Claude Code renders it as `## kangentic` in its
 * system prompt).
 *
 * Two jobs: (1) tell the agent how to route task-creation and other
 * cross-project tool calls when the user's prompt names a project that
 * differs from the URL-path-bound "active" project (without this guidance
 * the agent silently defaults to the active project and misfiles tasks,
 * e.g. filing a Kangentic bug into OCC-RBDMS-OKIES because that's the
 * project the Claude Code session is bound to); and (2) tell the agent
 * when to reach for the kangentic_browser_* tools to verify the running
 * app, advertising any Browser panes currently open in the active project.
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
const INSTRUCTIONS_PANE_LIST_CAP = 5;

/**
 * Browser-verification guidance for the `kangentic_browser_*` tools. A static
 * when/when-not paragraph (so natural prompts like "does the page render?"
 * trigger the tools without a magic prefix, and the agent does not drive the
 * browser proactively), plus a live advertisement of the panes currently open
 * in the active project so the agent knows the capability is available and
 * where it points - no `list_panes` round-trip needed to discover them.
 */
function buildBrowserSection(activeProjectId: string | null): string[] {
  const lines = [
    'BROWSER VERIFICATION (kangentic_browser_* tools):',
    'When the user asks you to verify, check, look at, click, type, or test something in the running app or a page in the browser, prefer the kangentic_browser_* tools - they drive the embedded Browser pane of a task (the dev server the user has loaded). Use them over any external or desktop browser-automation tool (for example a Chrome-extension browser MCP) and over writing a separate Playwright/Puppeteer script: those drive a separate real browser, not the in-app pane the user is looking at. Call kangentic_browser_list_panes first; target a tool with sessionId or taskId, or omit both to use your own task\'s pane (or the single pane open in this project). These tools only drive Browser panes in this project; one in another project is refused. If no pane is open, ask the user to open the Browser pill in the task header and load a URL. Do not drive the browser proactively when the user has not asked about on-screen behavior.',
  ];
  const panes = browserPaneRegistry
    .list()
    .filter((pane) => pane.alive && (activeProjectId == null || pane.projectId === activeProjectId));
  if (panes.length === 1) {
    const pane = panes[0];
    lines.push(
      `A Browser pane is currently open${pane.url ? ` at ${pane.url}` : ''} (task ${pane.taskId}). You can drive it now with the kangentic_browser_* tools - drive this pane, not a separate external browser.`,
    );
  } else if (panes.length > 1) {
    const summary = panes
      .slice(0, INSTRUCTIONS_PANE_LIST_CAP)
      .map((pane) => `task ${pane.taskId}${pane.url ? ` (${pane.url})` : ''}`)
      .join(', ');
    lines.push(
      `${panes.length} Browser panes are currently open: ${summary}. Drive a specific one with the kangentic_browser_* tools by passing its sessionId or taskId - drive these panes, not a separate external browser.`,
    );
  }
  return lines;
}

/**
 * @param browserAutomationEnabled When false, the BROWSER VERIFICATION section
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
    'When a kangentic_create_task or kangentic_update_task call carries both a long description (roughly 1KB or more) and labels, the labels can be dropped before they reach the server. To make labels stick, set them in a separate labels-only kangentic_update_task call after creating or updating the task with the long description.',
    '',
    'EDITING A LONG TASK DESCRIPTION:',
    'For an incremental change to a long task description, prefer kangentic_update_task\'s `descriptionEdits` (exact find/replace, like the file Edit tool) or `appendDescription` over resending the whole `description`. They cost far fewer tokens and cannot silently drop or alter untouched sections. Reserve `description` for a genuine full rewrite.',
  ];

  if (browserAutomationEnabled) {
    lines.push('', ...buildBrowserSection(active?.id ?? null));
  }

  if (projects.length > 0) {
    lines.push('', 'Registered projects (use any name or id below as the `project` argument):');
    const listed = projects.slice(0, INSTRUCTIONS_PROJECT_LIST_CAP);
    for (const project of listed) {
      const activeTag = project.isActive ? ' [active]' : '';
      lines.push(`- ${sanitizeProjectName(project.name)}${activeTag}`);
    }
    if (projects.length > INSTRUCTIONS_PROJECT_LIST_CAP) {
      const remaining = projects.length - INSTRUCTIONS_PROJECT_LIST_CAP;
      lines.push(`- ... and ${remaining} more. Call kangentic_list_projects for the full list.`);
    }
  } else {
    lines.push('', 'Call kangentic_list_projects at any time to discover registered projects.');
  }

  return lines.join('\n');
}
