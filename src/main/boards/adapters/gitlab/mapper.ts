import type { ExternalIssue } from '../../../../shared/types';
import { extractInlineImageUrls } from '../../shared/mapping';
import type { GitLabIssueRaw } from './client';
import { statusFor } from './status';
import { serverLabel } from './url-parser';

export interface GitLabMapContext {
  /** The server's base URL. */
  base: string;
  /** A group source's rows print GitLab's group-relative reference (`web#214`); a project's print `#214`. */
  scopeKind: 'project' | 'group';
  /** The source board's label lists, left to right. Empty when there is no board. */
  labelLists: readonly string[];
  /** The external ids already imported, from the backlog. */
  alreadyImported: Set<string>;
}

/** The type names a GitLab work item carries, as GitLab's UI writes them. */
const TYPE_NAMES: Record<string, string> = {
  issue: 'Issue',
  task: 'Task',
  incident: 'Incident',
  test_case: 'Test case',
};

/**
 * The id an issue is stored under: the server's host and GitLab's global issue
 * id, so two projects (whose `iid`s both start at 1) or two servers never collide.
 */
export function gitLabExternalId(base: string, issueId: number): string {
  return `${serverLabel(base)}:${issueId}`;
}

/** The project an issue belongs to, from its full reference (`acme/web#214`). */
export function projectPathOf(issue: Pick<GitLabIssueRaw, 'references' | 'web_url'>, base: string): string | undefined {
  const full = issue.references?.full;
  if (full && full.includes('#')) return full.slice(0, full.lastIndexOf('#'));
  // An older server without references: the web URL's path before `/-/`.
  const prefix = `${base}/`;
  if (issue.web_url.startsWith(prefix)) {
    const rest = issue.web_url.slice(prefix.length);
    const separator = rest.indexOf('/-/');
    if (separator > 0) return rest.slice(0, separator);
  }
  return undefined;
}

function typeName(issue: GitLabIssueRaw): string | undefined {
  const raw = (issue.type ?? issue.issue_type ?? '').toLowerCase();
  if (raw.length === 0) return undefined;
  return TYPE_NAMES[raw] ?? raw.charAt(0).toUpperCase() + raw.slice(1).replace(/_/g, ' ');
}

/**
 * The description as Kangentic stores it. A project-relative upload link
 * (`/uploads/<secret>/<file>`) becomes a full link on the issue's project, so it
 * opens in a browser and the import can download it, and GitLab's image size
 * marks (`{width=499 height=108}`) are dropped.
 */
export function normalizeDescription(description: string, base: string, projectPath: string | undefined): string {
  let body = description.replace(/(!\[[^\]]*\]\([^)\s]+\))\{[^}\n]*\}/g, '$1');
  if (projectPath) {
    body = body.replace(
      /(^|[("'\s])\/uploads\/([0-9a-f]{16,})\/([^)\s"']+)/g,
      (_match, lead: string, secret: string, file: string) => `${lead}${base}/${projectPath}/uploads/${secret}/${file}`,
    );
  }
  return body;
}

/** The section of GitLab fields with no Kangentic home, after the body. Lines with no value are left out. */
export function gitLabSection(issue: GitLabIssueRaw): string {
  const lines: string[] = [];
  const milestone = issue.milestone?.title?.trim();
  if (milestone) lines.push(`- **Milestone**: ${milestone}`);
  const iteration = issue.iteration?.title?.trim()
    || (issue.iteration?.start_date && issue.iteration?.due_date ? `${issue.iteration.start_date} to ${issue.iteration.due_date}` : '');
  if (iteration) lines.push(`- **Iteration**: ${iteration}`);
  if (typeof issue.weight === 'number') lines.push(`- **Weight**: ${issue.weight}`);
  if (issue.due_date) lines.push(`- **Due**: ${issue.due_date}`);
  const assignees = (issue.assignees ?? [])
    .map((assignee) => assignee.username)
    .filter((username): username is string => typeof username === 'string' && username.length > 0);
  if (assignees.length > 0) lines.push(`- **Assignees**: ${assignees.map((username) => `@${username}`).join(', ')}`);
  return lines.length > 0 ? `## GitLab\n\n${lines.join('\n')}` : '';
}

export function mapGitLabIssue(issue: GitLabIssueRaw, context: GitLabMapContext): ExternalIssue {
  const externalId = gitLabExternalId(context.base, issue.id);
  const description = normalizeDescription(issue.description ?? '', context.base, projectPathOf(issue, context.base));
  const section = gitLabSection(issue);
  const body = [description.trim(), section].filter((part) => part.length > 0).join('\n\n');
  const { state, stateOrder } = statusFor(issue, context.labelLists);
  const firstAssignee = issue.assignees?.[0]?.username ?? issue.assignee?.username ?? null;
  const displayId = context.scopeKind === 'group'
    ? issue.references?.relative || `#${issue.iid}`
    : `#${issue.iid}`;

  return {
    externalId,
    externalSource: 'gitlab',
    externalUrl: issue.web_url,
    title: issue.title,
    body,
    labels: issue.labels ?? [],
    assignee: firstAssignee,
    state,
    stateCategory: issue.state === 'closed' ? 'closed' : 'open',
    workItemType: typeName(issue),
    displayId,
    dueDate: issue.due_date ?? undefined,
    stateOrder,
    createdAt: issue.created_at,
    updatedAt: issue.updated_at,
    alreadyImported: context.alreadyImported.has(externalId),
    attachmentCount: extractInlineImageUrls(body).length,
  };
}

export function mapGitLabIssues(issues: readonly GitLabIssueRaw[], context: GitLabMapContext): ExternalIssue[] {
  return issues.map((issue) => mapGitLabIssue(issue, context));
}
