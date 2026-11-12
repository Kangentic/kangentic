import type { ReactNode } from 'react';
import { Check, CircleX, ExternalLink, GitMergeConflict, LoaderCircle, Send } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import { plural } from '@lingui/core/macro';
import { Tooltip } from '../../../Tooltip';
import { CountBadge } from '../../../CountBadge';
import { PrOpenButton } from '../../../PrLink';
import { TINTED_PILL_EDGE, TINTED_PILL_FILL } from '../../../Pill';
import { ChangesRailSection } from './ChangesRailSection';
import { prFixCount } from '../../../../hooks/usePrChecks';
import type { PRCheck, PRChecks, Task } from '../../../../../shared/types';

/** A content-sized body never takes more than this; it scrolls past it. */
const BODY_MAX_PX = 240;

// What every row shares. `group/pr-row` is the name ROW_LINK_ICON_CLASS keys
// on, so it lives in one place.
const ROW_BASE_CLASS = 'group/pr-row w-full flex items-center gap-2 px-2 rounded text-xs text-left hover:bg-surface-hover transition-colors';
const ROW_CLASS = `${ROW_BASE_CLASS} py-1.5 text-fg-secondary hover:text-fg`;
/** The passed line: one row for every passed check, a step quieter than the rows above it. */
const PASSED_ROW_CLASS = `${ROW_BASE_CLASS} py-1 text-fg-muted hover:text-fg-secondary`;

/**
 * A row's open-in-browser hint. The row is the control and is always on screen;
 * the icon only says where its click goes, so it shows while the pointer or
 * keyboard focus is on the row. The section header's open button is the one
 * icon that is always drawn. The group is NAMED: the task window above is a
 * plain `group` too, and an unnamed variant lit every row's icon whenever the
 * pointer was anywhere in the window.
 */
const ROW_LINK_ICON_CLASS = 'ml-auto flex-shrink-0 opacity-0 group-hover/pr-row:opacity-60 group-focus-visible/pr-row:opacity-60';

function openExternal(url: string): void {
  if (url) window.electronAPI.shell.openExternal(url);
}

/** The check's own name, with its workflow faint in front ("CI / UI Test (10/11)"). */
function CheckName({ check }: { check: PRCheck }) {
  return (
    <span className="min-w-0 truncate">
      {check.group && <span className="text-fg-faint">{check.group} / </span>}
      {check.name}
    </span>
  );
}

function CheckRow({ check, glyph }: { check: PRCheck; glyph: ReactNode }) {
  const { t } = useLingui();
  const name = check.name;
  return (
    <Tooltip label={t`Open ${name} in browser`}>
      <button
        type="button"
        className={ROW_CLASS}
        onClick={() => openExternal(check.url)}
        data-testid="changes-pr-row"
        data-check-status={check.status}
      >
        {glyph}
        <CheckName check={check} />
        <ExternalLink size={11} className={ROW_LINK_ICON_CLASS} aria-hidden="true" />
      </button>
    </Tooltip>
  );
}

/**
 * The section header's check progress, shown while nothing needs fixing:
 * passed of total (skipped checks count in neither), drawn in CountBadge's
 * tinted-pill fill and edge but not through CountBadge, which takes a number,
 * not a glyph and a ratio. One glyph says the result without colour: a spinner
 * while checks run and none failed, a cross the moment any fails (even
 * mid-run), a check when all passed.
 */
export function ChecksProgressBadge({ checks }: { checks: PRCheck[] }) {
  const counted = checks.filter((check) => check.status !== 'skipped');
  if (counted.length === 0) return null;
  const passed = counted.filter((check) => check.status === 'passed').length;
  const failed = counted.some((check) => check.status === 'failed');
  const pending = counted.some((check) => check.status === 'pending');
  const tone = failed ? 'text-red-400' : pending ? 'text-fg-muted' : 'text-green-400';
  const state = failed ? 'failed' : pending ? 'pending' : 'passed';
  return (
    <span
      className={`inline-flex h-[18px] flex-shrink-0 items-center gap-[3px] rounded-full border px-1.5 text-[11px] font-semibold leading-none tabular-nums select-none ${tone}`}
      style={{ backgroundColor: TINTED_PILL_FILL, borderColor: TINTED_PILL_EDGE }}
      data-testid="changes-pr-progress"
      data-progress-state={state}
    >
      {failed
        ? <CircleX size={10} className="flex-shrink-0" aria-hidden="true" />
        : pending
          ? <LoaderCircle size={10} className="flex-shrink-0 animate-spin" aria-hidden="true" />
          : <Check size={10} className="flex-shrink-0" aria-hidden="true" />}
      <span className="[text-box:trim-both_cap_alphabetic]">{passed}/{counted.length}</span>
    </span>
  );
}

interface ChangesPullRequestSectionProps {
  task: Task;
  checks: PRChecks | null;
  open: boolean;
  onToggle: () => void;
  sending: boolean;
  onSend: () => void;
}

/**
 * The Changes rail's Pull request section, above History, shown for every live
 * task with a linked PR. It is where the pull request lives in this panel: no
 * PR pill is drawn in the panel header.
 *
 * The header reads "Pull request", then ONE count: the same red badge as the
 * task window's Changes button while there is something to fix (each failed
 * check, plus a conflict), otherwise the checks' progress. The button at its
 * right end opens the PR, collapsed or not.
 *
 * One tier of rows: the conflict, the failed checks, Send to agent under them,
 * the running checks, then the passed ones as a single line that opens the PR's
 * checks page. Every row opens its own page. Rows are flat until hovered, like
 * the file and History rows. A PR with no checks and no conflict has nothing to
 * open, so its header stands alone.
 */
