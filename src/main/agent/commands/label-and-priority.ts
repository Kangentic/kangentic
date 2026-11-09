/**
 * The label and priority vocabulary the MCP task and backlog commands share.
 *
 * Labels: a tool takes each label as a plain name or `{ name, color }`. The
 * names go to the row; the colors go to the project's label colors. A plain name
 * leaves a label's existing color alone.
 *
 * Priority: a number is an index into the PROJECT's scale, which the Priorities
 * popover lets a person rename, reorder and extend. So the bound and the names
 * come from that scale, never from the five levels Kangentic seeds.
 */
import { DEFAULT_PRIORITY_CONFIG } from '../../../shared/types';
import { HEX_LABEL_COLOR } from '../../../shared/label-palette';
import type { CommandContext } from './types';

export type PriorityScale = ReadonlyArray<{ label: string; color: string }>;

/** The refusal for a `labels` value that is not a list. */
export const LABELS_NOT_A_LIST = 'labels must be a list of names or { name, color } entries.';

/**
 * Whether a raw `labels` param is a list, or absent. Checked before
 * `splitLabelEntries`, because a string would otherwise split into one label
 * per character, and treating it as no labels would clear a task's labels.
 */
export function isLabelListOrAbsent(raw: unknown): raw is ReadonlyArray<unknown> | null | undefined {
  return raw === undefined || raw === null || Array.isArray(raw);
}

/**
 * Splits label entries into the names a row stores and the colors to save.
 * Reached from the mobile bridge with no schema in front of it, so anything
 * that is neither a string nor a named object is dropped, and a color that is
 * not a 6-digit hex is ignored rather than saved.
 */
export function splitLabelEntries(rawEntries: ReadonlyArray<unknown> | null | undefined): {
  names: string[];
  colors: Record<string, string>;
} {
  const names: string[] = [];
  const colors: Record<string, string> = {};
  for (const entry of rawEntries ?? []) {
    if (typeof entry === 'string') {
      names.push(entry);
      continue;
    }
    if (entry && typeof entry === 'object' && 'name' in entry && typeof entry.name === 'string' && entry.name) {
      names.push(entry.name);
      const color = 'color' in entry ? entry.color : undefined;
      if (typeof color === 'string' && HEX_LABEL_COLOR.test(color)) colors[entry.name] = color;
    }
  }
  return { names, colors };
}

/** The project's priority scale, bottom entry first. An empty one reads as the seeded scale. */
export function priorityScaleOf(context: CommandContext): PriorityScale {
  const priorities = context.getBacklogDisplayConfig?.().priorities;
  return priorities && priorities.length > 0 ? priorities : DEFAULT_PRIORITY_CONFIG;
}

/** The project's label colors, keyed by exact label text. */
export function labelColorsOf(context: CommandContext): Record<string, string> {
  return context.getBacklogDisplayConfig?.().labelColors ?? {};
}

/**
 * A priority's name on the scale. An index past the end (a level since removed)
 * reads as its number, the same `P<n>` the renderer's `PriorityBadge` draws.
 */
export function priorityName(index: number, scale: PriorityScale): string {
  return scale[index]?.label ?? `P${index}`;
}

/** The scale as one line: `0 None, 1 Low, 2 Medium, 3 High, 4 Urgent`. */
export function describePriorityScale(scale: PriorityScale): string {
  return scale.map((entry, index) => `${index} ${entry.label}`).join(', ');
}

/**
 * Null when `priority` is a level on the scale, otherwise the refusal. The
 * refusal lists the scale so an agent can correct the call without another
 * lookup.
 */
export function priorityScaleError(priority: unknown, scale: PriorityScale): string | null {
  if (typeof priority === 'number' && Number.isInteger(priority) && priority >= 0 && priority < scale.length) {
    return null;
  }
  return `Priority must be 0-${scale.length - 1} on this project's scale: ${describePriorityScale(scale)}.`;
}
