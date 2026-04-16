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

/** Build a WIQL query string with optional state, search, and iteration filters. */
export function buildWiqlQuery(
  project: string,
  state?: string,
  searchQuery?: string,
  iterationPath?: string,
): string {
  const conditions: string[] = [
    `[System.TeamProject] = '${escapeWiqlString(project)}'`,
  ];

  if (iterationPath) {
    // UNDER matches the iteration and all child iterations
    conditions.push(`[System.IterationPath] UNDER '${escapeWiqlString(iterationPath)}'`);
  }

  if (state === 'open') {
    conditions.push(`[System.State] NOT IN ('Closed', 'Done', 'Removed', 'Resolved')`);
  } else if (state === 'closed') {
    conditions.push(`[System.State] IN ('Closed', 'Done', 'Removed', 'Resolved')`);
  }

  if (searchQuery && searchQuery.trim()) {
    conditions.push(`[System.Title] CONTAINS '${escapeWiqlString(searchQuery.trim())}'`);
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
