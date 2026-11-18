/**
 * What the daily outside checks share: one request with one retry, text made safe to print, a
 * result row, and the three ways a run reports its rows (a console table, workflow annotations
 * and a step summary table).
 *
 * scripts/check-integrations.mjs (the shipped sign-ins) and scripts/check-distribution.mjs (the
 * published release, the npm launcher, the site and the domain) both run from
 * .github/workflows/integrations.yml, before any install, so this file uses only Node's own
 * modules.
 */

export const TIMEOUT_MS = 15_000;
const SNIPPET_LIMIT = 120;

/** @typedef {'ok' | 'pending' | 'fail'} Status */
/** @typedef {{ area: string, check: string, status: Status, detail: string }} Result */
/** @typedef {(url: string, init?: RequestInit) => Promise<Response>} SendRequest */

// ---------------------------------------------------------------------------
// Text that came from somewhere else
// ---------------------------------------------------------------------------

/** Flattens text to one line. Every control character and line break becomes a space. */
export function singleLine(text) {
  return String(text).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/ {2,}/g, ' ').trim();
}

/**
 * A piece of a remote answer, safe to print. The runner reads `::command::`
 * lines from a script's output, so nothing a service sent may start a line.
 */
export function snippet(text) {
  return singleLine(text).slice(0, SNIPPET_LIMIT);
}

/**
 * Why a request got no answer. Node's fetch throws "fetch failed" and keeps the
 * reason on `cause`. When both address families refuse the connection, that
 * cause is an AggregateError with an empty message and the reason in `code`.
 */
export function messageOf(problem) {
  if (!(problem instanceof Error)) return snippet(problem);
  const cause = problem.cause;
  return snippet(cause?.message || cause?.code || problem.message);
}

/** @returns {Result} */
export function result(area, check, status, detail) {
  return { area, check, status, detail: singleLine(detail) };
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

/** @param {Result[]} results */
export function tableLines(results) {
  return results.map(({ area, check, status, detail }) => `${status.padEnd(8)}${area.padEnd(8)}${check.padEnd(16)}${detail}`);
}

function escapeCommandData(text) {
  return text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

function escapeCommandProperty(text) {
  return escapeCommandData(text).replace(/:/g, '%3A').replace(/,/g, '%2C');
}

/** One `::error` per failure and one `::notice` per pending check, for the run's annotations. */
export function annotationLines(results) {
  return results
    .filter(({ status }) => status !== 'ok')
    .map(({ area, check, status, detail }) =>
      `::${status === 'fail' ? 'error' : 'notice'} title=${escapeCommandProperty(`${area} ${check}`)}::${escapeCommandData(detail)}`);
}

export function markdownCell(text) {
  return text.replace(/[\\|<>[\]`*_]/g, '\\$&');
}

/** The step summary's table: a header and one row per check. */
export function summaryTable(results) {
  const rows = results.map(({ area, check, status, detail }) => `| ${status} | ${area} | ${check} | ${markdownCell(detail)} |`);
  return ['| Status | Area | Check | Detail |', '| --- | --- | --- | --- |', ...rows];
}

export function exitCodeFor(results) {
  return results.some(({ status }) => status === 'fail') ? 1 : 0;
}

/**
 * One retry on a network failure, so a single dropped connection does not
 * email anyone. An HTTP answer, even a 5xx, is never retried, because it is the
 * answer.
 *
 * @param {string} url
 * @param {RequestInit} [init]
 * @returns {Promise<Response>}
 */
export async function sendRequest(url, init = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (problem) {
      if (attempt === 2) throw problem;
    }
  }
}
