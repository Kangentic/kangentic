/**
 * Column and shortcut icons by persisted name: `RegistryIcon`, `ShortcutGlyph`, `SwimlaneIcon`,
 * `ColumnGlyph` and `getSwimlaneIconName`
 * (src/renderer/utils/swimlane-icons.tsx) over the two-tier registry in
 * src/renderer/utils/icon-registry.ts, plus `AutomationIcon`
 * (src/renderer/components/dialogs/board-manager/automation-icons.tsx).
 *
 * The registry resolves a name from a small core set at once and from lucide's whole icon map
 * only once that map has loaded, because loading it eagerly cost a web demo frame 2.3 MB of heap
 * (demo/README.md, What the page ships). So this file pins three things beyond the lookups:
 * - the core set's components ARE the full map's, so nothing remounts when the map lands;
 * - a pending name loads the map, a failed load retries, and an unknown name stays unknown;
 * - no renderer file but `icon-catalog.ts` imports lucide's `icons`, which would pull the map back
 *   into the eager bundle with every check here still green.
 *
 * `RegistryIcon` subscribes to the registry with hooks, so it is rendered through
 * `renderToStaticMarkup` rather than called as a plain function. Tests that need the registry
 * before the map loads re-import it after `vi.resetModules()`, since the loaded map is module state.
 *
 * Tier: Unit.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { Bell, Columns3Cog } from 'lucide-react';
import { AutomationIcon } from '../../src/renderer/components/dialogs/board-manager/automation-icons';

type RegistryModule = typeof import('../../src/renderer/utils/icon-registry');
type SwimlaneIconsModule = typeof import('../../src/renderer/utils/swimlane-icons');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const RENDERER_DIR = path.join(REPO_ROOT, 'src', 'renderer');
const CATALOG_PATH = '../../src/renderer/utils/icon-catalog';

/** A real lucide glyph that is deliberately not in the core set. */
const NON_CORE_ICON = 'rocket';
const UNKNOWN_ICON = 'not-a-real-icon-xyz';

async function freshModules(): Promise<{ registry: RegistryModule; swimlaneIcons: SwimlaneIconsModule }> {
  vi.resetModules();
  const registry = await import('../../src/renderer/utils/icon-registry');
  const swimlaneIcons = await import('../../src/renderer/utils/swimlane-icons');
  return { registry, swimlaneIcons };
}

describe('RegistryIcon', () => {
  let swimlaneIcons: SwimlaneIconsModule;
  beforeEach(async () => {
    ({ swimlaneIcons } = await freshModules());
  });

  const render = (props: Parameters<SwimlaneIconsModule['RegistryIcon']>[0]) =>
    renderToStaticMarkup(createElement(swimlaneIcons.RegistryIcon, props));

  it('renders a core icon by name, with no map loaded', () => {
    expect(render({ name: 'layers' })).toContain('lucide-layers');
  });

  it('prefers the named icon over a provided fallback when the name resolves', () => {
    const markup = render({ name: 'layers', fallback: Bell });
    expect(markup).toContain('lucide-layers');
    expect(markup).not.toContain('lucide-bell');
  });

  it('renders the fallback for an unknown name', () => {
    expect(render({ name: UNKNOWN_ICON, fallback: Bell })).toContain('lucide-bell');
  });

  it('renders the fallback for a name still waiting on the full map', () => {
    expect(render({ name: NON_CORE_ICON, fallback: Bell })).toContain('lucide-bell');
  });

  it('renders the fallback when the name is null or empty', () => {
    expect(render({ name: null, fallback: Bell })).toContain('lucide-bell');
    expect(render({ name: '', fallback: Bell })).toContain('lucide-bell');
  });

  it('renders nothing for an unknown name with no fallback', () => {
    expect(render({ name: UNKNOWN_ICON })).toBe('');
  });

  it('passes icon props through and never leaks name/fallback onto the element', () => {
    const markup = render({ name: 'layers', size: 16, className: 'x' });
    expect(markup).toContain('width="16"');
    expect(markup).toMatch(/class="[^"]*\bx\b/);
    expect(markup).not.toContain('name=');
    expect(markup).not.toContain('fallback');
  });
});

