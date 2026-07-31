import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { reconcileLanePins, applyTaskListPayload, EMPTY_LANE_PINS, type LanePin } from '../../src/renderer/stores/board-store/lane-pins';
import type { Task } from '../../src/shared/types';

/**
 * Lane pins hold a task at its optimistic destination until the server confirms
 * the move, so a `loadBoard()` whose `tasks.list()` was issued BEFORE the move's
 * DB write cannot snap the card back to its source column.
 *
 * The invariant this file guards: a pin holds only while the server keeps
 * telling us the pre-move story, and every uncertainty resolves toward DROPPING.
 * A pin that leaks is strictly worse than the bug it fixes - the card would be
 * stuck in a phantom column with no way out.
 */

const TODO_LANE = 'lane-todo';
const EXECUTING_LANE = 'lane-executing';
const PLANNING_LANE = 'lane-planning';
const BEFORE_STAMP = '2026-07-31T10:00:00.000Z';
const AFTER_STAMP = '2026-07-31T10:00:05.000Z';

function task(overrides: Partial<Task> & Pick<Task, 'id'>): Task {
  return {
    id: overrides.id,
    display_id: 1,
    title: 'Task',
    description: '',
    swimlane_id: EXECUTING_LANE,
    position: 0,
    updated_at: BEFORE_STAMP,
    ...overrides,
  } as Task;
}

function pins(entries: Record<string, LanePin>): ReadonlyMap<string, LanePin> {
  return new Map(Object.entries(entries));
}

const MOVING_PIN: LanePin = {
  laneId: TODO_LANE,
  fromLaneId: EXECUTING_LANE,
  fromUpdatedAt: BEFORE_STAMP,
};

describe('reconcileLanePins', () => {
  it('KEEPS the pin for a payload issued before the write (the whole point)', () => {
    // This is the clobbering reload: it still reports the pre-move lane AND the
    // pre-move stamp, so it carries no information that the move landed.
    const result = reconcileLanePins(pins({ 't1': MOVING_PIN }), [
      task({ id: 't1', swimlane_id: EXECUTING_LANE, updated_at: BEFORE_STAMP }),
    ]);
    expect(result.get('t1')).toEqual(MOVING_PIN);
  });

  it('drops the pin once the payload reports the move landed', () => {
    const result = reconcileLanePins(pins({ 't1': MOVING_PIN }), [
      task({ id: 't1', swimlane_id: TODO_LANE, updated_at: AFTER_STAMP }),
    ]);
    expect(result.has('t1')).toBe(false);
  });

  it('drops the pin when the server reports a THIRD lane (an auto-move won)', () => {
    const result = reconcileLanePins(pins({ 't1': MOVING_PIN }), [
      task({ id: 't1', swimlane_id: PLANNING_LANE, updated_at: AFTER_STAMP }),
    ]);
    expect(result.has('t1')).toBe(false);
  });

  it('drops the pin when the task bounces BACK to its origin lane with a newer stamp', () => {
    // The leak a lane-only rule cannot see: lane matches `fromLaneId`, so
    // matching on lane alone would hold the card in a phantom column forever.
    // The updated_at clause is what makes this terminate.
    const result = reconcileLanePins(pins({ 't1': MOVING_PIN }), [
      task({ id: 't1', swimlane_id: EXECUTING_LANE, updated_at: AFTER_STAMP }),
    ]);
    expect(result.has('t1')).toBe(false);
  });

  it('drops the pin when the task is absent from the payload (archived or deleted)', () => {
    const result = reconcileLanePins(pins({ 't1': MOVING_PIN }), [task({ id: 'other' })]);
    expect(result.has('t1')).toBe(false);
  });

  it('does not drop a pin because a SIBLING shifted position', () => {
    // TaskRepository.move() bumps updated_at only on the moved row; the two
    // position-shift UPDATEs deliberately leave siblings' stamps alone. If that
    // ever changes, every concurrent move loses its pin and the bug returns.
    const result = reconcileLanePins(pins({ 't1': MOVING_PIN }), [
      task({ id: 't1', swimlane_id: EXECUTING_LANE, position: 4, updated_at: BEFORE_STAMP }),
    ]);
    expect(result.get('t1')).toEqual(MOVING_PIN);
  });

  it('reconciles each pin independently when two moves are in flight', () => {
    const secondPin: LanePin = { laneId: TODO_LANE, fromLaneId: EXECUTING_LANE, fromUpdatedAt: BEFORE_STAMP };
    const result = reconcileLanePins(pins({ 't1': MOVING_PIN, 't2': secondPin }), [
      task({ id: 't1', swimlane_id: TODO_LANE, updated_at: AFTER_STAMP }),
      task({ id: 't2', swimlane_id: EXECUTING_LANE, updated_at: BEFORE_STAMP }),
    ]);
    expect(result.has('t1')).toBe(false);
    expect(result.get('t2')).toEqual(secondPin);
  });

  it('returns the SAME reference when nothing is pinned', () => {
    // tasksPerLane takes lanePins as a memo dependency, so a fresh Map on every
    // store write would invalidate the whole board's lane bucketing constantly.
    const result = reconcileLanePins(EMPTY_LANE_PINS, [task({ id: 't1' })]);
    expect(result).toBe(EMPTY_LANE_PINS);
  });

  it('returns the SAME reference when no pin was dropped', () => {
    const input = pins({ 't1': MOVING_PIN });
    const result = reconcileLanePins(input, [
      task({ id: 't1', swimlane_id: EXECUTING_LANE, updated_at: BEFORE_STAMP }),
    ]);
    expect(result).toBe(input);
  });
});

