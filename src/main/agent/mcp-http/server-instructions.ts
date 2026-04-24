/**
 * Builds the top-level MCP `instructions` string surfaced to agents at
 * initialize time (Claude Code renders it as `## kangentic` in its
 * system prompt).
 *
 * The string has one job: tell the agent how to route task-creation and
 * other cross-project tool calls when the user's prompt names a project
 * that differs from the URL-path-bound "active" project. Without this
 * guidance the agent silently defaults to the active project and
 * misfiles tasks (e.g. filing a Kangentic bug into OCC-RBDMS-OKIES
 * because that's the project the Claude Code session is bound to).
 *
 * The registered-project list is embedded live so the agent sees real
 * routing candidates without needing a separate kangentic_list_projects
 * round-trip first. We cap the list length to keep the string short;
 * when truncated we point to kangentic_list_projects for the full set.
 */
import { sanitizeProjectName } from './handler-helpers';
import type { RequestResolver } from './project-resolver';

/** Maximum number of project names embedded in the instructions string. */
export const INSTRUCTIONS_PROJECT_LIST_CAP = 20;

export function buildServerInstructions(resolver: RequestResolver): string {
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
    'Tools that accept an optional `project` argument default to the active project above. If the user\'s request names a different Kangentic project (e.g. "create a task in kangentic to fix ...", "move task #7 in acme to Done"), pass that project name as `project` on the tool call instead of relying on the active default. Do not file a task into the active project when the user clearly targeted another one.',
  ];

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
