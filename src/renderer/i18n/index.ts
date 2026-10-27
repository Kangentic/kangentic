/**
 * The renderer's i18n entry point: the catalog loaders (catalogs.ts, which
 * activates English as it loads) and `translateText` (translate.ts).
 *
 * catalogs.ts uses `import.meta.glob`, which exists only under Vite, so a module
 * Playwright or the capture rig imports outside Vite takes `translateText` from
 * ./translate instead of from here. See .claude/rules/i18n.md.
 */
export { activateLocale, createLocaleI18n, loadLocaleMessages } from './catalogs';
export { translateText } from './translate';
