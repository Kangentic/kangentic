/**
 * Does something other than a surface-level Escape handler own this keystroke?
 *
 * A surface that takes Escape for itself (a pop-out window closing, the Changes
 * panel letting go of a selected commit) yields when any of these holds:
 *
 * - Something already handled it (`defaultPrevented`): Monaco's keybinding
 *   service preventDefaults the keys it handled, closing its find widget.
 * - A text field has focus, an `<input>`, a `<textarea>` or an editable node:
 *   Escape there cancels an edit (the Changes file filter, a URL bar). That
 *   includes xterm's helper textarea and Monaco's input textarea, whose Escape
 *   belongs to the agent and the editor.
 * - A dialog, context menu or popover is open (`[data-dismissable-layer]`): its
 *   Escape closes it, one press undoing one thing. A menu registers its own
 *   capture listener only when it opens, after a surface's, so the surface would
 *   otherwise run first.
 * - The key comes from inside a terminal (`.xterm`), where Escape interrupts
 *   the agent, or from Monaco's find widget (`.find-widget`, unqualified: the
 *   lazy-monaco build assertion scans entry chunks for the editor root's class).
 */
export function escapeOwnedElsewhere(event: KeyboardEvent): boolean {
  if (event.defaultPrevented) return true;
  const activeElement = document.activeElement;
  if (
    activeElement instanceof HTMLElement &&
    (activeElement.tagName === 'INPUT' || activeElement.tagName === 'TEXTAREA' || activeElement.isContentEditable)
  ) return true;
  if (document.querySelector('[data-dismissable-layer]')) return true;
  const target = event.target instanceof HTMLElement ? event.target : null;
  if (target?.closest('.xterm, .find-widget')) return true;
  return false;
}
