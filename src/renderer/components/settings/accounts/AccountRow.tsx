import { ArrowLeftRight, Check, EllipsisVertical, GripVertical, KeyRound, LogIn, RotateCcw, Trash2, TriangleAlert } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { AgentAccount, AgentAccountStatus, AgentUsageWindowShape } from '../../../../shared/agent-accounts';
import type { RateLimitWindow } from '../../../../shared/types';
import { accountUsageLines, liveRateLimitWindows, windowElapsedPercentage, type AccountUsageLine } from '../../../utils/rate-limit-window';
import { KebabMenu, KebabMenuItem } from '../../KebabMenu';
import { Tooltip } from '../../Tooltip';
import { RATE_LIMIT_ICON, RateLimitTrack, formatResetMoment, formatResetTime } from '../../terminal/rate-limit-meter';
import { CardTile } from '../settings-card';

/** A tint of the element's own text color, for a pill's edge and fill. */
function tint(percent: number): string {
  return `color-mix(in srgb, currentColor ${percent}%, transparent)`;
}

/** The slot a row's one action sits in. Active and Switch to share it, so the right edge never shifts. */
const ACTION_SLOT_CLASS = 'inline-flex h-6 w-[88px] flex-shrink-0 items-center justify-center gap-[5px] rounded-md border text-xs';

const SWITCH_BUTTON_CLASS = `${ACTION_SLOT_CLASS} border-edge-input text-fg hover:bg-surface-hover focus:outline-none focus-visible:ring-1 focus-visible:ring-accent`;

export interface AccountRowProps {
  account: AgentAccount;
  /** New sessions start on this account now. */
  active: boolean;
  /** The agent has more than one account, so Switch to and the row's action slot mean something. */
  reorderable: boolean;
  /** The list is in the user's order (Manual, or an agent with no usage), so the row shows its grip. */
  orderEditable: boolean;
  /** The agent reports usage windows. */
  reportsUsage: boolean;
  /** The windows the agent always has; each row draws a line per window. */
  usageWindows: AgentUsageWindowShape[];
  /** Switch to also moves the agent's running sessions. False where a conversation stays on its account. */
  switchMovesSessions: boolean;
  /** The agent's accounts are key files, so its own row is what it runs on with none. */
  keyFileAgent: boolean;
  /** Epoch ms, ticked by the tab, for the reset times and the tracks' time marks. */
  now: number;
  /** Moves the account to the top and its agent's running sessions onto it. */
  onSwitchTo: () => void;
  onSignIn: () => void;
  onRemove: () => void;
}

/** How far through its window a live line is, for the tick's tip. Null when the window has no duration. */
function elapsedOfWindow(limitWindow: RateLimitWindow, now: number): number | null {
  if (limitWindow.windowDurationSeconds === undefined) return null;
  const elapsedPercentage = windowElapsedPercentage(limitWindow.resetsAt, limitWindow.windowDurationSeconds, now);
  return elapsedPercentage === null ? null : Math.round(elapsedPercentage);
}

/** A stable React key for a usage line: its window's id, or its place for the one unnamed line. */
function usageLineKey(line: AccountUsageLine, index: number): string {
  if (line.kind === 'live') return line.window.id;
  return line.shape?.id ?? `line-${index}`;
}

/**
 * One usage line: the window's name, the context bar's meter with the percent attached, and when
 * it resets. Its three cells sit in the block's shared grid, so every line's bar starts together
 * whatever the language makes of the names. A window the account has not opened reads Not started.
 */
function UsageLine({ line, now }: { line: AccountUsageLine; now: number }) {
  const { t } = useLingui();
  const shape = line.kind === 'live' ? line.window : line.shape;
  const Icon = shape ? RATE_LIMIT_ICON[shape.iconKind] : null;
  const live = line.kind === 'live' ? line.window : null;
  // The percent sits beside the bar, so the bar's tip says only what the tick marks.
  const elapsed = live ? elapsedOfWindow(live, now) : null;
  const trackTip = elapsed === null ? '' : t`${elapsed}% of the window has passed.`;
  let percentText = '-';
  if (live) percentText = `${Math.round(live.usedPercentage)}%`;
  else if (line.kind === 'not-started') percentText = '0%';
  return (
    <div className="contents" data-testid="account-usage-line" data-usage-state={line.kind}>
      <span className="flex items-center gap-1.5 whitespace-nowrap">
        {Icon ? <Icon size={11} className="flex-shrink-0 text-fg-faint" aria-hidden="true" /> : null}
        {shape ? shape.label : t`Usage`}
      </span>
      <span className="flex min-w-0 items-center gap-1.5">
        {live ? (
          <Tooltip label={trackTip}>
            <span className="flex min-w-[40px] flex-1 items-center">
              <RateLimitTrack limitWindow={live} now={now} className="w-full" />
            </span>
          </Tooltip>
        ) : (
          <RateLimitTrack limitWindow={null} now={now} className="min-w-[40px] flex-1" />
        )}
        <span className={`w-7 flex-shrink-0 text-right ${line.kind === 'not-started' ? 'text-fg-faint' : ''}`}>
          {percentText}
        </span>
      </span>
      <span className="flex items-center whitespace-nowrap pl-1.5">
        {live && live.resetsAt > 0 ? (
          <Tooltip label={formatResetTime(live.resetsAt)}>
            <span className="flex min-w-0 items-center gap-1.5">
              <RotateCcw size={11} className="flex-shrink-0 text-fg-faint" aria-hidden="true" />
              <span className="truncate">{formatResetMoment(live.resetsAt, now)}</span>
            </span>
          </Tooltip>
        ) : line.kind === 'not-started' ? (
          <span className="text-fg-faint" data-testid="account-usage-not-started">
            <Trans context="a usage window the account has not opened">Not started</Trans>
          </span>
        ) : null}
      </span>
    </div>
  );
}

