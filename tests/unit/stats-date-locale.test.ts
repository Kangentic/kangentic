/**
 * The stats dashboard formats its dates in the session's language (the global
 * Lingui `i18n.locale`), not the operating system's. `toLocaleDateString(undefined)`
 * would use the OS locale, which is English on CI and on most dev machines, so a
 * German session would show "May 15" beside German chrome.
 *
 * Covered here: `formatBucketLabel` (chart axis ticks and tooltips) and
 * `customWindowLabel` (the applied-window chip). `BackgroundHistoryCard`'s row
 * date and the day-drill chip in `StatsDashboardBody` read the same locale but
 * format inline inside a component, so there is no pure function to call.
 *
 * Expected strings are computed with an explicit locale in the test, never
 * hardcoded, so ICU data differences between Windows and Linux cannot break it.
 * Each case also asserts the German and English forms differ, which is what keeps
 * the comparison from passing vacuously when the helper ignores the session
 * language. Both directions are pinned (German active, English active), so
 * dropping the locale argument fails on any machine whatever its OS language.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { i18n } from '@lingui/core';
import { formatBucketLabel } from '../../src/renderer/components/stats/useStatsData';
import { customWindowLabel } from '../../src/renderer/components/stats/StatsCustomRangePicker';

const DAY_MS = 24 * 3_600_000;
const HOUR_MS = 3_600_000;

const DAY_OPTIONS: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
const TIME_OPTIONS: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit' };
const MONTH_YEAR_OPTIONS: Intl.DateTimeFormatOptions = { month: 'short', year: 'numeric' };
const MONTH_OPTIONS: Intl.DateTimeFormatOptions = { month: 'short' };

/**
 * A mid-month noon-UTC instant for the first month whose NAME is spelled
 * differently in German and English ("Mai" and "May"), found here so the test
 * does not assume which months the installed ICU data spells differently. A
 * month name is compared, not the whole date, so a difference in day-month order
 * alone cannot stand in for it. Mid-month noon UTC keeps the calendar month the
 * same in every timezone.
 */
function findMonthWhereGermanNameDiffers(): number {
  for (let monthIndex = 0; monthIndex < 12; monthIndex++) {
    const instantMs = Date.UTC(2026, monthIndex, 15, 12, 0, 0);
    // Trailing periods are dropped ("Jan." and "Jan" are one spelling), which some
    // ICU versions add to German abbreviations.
    const german = new Date(instantMs).toLocaleDateString('de', MONTH_OPTIONS).replace(/\./g, '');
    const english = new Date(instantMs).toLocaleDateString('en', MONTH_OPTIONS).replace(/\./g, '');
    if (german !== english) return instantMs;
  }
  throw new Error('No month of 2026 is spelled differently in de and en');
}

describe('stats dates follow the session language, not the OS locale', () => {
  afterEach(() => {
    // The setup file activates English for every test; put it back for the ones after.
    i18n.activate('en');
  });

  describe('formatBucketLabel', () => {
    it('formats a daily bucket label in German when German is the active language', () => {
      const bucketStartMs = findMonthWhereGermanNameDiffers();
      const expectedGerman = new Date(bucketStartMs).toLocaleDateString('de', DAY_OPTIONS);
      const expectedEnglish = new Date(bucketStartMs).toLocaleDateString('en', DAY_OPTIONS);
      expect(expectedGerman).not.toBe(expectedEnglish);

      i18n.loadAndActivate({ locale: 'de', messages: {} });

      expect(formatBucketLabel(bucketStartMs, DAY_MS)).toBe(expectedGerman);
      expect(formatBucketLabel(bucketStartMs, DAY_MS)).not.toBe(expectedEnglish);
    });

    it('formats the same daily bucket label in English when English is the active language', () => {
      const bucketStartMs = findMonthWhereGermanNameDiffers();
      const expectedEnglish = new Date(bucketStartMs).toLocaleDateString('en', DAY_OPTIONS);

      i18n.activate('en');

      expect(formatBucketLabel(bucketStartMs, DAY_MS)).toBe(expectedEnglish);
    });

    it('formats an intraday bucket label (a time) in the active language too', () => {
      // 12-hour "02:00 PM" in English, 24-hour "14:00" in German: the two forms
      // differ at every hour of the day.
      const bucketStartMs = Date.UTC(2026, 4, 15, 14, 0, 0);
      const expectedGerman = new Date(bucketStartMs).toLocaleTimeString('de', TIME_OPTIONS);
      const expectedEnglish = new Date(bucketStartMs).toLocaleTimeString('en', TIME_OPTIONS);
      expect(expectedGerman).not.toBe(expectedEnglish);

      i18n.loadAndActivate({ locale: 'de', messages: {} });
      expect(formatBucketLabel(bucketStartMs, HOUR_MS)).toBe(expectedGerman);

      i18n.activate('en');
      expect(formatBucketLabel(bucketStartMs, HOUR_MS)).toBe(expectedEnglish);
    });
  });

  describe('customWindowLabel', () => {
    // The window bounds are local first-of-month instants (UsageCustomWindow's contract),
    // so they are built with local-time constructors.
    const mayStartMs = new Date(2026, 4, 1).getTime();
    const juneStartMs = new Date(2026, 5, 1).getTime();
    const augustStartMs = new Date(2026, 7, 1).getTime();
    const julyStartMs = new Date(2026, 6, 1).getTime();

    it('labels a single applied month in German when German is the active language', () => {
      const expectedGerman = new Date(mayStartMs).toLocaleDateString('de', MONTH_YEAR_OPTIONS);
      const expectedEnglish = new Date(mayStartMs).toLocaleDateString('en', MONTH_YEAR_OPTIONS);
      expect(expectedGerman).not.toBe(expectedEnglish);

      i18n.loadAndActivate({ locale: 'de', messages: {} });

      const label = customWindowLabel({ sinceMs: mayStartMs, untilMs: juneStartMs });
      expect(label).toBe(expectedGerman);
      expect(label).not.toBe(expectedEnglish);
    });

    it('labels a same-year month span with both ends in the active language', () => {
      // May through July 2026: the from end is a bare month, the to end carries the year.
      const fromGerman = new Date(mayStartMs).toLocaleDateString('de', MONTH_OPTIONS);
      const toGerman = new Date(julyStartMs).toLocaleDateString('de', MONTH_YEAR_OPTIONS);
      const fromEnglish = new Date(mayStartMs).toLocaleDateString('en', MONTH_OPTIONS);
      const toEnglish = new Date(julyStartMs).toLocaleDateString('en', MONTH_YEAR_OPTIONS);
      expect(`${fromGerman} - ${toGerman}`).not.toBe(`${fromEnglish} - ${toEnglish}`);

      i18n.loadAndActivate({ locale: 'de', messages: {} });
      expect(customWindowLabel({ sinceMs: mayStartMs, untilMs: augustStartMs })).toBe(`${fromGerman} - ${toGerman}`);

      i18n.activate('en');
      expect(customWindowLabel({ sinceMs: mayStartMs, untilMs: augustStartMs })).toBe(`${fromEnglish} - ${toEnglish}`);
    });
  });
});