export function ChangesPullRequestSection({ task, checks, open, onToggle, sending, onSend }: ChangesPullRequestSectionProps) {
  const { t } = useLingui();
  const all = checks?.checks ?? [];
  const failed = all.filter((check) => check.status === 'failed');
  const pending = all.filter((check) => check.status === 'pending');
  const passedCount = all.filter((check) => check.status === 'passed').length;
  const conflicting = task.pr_merge_readiness === 'conflicting';
  const base = task.base_branch;
  const canSend = failed.length > 0 || conflicting;
  // The Changes button's own count, so the two can never disagree.
  const prFixes = prFixCount(task, checks);
  const failedGlyph = <CircleX size={12} className="flex-shrink-0 text-red-400" aria-hidden="true" />;
  const pendingGlyph = <LoaderCircle size={12} className="flex-shrink-0 animate-spin text-fg-muted" aria-hidden="true" />;

  return (
    <ChangesRailSection
      open={open}
      onToggle={onToggle}
      label={<Trans>Pull request</Trans>}
      trailing={prFixes > 0 ? (
        <>
          {/* The button's badge, repeated: the same shape and number is what
              ties the count up there to the rows down here. */}
          <span aria-hidden="true" className="flex flex-shrink-0">
            <CountBadge count={prFixes} variant="solid" size="xs" tone="danger" testId="changes-pr-fix-count" />
          </span>
          <span className="sr-only">{t`${plural(prFixes, { one: '# thing on the PR to fix', other: '# things on the PR to fix' })}`}</span>
        </>
      ) : <ChecksProgressBadge checks={all} />}
      actions={task.pr_url ? (
        <PrOpenButton
          prUrl={task.pr_url}
          prNumber={task.pr_number}
          prState={task.pr_state}
          prMergeReadiness={task.pr_merge_readiness}
          taskId={task.id}
          testId="changes-pr-open"
          // Right-aligned with a 12px inset: the icon sits in the rows' own
          // icon column (their 4px gutter plus 8px padding), in the narrowest
          // button that still clears it.
          className="h-full w-7 flex-shrink-0 justify-end pr-3"
        />
      ) : undefined}
      collapsible={all.length > 0 || conflicting}
      testIdPrefix="changes-pr"
      bodyHeight="content"
      maxBodyHeight={BODY_MAX_PX}
    >
      <div className="flex flex-col gap-0.5 px-1 pb-1.5 pt-0.5" data-testid="changes-pr-body">
        {conflicting && task.pr_url && (
          <Tooltip label={t`Open the pull request in browser`}>
            <button
              type="button"
              className={ROW_CLASS}
              onClick={() => openExternal(task.pr_url ?? '')}
              data-testid="changes-pr-conflict"
            >
              <GitMergeConflict size={12} className="flex-shrink-0 text-red-400" aria-hidden="true" />
              <span className="min-w-0 truncate">
                {base ? <Trans>Conflicts with {base}</Trans> : <Trans>Conflicts with the base branch</Trans>}
              </span>
              <ExternalLink size={11} className={ROW_LINK_ICON_CLASS} aria-hidden="true" />
            </button>
          </Tooltip>
        )}
        {failed.map((check) => <CheckRow key={check.id} check={check} glyph={failedGlyph} />)}
        {canSend && (
          // As wide as the rows above it, in the app's muted secondary fill: it
          // is the action for those rows, and it closes the fixes before the
          // checks begin. Never an accent fill, which read as the whole
          // window's primary action.
          <div className="flex py-1">
            <button
              type="button"
              onClick={onSend}
              disabled={sending}
              className="w-full inline-flex h-[26px] items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-edge/50 bg-surface-hover/30 px-2.5 text-xs text-fg-secondary transition-colors hover:border-edge hover:bg-surface-hover hover:text-fg disabled:cursor-default disabled:opacity-60 disabled:hover:border-edge/50 disabled:hover:bg-surface-hover/30 disabled:hover:text-fg-secondary"
              data-testid="changes-pr-send"
            >
              {sending
                ? <LoaderCircle size={12} className="flex-shrink-0 animate-spin" aria-hidden="true" />
                : <Send size={12} className="flex-shrink-0 opacity-70" aria-hidden="true" />}
              {sending ? <Trans>Sending...</Trans> : <Trans>Send to agent</Trans>}
            </button>
          </div>
        )}
        {pending.map((check) => <CheckRow key={check.id} check={check} glyph={pendingGlyph} />)}
        {passedCount > 0 && checks && (
          <Tooltip label={t`Open all checks in browser`}>
            <button
              type="button"
              className={PASSED_ROW_CLASS}
              onClick={() => openExternal(checks.checksPageUrl)}
              data-testid="changes-pr-passed"
            >
              <Check size={12} className="flex-shrink-0 text-green-400" aria-hidden="true" />
              <span><Trans>{passedCount} passed</Trans></span>
              <ExternalLink size={11} className={ROW_LINK_ICON_CLASS} aria-hidden="true" />
            </button>
          </Tooltip>
        )}
      </div>
    </ChangesRailSection>
  );
}