/** An account that takes no new session now: not signed in, no plan, or a window at its limit. */
function isAccountSkipped(account: AgentAccount, now: number): boolean {
  if (account.status !== 'ok') return true;
  return liveRateLimitWindows(account.lastUsage ?? [], now).some((limitWindow) => limitWindow.usedPercentage >= 100);
}

/**
 * What a row draws, with no drag wiring, so the list and the drag overlay share it. The top line
 * is the account (grip where the order is the user's, name, plan, state, its one action, its
 * menu). Under it, one line per usage window the agent has.
 */
function AccountRowContent({
  account, active, reorderable, reportsUsage, usageWindows, switchMovesSessions, keyFileAgent, now, onSwitchTo, onSignIn, onRemove, grip,
}: AccountRowProps & { grip: React.ReactNode }) {
  const { t } = useLingui();
  const skipped = isAccountSkipped(account, now);
  const statusLabels: Record<Exclude<AgentAccountStatus, 'ok'>, string> = {
    'signed-out': t`Not signed in`,
    'no-subscription': t`No subscription`,
    'not-found': t`File not found`,
    'link-failed': t`History not shared`,
  };
  const keyFileName = account.keyFilePath?.split(/[\\/]/).pop() ?? null;
  // The agent's own login, before the CLI reports an email for it. A key-file agent's own login
  // reports none: it is whatever the CLI signs in with when no key file is set.
  const ownName = keyFileAgent ? t`Own sign-in` : t`Signed in on this machine`;
  // A CLI that reports no email leaves a signed-in account its folder's number to go by.
  const folderNumber = account.folderPath?.split(/[\\/]/).pop() ?? null;
  const unnamed = account.status !== 'signed-out' && folderNumber ? t`Account ${folderNumber}` : t`New account`;
  const name = account.email ?? keyFileName ?? (account.kind === 'default' ? ownName : unnamed);
  const showsUsage = reportsUsage && account.kind !== 'key-file' && account.status !== 'signed-out';
  const lines = showsUsage
    ? accountUsageLines(usageWindows, liveRateLimitWindows(account.lastUsage ?? [], now), account.lastUsage !== null)
    : [];
  // The agent's own login has nothing in the menu (it is signed in from the CLI, and cannot be
  // removed), so it gets none, signed out or not.
  const hasMenu = account.kind !== 'default';

  return (
    <>
      <div className="flex min-h-6 items-center gap-2" data-skipped={skipped ? '' : undefined}>
        {grip}
        <Tooltip label={name}>
          <span className="min-w-0 truncate text-xs font-medium text-fg" data-testid="account-name">{name}</span>
        </Tooltip>
        {account.plan ? (
          <span className="flex-shrink-0 whitespace-nowrap rounded border border-edge px-1.5 text-[11px] leading-4 text-fg-muted">
            {account.plan}
          </span>
        ) : null}
        {account.kind === 'key-file' && account.keyNames.length > 0 ? (
          <Tooltip label={account.keyNames.join(', ')}>
            <span className="flex flex-shrink-0 items-center gap-1 text-[11px] text-fg-faint">
              <KeyRound size={11} aria-hidden="true" />
              {account.keyNames.length}
            </span>
          </Tooltip>
        ) : null}
        {account.status !== 'ok' ? (
          <span
            className="inline-flex flex-shrink-0 items-center gap-1 whitespace-nowrap rounded border px-1.5 text-[11px] leading-4 text-warning"
            style={{ borderColor: tint(50), backgroundColor: tint(12) }}
          >
            <TriangleAlert size={11} strokeWidth={2.5} aria-hidden="true" />
            {statusLabels[account.status]}
          </span>
        ) : null}
        {account.historyPrivate ? (
          <Tooltip label={t`This account's folder is on another drive, so its prompt history stays its own.`}>
            <span className="flex-shrink-0 whitespace-nowrap rounded border border-edge px-1.5 text-[11px] leading-4 text-fg-muted">
              <Trans>Own prompt history</Trans>
            </span>
          </Tooltip>
        ) : null}
        <span className="flex-1" />
        {active ? (
          <span
            className={`${ACTION_SLOT_CLASS} font-medium text-active`}
            style={{ borderColor: tint(55), backgroundColor: tint(10) }}
            data-testid="account-active"
          >
            <Check size={13} strokeWidth={2.5} aria-hidden="true" />
            <Trans context="the account new sessions start on">Active</Trans>
          </span>
        ) : reorderable && account.status === 'ok' ? (
          // A deliberate switch: the account goes to the top, and running sessions move to it now
          // unless the agent's conversations stay on their account.
          <Tooltip label={switchMovesSessions ? t`Running sessions move here too` : t`Running sessions stay on their account`}>
            <button
              type="button"
              onClick={onSwitchTo}
              className={SWITCH_BUTTON_CLASS}
              data-testid="account-switch-to"
            >
              <ArrowLeftRight size={12} aria-hidden="true" />
              <Trans>Switch to</Trans>
            </button>
          </Tooltip>
        ) : null}
        {hasMenu ? (
          <KebabMenu
            label={t`Account options`}
            icon={<EllipsisVertical size={16} />}
            // 24 by 24, the canvas's size and the width the spacer below keeps on a row with no menu.
            triggerClassName="flex h-6 w-6 items-center justify-center rounded-md text-fg-muted hover:bg-surface-hover hover:text-fg focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
            triggerTestId="account-menu"
          >
            {(close) => (
              <>
                {account.status === 'signed-out' && account.kind === 'folder' ? (
                  <KebabMenuItem icon={<LogIn size={14} />} label={t`Sign in`} onClick={() => { close(); onSignIn(); }} data-testid="account-sign-in" />
                ) : null}
                {account.kind !== 'default' ? (
                  <KebabMenuItem icon={<Trash2 size={14} />} label={t`Remove`} destructive onClick={() => { close(); onRemove(); }} data-testid="account-remove" />
                ) : null}
              </>
            )}
          </KebabMenu>
        ) : reorderable ? (
          // The menu's place, kept, so every row's action ends on one edge.
          <span className="w-6 flex-shrink-0" />
        ) : null}
      </div>
      {lines.length > 0 ? (
        // The full width of the tile, set off by space alone: the card's border and the tile's
        // fill are the only layers (settings-card-design.md). One grid for every line, so the name
        // column is as wide as the longest name and the bars start together.
        <div className="mt-3 grid grid-cols-[auto_1fr_minmax(84px,auto)] items-center gap-x-2.5 gap-y-3 text-xs tabular-nums text-fg-muted">
          {lines.map((line, index) => (
            <UsageLine key={usageLineKey(line, index)} line={line} now={now} />
          ))}
        </div>
      ) : null}
    </>
  );
}