describe('applyTaskListPayload', () => {
  it('applies the payload and reconciles pins in one pass', () => {
    const state = {
      tasks: [task({ id: 't1', swimlane_id: EXECUTING_LANE, updated_at: BEFORE_STAMP })],
      lanePins: pins({ 't1': MOVING_PIN }),
    };
    const nextTasks = [task({ id: 't1', swimlane_id: TODO_LANE, updated_at: AFTER_STAMP })];
    const result = applyTaskListPayload(state, nextTasks);
    expect(result.tasks[0].swimlane_id).toBe(TODO_LANE);
    expect(result.lanePins.has('t1')).toBe(false);
  });

  it('keeps the pin while applying a stale payload, so the card stays put', () => {
    const state = {
      tasks: [task({ id: 't1', swimlane_id: TODO_LANE, updated_at: BEFORE_STAMP })],
      lanePins: pins({ 't1': MOVING_PIN }),
    };
    // The stale reload wins on `tasks` (structural sharing is not a merge) ...
    const result = applyTaskListPayload(state, [
      task({ id: 't1', swimlane_id: EXECUTING_LANE, updated_at: BEFORE_STAMP }),
    ]);
    expect(result.tasks[0].swimlane_id).toBe(EXECUTING_LANE);
    // ... but the pin survives, and tasksPerLane buckets by the pin.
    expect(result.lanePins.get('t1')).toEqual(MOVING_PIN);
  });
});

/**
 * Static guard. The drop side has more call sites than the read side, so
 * "remember to reconcile" would rot. Invert it: there is ONE function every
 * task-list payload goes through, and a new payload site fails CI until it does.
 */
