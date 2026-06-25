/**
 * Tests for the browser-verification section of buildServerInstructions
 * (src/main/agent/mcp-http/server-instructions.ts).
 *
 * The `buildBrowserSection` helper, called inside `buildServerInstructions`,
 * has five falsifiable branches:
 *   1. No open panes    - only the static guidance text is emitted
 *   2. Single pane w/ URL  - single-pane advertisement with the URL
 *   3. Single pane, no URL - single-pane advertisement without a URL component
 *   4. Multiple panes   - multi-pane summary
 *   5. Pane list cap    - more than 5 panes: total count is correct, only 5
 *                          task names appear in the summary
 *
 * Two cross-cutting filter behaviors are also tested:
 *   - alive filter: panes with alive=false are never advertised
 *   - projectId filter: when an active project is bound, only that project's
 *     panes appear; when no active project is bound, all alive panes appear
 *
 * `browserPaneRegistry` is mocked at the module level so no Electron binary
 * or real CDP state is required.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted spy - must be defined before vi.mock() factories run.
// ---------------------------------------------------------------------------

const { fakeList } = vi.hoisted(() => {
  const fakeList = vi.fn(
    () =>
      [] as Array<{
        sessionId: string;
        taskId: string;
        projectId: string | null;
        webContentsId: number;
        url: string | null;
        registeredAt: number;
        alive: boolean;
        debuggerAttached: boolean;
      }>,
  );
  return { fakeList };
});

// ---------------------------------------------------------------------------
// Module mock - replace the registry singleton so list() is controllable.
// Mocking the whole module means electron (imported by the real module) is
// never loaded by this test file.
// ---------------------------------------------------------------------------

vi.mock('../../src/main/browser/browser-pane-registry', () => ({
  browserPaneRegistry: { list: fakeList },
}));

// ---------------------------------------------------------------------------
// Import under test (after all vi.mock calls)
// ---------------------------------------------------------------------------

import { buildServerInstructions } from '../../src/main/agent/mcp-http/server-instructions';
import type { RequestResolver } from '../../src/main/agent/mcp-http/project-resolver';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type ProjectSummary = ReturnType<RequestResolver['listProjects']>[number];

function makeProject(overrides: Partial<ProjectSummary> = {}): ProjectSummary {
  return {
    id: 'proj-a',
    name: 'MyApp',
    path: '/projects/myapp',
    lastOpened: '2026-01-01T00:00:00Z',
    isActive: true,
    ...overrides,
  };
}

function makeResolver(projects: ProjectSummary[]): RequestResolver {
  return {
    listProjects: vi.fn(() => projects),
  } as unknown as RequestResolver;
}

type PaneStatus = ReturnType<typeof fakeList>[number];

function makePane(overrides: Partial<PaneStatus> = {}): PaneStatus {
  return {
    sessionId: 'sess-1',
    taskId: 'task-1',
    projectId: 'proj-a',
    webContentsId: 1,
    url: 'http://localhost:3000',
    registeredAt: Date.now(),
    alive: true,
    debuggerAttached: false,
    ...overrides,
  };
}

/** A resolver with a single active project (id='proj-a', name='MyApp'). */
const ACTIVE_RESOLVER = makeResolver([makeProject()]);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildServerInstructions - browser section', () => {
  beforeEach(() => {
    fakeList.mockReset();
    fakeList.mockReturnValue([]);
  });

  // -------------------------------------------------------------------------
  // Branch 1: static content - always present
  // -------------------------------------------------------------------------

  it('always includes the BROWSER VERIFICATION header and guidance paragraph', () => {
    // No panes registered - the static block must still appear.
    const instructions = buildServerInstructions(ACTIVE_RESOLVER);

    expect(instructions).toContain('BROWSER VERIFICATION (kangentic_browser_* tools):');
    // Guidance paragraph: the agent should prefer the browser tools over Playwright.
    expect(instructions).toContain('kangentic_browser_list_panes');
    // Guard against proactive driving (the "do not drive" contract).
    expect(instructions).toContain('Do not drive the browser proactively');
    // Open-pane discovery advice.
    expect(instructions).toContain('Browser pill in the task header');
  });

  it('adds no pane advertisement when the registry is empty', () => {
    const instructions = buildServerInstructions(ACTIVE_RESOLVER);

    expect(instructions).not.toContain('A Browser pane is currently open');
    expect(instructions).not.toContain('Browser panes are currently open');
  });

  // -------------------------------------------------------------------------
  // Branch 2: single pane with URL
  // -------------------------------------------------------------------------

  it('emits a single-pane advertisement with the URL when one alive pane is open', () => {
    fakeList.mockReturnValue([makePane({ taskId: 'task-abc', url: 'http://localhost:3000' })]);

    const instructions = buildServerInstructions(ACTIVE_RESOLVER);

    expect(instructions).toContain(
      'A Browser pane is currently open at http://localhost:3000 (task task-abc).',
    );
    expect(instructions).toContain('You can drive it now with the kangentic_browser_* tools.');
    // Must NOT also emit the multi-pane format.
    expect(instructions).not.toContain('Browser panes are currently open:');
  });

  // -------------------------------------------------------------------------
  // Branch 3: single pane, url is null
  // -------------------------------------------------------------------------

  it('emits a single-pane advertisement without a URL component when pane.url is null', () => {
    fakeList.mockReturnValue([makePane({ taskId: 'task-xyz', url: null })]);

    const instructions = buildServerInstructions(ACTIVE_RESOLVER);

    // The "at URL" part must be absent when url is null.
    expect(instructions).not.toContain('currently open at');
    expect(instructions).toContain('A Browser pane is currently open (task task-xyz).');
  });

  // -------------------------------------------------------------------------
  // Branch 4: multiple panes
  // -------------------------------------------------------------------------

  it('emits a multi-pane summary when two panes are open', () => {
    fakeList.mockReturnValue([
      makePane({ sessionId: 'sess-1', taskId: 'task-1', url: 'http://localhost:3000' }),
      makePane({ sessionId: 'sess-2', taskId: 'task-2', url: null }),
    ]);

    const instructions = buildServerInstructions(ACTIVE_RESOLVER);

    expect(instructions).toContain('2 Browser panes are currently open:');
    // Both tasks appear in the summary.
    expect(instructions).toContain('task task-1 (http://localhost:3000)');
    expect(instructions).toContain('task task-2');
    // Agent is told to pass sessionId or taskId to disambiguate.
    expect(instructions).toContain('Drive a specific one with the kangentic_browser_* tools');
    // Must NOT also emit the single-pane format.
    expect(instructions).not.toContain('A Browser pane is currently open');
  });

  it('includes the pane URL in the multi-pane summary and omits the URL component when null', () => {
    fakeList.mockReturnValue([
      makePane({ sessionId: 'sess-1', taskId: 'task-with-url', url: 'http://localhost:5173' }),
      makePane({ sessionId: 'sess-2', taskId: 'task-no-url', url: null }),
    ]);

    const instructions = buildServerInstructions(ACTIVE_RESOLVER);

    // Pane with URL: "task task-with-url (http://localhost:5173)"
    expect(instructions).toContain('task task-with-url (http://localhost:5173)');
    // Pane without URL: "task task-no-url" with no trailing "(null)" or similar.
    expect(instructions).toContain('task task-no-url');
    expect(instructions).not.toContain('task task-no-url (');
  });

  // -------------------------------------------------------------------------
  // Branch 5: pane list cap (INSTRUCTIONS_PANE_LIST_CAP = 5)
  // -------------------------------------------------------------------------

  it('caps the pane summary at 5 entries even when more panes are open', () => {
    // 7 panes - the cap is 5, so task-5 and task-6 must not appear in the summary.
    const panes = Array.from({ length: 7 }, (_, index) =>
      makePane({ sessionId: `sess-${index}`, taskId: `task-${index}`, url: null }),
    );
    fakeList.mockReturnValue(panes);

    const instructions = buildServerInstructions(ACTIVE_RESOLVER);

    // Total count is still the actual number (7), not the cap.
    expect(instructions).toContain('7 Browser panes are currently open:');
    // The first 5 task names (task-0 through task-4) appear in the summary.
    for (let index = 0; index < 5; index++) {
      expect(instructions).toContain(`task task-${index}`);
    }
    // task-5 and task-6 are beyond the cap.
    expect(instructions).not.toContain('task task-5');
    expect(instructions).not.toContain('task task-6');
  });

  // -------------------------------------------------------------------------
  // alive filter
  // -------------------------------------------------------------------------

  it('excludes panes where alive=false from the advertisement', () => {
    fakeList.mockReturnValue([makePane({ alive: false, taskId: 'dead-pane' })]);

    const instructions = buildServerInstructions(ACTIVE_RESOLVER);

    expect(instructions).not.toContain('Browser pane is currently open');
    expect(instructions).not.toContain('dead-pane');
  });

  it('counts only alive panes: a dead pane plus a live pane shows the single-pane format', () => {
    fakeList.mockReturnValue([
      makePane({ sessionId: 'dead', taskId: 'dead-task', alive: false }),
      makePane({ sessionId: 'live', taskId: 'live-task', alive: true, url: 'http://localhost:8080' }),
    ]);

    const instructions = buildServerInstructions(ACTIVE_RESOLVER);

    // Only the live pane survives the filter.
    expect(instructions).toContain('A Browser pane is currently open at http://localhost:8080 (task live-task).');
    expect(instructions).not.toContain('dead-task');
    // Multi-pane format must not appear.
    expect(instructions).not.toContain('Browser panes are currently open:');
  });

  // -------------------------------------------------------------------------
  // projectId filter
  // -------------------------------------------------------------------------

  it('excludes panes from other projects when an active project is bound', () => {
    fakeList.mockReturnValue([
      makePane({ sessionId: 'sess-a', projectId: 'proj-a', taskId: 'in-scope', url: 'http://localhost:3000' }),
      makePane({ sessionId: 'sess-b', projectId: 'proj-b', taskId: 'out-of-scope', url: 'http://other:4000' }),
    ]);
    // Active project is proj-a.
    const instructions = buildServerInstructions(
      makeResolver([makeProject({ id: 'proj-a', isActive: true })]),
    );

    // Only the proj-a pane is advertised (single-pane path).
    expect(instructions).toContain(
      'A Browser pane is currently open at http://localhost:3000 (task in-scope).',
    );
    expect(instructions).not.toContain('out-of-scope');
    expect(instructions).not.toContain('proj-b');
  });

  it('shows all alive panes regardless of projectId when no active project is bound', () => {
    fakeList.mockReturnValue([
      makePane({ sessionId: 'sess-a', projectId: 'proj-a', taskId: 'task-from-a', url: 'http://localhost:3000' }),
      makePane({ sessionId: 'sess-b', projectId: 'proj-b', taskId: 'task-from-b', url: null }),
    ]);
    // Empty project list -> no active project -> activeProjectId is null.
    const instructions = buildServerInstructions(makeResolver([]));

    expect(instructions).toContain('2 Browser panes are currently open:');
    expect(instructions).toContain('task task-from-a');
    expect(instructions).toContain('task task-from-b');
  });

  it('shows zero-project-filtered panes as no advertisement even when dead panes are present', () => {
    fakeList.mockReturnValue([
      // Alive, but belongs to a different project.
      makePane({ sessionId: 'sess-x', projectId: 'proj-other', taskId: 'other-task', alive: true }),
    ]);
    // Active project is proj-a, so proj-other is excluded.
    const instructions = buildServerInstructions(
      makeResolver([makeProject({ id: 'proj-a', isActive: true })]),
    );

    expect(instructions).not.toContain('Browser pane is currently open');
    expect(instructions).not.toContain('other-task');
  });
});
