import type { ExternalIssue, FileAttachmentRef } from '../../../../shared/types';
import { convertHtmlToMarkdown } from '../../shared';

/**
 * A Jira issue as search and the agile API return it, with the fields
 * `ISSUE_FIELDS` asks for and `expand=renderedFields`. Every field is optional:
 * Jira omits a field the issue does not have, and an admin can hide any of them.
 */
export interface JiraIssueRaw {
  id: string;
  key?: string;
  fields?: {
    summary?: string | null;
    status?: { id?: string; name?: string; statusCategory?: { key?: string } } | null;
    issuetype?: { name?: string } | null;
    priority?: { name?: string } | null;
    labels?: string[] | null;
    assignee?: { displayName?: string | null } | null;
    duedate?: string | null;
    created?: string | null;
    updated?: string | null;
    attachment?: Array<{ id?: string; filename?: string; size?: number; content?: string }> | null;
  };
  renderedFields?: { description?: string | null } | null;
}

/** A board column and the status ids mapped to it, in board order. */
export interface JiraBoardColumn {
  name: string;
  statusIds: string[];
}

export interface JiraMapContext {
  /** The site's base URL, for issue links and making relative URLs absolute. */
  site: string;
  /** Set for a board source: rows show the board's column names, in board order. */
  boardColumns?: JiraBoardColumn[];
  /** External ids already in the backlog. */
  alreadyImported: Set<string>;
}

/**
 * Make the rendered HTML's root-relative `src` and `href` absolute, so images
 * download. They are prefixed with the site's origin, not its base: Jira renders
 * a Data Center context path into the URL itself (`/jira/secure/attachment/...`),
 * so the base `https://example.com/jira` would double it.
 */
function absolutizeUrls(html: string, site: string): string {
  return html.replace(/(\s(?:src|href)=["'])\/(?!\/)/gi, `$1${siteOrigin(site)}/`);
}

function siteOrigin(site: string): string {
  try {
    return new URL(site).origin;
  } catch { // report-ok: a site that is not a URL has no origin to split off, so its base is used whole
    return site;
  }
}

/** Normalize Jira's `2026-11-12T09:30:00.000+0000` to a UTC ISO instant. */
function toIsoInstant(value: string | null | undefined): string {
  if (!value) return new Date(0).toISOString();
  const parsed = new Date(value.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  return Number.isNaN(parsed.getTime()) ? new Date(0).toISOString() : parsed.toISOString();
}

/**
 * Attachment ids the rendered description shows inline. Those come over as
 * inline images (downloaded from the body), so they are left out of the file
 * attachments to avoid saving the same file twice. Cloud renders
 * `/attachment/content/<id>` or `/attachment/thumbnail/<id>`; Data Center renders
 * `/secure/attachment/<id>/...` or, for a thumbnail, `/secure/thumbnail/<id>/...`.
 */
function inlineAttachmentIds(html: string): Set<string> {
  const ids = new Set<string>();
  for (const match of html.matchAll(/(?:attachment\/(?:content\/|thumbnail\/)?|secure\/thumbnail\/)(\d+)/g)) ids.add(match[1]);
  return ids;
}

export function mapJiraIssues(rawIssues: JiraIssueRaw[], context: JiraMapContext): ExternalIssue[] {
  return rawIssues.map((raw) => mapOne(raw, context));
}

function mapOne(raw: JiraIssueRaw, context: JiraMapContext): ExternalIssue {
  const fields = raw.fields ?? {};
  const html = absolutizeUrls(raw.renderedFields?.description ?? '', context.site);
  const body = html ? convertHtmlToMarkdown(html) : '';

  const statusId = fields.status?.id;
  const columnIndex = statusId && context.boardColumns
    ? context.boardColumns.findIndex((column) => column.statusIds.includes(statusId))
    : -1;
  const state = columnIndex >= 0
    ? context.boardColumns![columnIndex].name
    : fields.status?.name ?? 'unknown';

  const inlineIds = inlineAttachmentIds(html);
  const attachments = fields.attachment ?? [];
  const fileAttachments: FileAttachmentRef[] = attachments
    .filter((attachment) => typeof attachment.id === 'string' && typeof attachment.content === 'string')
    .filter((attachment) => !inlineIds.has(attachment.id!))
    .map((attachment) => ({
      url: attachment.content!,
      filename: attachment.filename ?? `attachment-${attachment.id}`,
      sizeBytes: attachment.size ?? 0,
      externalRef: attachment.id,
    }));

  const issue: ExternalIssue = {
    externalId: raw.id,
    externalSource: 'jira',
    externalUrl: raw.key ? `${context.site}/browse/${raw.key}` : context.site,
    title: fields.summary?.trim() || '(untitled)',
    body,
    labels: (fields.labels ?? []).filter((label) => typeof label === 'string' && label.length > 0),
    assignee: fields.assignee?.displayName ?? null,
    state,
    // `done` is Jira's closed category; `new` and `indeterminate` are open, and an
    // issue with no category (Jira's "No Category") is treated as open.
    stateCategory: fields.status?.statusCategory?.key === 'done' ? 'closed' : 'open',
    workItemType: fields.issuetype?.name || undefined,
    displayId: raw.key,
    priority: fields.priority?.name || undefined,
    dueDate: fields.duedate || undefined,
    stateOrder: columnIndex >= 0 ? columnIndex : undefined,
    createdAt: toIsoInstant(fields.created),
    updatedAt: toIsoInstant(fields.updated),
    alreadyImported: context.alreadyImported.has(raw.id),
    attachmentCount: attachments.length,
  };
  return fileAttachments.length > 0 ? { ...issue, fileAttachments } : issue;
}

/** Board columns from the board configuration, dropping any with no name. */
export function mapBoardColumns(
  configuration: { columnConfig?: { columns?: Array<{ name?: string; statuses?: Array<{ id?: string }> }> } },
): JiraBoardColumn[] {
  return (configuration.columnConfig?.columns ?? [])
    .filter((column) => typeof column.name === 'string' && column.name.length > 0)
    .map((column) => ({
      name: column.name!,
      statusIds: (column.statuses ?? []).map((status) => status.id).filter((id): id is string => typeof id === 'string'),
    }));
}
