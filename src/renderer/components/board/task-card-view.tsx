import React, { useCallback, useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Loader2, CirclePause, Paperclip, Globe } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import { formatRelativeTime } from '../../lib/datetime';
import { stripMarkdown } from '../../utils/strip-markdown';
import { useSessionStore } from '../../stores/session-store';
import { useConfigStore } from '../../stores/config-store';
import { useProjectStore } from '../../stores/project-store';
import { useTaskProgress } from '../../utils/task-progress';
import { useNow } from '../../hooks/useNow';
import { isContextOccupancyKnown, contextWindowDisplayPercent } from '../../utils/format-tokens';
import { requiresUserInteraction, isActive } from '../../../shared/activity-state';
import { ActivityMark } from '../ActivityMark';
import { ContextUsageFooter } from './ContextUsageFooter';
import { CardMessageTrail, EXCERPT_CLAMP_CLASS, excerptLinesFor, trailModeFor } from './CardMessageTrail';
import { LabelPills } from '../Pill';
import { PrLink } from '../PrLink';
import type {
  ActivityReason, AgentLiveTelemetryUnsupported, AppConfig, AssistantMessageTrailEntry, SessionDisplayState, Task,
} from '../../../shared/types';
import { activityReasonIcon } from './ActivityReasonTooltip';
import { formatActivityReasonText } from './activity-reason-text';
import { agentActivityMark, type AgentActivityMarkName } from './agent-wait';
import { Tooltip } from '../Tooltip';
import { AutomationsDisabledStrip } from './AutomationsDisabledStrip';
import { canTaskRunAutomations } from '../../../shared/automation-manifest';

/**
 * What a task card shows, shared by the board's `TaskCard` and the Workflows
 * canvas's card. One body, two hosts: the board wraps it in a sortable,
 * menu-bearing root; the canvas wraps it in a selectable node with the
 * workflow strip on top. Parity between the two is by construction, not by
 * copying.
 */

/**
 * The card's bottom bar, in the ONE shape every populated state shares: a label row,
 * `mb-1.5`, and an `h-1` track - structurally identical to `ContextUsageFooter`.
 *
 * Height is the thing that matters here. dnd-kit runs a ResizeObserver that is live
 * only while a drag is in flight, and `useSortable` asks it to re-measure every card
 * BELOW a resized one in the lane. So a card that grows as its agent spawns stalls
 * the pointer for a frame - which showed up as a brief hitch right at the moment
 * "Creating worktree..." gave way to a live agent. Rendering the same skeleton for
 * preparing, queued, suspended and running means that transition costs no layout at
 * all, which is what lets session updates apply during a drag instead of being
 * frozen until the drop.
 *
 * The track is inert here (an empty groove); only the running state fills it, via
 * `ContextUsageFooter`.
 *
 * `tip` is the full status label, which the bar truncates. The label is already on the
 * span as text, so a screen reader hears it there and the tip describes nothing.
 *
 * `divider` matches `ContextUsageFooter`'s, and the card passes both the same value so a
 * footer that turns from one into the other keeps its height.
 */
export function CardStatusBar({
  children, testId, tip, divider = true,
}: { children: React.ReactNode; testId: string; tip?: string; divider?: boolean }) {
  return (
    <div className={divider ? 'mt-2 pt-2 border-t border-edge' : 'mt-2'} data-testid={testId}>
      <div className="flex items-center justify-between mb-1.5">
        <Tooltip label={tip ?? ''} describe={false}>
          <span className="text-xs text-fg-faint flex items-center gap-1 min-w-0">
            {children}
          </span>
        </Tooltip>
      </div>
      <div className="w-full h-1 bg-surface-hover rounded-full overflow-hidden" />
    </div>
  );
}

/**
 * A workflow task's footer while it waits in To Do: "Blocked by #413...",
 * "Queued..." or "Paused", on its board card and its canvas card alike.
 *
 * The glyph is the spinner's, held still. A task waiting on another is not
 * loading anything, and at workflow scale it is the costly part: 90 spinning
 * footers on a 100-card canvas made a pan miss 143 of about 500 refreshes,
 * against 7 with the spinners still (`scripts/drag-perf-rig.mjs`, W100).
 */
