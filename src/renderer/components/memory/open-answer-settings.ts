/**
 * Take the user to Settings > Knowledge Graph, at the Agent row.
 *
 * Where a question goes when the Memory Graph cannot answer it yet: no agent is
 * chosen, or the chosen agent takes a model and none is. The rule is that this
 * is one explicit global choice, never inferred from the project, so the box
 * does not guess; it shows the user where the choice lives.
 *
 * The panel opens on the tab it was last left on, so the tab is set first. The
 * row only exists once the panel has mounted, so it is scrolled into view on a
 * later frame, and given up on quietly if it never appears (semantic search
 * off, which hides the section the row lives in).
 */

import { useConfigStore } from '../../stores/config-store';

const ANSWER_AGENT_ROW_SELECTOR = '[data-testid="setting-row-memory.answerAgent"]';
const REVEAL_FRAME_BUDGET = 30;

/** Take the user to Settings > Knowledge Graph, where the index is managed: the Index
 *  flyout's Settings button. */
export function openSearchSettings(): void {
  const store = useConfigStore.getState();
  store.setLastSettingsTab('memory');
  store.setSettingsOpen(true);
}

export function openAnswerSettings(): void {
  const store = useConfigStore.getState();
  store.setLastSettingsTab('memory');
  store.setSettingsOpen(true);

  let framesLeft = REVEAL_FRAME_BUDGET;
  const reveal = (): void => {
    const row = document.querySelector(ANSWER_AGENT_ROW_SELECTOR);
    if (row) {
      row.scrollIntoView({ block: 'center' });
      return;
    }
    framesLeft -= 1;
    if (framesLeft > 0) requestAnimationFrame(reveal);
  };
  requestAnimationFrame(reveal);
}
