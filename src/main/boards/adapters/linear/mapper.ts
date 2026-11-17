import type { ExternalIssue } from '../../../../shared/types';
import { extractInlineImageUrls } from '../../shared';
import { isClosedStateType, type LinearIssueRaw, type LinearWorkflowState } from './client';

/**
 * Linear's priority numbers as the names Kangentic seeds for its own priority
 * scale. 0 ("No priority") has no entry, so an issue without one imports at None.
 * The executor matches the name against the project's scale.
 */
const PRIORITY_NAMES: Readonly<Record<number, string>> = {
  1: 'Urgent',
  2: 'High',
  3: 'Medium',
  4: 'Low',
};

export function linearPriorityName(priority: number): string | undefined {
  return PRIORITY_NAMES[priority];
}

function formatEstimate(estimate: number): string {
  return estimate === 1 ? '1 point' : `${estimate} points`;
}

/**
 * The `## Linear` section appended to the issue body: the fields that have no
 * Kangentic column of their own, one line each, a line left out when the issue
 * has no value for it. Stays English: it is stored text an agent reads.
 */
export function buildLinearDetailsBlock(issue: LinearIssueRaw): string {
  const lines: string[] = [];
  if (issue.priority > 0 && issue.priorityLabel) lines.push(`- **Priority**: ${issue.priorityLabel}`);
  if (issue.project?.name) lines.push(`- **Project**: ${issue.project.name}`);
  if (issue.cycle) lines.push(`- **Cycle**: ${issue.cycle.name?.trim() || `Cycle ${issue.cycle.number}`}`);
  if (typeof issue.estimate === 'number') lines.push(`- **Estimate**: ${formatEstimate(issue.estimate)}`);
  if (issue.dueDate) lines.push(`- **Due**: ${issue.dueDate}`);
  if (lines.length === 0) return '';
  return ['## Linear', '', ...lines].join('\n');
}

/** Rank of each workflow state id on the team's board, left to right. */
export function stateOrderByIdFrom(statesInBoardOrder: LinearWorkflowState[]): Map<string, number> {
  return new Map(statesInBoardOrder.map((state, index) => [state.id, index]));
}

export function mapLinearIssues(
  rawIssues: LinearIssueRaw[],
  stateOrderById: Map<string, number>,
  alreadyImportedIds: Set<string>,
): ExternalIssue[] {
  return rawIssues.map((issue) => mapOne(issue, stateOrderById, alreadyImportedIds.has(issue.id)));
}

function mapOne(issue: LinearIssueRaw, stateOrderById: Map<string, number>, alreadyImported: boolean): ExternalIssue {
  const description = (issue.description ?? '').trim();
  const body = [description, buildLinearDetailsBlock(issue)].filter(Boolean).join('\n\n');
  const stateOrder = stateOrderById.get(issue.state.id);
  const priority = linearPriorityName(issue.priority);
  return {
    externalId: issue.id,
    externalSource: 'linear',
    externalUrl: issue.url,
    displayId: issue.identifier,
    title: issue.title || '(untitled)',
    body,
    labels: issue.labels.nodes.map((label) => label.name).filter((name) => name.length > 0),
    assignee: issue.assignee?.displayName || issue.assignee?.name || null,
    state: issue.state.name,
    stateCategory: isClosedStateType(issue.state.type) ? 'closed' : 'open',
    ...(stateOrder !== undefined ? { stateOrder } : {}),
    ...(priority ? { priority } : {}),
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    alreadyImported,
    attachmentCount: extractInlineImageUrls(description).length,
  };
}
