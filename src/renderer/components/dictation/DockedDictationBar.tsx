import type { CSSProperties } from 'react';
import { Download, Mic, RotateCcw, Send, X } from 'lucide-react';
import { useDictationStore } from '../../stores/dictation-store';
import { useOverlayPhase } from '../../hooks/useOverlayPhase';
import { useFocusedTerminalRect } from '../../hooks/useFocusedTerminalRect';
import { dictationPopupActions } from '../../hooks/useDictation';

/** Keep a centered, fixed-width box fully on screen. */
function clampHorizontalCenter(center: number, width: number): number {
  const half = width / 2;
  return Math.min(Math.max(center, half + 8), window.innerWidth - half - 8);
}

/**
 * The `docked` dictation experience: a slim bar anchored to the bottom of the
 * window, by the terminal input, so the live transcript reads as "this is going
 * here." Prototype anchoring is a fixed bottom-center bar (robust across which
 * terminal is focused); per-focused-window pixel anchoring is a follow-up.
 * Renders nothing while idle and not downloading a model.
 */
export function DockedDictationBar() {
  const status = useDictationStore((state) => state.status);
  const modelProgress = useDictationStore((state) => state.modelProgress);
  if (status === 'idle' && !modelProgress) return null;
  return <DockedDictationBarContent />;
}

function DockedDictationBarContent() {
  const status = useDictationStore((state) => state.status);
  const partialText = useDictationStore((state) => state.partialText);
  const finalText = useDictationStore((state) => state.finalText);
  const targetSessionId = useDictationStore((state) => state.targetSessionId);
  const error = useDictationStore((state) => state.error);
  const modelProgress = useDictationStore((state) => state.modelProgress);
  const { contentClassName, onAnimationEnd } = useOverlayPhase(() => undefined, { variant: 'popover' });
  // Follow the focused terminal window's input area; null = bottom panel / no
  // focus, where the fixed bottom-center fallback already sits by the input.
  const anchor = useFocusedTerminalRect();

  const downloading = modelProgress?.status === 'downloading';
  const recording = status === 'recording';
  const transcript = recording ? partialText : finalText || partialText;
  const downloadPercent = downloading && modelProgress.totalBytes > 0
    ? Math.min(100, Math.round((modelProgress.downloadedBytes / modelProgress.totalBytes) * 100))
    : 0;

  // When anchored, position the bar just above the focused window's bottom edge,
  // centered within it; the inner div keeps the entrance animation so the
  // position transform here never fights the animation's own transform.
  const barWidth = anchor ? Math.min(640, Math.max(360, anchor.width - 24)) : null;
  const anchoredStyle: CSSProperties | undefined =
    anchor && barWidth
      ? {
          position: 'fixed',
          left: clampHorizontalCenter(anchor.left + anchor.width / 2, barWidth),
          top: anchor.bottom - 12,
          width: barWidth,
          maxWidth: '92vw',
          transform: 'translate(-50%, -100%)',
        }
      : undefined;

  return (
    <div
      className={anchoredStyle ? 'fixed z-50' : 'fixed bottom-8 left-1/2 z-50 w-[640px] max-w-[80%] -translate-x-1/2'}
      style={anchoredStyle}
      data-testid="dictation-docked-bar"
    >
      <div
        className={`flex w-full items-center gap-3 rounded-lg border border-edge bg-surface px-3 py-2 shadow-lg ${contentClassName}`}
        onAnimationEnd={onAnimationEnd}
      >
        <span className="relative flex flex-shrink-0 items-center justify-center">
          {downloading ? (
            <Download size={16} className="text-accent" />
          ) : (
            <Mic size={16} className={recording ? 'text-accent' : 'text-fg-muted'} />
          )}
          {recording && (
            <span className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-accent animate-pulse" />
          )}
        </span>

        {downloading ? (
          <div className="min-w-0 flex-1">
            <div className="mb-1 text-xs text-fg-muted">Preparing the speech model... {downloadPercent}%</div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-hover">
              <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${downloadPercent}%` }} />
            </div>
          </div>
        ) : (
          <>
            <div className="min-w-0 flex-1 truncate text-sm text-fg">
              {error ? (
                <span className="text-fg-muted">{error}</span>
              ) : transcript ? (
                transcript
              ) : (
                <span className="text-fg-muted">
                  {recording ? 'Speak now...' : 'No speech captured.'}
                </span>
              )}
              {!targetSessionId && status !== 'error' && (
                <span className="ml-2 text-xs text-fg-faint">(no terminal focused)</span>
              )}
            </div>

            <div className="flex flex-shrink-0 items-center gap-1.5">
              <button
                type="button"
                onClick={() => dictationPopupActions.clear()}
                className="inline-flex items-center gap-1 rounded border border-edge-input px-2 py-1 text-xs text-fg-muted hover:bg-surface-hover hover:text-fg"
                data-testid="dictation-docked-clear"
                title="Clear and start over"
              >
                <RotateCcw size={13} /> Clear
              </button>
              <button
                type="button"
                onClick={() => dictationPopupActions.cancel()}
                className="inline-flex items-center gap-1 rounded border border-edge-input px-2 py-1 text-xs text-fg-muted hover:bg-surface-hover hover:text-fg"
                data-testid="dictation-docked-cancel"
                title="Cancel"
              >
                <X size={13} />
              </button>
              <button
                type="button"
                onClick={() => dictationPopupActions.commit()}
                disabled={!targetSessionId}
                className="inline-flex items-center gap-1 rounded bg-accent px-2.5 py-1 text-xs text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                data-testid="dictation-docked-send"
              >
                <Send size={13} /> Send
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
