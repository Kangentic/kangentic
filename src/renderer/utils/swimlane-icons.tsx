import React from 'react';
import {
  Layers, Map as MapIcon, Zap, CircleCheckBig,
  icons,
} from 'lucide-react';
import type { Swimlane, SwimlaneRole } from '../../shared/types';

/** Generic icon component type — not tied to any icon library. */
export type IconComponent = React.ComponentType<{
  size?: number;
  strokeWidth?: number;
  className?: string;
  style?: React.CSSProperties;
}>;

export interface IconEntry {
  name: string;
  component: IconComponent;
  label: string;
}

/** Convert PascalCase to kebab-case (e.g. GitBranch → git-branch). */
function toKebabCase(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

/** Convert PascalCase to spaced display label (e.g. GitBranch → Git Branch). */
function toDisplayLabel(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
}

/** Full icon list from lucide-react (~1,500 icons). */
export const ALL_ICONS: IconEntry[] = Object.entries(icons).map(
  ([key, component]) => ({
    name: toKebabCase(key),
    component: component as IconComponent,
    label: toDisplayLabel(key),
  }),
);

/** O(1) name → component lookup. */
export const ICON_REGISTRY = new Map<string, IconComponent>(
  ALL_ICONS.map((entry) => [entry.name, entry.component]),
);

/** Default icons for system swimlane roles. */
export const ROLE_DEFAULTS: Record<SwimlaneRole, IconComponent> = {
  backlog: Layers,
  planning: MapIcon,
  running: Zap,
  done: CircleCheckBig,
};

/** Reverse lookup: role → kebab-case icon name. */
const ROLE_DEFAULT_NAMES: Record<SwimlaneRole, string> = {
  backlog: 'layers',
  planning: 'map',
  running: 'zap',
  done: 'circle-check-big',
};

/**
 * Compute the set of icon names in use by other columns.
 * Checks both explicit `swimlane.icon` and resolved role-default icon names.
 * Pass `excludeId` to skip the column currently being edited.
 */
export function getUsedIcons(swimlanes: Swimlane[], excludeId?: string): Set<string> {
  const used = new Set<string>();
  for (const s of swimlanes) {
    if (s.id === excludeId) continue;
    if (s.icon) {
      used.add(s.icon);
    } else if (s.role) {
      used.add(ROLE_DEFAULT_NAMES[s.role]);
    }
  }
  return used;
}

/**
 * Resolve the icon for a swimlane.
 * Priority: user-set icon → role default → null (color dot fallback).
 */
export function getSwimlaneIcon(swimlane: Swimlane): IconComponent | null {
  if (swimlane.icon) {
    const custom = ICON_REGISTRY.get(swimlane.icon);
    if (custom) return custom;
  }
  if (swimlane.role) {
    return ROLE_DEFAULTS[swimlane.role] ?? null;
  }
  return null;
}
