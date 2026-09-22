import { useToastStore } from '../../stores/toast-store';
import { ToastItem } from './ToastItem';

export function ToastContainer() {
  const toasts = useToastStore((s) => s.toasts);
  const dismissToast = useToastStore((s) => s.dismissToast);

  if (toasts.length === 0) return null;

  return (
    // `role="status"` is on the CONTAINER, not the item: board-manager-automations.spec.ts's
    // saveManager reads `[role="status"]` to report which column refused a save.
    //
    // `bottom: 40px` clears the 36px status bar (`h-9`) by 4px. Nothing else is
    // clear of this corner, which is why ToastItem's card is inert rather than
    // interactive - the stack grows upward into a centred dialog's footer.
    //
    // `z-[60]` is pinned from two directions: popover-escapes-clipping.md
    // justifies every portaled menu's `z-[2147483646]` by clearing this layer,
    // and AnnouncementDialog pins itself here to layer over its history dialog.
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
