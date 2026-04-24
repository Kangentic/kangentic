import { describe, it, expect, vi } from 'vitest';

import {
  buildServerInstructions,
  INSTRUCTIONS_PROJECT_LIST_CAP,
} from '../../src/main/agent/mcp-http/server-instructions';
import type { RequestResolver } from '../../src/main/agent/mcp-http/project-resolver';

type ProjectSummary = ReturnType<RequestResolver['listProjects']>[number];

function makeProject(overrides: Partial<ProjectSummary>): ProjectSummary {
  return {
    id: '00000000-0000-4000-8000-000000000000',
    name: 'Example',
    path: '/projects/example',
    lastOpened: '2026-01-01T00:00:00Z',
    isActive: false,
    ...overrides,
  };
}

function makeResolver(projects: ProjectSummary[]): RequestResolver {
  return {
    listProjects: vi.fn(() => projects),
  } as unknown as RequestResolver;
}

describe('buildServerInstructions', () => {
  it('always includes the project routing rule regardless of project list', () => {
    const instructions = buildServerInstructions(makeResolver([]));
    expect(instructions).toContain('PROJECT ROUTING RULE');
    expect(instructions).toContain('`project`');
    expect(instructions.toLowerCase()).toContain('active default');
  });

  it('names the active project explicitly when one is present', () => {
    const instructions = buildServerInstructions(
      makeResolver([
        makeProject({ id: 'a', name: 'ActiveOne', isActive: true }),
        makeProject({ id: 'b', name: 'Other' }),
      ]),
    );

    expect(instructions).toContain('Active project');
    expect(instructions).toContain('"ActiveOne"');
  });

  it('falls back to a "no active project" message when no project is marked active', () => {
    const instructions = buildServerInstructions(
      makeResolver([makeProject({ id: 'a', name: 'Lonely', isActive: false })]),
    );
    expect(instructions).toContain('No active project');
  });

  it('lists every registered project name when under the cap, and marks the active one', () => {
    const instructions = buildServerInstructions(
      makeResolver([
        makeProject({ id: 'a', name: 'ActiveOne', isActive: true }),
        makeProject({ id: 'b', name: 'Kangentic' }),
        makeProject({ id: 'c', name: 'OCC-RBDMS-OKIES' }),
      ]),
    );

    expect(instructions).toContain('Registered projects');
    expect(instructions).toContain('ActiveOne [active]');
    expect(instructions).toContain('Kangentic');
    expect(instructions).toContain('OCC-RBDMS-OKIES');
    // Only the active project should carry the [active] tag.
    const activeTagMatches = instructions.match(/\[active\]/g) ?? [];
    expect(activeTagMatches).toHaveLength(1);
  });

  it('truncates the project list at the cap and tells the agent to call kangentic_list_projects for the rest', () => {
    const total = INSTRUCTIONS_PROJECT_LIST_CAP + 5;
    const projects: ProjectSummary[] = [];
    for (let index = 0; index < total; index++) {
      projects.push(
        makeProject({
          id: `id-${index}`,
          name: `Project-${index}`,
          isActive: index === 0,
        }),
      );
    }

    const instructions = buildServerInstructions(makeResolver(projects));

    // First N project names are listed.
    for (let index = 0; index < INSTRUCTIONS_PROJECT_LIST_CAP; index++) {
      expect(instructions).toContain(`Project-${index}`);
    }
    // Overflow names are NOT listed.
    expect(instructions).not.toContain(`Project-${INSTRUCTIONS_PROJECT_LIST_CAP}`);
    // Truncation hint + pointer to kangentic_list_projects.
    expect(instructions).toContain(`and ${total - INSTRUCTIONS_PROJECT_LIST_CAP} more`);
    expect(instructions).toContain('kangentic_list_projects');
  });

  it('omits the project list section entirely when no projects are registered but still references kangentic_list_projects', () => {
    const instructions = buildServerInstructions(makeResolver([]));
    expect(instructions).not.toContain('Registered projects');
    expect(instructions).toContain('kangentic_list_projects');
  });

  it('calls resolver.listProjects() exactly once per build', () => {
    const resolver = makeResolver([
      makeProject({ id: 'a', name: 'ActiveOne', isActive: true }),
    ]);

    buildServerInstructions(resolver);

    expect(resolver.listProjects).toHaveBeenCalledOnce();
  });

  it('sanitises embedded project names so newlines and brackets cannot break the bulleted list', () => {
    const instructions = buildServerInstructions(
      makeResolver([
        makeProject({ id: 'a', name: 'Clean Active', isActive: true }),
        // Name with an embedded newline + ] that would otherwise split
        // the list entry across multiple visual lines / confuse parsers.
        makeProject({ id: 'b', name: 'Broken]\nName' }),
      ]),
    );

    expect(instructions).not.toContain('Broken]\nName');
    expect(instructions).toContain('- Broken  Name');
    // The registered-projects block still has exactly one line per project
    // entry (active + sanitised second entry + no stray fragment).
    const listLines = instructions
      .split('\n')
      .filter((line) => line.startsWith('- '));
    expect(listLines).toHaveLength(2);
  });

  it('sanitises a CRLF-containing name when that project is the active one (dirty-name active-line path)', () => {
    const instructions = buildServerInstructions(
      makeResolver([
        // The active project itself has a CRLF in its name - exercises the
        // sanitizeProjectName call on the activeLine branch specifically.
        makeProject({ id: 'a', name: 'Active\r\nProject', isActive: true }),
        makeProject({ id: 'b', name: 'Other' }),
      ]),
    );

    // The active-line prefix must show the sanitised form with spaces in place
    // of both the \r and the \n.
    expect(instructions).toContain('"Active  Project"');
    expect(instructions).not.toContain('Active\r\nProject');
    expect(instructions).not.toContain('\r');

    // The same project also appears in the list-entry path - the [active] tag
    // must attach to the sanitised name.
    expect(instructions).toContain('Active  Project [active]');
  });

  it('truncates a pathologically long project name before embedding', () => {
    const longName = 'x'.repeat(200);
    const instructions = buildServerInstructions(
      makeResolver([
        makeProject({ id: 'a', name: 'Active', isActive: true }),
        makeProject({ id: 'b', name: longName }),
      ]),
    );

    // sanitizeProjectName caps at 57 + '...' when > 60 chars.
    expect(instructions).toContain(`${'x'.repeat(57)}...`);
    expect(instructions).not.toContain('x'.repeat(200));
  });
});
