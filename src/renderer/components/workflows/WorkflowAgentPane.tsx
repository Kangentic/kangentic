import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { Bot, Info, Loader2, MessageSquare, PanelLeftClose, PanelLeftOpen, Play, Settings, X } from 'lucide-react';
import { isActive, requiresUserInteraction } from '../../../shared/activity-state';
import { workflowAgentChoice, workflowAgentSetupGap } from '../../../shared/workflow-agent-choice';
import { openWorkflowAgentSettings } from './open-workflow-agent-settings';
import { useSessionStore } from '../../stores/session-store';
import { selectAgentSession, useWorkflowAgentWorking } from '../../hooks/useWorkflowAgentWorking';
import { useWorkflowStore } from '../../stores/workflow-store';
import { useConfigStore } from '../../stores/config-store';
import { useTerminal } from '../../hooks/useTerminal';
import { useTerminalRefit } from '../../hooks/useTerminalRefit';
import { useDeferredTerminalInit } from '../../hooks/useDeferredTerminalInit';
import { useTerminalFileDrop } from '../../hooks/useTerminalFileDrop';
import { mayTakeArrivalFocus, type ArrivalFocusSite } from '../../utils/terminal-arrival-focus';
import { FileDropOverlay } from '../terminal/FileDropOverlay';
import { ActivityMark } from '../ActivityMark';
import { HoverTip } from '../HoverTip';
import { tipLabel } from '../../utils/hover-tip';
import { PauseButtonIcon } from '../dialogs/task-detail/TaskDetailHeader';
import { INSPECTOR_WIDTH } from './WorkflowInspector';
import { startPanelDrag } from '../../hooks/panel-drag';

/**
 * The Workflows view's left pane: the workflow's own agent (#732, boards 1b and
 * J2). Headed "Workflow agent", led by task detail's own Pause / Resume toggle,
 * since stopping it is stopping a task's agent; collapsible to a strip.
 *
 * Opening the pane on a workflow opens its agent: as it is when it has a
 * session (a paused one stays paused), otherwise started, which resumes its
 * conversation or, for a new workflow, sends the first message. It keeps
 * running when the view closes, and its terminal mounts only while the pane
 * shows it.
 *
 * Until the Workflow agent is chosen in Settings > Workflows, nothing starts:
 * the pane asks for the choice where the terminal would be, and starts the agent
 * on its own once the choice is made and Settings is closed.
 */

/**
 * The pane's width when open, until the user drags its edge: 77 columns at the
 * default terminal font (measured), room for an agent's plan without wrapping.
 */
export const WORKFLOW_AGENT_PANE_DEFAULT_WIDTH = 560;
const MIN_PANE_WIDTH = 360;
const MAX_PANE_WIDTH = 960;
/** The canvas the docked pane always leaves, beside the inspector. */
export const WORKFLOW_CANVAS_MIN_WIDTH = 400;

/** The pane's width: the dragged one, clamped, or the default. */
export function workflowAgentPaneWidth(stored: number | null | undefined): number {
  if (typeof stored !== 'number' || !Number.isFinite(stored)) return WORKFLOW_AGENT_PANE_DEFAULT_WIDTH;
  return Math.round(Math.min(MAX_PANE_WIDTH, Math.max(MIN_PANE_WIDTH, stored)));
}

/**
 * The narrowest view body the open pane takes its own width in: the pane, the
 * inspector and a canvas of 400. Narrower, it floats over the canvas.
 */
export function workflowAgentPaneDockedMin(paneWidth: number): number {
  return paneWidth + INSPECTOR_WIDTH + WORKFLOW_CANVAS_MIN_WIDTH;
}

/** The collapsed strip. */
const COLLAPSED_WIDTH = 36;

/**
 * Start-over lines the user closed, by the session that started over, for this
 * run of the app. The pane remounts on every visit to the view, and a closed
 * line stays closed. A new session (the next resume) never matches.
 */
const dismissedStartOvers = new Set<string>(); // hmr-safe: a reset only shows a closed line again, until the agent next resumes

// The plan's hold lives in its own module, so the New Task form can read it
// without importing this pane. Re-exported for the view.
export { useWorkflowAgentWorking };

