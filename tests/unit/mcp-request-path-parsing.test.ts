/**
 * Unit tests for `parseMcpRequestPath` (src/main/agent/mcp-http-server.ts).
 *
 * `handleHttpRequest` used to inline this parse (`segments[1]` -> projectId,
 * `segments[2]` -> optional callerSessionId) with zero test coverage - only
 * reachable through a real HTTP request. It was extracted into a small pure
 * function (mirroring the existing `buildAllowedHosts` precedent in this same
 * file) so the URL-segment contract is directly testable. Before the
 * extraction, reverting the parse to 2-segment-only (dropping `segments[2]`
 * entirely) failed nothing anywhere in the suite.
 *
 * Heavy leaf modules are stubbed so mcp-http-server imports under node
 * (mirrors mcp-server-config-gating.test.ts / mcp-server-network-config.test.ts).
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({
  webContents: { fromId: () => null },
  app: { getPath: () => '/tmp', isPackaged: false },
}));
vi.mock('../../src/main/agent/commands', () => ({ commandHandlers: {} }));
vi.mock('../../src/main/agent/mcp-project-context', () => ({
  buildCommandContextForProject: vi.fn(() => null),
}));
vi.mock('../../src/main/search/search-core', () => ({ runSearchEverything: vi.fn() }));
vi.mock('../../src/main/diagnostics/process-metrics', () => ({ getProcessMetrics: vi.fn() }));
vi.mock('../../src/main/git/worktree-list', () => ({ enumerateWorktrees: vi.fn() }));
vi.mock('../../src/main/browser/browser-pane-driver', () => ({
  withGuest: vi.fn(),
  validateNavigationUrl: vi.fn(),
}));
vi.mock('../../src/main/browser/browser-pane-registry', () => ({
  browserPaneRegistry: { list: () => [] },
}));
vi.mock('../../src/main/browser/cdp/cdp', () => ({
  clickAtCenterOfSelector: vi.fn(),
  dispatchMouseEvent: vi.fn(),
  dispatchKeyEvent: vi.fn(),
  dispatchKeypress: vi.fn(),
  dragFromTo: vi.fn(),
  getOuterHtml: vi.fn(),
  getBoundingBox: vi.fn(),
  getConsoleEntries: vi.fn(),
  getLayoutMetrics: vi.fn(),
  queryAllElements: vi.fn(),
  runtimeEvaluate: vi.fn(),
  typeText: vi.fn(),
}));
vi.mock('../../src/main/browser/cdp/screenshot', () => ({
  captureScreenshotWithBudget: vi.fn(),
  captureElementClip: vi.fn(),
}));
vi.mock('../../src/devtools/mcp/register', () => ({ registerDevtoolsMcpTools: vi.fn() }));

import { parseMcpRequestPath } from '../../src/main/agent/mcp-http-server';

describe('parseMcpRequestPath', () => {
  it('returns projectId with callerSessionId undefined when there is no third segment', () => {
    expect(parseMcpRequestPath('/mcp/proj-1')).toEqual({ projectId: 'proj-1', callerSessionId: undefined });
  });

  it('returns both projectId and callerSessionId when a third segment is present', () => {
    // Red: reverting the parse to 2-segment-only (never reading segments[2])
    // makes callerSessionId undefined here too.
    expect(parseMcpRequestPath('/mcp/proj-1/session-abc')).toEqual({
      projectId: 'proj-1',
      callerSessionId: 'session-abc',
    });
  });

  it('ignores a trailing slash (no phantom empty callerSessionId)', () => {
    expect(parseMcpRequestPath('/mcp/proj-1/')).toEqual({ projectId: 'proj-1', callerSessionId: undefined });
  });

  it('ignores segments past the caller session id', () => {
    // Matches the pre-extraction behavior: only segments[1]/segments[2] were
    // ever read, so a 4th+ segment is silently dropped, not an error.
    expect(parseMcpRequestPath('/mcp/proj-1/session-abc/extra/stuff')).toEqual({
      projectId: 'proj-1',
      callerSessionId: 'session-abc',
    });
  });

  it('returns null when the path has fewer than two segments', () => {
    expect(parseMcpRequestPath('/mcp')).toBeNull();
    expect(parseMcpRequestPath('/')).toBeNull();
  });

  it('returns null when the first segment is not "mcp"', () => {
    expect(parseMcpRequestPath('/notmcp/proj-1')).toBeNull();
  });
});
