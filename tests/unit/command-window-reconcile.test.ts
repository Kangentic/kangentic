import { describe, it, expect } from 'vitest';
import {
  planCommandWindowReconciliation,
  type CommandWindowSlotRef,
  type CommandWindowTransientEntry,
  type CommandWindowSessionRef,
} from '../../src/renderer/components/command-bar/command-window-reconcile';

const PROJECT_A = 'project-a';
const PROJECT_B = 'project-b';
const MAX_WINDOWS = 4;

function windowRef(slot: string): CommandWindowSlotRef {
  return { windowId: `win-${slot}`, slot };
}

function transientMap(entries: CommandWindowTransientEntry[]): Record<string, CommandWindowTransientEntry> {
  const map: Record<string, CommandWindowTransientEntry> = {};
  for (const entry of entries) map[`${entry.projectId}::${entry.slot}`] = entry;
  return map;
}

function runningSession(id: string): CommandWindowSessionRef {
  return { id, status: 'running' };
}

describe('planCommandWindowReconciliation', () => {
  it('keeps only the lowest-slot window when the project has no live sessions', () => {
    const plan = planCommandWindowReconciliation({
      windows: [windowRef('slot-1'), windowRef('slot-2')],
      transientSessions: {},
      sessions: [],
      projectId: PROJECT_A,
      maxWindows: MAX_WINDOWS,
    });
    expect(plan.closeWindowIds).toEqual(['win-slot-2']);
    expect(plan.openSlots).toEqual([]);
  });

  it('keeps the lowest EXISTING slot when slot-1 has no window', () => {
    const plan = planCommandWindowReconciliation({
      windows: [windowRef('slot-2'), windowRef('slot-3')],
      transientSessions: {},
      sessions: [],
      projectId: PROJECT_A,
      maxWindows: MAX_WINDOWS,
    });
    expect(plan.closeWindowIds).toEqual(['win-slot-3']);
    expect(plan.openSlots).toEqual([]);
  });

  it('opens windows for live sessions that lack one, ascending', () => {
    const plan = planCommandWindowReconciliation({
      windows: [windowRef('slot-1')],
      transientSessions: transientMap([
        { projectId: PROJECT_A, slot: 'slot-1', sessionId: 'sess-1' },
        { projectId: PROJECT_A, slot: 'slot-3', sessionId: 'sess-3' },
        { projectId: PROJECT_A, slot: 'slot-2', sessionId: 'sess-2' },
      ]),
      sessions: [runningSession('sess-1'), runningSession('sess-2'), runningSession('sess-3')],
      projectId: PROJECT_A,
      maxWindows: MAX_WINDOWS,
    });
    expect(plan.closeWindowIds).toEqual([]);
    expect(plan.openSlots).toEqual(['slot-2', 'slot-3']);
  });

  it('closes a window whose slot has no live session while opening the live slot', () => {
    const plan = planCommandWindowReconciliation({
      windows: [windowRef('slot-1')],
      transientSessions: transientMap([{ projectId: PROJECT_A, slot: 'slot-2', sessionId: 'sess-2' }]),
      sessions: [runningSession('sess-2')],
      projectId: PROJECT_A,
      maxWindows: MAX_WINDOWS,
    });
    expect(plan.closeWindowIds).toEqual(['win-slot-1']);
    expect(plan.openSlots).toEqual(['slot-2']);
  });

  it('treats a map entry without a running session row as dead (exited or missing)', () => {
    const exited = planCommandWindowReconciliation({
      windows: [windowRef('slot-1'), windowRef('slot-2')],
      transientSessions: transientMap([{ projectId: PROJECT_A, slot: 'slot-2', sessionId: 'sess-2' }]),
      sessions: [{ id: 'sess-2', status: 'exited' }],
      projectId: PROJECT_A,
      maxWindows: MAX_WINDOWS,
    });
    // No live session -> keep only the lowest-slot window.
    expect(exited.closeWindowIds).toEqual(['win-slot-2']);
    expect(exited.openSlots).toEqual([]);

    const missingRow = planCommandWindowReconciliation({
      windows: [windowRef('slot-1'), windowRef('slot-2')],
      transientSessions: transientMap([{ projectId: PROJECT_A, slot: 'slot-2', sessionId: 'sess-2' }]),
      sessions: [],
      projectId: PROJECT_A,
      maxWindows: MAX_WINDOWS,
    });
    expect(missingRow.closeWindowIds).toEqual(['win-slot-2']);
    expect(missingRow.openSlots).toEqual([]);
  });

  it("ignores other projects' transient entries", () => {
    const plan = planCommandWindowReconciliation({
      windows: [windowRef('slot-1'), windowRef('slot-2')],
      transientSessions: transientMap([
        { projectId: PROJECT_A, slot: 'slot-1', sessionId: 'sess-a1' },
        { projectId: PROJECT_B, slot: 'slot-2', sessionId: 'sess-b2' },
      ]),
      sessions: [runningSession('sess-a1'), runningSession('sess-b2')],
      projectId: PROJECT_A,
      maxWindows: MAX_WINDOWS,
    });
    // Only slot-1 is live for project A; slot-2 belongs to project B and is closed.
    expect(plan.closeWindowIds).toEqual(['win-slot-2']);
    expect(plan.openSlots).toEqual([]);
  });

  it('returns an empty plan when windows already match live sessions (HMR no-op)', () => {
    const plan = planCommandWindowReconciliation({
      windows: [windowRef('slot-1'), windowRef('slot-2')],
      transientSessions: transientMap([
        { projectId: PROJECT_A, slot: 'slot-1', sessionId: 'sess-1' },
        { projectId: PROJECT_A, slot: 'slot-2', sessionId: 'sess-2' },
      ]),
      sessions: [runningSession('sess-1'), runningSession('sess-2')],
      projectId: PROJECT_A,
      maxWindows: MAX_WINDOWS,
    });
    expect(plan.closeWindowIds).toEqual([]);
    expect(plan.openSlots).toEqual([]);
  });

  it('opens all live slots when no windows exist (hard reload without a blob)', () => {
    const plan = planCommandWindowReconciliation({
      windows: [],
      transientSessions: transientMap([
        { projectId: PROJECT_A, slot: 'slot-1', sessionId: 'sess-1' },
        { projectId: PROJECT_A, slot: 'slot-2', sessionId: 'sess-2' },
      ]),
      sessions: [runningSession('sess-1'), runningSession('sess-2')],
      projectId: PROJECT_A,
      maxWindows: MAX_WINDOWS,
    });
    expect(plan.closeWindowIds).toEqual([]);
    expect(plan.openSlots).toEqual(['slot-1', 'slot-2']);
  });

  it('returns a fully empty plan when there are no windows and no live sessions', () => {
    // The empty store with no survivors: the caller opens the single default window itself.
    const plan = planCommandWindowReconciliation({
      windows: [],
      transientSessions: {},
      sessions: [],
      projectId: PROJECT_A,
      maxWindows: MAX_WINDOWS,
    });
    expect(plan.closeWindowIds).toEqual([]);
    expect(plan.openSlots).toEqual([]);
  });

  it('never plans more windows than maxWindows', () => {
    // Defensive: a live slot beyond the cap must not be planned open.
    const plan = planCommandWindowReconciliation({
      windows: [windowRef('slot-1')],
      transientSessions: transientMap([
        { projectId: PROJECT_A, slot: 'slot-1', sessionId: 'sess-1' },
        { projectId: PROJECT_A, slot: 'slot-2', sessionId: 'sess-2' },
        { projectId: PROJECT_A, slot: 'slot-3', sessionId: 'sess-3' },
      ]),
      sessions: [runningSession('sess-1'), runningSession('sess-2'), runningSession('sess-3')],
      projectId: PROJECT_A,
      maxWindows: 2,
    });
    // 1 kept (slot-1) + at most 1 opened = 2 total.
    expect(plan.openSlots).toEqual(['slot-2']);
  });
});
