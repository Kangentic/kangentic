/**
 * React bindings over `icon-registry.ts` for any icon persisted by name: a column's icon and a
 * command shortcut's. The registry decides how a name resolves; this module renders it.
 */
import React, { useEffect, useSyncExternalStore } from 'react';
import { Layers, CircleCheckBig, Zap } from 'lucide-react';
import type { Swimlane, SwimlaneRole } from '../../shared/types';
import {
  getIconCatalogVersion, isIconPending, resolveIcon, subscribeIconCatalog, warmIconCatalog,
  type IconComponent,
} from './icon-registry';

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
 * Priority: user-set icon (when it resolves) → role default → null (color dot).
 *
 * Pure: it answers from what is loaded now, so a custom icon outside the core set reads as its
 * role default until the full map lands. A component reads it through `useSwimlaneIconName`, which
 * starts that load and re-renders when it lands.
 */
export function getSwimlaneIconName(swimlane: Pick<Swimlane, 'icon' | 'role'>): string | null {
  if (swimlane.icon && resolveIcon(swimlane.icon)) return swimlane.icon;
  if (swimlane.role) return ROLE_DEFAULT_NAMES[swimlane.role] ?? null;
  return null;
}

/**
 * The component for a persisted icon name, or undefined while it is pending or when it is
 * unknown. A pending name starts the full map's load, and the caller re-renders when it lands.
 */
export function useRegistryIcon(name: string | null | undefined): IconComponent | undefined {
  // Subscribed for the re-render alone: the version changes once, when the full map lands.
  useSyncExternalStore(subscribeIconCatalog, getIconCatalogVersion, getIconCatalogVersion);
  const pending = isIconPending(name);
  useEffect(() => {
    if (pending) warmIconCatalog();
  }, [pending]);
  return resolveIcon(name);
}

/** `getSwimlaneIconName` for a component: starts the map's load for a pending custom icon. */
export function useSwimlaneIconName(swimlane: Pick<Swimlane, 'icon' | 'role'> | null | undefined): string | null {
  useRegistryIcon(swimlane?.icon);
  return swimlane ? getSwimlaneIconName(swimlane) : null;
}

/**
 * Render a registry icon by name.
 *
 * The lookup lives in one component and goes through `createElement` on
 * purpose. React's compiler rules read `const Icon = resolveIcon(name)`
 * followed by `<Icon />` as a component created during render, which they
 * forbid because a component created per render remounts on every render.
 * The registry holds module-level lucide components, so the identity is in
 * fact stable, but the rule cannot see through the lookup. Routing every
 * call site through here keeps that reasoning in one place.
 *
 * Renders nothing when the name is unknown (or still loading) and no fallback is given.
 */
export function RegistryIcon({
  name,
  fallback = null,
  ...iconProps
}: {
  name: string | null | undefined;
  /** Rendered when `name` is empty or does not resolve. */
  fallback?: IconComponent | null;
  size?: number;
  strokeWidth?: number;
  className?: string;
  style?: React.CSSProperties;
}): React.ReactElement | null {
  const component = useRegistryIcon(name) ?? fallback;
  return component ? React.createElement(component, iconProps) : null;
}

/**
 * A command shortcut's icon by its persisted name. Zap stands in for a shortcut with no icon or one
 * that does not resolve, so this is the one place that default lives.
 */
export function ShortcutGlyph({
  name,
  ...iconProps
}: {
  name: string | null | undefined;
  size?: number;
  strokeWidth?: number;
  className?: string;
  style?: React.CSSProperties;
}): React.ReactElement | null {
  return <RegistryIcon name={name || 'zap'} fallback={Zap} {...iconProps} />;
}

// hmr-safe: a memo of stateless wrappers; a refreshed module builds its own
const SHORTCUT_ICONS = new Map<string, IconComponent>();

/**
 * `ShortcutGlyph` as a component type, for a control that takes one (the header pills'
 * `HeaderActionButton`). Memoized per name, so a pill keeps one component identity across renders.
 */
export function shortcutIcon(name: string | null | undefined): IconComponent {
  const key = name || 'zap';
  let component = SHORTCUT_ICONS.get(key);
  if (!component) {
    const ShortcutIcon: IconComponent = (props) => <ShortcutGlyph name={key} {...props} />;
    ShortcutIcon.displayName = `ShortcutIcon(${key})`;
    component = ShortcutIcon;
    SHORTCUT_ICONS.set(key, component);
  }
  return component;
}

/**
 * A column's glyph, resolved as the board's column header resolves it
 * (`getSwimlaneIconName`): its own icon, else its To Do or Done default, else
 * a dot in its color. `size` is the glyph box; the dot is two thirds of it,
 * centered, so column names line up down a list (8px in a 12px box, as the
 * phone draws it). With no color the icon inherits the text color and the dot
 * is `fg-faint`.
 */
export function ColumnGlyph({
  column,
  size,
  strokeWidth = 1.75,
  color,
}: {
  column: Pick<Swimlane, 'icon' | 'role'>;
  size: number;
  strokeWidth?: number;
  color?: string | null;
}): React.ReactElement {
  const iconName = useSwimlaneIconName(column);
  if (iconName) {
    return <RegistryIcon name={iconName} size={size} strokeWidth={strokeWidth} style={{ color: color ?? undefined }} />;
  }
  const dot = Math.round((size * 2) / 3);
  return (
    <span className="inline-flex items-center justify-center shrink-0" style={{ width: size, height: size }} data-testid="column-glyph-dot">
      <span className="block rounded-full" style={{ width: dot, height: dot, backgroundColor: color ?? 'var(--color-fg-faint)' }} />
    </span>
  );
}

/**
 * A column's icon in the column's color, or a dot in its color: the board's column headers and a
 * task's Move to menu. The caller sizes the dot, since each surface draws it differently.
 */
export function SwimlaneIcon({
  swimlane,
  size,
  dotClassName,
}: {
  swimlane: Pick<Swimlane, 'icon' | 'role' | 'color'>;
  size: number;
  dotClassName: string;
}): React.ReactElement {
  const iconName = useSwimlaneIconName(swimlane);
  if (iconName) {
    return <span style={{ color: swimlane.color }}><RegistryIcon name={iconName} size={size} strokeWidth={1.75} /></span>;
  }
  return <div className={dotClassName} style={{ backgroundColor: swimlane.color }} />;
}
