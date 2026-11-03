/**
 * The MCP instructions stay under Claude Code's 4,096-character cut (task #977).
 *
 * Claude Code shows the agent only the instructions text before the cut, and
 * the project list sits last. With 16 projects and one open pane the text was
 * about 4,050 characters before the browser policy was rewritten, so any
 * stronger browser wording would have cut the project list off silently.
 * `buildServerInstructions` now shortens the project list to fit; these cases
 * fail when the fixed text grows enough to squeeze out a typical list.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { fakeList } = vi.hoisted(() => ({
  fakeList: vi.fn((): Array<{
    sessionId: string;
    taskId: string;
    projectId: string | null;
    webContentsId: number;
    url: string | null;
    registeredAt: number;
    alive: boolean;
    debuggerAttached: boolean;
  }> => []),
}));

vi.mock('../../src/main/browser/browser-pane-registry', () => ({
  browserPaneRegistry: { list: fakeList },
}));

import {
  buildServerInstructions,
  INSTRUCTIONS_PANE_LIST_CAP,
  INSTRUCTIONS_PROJECT_LIST_CAP,
  MCP_INSTRUCTIONS_CHARACTER_CAP,
} from '../../src/main/agent/mcp-http/server-instructions';
import type { RequestResolver } from '../../src/main/agent/mcp-http/project-resolver';

type ProjectSummary = ReturnType<RequestResolver['listProjects']>[number];

function resolverWith(names: string[]): RequestResolver {
  const projects: ProjectSummary[] = names.map((name, index) => ({
    id: `project-${index}`,
    name,
    path: `/projects/${index}`,
    lastOpened: '2026-01-01T00:00:00Z',
    isActive: index === 0,
  }));
  return { listProjects: () => projects } as unknown as RequestResolver;
}

function openPanes(count: number, url: string): void {
  fakeList.mockReturnValue(Array.from({ length: count }, (_, index) => ({
    sessionId: `pane_${index}`,
    taskId: `0f3c2a91-7b44-4d1e-9a8c-${String(index).padStart(12, '0')}`,
    projectId: 'project-0',
    webContentsId: index + 1,
    url,
    registeredAt: 0,
    alive: true,
    debuggerAttached: false,
  })));
}

/** A typical setup's project names: 16 projects of ordinary length. */
const TYPICAL_PROJECT_NAMES = [
  'kangentic', 'kangentic.com', 'kangentic-mobile', 'kangentic-relay', 'kangentic-branding',
  'Customer-Portal', 'Inventory-Service', 'Billing-Core', 'Billing-Reports', 'Records-Archive',
  'Marketing-Site', 'operations-dashboard', 'Hiring-Tool', 'Sandbox', 'shared-toolkit', 'Team Wiki',
];

describe('MCP instructions character cap', () => {
  beforeEach(() => {
    fakeList.mockReset();
    fakeList.mockReturnValue([]);
  });

  it('stays at or under the cap in the worst case: the most projects and panes, the longest names and URLs', () => {
    const longName = 'x'.repeat(200);
    openPanes(INSTRUCTIONS_PANE_LIST_CAP + 2, `http://localhost:3000/${'a'.repeat(300)}`);
    const projects = Array.from({ length: INSTRUCTIONS_PROJECT_LIST_CAP + 5 }, () => longName);

    const instructions = buildServerInstructions(resolverWith(projects));

    expect(instructions.length).toBeLessThanOrEqual(MCP_INSTRUCTIONS_CHARACTER_CAP);
    // The list ends in the pointer to the full list, so nothing reads as complete.
    expect(instructions).toMatch(/- \.\.\. and \d+ more\. Call kangentic_list_projects for the full list\.$/);
  });

  it('lists every project of a typical setup, 16 names with one pane open', () => {
    openPanes(1, 'http://localhost:5173/');

    const instructions = buildServerInstructions(resolverWith(TYPICAL_PROJECT_NAMES));

    expect(instructions.length).toBeLessThanOrEqual(MCP_INSTRUCTIONS_CHARACTER_CAP);
    for (const name of TYPICAL_PROJECT_NAMES) expect(instructions).toContain(`- ${name}`);
    expect(instructions).not.toContain('more. Call kangentic_list_projects');
  });

  it('reports an "and N more" count equal to the projects left out of the list', () => {
    const projects = Array.from({ length: INSTRUCTIONS_PROJECT_LIST_CAP + 5 }, (_, index) => `${String(index).padStart(2, '0')}-${'x'.repeat(190)}`);

    const instructions = buildServerInstructions(resolverWith(projects));

    const listText = instructions.slice(instructions.indexOf('Registered projects'));
    const projectLines = listText.split('\n').filter((line) => line.startsWith('- ') && !line.startsWith('- ... and'));
    const moreMatch = /- \.\.\. and (\d+) more\./.exec(listText);
    expect(moreMatch).not.toBeNull();
    expect(projectLines.length).toBeGreaterThan(0);
    expect(projectLines.length).toBeLessThan(projects.length);
    expect(Number(moreMatch?.[1])).toBe(projects.length - projectLines.length);
    // The names listed are the first ones, in order.
    expect(projectLines[0]).toContain('00-');
  });

  it('names only the first INSTRUCTIONS_PANE_LIST_CAP panes when more are open', () => {
    openPanes(INSTRUCTIONS_PANE_LIST_CAP + 2, 'http://localhost:5173/');

    const instructions = buildServerInstructions(resolverWith(['alpha']));

    const taskIdFor = (index: number): string => `0f3c2a91-7b44-4d1e-9a8c-${String(index).padStart(12, '0')}`;
    expect(instructions).toContain(`${INSTRUCTIONS_PANE_LIST_CAP + 2} Browser panes are currently open`);
    for (let index = 0; index < INSTRUCTIONS_PANE_LIST_CAP; index += 1) {
      expect(instructions).toContain(taskIdFor(index));
    }
    expect(instructions).not.toContain(taskIdFor(INSTRUCTIONS_PANE_LIST_CAP));
    expect(instructions).not.toContain(taskIdFor(INSTRUCTIONS_PANE_LIST_CAP + 1));
  });

  it('lists all 20 typical projects with five panes open', () => {
    openPanes(INSTRUCTIONS_PANE_LIST_CAP, 'http://localhost:5173/settings/profile');
    const names = [...TYPICAL_PROJECT_NAMES, 'Docs-Site', 'Mobile-Shell', 'Data-Pipeline', 'Design-System'];

    const instructions = buildServerInstructions(resolverWith(names));

    expect(instructions.length).toBeLessThanOrEqual(MCP_INSTRUCTIONS_CHARACTER_CAP);
    for (const name of names) expect(instructions).toContain(`- ${name}`);
  });
});
