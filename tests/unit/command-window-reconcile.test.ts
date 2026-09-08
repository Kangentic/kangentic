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

/** A running Command Terminal PTY as main reports it, carrying the slot it was
 *  spawned under. This is what lets the planner see a live terminal the renderer's
 *  pairing map has lost track of. */
function runningTerminal(id: string, slot: string, projectId = PROJECT_A): CommandWindowSessionRef {
  return { id, status: 'running', transient: true, projectId, commandTerminalSlot: slot };
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

  it('counts a live PTY the pairing map has lost as a live slot', () => {
    // A renderer reload destroys the map while every transient PTY survives. Read
    // from the map alone this looks like "no live sessions", which takes the
    // keep-one-window branch and lets that window fresh-spawn over a live
    // terminal. Main's own session rows are what close that hole.
    const plan = planCommandWindowReconciliation({
      windows: [windowRef('slot-1'), windowRef('slot-2')],
      transientSessions: {},
      sessions: [runningTerminal('sess-1', 'slot-1'), runningTerminal('sess-2', 'slot-2')],
      projectId: PROJECT_A,
      maxWindows: MAX_WINDOWS,
    });
    expect(plan.closeWindowIds).toEqual([]);
    expect(plan.openSlots).toEqual([]);
  });

  it('opens a window for an unpaired live PTY that has none', () => {
    const plan = planCommandWindowReconciliation({
      windows: [windowRef('slot-1')],
      transientSessions: transientMap([{ projectId: PROJECT_A, slot: 'slot-1', sessionId: 'sess-1' }]),
      sessions: [runningSession('sess-1'), runningTerminal('sess-2', 'slot-2')],
      projectId: PROJECT_A,
      maxWindows: MAX_WINDOWS,
    });
    expect(plan.closeWindowIds).toEqual([]);
    expect(plan.openSlots).toEqual(['slot-2']);
  });

  it('ignores session rows from another project, task agents, and dead PTYs', () => {
    const plan = planCommandWindowReconciliation({
      windows: [windowRef('slot-1'), windowRef('slot-2')],
      transientSessions: {},
      sessions: [
        runningTerminal('other-project', 'slot-1', PROJECT_B),
        // A task agent: running, but not a Command Terminal and carries no slot.
        { id: 'task-agent', status: 'running', projectId: PROJECT_A },
        { ...runningTerminal('dead', 'slot-2'), status: 'exited' },
      ],
      projectId: PROJECT_A,
      maxWindows: MAX_WINDOWS,
    });
    // Nothing live for project A, so the keep-one-window branch still applies.
    expect(plan.closeWindowIds).toEqual(['win-slot-2']);
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