export function WorkflowWaitingBar({ label, paused }: { label: string; paused: boolean }) {
  return (
    <CardStatusBar testId="workflow-status-bar" tip={label}>
      {paused ? <CirclePause size={12} className="shrink-0" /> : <Loader2 size={12} className="shrink-0" />}
      <span className="truncate">{label}</span>
    </CardStatusBar>
  );
}

export interface TaskCardViewModel {
  sessionId: string | undefined;
  isHighlighted: boolean;
  isResuming: boolean;
  activityReason: ActivityReason | undefined;
  displayState: SessionDisplayState;
  browserAlive: boolean;
  /** A running session waiting on the user (idle or permission). */
  isIdle: boolean;
  /** A running session whose agent is working. */
  isThinking: boolean;
  /**
   * The mark the title row draws while `isIdle` or `isThinking`: the working
   * ring, or the envelope, bubble or shield for a finished turn, a question
   * and an approval (`agentActivityMark`).
   */
  activityMark: AgentActivityMarkName;
  shownTrail: AssistantMessageTrailEntry[] | null;
  trailMode: ReturnType<typeof trailModeFor>;
  labelColors: Record<string, string>;
  taskLabels: string[];
  archivedRelativeTime: string | null;
  cardDensity: AppConfig['cardDensity'];
  showTaskNumbers: boolean;
  /** Set when the task's agent streams no live telemetry, so its footer never waits on a model. */
  liveTelemetryUnsupported: AgentLiveTelemetryUnsupported | undefined;
}

/**
 * An agent's declared lack of live telemetry (`liveTelemetryUnsupported`, owned by
 * its adapter), read from the installed agents list. A generic capability, so a
 * card never branches on the agent's name.
 */
export function useLiveTelemetryUnsupported(agentName: string | null | undefined): AgentLiveTelemetryUnsupported | undefined {
  return useConfigStore((state) => (agentName
    ? state.agentList.find((agent) => agent.name === agentName)?.liveTelemetryUnsupported
    : undefined));
}

