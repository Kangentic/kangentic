import type { CSSProperties } from 'react';
import { Download, Mic, RotateCcw } from 'lucide-react';
import { useDictationStore } from '../../stores/dictation-store';
import { useConfigStore } from '../../stores/config-store';
import { useOverlayPhase } from '../../hooks/useOverlayPhase';
import { useFocusedTerminalRect } from '../../hooks/useFocusedTerminalRect';
import { dictationPopupActions } from '../../hooks/useDictation';

/**
 * The `live` dictation experience: the transcript streams straight into the
 * focused terminal's input as you speak, so this is only a small status chip
 * (mic state + a Clear control), not a transcript surface. While the model is
 * downloading on first use it shows progress, since no live typing can happen
 * until it is ready. Renders nothing while idle.
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
  const targetSessionId = useDictationStore((state) => state.targetSessionId);
  const modelProgress = useDictationStore((state) => state.modelProgress);
  const { contentClassName, onAnimationEnd } = useOverlayPhase(() => undefined, { variant: 'popover' });
  // Sit at the bottom-center of the focused terminal, raised just above the bottom
  // context bar so it sits over the input the user is watching. null = bottom
  // panel / no focus, where the fixed fallback applies.
  const anchor = useFocusedTerminalRect();
  const anchoredStyle: CSSProperties | undefined = anchor
    ? {
        position: 'fixed',
        left: (anchor.left + anchor.right) / 2,
        top: anchor.bottom - 45,
        maxWidth: '92vw',
        transform: 'translate(-50%, -100%)',
      }
    : undefined;

  const downloading = modelProgress?.status === 'downloading';
  const recording = status === 'recording';
  const downloadPercent = downloading && modelProgress.totalBytes > 0
    ? Math.min(100, Math.round((modelProgress.downloadedBytes / modelProgress.totalBytes) * 100))
    : 0;
  // Whether releasing push-to-talk submits the text or just leaves it in the
  // input. It is the one thing the terminal itself cannot show you, which is why
  // it earns the space the old "(typing into the terminal)" hint used to take.
  const autoSubmit = useConfigStore((state) => state.globalConfig.dictation?.autoSubmit ?? true);

  // Capturing with nowhere to put the text. Its own state, not a suffix: the
  // words go nowhere, so saying "Listening" in the live tone would be a lie.
  const noTarget = !targetSessionId && (recording || status === 'finalizing');

  const label = error
    ? error
    : downloading
      ? `Preparing model... ${downloadPercent}%`
      : noTarget
        ? 'No terminal focused'
        : recording
          ? 'Listening'
          : status === 'finalizing'
            ? (autoSubmit ? 'Sending...' : 'Inserting...')
            : 'Dictation';

  // Trailing hint, separated by spacing and a muted tone rather than a glyph.
  const hint = recording && !noTarget
    ? (autoSubmit ? 'Release to send' : 'Release to insert')
    : null;

  return (
    <div
      className={anchoredStyle ? 'fixed z-50' : 'fixed bottom-8 left-8 z-50'}
      style={anchoredStyle}
      data-testid="dictation-live-chip"
    >
      <div
        // The min width holds the chip steady across state changes. When anchored
        // to a focused terminal it is centred with translate(-50%) (see
        // anchoredStyle above), so a label that shrinks (Listening -> Sending...)
        // would otherwise snap the whole chip narrower and re-centre it under the
        // user's cursor at the exact moment they release the key.
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
                noTarget ? 'bg-attention' : 'bg-active'
              }`}
              data-testid="dictation-recording-dot"
              data-tone={noTarget ? 'attention' : 'active'}
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
