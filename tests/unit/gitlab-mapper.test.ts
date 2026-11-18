/**
 * What one GitLab issue becomes in the Import dialog and the backlog: the id
 * people read, the status from the board, the type, the
 * description with its uploads made reachable, and the GitLab section. The raw
 * shapes follow GitLab's issues API, as gitlab.com returned them.
 */
import { describe, expect, it } from 'vitest';
import type { GitLabBoardRaw, GitLabIssueRaw } from '../../src/main/boards/adapters/gitlab/client';
import { gitLabSection, mapGitLabIssue, normalizeDescription } from '../../src/main/boards/adapters/gitlab/mapper';
import { boardForSource, labelListsInOrder, statusFor } from '../../src/main/boards/adapters/gitlab/status';

const BASE = 'https://gitlab.com';

function issue(overrides: Partial<GitLabIssueRaw> = {}): GitLabIssueRaw {
  return {
    id: 155001,
    iid: 214,
    project_id: 7,
    title: 'Retry webhook delivery when the endpoint returns 429',
    description: 'Retry with backoff.',
    state: 'opened',
    labels: ['backend', 'workflow::doing'],
    assignees: [{ username: 'dana' }, { username: 'sam' }],
    milestone: { title: 'v2.4' },
    iteration: { title: 'Sprint 31' },
    weight: 3,
    due_date: '2026-11-28',
    web_url: 'https://gitlab.com/acme/web/-/work_items/214',
    created_at: '2026-11-10T00:00:00.000Z',
    updated_at: '2026-11-15T00:00:00.000Z',
    type: 'ISSUE',
    references: { short: '#214', relative: 'web#214', full: 'acme/web#214' },
    ...overrides,
  };
}

const LISTS = ['workflow::todo', 'workflow::doing', 'workflow::review'];

describe('statusFor', () => {
  it('puts an open issue on the leftmost list whose label it carries', () => {
    expect(statusFor({ state: 'opened', labels: ['workflow::review', 'workflow::doing'] }, LISTS))
      .toEqual({ state: 'workflow::doing', stateOrder: 2 });
  });

  it('puts an open issue on no list in Open, first', () => {
    expect(statusFor({ state: 'opened', labels: ['backend'] }, LISTS)).toEqual({ state: 'Open', stateOrder: 0 });
  });

  it('puts a closed issue in Closed, last, whatever labels it carries', () => {
    expect(statusFor({ state: 'closed', labels: ['workflow::doing'] }, LISTS)).toEqual({ state: 'Closed', stateOrder: 4 });
  });
});

describe('the source board', () => {
  const boards: GitLabBoardRaw[] = [
    { id: 9, name: 'Releases', lists: [] },
    { id: 4, name: 'development', lists: [
      { id: 1, label: null, position: 0 },
      { id: 2, label: { name: 'workflow::review' }, position: 2 },
      { id: 3, label: { name: 'workflow::todo' }, position: 0 },
      { id: 4, label: { name: 'workflow::doing' }, position: 1 },
    ] },
  ];

  it("uses the board a link named, else GitLab's default, first by name", () => {
    expect(boardForSource(boards, '9')?.id).toBe(9);
    expect(boardForSource(boards)?.id).toBe(4);
    expect(boardForSource([])).toBeUndefined();
  });

  it('lists label lists by position and skips lists with no label', () => {
    expect(labelListsInOrder(boards[1])).toEqual(LISTS);
  });
});