/** The live state a card reads for one task: its session, activity, trail, and the card settings. */
export function useTaskCardViewModel(task: Task): TaskCardViewModel {
  // A single `useShallow`-gated selector replaces five individual subscriptions.
  // Scaling: 100 cards × 5 subs each = 500 selector invocations per session-store
  // update; with one selector it drops to 100, and shallow equality still skips
  // re-renders when the projected object hasn't actually changed. The message
  // trail rides here for the same reason: main pushes a session's trail array
  // only when a line is new, so its reference is stable between pushes and the
  // shallow compare skips every other card's write.
  const { sessionId, isHighlighted, isResuming, activityReason, messageTrail } = useSessionStore(
    useShallow(
      useCallback(
        (s: ReturnType<typeof useSessionStore.getState>) => {
          const resolvedSessionId = s._sessionByTaskId.get(task.id)?.id;
          return {
            sessionId: resolvedSessionId,
            isHighlighted: !!resolvedSessionId && resolvedSessionId === s.activeSessionId,
            isResuming: s._sessionByTaskId.get(task.id)?.resuming ?? false,
            activityReason: resolvedSessionId ? s.sessionActivityReason[resolvedSessionId] : undefined,
            messageTrail: resolvedSessionId ? s.sessionMessageTrails[resolvedSessionId] : undefined,
          };
        },
        [task.id],
      ),
    ),
  );
  const displayState = useTaskProgress(task.id, sessionId);
  // A browser is running for this task, in ANY state: showing, hidden behind
  // the terminal, parked in a closed window, or OFFSCREEN (main's fallback
  // when no pane can mount). The last two have no pill anywhere on screen,
  // which is why the card carries this - an offscreen surface with no globe is
  // a browser the user cannot know about, let alone close.
  const browserAlive = useSessionStore(
    (s) => s.browserGuestTasks.has(task.id) || s.browserOffscreenTasks.has(task.id),
  );

  // Label display config. Wrap the `?? {}` / `?? []` fallbacks in useMemo so
  // they return a stable reference; otherwise a fresh empty object/array each
  // render defeats LabelPills' React.memo for label-less / archived cards.
  const labelColorsRaw = useConfigStore((state) => state.config.backlog?.labelColors);
  const labelColors = useMemo(() => labelColorsRaw ?? {}, [labelColorsRaw]);
  const taskLabels = useMemo(() => task.labels ?? [], [task.labels]);
  // Memoized so it recomputes only when archived_at changes, not on every
  // unrelated re-render of the card.
  const archivedRelativeTime = useMemo(
    () => (task.archived_at ? formatRelativeTime(task.archived_at) : null),
    [task.archived_at],
  );
  const cardDensity = useConfigStore((state) => state.config.cardDensity);
  const showTaskNumbers = useConfigStore((state) => state.config.showTaskNumbers);
  const cardPreview = useConfigStore((state) => state.config.cardPreview);
  // The task's agent, or the project's default when the task names none: the
  // same resolution the task detail's context bar makes for the same question.
  const projectDefaultAgent = useProjectStore((state) => state.currentProject?.default_agent ?? null);
  const liveTelemetryUnsupported = useLiveTelemetryUnsupported(task.agent ?? projectDefaultAgent);
  // `messageTrail` (from the shared selector above) is the session's agent
  // message trail as main pushes it on change. NEVER fetched here: a board
  // renders every card at once, and a per-card transcript read is the one way
  // this feature ships broken. Falls back to the description while a task has
  // no session or its agent has not said anything yet, so the default setting
  // never blanks a card.
  //
  // RUNNING is a condition of showing it at all, not just of styling it. A trail
  // deliberately outlives its session ("a paused or exited card keeps what its
  // agent last said", `message-trail-tracker.ts`), and this card only ever tested
  // that the trail was non-empty, so a paused, exited or Done card printed agent
  // prose in the description's slot with no activity mark and no progress bar to
  // say who wrote it. Gating on `running` makes the trail and the mark one
  // signal: if there is a glyph in the title row, there is agent output below it.
  // Idle and permission count as running - an agent waiting on you is still on
  // the task - which is why this reads `kind`, not the activity bucket.
  const trailMode = trailModeFor(cardPreview);
  const isLive = displayState.kind === 'running';
  const shownTrail = trailMode && isLive && messageTrail && messageTrail.length > 0 ? messageTrail : null;

  // A running session is in one of three states (idle, thinking, permission).
  // See task-progress.ts for how the fallback is resolved. The idle-vs-active
  // bucketing (permission grouped with idle as "needs attention") lives in
  // shared/activity-state.ts so every consumer agrees.
  const isIdle = displayState.kind === 'running' && requiresUserInteraction(displayState.activity);
  const isThinking = displayState.kind === 'running' && isActive(displayState.activity);
  // Which of the waits the agent is in, so a question, an approval and a
  // finished turn each draw their own mark (`agent-wait.ts`).
  const activityMark = agentActivityMark(displayState.kind === 'running' ? displayState.activity : undefined, activityReason);

  // One object per change, not per render, so a host can skip re-rendering the
  // card's content when nothing in it changed (`TaskCard` does, through every
  // re-render a board drag forces on it). Every field is a primitive or a
  // reference its own source keeps stable.
  return useMemo(
    () => ({
      sessionId,
      isHighlighted,
      isResuming,
      activityReason,
      displayState,
      browserAlive,
      isIdle,
      isThinking,
      activityMark,
      shownTrail,
      trailMode,
      labelColors,
      taskLabels,
      archivedRelativeTime,
      cardDensity,
      showTaskNumbers,
      liveTelemetryUnsupported,
    }),
    [
      sessionId, isHighlighted, isResuming, activityReason, displayState, browserAlive, isIdle, isThinking,
      activityMark, shownTrail, trailMode, labelColors, taskLabels, archivedRelativeTime, cardDensity,
      showTaskNumbers, liveTelemetryUnsupported,
    ],
  );
}

/**
 * The full card's frame: padding by density and the border that carries its
 * state (highlighted, waiting on the user). The host adds its own cursor and
 * selection treatment. Reads only the two state flags, so a host with no
 * `TaskCardViewModel` (the Agent Monitor's card) draws the same frame.
 */
export function taskCardFrameClass(
  view: Pick<TaskCardViewModel, 'isHighlighted' | 'isIdle'>,
  density: AppConfig['cardDensity'],
): string {
  const padding = density === 'comfortable' ? 'p-3' : 'p-2.5';
  const border = view.isHighlighted
    ? 'border-[2px] border-fg-faint/60'
    : view.isIdle ? 'border-edge/40' : 'border-edge hover:border-edge-input';
  return `border rounded-md ${padding} bg-surface-raised ${border}`;
}

