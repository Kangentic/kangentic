import { useLingui } from '@lingui/react/macro';
import { plural } from '@lingui/core/macro';
import type { TooltipFact } from '../../Tooltip';
import { IconBadge, type IconBadgeKind } from '../../IconBadge';
import { gitWorkBadge, type GitWorkBadge, type GitWorkState } from '../../../../shared/git-work-state';

const BADGE_KIND: Record<GitWorkBadge, IconBadgeKind> = {
  'pr-problems': 'problems',
  uncommitted: 'uncommitted',
  unpushed: 'unpushed',
};

/** The Changes button's one badge, or null with nothing to mark. */
export function changesBadgeKind(prFixCount: number, state: GitWorkState | null): IconBadgeKind | null {
  const badge = gitWorkBadge({ prFixCount, state });
  return badge === null ? null : BADGE_KIND[badge];
}

/** Each fact the Changes button's tip lists, once, in words, led by its badge. */
export function useChangesFacts(prFixCount: number, state: GitWorkState | null): TooltipFact[] {
  const { t } = useLingui();
  const facts: TooltipFact[] = [];
  if (prFixCount > 0) {
    facts.push({
      id: 'pr-problems',
      icon: <IconBadge kind="problems" placement="tip" />,
      label: t`${plural(prFixCount, { one: '# problem on the PR', other: '# problems on the PR' })}`,
    });
  }
  const fileCount = state?.uncommittedFileCount ?? 0;
  if (fileCount > 0) {
    facts.push({
      id: 'uncommitted',
      icon: <IconBadge kind="uncommitted" placement="tip" />,
      label: t`${plural(fileCount, { one: '# uncommitted file', other: '# uncommitted files' })}`,
    });
  }
  const commitCount = state?.unpushedCommitCount ?? 0;
  if (commitCount > 0) {
    facts.push({
      id: 'unpushed',
      icon: <IconBadge kind="unpushed" placement="tip" />,
      label: t`${plural(commitCount, { one: '# commit not pushed', other: '# commits not pushed' })}`,
    });
  }
  return facts;
}
