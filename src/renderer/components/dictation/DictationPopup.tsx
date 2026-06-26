import { Download, Mic, RotateCcw, Send, X } from 'lucide-react';
import { useDictationStore } from '../../stores/dictation-store';
import { useOverlayPhase } from '../../hooks/useOverlayPhase';
import { dictationPopupActions } from '../../hooks/useDictation';

/**
 * Live-transcript popup for voice dictation. Always mounted from AppLayout;
 * renders nothing while idle (and not downloading a model). The revising
 * hypothesis is safe to show here because only the finalized text is written
 * into the terminal.
 */
export function DictationPopup() {
  const status = useDictationStore((state) => state.status);
  const modelProgress = useDictationStore((state) => state.modelProgress);
  if (status === 'idle' && !modelProgress) return null;
  return <DictationPopupContent />;
}

function DictationPopupContent() {
  const status = useDictationStore((state) => state.status);
  const partialText = useDictationStore((state) => state.partialText);
  const finalText = useDictationStore((state) => state.finalText);
  const targetSessionId = useDictationStore((state) => state.targetSessionId);
  const error = useDictationStore((state) => state.error);
  const modelProgress = useDictationStore((state) => state.modelProgress);
  const { contentClassName, onAnimationEnd } = useOverlayPhase(() => undefined, { variant: 'popover' });

  const downloading = modelProgress?.status === 'downloading';
  const recording = status === 'recording';
  const transcript = recording ? partialText : finalText || partialText;
  const downloadPercent = downloading && modelProgress.totalBytes > 0
    ? Math.min(100, Math.round((modelProgress.downloadedBytes / modelProgress.totalBytes) * 100))
    : 0;

  const headerLabel =
    status === 'error'
      ? 'Dictation error'
      : downloading
        ? 'Preparing model...'
        : recording
          ? 'Listening...'
          : status === 'finalizing'
            ? 'Transcribing...'
            : 'Dictation';

  return (
    <div className="fixed bottom-6 right-6 z-50 w-80" data-testid="dictation-popup">
      <div
        className={`rounded-lg border border-edge bg-surface shadow-lg ${contentClassName}`}
        onAnimationEnd={onAnimationEnd}
      >
        <div className="flex items-center gap-2 border-b border-edge px-3 py-2">
          <span className="relative flex items-center justify-center">
            {downloading ? (
              <Download size={16} className="text-accent" />
            ) : (
              <Mic size={16} className={recording ? 'text-accent' : 'text-fg-muted'} />
            )}
            {recording && (
              <span className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-accent animate-pulse" />
            )}
          </span>
          <span className="text-xs font-medium text-fg">{headerLabel}</span>
        </div>

        {downloading ? (
          <div className="px-3 py-3" data-testid="dictation-model-download">
            <div className="mb-2 text-xs text-fg-muted">
              Downloading the speech model for the first time. This happens once.
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-hover">
              <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${downloadPercent}%` }} />
            </div>
            <div className="mt-1 text-right text-[11px] text-fg-faint">{downloadPercent}%</div>
          </div>
        ) : (
          <>
            <div className="max-h-40 min-h-[3rem] overflow-y-auto px-3 py-3 text-sm text-fg whitespace-pre-wrap break-words">
              {error ? (
                <span className="text-sm text-fg-muted">{error}</span>
              ) : transcript ? (
                transcript
              ) : (
                <span className="text-sm text-fg-muted">{recording ? 'Speak now.' : 'No speech captured.'}</span>
              )}
            </div>

            {!targetSessionId && status !== 'error' && (
              <div className="px-3 pb-2 text-xs text-fg-muted">
                No terminal focused. Focus a terminal to insert text.
              </div>
            )}

            <div className="flex items-center justify-end gap-2 border-t border-edge px-3 py-2">
              <button
                type="button"
                onClick={() => dictationPopupActions.clear()}
                className="inline-flex items-center gap-1 rounded border border-edge-input px-2.5 py-1 text-xs text-fg-muted hover:bg-surface-hover hover:text-fg"
                data-testid="dictation-clear"
                title="Clear and start over"
              >
                <RotateCcw size={13} /> Clear
              </button>
              <button
                type="button"
                onClick={() => dictationPopupActions.cancel()}
                className="inline-flex items-center gap-1 rounded border border-edge-input px-2.5 py-1 text-xs text-fg-muted hover:bg-surface-hover hover:text-fg"
                data-testid="dictation-cancel"
              >
                <X size={13} /> Cancel
              </button>
              <button
                type="button"
                onClick={() => dictationPopupActions.commit()}
                disabled={!targetSessionId}
                className="inline-flex items-center gap-1 rounded bg-accent px-2.5 py-1 text-xs text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                data-testid="dictation-send"
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