/**
 * Subtle, muted `#N` (display_id) matching the task-detail header format. Right-aligned
 * and shrink-0 so a long title truncates before the number. Shared with the Agent
 * Monitor's card and list row; each host gates it on the Ticket Numbers setting.
 */
export function TicketNumber({ displayId, testId, className = '' }: { displayId: number; testId: string; className?: string }) {
  return (
    <span className={`shrink-0 font-mono text-xs text-fg-muted ${className}`} data-testid={testId}>
      #{displayId}
    </span>
  );
}

/** The board's ticket number, rendered only when the board's Ticket Numbers setting is on. */
function DisplayIdBadge({ task, view, hidden }: { task: Task; view: TaskCardViewModel; hidden?: boolean }) {
  if (!view.showTaskNumbers || hidden) return null;
  return <TicketNumber displayId={task.display_id} testId="task-card-display-id" />;
}

/**
 * A solid green globe at the far RIGHT of the title row, after the ticket number,
 * at the badge's scale (12). Four cuts were compared side by side on a live board,
 * and the two decisions that survived are:
 *   - PLACEMENT: right cluster, not beside the activity mark. That slot is the
 *     agent's state; a globe there competed with the activity ring and shifted
 *     every title's start. Placement is also what makes green safe here - green
 *     next to the ring's green lost its identity, but past the title and the
 *     ticket number it reads as its own thing.
 *   - NO running dot, unlike the pill: the pill is persistent chrome (always
 *     rendered, so it needs a marker to say whether a guest is behind it), while
 *     this globe renders ONLY while a guest is running - its presence IS the
 *     signal, and at 12px the dot was a smudge on the glyph rather than a second
 *     reading.
 * Solid, not pulsing: a running guest is a steady fact, and a pulse on every such
 * card is motion the board does not need. Whether the agent is DRIVING the page is
 * shown in the pane. Not a click target: the card's own click opens the task,
 * where the kebab's "Close browser" is. Shared with the Agent Monitor's card.
 */
export function BrowserAliveGlobe({ testId }: { testId: string }) {
  const { t } = useLingui();
  return (
    <Tooltip label={t`Browser running for the agent. Close it from the task menu to free memory.`}>
      <span className="text-active shrink-0 flex" data-testid={testId}>
        <Globe size={12} aria-label={t`Browser running`} />
      </span>
    </Tooltip>
  );
}

/** A card footer's state while there is no model and context to show yet, or no live agent. */
export type PendingFooterState = 'starting' | 'resuming' | 'queued' | 'paused';

/**
 * The footer for a session that has no model to report: starting or resuming
 * (spinning), queued (spinning), or paused. One home for the words, shared by the
 * board card and the Agent Monitor's card, in the same skeleton as the running
 * footer so the card keeps its height when one gives way to the other.
 */
export function PendingFooter({ state, divider, testId }: { state: PendingFooterState; divider: boolean; testId?: string }) {
  if (state === 'paused') {
    return (
      <CardStatusBar testId={testId ?? 'status-bar'} divider={divider}>
        <CirclePause size={12} className="shrink-0" />
        <Trans context="Agent status">Paused</Trans>
      </CardStatusBar>
    );
  }
  if (state === 'queued') {
    return (
      <CardStatusBar testId={testId ?? 'status-bar'} divider={divider}>
        <Loader2 size={12} className="animate-spin shrink-0" />
        <Trans>Queued...</Trans>
      </CardStatusBar>
    );
  }
  return (
    <CardStatusBar testId={testId ?? 'usage-bar'} divider={divider}>
      <Loader2 size={12} className="animate-spin shrink-0" />
      <span className="truncate">{state === 'resuming' ? <Trans>Resuming agent...</Trans> : <Trans>Starting agent...</Trans>}</span>
    </CardStatusBar>
  );
}

/**
 * The footer for an agent whose CLI streams no live telemetry: its adapter's own
 * label and tip in place of a "Starting agent..." spinner that would never end,
 * as the task detail's context bar shows it.
 */
function TelemetryUnavailableFooter({ unsupported, divider, testId }: {
  unsupported: AgentLiveTelemetryUnsupported;
  divider: boolean;
  testId?: string;
}) {
  return (
    <CardStatusBar testId={testId ?? 'usage-bar'} tip={unsupported.unavailableTitle} divider={divider}>
      <span className="truncate">{unsupported.unavailableLabel}</span>
    </CardStatusBar>
  );
}

