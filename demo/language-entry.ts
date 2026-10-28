/**
 * Makes the demo's in-place language switch (demo/language.ts) loadable from demo/boot.js, a
 * classic script that cannot import: the chunk is fetched only when a visitor, or a scene's
 * choreography, confirms Restart now on a display language, so every other frame loads this
 * one-line loader and nothing else.
 */
import type { AppLocale } from '../src/shared/i18n/locales';

declare global {
  interface Window {
    __demoLoadLanguage?: () => Promise<{ switchLanguage: (locale: AppLocale) => Promise<void> }>;
  }
}

window.__demoLoadLanguage = () => import('./language');