/** One account in an agent's list: a tile the user drags by its grip while the order is theirs. */
export function AccountRow(props: AccountRowProps) {
  const { t } = useLingui();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: props.account.id,
    disabled: !props.orderEditable,
  });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition: transition || undefined,
    // The row left behind while its overlay follows the pointer.
    opacity: isDragging ? 0.4 : 1,
  };
  const grip = props.orderEditable ? (
    <Tooltip label={t`Drag to reorder`}>
      {/* light-dismiss-ok: the settings panel mounts as a sibling of AppLayout's marked shell
          subtree, so a click in it resolves to no `data-dismiss-layer` scope. */}
      {/* select-none-ok: the handle draws a grip icon and no text. */}
      <div
        className="flex h-6 w-5 flex-shrink-0 cursor-grab items-center justify-center text-fg-faint hover:text-fg-muted active:cursor-grabbing"
        aria-label={t`Reorder`}
        data-testid="account-grip"
        {...attributes}
        {...listeners}
      >
        <GripVertical size={14} />
      </div>
    </Tooltip>
  ) : null;

  return (
    <CardTile ref={setNodeRef} style={style} className="flex flex-col" testId={`account-row-${props.account.id}`}>
      <AccountRowContent {...props} grip={grip} />
    </CardTile>
  );
}

/** The row as the drag overlay draws it: the same content, no drag wiring of its own. */
export function AccountRowOverlay(props: AccountRowProps) {
  return (
    <CardTile className="flex flex-col">
      <AccountRowContent
        {...props}
        grip={<span className="flex h-6 w-5 flex-shrink-0 items-center justify-center text-fg-muted"><GripVertical size={14} /></span>}
      />
    </CardTile>
  );
}
