/**
 * How far an incremental fetch reaches back before the cache's watermark. JQL
 * compares times to the minute, and Cloud's search is eventually consistent, so
 * an item changed in the watermark's minute or just indexed late would be missed
 * without the overlap. The reconcile dedupes what comes back twice.
 */
const SINCE_OVERLAP_MS = 5 * 60 * 1000;

/**
 * Split a query's `ORDER BY` clause off, so a condition can be added before it.
 * Quoted text is masked first, so `summary ~ "order by"` is not mistaken for one.
 */
export function splitOrderBy(jql: string): { condition: string; orderBy: string } {
  const masked = jql.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, (quoted) => 'x'.repeat(quoted.length));
  const match = /\bORDER\s+BY\b/i.exec(masked);
  if (!match) return { condition: jql.trim(), orderBy: '' };
  return { condition: jql.slice(0, match.index).trim(), orderBy: jql.slice(match.index).trim() };
}

/**
 * Format an instant for a JQL date comparison (`yyyy/MM/dd HH:mm`). Jira reads
 * these in the signed-in user's time zone, so the instant is shown in that zone
 * (`/myself` reports it), not this computer's.
 */
export function formatJqlInstant(instant: Date, timeZone: string | undefined): string {
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = jqlDateFormatter(timeZone || 'UTC');
  } catch { // report-ok: a zone name this runtime does not know (Jira's /myself sent it) compares in UTC instead of failing every incremental fetch; the next full pass catches what the offset misses
    formatter = jqlDateFormatter('UTC');
  }
  const parts = formatter.formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((entry) => entry.type === type)?.value ?? '00';
  return `${part('year')}/${part('month')}/${part('day')} ${part('hour')}:${part('minute')}`;
}

function jqlDateFormatter(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
}

/**
 * Narrow a query to items updated since an ISO watermark, rewound by the overlap.
 * With no watermark the query is returned as is.
 */
export function withUpdatedSince(jql: string, since: string | undefined, timeZone: string | undefined): string {
  if (!since) return jql;
  const sinceTime = new Date(since).getTime();
  if (Number.isNaN(sinceTime)) return jql;
  const clause = `updated >= "${formatJqlInstant(new Date(sinceTime - SINCE_OVERLAP_MS), timeZone)}"`;
  const { condition, orderBy } = splitOrderBy(jql);
  const narrowed = condition ? `(${condition}) AND ${clause}` : clause;
  return orderBy ? `${narrowed} ${orderBy}` : narrowed;
}
