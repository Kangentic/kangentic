/**
 * Unit tests for `reconcileMonitorRows` and `monitorRowsEqual` in
 * src/renderer/stores/monitor-rows.ts (the Agent Monitor's row-identity
 * reconciliation). The module is pure: a type-only import and no DOM, so no
 * mocks are needed.
 *
 * `MONITOR_CHANGED` crosses IPC by structured clone, so every incoming row is a
 * fresh object even when nothing changed. The store keeps the previous array and
 * objects when nothing moved, which is what lets zustand skip the notify.
 *
 * Covers:
 *   - an incoming snapshot that is a deep clone of the held rows returns the
 *     PREVIOUS array and keeps every row's object identity. The fixture's
 *     `track` puts its leaves at exactly MAX_COMPARE_DEPTH (row, track, steps,
 *     step, field and row, track, ends, todo, field are four levels down), so
 *     lowering the ceiling makes the clone read as changed on every push
 *   - a change at that depth (a step's state, a column end's name) is detected,
 *     replaces only the changed row, and leaves the other rows' objects alone
 *   - a reorder of equal rows is a change, with the objects reused
 *   - an added or removed row is a change
 */

import { describe, it, expect } from 'vitest';
import type {
  MonitorSessionRow,
  WorkflowColumnEnd,
  WorkflowRouteStep,
} from '../../src/shared/types';
import { EventType } from '../../src/shared/types';
import { monitorRowsEqual, reconcileMonitorRows } from '../../src/renderer/stores/monitor-rows';

function makeStep(
  swimlaneId: string,
  name: string,
  state: WorkflowRouteStep['state'],
  finishedAt: string | null,
): WorkflowRouteStep {
  return { swimlaneId, name, color: '#3b82f6', icon: 'circle', state, finishedAt };
}

function makeColumnEnd(swimlaneId: string, name: string): WorkflowColumnEnd {
  return { swimlaneId, name, color: '#6b7280', icon: 'circle' };
}

/**
 * A full row: every field MonitorSessionRow declares, with the workflow and the
 * track populated. The leaves under `track` are non-null scalars so a lowered
 * ceiling cannot hide behind a null that compares equal by identity.
 */
function makeRow(sessionId: string, overrides: Partial<MonitorSessionRow> = {}): MonitorSessionRow {
  return {
    sessionId,
    projectId: 'project-1',
    projectName: 'Project One',
    taskId: `task-for-${sessionId}`,
    taskTitle: `Task for ${sessionId}`,
    outputPeek: ['running tests', 'all green'],
    description: 'Fix the PTY capture race.',
    displayId: 142,
    columnName: 'Executing',
    commandTerminalBranch: null,
    automationsDisabled: false,
    workflow: { id: 'workflow-1', title: 'Harden the API', colorSlot: 3 },
    track: {
      steps: [
        makeStep('swimlane-planning', 'Planning', 'done', '2026-01-01T01:00:00.000Z'),
        makeStep('swimlane-executing', 'Executing', 'current', null),
        makeStep('swimlane-review', 'Code Review', 'ahead', null),
      ],
      ends: {
        todo: makeColumnEnd('swimlane-todo', 'To Do'),
        done: makeColumnEnd('swimlane-done', 'Done'),
      },
      place: 'working',
    },
    modelReported: true,
    browserRunning: false,
    labels: ['bug', 'pty'],
    prUrl: 'https://github.com/owner/repo/pull/7',
    prNumber: 7,
    prState: 'open',
    prMergeReadiness: 'ready',
    agentName: 'claude',
    modelDisplayName: 'Opus 5',
    effort: 'high',
    permissionMode: 'default',
    startedAt: '2026-01-01T00:00:00.000Z',
    exitedAt: null,
    status: 'running',
    activity: 'thinking',
    activityReason: null,
    lastEvent: { type: EventType.ToolStart, detail: 'Reading file.ts' },
    contextPercent: 42,
    isolated: false,
    isCommandTerminal: false,
    ...overrides,
  };
}

/** The rows the store already holds: three distinct sessions. */
function makePreviousRows(): MonitorSessionRow[] {
  return [makeRow('session-1'), makeRow('session-2'), makeRow('session-3')];
}

