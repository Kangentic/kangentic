/**
 * Pure helpers behind the cycle keys (`session.cycle*`, `project.cycle*`): the
 * orders they walk and the step from wherever the user is. The hook that binds
 * the keys and lands on a target is `hooks/useCycleShortcuts.ts`; nothing here
 * touches the DOM or a store, so the orders are unit-tested directly.
 */
import type { Project, ProjectGroup, Session } from '../../shared/types';
import { isCommandTerminalSession } from '../../shared/session-owner';
import {
  groupSidebarProjects,
  sidebarVisualOrder,
} from '../components/sidebar/project-sidebar/sidebar-project-order';

export type CycleDirection = 1 | -1;

/** One terminal the session cycle can land on. */
export type CycleTarget =
  | { kind: 'agent'; projectId: string; sessionId: string; taskId: string }
  | { kind: 'command'; projectId: string; sessionId: string; slot: string };

/**
 * Step `currentIndex` by `direction` through a list of `length`, wrapping at
 * both ends. From `-1` (nothing current), next is the first item and previous
 * is the last. Returns `-1` for an empty list.
 */
export function cycleIndex(length: number, currentIndex: number, direction: CycleDirection): number {
  if (length <= 0) return -1;
  if (currentIndex < 0 || currentIndex >= length) return direction > 0 ? 0 : length - 1;
  return (currentIndex + direction + length) % length;
}

/**
 * Every registered project in the order the project cycle walks: the sidebar's
 * visual order (collapsed groups included), then any project the sidebar shows
 * nowhere because its `group_id` names a deleted group, so every project stays
 * reachable from the keyboard.
 */
export function projectCycleOrder(projects: Project[], groups: ProjectGroup[]): Project[] {
  const order = sidebarVisualOrder(groupSidebarProjects(projects, groups));
  const listed = new Set(order.map((project) => project.id));
  for (const project of projects) {
    if (!listed.has(project.id)) order.push(project);
  }
  return order;
}

export interface TerminalCycleListInput {
  /** The projects to walk, in order: the current one alone for the
   *  this-project cycle, or `projectCycleOrder` for the all-projects one. */
  projectIds: readonly string[];
  /** The unscoped session replica. */
  sessions: readonly Session[];
  /** Tasks whose detail another renderer hosts (the detached Agent Monitor).
   *  Their terminal lives in that window, so this one cannot land on it. */
  remoteDetailTaskIds: readonly string[];
  /** Projects whose Command Terminal is open in a window of its own. Its
   *  terminals live there, so the cycle skips them. */
  commandTerminalsElsewhere: ReadonlySet<string>;
}

/** The number in a `slot-N` id, for slot order. Unknown shapes sort last. */
function slotNumber(slot: string): number {
  const match = /(\d+)$/.exec(slot);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

/**
 * The terminals the session cycle walks. Per project, in `projectIds` order:
 * each running board agent in the replica's order (the bottom panel's tab
 * order), then each running Command Terminal terminal by slot. A workflow's own
 * agent is transient but holds no slot, so it is in neither part.
 */
export function buildTerminalCycleList(input: TerminalCycleListInput): CycleTarget[] {
  const remoteTasks = new Set(input.remoteDetailTaskIds);
  const list: CycleTarget[] = [];
  for (const projectId of input.projectIds) {
    for (const session of input.sessions) {
      if (session.projectId !== projectId || session.status !== 'running' || session.transient) continue;
      if (remoteTasks.has(session.taskId)) continue;
      list.push({ kind: 'agent', projectId, sessionId: session.id, taskId: session.taskId });
    }
    if (input.commandTerminalsElsewhere.has(projectId)) continue;
    const commandTerminals: Array<{ sessionId: string; slot: string }> = [];
    for (const session of input.sessions) {
      if (!isCommandTerminalSession(session) || session.projectId !== projectId || session.status !== 'running') continue;
      if (!session.commandTerminalSlot) continue;
      commandTerminals.push({ sessionId: session.id, slot: session.commandTerminalSlot });
    }
    commandTerminals.sort((first, second) => slotNumber(first.slot) - slotNumber(second.slot));
    for (const terminal of commandTerminals) {
      list.push({ kind: 'command', projectId, sessionId: terminal.sessionId, slot: terminal.slot });
    }
  }
  return list;
}

export interface CycleStepInput {
  list: readonly CycleTarget[];
  /** The terminal the user is on, or null when none resolves. */
  currentSessionId: string | null;
  currentProjectId: string | null;
  /** The project order `list` was built in. */
  projectIds: readonly string[];
  direction: CycleDirection;
}

/**
 * The index of the terminal a press lands on, or `-1` for an empty list. From a
 * terminal in the list, one step in `direction`. From none, the current
 * project's own terminals come first: next lands on its first and previous on
 * its last. A project with no terminals hands next to the first terminal after
 * it in project order and previous to the last one before it, wrapping.
 */
export function cycleStep(input: CycleStepInput): number {
  const { list, direction } = input;
  if (list.length === 0) return -1;
  const currentIndex = input.currentSessionId === null
    ? -1
    : list.findIndex((target) => target.sessionId === input.currentSessionId);
  if (currentIndex !== -1) return cycleIndex(list.length, currentIndex, direction);

  const rank = new Map(input.projectIds.map((projectId, index) => [projectId, index]));
  const currentRank = input.currentProjectId === null ? undefined : rank.get(input.currentProjectId);
  if (currentRank === undefined) return cycleIndex(list.length, -1, direction);
  if (direction > 0) {
    const index = list.findIndex((target) => (rank.get(target.projectId) ?? Number.MAX_SAFE_INTEGER) >= currentRank);
    return index === -1 ? 0 : index;
  }
  for (let index = list.length - 1; index >= 0; index -= 1) {
    if ((rank.get(list[index].projectId) ?? -1) <= currentRank) return index;
  }
  return list.length - 1;
}
