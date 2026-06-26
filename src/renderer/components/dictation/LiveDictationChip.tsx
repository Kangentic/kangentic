import type { CSSProperties } from 'react';
import { Download, Mic, RotateCcw } from 'lucide-react';
import { useDictationStore } from '../../stores/dictation-store';
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

  const label = error
    ? error
    : downloading
      ? `Preparing model... ${downloadPercent}%`
      : recording
        ? 'Listening (typing into the terminal)'
        : status === 'finalizing'
          ? 'Inserting...'
          : 'Dictation';

  return (
    <div
      className={anchoredStyle ? 'fixed z-50' : 'fixed bottom-8 left-8 z-50'}
      style={anchoredStyle}
      data-testid="dictation-live-chip"
    >
      <div
        className={`flex items-center gap-2 rounded-full border border-edge bg-surface px-3 py-1.5 shadow-lg ${contentClassName}`}
        onAnimationEnd={onAnimationEnd}
      >
        <span className="relative flex items-center justify-center">
          {downloading ? (
            <Download size={14} className="text-accent" />
          ) : (
            <Mic size={14} className={recording ? 'text-accent' : 'text-fg-muted'} />
          )}
          {recording && (
            <span className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-accent animate-pulse" />
          )}
        </span>
        <span className="max-w-[280px] truncate text-xs text-fg-secondary">{label}</span>
        {!targetSessionId && status !== 'error' && (
          <span className="text-xs text-fg-faint">(no terminal)</span>
        )}
        {!downloading && (
          <button
            type="button"
            onClick={() => dictationPopupActions.clear()}
            className="ml-1 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-fg-muted hover:bg-surface-hover hover:text-fg"
            data-testid="dictation-live-clear"
            title="Clear and start over"
          >
            <RotateCcw size={12} /> Clear
          </button>
        )}
      </div>
    </div>
  );
}
