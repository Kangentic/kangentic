/**
 * Column and shortcut icons by persisted name, without lucide-react's whole icon map.
 *
 * A column's icon (and a command shortcut's) is stored as a kebab-case name, so resolving any name
 * once meant importing all of lucide's `icons` (about 1,800 glyphs). That map is most of an eager
 * renderer chunk and, in the web demo, 2.3 MB of a page's first frame (demo/README.md, What the page
 * ships). So a name resolves in two tiers:
 *
 * - `CORE_ICONS`, named imports of every icon the default board, the shortcut presets and the demo
 *   dataset use, resolved synchronously. `tests/unit/default-swimlanes-seed-parity.test.ts` keeps
 *   every shipped default in this set, so a stock board never loads the map.
 * - The full map in `icon-catalog.ts`, loaded by `loadIconCatalog()` when the icon picker opens or
 *   when a name outside the core set has to paint. `loadBoard` and `loadShortcuts` await
 *   `ensureIcons` before they publish names, so a project switch paints its icons on the first
 *   frame. A surface that meets a non-core name first (a Monitor bundle, a workflow step) paints
 *   the fallback until the map lands, once per session.
 *
 * A name is in one of three states: known (core, or in the loaded map), pending (not core and the
 * map is not loaded), or unknown (the map is loaded and has no such name; the MCP column tools take
 * any string). Pending and unknown both resolve to `undefined`, which every caller already treats
 * as "no such icon": the role default, a dot, or Zap.
 */
import type React from 'react';
import {
  CircleCheckBig, Code, FlaskConical, FolderOpen, GitBranch, GitCommitHorizontal, GitFork, Layers,
  Map as MapGlyph, Merge, SquareTerminal, Terminal, Zap,
} from 'lucide-react';

/** Generic icon component type, not tied to any icon library. */
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

/**
 * Convert PascalCase to kebab-case (e.g. GitBranch to git-branch). This is how every persisted name
 * was made, and it differs from lucide's own file names for about 100 icons (`calendar1`, not
 * `calendar-1`), so it is the only derivation a lookup may use.
 */
export function toKebabCase(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

/** Convert PascalCase to a spaced display label (e.g. GitBranch to Git Branch). */
export function toDisplayLabel(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
}

/**
 * The icons a board, a shortcut or the web demo names out of the box: the default columns
 * (`src/main/db/migrations/default-data.ts`), Zap (a shortcut with no icon), and the shortcut
 * presets' icons. The full map holds these same component objects, so nothing remounts when it
 * arrives.
 */
export const CORE_ICONS: ReadonlyMap<string, IconComponent> = new Map<string, IconComponent>(
  Object.entries({
    CircleCheckBig, Code, FlaskConical, FolderOpen, GitBranch, GitCommitHorizontal, GitFork, Layers,
    Map: MapGlyph, Merge, SquareTerminal, Terminal, Zap,
  }).map(([key, component]) => [toKebabCase(key), component as IconComponent]),
);

type IconCatalogModule = typeof import('./icon-catalog');

// The loaded map outlives a Fast Refresh of this module (Pattern A), so an edit here does not drop
// it and make every non-core icon paint its fallback again until something reloads it.
// @ts-expect-error -- Vite handles import.meta.hot; tsc's "module": "commonjs" doesn't support it
let catalogModule: IconCatalogModule | null = import.meta.hot?.data?.iconCatalogModule ?? null;
// hmr-safe: an in-flight import; the preserved module above is what a refreshed copy needs
let catalogPromise: Promise<IconCatalogModule> | null = null;
// @ts-expect-error -- Vite handles import.meta.hot
let catalogVersion: number = import.meta.hot?.data?.iconCatalogVersion ?? 0;
// hmr-safe: starts empty on purpose; every subscriber re-subscribes through the refreshed module's subscribeIconCatalog
const listeners = new Set<() => void>();

// @ts-expect-error -- Vite handles import.meta.hot
if (import.meta.hot) {
  // @ts-expect-error -- Vite handles import.meta.hot
  import.meta.hot.dispose((data: Record<string, unknown>) => {
    data.iconCatalogModule = catalogModule;
    data.iconCatalogVersion = catalogVersion;
  });
}

/** The component for a name, or undefined when the name is pending or unknown. */
export function resolveIcon(name: string | null | undefined): IconComponent | undefined {
  if (!name) return undefined;
  return CORE_ICONS.get(name) ?? catalogModule?.CATALOG.get(name);
}

/** The full map when it has already loaded, so a picker reopened later paints its grid at once. */
export function getLoadedIconCatalog(): IconCatalogModule | null {
  return catalogModule;
}

/** True while a name cannot be answered without the full map. */
export function isIconPending(name: string | null | undefined): boolean {
  return Boolean(name) && catalogModule === null && !CORE_ICONS.has(name as string);
}

/**
 * Loads the full map once. A failed load is not cached here, so the next call imports again. In
 * Chromium that import rejects at once: the engine keeps a failed module fetch for the life of the
 * document, so only a reload fetches the chunk again, which is why the picker's failure line says
 * to restart rather than to reopen it.
 */
export function loadIconCatalog(): Promise<IconCatalogModule> {
  if (catalogModule) return Promise.resolve(catalogModule);
  if (!catalogPromise) {
    catalogPromise = import('./icon-catalog').then(
      (loaded) => {
        catalogModule = loaded;
        catalogPromise = null;
        catalogVersion += 1;
        for (const listener of listeners) listener();
        return loaded;
      },
      (error: unknown) => {
        catalogPromise = null;
        throw error;
      },
    );
  }
  return catalogPromise;
}

/** Starts the full map's load ahead of a picker opening (a hover or focus on its button). */
export function warmIconCatalog(): void {
  loadIconCatalog().catch(() => undefined);
}

/**
 * Null when every name already resolves (or is empty), so a caller adds no await on the normal
 * path. Otherwise a promise that settles once the full map has loaded or failed to; it never
 * rejects, because a missing icon falls back and must not fail the load that asked.
 */
export function ensureIcons(names: Iterable<string | null | undefined>): Promise<void> | null {
  for (const name of names) {
    if (isIconPending(name)) {
      return loadIconCatalog().then(() => undefined, () => undefined);
    }
  }
  return null;
}

/** For `useSyncExternalStore`: notified once, when the full map lands. */
export function subscribeIconCatalog(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getIconCatalogVersion(): number {
  return catalogVersion;
}