/**
 * The footer for a running session whose model is not known yet. An agent with
 * no telemetry channel never reports one, so it gets its adapter's label; any
 * other agent spins until the name arrives. Shared by the board card and the
 * Agent Monitor's card, so the two make this call the same way.
 */
export function NoModelFooter({ liveTelemetryUnsupported, resuming, divider, testId }: {
  liveTelemetryUnsupported: AgentLiveTelemetryUnsupported | undefined;
  resuming: boolean;
  divider: boolean;
  testId?: string;
}) {
  if (liveTelemetryUnsupported) {
    return <TelemetryUnavailableFooter unsupported={liveTelemetryUnsupported} divider={divider} testId={testId} />;
  }
  return <PendingFooter state={resuming ? 'resuming' : 'starting'} divider={divider} testId={testId} />;
}

interface TaskCardBodyProps {
  task: Task;
  view: TaskCardViewModel;
  density: AppConfig['cardDensity'];
  /** A task that does not exist yet (a planned workflow task) has no number to show. */
  hideDisplayId?: boolean;
  /**
   * What the footer says while the task has no session. The board shows
   * nothing there; a workflow card says why its task has not started
   * ("Blocked by #413...", "Queued...").
   */
  idleFooter?: React.ReactNode;
  /**
   * The host draws the "Automations paused" strip itself: a workflow card
   * stacks it over its workflow strip, in one bleed wrapper.
   */
  hostDrawsAutomationsStrip?: boolean;
}

/** The full card's content, inside whichever root the host draws. */
export function TaskCardBody({ task, view, density, hideDisplayId, idleFooter, hostDrawsAutomationsStrip }: TaskCardBodyProps) {
  // The rule above the footer closes what sits over it, and the agent's output
  // well already closes itself with its own edge. Labels and a plain
  // description (a paused card, or the card preview turned off) keep it, or
  // the description's grey runs straight into the footer's.
  const footerDivider = !(view.shownTrail && view.trailMode && view.taskLabels.length === 0);
  return (
    <>
      {!hostDrawsAutomationsStrip && !canTaskRunAutomations(task).ok && <AutomationsDisabledStrip density={density} />}
      <TaskCardBodyContent task={task} view={view} density={density} hideDisplayId={hideDisplayId} idleFooter={idleFooter} />
      {/* Bottom bar -- exhaustive switch on display state */}
      {density !== 'compact' && <TaskCardFooter view={view} idleFooter={idleFooter} divider={footerDivider} />}
    </>
  );
}

/** How often a waiting card re-reads the clock for its elapsed time: the text shows seconds. */
const WAIT_ELAPSED_TICK_MS = 1000;

interface TitleRowActivityMarkProps {
  activityMark: AgentActivityMarkName;
  activityReason: TaskCardViewModel['activityReason'];
  isIdle: boolean;
  isThinking: boolean;
}

/**
 * The title row's mark and its tip. A card that waits on the user (a finished
 * turn, a question, an approval) says how long it has waited, so it re-reads the
 * clock every second, here only: the tick re-renders this mark and its tip, never
 * the rest of the card. Before, the time was read when the card rendered, and a
 * card that sat waiting did not render again, so its tip kept saying "for 0s".
 * One component in both states, so the slot never swaps element types.
 */
function TitleRowActivityMark({ activityMark, activityReason, isIdle, isThinking }: TitleRowActivityMarkProps) {
  const { t } = useLingui();
  const now = useNow(WAIT_ELAPSED_TICK_MS, isIdle && Boolean(activityReason));
  // Read once per render: the mark's name and its tip must match. A wait that
  // began after the last tick reads "0s" until the next one, at most a second.
  const reasonText = activityReason ? formatActivityReasonText(activityReason, now) : '';
  return (
    <Tooltip label={reasonText} icon={activityReason ? activityReasonIcon(activityReason) : undefined}>
      <ActivityMark
        mark={activityMark}
        size={16}
        className={`${isThinking ? 'text-active' : 'text-attention'} shrink-0`}
        aria-label={reasonText !== ''
          ? reasonText
          : isThinking ? t({ message: 'Thinking', context: 'Agent status' }) : t({ message: 'Idle', context: 'Agent status' })}
      />
    </Tooltip>
  );
}