describe('shortcutIcon', () => {
  it('returns one component identity per name, and Zap for none or an unknown name', async () => {
    const { swimlaneIcons } = await freshModules();
    expect(swimlaneIcons.shortcutIcon('git-fork')).toBe(swimlaneIcons.shortcutIcon('git-fork'));
    expect(swimlaneIcons.shortcutIcon(undefined)).toBe(swimlaneIcons.shortcutIcon('zap'));
    expect(renderToStaticMarkup(createElement(swimlaneIcons.shortcutIcon('git-fork'), { size: 14 }))).toContain('lucide-git-fork');
    expect(renderToStaticMarkup(createElement(swimlaneIcons.shortcutIcon(UNKNOWN_ICON), { size: 14 }))).toContain('lucide-zap');
  });
});

describe('ShortcutGlyph', () => {
  let swimlaneIcons: SwimlaneIconsModule;
  beforeEach(async () => {
    ({ swimlaneIcons } = await freshModules());
  });

  const render = (props: Parameters<SwimlaneIconsModule['ShortcutGlyph']>[0]) =>
    renderToStaticMarkup(createElement(swimlaneIcons.ShortcutGlyph, props));

  it('renders the named core icon, not the Zap default', () => {
    const markup = render({ name: 'git-fork' });
    expect(markup).toContain('lucide-git-fork');
    expect(markup).not.toContain('lucide-zap');
  });

  it('renders Zap for a shortcut with no icon, an empty one, or one that does not resolve', () => {
    expect(render({ name: null })).toContain('lucide-zap');
    expect(render({ name: undefined })).toContain('lucide-zap');
    expect(render({ name: '' })).toContain('lucide-zap');
    expect(render({ name: UNKNOWN_ICON })).toContain('lucide-zap');
  });

  it('passes size through to the icon', () => {
    expect(render({ name: 'git-fork', size: 14 })).toContain('width="14"');
    expect(render({ name: null, size: 14 })).toContain('width="14"');
  });
});

describe('SwimlaneIcon', () => {
  const COLUMN_COLOR = '#3b82f6';
  const DOT_CLASS = 'w-2 h-2 rounded-full';
  let registry: RegistryModule;
  let swimlaneIcons: SwimlaneIconsModule;
  beforeEach(async () => {
    ({ registry, swimlaneIcons } = await freshModules());
  });

  const render = (swimlane: Parameters<SwimlaneIconsModule['SwimlaneIcon']>[0]['swimlane']) =>
    renderToStaticMarkup(createElement(swimlaneIcons.SwimlaneIcon, { swimlane, size: 18, dotClassName: DOT_CLASS }));

  it('wraps a core custom icon in a span that carries the column color', () => {
    const markup = render({ icon: 'git-fork', role: null, color: COLUMN_COLOR });
    expect(markup).toMatch(/^<span style="color:#3b82f6"><svg[^>]*lucide-git-fork/);
    expect(markup).toContain('width="18"');
    expect(markup).toContain('stroke-width="1.75"');
    expect(markup).not.toContain('<div');
  });

  it('prefers a custom icon over the role default', () => {
    const markup = render({ icon: 'git-fork', role: 'done', color: COLUMN_COLOR });
    expect(markup).toContain('lucide-git-fork');
    expect(markup).not.toContain('lucide-circle-check-big');
  });

  it('renders the role default when there is no icon', () => {
    const todo = render({ icon: null, role: 'todo', color: COLUMN_COLOR });
    expect(todo).toMatch(/^<span style="color:#3b82f6"><svg[^>]*lucide-layers/);
    const done = render({ icon: null, role: 'done', color: COLUMN_COLOR });
    expect(done).toMatch(/^<span style="color:#3b82f6"><svg[^>]*lucide-circle-check-big/);
    expect(done).not.toContain('lucide-layers');
  });

  it('falls back to the role default for an icon that does not resolve', () => {
    const markup = render({ icon: UNKNOWN_ICON, role: 'todo', color: COLUMN_COLOR });
    expect(markup).toContain('lucide-layers');
    expect(markup).not.toContain('<div');
  });

  it('draws a dot in the column color, with the caller\'s class and no svg, for an unknown icon and no role', () => {
    const markup = render({ icon: UNKNOWN_ICON, role: null, color: COLUMN_COLOR });
    expect(markup).toMatch(/^<div class="w-2 h-2 rounded-full" style="background-color:#3b82f6"><\/div>$/);
    expect(markup).not.toContain('<svg');
  });

  it('draws the dot when there is neither an icon nor a role', () => {
    const markup = render({ icon: null, role: null, color: COLUMN_COLOR });
    expect(markup).toContain(`class="${DOT_CLASS}"`);
    expect(markup).toContain('background-color:#3b82f6');
    expect(markup).not.toContain('<svg');
  });

  it('draws the dot for a non-core icon until the full map lands, then the icon itself', async () => {
    const swimlane = { icon: NON_CORE_ICON, role: null, color: COLUMN_COLOR };
    expect(render(swimlane)).toContain('<div');
    expect(render(swimlane)).not.toContain('<svg');

    await registry.loadIconCatalog();

    const markup = render(swimlane);
    expect(markup).toMatch(/^<span style="color:#3b82f6"><svg[^>]*lucide-rocket/);
    expect(markup).not.toContain('<div');
  });
});