/**
 * `floating`: the view is too narrow to give the pane its width (below
 * `workflowAgentPaneDockedMin`), so the open pane lies over the canvas's left
 * edge instead of taking the canvas's width, and keeps the collapsed strip's
 * place in the row.
 */
export function WorkflowAgentPane({ workflowId, floating = false }: { workflowId: string; floating?: boolean }) {
  const storedWidth = useConfigStore((state) => state.config.workflows?.agentPaneWidth);
  const updateConfig = useConfigStore((state) => state.updateConfig);
  // The width a finished drag set, held until the setting it saved comes back;
  // null otherwise, which reads the setting.
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  // Counts the width saves, so only the newest one lets go of `dragWidth`.
  const widthSaveSerialRef = useRef(0);
  const width = workflowAgentPaneWidth(dragWidth ?? storedWidth);
  const outerRef = useRef<HTMLDivElement>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  const startResize = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    const outer = outerRef.current;
    const paneElement = paneRef.current;
    if (!outer || !paneElement) return;
    const handle = event.currentTarget;
    const startX = event.clientX;
    // From the width on screen: a drag pressed while the last one's save is
    // still on its way starts where that one left the pane.
    const startWidth = workflowAgentPaneWidth(dragWidth ?? storedWidth);
    // Docked, the drag stops where the canvas would drop below its minimum, so
    // widening the pane never pushes the inspector out or turns it floating.
    const rowWidth = outer.parentElement?.getBoundingClientRect().width ?? Number.POSITIVE_INFINITY;
    const widest = floating ? MAX_PANE_WIDTH : rowWidth - INSPECTOR_WIDTH - WORKFLOW_CANVAS_MIN_WIDTH;
    let latest = startWidth;
    startPanelDrag(event, {
      cursor: 'col-resize',
      // Written to the elements, not to state, until release. A move sets the
      // width ahead of that frame's layout; as React state it would wait as a
      // pending render, which React Flow's ResizeObserver flushes in the middle
      // of the browser's observer delivery, and the pane resizing there is a
      // "ResizeObserver loop" error on every few frames of a drag.
      onMove: (moveEvent) => {
        const next = workflowAgentPaneWidth(startWidth + moveEvent.clientX - startX);
        latest = Math.max(MIN_PANE_WIDTH, Math.min(widest, next));
        paneElement.style.width = `${latest}px`;
        if (!floating) outer.style.width = `${latest}px`;
        handle.setAttribute('aria-valuenow', String(latest));
      },
      onRelease: () => {
        if (latest === startWidth) return;
        setDragWidth(latest);
        // An earlier save that lands while a later drag's save is on its way
        // leaves the width alone: letting go then would show its own width.
        widthSaveSerialRef.current += 1;
        const saveSerial = widthSaveSerialRef.current;
        // A failed save puts the stored width back, which is all a user can see of it.
        void updateConfig({ workflows: { agentPaneWidth: latest } })
          .catch((error: unknown) => console.warn('[WORKFLOW-AGENT-PANE] Could not save the pane width:', error))
          .finally(() => {
            if (widthSaveSerialRef.current === saveSerial) setDragWidth(null);
          });
      },
    });
  }, [floating, dragWidth, storedWidth, updateConfig]);
  const session = useSessionStore((state) => selectAgentSession(state.sessions, workflowId));
  const activity = useSessionStore((state) => (session ? state.sessionActivity[session.id] : undefined));
  const unavailable = useWorkflowStore((state) => state.agentUnavailable[workflowId] ?? null);
  // The conversation the workflow keeps, which outlives any one session of its agent.
  const conversationId = useWorkflowStore((state) => (
    state.summaries.find((summary) => summary.workflow.id === workflowId)?.workflow.agent_session_id ?? null
  ));
  const collapsed = useWorkflowStore((state) => state.agentPaneCollapsed);
  const setCollapsed = useWorkflowStore((state) => state.setAgentPaneCollapsed);
  const openAgent = useWorkflowStore((state) => state.openAgent);
  const resumeAgent = useWorkflowStore((state) => state.resumeAgent);
  const pauseAgent = useWorkflowStore((state) => state.pauseAgent);
  // The session main started over in when the conversation could not be
  // resumed. Main pushes the summary again when that happens, after this
  // pane's open has answered.
  const startedOverSessionId = useWorkflowStore((state) => (
    state.summaries.find((summary) => summary.workflow.id === workflowId)?.agent?.startedOverSessionId ?? null
  ));
  const [toggling, setToggling] = useState(false);
  // Re-renders the pane when a line is closed; `dismissedStartOvers` keeps it closed across remounts.
  const [, setDismissedStartOver] = useState<string | null>(null);

  // What the Workflow agent setting still lacks, by the rule main checks. Read
  // only once the agent list is in, so a boot shows the starting line rather
  // than a flash of the setup state.
  const agentList = useConfigStore((state) => state.agentList);
  const agentListLoaded = useConfigStore((state) => state.agentListLoaded);
  const workflowsConfig = useConfigStore((state) => state.config.workflows);
  const settingsOpen = useConfigStore((state) => state.settingsOpen);
  const choice = useMemo(() => workflowAgentChoice(workflowsConfig), [workflowsConfig]);
  const setupGap = useMemo(
    () => (agentListLoaded ? workflowAgentSetupGap({ agents: agentList, choice }) : null),
    [agentListLoaded, agentList, choice],
  );
  // Main refused the last start for want of the setting, which the pane's own
  // read missed (its agent list was out of date, or not in yet).
  const mainSetupNeeded = useWorkflowStore((state) => state.agentSetupNeeded[workflowId] === true);
  const clearAgentRefusal = useWorkflowStore((state) => state.clearAgentRefusal);
  // Main refused the last start, for want of the setting or for a reason it gave.
  const refused = mainSetupNeeded || unavailable !== null;
  // The agent the terminal runs, as main picks it: the one holding a
  // conversation it can resume, else the setting's (a new workflow's first
  // start, or a new conversation from the saved plan).
  const recordedAgent = useWorkflowStore((state) => {
    const workflow = state.summaries.find((summary) => summary.workflow.id === workflowId)?.workflow;
    return workflow && workflow.agent_session_id !== null ? workflow.agent_name : null;
  });
  const terminalAgent = recordedAgent ?? choice.agent;

  // Open the agent of the workflow on screen, once per mount, when nothing holds
  // it back: the Workflow agent setting is complete as far as the pane knows,
  // Settings is closed, and main has not just refused a start. It does not wait
  // for the agent list: main checks the setting itself and answers
  // `setupNeeded`, so a list that never loads cannot strand the pane. Closing
  // Settings is what starts a pane that waited, so an Effort picked after the
  // Model still makes the first run. The ref (which survives StrictMode's second
  // effect run) keeps a later Settings close from opening again: main resumes an
  // exited agent's conversation on an open, which the user did not ask for.
  //
  // A start main refuses (the setting incomplete, the CLI not found, the MCP
  // server off) leaves the pane waiting again: the second effect clears the ref.
  // Opening Settings forgets the refusal, since that is where each is fixed, so
  // the close that follows tries once more. Nothing else retries, so there is no
  // loop.
  const openedWorkflowRef = useRef<string | null>(null);
  useEffect(() => {
    if (openedWorkflowRef.current === workflowId) return;
    if (setupGap !== null || settingsOpen || refused) return;
    openedWorkflowRef.current = workflowId;
    void openAgent();
  }, [workflowId, openAgent, setupGap, settingsOpen, refused]);
  useEffect(() => {
    if (!refused) return;
    openedWorkflowRef.current = null;
    if (settingsOpen) clearAgentRefusal(workflowId);
  }, [refused, settingsOpen, workflowId, clearAgentRefusal]);

  const running = session?.status === 'running';
  const queued = session?.status === 'queued';
  const live = running || queued;
  // A live agent keeps its terminal whatever the setting says. Any other asks
  // for the setting while it is incomplete or main refused for want of it.
  const settingIncomplete = setupGap !== null || mainSetupNeeded;
  // With no agent yet and Settings open, the open above is held until Settings
  // closes, so the pane says it will start then rather than that it is starting.
  const heldForSettings = agentListLoaded && settingsOpen && session === null;
  const showSetup = !live && (settingIncomplete || heldForSettings);
  const working = running && isActive(activity);
  const waiting = running && requiresUserInteraction(activity);
  // Only for the session the pane shows, so a summary that has not caught up
  // with a newer session never says it of that one.
  const showStartedOver = startedOverSessionId !== null
    && session?.id === startedOverSessionId
    && !dismissedStartOvers.has(startedOverSessionId);
  const dismissStartedOver = useCallback(() => {
    if (!startedOverSessionId) return;
    dismissedStartOvers.add(startedOverSessionId);
    setDismissedStartOver(startedOverSessionId);
  }, [startedOverSessionId]);

  const toggle = useCallback(() => {
    if (toggling) return;
    setToggling(true);
    const done = () => setToggling(false);
    if (live) void pauseAgent().finally(done);
    else void resumeAgent().finally(done);
  }, [toggling, live, pauseAgent, resumeAgent]);

  if (collapsed) {
    const stripMarkLabel = working ? 'Workflow agent is working' : 'Workflow agent is waiting for you';
    return (
      <div
        className="flex flex-shrink-0 flex-col items-center gap-2 border-r border-edge bg-surface py-2"
        style={{ width: COLLAPSED_WIDTH }}
        data-testid="workflow-agent-pane"
        data-collapsed="true"
      >
        <HoverTip label="Show the workflow agent">
          <button
            type="button"
            onClick={() => setCollapsed(false)}
            className="rounded p-1 text-fg-faint transition-colors hover:bg-surface-hover hover:text-fg-tertiary"
            aria-label="Show the workflow agent"
            data-testid="workflow-agent-pane-expand"
          >
            <PanelLeftOpen size={16} />
          </button>
        </HoverTip>
        {running && (
          <HoverTip label={stripMarkLabel}>
            <span role="img" aria-label={stripMarkLabel}>
              <ActivityMark
                mark={working ? 'agent-working' : 'agent-idle'}
                size={16}
                className={working ? 'text-active' : 'text-attention'}
              />
            </span>
          </HoverTip>
        )}
      </div>
    );
  }

  // A Resume while the setting is not complete is one main would refuse.
  const canToggle = unavailable === null && session !== null && !showSetup;
  const toggleLabel = toggling ? 'Working' : live ? 'Pause session' : 'Resume session';

  const pane = (
    <div
      ref={paneRef}
      className="relative flex h-full min-h-0 flex-shrink-0 flex-col border-r border-edge bg-surface"
      style={{ width }}
      data-testid="workflow-agent-pane"
      data-collapsed="false"
      data-floating={floating ? 'true' : 'false'}
      data-agent-state={unavailable ? 'unavailable' : showSetup ? 'setup' : working ? 'working' : waiting ? 'waiting' : session?.status ?? 'starting'}
    >
      <div className="flex h-10 flex-shrink-0 items-center gap-2 border-b border-edge bg-surface-raised px-3" data-testid="workflow-agent-pane-header">
        {canToggle && (
          <HoverTip label={toggleLabel}>
            <button
              type="button"
              onClick={toggle}
              disabled={toggling}
              data-testid="workflow-agent-toggle"
              className={`inline-flex flex-shrink-0 items-center justify-center rounded-full p-1 transition-colors disabled:cursor-not-allowed ${
                toggling ? 'text-fg-muted' : live ? 'text-active hover:bg-surface-hover' : 'text-fg-faint hover:bg-surface-hover hover:text-fg-tertiary'
              }`}
              aria-label={toggleLabel}
            >
              <PauseButtonIcon
                toggling={toggling}
                isQueued={queued}
                isThinking={working}
                isIdle={waiting}
                isSessionActive={live}
              />
            </button>
          </HoverTip>
        )}
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">Workflow agent</span>
        {/* Task detail's own Conversation control: the transcript viewer, on the
            conversation the workflow keeps, so it opens with the agent paused too. */}
        <HoverTip label={tipLabel({ disabled: !conversationId, disabledReason: 'No conversation yet', tip: 'View conversation' })}>
          <button
            type="button"
            onClick={() => { if (conversationId) useSessionStore.getState().setConversationSessionId(conversationId); }}
            disabled={!conversationId}
            className="flex-shrink-0 rounded p-1 text-fg-faint transition-colors hover:bg-surface-hover hover:text-fg-tertiary disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
            aria-label="View conversation"
            data-testid="workflow-agent-conversation"
          >
            <MessageSquare size={16} />
          </button>
        </HoverTip>
        <HoverTip label="Collapse agent">
          <button
            type="button"
            onClick={() => setCollapsed(true)}
            className="flex-shrink-0 rounded p-1 text-fg-faint transition-colors hover:bg-surface-hover hover:text-fg-tertiary"
            aria-label="Collapse agent"
            data-testid="workflow-agent-pane-collapse"
          >
            <PanelLeftClose size={16} />
          </button>
        </HoverTip>
      </div>

      {/* The agent's conversation could not be resumed, so main started a new
          one (workflow-agent.ts). Said once, under the header, until closed. */}
      {showStartedOver && (
        <div
          className="flex flex-shrink-0 items-center gap-2.5 border-b border-edge bg-accent-fg/10 px-3 py-2"
          role="status"
          data-testid="workflow-agent-started-over"
        >
          <Info size={16} className="flex-shrink-0 text-accent-fg" aria-hidden="true" />
          <span className="min-w-0 flex-1 text-[13px] text-fg-secondary">
            The earlier conversation could not be resumed, so the agent started a new one.
          </span>
          <HoverTip label="Dismiss">
            <button
              type="button"
              onClick={dismissStartedOver}
              className="flex-shrink-0 rounded p-0.5 text-fg-muted transition-colors hover:bg-surface-hover hover:text-fg-secondary"
              aria-label="Dismiss"
              data-testid="workflow-agent-started-over-dismiss"
            >
              <X size={14} />
            </button>
          </HoverTip>
        </div>
      )}

      <div className="relative min-h-0 flex-1">
        {unavailable ? (
          <div className="flex h-full items-start gap-2 px-4 py-4 text-sm text-fg-muted" data-testid="workflow-agent-unavailable">
            <Info size={16} className="mt-0.5 flex-shrink-0 text-fg-faint" aria-hidden="true" />
            <span>{unavailable}</span>
          </div>
        ) : running && session ? (
          <WorkflowAgentTerminal key={session.id} sessionId={session.id} shell={session.shell} agentName={terminalAgent} />
        ) : queued ? (
          <PaneNotice testId="workflow-agent-queued">
            <Loader2 size={14} className="animate-spin" />
            Waiting for a free agent slot...
          </PaneNotice>
        ) : showSetup ? (
          <WorkflowAgentSetup chosen={!settingIncomplete} />
        ) : session ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 bg-surface/50">
            <button
              type="button"
              onClick={toggle}
              disabled={toggling}
              data-testid="workflow-agent-resume"
              className="flex items-center gap-2.5 rounded-lg border border-accent/40 bg-accent/20 px-6 py-3 text-base text-accent-fg transition-colors hover:bg-accent/30 disabled:opacity-50"
            >
              {toggling ? <Loader2 size={16} className="animate-spin" /> : <Play size={16} />}
              {toggling ? 'Resuming agent...' : 'Resume session'}
            </button>
          </div>
        ) : (
          <PaneNotice testId="workflow-agent-starting">
            <Loader2 size={14} className="animate-spin" />
            Starting the workflow agent...
          </PaneNotice>
        )}
      </div>
      {/* The edge: drag to widen or narrow the pane; the width is kept. */}
      <HoverTip label="Drag to resize">
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize the workflow agent"
          aria-valuenow={width}
          onMouseDown={startResize}
          data-no-dismiss
          data-testid="workflow-agent-pane-resize"
          className="absolute inset-y-0 -right-1 z-10 w-2 cursor-col-resize select-none transition-colors hover:bg-accent/30"
        />
      </HoverTip>
    </div>
  );

  // One shape docked or floating, so crossing the width never remounts the
  // terminal: the outer box holds the row's place (the pane's width, or the
  // strip's while floating), and the pane inside lies over the canvas when it
  // floats.
  return (
    <div ref={outerRef} className="relative flex-shrink-0" style={{ width: floating ? COLLAPSED_WIDTH : width }}>
      <div className={floating ? 'absolute inset-y-0 left-0 z-20 shadow-xl' : 'h-full'}>{pane}</div>
    </div>
  );
}

