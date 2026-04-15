import type { ExternalIssue } from '../../../../shared/types';
import { extractInlineImageUrls } from '../../shared';

/**
 * Raw task shape as returned by Asana with the `opt_fields` projection defined
 * in `constants.ts`. Every nested field is optional because Asana omits fields
 * that are null/unset rather than returning them explicitly.
 */
export interface AsanaTaskRaw {
  gid: string;
  name?: string | null;
  notes?: string | null;
  completed?: boolean;
  permalink_url?: string;
  created_at?: string;
  modified_at?: string;
  due_on?: string | null;
  num_attachments?: number;
  assignee?: { name?: string | null } | null;
  tags?: Array<{ name?: string | null }>;
  memberships?: Array<{ section?: { name?: string | null } | null }>;
  custom_fields?: AsanaCustomFieldRaw[];
}

export interface AsanaCustomFieldRaw {
  name?: string | null;
  type?: string;
  resource_subtype?: string;
  display_value?: string | null;
  text_value?: string | null;
  number_value?: number | null;
  enum_value?: { name?: string | null } | null;
  multi_enum_values?: Array<{ name?: string | null }>;
  date_value?: { date?: string | null } | null;
}

export function mapAsanaTasks(
  rawTasks: AsanaTaskRaw[],
  alreadyImportedIds: Set<string>,
): ExternalIssue[] {
  return rawTasks.map((task) => mapOne(task, alreadyImportedIds.has(task.gid)));
}

function mapOne(task: AsanaTaskRaw, alreadyImported: boolean): ExternalIssue {
  const notes = (task.notes ?? '').trim();
  const customFieldsBlock = buildCustomFieldsBlock(task.custom_fields ?? []);
  const dueLine = task.due_on ? `**Due:** ${task.due_on}` : '';

  const bodyParts = [notes, customFieldsBlock, dueLine].filter(Boolean);
  const body = bodyParts.join('\n\n');

  const sectionName = firstSectionName(task.memberships);
  const inlineImageCount = extractInlineImageUrls(notes).length;
  const attachmentCount = (task.num_attachments ?? 0) + inlineImageCount;

  return {
    externalId: task.gid,
    externalSource: 'asana',
    externalUrl: task.permalink_url ?? `https://app.asana.com/0/0/${task.gid}`,
    title: task.name ?? '(untitled)',
    body,
    labels: (task.tags ?? [])
      .map((tag) => tag.name ?? '')
      .filter((name) => name.length > 0),
    assignee: task.assignee?.name ?? null,
    state: task.completed ? 'closed' : 'open',
    workItemType: sectionName,
    createdAt: task.created_at ?? new Date(0).toISOString(),
    updatedAt: task.modified_at ?? task.created_at ?? new Date(0).toISOString(),
    alreadyImported,
    attachmentCount,
  };
}

function firstSectionName(memberships: AsanaTaskRaw['memberships']): string | undefined {
  if (!memberships) return undefined;
  for (const membership of memberships) {
    const name = membership.section?.name;
    if (name) return name;
  }
  return undefined;
}

function buildCustomFieldsBlock(fields: AsanaCustomFieldRaw[]): string {
  const rendered: string[] = [];
  for (const field of fields) {
    const line = renderField(field);
    if (line) rendered.push(line);
  }
  if (rendered.length === 0) return '';
  return ['## Custom Fields', '', ...rendered].join('\n');
}

function renderField(field: AsanaCustomFieldRaw): string | null {
  const name = field.name?.trim();
  if (!name) return null;
  const value = extractFieldValue(field);
  if (value === null || value === '') return null;
  return `- **${name}**: ${value}`;
}

function extractFieldValue(field: AsanaCustomFieldRaw): string | null {
  if (typeof field.display_value === 'string' && field.display_value.length > 0) {
    return field.display_value;
  }
  if (typeof field.text_value === 'string' && field.text_value.length > 0) {
    return field.text_value;
  }
  if (typeof field.number_value === 'number') {
    return String(field.number_value);
  }
  if (field.enum_value?.name) {
    return field.enum_value.name;
  }
  if (field.multi_enum_values && field.multi_enum_values.length > 0) {
    const names = field.multi_enum_values
      .map((value) => value.name ?? '')
      .filter((name) => name.length > 0);
    if (names.length > 0) return names.join(', ');
  }
  if (field.date_value?.date) {
    return field.date_value.date;
  }
  return null;
}
