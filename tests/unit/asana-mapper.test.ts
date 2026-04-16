import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { mapAsanaTasks, type AsanaTaskRaw } from '../../src/main/boards/adapters/asana/mapper';

function makeTask(overrides: Partial<AsanaTaskRaw> = {}): AsanaTaskRaw {
  return {
    gid: '111',
    name: 'Original task',
    notes: '',
    completed: false,
    permalink_url: 'https://app.asana.com/0/1/111',
    created_at: '2026-01-01T00:00:00Z',
    modified_at: '2026-01-02T00:00:00Z',
    ...overrides,
  };
}

describe('mapAsanaTasks', () => {
  it('maps the primary field set into ExternalIssue shape', () => {
    const [issue] = mapAsanaTasks(
      [makeTask({
        gid: '42',
        name: 'Fix login bug',
        notes: 'Users report 500 errors after SSO redirect.',
        assignee: { name: 'Dana Dev' },
        tags: [{ name: 'bug' }, { name: 'regression' }],
        completed: false,
        permalink_url: 'https://app.asana.com/0/99/42',
      })],
      new Set(),
    );

    expect(issue.externalId).toBe('42');
    expect(issue.externalSource).toBe('asana');
    expect(issue.externalUrl).toBe('https://app.asana.com/0/99/42');
    expect(issue.title).toBe('Fix login bug');
    expect(issue.body).toBe('Users report 500 errors after SSO redirect.');
    expect(issue.labels).toEqual(['bug', 'regression']);
    expect(issue.assignee).toBe('Dana Dev');
    expect(issue.state).toBe('open');
    expect(issue.alreadyImported).toBe(false);
  });

  it('marks completed tasks as closed', () => {
    const [issue] = mapAsanaTasks([makeTask({ completed: true })], new Set());
    expect(issue.state).toBe('closed');
  });

  it('captures the first membership section name as workItemType', () => {
    const [issue] = mapAsanaTasks(
      [makeTask({
        memberships: [
          { section: { name: 'In Progress' } },
          { section: { name: 'Ignored later section' } },
        ],
      })],
      new Set(),
    );
    expect(issue.workItemType).toBe('In Progress');
  });

  it('skips empty section names and falls back to a later membership', () => {
    const [issue] = mapAsanaTasks(
      [makeTask({
        memberships: [
          { section: { name: '' } },
          { section: null },
          { section: { name: 'Code Review' } },
        ],
      })],
      new Set(),
    );
    expect(issue.workItemType).toBe('Code Review');
  });

  it('appends a Due line to the body when due_on is present', () => {
    const [issue] = mapAsanaTasks(
      [makeTask({ notes: 'Work to do.', due_on: '2026-05-01' })],
      new Set(),
    );
    expect(issue.body).toContain('Work to do.');
    expect(issue.body).toContain('**Due:** 2026-05-01');
  });

  it('renders custom fields as a markdown block using display_value, text, number, enum, multi-enum, and date', () => {
    const [issue] = mapAsanaTasks(
      [makeTask({
        notes: 'Base body.',
        custom_fields: [
          { name: 'Priority', display_value: 'High' },
          { name: 'Effort', number_value: 8 },
          { name: 'Release', enum_value: { name: 'Q2 2025' } },
          { name: 'Platforms', multi_enum_values: [{ name: 'Web' }, { name: 'iOS' }] },
          { name: 'Target date', date_value: { date: '2026-06-30' } },
          { name: 'Notes', text_value: 'Needs triage' },
          { name: 'Empty field', display_value: '' },
          { name: '' },
        ],
      })],
      new Set(),
    );
    expect(issue.body).toContain('## Custom Fields');
    expect(issue.body).toContain('- **Priority**: High');
    expect(issue.body).toContain('- **Effort**: 8');
    expect(issue.body).toContain('- **Release**: Q2 2025');
    expect(issue.body).toContain('- **Platforms**: Web, iOS');
    expect(issue.body).toContain('- **Target date**: 2026-06-30');
    expect(issue.body).toContain('- **Notes**: Needs triage');
    expect(issue.body).not.toContain('Empty field');
  });

  it('marks tasks as alreadyImported when their gid is in the set', () => {
    const tasks = [makeTask({ gid: 'a' }), makeTask({ gid: 'b' })];
    const [first, second] = mapAsanaTasks(tasks, new Set(['b']));
    expect(first.alreadyImported).toBe(false);
    expect(second.alreadyImported).toBe(true);
  });

  it('counts inline <img> tags from html_notes plus num_attachments', () => {
    // Asana embeds inline images in html_notes as <img> tags. The plain
    // notes field downgrades them to bare URLs, so the mapper must count
    // from html_notes to match what the user sees on the Asana task.
    const html_notes = '<body>Here is a screenshot:<img src="https://app.asana.com/abc.png"/></body>';
    const [issue] = mapAsanaTasks(
      [makeTask({ html_notes, num_attachments: 2 })],
      new Set(),
    );
    expect(issue.attachmentCount).toBe(3);
  });

  it('does not count bare URLs in plain notes as inline images', () => {
    // Bare URLs in `notes` should NOT inflate the count - that's html_notes' job.
    const [issue] = mapAsanaTasks(
      [makeTask({ notes: 'See https://app.asana.com/abc.png', num_attachments: 1 })],
      new Set(),
    );
    expect(issue.attachmentCount).toBe(1);
  });

  it('omits empty labels, null assignee, and missing title safely', () => {
    const [issue] = mapAsanaTasks(
      [makeTask({
        name: undefined,
        tags: [{ name: '' }, { name: 'keep' }],
        assignee: null,
      })],
      new Set(),
    );
    expect(issue.title).toBe('(untitled)');
    expect(issue.labels).toEqual(['keep']);
    expect(issue.assignee).toBe(null);
  });
});

