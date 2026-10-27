/**
 * PopOutButton's accessible name: `label ?? (isOpen ? 'Focus detached window' : 'Open in new window')`.
 *
 * Unit tier, not the UI tier, because the open branch cannot be reached in a page. Strict mutual
 * exclusivity (.claude/rules/pop-out-surface-registry.md) unmounts the in-app surface in the same
 * commit that flips `isOpen`: AppLayout renders `{statsOpen && !statsPopOut.isOpen && <StatsPage />}`
 * and TaskDetailBody guards the Changes and Browser panes the same way, so the button that says
 * "Focus detached window" is never on screen in the main window. A pop-out window never loads the
 * open set. The closed default is pinned in tests/ui/usage-dashboard.spec.ts; the open name and the
 * `label` override are pinned here.
 *
 * `react-dom/server`, no jsdom, like tooltip.test.ts. A static render reads a zustand store's
 * INITIAL state, so the pop-out store is replaced by a stand-in that reads a mutable record. The real
 * `usePopOut` and `popOutInstanceKey` still run, so the key the button looks up is the real one.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup as renderBareMarkup } from 'react-dom/server';
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { popOutInstanceKey } from '../../src/shared/pop-out';
import { PopOutButton } from '../../src/renderer/pop-out/PopOutButton';

/** A static render inside the I18nProvider the button's `useLingui` reads from, as in the app. */
function renderToStaticMarkup(element: ReactElement): string {
  return renderBareMarkup(createElement(I18nProvider, { i18n }, element));
}

// vi.mock and vi.hoisted run before the imports above, so PopOutButton sees the stand-in store.
const openInstanceKeys = vi.hoisted(() => ({ current: {} as Record<string, true> }));

vi.mock('../../src/renderer/stores/pop-out-store', () => ({
  usePopOutStore: <Selected>(select: (state: { openInstanceKeys: Record<string, true> }) => Selected): Selected =>
    select({ openInstanceKeys: openInstanceKeys.current }),
}));

const TASK_PARAMS = { taskId: 'task-pop-out', projectId: 'proj-pop-out' };

/** The opening tag of the button, whatever order its attributes come in. */
function buttonTag(markup: string): string {
  const match = /^<button[^>]*>/.exec(markup);
  if (match === null) throw new Error(`Markup does not start with a button: ${markup}`);
  return match[0];
}

function ariaLabelOf(openingTag: string): string | null {
  const match = /\saria-label="([^"]*)"/.exec(openingTag);
  return match === null ? null : match[1];
}

describe('PopOutButton name', () => {
  beforeEach(() => {
    openInstanceKeys.current = {};
  });

  it('says it opens a new window while the surface is attached', () => {
    const tag = buttonTag(renderToStaticMarkup(createElement(PopOutButton, { kind: 'stats', params: {} })));
    expect(ariaLabelOf(tag)).toBe('Open in new window');
    expect(tag).toContain('data-testid="pop-out-button-stats"');
  });

  it('says it focuses the window once the surface is detached', () => {
    openInstanceKeys.current = { [popOutInstanceKey('stats', {})]: true };
    const tag = buttonTag(renderToStaticMarkup(createElement(PopOutButton, { kind: 'stats', params: {} })));
    expect(ariaLabelOf(tag)).toBe('Focus detached window');
  });

  it('names a task-scoped surface by its own instance key, not another one', () => {
    const params = TASK_PARAMS;
    const render = (): string => buttonTag(renderToStaticMarkup(createElement(PopOutButton, { kind: 'changes', params })));

    // Another task's window and another kind's window for the same task are not this surface.
    openInstanceKeys.current = {
      [popOutInstanceKey('changes', { taskId: 'task-other', projectId: params.projectId })]: true,
      [popOutInstanceKey('browser', params)]: true,
      [popOutInstanceKey('stats', {})]: true,
    };
    expect(ariaLabelOf(render())).toBe('Open in new window');

    openInstanceKeys.current = { [popOutInstanceKey('changes', params)]: true };
    expect(ariaLabelOf(render())).toBe('Focus detached window');
  });

  it('keeps an explicit label in both states', () => {
    const render = (): string => buttonTag(renderToStaticMarkup(
      createElement(PopOutButton, { kind: 'browser', params: TASK_PARAMS, label: 'Pop the page out' }),
    ));

    expect(ariaLabelOf(render())).toBe('Pop the page out');
    openInstanceKeys.current = { [popOutInstanceKey('browser', TASK_PARAMS)]: true };
    expect(ariaLabelOf(render())).toBe('Pop the page out');
  });

  it('reads no description, because the tip only repeats the name', () => {
    const closed = renderToStaticMarkup(createElement(PopOutButton, { kind: 'stats', params: {} }));
    expect(closed).not.toContain('aria-description');

    openInstanceKeys.current = { [popOutInstanceKey('stats', {})]: true };
    const open = renderToStaticMarkup(createElement(PopOutButton, { kind: 'stats', params: {} }));
    expect(open).not.toContain('aria-description');
  });
});
