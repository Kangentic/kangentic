import React from 'react';
import {
  Layers, CircleCheckBig,
  icons,
} from 'lucide-react';
import type { Swimlane, SwimlaneRole } from '../../shared/types';

/** Generic icon component type -- not tied to any icon library. */
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
  todo: Layers,
  done: CircleCheckBig,
};

/** Reverse lookup: role → kebab-case icon name. */
const ROLE_DEFAULT_NAMES: Record<SwimlaneRole, string> = {
  todo: 'layers',
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
      // Same two-key map as ROLE_DEFAULTS: a role from outside the union resolves to
      // undefined, which would go into a Set<string> silently and then compare unequal
      // to every real icon name in the picker.
      const roleIconName = ROLE_DEFAULT_NAMES[s.role];
      if (roleIconName) used.add(roleIconName);
    }
  }
  return used;
}

/**
 * Resolve the icon NAME for a swimlane, for a `RegistryIcon` render.
 * Priority: user-set icon (when registered) → role default → null (color dot).
 */
export function getSwimlaneIconName(swimlane: Pick<Swimlane, 'icon' | 'role'>): string | null {
  if (swimlane.icon && ICON_REGISTRY.has(swimlane.icon)) return swimlane.icon;
  if (swimlane.role) return ROLE_DEFAULT_NAMES[swimlane.role] ?? null;
  return null;
}

/**
 * Render a registry icon by name.
 *
 * The lookup lives in one component and goes through `createElement` on
 * purpose. React's compiler rules read `const Icon = ICON_REGISTRY.get(name)`
 * followed by `<Icon />` as a component created during render, which they
 * forbid because a component created per render remounts on every render.
 * The registry holds module-level lucide components, so the identity is in
 * fact stable, but the rule cannot see through a `Map.get`. Routing every
 * call site through here keeps that reasoning in one place.
 *
 * Renders nothing when the name is unknown and no fallback is given.
 */
export function RegistryIcon({
  name,
  fallback = null,
  ...iconProps
}: {
  name: string | null | undefined;
  /** Rendered when `name` is empty or unregistered. */
  fallback?: IconComponent | null;
  size?: number;
  strokeWidth?: number;
  className?: string;
  style?: React.CSSProperties;
}): React.ReactElement | null {
  const component = (name ? ICON_REGISTRY.get(name) : undefined) ?? fallback;
  return component ? React.createElement(component, iconProps) : null;
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
