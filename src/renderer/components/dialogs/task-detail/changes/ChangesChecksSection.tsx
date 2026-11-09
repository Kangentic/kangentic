import type { ReactNode } from 'react';
import { Check, CircleX, ExternalLink, GitMergeConflict, LoaderCircle, Send } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import { Tooltip } from '../../../Tooltip';
import { TINTED_PILL_EDGE, TINTED_PILL_FILL } from '../../../Pill';
import { ChangesRailSection } from './ChangesRailSection';
import type { PRCheck, PRChecks, Task } from '../../../../../shared/types';

/** A content-sized Checks body never takes more than this; it scrolls past it. */
const CHECKS_BODY_MAX_PX = 240;

const ROW_CLASS = 'w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs text-left text-fg-secondary hover:bg-surface-hover hover:text-fg transition-colors';

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
        data-testid="changes-checks-row"
        data-check-status={check.status}
      >
        {glyph}
        <CheckName check={check} />
        <ExternalLink size={11} className="ml-auto flex-shrink-0 opacity-60" aria-hidden="true" />
      </button>
    </Tooltip>
  );
}

/**
 * The Checks header's progress: passed of total (skipped checks count in
 * neither), drawn in CountBadge's tinted-pill fill and edge but not through
 * CountBadge, which takes a number, not a glyph and a ratio. One glyph says the result without
 * colour: a spinner while checks run and none failed, a cross the moment any
 * fails (even mid-run), a check when all passed. A conflict leaves it alone;
 * the PR pill carries that.
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
      className={`inline-flex h-[18px] items-center gap-[3px] rounded-full border px-1.5 text-[11px] font-semibold leading-none tabular-nums select-none ${tone}`}
      style={{ backgroundColor: TINTED_PILL_FILL, borderColor: TINTED_PILL_EDGE }}
      data-testid="changes-checks-progress"
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

interface ChangesChecksSectionProps {
  task: Task;
  checks: PRChecks | null;
  open: boolean;
  onToggle: () => void;
  sending: boolean;
  onSend: () => void;
}

/** Whether the Checks section has anything to show for this task: a check, or a conflict. */
export function checksSectionVisible(task: Task, checks: PRChecks | null): boolean {
  return (checks?.checks.length ?? 0) > 0 || task.pr_merge_readiness === 'conflicting';
}

/**
 * The Changes rail's Checks section, above History. One tier: the conflict
 * row, the failed checks, Send to agent under them, the running checks, then
 * the passed ones as a single line that opens the PR's checks page. Every row
 * opens its check. Rows are flat until hovered, like the file and History rows.
 */
export function ChangesChecksSection({ task, checks, open, onToggle, sending, onSend }: ChangesChecksSectionProps) {
  const { t } = useLingui();
  const all = checks?.checks ?? [];
  const failed = all.filter((check) => check.status === 'failed');
  const pending = all.filter((check) => check.status === 'pending');
  const passedCount = all.filter((check) => check.status === 'passed').length;
  const conflicting = task.pr_merge_readiness === 'conflicting';
  const base = task.base_branch;
  const canSend = failed.length > 0 || conflicting;
  const failedGlyph = <CircleX size={12} className="flex-shrink-0 text-red-400" aria-hidden="true" />;
  const pendingGlyph = <LoaderCircle size={12} className="flex-shrink-0 animate-spin text-fg-muted" aria-hidden="true" />;

  return (
    <ChangesRailSection
      open={open}
      onToggle={onToggle}
      label={<Trans>Checks</Trans>}
      trailing={<ChecksProgressBadge checks={all} />}
      testIdPrefix="changes-checks"
      bodyHeight="content"
      maxBodyHeight={CHECKS_BODY_MAX_PX}
    >
      <div className="flex flex-col gap-0.5 px-1 pb-1.5 pt-0.5" data-testid="changes-checks-body">
        {conflicting && task.pr_url && (
          <Tooltip label={t`Open the pull request in browser`}>
            <button
              type="button"
              className={ROW_CLASS}
              onClick={() => openExternal(task.pr_url ?? '')}
              data-testid="changes-checks-conflict"
            >
              <GitMergeConflict size={12} className="flex-shrink-0 text-red-400" aria-hidden="true" />
              <span className="min-w-0 truncate">
                {base ? <Trans>Conflicts with {base}</Trans> : <Trans>Conflicts with the base branch</Trans>}
              </span>
              <ExternalLink size={11} className="ml-auto flex-shrink-0 opacity-60" aria-hidden="true" />
            </button>
          </Tooltip>
        )}
        {failed.map((check) => <CheckRow key={check.id} check={check} glyph={failedGlyph} />)}
        {canSend && (
          <div className="flex px-2 py-1">
            <button
              type="button"
              onClick={onSend}
              disabled={sending}
              className="w-full inline-flex h-[26px] items-center justify-center gap-1.5 whitespace-nowrap rounded-[5px] border border-accent/30 bg-accent/15 px-2.5 text-xs text-accent-fg transition-colors hover:bg-accent/25 disabled:cursor-default disabled:opacity-60 disabled:hover:bg-accent/15"
              data-testid="changes-checks-send"
            >
              {sending
                ? <LoaderCircle size={13} className="flex-shrink-0 animate-spin" aria-hidden="true" />
                : <Send size={13} className="flex-shrink-0" aria-hidden="true" />}
              {sending ? <Trans>Sending...</Trans> : <Trans>Send to agent</Trans>}
            </button>
          </div>
        )}
        {pending.map((check) => <CheckRow key={check.id} check={check} glyph={pendingGlyph} />)}
        {passedCount > 0 && checks && (
          <Tooltip label={t`Open all checks in browser`}>
            <button
              type="button"
              className="w-full flex items-center gap-2 px-2 py-1 rounded text-xs text-left text-fg-muted hover:bg-surface-hover hover:text-fg-secondary transition-colors"
              onClick={() => openExternal(checks.checksPageUrl)}
              data-testid="changes-checks-passed"
            >
              <Check size={12} className="flex-shrink-0 text-green-400" aria-hidden="true" />
              <span><Trans>{passedCount} passed</Trans></span>
              <ExternalLink size={11} className="ml-auto flex-shrink-0 opacity-60" aria-hidden="true" />
            </button>
          </Tooltip>
        )}
      </div>
    </ChangesRailSection>
  );
}