function TaskCardBodyContent({ task, view, density, hideDisplayId, idleFooter }: TaskCardBodyProps) {
  const { displayState, isIdle, isThinking, activityMark, activityReason, shownTrail, trailMode } = view;
  const isCompactDensity = density === 'compact';
  // The description slot's clamp per density. Compact used to print no excerpt
  // at all; it now always shows exactly one line, so a compact board still says
  // what each agent is doing. Shared with the monitor card through
  // `excerptLinesFor`, so the two surfaces cannot clamp differently.
  const excerptLines = excerptLinesFor(density);

  return (
    <>
      {/* `data-card-title-row`: the board's links overlay puts a card's ports on this row. */}
      <div className="flex items-center gap-1.5" data-card-title-row>
        {/* ONE slot, not two conditional siblings.
            These were `{isIdle && <ActivityMark .../>}{isThinking && <ActivityMark .../>}`,
            which React reconciles positionally: idle owned child index 0 and working index 1,
            so every idle<->thinking flip was a delete at one index plus a create at the other.
            That unmounted the whole <svg>, re-injected `MARK_INNER` into a fresh <g>, and
            restarted the `.kng-march` dash from zero - the indicator visibly "resetting"
            rather than marching. One slot lets React reuse the fiber, so a working->working
            update never touches the DOM and only a genuine state change re-injects.
            The engine's reason, when it has one, is both the mark's name and its tip,
            led by the reason's own glyph. The tip repeats the name, so a screen reader
            hears it once. A wait on the user swaps the mark's shape (envelope, bubble,
            shield) inside this same slot, which is a mark flip, not an element swap. */}
        {(isIdle || isThinking) && (
          <TitleRowActivityMark
            activityMark={activityMark}
            activityReason={activityReason}
            isIdle={isIdle}
            isThinking={isThinking}
          />
        )}
        <div className="text-sm text-fg font-medium truncate flex-1 min-w-0">{task.title}</div>
        <DisplayIdBadge task={task} view={view} hidden={hideDisplayId} />
        {/* Placement and treatment are documented on `BrowserAliveGlobe`. */}
        {view.browserAlive && <BrowserAliveGlobe testId="task-card-browser-alive" />}
      </div>

      {!isCompactDensity && task.pr_url && (
        <div className="flex items-center gap-2 mt-1.5">
          <PrLink
            prUrl={task.pr_url}
            prNumber={task.pr_number}
            prState={task.pr_state}
            prMergeReadiness={task.pr_merge_readiness}
            testId="task-card-pr-link"
          />
        </div>
      )}

      {/* One tone for every line, the `text-fg-muted` the newest line already
          had. Nothing on this card gets brighter or dimmer than it is today;
          the well is what says the agent wrote this. */}
      {shownTrail && trailMode ? (
        <div className="mt-1">
          <CardMessageTrail entries={shownTrail} lines={excerptLines} mode={trailMode} lineClass="text-fg-muted" terminal />
        </div>
      ) : task.description ? (
        <div className={`text-xs text-fg-faint mt-1 ${EXCERPT_CLAMP_CLASS[excerptLines]}`} data-testid="task-card-description">{stripMarkdown(task.description)}</div>
      ) : null}

      <div className={isCompactDensity ? 'mt-1' : 'mt-1.5'}>
        <LabelPills labels={view.taskLabels} labelColors={view.labelColors} />
      </div>

      {!isCompactDensity && task.attachment_count > 0 && displayState.kind === 'none' && !idleFooter && (
        <div className="flex items-center gap-1.5 mt-2 pt-2 border-t border-edge">
          <Paperclip size={15} className="text-fg-faint" />
          <span className="text-xs text-fg-faint">{task.attachment_count}</span>
        </div>
      )}
    </>
  );
}

