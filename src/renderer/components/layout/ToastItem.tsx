import React, { useState, useEffect, useRef, useCallback } from 'react';
import { X } from 'lucide-react';
import type { Toast } from '../../stores/toast-store';

const variantStyles: Record<Toast['variant'], string> = {
  info: 'border-blue-500/40 text-blue-300',
  success: 'border-green-500/40 text-green-300',
  warning: 'border-yellow-500/40 text-yellow-300',
  error: 'border-red-500/40 text-red-300',
};

interface ToastItemProps {
  toast: Toast;
  onDismiss: (id: string) => void;
}

export function ToastItem({ toast, onDismiss }: ToastItemProps) {
  const [visible, setVisible] = useState(false);
  const [exiting, setExiting] = useState(false);
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

  const handleDismissClick = useCallback(() => {
    setExiting(true);
  }, []);

  return (
    <div
      ref={ref}
      data-testid="toast"
      onTransitionEnd={handleTransitionEnd}
      className={`pointer-events-auto flex items-center gap-2 px-4 py-2.5 rounded-lg border
        bg-zinc-800/95 backdrop-blur-sm shadow-lg text-sm
        transition-all duration-300 ease-out
        ${variantStyles[toast.variant]}
        ${visible && !exiting ? 'translate-x-0 opacity-100' : 'translate-x-4 opacity-0'}
      `}
    >
      <span className="text-zinc-200">{toast.message}</span>

      {toast.action && (
        <button
          onClick={toast.action.onClick}
          className="underline underline-offset-2 hover:opacity-80 ml-1 flex-shrink-0"
        >
          {toast.action.label}
        </button>
      )}

      <button
        onClick={handleDismissClick}
        className="ml-1 p-0.5 text-zinc-500 hover:text-zinc-300 transition-colors flex-shrink-0"
      >
        <X size={14} />
      </button>
    </div>
  );
}
