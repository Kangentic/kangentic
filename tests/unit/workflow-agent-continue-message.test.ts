/**
 * The first message of a new conversation for a workflow that already has a
 * plan (`buildWorkflowAgentContinueMessage`), sent when its agent's earlier
 * conversation cannot be resumed. A save replaces the whole plan, so an agent
 * that planned from the brief again would save over every task the user had
 * shaped; this message hands it the saved plan to build on instead.
 *
 * The workflow service is mocked (the builder loads it lazily, and vitest's
 * mock covers that import); the plan's text is the real `formatWorkflow`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IpcContext } from '../../src/main/ipc/ipc-context';
import type { Workflow } from '../../src/shared/types';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp', isPackaged: false } }));

const harness = vi.hoisted(() => ({
  view: null as unknown,
  readFails: false,
}));

vi.mock('../../src/main/workflows/workflow-service', () => ({
  readWorkflow: () => {
    if (harness.readFails) throw new Error('database closing');
    return harness.view;
  },
}));
vi.mock('../../src/main/db/database', () => ({
  getProjectDb: () => {
    throw new Error('no board in this test');
  },
  getExistingProjectDb: () => null,
}));

const { buildWorkflowAgentContinueMessage } = await import('../../src/main/workflows/workflow-agent-prompt');
const { commandLineLength } = await import('../../src/main/agent/shared/prompt-budget');

const workflow = { id: 'wf-1', title: 'Usage budgets', state: 'draft', revision: 3, brief: null, source_task_id: null } as unknown as Workflow;
const context = { projectRepo: { getById: () => undefined } } as unknown as IpcContext;

function plannedTask(title: string) {
  return {
    key: title.toLowerCase().replace(/\s+/g, '-'),
    title,
    column: 'To Do',
    board: null,
    route: ['Planning', 'Executing'],
    waitsFor: [],
    place: 'planned',
    runSettings: {
      base_branch: null, use_worktree: null, run_mode: null, agent_override: null,
      model_override: null, effort_override: null, permission_mode: null,
    },
    profileName: null,
  };
}

beforeEach(() => {
  harness.readFails = false;
  harness.view = { workflow, tasks: [plannedTask('Token table'), plannedTask('Budget alerts')] };
});

describe('buildWorkflowAgentContinueMessage', () => {
  it('sends the first message, then the saved plan and what to do with it', async () => {
    const message = await buildWorkflowAgentContinueMessage(context, 'home', workflow, 'FIRST MESSAGE');

    expect(message).not.toBeNull();
    expect(message!.startsWith('FIRST MESSAGE')).toBe(true);
    expect(message).toContain('<saved_plan>');
    expect(message).toContain('Token table');
    expect(message).toContain('Budget alerts');
    expect(message).toContain('keep every task you are not changing');
  });

  it('is null when nothing is saved yet, so the caller sends the plain first message', async () => {
    harness.view = { workflow, tasks: [] };
    expect(await buildWorkflowAgentContinueMessage(context, 'home', workflow, 'FIRST MESSAGE')).toBeNull();
  });

  it('is null when the plan cannot be read', async () => {
    harness.readFails = true;
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await buildWorkflowAgentContinueMessage(context, 'home', workflow, 'FIRST MESSAGE')).toBeNull();
  });

  // The message rides the command line (8,191 characters under a cmd.exe
  // shell); a long plan would leave the recovering start unable to start.
  it('points the agent at its saved plan instead of sending a long one', async () => {
    const longTitle = 'A task whose title runs on for a while to make the plan long'.repeat(2);
    harness.view = { workflow, tasks: Array.from({ length: 40 }, (_unused, index) => plannedTask(`${longTitle} ${index}`)) };

    const message = await buildWorkflowAgentContinueMessage(context, 'home', workflow, 'FIRST MESSAGE');

    expect(message).not.toContain('<saved_plan>');
    expect(message).toContain('kangentic_get_workflow');
    expect(message!.length).toBeLessThan(1_000);
  });

  // The inline budget (INLINE_PROMPT_BUDGET, agent/shared/prompt-budget.ts) counts the
  // whole message as the command line carries it: the first message, the saved
  // plan, and the lines around the plan. A board with many columns or a long
  // custom template fills much of that line before the plan is added, so a short
  // plan can still push the whole message past it. The template here has no
  // variables and no whitespace, so the first message is exactly the template.
  describe('inline budget (the whole message, as the command line carries it)', () => {
    const INLINE_BUDGET = 7_000;
    /** cmd.exe's command line limit; the message is only part of the command. */
    const COMMAND_LINE_LIMIT = 8_191;

    /** How much the inline message adds to its first message, for the file's two-task plan. */
    async function measureInlineWrapperLength(): Promise<number> {
      const message = await buildWorkflowAgentContinueMessage(context, 'home', workflow, 'x');
      expect(message).toContain('<saved_plan>');
      return message!.length - 'x'.length;
    }

    it('points the agent at its saved plan when a long template and a short plan together pass the budget', async () => {
      const wrapperLength = await measureInlineWrapperLength();
      const template = 'x'.repeat(INLINE_BUDGET - wrapperLength + 1);
      // Neither part is over the budget alone, so only counting both can send
      // this to the pointer. Red: a check on the plan by itself keeps it inline.
      expect(template.length).toBeLessThan(INLINE_BUDGET);
      expect(wrapperLength).toBeLessThan(INLINE_BUDGET);

      const message = await buildWorkflowAgentContinueMessage(context, 'home', workflow, template);

      expect(message!.startsWith(template)).toBe(true);
      expect(message).not.toContain('<saved_plan>');
      expect(message).toContain('kangentic_get_workflow');
      expect(message!.length).toBeLessThan(COMMAND_LINE_LIMIT);
    });

    it('still sends the plan inline when the whole message exactly fills the budget', async () => {
      const wrapperLength = await measureInlineWrapperLength();
      const template = 'x'.repeat(INLINE_BUDGET - wrapperLength);

      const message = await buildWorkflowAgentContinueMessage(context, 'home', workflow, template);

      expect(message!.length).toBe(INLINE_BUDGET);
      expect(message!.startsWith(template)).toBe(true);
      expect(message).toContain('<saved_plan>');
      expect(message).toContain('Token table');
      expect(message).not.toContain('kangentic_get_workflow');
    });

    // A cmd host writes each `%` as `"^%"` (escapePercentForCmd), four
    // characters, so the raw length undercounts what the command line holds.
    it('measures by command line length, so a message full of % goes to the pointer', async () => {
      const wrapperLength = await measureInlineWrapperLength();
      // Small enough that the pointer form fits, large enough that the inline
      // form does not once each `%` counts four.
      const percentCount = Math.floor((INLINE_BUDGET - wrapperLength) / 4) + 1;
      const template = '%'.repeat(percentCount);
      // Red: by raw length the inline form fits with room to spare.
      expect(template.length + wrapperLength).toBeLessThan(INLINE_BUDGET);
      expect(commandLineLength(template) + wrapperLength).toBeGreaterThan(INLINE_BUDGET);

      const message = await buildWorkflowAgentContinueMessage(context, 'home', workflow, template);

      expect(message!.startsWith(template)).toBe(true);
      expect(message).not.toContain('<saved_plan>');
      expect(message).toContain('kangentic_get_workflow');
      expect(commandLineLength(message!)).toBeLessThanOrEqual(INLINE_BUDGET);
    });
  });
});