describe('ColumnGlyph', () => {
  const COLUMN_COLOR = '#ef4444';
  let registry: RegistryModule;
  let swimlaneIcons: SwimlaneIconsModule;
  beforeEach(async () => {
    ({ registry, swimlaneIcons } = await freshModules());
  });

  const render = (props: Omit<Parameters<SwimlaneIconsModule['ColumnGlyph']>[0], 'size'>) =>
    renderToStaticMarkup(createElement(swimlaneIcons.ColumnGlyph, { size: 18, ...props }));

  it('draws the dot test-id box for a column with no icon and no role', () => {
    const markup = render({ column: { icon: null, role: null } });
    expect(markup).toContain('data-testid="column-glyph-dot"');
    expect(markup).not.toContain('<svg');
  });

  it('sizes the dot to two thirds of the glyph box, in the faint foreground with no color', () => {
    const markup = render({ column: { icon: null, role: null } });
    expect(markup).toContain('width:18px;height:18px');
    expect(markup).toContain('width:12px;height:12px;background-color:var(--color-fg-faint)');
  });

  it('colors the dot with the column color when one is given', () => {
    const markup = render({ column: { icon: null, role: null }, color: COLUMN_COLOR });
    expect(markup).toContain('background-color:#ef4444');
    expect(markup).not.toContain('var(--color-fg-faint)');
  });

  it('draws a dot for an unknown icon with no role', () => {
    const markup = render({ column: { icon: UNKNOWN_ICON, role: null } });
    expect(markup).toContain('data-testid="column-glyph-dot"');
  });

  it('renders the role default svg, and no dot, for a column with a role and no icon', () => {
    const todo = render({ column: { icon: null, role: 'todo' } });
    expect(todo).toContain('lucide-layers');
    expect(todo).not.toContain('column-glyph-dot');
    const done = render({ column: { icon: null, role: 'done' } });
    expect(done).toContain('lucide-circle-check-big');
    expect(done).not.toContain('column-glyph-dot');
  });

  it('renders the column\'s own icon over its role default, at the glyph size and stroke weight, in the column color', () => {
    const markup = render({ column: { icon: 'git-fork', role: 'done' }, color: COLUMN_COLOR });
    expect(markup).toContain('lucide-git-fork');
    expect(markup).not.toContain('lucide-circle-check-big');
    expect(markup).toContain('width="18"');
    expect(markup).toContain('stroke-width="1.75"');
    expect(markup).toContain('color:#ef4444');
  });

  it('takes a stroke weight from the caller', () => {
    expect(render({ column: { icon: 'git-fork', role: null }, strokeWidth: 2.5 })).toContain('stroke-width="2.5"');
  });

  it('draws a dot for a non-core icon until the full map lands, then the icon itself', async () => {
    const column = { icon: NON_CORE_ICON, role: null };
    expect(render({ column })).toContain('column-glyph-dot');

    await registry.loadIconCatalog();

    const markup = render({ column });
    expect(markup).toContain('lucide-rocket');
    expect(markup).not.toContain('column-glyph-dot');
  });
});

