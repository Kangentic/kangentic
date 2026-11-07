/**
 * The find bar on a terminal. It floats over the pane, so opening and closing it
 * resizes nothing: a strip above the terminal would send the PTY a resize and make
 * an agent repaint on every open and close.
 *
 * It sits inside `data-terminal-host` and outside `.xterm`. Tooltip and
 * `escapeOwnedElsewhere` read a key from `.xterm` as the agent's.
 *
 * Mod+F is bound in the capture phase on `window`, since xterm stops the keys it
 * takes in its own capture pass on the textarea. Escape is the capture-phase consume
 * in `.claude/rules/keybindings-registry.md`: it has to beat both xterm and the task
 * window's bubble-phase close.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type RefObject } from 'react';
import { ChevronDown, ChevronUp, X } from 'lucide-react';
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { HeaderActionButton } from '../HeaderActionButton';
import { useKeybinding } from '../../hooks/useKeybinding';
import { registerTerminalFind, setTerminalFindOpen } from '../../utils/terminal-find-registry';
import {
  summarizeFindResults,
  TERMINAL_FIND_HIGHLIGHT_LIMIT,
  type FindResults,
  type FindSummary,
  type TerminalBufferReach,
  type TerminalFind,
} from '../../utils/terminal-find';

interface TerminalFindBarProps {
  find: TerminalFind;
  sessionId: string;
  /** This terminal's element, which locates the pane the shortcut and Escape answer for. */
  terminalRef: RefObject<HTMLDivElement | null>;
}

export function TerminalFindBar({ find, sessionId, terminalRef }: TerminalFindBarProps) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<FindResults | null>(null);
  const [reach, setReach] = useState<TerminalBufferReach>({ alternate: false, lines: 0 });
  const inputRef = useRef<HTMLInputElement>(null);

  const isInThisPane = useCallback((target: EventTarget | null): boolean => (
    target instanceof Node && !!terminalRef.current?.closest('[data-terminal-host]')?.contains(target)
  ), [terminalRef]);

  const openBar = useCallback(() => {
    setReach(find.readReach());
    setOpen(true);
  }, [find]);

  const closeBar = useCallback(() => {
    find.clear();
    setOpen(false);
    setQuery('');
    setResults(null);
    // arrival-focus-ok: the user closed the bar, which hands the keyboard back.
    find.focusTerminal();
  }, [find]);

  // The entry registers once per session, so its callback reads the current toggle here.
  const toggleRef = useRef(openBar);
  useLayoutEffect(() => {
    toggleRef.current = open ? closeBar : openBar;
  });
  useEffect(() => registerTerminalFind(sessionId, () => toggleRef.current()), [sessionId]);
  useEffect(() => setTerminalFindOpen(sessionId, open), [sessionId, open]);

  useKeybinding('terminal.find', () => {
    if (!open) {
      openBar();
      return;
    }
    // arrival-focus-ok: the find field, on the user's own shortcut.
    inputRef.current?.focus();
    inputRef.current?.select();
  }, { capture: true, when: (event) => isInThisPane(event.target) });

  useLayoutEffect(() => {
    // arrival-focus-ok: the find field, which opens only on a user gesture.
    if (open) inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const stopResults = find.onResults((next) => {
      setResults(next);
      setReach(find.readReach());
    });
    const stopBuffer = find.onBufferChange(() => setReach(find.readReach()));
    return () => {
      stopResults();
      stopBuffer();
    };
  }, [find, open]);

  // Only while open, and only from this pane. It runs before xterm, so the agent
  // never sees the key, and before the task window's close. An open menu or dialog
  // keeps its own Escape: one press undoes one thing.
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing) return;
      if (!isInThisPane(event.target)) return;
      if (document.querySelector('[data-dismissable-layer]')) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      closeBar();
    };
    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [open, isInThisPane, closeBar]);

  if (!open) return null;

  const handleChange = (nextQuery: string) => {
    setQuery(nextQuery);
    find.find(nextQuery, 'older');
  };

  const handleInputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    find.find(query, event.shiftKey ? 'newer' : 'older');
  };

  // Dead space in the bar keeps the field focused, or the click drops focus to
  // <body>, where neither the shortcut nor Escape can tell which terminal it means.
  const handleMouseDown = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.target instanceof Element && event.target.closest('input, button')) return;
    event.preventDefault();
    // arrival-focus-ok: the find field, on the user's own click in the bar.
    inputRef.current?.focus();
  };

  const summary: FindSummary = results && query ? summarizeFindResults(results, TERMINAL_FIND_HIGHLIGHT_LIMIT) : { kind: 'none' };
  const noMatches = query.length > 0 && results !== null && summary.kind === 'none';
  const hasMatches = query.length > 0 && summary.kind !== 'none';
  const lineCount = reach.lines;

  let countLabel = '';
  if (summary.kind === 'position') {
    const { position, total } = summary;
    countLabel = reach.alternate ? t`${position} of ${total} on screen` : t`${position} of ${total}`;
  } else if (summary.kind === 'past-limit') {
    const { limit } = summary;
    countLabel = reach.alternate ? t`${limit}+ on screen` : t`${limit}+`;
  } else if (summary.kind === 'total') {
    const { total } = summary;
    countLabel = reach.alternate ? t`${total} on screen` : String(total);
  }

  return (
    <div
      className="absolute right-[18px] top-2 z-20 w-[360px] max-w-[calc(100%-26px)] rounded-lg border border-edge bg-surface-raised shadow-lg"
      role="search"
      aria-label={t`Find in terminal`}
      data-testid="terminal-find-bar"
      data-no-dismiss
      onMouseDown={handleMouseDown}
    >
      <div className="flex h-8 items-center gap-1 pl-2.5 pr-[5px]">
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(event) => handleChange(event.target.value)}
          onKeyDown={handleInputKeyDown}
          placeholder={reach.alternate ? t`Find on screen` : t({ message: 'Find', context: 'terminal find field' })}
          aria-label={t`Find in terminal`}
          spellCheck={false}
          autoComplete="off"
          className="min-w-0 flex-1 bg-transparent text-sm text-fg placeholder:text-fg-faint focus:outline-none"
          data-testid="terminal-find-input"
        />
        <span aria-live="polite" className="mx-1 whitespace-nowrap text-xs text-fg-muted empty:hidden" data-testid="terminal-find-count">
          {countLabel}
        </span>
        <HeaderActionButton
          icon={ChevronUp}
          onClick={() => find.find(query, 'older')}
          disabled={!hasMatches}
          tip={t`Older match`}
          size="small"
          testId="terminal-find-older"
        />
        <HeaderActionButton
          icon={ChevronDown}
          onClick={() => find.find(query, 'newer')}
          disabled={!hasMatches}
          tip={t`Newer match`}
          size="small"
          testId="terminal-find-newer"
        />
        <HeaderActionButton icon={X} onClick={closeBar} tip={t`Close find`} size="small" testId="terminal-find-close" />
      </div>
      {noMatches && (
        <div role="status" className="border-t border-edge/60 px-2.5 pb-1.5 pt-1 text-xs text-fg-muted" data-testid="terminal-find-no-matches">
          {reach.alternate
            ? <Trans>No matches on screen</Trans>
            : <Plural value={lineCount} one="No matches in the last # line" other="No matches in the last # lines" />}
        </div>
      )}
    </div>
  );
}
