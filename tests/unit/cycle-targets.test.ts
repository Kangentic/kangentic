/**
 * The orders the cycle keys walk (GitHub #176): `src/renderer/utils/cycle-targets.ts`
 * and the sidebar order it shares with `useSidebarDragDrop`.
 *
 * Tier: Unit (vitest, no browser, no Electron).
 */
import { describe, it, expect } from 'vitest';
import type { Project, ProjectGroup, Session } from '../../src/shared/types';
import {
  buildTerminalCycleList,
  cycleIndex,
  cycleStep,
  projectCycleOrder,
  type CycleTarget,
} from '../../src/renderer/utils/cycle-targets';
import {
  groupSidebarProjects,
  sidebarVisualOrder,
} from '../../src/renderer/components/sidebar/project-sidebar/sidebar-project-order';

function makeProject(id: string, overrides: Partial<Project> = {}): Project {
  return {
    id,
    name: id,
    path: `/mock/${id}`,
    github_url: null,
    default_agent: 'claude',
    default_model: null,
    default_effort: null,
    group_id: null,
    position: 0,
    last_opened: '2026-10-30T00:00:00.000Z',
    created_at: '2026-10-30T00:00:00.000Z',
    ...overrides,
  };
}

function makeGroup(id: string, position: number, isCollapsed = false): ProjectGroup {
  return { id, name: id, position, is_collapsed: isCollapsed };
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess-default',
    taskId: 'task-default',
    projectId: 'proj-a',
    pid: 1000,
    status: 'running',
    shell: 'bash',
    cwd: '/tmp',
    startedAt: '2026-10-30T00:00:00.000Z',
    exitCode: null,
    resuming: false,
    transient: false,
    ...overrides,
  };
}

function makeCommandTerminal(id: string, projectId: string, slot: string, overrides: Partial<Session> = {}): Session {
  return makeSession({ id, taskId: '', projectId, transient: true, commandTerminalSlot: slot, ...overrides });
}

const ids = (targets: readonly CycleTarget[]): string[] => targets.map((target) => target.sessionId);
const projectIdsOf = (projects: readonly Project[]): string[] => projects.map((project) => project.id);

describe('cycleIndex', () => {
  it('steps forward and back, wrapping at both ends', () => {
    expect(cycleIndex(3, 0, 1)).toBe(1);
    expect(cycleIndex(3, 2, 1)).toBe(0);
    expect(cycleIndex(3, 0, -1)).toBe(2);
    expect(cycleIndex(3, 1, -1)).toBe(0);
  });

  it('from nothing current, next is the first item and previous the last', () => {
    expect(cycleIndex(3, -1, 1)).toBe(0);
    expect(cycleIndex(3, -1, -1)).toBe(2);
  });

  it('returns -1 for an empty list', () => {
    expect(cycleIndex(0, -1, 1)).toBe(-1);
    expect(cycleIndex(0, 0, -1)).toBe(-1);
  });
});

describe('sidebar project order', () => {
  it('keeps store order when there are no groups', () => {
    const projects = [makeProject('b', { position: 5 }), makeProject('a', { position: 1 })];
    expect(projectIdsOf(sidebarVisualOrder(groupSidebarProjects(projects, [])))).toEqual(['b', 'a']);
  });

  it('lists groups by position, each by project position, then the ungrouped projects', () => {
    const projects = [
      makeProject('loose'),
      makeProject('g2-first', { group_id: 'g2', position: 0 }),
      makeProject('g1-second', { group_id: 'g1', position: 2 }),
      makeProject('g1-first', { group_id: 'g1', position: 1 }),
    ];
    const groups = [makeGroup('g2', 1), makeGroup('g1', 0)];
    expect(projectIdsOf(sidebarVisualOrder(groupSidebarProjects(projects, groups)))).toEqual([
      'g1-first', 'g1-second', 'g2-first', 'loose',
    ]);
  });

  it('keeps a collapsed group in the order', () => {
    const projects = [makeProject('hidden', { group_id: 'g1' }), makeProject('loose')];
    const groups = [makeGroup('g1', 0, true)];
    expect(projectIdsOf(projectCycleOrder(projects, groups))).toEqual(['hidden', 'loose']);
  });

  it('appends a project whose group was deleted, so the cycle still reaches it', () => {
    const projects = [makeProject('orphan', { group_id: 'gone' }), makeProject('grouped', { group_id: 'g1' })];
    const groups = [makeGroup('g1', 0)];
    // The sidebar shows the orphan nowhere...
    expect(projectIdsOf(sidebarVisualOrder(groupSidebarProjects(projects, groups)))).toEqual(['grouped']);
    // ...but the cycle does not lose it.
    expect(projectIdsOf(projectCycleOrder(projects, groups))).toEqual(['grouped', 'orphan']);
  });
});

