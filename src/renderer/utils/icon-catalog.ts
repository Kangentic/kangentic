/**
 * lucide-react's whole icon map (about 1,800 glyphs) under the names columns and shortcuts persist.
 *
 * Imported ONLY through `loadIconCatalog()` in `icon-registry.ts`, never statically: the map is
 * about 690 KB of code and, measured on the web build, 2.3 MB of a page's first frame and 0.8 MB of
 * every frame after it (demo/README.md, What the page ships). A board paints from the core set in
 * `icon-registry.ts`; this module loads when the icon picker opens or a persisted name is not in
 * that set. `tests/unit/swimlane-icons.test.ts` fails any other file that imports `icons`.
 */
import { icons } from 'lucide-react';
import { toDisplayLabel, toKebabCase, type IconComponent, type IconEntry } from './icon-registry';

/** Every glyph, named the way the picker has always stored them. */
export const ALL_ICONS: IconEntry[] = Object.entries(icons).map(([key, component]) => ({
  name: toKebabCase(key),
  component: component as IconComponent,
  label: toDisplayLabel(key),
}));

/** Name to component, for resolving a persisted name. */
export const CATALOG = new Map<string, IconComponent>(ALL_ICONS.map((entry) => [entry.name, entry.component]));
