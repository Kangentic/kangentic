import { describe, it, expect, vi } from 'vitest';

// handler-helpers -> project-resolver -> mcp-project-context pulls in
// Electron bindings transitively. Stub it before importing so the unit
// scope stays pure. detectCrossProjectMention only touches
// resolver.listProjects(), so the stub never actually runs here, but the
// mock keeps the import graph Electron-free.
const { buildCommandContextForProject } = vi.hoisted(() => ({
  buildCommandContextForProject: vi.fn(),
}));

vi.mock('../../src/main/agent/mcp-project-context', () => ({
  buildCommandContextForProject,
}));

import { RequestResolver } from '../../src/main/agent/mcp-http/project-resolver';
import { detectCrossProjectMention } from '../../src/main/agent/mcp-http/handler-helpers';
import type { IpcContext } from '../../src/main/ipc/ipc-context';
import type { CommandContext } from '../../src/main/agent/commands/types';
import type { Project } from '../../src/shared/types';

const ACTIVE_ID = '11111111-1111-4111-8111-111111111111';

function makeProject(overrides: Partial<Project>): Project {
  return {
    id: '00000000-0000-4000-8000-000000000000',
    name: 'Example',
    path: '/projects/example',
    github_url: null,
    default_agent: 'claude',
    group_id: null,
    position: 0,
    last_opened: '2026-01-01T00:00:00Z',
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeContext(): CommandContext {
  return {
    getProjectDb: () => ({}) as never,
    getProjectPath: () => '/projects/active',
    onTaskCreated: vi.fn(),
    onTaskUpdated: vi.fn(),
    onTaskDeleted: vi.fn(),
    onTaskMove: vi.fn(),
    onTasksReordered: vi.fn(),
    onSwimlaneUpdated: vi.fn(),
    onSwimlaneDeleted: vi.fn(),
    onBacklogChanged: vi.fn(),
    onLabelColorsChanged: vi.fn(),
  };
}

// Active project is "kangentic" so we can prove the scan excludes the
// active name and treats "kangentic.com" as a distinct token.
function makeResolver(extraProjects: Array<Partial<Project>>): RequestResolver {
  const projects = [
    makeProject({ id: ACTIVE_ID, name: 'kangentic' }),
    ...extraProjects.map((overrides, index) =>
      makeProject({ id: `2222222${index}-2222-4222-8222-222222222222`, ...overrides }),
    ),
  ];
  const ipcContext = { projectRepo: { list: () => projects } } as unknown as IpcContext;
  return new RequestResolver({
    ipcContext,
    defaultContext: makeContext(),
    defaultProjectId: ACTIVE_ID,
    defaultProjectName: 'kangentic',
  });
}

describe('detectCrossProjectMention', () => {
  it('fires on a distinct dotted name even when it shares a prefix with the active project', () => {
    const resolver = makeResolver([{ name: 'kangentic.com' }]);
    expect(detectCrossProjectMention(resolver, 'update the kangentic.com landing page')).toEqual([
      'kangentic.com',
    ]);
  });

  it('does not fire when only the active project name appears', () => {
    const resolver = makeResolver([{ name: 'kangentic.com' }]);
    // "kangentic" is the active project (excluded) and the bare word does
    // not satisfy the "kangentic.com" token boundary, so nothing matches.
    expect(detectCrossProjectMention(resolver, 'work in kangentic on the bug')).toEqual([]);
  });

  it('does not fire when no registered project is mentioned', () => {
    const resolver = makeResolver([{ name: 'TWC-Website' }]);
    expect(detectCrossProjectMention(resolver, 'fix the broken login form')).toEqual([]);
  });

  it('matches multi-word names as an exact phrase', () => {
    const resolver = makeResolver([{ name: 'Agent Testing' }]);
    expect(detectCrossProjectMention(resolver, 'file this under Agent Testing please')).toEqual([
      'Agent Testing',
    ]);
  });

  it('escapes regex metacharacters and matches case-insensitively', () => {
    const resolver = makeResolver([{ name: 'OCC-RBDMS-OKIES' }]);
    expect(detectCrossProjectMention(resolver, 'add a bug to the occ-rbdms-okies board')).toEqual([
      'OCC-RBDMS-OKIES',
    ]);
  });

  it('treats a literal dot as a dot, not a wildcard', () => {
    const resolver = makeResolver([{ name: 'kangentic.com' }]);
    // If the dot were a wildcard, "kangenticXcom" would match. It must not.
    expect(detectCrossProjectMention(resolver, 'see kangenticXcom for details')).toEqual([]);
  });

  it('does not match a name embedded inside a larger word', () => {
    const resolver = makeResolver([{ name: 'Sydor' }]);
    expect(detectCrossProjectMention(resolver, 'the presydored release notes')).toEqual([]);
  });

  it('skips names shorter than the minimum match length', () => {
    const resolver = makeResolver([{ name: 'QA' }]);
    expect(detectCrossProjectMention(resolver, 'run the QA suite before shipping')).toEqual([]);
  });

  it('returns each matched project once even when mentioned repeatedly', () => {
    const resolver = makeResolver([{ name: 'Agent Testing' }, { name: 'TWC-Website' }]);
    const result = detectCrossProjectMention(
      resolver,
      'move Agent Testing work to TWC-Website and keep Agent Testing in sync',
    );
    expect(result).toEqual(['Agent Testing', 'TWC-Website']);
  });
});
