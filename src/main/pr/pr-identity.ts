import type { Task } from '../../shared/types';

/**
 * The columns that tie a task row to a PR: the link itself and the two anchors
 * a resolve finds it again from (`pushed_branch` for Tier 5, `head_sha` for
 * Tiers 3 and 6).
 *
 * `forgetPRLinkOnTodoReset` nulls exactly these when a To Do move commits. The
 * To Do sweep reads a leftover branch's tip back into `head_sha` only for a row
 * that still holds one of them. Both read this list, so a column added to one
 * side cannot be missed by the other.
 */
export const PR_IDENTITY_COLUMNS = [
  'pr_url',
  'pr_number',
  'pr_state',
  'pr_merge_readiness',
  'pushed_branch',
  'head_sha',
] as const satisfies ReadonlyArray<keyof Task>;

export type PRIdentityColumn = typeof PR_IDENTITY_COLUMNS[number];

/** True when the row still holds any PR identity column. */
export function holdsPRIdentity(row: Pick<Task, PRIdentityColumn>): boolean {
  return PR_IDENTITY_COLUMNS.some((column) => row[column] != null);
}
