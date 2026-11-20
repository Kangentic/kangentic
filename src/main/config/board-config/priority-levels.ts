import { DEFAULT_PRIORITY_CONFIG } from '../../../shared/types';
import type { PriorityLevelName } from '../../../shared/automation-filter';

export type { PriorityLevelName };

/**
 * A project's priority levels, for the `kangentic.json` reader and writer to
 * turn a Condition's Priority line between level numbers (the database's) and
 * level names (the file's, #872). The list lives in the project's config, which
 * the board config modules do not reach, so `register-all.ts` sets the lookup
 * once and every read and write asks here. Unset, or for a project it cannot
 * find, the default levels answer, which is what a project that never edited
 * its list has.
 */
export type PriorityLevelLookup = (projectId: string) => readonly PriorityLevelName[] | null | undefined;

let lookup: PriorityLevelLookup | null = null;

export function setBoardPriorityLevelLookup(next: PriorityLevelLookup | null): void {
  lookup = next;
}

export function boardPriorityLevels(projectId: string | null | undefined): readonly PriorityLevelName[] {
  if (!projectId || !lookup) return DEFAULT_PRIORITY_CONFIG;
  try {
    const levels = lookup(projectId);
    return levels && levels.length > 0 ? levels : DEFAULT_PRIORITY_CONFIG;
  } catch {
    // report-ok: a project whose config cannot be read has the default levels, the same answer an unset lookup gives
    return DEFAULT_PRIORITY_CONFIG;
  }
}
