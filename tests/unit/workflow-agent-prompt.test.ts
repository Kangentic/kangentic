/**
 * The workflow agent's first message: the variables its builder fills are
 * exactly the ones the Settings field offers (`templateVarsFor('workflow')`), so
 * a variable added to the catalog for that context cannot be offered and then
 * dropped as unknown, and the default template uses nothing else.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp', isPackaged: false } }));

const { WORKFLOW_AGENT_VARIABLE_NAMES } = await import('../../src/main/workflows/workflow-agent-prompt');
const { templateVarsFor, TEMPLATE_VARIABLE_PATTERN } = await import('../../src/shared/task-template-vars');
const { DEFAULT_WORKFLOW_AGENT_PROMPT, workflowAgentPromptTemplate } = await import('../../src/shared/workflow-agent-prompt');

describe('workflow agent first message', () => {
  it('fills every variable the workflow context offers, and only those', () => {
    const offered = templateVarsFor('workflow').map((info) => info.name).sort();
    expect([...WORKFLOW_AGENT_VARIABLE_NAMES].sort()).toEqual(offered);
  });

  it('uses only variables the workflow context offers in its default text', () => {
    const offered = new Set(templateVarsFor('workflow').map((info) => info.name as string));
    const used = [...DEFAULT_WORKFLOW_AGENT_PROMPT.matchAll(TEMPLATE_VARIABLE_PATTERN)].map((match) => match[1]);
    expect(used.length).toBeGreaterThan(0);
    for (const name of used) expect(offered).toContain(name);
  });

  it('falls back to the default for an unset or blank setting', () => {
    expect(workflowAgentPromptTemplate(undefined)).toBe(DEFAULT_WORKFLOW_AGENT_PROMPT);
    expect(workflowAgentPromptTemplate('   ')).toBe(DEFAULT_WORKFLOW_AGENT_PROMPT);
    expect(workflowAgentPromptTemplate('Plan {{projectName}}.')).toBe('Plan {{projectName}}.');
  });
});
