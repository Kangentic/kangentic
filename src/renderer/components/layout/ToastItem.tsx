import { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import { X, Copy, Check, List, Settings, RotateCw, Download } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { countdownRemaining, type Toast, type ToastActionIcon } from '../../stores/toast-store';
import { useNow } from '../../hooks/useNow';
import { formatTimeAgo } from '../../lib/datetime';
import { motionReduced } from '../../utils/motion-reduced';
import { Tooltip } from '../Tooltip';

/** How often a toast's age re-reads the clock; it shows whole minutes. */
const AGE_TICK_MS = 30_000;

/** The card's fixed width, so a stack lines up on both edges whatever it says. */
const TOAST_WIDTH_PX = 380;

/**
 * "2 min ago" for a toast's `since`, kept current while it is up, as a muted
 * outlined pill after the title.
 */
function ToastAge({ since }: { since: string }) {
  const now = useNow(AGE_TICK_MS);
  const age = formatTimeAgo(since, now);
  if (!age) return null;
  return (
    <span
      data-testid="toast-age"
      className="flex-shrink-0 whitespace-nowrap rounded-full border border-edge px-[7px] text-[11px] leading-4 text-fg-muted"
    >
      {age}
    </span>
  );
}

/** The border tint, and the countdown line's track and fill, per variant. */
const variantStyles: Record<Toast['variant'], { border: string; track: string; fill: string }> = {
  info: { border: 'border-accent/50', track: 'bg-accent/20', fill: 'bg-accent' },
  success: { border: 'border-green-500/50', track: 'bg-green-500/20', fill: 'bg-green-500' },
  warning: { border: 'border-yellow-500/50', track: 'bg-yellow-500/20', fill: 'bg-yellow-500' },
  error: { border: 'border-red-500/50', track: 'bg-red-500/20', fill: 'bg-red-500' },
};

const ACTION_ICONS: Record<ToastActionIcon, LucideIcon> = {
  review: List,
  settings: Settings,
  retry: RotateCw,
  update: Download,
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

/** One step a second with Animations off, so the line still says how long is left without moving smoothly. */
const REDUCED_MOTION_STEP_MS = 1000;

/**
 * The 2px line along a timed toast's bottom edge, filling as its countdown
 * runs. One Web Animation spans the whole countdown and is played and paused
 * with it, so a held toast's line stops exactly where it is and carries on
 * from there. A CSS keyframe could not be the clock: `.no-motion` zeroes every
 * animation's duration, and `animationend` is not reliable on a hidden page.
 * The dismissal is the JS timer in `ToastItem`; this only draws it.
 */
function CountdownLine({ toast }: { toast: Toast }) {
  const fillRef = useRef<HTMLDivElement>(null);
  const animationRef = useRef<Animation | null>(null);
  const styles = variantStyles[toast.variant];

  useLayoutEffect(() => {
    const fill = fillRef.current;
    if (!fill || typeof fill.animate !== 'function' || toast.durationMs <= 0) return;
    const steps = Math.max(1, Math.ceil(toast.durationMs / REDUCED_MOTION_STEP_MS));
    const animation = fill.animate(
      [{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }],
      {
        duration: toast.durationMs,
        easing: motionReduced() ? `steps(${steps}, end)` : 'linear',
        fill: 'forwards',
      },
    );
    animation.pause();
    animationRef.current = animation;
    return () => {
      animation.cancel();
      animationRef.current = null;
    };
  }, [toast.durationMs]);

  useLayoutEffect(() => {
    const animation = animationRef.current;
    if (!animation) return;
    animation.currentTime = toast.durationMs - countdownRemaining(toast, Date.now());
    if (toast.runningSince === null) animation.pause();
    else animation.play();
  }, [toast]);

  return (
    <div className={`absolute inset-x-0 bottom-0 h-0.5 ${styles.track}`} data-testid="toast-countdown">
      <div ref={fillRef} className={`h-full w-full origin-left ${styles.fill}`} style={{ transform: 'scaleX(0)' }} />
    </div>
  );
}

interface ToastItemProps {
  toast: Toast;
  onDismiss: (id: string) => void;
  /** False while a dialog or the settings panel is open: nothing on the card takes a click. */
  interactive: boolean;
}

export function ToastItem({ toast, onDismiss, interactive }: ToastItemProps) {
  const [visible, setVisible] = useState(false);
  const [exiting, setExiting] = useState(false);
  const [copied, setCopied] = useState(false);

  // Enter animation: mount hidden, then transition to visible
  useEffect(() => {
    const frame = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  // The countdown's dismissal. Re-armed whenever it starts or stops, so a
  // held toast never closes under the pointer and a released one closes when
  // what was left of it runs out.
  useEffect(() => {
    if (toast.persistent || toast.runningSince === null) return;
    const timer = setTimeout(() => setExiting(true), countdownRemaining(toast, Date.now()));
    return () => clearTimeout(timer);
  }, [toast]);

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

  // The X is the user's own close, the one place a toast's `onDismiss` runs. An
  // exiting card's X still takes clicks until it unmounts, so a second click
  // during the exit is ignored rather than running `onDismiss` again.
  const handleDismissClick = useCallback(() => {
    if (exiting) return;
    toast.onDismiss?.();
    setExiting(true);
  }, [toast, exiting]);

  // A click anywhere on a card that opens something opens it, then closes the
  // toast. The card's own buttons keep their clicks.
  const handleCardClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (!toast.onOpen) return;
    if (event.target instanceof Element && event.target.closest('button')) return;
    toast.onOpen();
    setExiting(true);
  }, [toast]);

  // Errors are the toasts people copy: a git or spawn failure arrives here as
  // the only copy of its own message. The card's text cannot be selected
  // (see the root below), which is the cost this button buys back. Scoped to
  // `error`, because nobody copies "Saved 1 column".
  const copyText = `${toast.title}\n${toast.message}`;
  const handleCopyClick = useCallback(() => {
    navigator.clipboard.writeText(copyText).then(
      () => setCopied(true),
      // A clipboard write can be refused (no permission, no secure context).
      // Leaving the icon un-flipped is the honest signal; a fake check is worse.
      () => {},
    );
  }, [copyText]);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  const opens = toast.onOpen !== undefined && interactive;
  // Only the card's own controls opt back in, and only while no dialog is open.
  const controlPointer = interactive ? 'pointer-events-auto' : 'pointer-events-none';
  const ActionIcon = toast.action?.icon ? ACTION_ICONS[toast.action.icon] : null;
  const styles = variantStyles[toast.variant];

  return (
    // A card that opens nothing is inert, and only its buttons opt back in. Do
    // not put `pointer-events-auto` on such a card. ToastContainer is `z-[60]`,
    // above BaseDialog's `z-50`, and it sits bottom-right - exactly where a
    // centred dialog's footer, the terminal panel, and the board all put live
    // controls. A card that took clicks there with nothing to do on them
    // swallowed them: that shipped as "Save in the Column Manager does nothing
    // while agents are running".
    //
    // A card that opens something (a task, a list, a workflow, a folder) does
    // take its clicks, because a click on it now does something. While a dialog
    // or the settings panel is open, no card and no button takes a click (the
    // container is `inert` then, see ToastContainer), which is the case that bug
    // came from. A held countdown comes from the container tracking the pointer,
    // never from the card taking it, so a click-through card still holds.
    //
    // An exiting toast is `opacity-0` for the whole transition, and an inert
    // card keeps it from eating clicks while invisible.
    <div
      data-testid="toast"
      data-toast-id={toast.id}
      data-variant={toast.variant}
      data-persistent={toast.persistent ? 'true' : 'false'}
      onTransitionEnd={handleTransitionEnd}
      onClick={opens ? handleCardClick : undefined}
      style={{ width: TOAST_WIDTH_PX }}
      className={`relative max-w-[calc(100vw-1.5rem)] overflow-hidden rounded-md border bg-surface text-sm
        shadow-xl shadow-black/40 transition-all duration-[var(--toast-duration)] ease-out
        ${styles.border}
        ${opens ? 'pointer-events-auto cursor-pointer select-none hover:bg-surface-raised hover:shadow-2xl' : 'pointer-events-none'}
        ${visible && !exiting ? 'translate-y-0 opacity-100' : 'translate-y-2 opacity-0'}
      `}
    >
      <div className="flex min-w-0 flex-col gap-1 pb-3 pl-3.5 pr-2.5 pt-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate text-sm font-semibold text-fg" data-testid="toast-title">{toast.title}</span>
          {toast.since && <ToastAge since={toast.since} />}
          <span className="flex-1" />
          {toast.variant === 'error' && (
            <Tooltip label={copied ? 'Message copied' : 'Copy message'}>
              <button
                type="button"
                onClick={handleCopyClick}
                data-testid="toast-copy"
                aria-label={copied ? 'Message copied' : 'Copy message'}
                className={`${controlPointer} flex flex-shrink-0 p-0.5 text-fg-faint transition-colors hover:text-fg-tertiary`}
              >
                {copied ? <Check size={14} className="text-green-500" /> : <Copy size={14} />}
              </button>
            </Tooltip>
          )}
          <button
            type="button"
            onClick={handleDismissClick}
            data-testid="toast-dismiss"
            aria-label="Dismiss"
            className={`${controlPointer} flex flex-shrink-0 p-0.5 text-fg-faint transition-colors hover:text-fg-tertiary`}
          >
            <X size={14} />
          </button>
        </div>
        {/* A body breaks only where it has to: copy is one sentence on one
            line, and only a task or file name is long enough to wrap. */}
        <span className="min-w-0 break-words text-[13px] leading-[19px] text-fg-muted" data-testid="toast-body">
          {toast.message}
        </span>
        {toast.action && (
          <div className="mt-1.5 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={toast.action.onClick}
              data-testid="toast-action"
              className={`${controlPointer} inline-flex h-[26px] items-center gap-1.5 whitespace-nowrap rounded-[5px] border border-edge-input bg-surface-hover/45 px-2.5 text-xs text-fg-secondary transition-colors hover:bg-surface-hover`}
            >
              {ActionIcon ? <ActionIcon size={13} aria-hidden="true" /> : null}
              {toast.action.label}
            </button>
          </div>
        )}
      </div>
      {!toast.persistent && <CountdownLine toast={toast} />}
    </div>
  );
}