describe('every task-list payload site reconciles lane pins', () => {
  const REPO_ROOT = path.resolve(__dirname, '../..');
  const SCAN_DIR = 'src/renderer/stores/board-store';
  // structural-sharing.ts defines the helper; lane-pins.ts is the one wrapper
  // that is allowed to call it on `tasks`.
  const ALLOWED = new Set(['structural-sharing.ts', 'lane-pins.ts']);

  it('no board-store slice calls applyStructuralSharing on `tasks` directly', () => {
    const offenders: string[] = [];
    const directory = path.join(REPO_ROOT, SCAN_DIR);
    for (const entry of fs.readdirSync(directory)) {
      if (!entry.endsWith('.ts') || ALLOWED.has(entry)) continue;
      const lines = fs.readFileSync(path.join(directory, entry), 'utf-8').split('\n');
      lines.forEach((line, index) => {
        // `state.tasks` / `s.tasks` as the first argument, but NOT
        // `state.archivedTasks` - the archive has no lane pins.
        if (/applyStructuralSharing\(\s*(?:state|s)\.tasks\b/.test(line)) {
          offenders.push(`${SCAN_DIR}/${entry}:${index + 1}`);
        }
      });
    }
    expect(
      offenders,
      `Apply a task-list payload through applyTaskListPayload (lane-pins.ts) so lane pins reconcile ` +
        `atomically with \`tasks\`. Calling applyStructuralSharing on \`tasks\` directly leaves an ` +
        `in-flight move's pin unreconciled, which either snaps the card back or strands the pin ` +
        `forever.\nOffenders:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  // The check above anchors on applyStructuralSharing, which only catches a site
  // that was already doing the right thing for RENDER identity. bulkUnarchiveTasks
  // was a bare `set({ tasks })` - no structural sharing, no reconcile - and slipped
  // straight through it. Anchor on the IPC call instead: fetching a task list is
  // what creates the obligation, however the result is then applied.
  it('every board-store file that fetches tasks.list() also reconciles through applyTaskListPayload', () => {
    const offenders: string[] = [];
    const directory = path.join(REPO_ROOT, SCAN_DIR);
    for (const entry of fs.readdirSync(directory)) {
      if (!entry.endsWith('.ts') || ALLOWED.has(entry)) continue;
      const source = fs.readFileSync(path.join(directory, entry), 'utf-8');
      if (!/electronAPI\.tasks\.list\(/.test(source)) continue;
      if (!source.includes('applyTaskListPayload')) offenders.push(`${SCAN_DIR}/${entry}`);
    }
    expect(
      offenders,
      `A board-store slice that calls electronAPI.tasks.list() must apply the result through ` +
        `applyTaskListPayload (lane-pins.ts). Assigning the payload straight to \`tasks\` leaves an ` +
        `in-flight move's lane pin unreconciled and skips structural sharing.\nOffenders:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});

/**
 * `useProjectSwitchEffect.ts` clears `lanePins` with a direct
 * `useBoardStore.setState({ ..., lanePins: EMPTY_LANE_PINS, ... })` on all
 * three of its board-resetting paths (warm-cache restore, cold load, and
 * project-closed) rather than through `applyTaskListPayload` - a lane pin is
 * transient in-flight state for ONE project's board and must never survive a
 * switch, and unlike the payload-application sites above there is no server
 * response to reconcile against here, so the explicit literal is the only
 * mechanism. This is a static, not behavioral, check: every reachable path
 * INTO a warm or cold switch has already cleared `lanePins` on the way OUT
 * (see the three call sites' own comments), so there is no observable
 * before/after state to drive a UI spec through - each call site is a
 * standalone literal, and this scan is what proves the literal is actually
 * there instead of a future refactor silently dropping the key from one
 * `useBoardStore.setState({...})` object while leaving the other two intact.
 */
describe('useProjectSwitchEffect.ts clears lanePins on every board-resetting path', () => {
  const REPO_ROOT = path.resolve(__dirname, '../..');

  it('every useBoardStore.setState({...}) call includes lanePins', () => {
    const filePath = path.join(REPO_ROOT, 'src/renderer/hooks/useProjectSwitchEffect.ts');
    const source = fs.readFileSync(filePath, 'utf-8');
    const callPattern = /useBoardStore\.setState\(\{/g;
    const offenders: string[] = [];
    let callCount = 0;
    let match: RegExpExecArray | null;
    while ((match = callPattern.exec(source)) !== null) {
      callCount += 1;
      // Walk forward from the call's opening brace, matching braces until
      // balanced, to extract the full (possibly multi-line) object literal
      // regardless of its indentation or field count.
      const openBraceIndex = match.index + match[0].length - 1;
      let depth = 0;
      let closeBraceIndex = openBraceIndex;
      for (let index = openBraceIndex; index < source.length; index += 1) {
        if (source[index] === '{') depth += 1;
        else if (source[index] === '}') {
          depth -= 1;
          if (depth === 0) { closeBraceIndex = index; break; }
        }
      }
      const block = source.slice(openBraceIndex, closeBraceIndex + 1);
      if (!block.includes('lanePins')) {
        const lineNumber = source.slice(0, match.index).split('\n').length;
        offenders.push(`useProjectSwitchEffect.ts:${lineNumber}`);
      }
    }
    // Sanity floor so a rename of useBoardStore or setState (or the effect
    // losing a path entirely) cannot pass this scan vacuously by matching
    // zero call sites - the warm, cold, and project-closed paths are each
    // their own useBoardStore.setState({...}) call today.
    expect(callCount).toBeGreaterThanOrEqual(3);
    expect(
      offenders,
      `Every useBoardStore.setState({...}) in useProjectSwitchEffect.ts resets per-project board ` +
        `state on a project switch and must clear lanePins (EMPTY_LANE_PINS): a lane pin is ` +
        `transient in-flight state for ONE project's board and must never survive to the next ` +
        `one.\nOffenders:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});
