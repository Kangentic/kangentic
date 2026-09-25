import { useState, useEffect, useCallback } from 'react';
import { useKeybinding } from './useKeybinding';

/** Preserved across HMR so the search palette stays mounted during hot
 *  module replacement instead of resetting to closed. */
// @ts-expect-error -- Vite handles import.meta.hot
const hmrSearchPaletteOpen: boolean = import.meta.hot?.data?.searchPaletteOpen ?? false;

// @ts-expect-error -- Vite handles import.meta.hot
if (import.meta.hot) {
  // @ts-expect-error -- Vite handles import.meta.hot
  import.meta.hot.dispose((data: Record<string, unknown>) => {
    data.searchPaletteOpen = _lastIsOpen;
  });
}

let _lastIsOpen = hmrSearchPaletteOpen;

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

interface UseSearchPaletteOptions {
  /**
   * Handler for plain Ctrl/Cmd+F (no Shift) fired outside an editable element.
   * Return true if it was handled (e.g. the board view focusing its inline
   * search) so the global palette stays closed; return false to fall back to
   * toggling the palette. Ctrl/Cmd+Shift+F always toggles the palette.
   */
  onPlainFindKey?: () => boolean;
}

/**
 * Registers Ctrl+Shift+F / Cmd+Shift+F to toggle the global (cross-project)
 * search palette. Plain Ctrl+F / Cmd+F (when not typing in an editable element)
 * is offered to `onPlainFindKey` first: on the board view that focuses the
 * inline board search; if unclaimed it falls back to toggling the palette.
 */
export function useSearchPalette(options: UseSearchPaletteOptions = {}) {
  const { onPlainFindKey } = options;
  const [isOpen, setIsOpen] = useState(hmrSearchPaletteOpen);

  useEffect(() => {
    _lastIsOpen = isOpen;
  }, [isOpen]);

  const open = useCallback(() => {
    setIsOpen(true);
    // Adoption signal; main dedups to once per day (fire-and-forget).
    window.electronAPI?.analytics?.trackFeatureUsed('quick_find');
  }, []);
  const close = useCallback(() => setIsOpen(false), []);

  // Ctrl/Cmd+Shift+F always toggles the palette.
  useKeybinding('search.togglePalette', () => {
    if (isOpen) close();
    else open();
  });

  // Plain Ctrl/Cmd+F: only when not in an editable region, so in-input "find
  // selection" muscle memory and a focused board search stay intact. The host
  // claims it first (board view focuses its inline search); if unclaimed, fall
  // back to toggling the global palette.
  useKeybinding(
    'search.plainFind',
    () => {
      if (onPlainFindKey?.()) return;
      if (isOpen) close();
      else open();
    },
    { when: (event) => !isEditableTarget(event.target) },
  );

  return { isOpen, open, close };
}
