import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/runtime-macro';
import { formatDuration } from '../utils/format-session';

type DateLike = Date | string | number | null | undefined;

let testLocaleOverride: string | undefined;

/**
 * The display language, so dates and relative times read in the same language
 * as the rest of the UI. A packaged build ships only Chromium's en-US locale, so
 * English already formatted as en-US there before the app had a language.
 */
function getLocale(): string | undefined {
  return testLocaleOverride ?? (i18n.locale || undefined);
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

/**
 * Month, day and time: "Oct 12, 11:04 PM", with the year when it is not the
 * current one. For a table or strip where every row is a recent moment.
 */
export function formatMonthDayTime(value: DateLike, now: Date = new Date()): string {
  return formatMonthDayWith(value, now, { hour: 'numeric', minute: '2-digit' });
}

/** Month and day: "Oct 12", with the year when it is not the current one. */
export function formatMonthDay(value: DateLike, now: Date = new Date()): string {
  return formatMonthDayWith(value, now, {});
}

function formatMonthDayWith(value: DateLike, now: Date, timeOptions: Intl.DateTimeFormatOptions): string {
  const date = toDate(value);
  if (!date) return '';
  const year = date.getFullYear() === now.getFullYear() ? undefined : 'numeric';
  return getDateTimeFormatter({ year, month: 'short', day: 'numeric', ...timeOptions }).format(date);
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

/**
 * A recent moment by the clock: "10:44" today, "yesterday 18:20" the day
 * before, and a short date and time before that. Day boundaries are the
 * user's local ones.
 */
export function formatClockTime(value: DateLike, now: Date = new Date()): string {
  const date = toDate(value);
  if (!date) return '';
  const time = getDateTimeFormatter({ timeStyle: 'short' }).format(date);
  const startOfDay = (moment: Date) => new Date(moment.getFullYear(), moment.getMonth(), moment.getDate()).getTime();
  const daysAgo = Math.round((startOfDay(now) - startOfDay(date)) / (24 * 60 * 60 * 1000));
  if (daysAgo === 0) return time;
  if (daysAgo === 1) return `${getRelativeFormatter().format(-1, 'day')} ${time}`;
  return formatShortDateTime(date);
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

const MINUTE_MS = 60 * 1000;

/**
 * How long before `now` a moment was: "just now" under a minute, then "37
 * minutes ago", "2 hours ago", "yesterday". Whole units, rounded down, so a
 * label that ticks once a minute never runs ahead of the clock. Unlike
 * `formatRelativeTime` it never says "now" on its own, which after a link
 * reads as an instruction.
 */
export function formatTimeAgo(value: DateLike, now: number = Date.now()): string {
  const date = toDate(value);
  if (!date) return '';
  const elapsedMs = now - date.getTime();
  if (elapsedMs < MINUTE_MS) return i18n._(msg`just now`);
  const formatter = getRelativeFormatter();
  for (const { unit, unitMs } of RELATIVE_UNITS) {
    if (elapsedMs >= unitMs) return formatter.format(-Math.floor(elapsedMs / unitMs), unit);
  }
  return '';
}

/** Elapsed duration between two instants, in `formatDuration`'s "1h 30m" format. */
export function formatDurationBetween(start: DateLike, end: DateLike): string {
  const startDate = toDate(start);
  const endDate = toDate(end);
  if (!startDate || !endDate) return '';
  return formatDuration(Math.max(0, endDate.getTime() - startDate.getTime()));
}
