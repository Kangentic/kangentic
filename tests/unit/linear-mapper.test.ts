/**
 * Linear issue -> ExternalIssue, and the team URL a source is saved with.
 *
 * What a user loses without each case: rows showing a UUID instead of ENG-214;
 * a Done issue counted as open; the Status filter out of board order; Linear's
 * priority dropped or mis-named (the executor matches the NAME); the Linear
 * fields with no Kangentic column lost from the description; and a pasted team
 * link refused or saved under the wrong key.
 */
import { describe, it, expect } from 'vitest';
import {
  buildLinearDetailsBlock,
  mapLinearIssues,
  stateOrderByIdFrom,
} from '../../src/main/boards/adapters/linear/mapper';
import { parseLinearUrl, buildLinearTeamUrl } from '../../src/main/boards/adapters/linear/url-parser';
import type { LinearIssueRaw, LinearWorkflowState } from '../../src/main/boards/adapters/linear/client';

const STATES: LinearWorkflowState[] = [
  { id: 'state-backlog', name: 'Backlog', type: 'backlog', position: 0 },
  { id: 'state-todo', name: 'Todo', type: 'unstarted', position: 0 },
  { id: 'state-progress', name: 'In Progress', type: 'started', position: 0 },
  { id: 'state-done', name: 'Done', type: 'completed', position: 0 },
  { id: 'state-canceled', name: 'Canceled', type: 'canceled', position: 0 },
];

function rawIssue(overrides: Partial<LinearIssueRaw> = {}): LinearIssueRaw {
  return {
    id: '9f6c1c2e-0000-4000-8000-000000000214',
    identifier: 'ENG-214',
    title: 'Retry webhook delivery when the endpoint returns 429',
    description: 'Webhook deliveries that get a 429 are dropped today.',
    url: 'https://linear.app/acme/issue/ENG-214/retry-webhook-delivery',
    priority: 2,
    priorityLabel: 'High',
    estimate: 3,
    dueDate: '2026-11-28',
    createdAt: '2026-11-10T09:00:00.000Z',
    updatedAt: '2026-11-15T09:00:00.000Z',
    state: STATES[2],
    assignee: { name: 'Dana Park', displayName: 'dana' },
    labels: { nodes: [{ name: 'backend' }] },
    cycle: { number: 24, name: null },
    project: { name: 'Webhooks v2' },
    ...overrides,
  };
}

function mapOne(overrides: Partial<LinearIssueRaw> = {}, alreadyImported = false) {
  const issue = rawIssue(overrides);
  return mapLinearIssues([issue], stateOrderByIdFrom(STATES), new Set(alreadyImported ? [issue.id] : []))[0];
}

describe('mapLinearIssues', () => {
  it('keys the issue by its UUID and shows its identifier', () => {
    const issue = mapOne();
    expect(issue.externalId).toBe('9f6c1c2e-0000-4000-8000-000000000214');
    expect(issue.displayId).toBe('ENG-214');
    expect(issue.externalSource).toBe('linear');
    expect(issue.externalUrl).toBe('https://linear.app/acme/issue/ENG-214/retry-webhook-delivery');
  });

  it('carries the state, its board rank, and the open/closed bucket by state type', () => {
    expect(mapOne()).toMatchObject({ state: 'In Progress', stateOrder: 2, stateCategory: 'open' });
    expect(mapOne({ state: STATES[3] })).toMatchObject({ state: 'Done', stateCategory: 'closed' });
    expect(mapOne({ state: STATES[4] }).stateCategory).toBe('closed');
    expect(mapOne({ state: { id: 'state-dup', name: 'Duplicate', type: 'duplicate', position: 0 } }).stateCategory).toBe('closed');
  });

  it('names the priority the way Kangentic seeds its scale, and none for "No priority"', () => {
    expect(mapOne({ priority: 1 }).priority).toBe('Urgent');
    expect(mapOne({ priority: 2 }).priority).toBe('High');
    expect(mapOne({ priority: 3 }).priority).toBe('Medium');
    expect(mapOne({ priority: 4 }).priority).toBe('Low');
    expect(mapOne({ priority: 0, priorityLabel: 'No priority' }).priority).toBeUndefined();
  });

  it('takes labels, the assignee display name, and the already-imported mark', () => {
    const issue = mapOne({}, true);
    expect(issue.labels).toEqual(['backend']);
    expect(issue.assignee).toBe('dana');
    expect(issue.alreadyImported).toBe(true);
    expect(mapOne({ assignee: null }).assignee).toBeNull();
  });

  it('appends the Linear section after the description', () => {
    expect(mapOne().body).toBe([
      'Webhook deliveries that get a 429 are dropped today.',
      '',
      '## Linear',
      '',
      '- **Priority**: High',
      '- **Project**: Webhooks v2',
      '- **Cycle**: Cycle 24',
      '- **Estimate**: 3 points',
      '- **Due**: 2026-11-28',
    ].join('\n'));
  });

  it('counts uploaded images in the description', () => {
    expect(mapOne({ description: '![a](https://uploads.linear.app/x/a.png) and ![b](https://uploads.linear.app/x/b.png)' }).attachmentCount).toBe(2);
  });
});

describe('buildLinearDetailsBlock', () => {
  it('leaves out every line with no value, and the whole section when none has one', () => {
    expect(buildLinearDetailsBlock(rawIssue({
      priority: 0, priorityLabel: 'No priority', project: null, cycle: null, estimate: null, dueDate: null,
    }))).toBe('');
  });

  it('uses a named cycle as named and a single point in the singular', () => {
    const block = buildLinearDetailsBlock(rawIssue({ cycle: { number: 7, name: 'Launch week' }, estimate: 1 }));
    expect(block).toContain('- **Cycle**: Launch week');
    expect(block).toContain('- **Estimate**: 1 point');
  });
});

describe('parseLinearUrl', () => {
  it('reads the team key from any page under the team', () => {
    expect(parseLinearUrl('https://linear.app/acme/team/ENG/all')).toEqual({ repository: 'ENG' });
    expect(parseLinearUrl('https://linear.app/acme/team/ENG')).toEqual({ repository: 'ENG' });
    expect(parseLinearUrl('https://linear.app/acme/team/eng/board?view=1')).toEqual({ repository: 'ENG' });
  });

  it('round-trips the URL the team picker saves', () => {
    expect(parseLinearUrl(buildLinearTeamUrl('acme', 'DES'))).toEqual({ repository: 'DES' });
  });

  it('refuses an issue or project link', () => {
    expect(() => parseLinearUrl('https://linear.app/acme/issue/ENG-214/title')).toThrow(/Invalid Linear team URL/);
    expect(() => parseLinearUrl('https://linear.app/acme/project/webhooks-v2')).toThrow(/Invalid Linear team URL/);
  });
});
