/**
 * WIQL (Work Item Query Language) query builders for Azure DevOps.
 *
 * WIQL is Azure's SQL-like query language for work items. Pure string
 * construction - no Azure REST client dependency - so this module is
 * callable from tests directly.
 *
 * Tested in tests/unit/azure-devops-wiql.test.ts.
 */

/** Escape single quotes in WIQL string literals. */
export function escapeWiqlString(value: string): string {
  return value.replace(/'/g, "''");
}

/**
 * Work item states Azure DevOps treats as closed. The single source of truth for
 * both the WIQL open/closed filter below and the `stateCategory` the client's
 * mapper stamps, so the query and the normalized bucket can never disagree.
 */
export const AZURE_CLOSED_STATES = ['Closed', 'Done', 'Removed', 'Resolved'] as const;

const CLOSED_STATE_LIST = AZURE_CLOSED_STATES.map((state) => `'${state}'`).join(', ');

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The incremental reconcile's watermark (a full ISO timestamp from
 * `System.ChangedDate`) as the date-only literal the WIQL endpoint accepts, one
 * day earlier. Undefined for a blank or unparseable watermark, which drops the
 * filter and makes the pass a full one.
 *
 * `az boards query` posts its WIQL with no `timePrecision` (azure-devops
 * extension 1.0.2, `work_item.py`), so the query runs at day precision, and the
 * server refuses a literal with a time: "You cannot supply a time with the date
 * when running a query using date precision." That fails every incremental
 * reconcile, which fits Sentry DESKTOP-47's recurrence (one install, every
 * open, two releases). A date-only literal with no zone is read in the
 * zone the server uses for the user, so the day before the watermark's UTC date
 * covers every offset. The literal is that date's midnight, so an incremental
 * pass re-fetches between one and two days of changes, an idempotent upsert.
 *
 * Calling the REST endpoint with `timePrecision=true` through `az devops invoke`
 * would keep the exact instant, but that endpoint answers with ids only, which
 * gives up az's batched field fetch for a second call per page of ids. Up to two
 * days of re-fetched items costs less.
 */
export function changedSinceDateLiteral(changedSince: string): string | undefined {
  const trimmed = changedSince.trim();
  if (!trimmed) return undefined;
  const instant = Date.parse(trimmed);
  const dayBefore = new Date(instant - ONE_DAY_MS);
  // NaN for an unparseable watermark, and for one at the very start of the Date range.
  if (Number.isNaN(dayBefore.getTime())) return undefined;
  return dayBefore.toISOString().slice(0, 10);
}

/**
 * The page condition: ids past the last page's highest. `az boards query` keeps
 * only the first 1000 work items of a query, so the client pages by id and every
 * query is ordered by `[System.Id]`. Ignored unless it is a whole number.
 */
function afterIdCondition(afterId: number | undefined): string | undefined {
  return afterId !== undefined && Number.isSafeInteger(afterId) ? `[System.Id] > ${afterId}` : undefined;
}

/**
 * Build a WIQL query string with optional state, search, iteration, and
 * changed-since filters, and `afterId` for the page after the one ending there.
 */
export function buildWiqlQuery(
  project: string,
  state?: string,
  searchQuery?: string,
  iterationPath?: string,
  changedSince?: string,
  afterId?: number,
): string {
  const conditions: string[] = [
    `[System.TeamProject] = '${escapeWiqlString(project)}'`,
  ];

  if (iterationPath) {
    // UNDER matches the iteration and all child iterations
    conditions.push(`[System.IterationPath] UNDER '${escapeWiqlString(iterationPath)}'`);
  }

  if (state === 'open') {
    conditions.push(`[System.State] NOT IN (${CLOSED_STATE_LIST})`);
  } else if (state === 'closed') {
    conditions.push(`[System.State] IN (${CLOSED_STATE_LIST})`);
  }

  if (searchQuery && searchQuery.trim()) {
    conditions.push(`[System.Title] CONTAINS '${escapeWiqlString(searchQuery.trim())}'`);
  }

  const changedSinceDate = changedSince === undefined ? undefined : changedSinceDateLiteral(changedSince);
  if (changedSinceDate) {
    conditions.push(`[System.ChangedDate] >= '${changedSinceDate}'`);
  }

  const pageCondition = afterIdCondition(afterId);
  if (pageCondition) conditions.push(pageCondition);

  const whereClause = conditions.join(' AND ');

  return [
    'SELECT [System.Id], [System.Title], [System.Description], [System.State],',
    '  [System.Tags], [System.AssignedTo], [System.CreatedDate],',
    '  [System.ChangedDate], [System.WorkItemType],',
    '  [Microsoft.VSTS.Common.Priority],',
    '  [Microsoft.VSTS.TCM.ReproSteps],',
    '  [Microsoft.VSTS.TCM.SystemInfo],',
    '  [Microsoft.VSTS.Common.AcceptanceCriteria]',
    'FROM WorkItems',
    `WHERE ${whereClause}`,
    // By id, for the paging. The cache sorts by changed date when it is read.
    'ORDER BY [System.Id]',
  ].join(' ');
}

/**
 * A minimal ids-only WIQL for the auto-prune sweep: it lists every current work
 * item id (all states) so the reconcile can drop cache rows the remote no longer
 * has. No state/search filter, because the cache holds all states. `afterId`
 * pages it as `buildWiqlQuery` is paged.
 */
export function buildWorkItemIdsWiql(project: string, iterationPath?: string, afterId?: number): string {
  const conditions: string[] = [
    `[System.TeamProject] = '${escapeWiqlString(project)}'`,
  ];
  if (iterationPath) {
    conditions.push(`[System.IterationPath] UNDER '${escapeWiqlString(iterationPath)}'`);
  }
  const pageCondition = afterIdCondition(afterId);
  if (pageCondition) conditions.push(pageCondition);
  return [
    'SELECT [System.Id]',
    'FROM WorkItems',
    `WHERE ${conditions.join(' AND ')}`,
    'ORDER BY [System.Id]',
  ].join(' ');
}
