/**
 * The phone reaches four workflow commands (list, get, pause, resume) through
 * board-tool-read/board-tool-write, which skips the MCP tools' zod schemas and
 * hands `params` straight from the wire. So each must check its own params'
 * types and answer a bad one with a refusal, never throw or reach a lookup.
 */
import { describe, it, expect, vi } from 'vitest';

const resolveWorkflow = vi.fn();
vi.mock('../../src/main/workflows/workflow-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/workflows/workflow-service')>();
  return { ...actual, resolveWorkflow: (...args: unknown[]) => resolveWorkflow(...args) };
});

import { commandHandlers } from '../../src/main/agent/commands';
import { isBoardToolAllowedForVerb } from '../../src/main/mobile-bridge/handlers/board-tool-allowlist';
import type { CommandContext } from '../../src/main/agent/commands/types';

const context = { projectId: 'proj-1' } as unknown as CommandContext;

describe('workflow commands on the phone path', () => {
  it('opens exactly list and get to reads, and pause and resume to writes', () => {
    expect(isBoardToolAllowedForVerb('list_workflows', 'board-tool-read')).toBe(true);
    expect(isBoardToolAllowedForVerb('get_workflow', 'board-tool-read')).toBe(true);
    expect(isBoardToolAllowedForVerb('pause_workflow', 'board-tool-write')).toBe(true);
    expect(isBoardToolAllowedForVerb('resume_workflow', 'board-tool-write')).toBe(true);
    for (const tool of ['save_workflow', 'start_workflow', 'delete_workflow', 'link_workflow_tasks', 'request_project_access']) {
      expect(isBoardToolAllowedForVerb(tool, 'board-tool-read')).toBe(false);
      expect(isBoardToolAllowedForVerb(tool, 'board-tool-write')).toBe(false);
    }
  });

  for (const tool of ['get_workflow', 'pause_workflow', 'resume_workflow'] as const) {
    it(`${tool} refuses a workflow that is not text, before looking anything up`, async () => {
      const response = await commandHandlers[tool]({ workflow: 42 }, context);
      expect(response).toEqual({ success: false, error: 'workflow must be text.' });
      expect(resolveWorkflow).not.toHaveBeenCalled();
    });

    it(`${tool} refuses a missing workflow`, async () => {
      const response = await commandHandlers[tool]({}, context);
      expect(response).toEqual({ success: false, error: 'workflow is required.' });
    });
  }
});