/**
 * Where the terminal would be while no Workflow agent is chosen: what to do and
 * the way to Settings > Workflows. The pane starts the agent on its own once the
 * choice is made and Settings is closed, so the user never comes back to press
 * anything. The button is the paused agent's Resume button in shape.
 *
 * `chosen` is the same place once the setting is complete but Settings is still
 * open, which holds the start: it says when the agent starts, and needs no way
 * into a Settings panel that is already open.
 */
function WorkflowAgentSetup({ chosen }: { chosen: boolean }) {
  return (
    <div
      className="flex h-full flex-col items-center justify-center gap-3 bg-surface/50 px-12 text-center"
      data-testid="workflow-agent-setup"
      data-setting={chosen ? 'chosen' : 'needed'}
    >
      <Bot size={28} className="text-fg-faint" aria-hidden="true" />
      <h2 className="text-base font-semibold text-fg">{chosen ? 'Workflow agent chosen' : 'Choose a workflow agent'}</h2>
      {/* One line at the pane's default width; a narrowed pane wraps it evenly. */}
      <p className="text-balance text-sm text-fg-muted">
        {chosen ? 'It starts when you close Settings.' : 'It plans your workflows, and starts when you close Settings.'}
      </p>
      {!chosen && (
        <button
          type="button"
          onClick={openWorkflowAgentSettings}
          data-testid="workflow-agent-setup-open-settings"
          className="mt-1.5 flex items-center gap-2.5 rounded-lg border border-accent/40 bg-accent/20 px-6 py-3 text-base text-accent-fg transition-colors hover:bg-accent/30"
        >
          <Settings size={16} />
          Open Settings
        </button>
      )}
    </div>
  );
}

