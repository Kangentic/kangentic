import { create } from 'zustand';
import { useConfigStore } from './config-store';

export type ToastVariant = 'info' | 'success' | 'warning' | 'error';

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface Toast {
  id: string;
  message: string;
  variant: ToastVariant;
  duration: number;
  action?: ToastAction;
}

export interface ToastInput {
  message: string;
  variant?: ToastVariant;
  duration?: number;
  action?: ToastAction;
}

interface ToastStore {
  toasts: Toast[];
  addToast: (input: ToastInput) => string;
  dismissToast: (id: string) => void;
}

/** Preserve visible toasts across Vite HMR cycles so a Fast Refresh during
 *  a toast's display window doesn't vanish it mid-display. Production has no
 *  `import.meta.hot`, so this is a no-op there. Mirrors the pattern in
 *  src/renderer/stores/board-store/task-slice.ts. */
// @ts-expect-error -- Vite handles import.meta.hot; tsc's "module": "commonjs" doesn't support it
const initialToasts: Toast[] = import.meta.hot?.data?.toasts ?? [];

/**
 * Hold the stack to `maxCount`, dropping the oldest toasts that close on their
 * own first. A toast that stays until closed (`duration <= 0`) is waiting for
 * the user, and its action can be the only way to what it reports (the
 * leftover-process Review list), so routine toasts never push it out. Only
 * when the waiting toasts alone overflow the limit do the oldest of them go.
 * The newest toast always shows.
 */
export function withinToastLimit(toasts: Toast[], maxCount: number): Toast[] {
  let excess = toasts.length - Math.max(maxCount, 1);
  if (excess <= 0) return toasts;
  const dropped = new Set<string>();
  const olderToasts = toasts.slice(0, -1);
  for (const closesOnItsOwn of [true, false]) {
    for (const toast of olderToasts) {
      if (excess === 0) break;
      if ((toast.duration > 0) === closesOnItsOwn) {
        dropped.add(toast.id);
        excess -= 1;
      }
    }
  }
  return toasts.filter((toast) => !dropped.has(toast.id));
}

export const useToastStore = create<ToastStore>((set) => ({
  toasts: initialToasts,

  addToast: (input) => {
    const id = crypto.randomUUID();
    const toastConfig = useConfigStore.getState().config.notifications.toasts;
    const defaultDuration = toastConfig.durationSeconds * 1000;
    const maxCount = toastConfig.maxCount;
    const toast: Toast = {
      id,
      message: input.message,
      variant: input.variant ?? 'info',
      duration: input.duration ?? defaultDuration,
      action: input.action,
    };
    set((s) => ({
      toasts: withinToastLimit([...s.toasts, toast], maxCount),
    }));
    return id;
  },

  dismissToast: (id) => {
    set((s) => ({
      toasts: s.toasts.filter((t) => t.id !== id),
    }));
  },
}));

// @ts-expect-error -- Vite handles import.meta.hot
if (import.meta.hot) {
  // @ts-expect-error -- Vite handles import.meta.hot
  import.meta.hot.dispose((data: Record<string, unknown>) => {
    data.toasts = useToastStore.getState().toasts;
  });
}
