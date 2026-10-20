/**
 * `{{workflow_xml}}`: a workflow task's agent is told its route, its
 * neighbours, and how its turns are judged; every other task's default prompt
 * is exactly what it was before the variable existed.
 */
import { describe, it, expect } from 'vitest';
import type { Task } from '../../src/shared/types';
import { DEFAULT_SPAWN_PROMPT_TEMPLATE } from '../../src/shared/task-template-vars';
import { buildWorkflowXml } from '../../src/main/agent/shared/prompt-xml';
import { resolveTaskTemplateVars } from '../../src/main/agent/shared/task-template-resolvers';
import { interpolateTaskTemplate } from '../../src/main/agent/shared/template-utils';

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    display_id: 414,
    title: 'Budgets UI',
    description: 'Show the budgets.',
    labels: [],
    ...overrides,
  } as Task;
}

const WORKFLOW = {
  title: 'Usage <budgets> & limits',
  route: ['Executing', 'Code Review', 'Done'],
  waitsFor: [{ number: 411, title: 'Budgets API', column: 'Done', branch: 'budgets-api', prUrl: 'https://example.com/pr/1' }],
  blocks: [{ number: 417, title: 'Budgets docs', column: 'To Do' }],
};

function context(workflow: typeof WORKFLOW | null) {
  return {
    task: task(),
    defaultBaseBranch: 'main',
    attachmentPaths: [],
    devPort: null,
    projectPath: '/projects/home',
    projectName: 'kangentic',
    move: null,
    workflow,
  };
}

describe('{{workflow_xml}}', () => {
  it('escapes the workflow\'s facts and names the route, built-on and waiting tasks', () => {
    const xml = buildWorkflowXml(WORKFLOW);
    expect(xml).toContain('<name>Usage &lt;budgets&gt; &amp; limits</name>');
    expect(xml).toContain('<route>Executing, Code Review, Done</route>');
    expect(xml).toContain('number="411"');
    expect(xml).toContain('budgets-api');
    expect(xml).toContain('number="417"');
  });

  it('tells the agent how its turns are judged', () => {
    const xml = buildWorkflowXml(WORKFLOW);
    expect(xml).toContain('End your turn only when this column\'s work is done');
    expect(xml).toContain('kangentic_move_task');
    expect(xml).toContain('kangentic_mark_background_service');
  });

  it('mentions waiting tasks only when something waits on this one', () => {
    const waitingLine = 'The tasks waiting on this one build on what you change.';
    expect(buildWorkflowXml(WORKFLOW)).toContain(waitingLine);
    const last = buildWorkflowXml({ ...WORKFLOW, blocks: [] });
    expect(last).not.toContain(waitingLine);
    expect(last).not.toContain('<waiting_on_this>');
  });

  it('resolves empty outside a workflow, leaving the default prompt as it was', () => {
    const vars = resolveTaskTemplateVars(context(null));
    expect(vars.workflow_xml).toBe('');
    const before = interpolateTaskTemplate('{{task_xml}}{{attachments}}', vars);
    expect(interpolateTaskTemplate(DEFAULT_SPAWN_PROMPT_TEMPLATE, vars)).toBe(before);
  });

  it('puts the block on its own line after the task in the default prompt', () => {
    const vars = resolveTaskTemplateVars(context(WORKFLOW));
    const prompt = interpolateTaskTemplate(DEFAULT_SPAWN_PROMPT_TEMPLATE, vars);
    expect(prompt).toMatch(/<\/task>\n<workflow>/);
  });
});
