import { RotateCcw, TriangleAlert } from 'lucide-react';
import { Trans } from '@lingui/react/macro';
import type { BrowserCrashKind } from '../../../shared/browser-crash';

/**
 * The cover a Browser pane shows over a page whose renderer process is gone
 * (task #1226, signed-off design D1 A, D2 A, D3 A).
 *
 * Opaque, over the page area only, in the slot the loading cover uses, and laid
 * out like `BrowserEmptyState`. It does not depend on what a dead `<webview>`
 * paints, and nobody mistakes the page under it for one that still works. It
 * stacks above the annotation bar, so it hides Select element and Draw, which
 * have nothing to act on. The toolbar, with its own Reload, and the note row
 * stay live.
 *
 * Reachable by an agent's crash, so nothing here takes focus on mount
 * (`.claude/rules/agent-driven-focus.md`).
 */
export function BrowserCrashedState({ kind, onReload }: { kind: BrowserCrashKind; onReload: () => void }) {
  return (
    <div
      // z-20: above the annotation bar's z-10, which floats over the page (D3 A).
      className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-4 px-6 bg-surface"
      data-testid="browser-pane-crashed"
      data-crash-kind={kind}
    >
      <div className="p-4 rounded-full bg-warning/10 border border-warning/30 text-warning">
        <TriangleAlert size={32} strokeWidth={1.5} aria-hidden="true" />
      </div>
      <div className="flex flex-col items-center gap-1.5 text-center">
        <h3 className="text-base font-semibold text-fg"><Trans>This page stopped</Trans></h3>
        <p className="text-xs text-fg-muted">
          {kind === 'out-of-memory' ? <Trans>It ran out of memory.</Trans> : <Trans>It crashed.</Trans>}
        </p>
      </div>
      <button
        type="button"
        onClick={onReload}
        className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-accent-on bg-accent-emphasis hover:bg-accent rounded transition-colors"
        data-testid="browser-pane-crashed-reload"
      >
        <RotateCcw size={14} aria-hidden="true" />
        <Trans context="Action">Reload</Trans>
      </button>
    </div>
  );
}