describe('buildTerminalCycleList', () => {
  const sessions: Session[] = [
    makeCommandTerminal('cmd-a2', 'proj-a', 'slot-2'),
    makeSession({ id: 'agent-a1', taskId: 'task-a1' }),
    makeSession({ id: 'agent-b1', taskId: 'task-b1', projectId: 'proj-b' }),
    makeCommandTerminal('cmd-a10', 'proj-a', 'slot-10'),
    makeSession({ id: 'agent-a2', taskId: 'task-a2' }),
    makeCommandTerminal('cmd-a1', 'proj-a', 'slot-1'),
    makeSession({ id: 'agent-a-paused', taskId: 'task-a3', status: 'suspended' }),
    makeSession({ id: 'workflow-agent', taskId: '', transient: true, workflowId: 'wf-1' }),
    makeCommandTerminal('cmd-a-exited', 'proj-a', 'slot-3', { status: 'exited' }),
  ];

  it('lists running agents in replica order, then Command Terminal terminals by slot number', () => {
    const list = buildTerminalCycleList({
      projectIds: ['proj-a'],
      sessions,
      remoteDetailTaskIds: [],
      commandTerminalsElsewhere: new Set(),
    });
    expect(ids(list)).toEqual(['agent-a1', 'agent-a2', 'cmd-a1', 'cmd-a2', 'cmd-a10']);
    expect(list[0]).toEqual({ kind: 'agent', projectId: 'proj-a', sessionId: 'agent-a1', taskId: 'task-a1' });
    expect(list[2]).toEqual({ kind: 'command', projectId: 'proj-a', sessionId: 'cmd-a1', slot: 'slot-1' });
  });

  it('walks projects in the order given', () => {
    const list = buildTerminalCycleList({
      projectIds: ['proj-b', 'proj-a'],
      sessions,
      remoteDetailTaskIds: [],
      commandTerminalsElsewhere: new Set(),
    });
    expect(ids(list)).toEqual(['agent-b1', 'agent-a1', 'agent-a2', 'cmd-a1', 'cmd-a2', 'cmd-a10']);
  });

  it('skips a Command Terminal session that carries no slot', () => {
    // A terminal with no slot has nothing for the cycle to land on, so it is left out
    // rather than listed as a target with an undefined slot. The type allows both
    // undefined and null.
    const slotless: Session[] = [
      makeSession({ id: 'agent-a1', taskId: 'task-a1' }),
      makeCommandTerminal('cmd-slot-1', 'proj-a', 'slot-1'),
      makeSession({ id: 'cmd-undefined-slot', taskId: '', transient: true }),
      makeSession({ id: 'cmd-null-slot', taskId: '', transient: true, commandTerminalSlot: null }),
    ];
    const list = buildTerminalCycleList({
      projectIds: ['proj-a'],
      sessions: slotless,
      remoteDetailTaskIds: [],
      commandTerminalsElsewhere: new Set(),
    });
    expect(ids(list)).toEqual(['agent-a1', 'cmd-slot-1']);
    for (const target of list) {
      if (target.kind === 'command') expect(typeof target.slot).toBe('string');
    }
  });

  it('skips an agent the detached Agent Monitor hosts', () => {
    const list = buildTerminalCycleList({
      projectIds: ['proj-a'],
      sessions,
      remoteDetailTaskIds: ['task-a1'],
      commandTerminalsElsewhere: new Set(),
    });
    expect(ids(list)).toEqual(['agent-a2', 'cmd-a1', 'cmd-a2', 'cmd-a10']);
  });

  it("skips a project's Command Terminal terminals while they are in a window of their own", () => {
    const list = buildTerminalCycleList({
      projectIds: ['proj-a'],
      sessions,
      remoteDetailTaskIds: [],
      commandTerminalsElsewhere: new Set(['proj-a']),
    });
    expect(ids(list)).toEqual(['agent-a1', 'agent-a2']);
  });
});

