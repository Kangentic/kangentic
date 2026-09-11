/**
 * Unit test for the kangentic_list_worktrees base-ref wiring in
 * src/main/agent/mcp-http/diagnostics-tools.ts.
 *
 * enumerateWorktrees (src/main/git/worktree-list.ts) does not know how to
 * resolve a worktree's base branch on its own; that logic lives in the
 * per-request resolver (RequestResolver.resolveWorktreeBaseRef), which reaches
 * both the task DB and the board/config defaults. The tool handler is
 * supposed to thread a resolveBaseRef hook through to enumerateWorktrees that
 * delegates to the resolver. This test proves the hook actually reaches
 * enumerateWorktrees and actually calls resolver.resolveWorktreeBaseRef -
 * a handler that reverted to calling enumerateWorktrees with only
 * { projectId } (dropping resolveBaseRef entirely) would fail here.
 *
 * Pattern mirrors tests/unit/mcp-project-tools.test.ts: a minimal fake
 * McpServer captures each registerTool(name, config, handler) call so the
 * handler can be invoked directly, without the real MCP SDK transport.
 *
 * Heavy imports are mocked the same way mcp-task-tools-run-mode-wiring.test.ts
 * does: handler-helpers is mocked so importing diagnostics-tools.ts never
 * pulls in commandHandlers (and thus better-sqlite3), and process-metrics is
 * mocked so its `import { app } from 'electron'` never has to resolve a real
 * electron binding in this plain-node test process. worktree-list is mocked
 * per this hole's instructions, so enumerateWorktrees is a bare vi.fn().
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/main/git/worktree-list', () => ({
  enumerateWorktrees: vi.fn(async () => []),
}));

vi.mock('../../src/main/agent/mcp-http/handler-helpers', () => ({
  PROJECT_SELECTOR_DESCRIPTION: 'Optional project selector (test stub).',
}));

vi.mock('../../src/main/diagnostics/process-metrics', () => ({
  getProcessMetrics: vi.fn(),
}));

import { registerDiagnosticsTools } from '../../src/main/agent/mcp-http/diagnostics-tools';
import { enumerateWorktrees } from '../../src/main/git/worktree-list';
import type { WorktreeBaseRefInput } from '../../src/main/git/worktree-list';
import type { RequestResolver } from '../../src/main/agent/mcp-http/project-resolver';

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

function makeFakeServer(): { registerTool: ReturnType<typeof vi.fn>; getHandler: (name: string) => ToolHandler } {
  const handlers: Record<string, ToolHandler> = {};
  const registerTool = vi.fn((name: string, _config: unknown, handler: ToolHandler) => {
    handlers[name] = handler;
  });
  return {
    registerTool,
    getHandler: (name: string) => {
      const handler = handlers[name];
      if (!handler) throw new Error(`Tool "${name}" was not registered`);
      return handler;
    },
  };
}

describe('registerDiagnosticsTools - kangentic_list_worktrees base-ref wiring', () => {
  it('threads a resolveBaseRef hook backed by resolver.resolveWorktreeBaseRef through to enumerateWorktrees', async () => {
    const server = makeFakeServer();
    const resolveWorktreeBaseRef = vi.fn(() => 'develop');
    const resolver = {
      resolveProject: vi.fn(),
      resolveWorktreeBaseRef,
    } as unknown as RequestResolver;

    registerDiagnosticsTools(server as never, resolver);
    await server.getHandler('kangentic_list_worktrees')({});

    // (1) enumerateWorktrees receives an object whose resolveBaseRef is a
    // function. Reverting to enumerateWorktrees(projectId ? { projectId } : {})
    // (dropping resolveBaseRef) fails this assertion.
    expect(vi.mocked(enumerateWorktrees)).toHaveBeenCalledTimes(1);
    const passedOptions = vi.mocked(enumerateWorktrees).mock.calls[0][0];
    expect(typeof passedOptions?.resolveBaseRef).toBe('function');

    // (2) that captured resolveBaseRef delegates to resolver.resolveWorktreeBaseRef
    // with the exact input it was given.
    const sampleInput: WorktreeBaseRefInput = {
      projectId: 'proj-1',
      projectPath: '/mock/repo',
      worktreePath: '/mock/repo/.kangentic/worktrees/t',
      branch: 'feature/x',
      isMainCheckout: false,
    };
    const result = passedOptions?.resolveBaseRef?.(sampleInput);

    expect(result).toBe('develop');
    expect(resolveWorktreeBaseRef).toHaveBeenCalledWith(sampleInput);
  });
});
