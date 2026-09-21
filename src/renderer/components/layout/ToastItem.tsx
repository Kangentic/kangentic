import { useState, useEffect, useRef, useCallback } from 'react';
import { X, Copy, Check } from 'lucide-react';
import type { Toast } from '../../stores/toast-store';

const variantStyles: Record<Toast['variant'], { border: string; accent: string }> = {
  info: { border: 'border-accent/50', accent: 'bg-accent' },
  success: { border: 'border-green-500/50', accent: 'bg-green-500' },
  warning: { border: 'border-yellow-500/50', accent: 'bg-yellow-500' },
  error: { border: 'border-red-500/50', accent: 'bg-red-500' },
};

/**
 * Backstop for the exit transition, comfortably clear of the 250ms
 * `--toast-duration` in index.css.
 *
 * Removal used to be gated on `transitionend` ALONE, and that event is not
 * guaranteed. Chromium produces no frames for a hidden page, so an occluded or
 * backgrounded window never finishes the transition and the toast never leaves
 * the store. Measured in a real window at `document.hidden === true`: a toast
 * dismissed by its X (duration 600000, so no timer was involved) and one whose
 * 4s auto-dismiss had long since fired were BOTH parked at `opacity-0` and both
 * still in the store. Agents raise toasts at windows nobody is looking at, so
 * that is the normal case here, not an edge one. A hidden page's timers are
 * throttled rather than stopped, so this still fires, just late.
 */
const EXIT_FALLBACK_MS = 1000;

/** How long the copy button reads as "copied" before reverting. */
const COPY_FEEDBACK_MS = 1500;

interface ToastItemProps {
  toast: Toast;
  onDismiss: (id: string) => void;
}

export function ToastItem({ toast, onDismiss }: ToastItemProps) {
  const [visible, setVisible] = useState(false);
  const [exiting, setExiting] = useState(false);
  const [copied, setCopied] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Enter animation: mount hidden, then transition to visible
  useEffect(() => {
    const frame = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  // Auto-dismiss timer
  useEffect(() => {
    if (toast.duration <= 0) return;
    const timer = setTimeout(() => setExiting(true), toast.duration);
    return () => clearTimeout(timer);
  }, [toast.duration]);

  // Remove from store after exit transition completes
  const handleTransitionEnd = useCallback(() => {
    if (exiting) onDismiss(toast.id);
  }, [exiting, onDismiss, toast.id]);

  // ...or after EXIT_FALLBACK_MS if that transition never ends. `dismissToast`
  // filters by id, so whichever path arrives second is a no-op rather than a
  // double removal.
  useEffect(() => {
    if (!exiting) return;
    const timer = setTimeout(() => onDismiss(toast.id), EXIT_FALLBACK_MS);
    return () => clearTimeout(timer);
  }, [exiting, onDismiss, toast.id]);

  const handleDismissClick = useCallback(() => {
    setExiting(true);
  }, []);

  // Errors are the toasts people copy: a git or spawn failure arrives here as
  // the only copy of its own message. The card is inert so the text cannot be
  // selected (see the comment on the root below), which is the cost this button
  // buys back. Scoped to `error` rather than added to every toast, because
  // nobody copies "Saved 1 column" and a button on all four variants is noise.
  const handleCopyClick = useCallback(() => {
    navigator.clipboard.writeText(toast.message).then(
      () => setCopied(true),
      // A clipboard write can be refused (no permission, no secure context).
      // Leaving the icon un-flipped is the honest signal; a fake check is worse.
      () => {},
    );
  }, [toast.message]);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    // The CARD is inert, and only the two buttons below opt back in. Do not put
    // `pointer-events-auto` back here. ToastContainer is `z-[60]`, above
    // BaseDialog's `z-50`, and it sits bottom-right - exactly where a centred
    // dialog's footer, the terminal panel, and the board all put live controls.
    // An interactive card physically covers them and swallows the click, and
    // since the card body has no onClick the click does nothing at all: not even
    // dismiss the toast. That shipped as "Save in the Column Manager does
    // nothing while agents are running".
    //
    // Viewport-none / card-auto is what Radix, sonner and react-hot-toast do,
    // but they assume the toast corner is dead space. Here it is not, so the
    // boundary is drawn one level lower. The cost is that the message is no
    // longer selectable; keeping the span hit-testable would reintroduce the
    // bug, since the span is most of the card's area. The copy button on error
    // toasts is what buys that back, which is why it is a button rather than a
    // relaxed `pointer-events` rule on the text.
    //
    // `pointer-events-none` is set explicitly rather than inherited from the
    // container, so a ToastItem rendered anywhere else is still inert. An
    // exiting toast is `opacity-0` for the whole transition and would otherwise
    // keep eating clicks while invisible.
    <div
      ref={ref}
      data-testid="toast"
      onTransitionEnd={handleTransitionEnd}
      className={`pointer-events-none flex items-stretch overflow-hidden rounded-md border
        bg-surface shadow-xl shadow-black/40 text-sm
        max-w-[min(34rem,calc(100vw-1.5rem))]
        transition-all duration-[var(--toast-duration)] ease-out
        ${variantStyles[toast.variant].border}
        ${visible && !exiting ? 'translate-y-0 opacity-100' : 'translate-y-2 opacity-0'}
      `}
    >
      <div className={`w-1 flex-shrink-0 ${variantStyles[toast.variant].accent}`} />
      {/* items-start, not items-center: a wrapped multi-line message must keep
          the dismiss button on the first line rather than floating it mid-block. */}
      <div className="flex items-start gap-2 px-3 py-2 min-w-0">
        {/* Without the width cap above (and min-w-0 here) a long message grows the
            toast leftward to the viewport edge and then truncates - a git failure
            reached ~1800px on a wide monitor and still lost its tail. */}
        <span className="text-fg-secondary min-w-0 break-words">{toast.message}</span>

        {/* The interactive children opt back in. A descendant's
            `pointer-events-auto` is hit-testable inside a `none` ancestor, which
            is the whole mechanism. They sit at the container's flush-right edge
            while a dialog is centred, so they clear a dialog footer's buttons. */}
        {toast.action && (
          <button
            onClick={toast.action.onClick}
            className="pointer-events-auto text-accent-fg underline underline-offset-2 hover:opacity-80 ml-1 flex-shrink-0"
          >
            {toast.action.label}
          </button>
        )}

        {toast.variant === 'error' && (
          <button
            onClick={handleCopyClick}
            data-testid="toast-copy"
            aria-label={copied ? 'Message copied' : 'Copy message'}
            title={copied ? 'Copied' : 'Copy message'}
            className="pointer-events-auto ml-1 p-0.5 text-fg-faint hover:text-fg-tertiary transition-colors flex-shrink-0"
          >
            {copied ? <Check size={14} className="text-green-500" /> : <Copy size={14} />}
          </button>
        )}

        <button
          onClick={handleDismissClick}
          data-testid="toast-dismiss"
          aria-label="Dismiss"
          className="pointer-events-auto ml-1 p-0.5 text-fg-faint hover:text-fg-tertiary transition-colors flex-shrink-0"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}
