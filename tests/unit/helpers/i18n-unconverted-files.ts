/**
 * Renderer files that still hold hard-coded UI text, which
 * tests/unit/i18n-hardcoded-text.test.ts lets through until their area is
 * extracted (GitHub #489). The list only shrinks: a listed file with no
 * hard-coded text left fails the test, so a converted file comes off in the same
 * change. Never add a file: put its text through Lingui instead.
 *
 * Keyed by catalog area (the PO file the area extracts into, lingui.config.ts),
 * and grouped by the extraction task that owns it, with a blank line between
 * areas, so tasks emptying different areas edit lines git can merge.
 *
 * Every area is extracted, so the list is empty. It stays as the place a future
 * area would be listed, and the test still checks that nothing listed is converted.
 */
export const I18N_UNCONVERTED_FILES: Record<string, readonly string[]> = {};
