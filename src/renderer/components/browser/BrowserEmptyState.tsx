import { useCallback, useEffect, useRef, useState } from 'react';
import { Globe, ArrowRight } from 'lucide-react';
import { normalizeUrl } from './BrowserEmptyState.utils';
import { focusIsInTypingSurface } from '../../utils/terminal-arrival-focus';

interface BrowserEmptyStateProps {
  onSubmit: (url: string) => void;
}

// Agnostic preview-target prompt. Could be a local dev server, a staging URL,
// a production site, anything reachable over http(s). Quick picks cover the
// most common local development ports without locking the copy into a
// dev-only narrative.

interface QuickPick {
  label: string;
  url: string;
  hint: string;
}

const QUICK_PICKS: QuickPick[] = [
  { label: 'localhost:3000', url: 'http://localhost:3000', hint: 'Next.js, Express, CRA' },
  { label: 'localhost:5173', url: 'http://localhost:5173', hint: 'Vite' },
  { label: 'localhost:4321', url: 'http://localhost:4321', hint: 'Astro' },
  { label: 'localhost:8080', url: 'http://localhost:8080', hint: 'Webpack, generic' },
];

export function BrowserEmptyState({ onSubmit }: BrowserEmptyStateProps) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Focus the URL input on mount, but never out of something the user is typing
  // into. This pane does not only mount from the user's Browser pill: an agent's
  // kangentic_browser_open_pane mounts it too, and lands here whenever the URL it
  // seeded fails to resolve. A bare `autoFocus` made that an agent-triggered
  // focus steal. See `.claude/rules/agent-driven-focus.md`.
  useEffect(() => {
    if (focusIsInTypingSurface()) return;
    inputRef.current?.focus();
  }, []);

  const submit = useCallback((raw: string) => {
    const normalized = normalizeUrl(raw);
    if (!normalized) {
      setError('Enter a valid http:// or https:// URL.');
      return;
    }
    setError(null);
    onSubmit(normalized);
  }, [onSubmit]);

  const handleSubmit = useCallback((event: React.FormEvent) => {
    event.preventDefault();
    submit(value);
  }, [submit, value]);

  return (
    <div
      className="flex flex-col items-center justify-center h-full px-6 py-8 bg-surface overflow-y-auto"
      data-testid="browser-empty-state"
    >
      <div className="flex flex-col items-center gap-4 max-w-md w-full">
        <div className="p-4 rounded-full bg-gradient-to-br from-accent/20 to-accent/5 border border-accent/20 text-accent-fg">
          <Globe size={32} strokeWidth={1.5} />
        </div>

        <div className="flex flex-col items-center gap-1.5 text-center">
          <h3 className="text-base font-semibold text-fg">Open a URL to preview</h3>
          <p className="text-xs text-fg-muted leading-relaxed max-w-sm">
            Local dev server, staging, production, or any http(s) page.
            This task remembers where you were; other tasks keep their own.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="flex w-full gap-2 mt-1">
          <input
            ref={inputRef}
            type="text"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder="https://example.com or localhost:5173"
            spellCheck={false}
            className="flex-1 bg-surface-input text-fg text-sm px-3 py-2 rounded border border-edge-input focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/30 transition-colors"
            data-testid="browser-empty-state-input"
          />
          <button
            type="submit"
            className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-accent-on bg-accent-emphasis hover:bg-accent rounded transition-colors"
            data-testid="browser-empty-state-open"
          >
            Open
            <ArrowRight size={14} />
          </button>
        </form>

        {error && (
          <p className="text-[11px] text-red-400 -mt-1 self-start">{error}</p>
        )}

        {/* WSL hint: Windows Kangentic can't always reach a dev server bound
         *  to WSL's loopback. The pane just shows Chromium's "site can't be
         *  reached" page - this hint surfaces the workaround before that.
         *  Reads platform from electronAPI (= main-process `process.platform`)
         *  rather than the deprecated `navigator.platform`, which can return
         *  empty / frozen / lying values across browser builds. */}
        {window.electronAPI.platform === 'win32' && (
          <p className="text-[11px] text-fg-faint leading-relaxed self-start">
            On Windows: if your dev server runs in WSL and `localhost` does not
            connect, run <code className="px-1 py-0.5 rounded bg-surface-input text-[11px]">wsl hostname -I</code> and use that IP instead.
          </p>
        )}

        <div className="flex flex-col items-stretch gap-2 w-full mt-2">
          <span className="text-[11px] uppercase tracking-wider text-fg-faint font-medium">
            Quick picks
          </span>
          <div className="grid grid-cols-2 gap-1.5">
            {QUICK_PICKS.map((pick) => (
              <button
                key={pick.url}
                type="button"
                onClick={() => submit(pick.url)}
                className="flex flex-col items-start gap-0.5 px-3 py-2 rounded border border-edge-input bg-surface-input/50 hover:bg-surface-hover hover:border-accent/40 text-left transition-colors group"
                data-testid={`browser-quick-pick-${pick.label}`}
                title={`Open ${pick.url}`}
              >
                <span className="text-xs font-mono text-fg group-hover:text-fg">
                  {pick.label}
                </span>
                <span className="text-[11px] text-fg-muted truncate w-full">
                  {pick.hint}
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
