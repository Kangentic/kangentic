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

/** Build a WIQL query string with optional state, search, iteration, and changed-since filters. */
export function buildWiqlQuery(
  project: string,
  state?: string,
  searchQuery?: string,
  iterationPath?: string,
  changedSince?: string,
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

  if (changedSince && changedSince.trim()) {
    // System.ChangedDate accepts an ISO 8601 string literal; no single quotes to
    // escape. `>=` is inclusive so re-fetching the boundary item is a harmless
    // idempotent upsert.
    conditions.push(`[System.ChangedDate] >= '${escapeWiqlString(changedSince.trim())}'`);
  }

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
    'ORDER BY [System.ChangedDate] DESC',
  ].join(' ');
}

/**
 * A minimal ids-only WIQL for the auto-prune sweep: it lists every current work
 * item id (all states) so the reconcile can drop cache rows the remote no longer
 * has. No state/search filter, because the cache holds all states.
 */
export function buildWorkItemIdsWiql(project: string, iterationPath?: string): string {
  const conditions: string[] = [
    `[System.TeamProject] = '${escapeWiqlString(project)}'`,
  ];
  if (iterationPath) {
    conditions.push(`[System.IterationPath] UNDER '${escapeWiqlString(iterationPath)}'`);
  }
  return [
    'SELECT [System.Id]',
    'FROM WorkItems',
    `WHERE ${conditions.join(' AND ')}`,
    'ORDER BY [System.Id]',
  ].join(' ');
}
