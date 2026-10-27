/**
 * Hot updates for the renderer's Lingui catalogs.
 *
 * @lingui/vite-plugin turns each `src/locales/<locale>/<area>.po` into a module
 * exporting `messages`, and `src/renderer/i18n/catalogs.ts` is the only module
 * that imports them. Neither accepts a hot update, so an edited PO file
 * propagated up to `src/renderer/index.tsx`, the root, and Vite reloaded the
 * whole page. That reload destroys every Browser pane guest. It would fire on
 * every `npm run i18n:extract`, and in the dogfood window whenever the main
 * checkout fast-forwards over a merge that touched a catalog.
 *
 * This dev-only transform makes each PO module accept its own update and hand
 * the new messages to the renderer through a window event, which catalogs.ts
 * loads into the active i18n instance. Lingui's `load` emits `change`, so
 * `<Trans>` and `useLingui()` consumers re-render with the new text, and the
 * page and its Browser pane guests stay up. The update is still a Vite update,
 * so App.tsx's vite:afterUpdate re-keys the DndContexts as for any other, and
 * text read through `translateText` keeps the old wording until its component
 * next renders.
 * `node scripts/hmr-guest-probe.mjs --file src/locales/en/<area>.po` measures it.
 * tests/unit/vite-refresh-hook-signatures.test.ts pins that every renderer dev
 * config registers it, and that the event name matches catalogs.ts.
 */

/** Kept in step with CATALOG_UPDATE_EVENT in src/renderer/i18n/catalogs.ts. */
export const CATALOG_UPDATE_EVENT = 'kangentic:catalog-update';

const CATALOG_SOURCE = /\/src\/locales\/[^/]+\/[^/]+\.po$/;

/** The accept block appended to a PO module, or null for any other module. */
export function acceptCatalogUpdate(code, id) {
  const filePath = id.split('?')[0].replace(/\\/g, '/');
  if (!CATALOG_SOURCE.test(filePath)) return null;
  const catalogPath = filePath.slice(filePath.lastIndexOf('/src/locales/') + 1);
  return `${code}
if (import.meta.hot) {
  import.meta.hot.accept((updated) => {
    if (!updated) return;
    window.dispatchEvent(new CustomEvent(${JSON.stringify(CATALOG_UPDATE_EVENT)}, {
      detail: { catalogPath: ${JSON.stringify(catalogPath)}, messages: updated.messages },
    }));
  });
}
`;
}

export function linguiCatalogHotUpdate() {
  return [
    {
      name: 'kangentic:lingui-catalog-hot-update',
      apply: 'serve',
      // After @lingui/vite-plugin has compiled the PO file to a module.
      enforce: 'post',
      transform(code, id) {
        const accepted = acceptCatalogUpdate(code, id);
        // Only appends, so the compiled catalog keeps its place (`map: null`).
        return accepted === null ? null : { code: accepted, map: null };
      },
    },
  ];
}
