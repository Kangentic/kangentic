import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { Info, Loader2, PanelLeftClose, PanelLeftOpen, Play } from 'lucide-react';
import type { Session } from '../../../shared/types';
import { isActive, requiresUserInteraction } from '../../../shared/activity-state';
import { useSessionStore } from '../../stores/session-store';
import { useWorkflowStore } from '../../stores/workflow-store';
import { useConfigStore } from '../../stores/config-store';
import { useProjectStore } from '../../stores/project-store';
import { useTerminal } from '../../hooks/useTerminal';
import { useTerminalRefit } from '../../hooks/useTerminalRefit';
import { useDeferredTerminalInit } from '../../hooks/useDeferredTerminalInit';
import { useTerminalFileDrop } from '../../hooks/useTerminalFileDrop';
import { mayTakeArrivalFocus, type ArrivalFocusSite } from '../../utils/terminal-arrival-focus';
import { FileDropOverlay } from '../terminal/FileDropOverlay';
import { ActivityMark } from '../ActivityMark';
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

/** The workflow's agent session: its live or paused one first, else the last that exited. */
function selectAgentSession(sessions: readonly Session[], workflowId: string): Session | null {
  let exited: Session | null = null;
  for (const session of sessions) {
    if (session.workflowId !== workflowId) continue;
    if (session.status !== 'exited') return session;
    exited = session;
  }
  return exited;
}

/**
 * Whether the workflow's agent is mid-turn: what holds the plan (#732, board
 * 2c). The agent works from what it read when its turn began, so a hand edit
 * meanwhile would leave it building on a plan that no longer exists.
 */