describe('mapGitLabIssue', () => {
  const context = { base: BASE, scopeKind: 'project' as const, labelLists: LISTS, alreadyImported: new Set<string>() };

  it('maps a project source row', () => {
    const mapped = mapGitLabIssue(issue(), context);
    expect(mapped).toMatchObject({
      externalId: 'gitlab.com:155001',
      externalSource: 'gitlab',
      externalUrl: 'https://gitlab.com/acme/web/-/work_items/214',
      displayId: '#214',
      state: 'workflow::doing',
      stateOrder: 2,
      stateCategory: 'open',
      workItemType: 'Issue',
      labels: ['backend', 'workflow::doing'],
      assignee: 'dana',
      dueDate: '2026-11-28',
    });
    expect(mapped.priority).toBeUndefined();
  });

  it("prints a group source's rows with GitLab's group-relative reference", () => {
    expect(mapGitLabIssue(issue(), { ...context, scopeKind: 'group' }).displayId).toBe('web#214');
  });

  it.each([['TASK', 'Task'], ['INCIDENT', 'Incident'], ['TEST_CASE', 'Test case']])('names a %s', (type, name) => {
    expect(mapGitLabIssue(issue({ type }), context).workItemType).toBe(name);
  });

  it('falls back to the web URL for the project when the issue has no references', () => {
    const mapped = mapGitLabIssue(issue({
      references: null,
      web_url: 'https://gitlab.com/acme/web/-/issues/214',
      description: '![shot](/uploads/0123456789abcdef0123456789abcdef/shot.png)',
    }), context);
    expect(mapped.body.startsWith('![shot](https://gitlab.com/acme/web/uploads/0123456789abcdef0123456789abcdef/shot.png)\n')).toBe(true);
    expect(mapped.body).not.toContain('](/uploads/');
  });

  it('reads the older issue_type when type is null', () => {
    expect(mapGitLabIssue(issue({ type: null, issue_type: 'incident' }), context).workItemType).toBe('Incident');
  });

  it('names an unknown type by capitalizing it and spacing its underscores', () => {
    expect(mapGitLabIssue(issue({ type: 'key_result' }), context).workItemType).toBe('Key result');
  });

  it('leaves the type out when neither field is set', () => {
    expect(mapGitLabIssue(issue({ type: null, issue_type: null }), context).workItemType).toBeUndefined();
  });

  it('marks an issue already in the backlog', () => {
    expect(mapGitLabIssue(issue(), { ...context, alreadyImported: new Set(['gitlab.com:155001']) }).alreadyImported).toBe(true);
  });

  it('ends the body with the GitLab section', () => {
    expect(mapGitLabIssue(issue(), context).body).toBe([
      'Retry with backoff.',
      '',
      '## GitLab',
      '',
      '- **Milestone**: v2.4',
      '- **Iteration**: Sprint 31',
      '- **Weight**: 3',
      '- **Due**: 2026-11-28',
      '- **Assignees**: @dana, @sam',
    ].join('\n'));
  });
});

describe('gitLabSection', () => {
  it('leaves out every line with no value, and the section when none has one', () => {
    expect(gitLabSection(issue({ milestone: null, iteration: null, weight: null, due_date: null, assignees: [] }))).toBe('');
    expect(gitLabSection(issue({ milestone: null, iteration: null, weight: null, assignees: [] })))
      .toBe('## GitLab\n\n- **Due**: 2026-11-28');
  });
});

describe('normalizeDescription', () => {
  it("makes a project-relative upload a full link on the issue's project and drops the size marks", () => {
    const raw = 'See ![image](/uploads/6c4e4afce4d7683cf08f0434e15444e4/image.png){width=499 height=108} and [log](/uploads/6c4e4afce4d7683cf08f0434e15444e4/run.log).';
    expect(normalizeDescription(raw, BASE, 'acme/web')).toBe(
      'See ![image](https://gitlab.com/acme/web/uploads/6c4e4afce4d7683cf08f0434e15444e4/image.png)'
      + ' and [log](https://gitlab.com/acme/web/uploads/6c4e4afce4d7683cf08f0434e15444e4/run.log).',
    );
  });

  it('leaves absolute links alone', () => {
    const raw = '![shot](https://cdn.example.com/uploads/abcdef0123456789abcdef/shot.png)';
    expect(normalizeDescription(raw, BASE, 'acme/web')).toBe(raw);
  });
});
