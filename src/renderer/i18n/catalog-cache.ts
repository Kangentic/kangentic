import { i18n } from '@lingui/core';

/**
 * How many times the session's i18n instance has changed: the boot's activate,
 * and in dev each catalog hot update (`catalogs.ts` loads the edited PO file in
 * place). A cache of translated values is valid only for the count it was built
 * at.
 *
 * hmr-safe: an edit to this file re-evaluates it and every importer, so each
 * importer builds a fresh cache against the fresh count. The old instance's
 * listener only bumps a count nothing reads any more.
 */
let catalogGeneration = 0;
i18n.on('change', () => {
  catalogGeneration += 1;
});

/**
 * Memoize `build` by key until the catalog changes. For a value built from
 * translated text whose identity a consumer keys an effect on: `SegmentedControl`
 * keys its measuring effect on its `options` array, so a fresh array per render
 * rebuilds its ResizeObserver and forces a layout read on every keystroke in the
 * dialog around it. A per-language Map would do that too, but it would keep the
 * old labels after a PO edit under a dev server, which `<Trans>` and `useLingui()`
 * consumers pick up in place.
 */
export function cachePerCatalogBy<Value>(build: (key: string) => Value): (key: string) => Value {
  const cache = new Map<string, Value>();
  let builtAtGeneration = catalogGeneration;
  return (key) => {
    if (builtAtGeneration !== catalogGeneration) {
      cache.clear();
      builtAtGeneration = catalogGeneration;
    }
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    const built = build(key);
    cache.set(key, built);
    return built;
  };
}

/** `cachePerCatalogBy` for a value with no key. */
export function cachePerCatalog<Value>(build: () => Value): () => Value {
  const byKey = cachePerCatalogBy(() => build());
  return () => byKey('');
}