describe('cycleStep', () => {
  const list: CycleTarget[] = [
    { kind: 'agent', projectId: 'proj-a', sessionId: 'a1', taskId: 't-a1' },
    { kind: 'command', projectId: 'proj-a', sessionId: 'a2', slot: 'slot-1' },
    { kind: 'agent', projectId: 'proj-c', sessionId: 'c1', taskId: 't-c1' },
  ];
  const projectIds = ['proj-a', 'proj-b', 'proj-c'];

  it('steps from the current terminal, wrapping', () => {
    expect(cycleStep({ list, currentSessionId: 'a2', currentProjectId: 'proj-a', projectIds, direction: 1 })).toBe(2);
    expect(cycleStep({ list, currentSessionId: 'c1', currentProjectId: 'proj-c', projectIds, direction: 1 })).toBe(0);
    expect(cycleStep({ list, currentSessionId: 'a1', currentProjectId: 'proj-a', projectIds, direction: -1 })).toBe(2);
  });

  it("with no current terminal, starts in the current project's own terminals", () => {
    expect(cycleStep({ list, currentSessionId: null, currentProjectId: 'proj-a', projectIds, direction: 1 })).toBe(0);
    expect(cycleStep({ list, currentSessionId: null, currentProjectId: 'proj-a', projectIds, direction: -1 })).toBe(1);
  });

  it('from a project with no terminals, next goes forward and previous back in project order', () => {
    expect(cycleStep({ list, currentSessionId: null, currentProjectId: 'proj-b', projectIds, direction: 1 })).toBe(2);
    expect(cycleStep({ list, currentSessionId: null, currentProjectId: 'proj-b', projectIds, direction: -1 })).toBe(1);
  });

  it('wraps when nothing lies ahead of or behind the current project', () => {
    const tail = ['proj-a', 'proj-c', 'proj-z'];
    expect(cycleStep({ list, currentSessionId: null, currentProjectId: 'proj-z', projectIds: tail, direction: 1 })).toBe(0);
    const head = ['proj-0', 'proj-a', 'proj-c'];
    expect(cycleStep({ list, currentSessionId: null, currentProjectId: 'proj-0', projectIds: head, direction: -1 })).toBe(2);
  });

  it.each([
    ['no current project', null],
    ['a current project the order does not list', 'proj-unlisted'],
  ])('with %s, next lands on the first terminal and previous on the last', (_description, currentProjectId) => {
    expect(cycleStep({ list, currentSessionId: null, currentProjectId, projectIds, direction: 1 })).toBe(0);
    expect(cycleStep({ list, currentSessionId: null, currentProjectId, projectIds, direction: -1 })).toBe(list.length - 1);
  });

  it('treats a current session that is not in the list as no current terminal', () => {
    expect(cycleStep({ list, currentSessionId: 'gone', currentProjectId: 'proj-a', projectIds, direction: 1 })).toBe(0);
  });

  it('returns -1 for an empty list', () => {
    expect(cycleStep({ list: [], currentSessionId: null, currentProjectId: 'proj-a', projectIds, direction: 1 })).toBe(-1);
  });
});
