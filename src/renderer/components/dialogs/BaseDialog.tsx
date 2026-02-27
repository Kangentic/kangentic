import React, { useCallback, useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';

type Phase = 'entering' | 'visible' | 'exiting';

interface BaseDialogProps {
  onClose: () => void;
  children: React.ReactNode;

  // Standard header (renders title + X button)
  title?: string;
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

  // Container
  className?: string;
  zIndex?: string;
  backdropClassName?: string;
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
  className = 'w-[400px]',
  zIndex = 'z-50',
  backdropClassName,
}: BaseDialogProps) {
  const [phase, setPhase] = useState<Phase>('entering');

  const requestClose = useCallback(() => {
    if (phase !== 'exiting') setPhase('exiting');
  }, [phase]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') requestClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [requestClose]);

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
        style={{ animation: contentAnimation }}
        className={`bg-zinc-800 border border-zinc-700 rounded-lg shadow-2xl flex flex-col overflow-visible ${className}`}
      >
        {/* Standard header */}
        {title && !header && (
          <div className="flex items-center gap-3 px-4 py-3 border-b border-zinc-700 flex-shrink-0">
            {icon && <div className="flex-shrink-0">{icon}</div>}
            <h3 className="text-sm font-semibold text-zinc-100 flex-1">{title}</h3>
            {headerRight}
            <button
              onClick={requestClose}
              className="p-1.5 text-zinc-500 hover:text-zinc-300 hover:bg-zinc-700 rounded transition-colors flex-shrink-0"
            >
              <X size={16} />
            </button>
          </div>
        )}

        {/* Custom header */}
        {header && (
          <div className="border-b border-zinc-700 flex-shrink-0">
            {header}
          </div>
        )}

        {/* Body */}
        {rawBody ? children : (
          <div className="px-4 py-4">
            {children}
          </div>
        )}

        {/* Footer */}
        {footer && (
          <div className="px-4 py-3 border-t border-zinc-700">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