describe('getSwimlaneIconName', () => {
  let registry: RegistryModule;
  let swimlaneIcons: SwimlaneIconsModule;
  beforeEach(async () => {
    ({ registry, swimlaneIcons } = await freshModules());
  });

  it('prefers a resolving custom icon over the role default', () => {
    expect(swimlaneIcons.getSwimlaneIconName({ icon: 'layers', role: 'done' })).toBe('layers');
  });

  it('falls through to the role default name when the custom icon is unknown', () => {
    expect(swimlaneIcons.getSwimlaneIconName({ icon: UNKNOWN_ICON, role: 'todo' })).toBe('layers');
    expect(swimlaneIcons.getSwimlaneIconName({ icon: UNKNOWN_ICON, role: 'done' })).toBe('circle-check-big');
  });

  it('returns null when there is no icon and no role', () => {
    expect(swimlaneIcons.getSwimlaneIconName({ icon: null, role: null })).toBeNull();
  });

  it('returns null for an unknown icon with no role', () => {
    expect(swimlaneIcons.getSwimlaneIconName({ icon: UNKNOWN_ICON, role: null })).toBeNull();
  });

  it('reads a non-core icon as the role default until the full map lands, then as itself', async () => {
    expect(swimlaneIcons.getSwimlaneIconName({ icon: NON_CORE_ICON, role: 'todo' })).toBe('layers');
    await registry.loadIconCatalog();
    expect(swimlaneIcons.getSwimlaneIconName({ icon: NON_CORE_ICON, role: 'todo' })).toBe(NON_CORE_ICON);
    expect(swimlaneIcons.getSwimlaneIconName({ icon: UNKNOWN_ICON, role: 'todo' })).toBe('layers');
  });
});