function PaneNotice({ children, testId }: { children: ReactNode; testId: string }) {
  return (
    <div className="flex h-full items-center justify-center gap-2 text-sm text-fg-muted" data-testid={testId}>
      {children}
    </div>
  );
}

/**
 * The agent's xterm, mounted per session (`useTerminal` tears down only on
 * unmount, so a new session needs a new host). It publishes itself to the
 * workflow store while mounted, which is what has main stream its bytes here.
 */
function WorkflowAgentTerminal({ sessionId, shell, agentName }: { sessionId: string; shell: string; agentName: string | null }) {
  const config = useConfigStore((state) => state.config);
  // The paste capability of the agent this session runs (the pane resolves it as
  // main does), not the project's default agent: the workflow agent has its own
  // setting, and no task to resolve through.
  const pasteImageCapability = useConfigStore((state) => state.agentList.find((agent) => agent.name === agentName));
  const setAgentPaneSessionId = useWorkflowStore((state) => state.setAgentPaneSessionId);

  const mayFocusOnArrival = useCallback(
    (site: ArrivalFocusSite) => mayTakeArrivalFocus(sessionId, site),
    [sessionId],
  );

  const { terminalRef, initTerminal, fit, flushResize, focus, paste } = useTerminal({
    sessionId,
    fontFamily: config.terminal.fontFamily,
    fontSize: config.terminal.fontSize,
    cursorStyle: config.terminal.cursorStyle,
    colors: config.terminal.colors,
    shellName: shell || undefined,
    pasteImageCapability,
    backspaceSendsCtrlH: config.terminal.backspaceSendsCtrlH,
    mayTakeArrivalFocus: mayFocusOnArrival,
  });

  const fileDrop = useTerminalFileDrop(sessionId, focus, paste, shell || undefined, pasteImageCapability);

  useEffect(() => {
    setAgentPaneSessionId(sessionId);
    return () => setAgentPaneSessionId(null);
  }, [sessionId, setAgentPaneSessionId]);

  const { initializedRef } = useDeferredTerminalInit({
    terminalRef,
    initTerminal,
    onInit: () => {
      fit();
      if (mayFocusOnArrival('deferred-init')) focus();
    },
  });

  useTerminalRefit({
    terminalRef,
    initializedRef,
    fit,
    flushResize,
    immediatePanelResize: true,
  });

  return (
    <div className="absolute inset-0 px-1 pt-1" data-testid="workflow-agent-terminal-pane" data-session-id={sessionId} data-agent-name={agentName ?? undefined}>
      <FileDropOverlay {...fileDrop} />
      <div ref={terminalRef} className="h-full" data-testid="workflow-agent-terminal" />
    </div>
  );
}