function TaskCardFooter({ view, idleFooter, divider }: { view: TaskCardViewModel; idleFooter?: React.ReactNode; divider: boolean }) {
  const { displayState, isResuming, liveTelemetryUnsupported } = view;
  switch (displayState.kind) {
    case 'running': {
      // Footer model label is the human name (e.g. "Opus 4.8"). We
      // deliberately do NOT fall back to the raw configured model id
      // (e.g. "claude-opus-4-8") - a user doesn't know what that means.
      // Until a name is known, show the loading spinner. The name (and
      // live context %) arrives from status.json once the CLI paints,
      // or - for a background (never-opened) session that never paints -
      // from the transcript-watch fallback (Claude's runtime.sessionHistory),
      // plus the spawn-time model seed as an immediate placeholder.
      const resolvedModelName = displayState.usage?.model.displayName || null;
      if (!resolvedModelName) {
        return <NoModelFooter liveTelemetryUnsupported={liveTelemetryUnsupported} resuming={isResuming} divider={divider} />;
      }
      // Always render the full bar layout (model + percent + track) once
      // the model name is known, so the card height is STABLE - the bar
      // does not mount in later and shove the card taller (the boot-window
      // jank). The bar sits at 0% until occupancy is known: a positive
      // contextWindowSize, or a percentage-only report (Cursor interactive
      // TUI, no window and no token counts). It animates to the real value
      // when telemetry fills in. An over-budget window (usedTokens > window,
      // only reachable via Claude's authoritative status.json replace path)
      // forces the percent to a full 100 rather than hiding the bar. The
      // label is never > 100% because of this clamp, not because of the
      // render gate.
      const usage = displayState.usage;
      const occupancyKnown = !!usage && isContextOccupancyKnown(
        usage.contextWindow.contextWindowSize,
        usage.contextWindow.usedTokens,
        usage.contextWindow.usedPercentage ?? 0,
      );
      const pct = usage
        ? contextWindowDisplayPercent(
            usage.contextWindow.contextWindowSize,
            usage.contextWindow.usedTokens,
            usage.contextWindow.usedPercentage ?? 0,
          )
        : 0;
      // Shared with the Agent Monitor's card so the two footers cannot drift.
      return (
        <ContextUsageFooter
          modelName={resolvedModelName}
          percent={pct}
          windowKnown={occupancyKnown}
          divider={divider}
        />
      );
    }
    case 'preparing':
    case 'initializing':
      return (
        <CardStatusBar testId="status-bar" tip={displayState.label} divider={divider}>
          <Loader2 size={12} className="animate-spin shrink-0" />
          <span className="truncate">{displayState.label}</span>
        </CardStatusBar>
      );
    case 'queued':
      return <PendingFooter state="queued" divider={divider} />;
    case 'suspended':
      return <PendingFooter state="paused" divider={divider} />;
    case 'none':
    case 'exited':
    default:
      return idleFooter ? <>{idleFooter}</> : null;
  }
}

/**
 * The Done column's compact card content (the completed list), inside the
 * host's root. `trailing` is the host's own row control (the board's delete).
 */
export function TaskCardCompactBody({ task, view, trailing }: { task: Task; view: TaskCardViewModel; trailing?: React.ReactNode }) {
  const { shownTrail, trailMode } = view;
  return (
    <>
      <div className="flex items-center gap-2">
        <span className="text-sm text-fg-tertiary truncate flex-1" data-testid="compact-title">{task.title}</span>
        <DisplayIdBadge task={task} view={view} />
        {trailing}
      </div>
      {/* This card is dimmer overall, so its trail keeps the `text-fg-faint`
          one step above its `text-fg-disabled` description rather than the
          full card's muted tone. The well is the same either way. It marks
          agent output, and that does not get quieter because the card is.
          This path is the Done column's completed list (`DoneSwimlane`), the
          only caller that passes `compact`. It is reached only by a RUNNING
          session, and moving a task into Done suspends its agent, so in
          practice this branch draws during the move and not after it. Kept
          rather than deleted because "in practice" is not "never". The
          suspend is asynchronous, and a card that rendered a bare trail
          during that window would be the exact mismatch this change removes. */}
      {shownTrail && trailMode ? (
        <div className="mt-0.5">
          <CardMessageTrail entries={shownTrail} lines={1} mode={trailMode} lineClass="text-fg-faint" terminal />
        </div>
      ) : task.description ? (
        <div className="mt-0.5">
          <span className="text-xs text-fg-disabled truncate block" data-testid="task-card-description">{stripMarkdown(task.description)}</span>
        </div>
      ) : null}
      <div className="mt-1">
        <LabelPills labels={view.taskLabels} labelColors={view.labelColors} />
      </div>
      {task.archived_at && (
        <div className="mt-0.5">
          <span className="text-xs text-fg-disabled">
            {view.archivedRelativeTime}
          </span>
        </div>
      )}
    </>
  );
}
