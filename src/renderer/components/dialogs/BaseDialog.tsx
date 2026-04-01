import React, { useCallback, useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';

type Phase = 'entering' | 'visible' | 'exiting';

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

  // Behavior
  preventBackdropClose?: boolean; // When true, clicking the backdrop does not close the dialog

  // Content mouse tracking (for callers that need hover state)
  onContentMouseEnter?: () => void;
  onContentMouseLeave?: () => void;

  // Container
  className?: string;
  zIndex?: string;
  backdropClassName?: string;
  testId?: string;
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
  rawBody,
  onContentMouseEnter,
  onContentMouseLeave,
  className = 'w-[400px]',
  zIndex = 'z-50',
  backdropClassName,
  testId,
}: BaseDialogProps) {
  const [phase, setPhase] = useState<Phase>('entering');

  const requestClose = useCallback(() => {
    if (phase !== 'exiting') setPhase('exiting');
  }, [phase]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !preventBackdropClose) requestClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [requestClose, preventBackdropClose]);

  const backdropMouseDown = useRef(false);

  const handleBackdropAnimationEnd = () => {
    if (phase === 'entering') setPhase('visible');
    if (phase === 'exiting') onClose();
  };

  const backdropAnimation = phase === 'entering'
    ? 'dialog-backdrop-in 150ms ease-out forwards'
    : phase === 'exiting'
      ? 'dialog-backdrop-out 100ms ease-in forwards'
      : 'none';

  const contentAnimation = phase === 'entering'
    ? 'dialog-content-in 150ms ease-out forwards'
    : phase === 'exiting'
      ? 'dialog-content-out 100ms ease-in forwards'
      : 'none';

  return (
    <div
      className={`fixed inset-0 bg-black/60 flex items-center justify-center ${zIndex} ${backdropClassName || ''}`}
      style={{ animation: backdropAnimation }}
      onAnimationEnd={handleBackdropAnimationEnd}
      onMouseDown={(e) => { backdropMouseDown.current = e.target === e.currentTarget; }}
      onMouseUp={(e) => {
        if (e.target === e.currentTarget && backdropMouseDown.current && !preventBackdropClose) requestClose();
        backdropMouseDown.current = false;
      }}
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        onMouseEnter={onContentMouseEnter}
        onMouseLeave={onContentMouseLeave}
        style={{ animation: contentAnimation }}
        className={`bg-surface-raised border border-edge rounded-lg shadow-2xl flex flex-col overflow-visible ${className}`}
        {...(testId ? { 'data-testid': testId } : {})}
      >
        {/* Standard header */}
        {title && !header && (
          <div className="flex items-center gap-3 px-4 py-3 border-b border-edge flex-shrink-0">
            {icon && <div className="flex-shrink-0">{icon}</div>}
            <h3 className="text-sm font-semibold text-fg flex-1">{title}</h3>
            {headerRight}
            <button
              onClick={requestClose}
              className="p-1.5 text-fg-faint hover:text-fg-tertiary hover:bg-surface-hover rounded transition-colors flex-shrink-0"
            >
              <X size={16} />
            </button>
          </div>
        )}

        {/* Custom header */}
        {header && (
          <div className="border-b border-edge flex-shrink-0">
            {header}
          </div>
        )}

        {/* Body */}
        {rawBody ? (
          <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
            {children}
          </div>
        ) : (
          <div className="px-4 py-4">
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
