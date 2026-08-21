/**
 * Task-template-variable parity guard (see .claude/rules/task-template-vars-parity.md).
 *
 * src/shared/task-template-vars.ts is the single declaration of the 10
 * task-template keywords (auto_command + spawn_agent promptTemplate share it).
 * It drives the UI chip list (BoardManagerDialog.tsx), the main-process
 * resolver map (task-template-resolvers.ts), and the docs tables. This test
 * makes drift unmergeable: every catalog name has a resolver and vice versa,
 * every catalog chip is documented, and the resolver/interpolation behavior
 * (the {{baseBranch}} bug fix and the drop-and-collapse semantics) is pinned.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { TASK_TEMPLATE_VAR_NAMES, TASK_TEMPLATE_VARS } from '../../src/shared/task-template-vars';
import { TASK_TEMPLATE_RESOLVERS, resolveTaskTemplateVars } from '../../src/main/agent/shared/task-template-resolvers';
import { interpolateTaskTemplate } from '../../src/main/agent/shared/template-utils';
import type { Task } from '../../src/shared/types';

const REPO_ROOT = path.resolve(__dirname, '../..');

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    display_id: 1,
    title: 'My Task',
    description: 'Do the thing',
    swimlane_id: 'lane-1',
    position: 0,
    agent: 'claude',
    agent_override: null,
    model_override: null,
    effort_override: null,
    session_id: null,
    worktree_path: null,
    branch_name: null,
    pr_number: null,
    pr_url: null,
    base_branch: null,
    use_worktree: null,
    labels: [],
    priority: 0,
    attachment_count: 0,
    archived_at: null,
    created_at: '2025-01-01T00:00:00.000Z',
    updated_at: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('task template vars: catalog <-> resolvers <-> chips <-> docs parity', () => {
  it('every catalog name has a resolver and every resolver names a catalog entry', () => {
    const catalogNames = [...TASK_TEMPLATE_VAR_NAMES].sort();
    const resolverNames = Object.keys(TASK_TEMPLATE_RESOLVERS).sort();
    expect(resolverNames).toEqual(catalogNames);
  });

  it('TASK_TEMPLATE_VARS covers exactly the names in TASK_TEMPLATE_VAR_NAMES, no more, no less', () => {
    const varsNames = TASK_TEMPLATE_VARS.map((entry) => entry.name).sort();
    expect(varsNames).toEqual([...TASK_TEMPLATE_VAR_NAMES].sort());
  });

  it('every chip matches the literal {{name}} form', () => {
    for (const entry of TASK_TEMPLATE_VARS) {
      expect(entry.chip).toBe(`{{${entry.name}}}`);
    }
  });

  it('every chip is documented in docs/transition-engine.md', () => {
    const docContent = fs.readFileSync(path.join(REPO_ROOT, 'docs/transition-engine.md'), 'utf-8');
    const undocumented = TASK_TEMPLATE_VARS.map((entry) => entry.chip).filter((chip) => !docContent.includes(chip));
    expect(
      undocumented,
      `These chips are not documented in docs/transition-engine.md:\n${undocumented.join('\n')}`,
    ).toEqual([]);
  });

  it('every chip is documented in docs/architecture.md', () => {
    const docContent = fs.readFileSync(path.join(REPO_ROOT, 'docs/architecture.md'), 'utf-8');
    const undocumented = TASK_TEMPLATE_VARS.map((entry) => entry.chip).filter((chip) => !docContent.includes(chip));
    expect(
      undocumented,
      `These chips are not documented in docs/architecture.md:\n${undocumented.join('\n')}`,
    ).toEqual([]);
  });
});

describe('resolveTaskTemplateVars: {{baseBranch}} effective-default fix (red-green)', () => {
  it('falls back to the effective project default when task.base_branch is null (the bug: this used to resolve empty)', () => {
    const vars = resolveTaskTemplateVars({
      task: makeTask({ base_branch: null }),
      defaultBaseBranch: 'main',
      attachmentPaths: [],
    });
    expect(vars.baseBranch).toBe('main');
  });

  it('the per-task override wins when set', () => {
    const vars = resolveTaskTemplateVars({
      task: makeTask({ base_branch: 'develop' }),
      defaultBaseBranch: 'main',
      attachmentPaths: [],
    });
    expect(vars.baseBranch).toBe('develop');
  });

  it('falls back to "main" when both the task override and defaultBaseBranch are empty', () => {
    const vars = resolveTaskTemplateVars({
      task: makeTask({ base_branch: null }),
      defaultBaseBranch: '',
      attachmentPaths: [],
    });
    expect(vars.baseBranch).toBe('main');
  });

  it('{{worktreePath}} and {{branchName}} stay a raw read (empty when null), unlike {{baseBranch}}', () => {
    const vars = resolveTaskTemplateVars({
      task: makeTask({ worktree_path: null, branch_name: null }),
      defaultBaseBranch: 'main',
      attachmentPaths: [],
    });
    expect(vars.worktreePath).toBe('');
    expect(vars.branchName).toBe('');
  });

  it('{{attachments}} lists resolved paths, one per line, with a leading newline', () => {
    const vars = resolveTaskTemplateVars({
      task: makeTask(),
      defaultBaseBranch: 'main',
      attachmentPaths: ['/mock/a.png', '/mock/b.png'],
    });
    expect(vars.attachments).toBe('\n/mock/a.png\n/mock/b.png');
  });
});

describe('interpolateTaskTemplate: drop-and-collapse semantics', () => {
  it('drops an empty-valued placeholder along with its leading separator', () => {
    expect(interpolateTaskTemplate('/code-review {{baseBranch}}', { baseBranch: '' })).toBe('/code-review');
  });

  it('drops an unknown placeholder identically to an empty-valued one', () => {
    expect(interpolateTaskTemplate('/code-review {{unknownVar}}', {})).toBe('/code-review');
  });

  it('collapses a whitespace run split across two adjacent dropped placeholders', () => {
    expect(interpolateTaskTemplate('/foo {{a}} {{b}} bar', { a: '', b: '' })).toBe('/foo bar');
  });

  it('inserts a non-empty value verbatim without collapsing its own internal whitespace', () => {
    expect(interpolateTaskTemplate('{{x}}', { x: 'a  b' })).toBe('a  b');
  });

  it('does not corrupt a substituted value that itself contains literal "{{...}}" text', () => {
    expect(interpolateTaskTemplate('{{description}}', { description: 'See {{title}} for context' }))
      .toBe('See {{title}} for context');
  });

  it('preserves newlines while collapsing only horizontal whitespace, with no dangling trailing space before the newline', () => {
    const result = interpolateTaskTemplate('Base: {{baseBranch}}\n{{body}}', { baseBranch: '', body: 'line1\nline2' });
    expect(result).toBe('Base:\nline1\nline2');
  });

  it('keeps a literal command with no placeholders untouched', () => {
    expect(interpolateTaskTemplate('/standup', {})).toBe('/standup');
  });

  it('keeps a multi-line {{task_xml}}-style value fully intact', () => {
    const xml = '<task>\n  <title>x</title>\n</task>';
    expect(interpolateTaskTemplate('{{task_xml}}{{attachments}}', { task_xml: xml, attachments: '' })).toBe(xml);
  });

  // Regression: the whitespace cleanup used to run on the CONCATENATED result,
  // so it reached into substituted values and stripped a markdown hard break
  // (a line ending in two spaces) out of the raw description {{task_xml}}
  // deliberately carries unsanitized. Cleanup is now per-text-segment.
  it('preserves a markdown hard break inside a substituted value', () => {
    const xml = '<task>\n  <description>line one  \nline two</description>\n</task>';
    expect(interpolateTaskTemplate('{{task_xml}}', { task_xml: xml })).toBe(xml);
  });

  it('does not trim an outermost substituted value, only template text edges', () => {
    expect(interpolateTaskTemplate('{{attachments}}', { attachments: '\n/mock/a.png' })).toBe('\n/mock/a.png');
    expect(interpolateTaskTemplate('  /standup  ', {})).toBe('/standup');
  });

  // Regression: /[ \t]+\n/ could not see a space sitting before a CRLF, so a
  // Windows-authored template kept the stray space and the bare \r.
  it('strips trailing horizontal whitespace before a CRLF line break', () => {
    expect(interpolateTaskTemplate('/foo {{gone}} \r\nbar', { gone: '' })).toBe('/foo\r\nbar');
  });
});

describe('BoardManagerDialog variable list is sourced from the catalog', () => {
  // Static scan rather than importing the .tsx (which would pull in React):
  // pins that the Automation section renders TASK_TEMPLATE_VARS instead of a
  // hand-maintained array that can silently drift from the resolvers.
  //
  // Asserted as the INVARIANT (rendered from the catalog, no hardcoded chips)
  // rather than as one exact line. The presentation has already changed once -
  // a row of always-on chips became a picker menu - and pinning the old
  // `const TEMPLATE_VARIABLES = ...` spelling failed that refactor while the
  // property it exists to protect was never violated.
  const source = fs.readFileSync(
    path.join(REPO_ROOT, 'src/renderer/components/dialogs/BoardManagerDialog.tsx'),
    'utf-8',
  );

  it('renders the variable list by mapping the shared catalog', () => {
    expect(source).toContain("import { TASK_TEMPLATE_VARS } from '../../../shared/task-template-vars'");
    expect(source).toMatch(/TASK_TEMPLATE_VARS\.map\(/);
  });

  it('hardcodes no template-variable chips of its own', () => {
    // Matches a STANDALONE quoted chip, which is the shape a hand-maintained
    // array takes (`['{{task_xml}}', '{{title}}', ...]`). Deliberately not a
    // bare `{{name}}` scan: that also hits any comment that names a variable
    // in prose (the JSDoc on the inserter mentions `{{chip}}` and
    // `{{variable}}`), which is not a second source of truth.
    const hardcoded = source.match(/['"]\{\{[a-zA-Z_]+\}\}['"]/g) ?? [];
    expect(hardcoded).toEqual([]);
    // Non-vacuous: the catalog is big enough that a hand-rolled copy of it
    // would trip the scan above many times over.
    expect(TASK_TEMPLATE_VARS.length).toBeGreaterThan(3);
  });
});
