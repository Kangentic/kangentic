import fs from 'node:fs';
import path from 'node:path';
import { safeWriteJson } from '../safe-write';
import type { CommandTerminalBrowserState } from '../../shared/types';

/**
 * Each Command Terminal slot's Browser layout: whether its pane is open, and
 * the terminal / Browser split. Stored per project at
 * `<projectPath>/.kangentic/command-terminal-browser.json` as
 * `{ [slot]: { open, ratio } }`.
 *
 * A task keeps the same two facts on its own row (`detail_view_state`), which
 * is how a task's pane comes back after a restart and in whichever window
 * hosts its detail. A Command Terminal has no row, so its slot holds them
 * here. Per project because slots are per project (`slot-1` exists in every
 * one); never in the global `commandTerminalWorkspace`, where slot-1's pane
 * would open in every project.
 *
 * The page's URL is not here: it lives in `browser-urls.json` under the
 * slot's owner key, like a task's. A Command Terminal's final end clears both
 * (`command-terminal-browser.ts`); a quit clears neither, so the restart
 * restore finds them.
 */

const FILE_NAME = 'command-terminal-browser.json';

function resolveFilePath(projectPath: string): string {
  return path.join(projectPath, '.kangentic', FILE_NAME);
}

type SlotMap = Record<string, CommandTerminalBrowserState>;

/** A map with no prototype, so a slot named like an `Object` member reads as absent. */
function emptySlotMap(): SlotMap {
  return Object.create(null) as SlotMap;
}

function readMap(projectPath: string): SlotMap {
  let raw: string;
  try {
    raw = fs.readFileSync(resolveFilePath(projectPath), 'utf-8');
  } catch {
    return emptySlotMap();
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    const map = emptySlotMap();
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return map;
    for (const [slot, value] of Object.entries(parsed as Record<string, unknown>)) {
      const state = toCommandTerminalBrowserState(value);
      if (state) map[slot] = state;
    }
    return map;
  } catch {
    // A corrupt file reads as empty: the panes open closed, which costs a click.
    return emptySlotMap();
  }
}

/**
 * Narrow one stored or sent entry, dropping anything malformed rather than
 * trusting it. A ratio is the terminal's share of the split, so one outside
 * 0 to 1 is dropped; the renderer clamps what is left to its own drag range.
 */
export function toCommandTerminalBrowserState(value: unknown): CommandTerminalBrowserState | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.open !== 'boolean') return null;
  const ratio = typeof candidate.ratio === 'number' && candidate.ratio > 0 && candidate.ratio < 1
    ? candidate.ratio
    : undefined;
  return ratio === undefined ? { open: candidate.open } : { open: candidate.open, ratio };
}

export class CommandTerminalBrowserStore {
  get(projectPath: string, slot: string): CommandTerminalBrowserState | null {
    return readMap(projectPath)[slot] ?? null;
  }

  set(projectPath: string, slot: string, state: CommandTerminalBrowserState): void {
    const map = readMap(projectPath);
    map[slot] = state;
    // Degrades rather than throws, like the URL sidecar: losing this write
    // costs a pane that opens closed after a restart, never the session.
    safeWriteJson(resolveFilePath(projectPath), map, 'command_terminal_browser');
  }

  clear(projectPath: string, slot: string): void {
    const map = readMap(projectPath);
    if (!Object.hasOwn(map, slot)) return;
    delete map[slot];
    safeWriteJson(resolveFilePath(projectPath), map, 'command_terminal_browser');
  }
}

export const commandTerminalBrowserStore = new CommandTerminalBrowserStore();
