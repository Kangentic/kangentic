import { useCallback, useMemo } from 'react';
import { i18n } from '@lingui/core';
import { useConfigStore } from '../stores/config-store';
import { formatComboSegments, type ClickModifiers } from '../utils/keybindings';
import { LINK_TARGET_LABELS, planLinkActions } from '../utils/link-open';
import { openInTaskBrowser, useTaskLinkBrowserAvailable } from '../utils/task-link-browser';
import type { TooltipRow } from '../components/Tooltip';

export interface LinkOpener {
  /** The tip's rows: what a click and a Ctrl or Cmd click open, the plain click first. */
  rows: TooltipRow[];
  /** Open the URL where this click names. A click with other modifiers held opens as a plain one. */
  open(url: string, event: ClickModifiers): void;
}

/**
 * How a link outside a terminal opens (#1056): the PR pill, a task's artifacts.
 * The same rule as a terminal link (`link-open.ts`): a click opens the browser
 * the user chose, Ctrl or Cmd click the other. `taskId` names the task whose
 * window offers a Kangentic browser, open or not (`task-link-browser.ts`: a
 * running task's window is opened for it); without one, both clicks open the
 * default browser and the tip is one row.
 */
export function useLinkOpener(taskId: string | null | undefined): LinkOpener {
  const clickTarget = useConfigStore((state) => state.config.linkClickTarget ?? 'default');
  const kangenticBrowserAvailable = useTaskLinkBrowserAvailable(taskId);
  const plan = useMemo(
    () => planLinkActions(clickTarget, kangenticBrowserAvailable),
    [clickTarget, kangenticBrowserAvailable],
  );
  const rows = useMemo<TooltipRow[]>(
    () => plan.actions.map((action) => ({
      id: action.target,
      label: i18n._(LINK_TARGET_LABELS[action.target]),
      keys: formatComboSegments(action.combo),
    })),
    [plan],
  );
  const open = useCallback((url: string, event: ClickModifiers) => {
    const target = plan.targetFor(event) ?? plan.actions[0].target;
    const openExternal = (link: string): void => { void window.electronAPI.shell.openExternal(link); };
    // Asked again at the click: the window may have closed, or the agent stopped, since the hover.
    if (target === 'kangentic-browser' && taskId && openInTaskBrowser(taskId, url, openExternal)) return;
    openExternal(url);
  }, [plan, taskId]);
  return { rows, open };
}
