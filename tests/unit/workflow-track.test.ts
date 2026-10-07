/**
 * A workflow task's step track (sign-off R2 and T2, 2026-10-07): the task's
 * whole journey, To Do, the route, Done, one stop each, the same length for a
 * task's whole life. A stop it has left is `done` (drawn grey), the one it is
 * at `current` (its column's marker), one still to come `ahead` (its column's
 * color). Drawing is checked in the UI tier (workflows-view, workflows-board).
 */
import { describe, it, expect } from 'vitest';
import { boardEnds, plannedRouteSteps, routeSteps } from '../../src/shared/workflow-route';
import { trackStops } from '../../src/renderer/components/workflows/workflow-track';

const lane = (id: string, position: number, role: 'todo' | 'done' | null, color: string | null = null) => ({
  id, position, role, name: id, color, icon: null, is_archived: false, is_ghost: false,
});
// The default board: To Do, five route columns, Done.
const LANES = [
  lane('To Do', 0, 'todo', '#6b7280'), lane('Planning', 1, null, '#8b5cf6'), lane('Executing', 2, null, '#3b82f6'),
  lane('Code Review', 3, null, '#f59e0b'), lane('Testing', 4, null, '#06b6d4'), lane('Merge', 5, null, '#f97316'),
  lane('Done', 6, 'done', '#10b981'),
];
// A route that skips Planning.
const ROUTE = { route_start_swimlane_id: null, route_last_swimlane_id: null, skipped_swimlane_ids: ['Planning'] };
const ENDS = boardEnds(LANES);
const shape = (stops: ReturnType<typeof trackStops>) => stops.map((stop) => `${stop.name}:${stop.state}`);
const at = (swimlaneId: string, archived = false) => ({ ...ROUTE, swimlane_id: swimlaneId, archived_at: archived ? '2026-10-07T00:00:00.000Z' : null });

describe('boardEnds', () => {
  it('names the board\'s To Do and Done columns, with their colors', () => {
    expect(ENDS.todo).toEqual({ swimlaneId: 'To Do', name: 'To Do', color: '#6b7280', icon: null });
    expect(ENDS.done).toEqual({ swimlaneId: 'Done', name: 'Done', color: '#10b981', icon: null });
  });

  it('is null for an end the board does not have', () => {
    expect(boardEnds(LANES.filter((column) => column.role !== 'done')).done).toBeNull();
  });
});

describe('trackStops', () => {
  it('draws a planned task at To Do, its route ahead, Done last, and no skipped column', () => {
    expect(shape(trackStops(plannedRouteSteps(LANES, ROUTE), ENDS, 'planned'))).toEqual([
      'To Do:current', 'Executing:ahead', 'Code Review:ahead', 'Testing:ahead', 'Merge:ahead', 'Done:ahead',
    ]);
  });

  it('draws a task at work with To Do and the columns it left behind it', () => {
    expect(shape(trackStops(routeSteps(LANES, at('Code Review')), ENDS, 'working'))).toEqual([
      'To Do:done', 'Executing:done', 'Code Review:current', 'Testing:ahead', 'Merge:ahead', 'Done:ahead',
    ]);
  });

  it('draws a finished task at Done with everything before it passed', () => {
    expect(shape(trackStops(routeSteps(LANES, at('Done', true)), ENDS, 'done'))).toEqual([
      'To Do:done', 'Executing:done', 'Code Review:done', 'Testing:done', 'Merge:done', 'Done:current',
    ]);
  });

  it('keeps one length for a task\'s whole life: only where it is moves', () => {
    const lengths = [
      trackStops(plannedRouteSteps(LANES, ROUTE), ENDS, 'planned'),
      trackStops(routeSteps(LANES, at('To Do')), ENDS, 'todo'),
      trackStops(routeSteps(LANES, at('Executing')), ENDS, 'working'),
      trackStops(routeSteps(LANES, at('Merge')), ENDS, 'working'),
      trackStops(routeSteps(LANES, at('Done', true)), ENDS, 'done'),
    ].map((stops) => stops.length);
    expect(new Set(lengths)).toEqual(new Set([6]));
    // And exactly one stop is where the task is.
    expect(trackStops(routeSteps(LANES, at('Testing')), ENDS, 'working').filter((stop) => stop.state === 'current')).toHaveLength(1);
  });

  it('marks the two ends, and draws a board without one with the end left off', () => {
    const stops = trackStops(routeSteps(LANES, at('Executing')), ENDS, 'working');
    expect(stops[0].end).toBe('todo');
    expect(stops[stops.length - 1].end).toBe('done');
    expect(stops.slice(1, -1).every((stop) => stop.end === null)).toBe(true);
    expect(trackStops(routeSteps(LANES, at('Executing')), { todo: ENDS.todo, done: null }, 'working').map((stop) => stop.name).at(-1)).toBe('Merge');
  });
});
