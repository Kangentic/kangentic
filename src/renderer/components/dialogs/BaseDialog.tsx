import React, { useCallback, useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { useFormattedCombo } from '../../hooks/useKeybinding';
import { useOverlayPhase } from '../../hooks/useOverlayPhase';
import { MaximizeOnDoubleClick } from './MaximizeOnDoubleClick';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

/** Visible, tabbable descendants of a container, in DOM order. */
function getFocusable(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    .filter((element) => element.offsetParent !== null || element === document.activeElement);
}

interface BaseDialogProps {
  onClose: () => void;
  children: React.ReactNode;

  // Standard header (renders title + X button)
  title?: React.ReactNode;
  icon?: React.ReactNode;
  headerRight?: React.ReactNode;

  // Custom header (replaces the standard header entirely)
  header?: React.ReactNode;

  // Footer (rendered inside border-t container)
  footer?: React.ReactNode;

  // Body
  rawBody?: boolean;              // skip px-4 py-4 wrapper, render children directly
  // Extra classes appended to the non-raw body wrapper. Pass a flex-column
  // class (e.g. 'flex-1 flex flex-col') so children can absorb height when the
  // dialog is maximized. Ignored when rawBody is set.
  bodyClassName?: string;
  // Keybinding action id whose combo is shown on the standard-header X button
  // tooltip (e.g. 'panel.close'). The consumer must bind that action itself.
  // Escape always closes the dialog (the hidden `dialog.dismiss` action) and is
  // deliberately not advertised here. When omitted, the tooltip is just 'Close'.
  closeHotkeyActionId?: string;

  // Behavior
  preventBackdropClose?: boolean; // When true, clicking the backdrop does not close the dialog
  // Synchronous backdrop-click hook. When set, the consumer takes full
  // control of the close decision: this fires immediately on click without
  // the exit animation, so the consumer can interrupt close (e.g. show a
  // dirty-changes confirm) without leaving the dialog visually faded out.
  // Takes precedence over preventBackdropClose.
  onBackdropClick?: () => void;
  // Unified close-intent hook. When set, every BaseDialog-owned close gesture
  // (the standard-header X button, Escape, and a backdrop click) routes here.
  // Return true to proceed with the normal animated close; return false to
  // cancel it (e.g. the consumer is showing a "discard unsaved changes?"
  // confirm instead). Takes precedence over preventBackdropClose / onBackdropClick.
  onCloseRequest?: () => boolean;
  // Move focus into the dialog on open and keep Tab / Shift+Tab cycling within
  // it, restoring focus on close. Use for modals layered over another dialog
  // (e.g. a confirm). Do NOT use for a dialog that embeds a terminal, where Tab
  // belongs to the PTY.
  trapFocus?: boolean;
  // Ignore Escape entirely while another surface is layered over this dialog and
  // owns the key. Escape listeners here and in the layered surface are both
  // bubble-phase on `document`, so the one registered first (this dialog, which
  // mounted first) wins - and a single Escape aimed at the surface on top would
  // otherwise ALSO dismiss this dialog underneath it. The consumer owns this
  // because only it knows what it can spawn (e.g. NewTaskDialog opening the
  // Board Manager from the profile picker). Nested ConfirmDialogs do not need it:
  // they render inside this dialog's own guarded close flow.
  suppressEscape?: boolean;

  // Content mouse tracking (for callers that need hover state)
  onContentMouseEnter?: () => void;
  onContentMouseLeave?: () => void;

  // Container
  className?: string;
  zIndex?: string;
  backdropClassName?: string;
  // Backdrop position utilities (default 'inset-0'). Override to keep the
  // backdrop clear of app chrome, e.g. a maximized dialog that must leave the
  // title bar and status bar uncovered and clickable.
  backdropPositionClass?: string;
  // Content corner radius (default 'rounded-lg'). Override to 'rounded-none'
  // when the dialog fills an edge so its border meets the edges flush.
  contentRadiusClass?: string;
  testId?: string;
  // Imperative handle: BaseDialog assigns its animated, guard-aware close
  // request here. A custom-header close button or a consumer keybinding should
  // call `closeRef.current?.()` instead of calling `onClose` directly, so it
  // plays the exit animation (and honors onCloseRequest) like the standard
  // header X, Escape, and backdrop click already do.
  closeRef?: React.MutableRefObject<(() => void) | null>;
  // Double-clicking the header (standard or custom) toggles this, mirroring the
  // desktop title-bar convention. Maximizable dialogs pass their maximize
  // toggle; others omit it and the header double-click does nothing. Double-
  // clicks on interactive controls in the header are ignored.
  onHeaderDoubleClick?: () => void;
}

export function BaseDialog({
  onClose,
  children,
  title,
  icon,
  headerRight,
  header,
  footer,
  preventBackdropClose,
  onBackdropClick,
  onCloseRequest,
  trapFocus,
  suppressEscape,
  rawBody,
  bodyClassName,
  closeHotkeyActionId,
  onContentMouseEnter,
  onContentMouseLeave,
  className = 'w-[400px]',
  zIndex = 'z-50',
  backdropClassName,
  backdropPositionClass = 'inset-0',
  contentRadiusClass = 'rounded-lg',
  testId,
  closeRef,
  onHeaderDoubleClick,
}: BaseDialogProps) {
  // The shared overlay phase machine (entering -> visible -> exiting) drives the
  // open/close animation and unmounts via onClose when the exit animation ends.
  const {
    requestClose,
    backdropClassName: backdropAnimClass,
    contentClassName: contentAnimClass,
    onAnimationEnd,
  } = useOverlayPhase(onClose, { variant: 'dialog' });

  // Show the consumer's bound close hotkey (e.g. panel.close = Ctrl+Shift+W) on
  // the standard-header X tooltip. Empty id resolves to '' so the tooltip falls
  // back to plain 'Close'. Escape (the hidden universal closer) is never shown.
  const closeCombo = useFormattedCombo(closeHotkeyActionId ?? '');

  const contentRef = useRef<HTMLDivElement>(null);

  // A close gesture routed through the consumer's guard (onCloseRequest). The
  // guard returns true to proceed with the animated close, false to cancel
  // (e.g. it opened a discard confirm). Without a guard, animate-close directly.
  const requestCloseViaGuard = useCallback(() => {
    if (onCloseRequest) {
      if (onCloseRequest()) requestClose();
    } else {
      requestClose();
    }
  }, [onCloseRequest, requestClose]);

  // Expose the animated close so consumers (custom headers, keybindings, footer
  // Cancel buttons) can route through the exit animation instead of unmounting
  // instantly via onClose.
  useEffect(() => {
    if (!closeRef) return;
    closeRef.current = requestCloseViaGuard;
    return () => { closeRef.current = null; };
  }, [closeRef, requestCloseViaGuard]);

  // Focus trap for modals layered over another dialog (e.g. a confirm). On open,
  // pull focus into the dialog if it is not already inside; on close, restore it
  // to the element that had it. The Tab cycling itself is handled in onKeyDown.
  useEffect(() => {
    if (!trapFocus) return;
    const content = contentRef.current;
    if (!content) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    if (!content.contains(document.activeElement)) {
      const focusables = getFocusable(content);
      (focusables[0] ?? content).focus();
    }
    return () => {
      if (previouslyFocused && document.contains(previouslyFocused)) previouslyFocused.focus();
    };
  }, [trapFocus]);

  const handleContentKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!trapFocus || event.key !== 'Tab') return;
    const content = contentRef.current;
    if (!content) return;
    const focusables = getFocusable(content);
    if (focusables.length === 0) { event.preventDefault(); return; }
    const firstFocusable = focusables[0];
    const lastFocusable = focusables[focusables.length - 1];
    const activeElement = document.activeElement;
    if (event.shiftKey) {
      if (activeElement === firstFocusable || !content.contains(activeElement)) { event.preventDefault(); lastFocusable.focus(); }
    } else if (activeElement === lastFocusable || !content.contains(activeElement)) {
      event.preventDefault();
      firstFocusable.focus();
    }
  }, [trapFocus]);

  useEffect(() => {
    if (suppressEscape) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Route through the consumer's close-intent guard when present (e.g. a
      // dirty-changes confirm); otherwise close unless the backdrop is locked.
      // An embedded terminal that wants Escape (pointer over the PTY) consumes
      // the event itself, so this bubble-phase listener never sees it; see
      // enableTerminalClipboard.
      if (onCloseRequest) { requestCloseViaGuard(); return; }
      if (preventBackdropClose) return;
      requestClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [requestClose, preventBackdropClose, onCloseRequest, requestCloseViaGuard, suppressEscape]);

  const backdropMouseDown = useRef(false);

  return (
    <div
      className={`fixed ${backdropPositionClass} bg-black/60 flex items-center justify-center ${zIndex} ${backdropAnimClass} ${backdropClassName || ''}`}
      // Marks an open modal as a dismissable layer so a board click while a dialog
      // is up dismisses the dialog, never a window underneath (BaseDialog renders
      // inline, so a board-level / card confirm sits inside the board subtree).
      data-dismissable-layer
      onMouseDown={(e) => { backdropMouseDown.current = e.target === e.currentTarget; }}
      onMouseUp={(e) => {
        if (e.target === e.currentTarget && backdropMouseDown.current) {
          if (onCloseRequest) {
            requestCloseViaGuard();
          } else if (onBackdropClick) {
            onBackdropClick();
          } else if (!preventBackdropClose) {
            requestClose();
          }
        }
        backdropMouseDown.current = false;
      }}
    >
      <div
        ref={contentRef}
        onMouseDown={(e) => e.stopPropagation()}
        onMouseEnter={onContentMouseEnter}
        onMouseLeave={onContentMouseLeave}
        onKeyDown={trapFocus ? handleContentKeyDown : undefined}
        tabIndex={trapFocus ? -1 : undefined}
        onAnimationEnd={onAnimationEnd}
        className={`bg-surface-raised border border-edge ${contentRadiusClass} shadow-2xl flex flex-col overflow-visible ${contentAnimClass} ${className}`}
        {...(testId ? { 'data-testid': testId } : {})}
      >
        {/* Standard header */}
        {title && !header && (
          <MaximizeOnDoubleClick
            onToggle={onHeaderDoubleClick}
            className="flex items-center gap-3 px-4 py-3 border-b border-edge flex-shrink-0"
          >
            {icon && <div className="flex-shrink-0">{icon}</div>}
            <h3 className="text-sm font-semibold text-fg flex-1 min-w-0">{title}</h3>
            {headerRight}
            <button
              type="button"
              onClick={requestCloseViaGuard}
              title={closeCombo ? `Close (${closeCombo})` : 'Close'}
              aria-label="Close dialog"
              className="p-1.5 text-fg-faint hover:text-fg-tertiary hover:bg-surface-hover rounded transition-colors flex-shrink-0"
            >
              <X size={16} />
            </button>
          </MaximizeOnDoubleClick>
        )}

        {/* Custom header */}
        {header && (
          <MaximizeOnDoubleClick
            onToggle={onHeaderDoubleClick}
            className="border-b border-edge flex-shrink-0"
          >
            {header}
          </MaximizeOnDoubleClick>
        )}

        {/* Body */}
        {rawBody ? (
          <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
            {children}
          </div>
        ) : (
          <div className={`px-4 py-4 ${bodyClassName ?? ''}`}>
            {children}
          </div>
        )}

        {/* Footer */}
        {footer && (
          <div className="px-4 py-3 border-t border-edge">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
