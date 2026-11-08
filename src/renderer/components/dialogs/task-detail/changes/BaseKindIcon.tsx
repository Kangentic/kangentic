import { GitBranch, GitCommitHorizontal, Tag } from 'lucide-react';

/**
 * The icon for what a base names. The Changes base badge draws one for a tag
 * or a commit only, so a branch, the usual base, keeps the badge as it was;
 * the base picker's segment passes `showBranch` and draws the branch icon too.
 */
export function BaseKindIcon({ kind, size = 10, showBranch = false }: {
  kind: 'branch' | 'tag' | 'commit';
  size?: number;
  showBranch?: boolean;
}) {
  if (kind === 'tag') return <Tag size={size} className="shrink-0" aria-hidden />;
  if (kind === 'commit') return <GitCommitHorizontal size={size} className="shrink-0" aria-hidden />;
  return showBranch ? <GitBranch size={size} className="shrink-0" aria-hidden /> : null;
}
