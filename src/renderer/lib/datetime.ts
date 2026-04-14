import { formatDuration } from '../utils/format-session';

type DateLike = Date | string | number | null | undefined;

let testLocaleOverride: string | undefined;

function getLocale(): string | undefined {
  return testLocaleOverride;
}

/** Test-only seam: force a locale for deterministic assertions. Pass undefined to restore. */
export function __setLocaleForTests(locale: string | undefined): void {
  testLocaleOverride = locale;
  formatterCache.clear();
  relativeFormatterCache.clear();
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();
const relativeFormatterCache = new Map<string, Intl.RelativeTimeFormat>();

function getDateTimeFormatter(options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const locale = getLocale();
  const key = `${locale ?? ''}|${JSON.stringify(options)}`;
  let formatter = formatterCache.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, options);
    formatterCache.set(key, formatter);
  }
  return formatter;
}

function getRelativeFormatter(): Intl.RelativeTimeFormat {
  const locale = getLocale();
  const key = locale ?? '';
  let formatter = relativeFormatterCache.get(key);
  if (!formatter) {
    formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
    relativeFormatterCache.set(key, formatter);
  }
  return formatter;
}

function toDate(value: DateLike): Date | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Medium date + medium time in the user's system locale. */
export function formatDateTime(value: DateLike): string {
  const date = toDate(value);
  if (!date) return '';
  return getDateTimeFormatter({ dateStyle: 'medium', timeStyle: 'medium' }).format(date);
}

/** Short date + short time in the user's system locale. Used for compact timelines. */
export function formatShortDateTime(value: DateLike): string {
  const date = toDate(value);
  if (!date) return '';
  return getDateTimeFormatter({ dateStyle: 'short', timeStyle: 'short' }).format(date);
}

/** Medium date only. */
export function formatDate(value: DateLike): string {
  const date = toDate(value);
  if (!date) return '';
  return getDateTimeFormatter({ dateStyle: 'medium' }).format(date);
}

/** Medium time only. 24-hour in locales that use it, 12-hour otherwise. */
export function formatTime(value: DateLike): string {
  const date = toDate(value);
  if (!date) return '';
  return getDateTimeFormatter({ timeStyle: 'medium' }).format(date);
}

const RELATIVE_UNITS: Array<{ unit: Intl.RelativeTimeFormatUnit; unitMs: number }> = [
  { unit: 'year', unitMs: 365 * 24 * 60 * 60 * 1000 },
  { unit: 'month', unitMs: 30 * 24 * 60 * 60 * 1000 },
  { unit: 'week', unitMs: 7 * 24 * 60 * 60 * 1000 },
  { unit: 'day', unitMs: 24 * 60 * 60 * 1000 },
  { unit: 'hour', unitMs: 60 * 60 * 1000 },
  { unit: 'minute', unitMs: 60 * 1000 },
  { unit: 'second', unitMs: 1000 },
];

/** "5 minutes ago", "in 2 hours", "now". Uses the largest unit that fits the delta. */
export function formatRelativeTime(value: DateLike): string {
  const date = toDate(value);
  if (!date) return '';
  const deltaMs = date.getTime() - Date.now();
  const absMs = Math.abs(deltaMs);
  const formatter = getRelativeFormatter();
  for (const { unit, unitMs } of RELATIVE_UNITS) {
    if (absMs >= unitMs || unit === 'second') {
      return formatter.format(Math.round(deltaMs / unitMs), unit);
    }
  }
  return '';
}

/** Elapsed duration between two instants, reusing the locale-neutral "1h 30m" format. */
export function formatDurationBetween(start: DateLike, end: DateLike): string {
  const startDate = toDate(start);
  const endDate = toDate(end);
  if (!startDate || !endDate) return '';
  return formatDuration(Math.max(0, endDate.getTime() - startDate.getTime()));
}
