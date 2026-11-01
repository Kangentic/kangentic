import type { PRMergeReadiness, PRState } from '../../shared/types';

/**
 * The `, merge <readiness>` suffix a PR link line carries, or nothing. Only an
 * open or draft PR has a merge to be ready for: a merged PR read "merged, merge
 * unknown" (task #952), which an agent took as a merge still in doubt. Shared
 * by the linker's log line (`pr-linking.ts`) and `kangentic_link_pr`'s reply.
 */
export function prReadinessNote(state: PRState | null | undefined, readiness: PRMergeReadiness | null | undefined): string {
  if (!readiness || state === 'merged' || state === 'closed') return '';
  return `, merge ${readiness}`;
}