describe('reconcileMonitorRows', () => {
  it('returns the previous array and every previous row object for a deep clone of the same snapshot', () => {
    // The red-green pin for MAX_COMPARE_DEPTH. A clone shares no object with the
    // held rows, so equality can only come from the structural compare reaching
    // the scalar leaves under track.steps[n] and track.ends.todo (depth 4).
    // With the ceiling at 3 the step and end OBJECTS fail their identity check
    // at the ceiling, every row reads as changed, and the store writes every push.
    const previous = makePreviousRows();
    const incoming = structuredClone(previous);
    for (let index = 0; index < previous.length; index += 1) {
      expect(incoming[index]).not.toBe(previous[index]);
    }

    const reconciled = reconcileMonitorRows(previous, incoming);

    expect(reconciled).toBe(previous);
    for (let index = 0; index < previous.length; index += 1) {
      expect(reconciled[index]).toBe(previous[index]);
    }
  });

  it('replaces only the row whose track step state changed, keeping the other rows\' objects', () => {
    const previous = makePreviousRows();
    const incoming = structuredClone(previous);
    // track.steps[1].state is a scalar at depth 4: the row moved on a step.
    incoming[1].track!.steps[1].state = 'done';

    const reconciled = reconcileMonitorRows(previous, incoming);

    expect(reconciled).not.toBe(previous);
    expect(reconciled).toHaveLength(3);
    expect(reconciled[1]).toBe(incoming[1]);
    expect(reconciled[1].track!.steps[1].state).toBe('done');
    expect(reconciled[0]).toBe(previous[0]);
    expect(reconciled[0]).not.toBe(incoming[0]);
    expect(reconciled[2]).toBe(previous[2]);
    expect(reconciled[2]).not.toBe(incoming[2]);
  });

  it('counts a changed track end name as a change, keeping the other rows\' objects', () => {
    const previous = makePreviousRows();
    const incoming = structuredClone(previous);
    // track.ends.todo.name is a scalar at depth 4: the board renamed its To Do column.
    incoming[0].track!.ends!.todo!.name = 'Backlog';

    const reconciled = reconcileMonitorRows(previous, incoming);

    expect(reconciled).not.toBe(previous);
    expect(reconciled[0]).toBe(incoming[0]);
    expect(reconciled[0].track!.ends!.todo!.name).toBe('Backlog');
    expect(reconciled[1]).toBe(previous[1]);
    expect(reconciled[1]).not.toBe(incoming[1]);
    expect(reconciled[2]).toBe(previous[2]);
    expect(reconciled[2]).not.toBe(incoming[2]);
  });

  it('returns a new array of the reused objects when two equal rows swap positions', () => {
    const previous = makePreviousRows();
    const incoming = structuredClone(previous);
    [incoming[0], incoming[1]] = [incoming[1], incoming[0]];

    const reconciled = reconcileMonitorRows(previous, incoming);

    // Same rows, same values, different order: consumers that read the array in
    // order (grouping, virtualizer keys) must be told, so the array is new.
    expect(reconciled).not.toBe(previous);
    expect(reconciled.map((row) => row.sessionId)).toEqual(['session-2', 'session-1', 'session-3']);
    expect(reconciled[0]).toBe(previous[1]);
    expect(reconciled[1]).toBe(previous[0]);
    expect(reconciled[2]).toBe(previous[2]);
  });

  it('returns a new array holding the incoming object for a session the store did not hold', () => {
    const previous = makePreviousRows();
    const incoming = structuredClone(previous);
    incoming.push(makeRow('session-4'));

    const reconciled = reconcileMonitorRows(previous, incoming);

    expect(reconciled).not.toBe(previous);
    expect(reconciled).toHaveLength(4);
    expect(reconciled[3]).toBe(incoming[3]);
    expect(reconciled[0]).toBe(previous[0]);
    expect(reconciled[1]).toBe(previous[1]);
    expect(reconciled[2]).toBe(previous[2]);
  });

  it('returns a new array when a session is gone, even though every surviving row is reused', () => {
    const previous = makePreviousRows();
    const incoming = structuredClone(previous).slice(0, 2);

    const reconciled = reconcileMonitorRows(previous, incoming);

    expect(reconciled).not.toBe(previous);
    expect(reconciled.map((row) => row.sessionId)).toEqual(['session-1', 'session-2']);
    expect(reconciled[0]).toBe(previous[0]);
    expect(reconciled[1]).toBe(previous[1]);
  });
});

describe('monitorRowsEqual', () => {
  it('reads a deep clone as equal and a changed depth-4 leaf as different', () => {
    const row = makeRow('session-1');

    expect(monitorRowsEqual(row, structuredClone(row))).toBe(true);

    const withChangedStep = structuredClone(row);
    withChangedStep.track!.steps[2].name = 'Review';
    expect(monitorRowsEqual(row, withChangedStep)).toBe(false);
  });
});
