/**
 * Vitest setup: load the English catalogs and activate English before any test
 * runs, exactly as the renderer does at boot (src/renderer/i18n/catalogs.ts).
 *
 * Without it, a test that reaches `i18n._` (formatDuration, a settings label)
 * throws "Attempted to call a translation function without setting a locale",
 * and main's translator would depend on which module a suite imported first.
 * The language comes from here, never from the machine running the tests.
 */
import '../../../src/renderer/i18n/catalogs';
