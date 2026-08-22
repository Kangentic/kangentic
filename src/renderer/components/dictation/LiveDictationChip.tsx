import { useRef, type CSSProperties } from 'react';
import { Download, Mic, RotateCcw } from 'lucide-react';
import { useDictationStore } from '../../stores/dictation-store';
import { useOverlayPhase } from '../../hooks/useOverlayPhase';
import { useDictationChipPosition } from '../../hooks/useDictationChipPosition';
import { dictationPopupActions } from '../../hooks/useDictation';

/**
 * The `live` dictation experience: the transcript streams straight into the
 * focused target as you speak - a terminal, or any focused text field - so this
 * is only a small status chip (mic state +
 * a Clear control), not a transcript surface. While the model is downloading on
 * first use it shows progress, since no live typing can happen until it is
 * ready. Renders nothing while idle.
 */
export function LiveDictationChip() {
  const status = useDictationStore((state) => state.status);
  const modelProgress = useDictationStore((state) => state.modelProgress);
  // activity-state-ok: the dictation store's own status enum (idle/recording/finalizing/error), not ActivityState
  if (status === 'idle' && !modelProgress) return null;
  return <LiveDictationChipContent />;
}

function LiveDictationChipContent() {
  const status = useDictationStore((state) => state.status);
  const error = useDictationStore((state) => state.error);
  const targetKind = useDictationStore((state) => state.targetKind);
  // What release will actually do, resolved at press time. NOT the raw setting:
  // a field inside a multi-field form refuses to submit even with auto-submit
  // on, and a hint that said "Release to send" there would be a lie.
  const willSubmit = useDictationStore((state) => state.willSubmit);
  const refusal = useDictationStore((state) => state.refusal);
  const modelProgress = useDictationStore((state) => state.modelProgress);
  const { contentClassName, onAnimationEnd } = useOverlayPhase(() => undefined, { variant: 'popover' });
  // Sit against the thing the words are actually landing in: the focused text
  // field, or the bottom edge of the terminal's pane. Below it where there is
  // room, above it where there is not - which is the usual case, since both real
  // targets live at the bottom of their pane. null = nothing anchorable, where
  // the fixed corner fallback applies. See `utils/dictation-anchor.ts`.
  const chipRef = useRef<HTMLDivElement | null>(null);
  const placement = useDictationChipPosition(chipRef);
  const anchoredStyle: CSSProperties | undefined = placement
    ? {
        position: 'fixed',
        left: placement.left,
        top: placement.top,
        maxWidth: '92vw',
      }
    : undefined;

  const downloading = modelProgress?.status === 'downloading';
  const recording = status === 'recording';
  const downloadPercent = downloading && modelProgress.totalBytes > 0
    ? Math.min(100, Math.round((modelProgress.downloadedBytes / modelProgress.totalBytes) * 100))
    : 0;

  // Capturing with nowhere to put the text. Its own state, not a suffix: the
  // words go nowhere, so saying "Listening" in the live tone would be a lie.
  //
  // Keyed on the target KIND, not on `targetSessionId`: an input target has no
  // session behind it (the renderer writes to the DOM node directly), so a
  // session-id test would report every one of them as "no target".
  const noTarget = targetKind === null && (recording || status === 'finalizing');

  // Declined, not recording: the target terminal's previous auto-submit is still
  // landing and fresh bytes would split its bracketed paste. Named plainly, in
  // the attention tone, because the button doing nothing for a second or two is
  // what made this read as broken.
  const busy = status === 'busy';

  const label = error
    ? error
    : busy
      ? 'Still sending the last one'
      : downloading
      ? `Preparing model... ${downloadPercent}%`
      : noTarget
        ? (refusal === 'password'
          // Naming the reason matters here: the user is looking straight at a
          // field they just clicked, so "nothing focused" reads as a bug rather
          // than as the deliberate refusal it is.
          ? 'Dictation is off in password fields'
          : 'No terminal or input focused')
        : recording
          ? 'Listening'
          : status === 'finalizing'
            ? (willSubmit ? 'Sending...' : 'Inserting...')
            : 'Dictation';

  // Trailing hint, separated by spacing and a muted tone rather than a glyph.
  const hint = recording && !noTarget
    ? (willSubmit ? 'Release to send' : 'Release to insert')
    : null;

  return (
    <div
      ref={chipRef}
      // Top of everything, deliberately one above the portaled-popover tier
      // (`z-[2147483646]`, see .claude/rules/popover-escapes-clipping.md). This
      // is a transient status readout for a live microphone: whatever else is on
      // screen, it must be the thing the user can see, and at z-50 it sat under
      // toasts (60), the walkthrough (70), every portaled menu, and the tile
      // splitters (2000000000). 2147483647 is the CSS maximum, so nothing can
      // outrank it without going out of range. Its nearest stacking context is
      // the document root (verified: chip -> div -> #root -> body, none of them
      // trapping), so the value actually applies globally rather than being
      // scoped to a subtree.
      className={anchoredStyle
        ? 'fixed z-[2147483647]'
        : 'fixed bottom-8 left-8 z-[2147483647]'}
      style={anchoredStyle}
      data-testid="dictation-live-chip"
      data-placement={placement?.placement ?? 'fallback'}
    >
      <div
        // The min width holds the chip steady across state changes: a label that
        // shrinks (Listening -> Sending...) would otherwise snap the whole chip
        // narrower and re-place it at the exact moment the user releases the key.
        className={`flex min-w-[min(17rem,80vw)] items-center gap-2 rounded-full border border-edge bg-surface px-3 py-1.5 shadow-lg ${contentClassName}`}
        onAnimationEnd={onAnimationEnd}
      >
        <span className="relative flex items-center justify-center">
          {downloading ? (
            <Download size={14} className="text-accent" />
          ) : (
            <Mic size={14} className={status === 'error' ? 'text-danger' : 'text-fg-muted'} />
          )}
          {/* The dot, not the glyph, carries the live-capture signal: `active` is
              the one state token every theme leaves alone, and keeping the mic
              muted is what lets the dot read as a light ON the glyph rather than
              part of it. Tinting both the same color is what this replaced. */}
          {recording && (
            <span
              className={`absolute -right-1 -top-1 h-2 w-2 rounded-full animate-pulse ${
                noTarget || busy ? 'bg-attention' : 'bg-active'
              }`}
              data-testid="dictation-recording-dot"
              data-tone={noTarget || busy ? 'attention' : 'active'}
            />
          )}
        </span>
        <span className="max-w-[280px] truncate text-xs text-fg-secondary">{label}</span>
        {hint && <span className="truncate text-xs text-fg-faint">{hint}</span>}
        {!downloading && (
          <>
            {/* Pushes Clear to the trailing edge, so the copy stays left-aligned
                while the chip holds its min width. */}
            <span className="flex-1" aria-hidden />
            <div className="w-px h-4 bg-edge mx-1" aria-hidden />
            <button
              type="button"
              onClick={() => dictationPopupActions.clear()}
              className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-xs text-fg-muted hover:bg-surface-hover hover:text-fg"
              data-testid="dictation-live-clear"
              title="Clear and start over"
            >
              <RotateCcw size={12} /> Clear
            </button>
          </>
        )}
      </div>
    </div>
  );
}