describe('the icon registry', () => {
  let registry: RegistryModule;
  beforeEach(async () => {
    ({ registry } = await freshModules());
  });
  afterEach(() => {
    vi.doUnmock(CATALOG_PATH);
  });

  it('holds the full map\'s own component for every core name, so nothing remounts when it lands', async () => {
    const catalog = await import('../../src/renderer/utils/icon-catalog');
    expect(registry.CORE_ICONS.size).toBeGreaterThan(0);
    for (const [name, component] of registry.CORE_ICONS) {
      expect(catalog.CATALOG.get(name), `core icon "${name}"`).toBe(component);
    }
  });

  it('names every catalog entry the way the picker has always stored it', async () => {
    const catalog = await import('../../src/renderer/utils/icon-catalog');
    expect(catalog.ALL_ICONS.length).toBeGreaterThan(1000);
    // toKebabCase over the PascalCase key, not lucide's file name: `calendar1`, not `calendar-1`.
    expect(catalog.CATALOG.has('calendar1')).toBe(true);
    expect(catalog.CATALOG.has('square-terminal')).toBe(true);
  });

  it('asks for no load when every name is core or empty', () => {
    expect(registry.ensureIcons(['layers', null, undefined, '', 'zap'])).toBeNull();
    expect(registry.isIconPending('layers')).toBe(false);
  });

  it('loads the full map for a pending name, after which it resolves and an unknown name stays unknown', async () => {
    expect(registry.isIconPending(NON_CORE_ICON)).toBe(true);
    expect(registry.resolveIcon(NON_CORE_ICON)).toBeUndefined();
    const versionBefore = registry.getIconCatalogVersion();
    const load = registry.ensureIcons(['layers', NON_CORE_ICON]);
    expect(load).not.toBeNull();
    await load;
    expect(registry.getIconCatalogVersion()).toBe(versionBefore + 1);
    expect(registry.resolveIcon(NON_CORE_ICON)).toBeDefined();
    expect(registry.isIconPending(UNKNOWN_ICON)).toBe(false);
    expect(registry.resolveIcon(UNKNOWN_ICON)).toBeUndefined();
    expect(registry.ensureIcons([NON_CORE_ICON, UNKNOWN_ICON])).toBeNull();
  });

  it('notifies subscribers once the map lands', async () => {
    const listener = vi.fn();
    const unsubscribe = registry.subscribeIconCatalog(listener);
    await registry.loadIconCatalog();
    unsubscribe();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('shares one load across concurrent callers: one import, one notification, one version bump', async () => {
    let factoryRuns = 0;
    vi.doMock(CATALOG_PATH, async (importOriginal) => {
      factoryRuns += 1;
      return importOriginal();
    });
    ({ registry } = await freshModules());
    const listener = vi.fn();
    const unsubscribe = registry.subscribeIconCatalog(listener);
    const versionBefore = registry.getIconCatalogVersion();

    await Promise.all([
      registry.loadIconCatalog(),
      registry.loadIconCatalog(),
      registry.ensureIcons([NON_CORE_ICON]),
    ]);

    // Vitest hands every import of a mocked path the factory's one cached result, so the factory
    // count holds at 1 even without single-flight. The listener and the version are what fail then:
    // each extra load still runs its own `.then`, notifying and bumping once more.
    expect(factoryRuns).toBe(1);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(registry.getIconCatalogVersion()).toBe(versionBefore + 1);

    // Once landed, a later call returns the held map: no second import, no second notification.
    await registry.loadIconCatalog();
    expect(registry.ensureIcons([NON_CORE_ICON])).toBeNull();
    expect(factoryRuns).toBe(1);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(registry.getIconCatalogVersion()).toBe(versionBefore + 1);
    unsubscribe();
  });

  it('retries a failed load instead of caching the failure, and ensureIcons never rejects', async () => {
    let attempts = 0;
    vi.doMock(CATALOG_PATH, async (importOriginal) => {
      attempts += 1;
      if (attempts === 1) throw new Error('chunk failed to load');
      return importOriginal();
    });
    ({ registry } = await freshModules());
    await expect(registry.ensureIcons([NON_CORE_ICON])).resolves.toBeUndefined();
    expect(registry.isIconPending(NON_CORE_ICON)).toBe(true);
    await registry.loadIconCatalog();
    expect(attempts).toBe(2);
    expect(registry.resolveIcon(NON_CORE_ICON)).toBeDefined();
  });
});

describe('lucide\'s whole icon map stays out of the eager bundle', () => {
  const ALLOWED = path.join(RENDERER_DIR, 'utils', 'icon-catalog.ts');
  // Any of these pulls every glyph into whatever chunk imports it.
  const WHOLE_MAP_IMPORT = [
    /import\s*\{[^}]*\bicons\b[^}]*\}\s*from\s*['"]lucide-react['"]/,
    /import\s+\*\s+as\s+\w+\s+from\s*['"]lucide-react['"]/,
    /from\s*['"]lucide-react\/(?:dynamic|dist\/esm\/icons|dist\/esm\/dynamicIconImports)/,
  ];

  function sourceFiles(directory: string): string[] {
    return readdirSync(directory).flatMap((entry) => {
      const fullPath = path.join(directory, entry);
      if (statSync(fullPath).isDirectory()) return sourceFiles(fullPath);
      return /\.(ts|tsx)$/.test(entry) ? [fullPath] : [];
    });
  }

  // Every renderer source, read once for the three scans below.
  let rendererSources: Array<{ file: string; source: string }>;
  beforeAll(() => {
    rendererSources = sourceFiles(RENDERER_DIR).map((file) => ({ file, source: readFileSync(file, 'utf8') }));
  });
  const filesMatching = (test: (source: string) => boolean): string[] =>
    rendererSources.filter(({ source }) => test(source)).map(({ file }) => file);

  it('is imported by icon-catalog.ts and by no other renderer file', () => {
    expect(filesMatching((source) => WHOLE_MAP_IMPORT.some((pattern) => pattern.test(source)))).toEqual([ALLOWED]);
  });

  // scripts/build.js finds the whole map in a built chunk by this icon's name, so the scan goes blind
  // the moment a renderer file imports the icon by name and puts it on the startup path itself.
  it('leaves the build\'s marker icon (ferris-wheel) unimported by name', () => {
    const buildScript = readFileSync(path.join(REPO_ROOT, 'scripts', 'build.js'), 'utf8');
    expect(buildScript).toContain("const ICON_MAP_MARKER = 'ferris-wheel';");
    expect(filesMatching((source) => /\bFerrisWheel\b/.test(source))).toEqual([]);
  });

  it('reaches icon-catalog.ts only through a dynamic import', () => {
    // A static value import (anything but `import type`) would put the map back in its importer's chunk.
    const staticImport = /^\s*import\s+(?!type\b)[^;]*?from\s*['"][^'"]*\/icon-catalog['"]/m;
    expect(filesMatching((source) => staticImport.test(source))).toEqual([]);
  });
});

describe('AutomationIcon', () => {
  it('renders the mapped component for a known automation type name', () => {
    const output = AutomationIcon({ name: 'bell' });
    expect(output.type).toBe(Bell);
  });

  it('falls back to the automations mark, Columns3Cog, for an unknown name', () => {
    const output = AutomationIcon({ name: 'not-a-real-automation-type' });
    expect(output.type).toBe(Columns3Cog);
  });

  it('no longer resolves the bolt, which is the Trigger card mark and not an automation type', () => {
    const output = AutomationIcon({ name: 'zap' });
    expect(output.type).toBe(Columns3Cog);
  });

  it('does not leak name onto the rendered element props', () => {
    const output = AutomationIcon({ name: 'bell', size: 20 });
    expect(output.props).toMatchObject({ size: 20 });
    expect(output.props).not.toHaveProperty('name');
  });
});
