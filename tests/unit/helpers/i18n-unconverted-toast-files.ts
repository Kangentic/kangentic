/**
 * Renderer files that still raise a toast with literal English in its title,
 * body or button, which the toast scan in tests/unit/i18n-hardcoded-text.test.ts
 * lets through until their area is extracted (GitHub #489). The JSX scan cannot
 * see these: a toast's text sits in an object literal, often in a `.ts` file.
 *
 * The list only shrinks: a listed file with no literal toast text left fails the
 * test, so a converted file comes off in the same change. Never add a file: put
 * its toast text through Lingui instead.
 *
 * Keyed by catalog area, the same way as helpers/i18n-unconverted-files.ts. A
 * separate file from that one, so the tasks still emptying that list never edit
 * this one.
 */
export const I18N_UNCONVERTED_TOAST_FILES: Record<string, readonly string[]> = {};