export function useWorkflowAgentWorking(workflowId: string | null): boolean {
  return useSessionStore((state) => {
    if (!workflowId) return false;
    const session = selectAgentSession(state.sessions, workflowId);
    return session?.status === 'running' && isActive(state.sessionActivity[session.id]);
  });
}

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
  const width = workflowAgentPaneWidth(dragWidth ?? storedWidth);
  const outerRef = useRef<HTMLDivElement>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  const startResize = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    const outer = outerRef.current;
    const paneElement = paneRef.current;
    if (!outer || !paneElement) return;
    const handle = event.currentTarget;
    const startX = event.clientX;
    const startWidth = workflowAgentPaneWidth(storedWidth);
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
        void updateConfig({ workflows: { agentPaneWidth: latest } }).finally(() => setDragWidth(null));
      },
    });
  }, [floating, storedWidth, updateConfig]);
  const session = useSessionStore((state) => selectAgentSession(state.sessions, workflowId));
  const activity = useSessionStore((state) => (session ? state.sessionActivity[session.id] : undefined));
  const unavailable = useWorkflowStore((state) => state.agentUnavailable[workflowId] ?? null);
  const collapsed = useWorkflowStore((state) => state.agentPaneCollapsed);
  const setCollapsed = useWorkflowStore((state) => state.setAgentPaneCollapsed);
  const openAgent = useWorkflowStore((state) => state.openAgent);
  const resumeAgent = useWorkflowStore((state) => state.resumeAgent);
  const pauseAgent = useWorkflowStore((state) => state.pauseAgent);
  const [toggling, setToggling] = useState(false);

  // Open the agent of the workflow on screen, once per workflow.
  useEffect(() => {
    void openAgent();
  }, [workflowId, openAgent]);

  const running = session?.status === 'running';
  const queued = session?.status === 'queued';
  const live = running || queued;
  const working = running && isActive(activity);
  const waiting = running && requiresUserInteraction(activity);

  const toggle = useCallback(() => {
    if (toggling) return;
    setToggling(true);
    const done = () => setToggling(false);
    if (live) void pauseAgent().finally(done);
    else void resumeAgent().finally(done);
  }, [toggling, live, pauseAgent, resumeAgent]);

  if (collapsed) {
    return (
      <div
        className="flex flex-shrink-0 flex-col items-center gap-2 border-r border-edge bg-surface py-2"
        style={{ width: COLLAPSED_WIDTH }}
        data-testid="workflow-agent-pane"
        data-collapsed="true"
      >
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          className="rounded p-1 text-fg-faint transition-colors hover:bg-surface-hover hover:text-fg-tertiary"
          title="Show the workflow agent"
          aria-label="Show the workflow agent"
          data-testid="workflow-agent-pane-expand"
        >
          <PanelLeftOpen size={16} />
        </button>
        {running && (
          <span title={working ? 'Workflow agent is working' : 'Workflow agent is waiting for you'}>
            <ActivityMark
              mark={working ? 'agent-working' : 'agent-idle'}
              size={16}
              className={working ? 'text-active' : 'text-attention'}
            />
          </span>
        )}
      </div>
    );
  }

  const canToggle = unavailable === null && session !== null;

  const pane = (
    <div
      ref={paneRef}
      className="relative flex h-full min-h-0 flex-shrink-0 flex-col border-r border-edge bg-surface"
      style={{ width }}
      data-testid="workflow-agent-pane"
      data-collapsed="false"
      data-floating={floating ? 'true' : 'false'}
      data-agent-state={unavailable ? 'unavailable' : working ? 'working' : waiting ? 'waiting' : session?.status ?? 'starting'}
    >
      <div className="flex h-10 flex-shrink-0 items-center gap-2 border-b border-edge px-3">
        {canToggle && (
          <button
            type="button"
            onClick={toggle}
            disabled={toggling}
            data-testid="workflow-agent-toggle"
            className={`inline-flex flex-shrink-0 items-center justify-center rounded-full p-1 transition-colors disabled:cursor-not-allowed ${
              toggling ? 'text-fg-muted' : live ? 'text-active hover:bg-surface-hover' : 'text-fg-faint hover:bg-surface-hover hover:text-fg-tertiary'
            }`}
            title={toggling ? 'Working...' : live ? 'Pause session' : 'Resume session'}
            aria-label={toggling ? 'Working' : live ? 'Pause session' : 'Resume session'}
          >
            <PauseButtonIcon
              toggling={toggling}
              isQueued={queued}
              isThinking={working}
              isIdle={waiting}
              isSessionActive={live}
            />
          </button>
        )}
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">Workflow agent</span>
        <button
          type="button"
          onClick={() => setCollapsed(true)}
          className="flex-shrink-0 rounded p-1 text-fg-faint transition-colors hover:bg-surface-hover hover:text-fg-tertiary"
          title="Hide the workflow agent"
          aria-label="Hide the workflow agent"
          data-testid="workflow-agent-pane-collapse"
        >
          <PanelLeftClose size={16} />
        </button>
      </div>

      <div className="relative min-h-0 flex-1">
        {unavailable ? (
          <div className="flex h-full items-start gap-2 px-4 py-4 text-sm text-fg-muted" data-testid="workflow-agent-unavailable">
            <Info size={16} className="mt-0.5 flex-shrink-0 text-fg-faint" aria-hidden="true" />
            <span>{unavailable}</span>
          </div>
        ) : running && session ? (
          <WorkflowAgentTerminal key={session.id} sessionId={session.id} shell={session.shell} />
        ) : queued ? (
          <PaneNotice testId="workflow-agent-queued">
            <Loader2 size={14} className="animate-spin" />
            Waiting for a free agent slot...
          </PaneNotice>
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
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the workflow agent"
        aria-valuenow={width}
        title="Drag to resize"
        onMouseDown={startResize}
        data-no-dismiss
        data-testid="workflow-agent-pane-resize"
        className="absolute inset-y-0 -right-1 z-10 w-2 cursor-col-resize select-none transition-colors hover:bg-accent/30"
      />
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
function WorkflowAgentTerminal({ sessionId, shell }: { sessionId: string; shell: string }) {
  const config = useConfigStore((state) => state.config);
  const projectAgent = useProjectStore((state) => state.currentProject?.default_agent ?? null);
  // The project default agent's paste capability, as the Command Terminal reads it:
  // the workflow agent runs that agent and has no task to resolve through.
  const pasteImageCapability = useConfigStore((state) => state.agentList.find((agent) => agent.name === projectAgent));
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
    <div className="absolute inset-0 px-1 pt-1" data-testid="workflow-agent-terminal-pane" data-session-id={sessionId}>
      <FileDropOverlay {...fileDrop} />
      <div ref={terminalRef} className="h-full" data-testid="workflow-agent-terminal" />
    </div>
  );
}