/**
 * Real-shape fixture test: protects against runtime type drift between the
 * Asana API and our `AsanaTaskRaw` interface. The fixture was assembled from
 * the `opt_fields` projection we send plus fields the API returns by default
 * (`resource_type`, nested `project` on memberships, `color` / `enabled` on
 * enum values, etc.) so ignored-field handling is exercised too.
 */
describe('mapAsanaTasks - real-shape fixture', () => {
  const fixturePath = path.join(__dirname, '..', 'fixtures', 'asana-tasks.json');
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as { data: AsanaTaskRaw[] };

  it('produces three ExternalIssue entries matching the fixture order', () => {
    const issues = mapAsanaTasks(fixture.data, new Set());
    expect(issues).toHaveLength(3);
    expect(issues.map((issue) => issue.externalId)).toEqual([
      '1200000000000101',
      '1200000000000102',
      '1200000000000103',
    ]);
  });

  it('maps the in-progress bug task with section, tags, assignee, custom fields, and due date', () => {
    const [issue] = mapAsanaTasks(fixture.data, new Set());
    expect(issue.title).toBe('Fix login bug');
    expect(issue.state).toBe('open');
    expect(issue.assignee).toBe('Dana Developer');
    expect(issue.labels).toEqual(['bug', 'regression']);
    expect(issue.workItemType).toBe('In Progress');
    expect(issue.externalUrl).toBe('https://app.asana.com/0/1199999999999999/1200000000000101');
    expect(issue.body).toContain('Users report 500 errors');
    expect(issue.body).toContain('## Custom Fields');
    expect(issue.body).toContain('- **Priority**: High');
    expect(issue.body).toContain('- **Effort**: 8');
    expect(issue.body).toContain('**Due:** 2026-02-15');
    expect(issue.attachmentCount).toBe(2);
  });

  it('maps the completed task with multi-enum custom field and no assignee/due/tags', () => {
    const issues = mapAsanaTasks(fixture.data, new Set());
    const issue = issues[1];
    expect(issue.title).toBe('Ship release notes');
    expect(issue.state).toBe('closed');
    expect(issue.assignee).toBe(null);
    expect(issue.labels).toEqual([]);
    expect(issue.workItemType).toBe('Done');
    expect(issue.body).toContain('- **Platforms**: Web, iOS');
    expect(issue.body).not.toContain('**Due:**');
  });

  it('counts an inline <img> from html_notes in attachmentCount alongside num_attachments', () => {
    const issues = mapAsanaTasks(fixture.data, new Set());
    const issue = issues[2];
    expect(issue.title).toBe('Design onboarding illustrations');
    expect(issue.attachmentCount).toBe(2);
    // The fixture custom fields include one with display_value=null and text_value=null.
    // It should NOT appear in the rendered Custom Fields block.
    expect(issue.body).toContain('- **Target date**: 2026-06-30');
    expect(issue.body).not.toContain('Empty field');
  });
});
