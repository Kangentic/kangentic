import React from 'react';
import { useToastStore } from '../../stores/toast-store';
import { ToastItem } from './ToastItem';

export function ToastContainer() {
  const toasts = useToastStore((s) => s.toasts);
  const dismissToast = useToastStore((s) => s.dismissToast);

  if (toasts.length === 0) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed right-3 z-[60] flex flex-col items-end gap-2 pointer-events-none"
      style={{ bottom: '40px' }}
    >
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} onDismiss={dismissToast} />
      ))}
    </div>
  );
}
