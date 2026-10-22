import { create } from 'zustand';
import { useConfigStore } from './config-store';

export type ToastVariant = 'info' | 'success' | 'warning' | 'error';

/** The icon on a persistent toast's button, one per kind of action. */
export type ToastActionIcon = 'review' | 'settings' | 'retry' | 'update';

export interface ToastAction {
  label: string;
  icon?: ToastActionIcon;
  onClick: () => void;
}

/**
 * A toast in the stack. Every toast has a title (what happened, in a few
 * words) and a body (`message`: the task, the place or the detail). A timed
 * toast closes on its own once its countdown runs out, and the countdown
 * holds while the pointer is over it. A persistent toast stays until closed,
 * and only a persistent toast carries a button: a timed one could leave while
 * the user reaches for it.
 *
 * The countdown lives here rather than in the component so a Fast Refresh
 * does not restart it (see the HMR stash at the bottom).
 */
export interface Toast {
  id: string;
  title: string;
  message: string;
  variant: ToastVariant;
  persistent: boolean;
  /** A timed toast's whole countdown in ms; 0 for a persistent toast. */
  durationMs: number;
  /** The countdown left when it last stopped running, or when it was raised. */
  remainingMs: number;
  /** When the countdown last started running (epoch ms). Null while held, and for a persistent toast. */
  runningSince: number | null;
  action?: ToastAction;
  /** A click on the card opens what the toast is about (a task, a list, a workflow, a folder). */
  onOpen?: () => void;
  /** When what the toast reports happened (UTC ISO 8601), shown as its age. */
  since?: string;
}

interface ToastFields {
  /** What happened, in a few words. */
  title: string;
  /** The body: the task, the place or the detail, as one sentence. */
  message: string;
  variant?: ToastVariant;
  since?: string;
  onOpen?: () => void;
}

/** A toast that closes on its own after `durationMs` (the Notifications setting by default). */
export interface TimedToastInput extends ToastFields {
  persistent?: false;
  durationMs?: number;
  /** A timed toast has no button: it could close while the user reaches for it. Give it `onOpen` instead. */
  action?: never;
}

/** A toast that stays until closed. The only kind that carries a button. */
export interface PersistentToastInput extends ToastFields {
  persistent: true;
  action?: ToastAction;
}

export type ToastInput = TimedToastInput | PersistentToastInput;

/** What `updateToast` may change in place: the words, the age, the button. */
export type ToastPatch = Partial<Pick<Toast, 'title' | 'message' | 'variant' | 'since' | 'action' | 'onOpen'>>;

interface ToastStore {
  toasts: Toast[];
  addToast: (input: ToastInput) => string;
  /** Change a toast in place, keeping its spot in the stack and its countdown. */
  updateToast: (id: string, patch: ToastPatch) => void;
  dismissToast: (id: string) => void;
  /** Stop a timed toast's countdown (the pointer is over it). */
  holdCountdown: (id: string, now: number) => void;
  /** Start a held countdown again from where it stopped. */
  releaseCountdown: (id: string, now: number) => void;
}

/** The countdown a toast has left at `now`. */
export function countdownRemaining(toast: Pick<Toast, 'remainingMs' | 'runningSince'>, now: number): number {
  if (toast.runningSince === null) return toast.remainingMs;
  return Math.max(0, toast.remainingMs - (now - toast.runningSince));
}

/** Build a stored toast from what a caller passed. */
export function resolveToast(input: ToastInput, id: string, defaultDurationMs: number, now: number): Toast {
  const persistent = input.persistent === true;
  const durationMs = input.persistent === true ? 0 : (input.durationMs ?? defaultDurationMs);
  return {
    id,
    title: input.title,
    message: input.message,
    variant: input.variant ?? 'info',
    persistent,
    durationMs,
    remainingMs: durationMs,
    runningSince: persistent ? null : now,
    action: input.action,
    onOpen: input.onOpen,
    since: input.since,
  };
}

/** Preserve visible toasts across Vite HMR cycles so a Fast Refresh during
 *  a toast's display window doesn't vanish it mid-display. Production has no
 *  `import.meta.hot`, so this is a no-op there. Mirrors the pattern in
 *  src/renderer/stores/board-store/task-slice.ts. */
// @ts-expect-error -- Vite handles import.meta.hot; tsc's "module": "commonjs" doesn't support it
const initialToasts: Toast[] = import.meta.hot?.data?.toasts ?? [];

/**
 * Hold the stack to `maxCount`, dropping the oldest timed toasts first. A
 * persistent toast is waiting for the user, and its button can be the only
 * way to what it reports (the leftover-process Review list), so routine
 * toasts never push it out. Only when the persistent toasts alone overflow
 * the limit do the oldest of them go. The newest toast always shows.
 */
export function withinToastLimit(toasts: Toast[], maxCount: number): Toast[] {
  let excess = toasts.length - Math.max(maxCount, 1);
  if (excess <= 0) return toasts;
  const dropped = new Set<string>();
  const olderToasts = toasts.slice(0, -1);
  for (const closesOnItsOwn of [true, false]) {
    for (const toast of olderToasts) {
      if (excess === 0) break;
      if (!toast.persistent === closesOnItsOwn) {
        dropped.add(toast.id);
        excess -= 1;
      }
    }
  }
  return toasts.filter((toast) => !dropped.has(toast.id));
}

function mapToast(toasts: Toast[], id: string, change: (toast: Toast) => Toast): Toast[] {
  let changed = false;
  const next = toasts.map((toast) => {
    if (toast.id !== id) return toast;
    const updated = change(toast);
    if (updated !== toast) changed = true;
    return updated;
  });
  return changed ? next : toasts;
}

export const useToastStore = create<ToastStore>((set) => ({
  toasts: initialToasts,

  addToast: (input) => {
    const id = crypto.randomUUID();
    const toastConfig = useConfigStore.getState().config.notifications.toasts;
    const toast = resolveToast(input, id, toastConfig.durationSeconds * 1000, Date.now());
    set((state) => ({
      toasts: withinToastLimit([...state.toasts, toast], toastConfig.maxCount),
    }));
    return id;
  },

  updateToast: (id, patch) => {
    set((state) => ({ toasts: mapToast(state.toasts, id, (toast) => ({ ...toast, ...patch })) }));
  },

  dismissToast: (id) => {
    set((state) => ({
      toasts: state.toasts.filter((toast) => toast.id !== id),
    }));
  },

  holdCountdown: (id, now) => {
    set((state) => ({
      toasts: mapToast(state.toasts, id, (toast) => (toast.persistent || toast.runningSince === null
        ? toast
        : { ...toast, remainingMs: countdownRemaining(toast, now), runningSince: null })),
    }));
  },

  releaseCountdown: (id, now) => {
    set((state) => ({
      toasts: mapToast(state.toasts, id, (toast) => (toast.persistent || toast.runningSince !== null
        ? toast
        : { ...toast, runningSince: now })),
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
