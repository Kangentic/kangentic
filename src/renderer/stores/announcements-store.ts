import { create } from 'zustand';
import {
  countUnreadAnnouncements,
  markArchiveEntryRead,
  reconcileOpenDialog,
  type Announcement,
  type AnnouncementArchiveEntry,
  type AnnouncementDialogSource,
} from '../../shared/announcements';

interface AnnouncementsState {
  /** Active announcements for this client, filtered and sorted by the main
   *  process (targeting + expiry). Still CONTAINS dismissed items: dismissal
   *  is applied renderer-side against config.dismissedAnnouncementIds (see
   *  selectBannerAnnouncement), so a dismissal is instant with no IPC
   *  round-trip and the dismissal prune can see the full active set. */
  active: Announcement[];
  /** The local archive, most recently seen first: every announcement ever active
   *  for this client, plus read-state. Backs the megaphone's history list and
   *  its unread badge, and unlike `active` it is populated from disk at mount,
   *  so it is non-empty during the 10s before the first poll and while
   *  offline. */
  history: AnnouncementArchiveEntry[];
  /** The announcement the "Learn more" dialog is showing; null = closed. */
  dialogAnnouncement: Announcement | null;
  /** Where the open dialog was opened from. Load-bearing: receiveActive
   *  reconciles a 'banner' dialog against the active list but must leave a
   *  'history' one alone. */
  dialogSource: AnnouncementDialogSource | null;
  /** Whether the megaphone's history dialog is showing. */
  historyOpen: boolean;

  /** Pull the current active list (app mount and HMR resync, Pattern B). */
  loadActive: () => Promise<void>;
  /** Pull the archive (app mount and HMR resync, Pattern B). */
  loadHistory: () => Promise<void>;
  /** Called from the announcements:changed IPC push. */
  receiveActive: (active: Announcement[]) => void;
  /** Called from the announcements:changed IPC push. */
  receiveHistory: (history: AnnouncementArchiveEntry[]) => void;
  openDialog: (announcement: Announcement, source: AnnouncementDialogSource) => void;
  closeDialog: () => void;
  /** Stamp an archive entry read. Optimistic, then fire-and-forget over IPC. */
  markRead: (announcementId: string) => void;
  openHistory: () => void;
  closeHistory: () => void;
}

/**
 * The announcement the banner shows: the first active entry the user has not
 * dismissed (main pre-sorted by priority, then recency). One at a time, no
 * stacking. Pure so the banner component and tests share it.
 */
export function selectBannerAnnouncement(
  active: Announcement[],
  dismissedIds: string[],
): Announcement | null {
  return active.find((announcement) => !dismissedIds.includes(announcement.id)) ?? null;
}

/**
 * The megaphone badge count: unread archive entries.
 *
 * Deliberately NOT filtered by dismissal. Dismissed hides the banner; read
 * silences the badge. A dismissed-but-unread announcement still counts, because
 * the megaphone means "there is something you have not read".
 */
export function selectUnreadAnnouncementCount(history: AnnouncementArchiveEntry[]): number {
  return countUnreadAnnouncements(history);
}

const createAnnouncementsStore = () => create<AnnouncementsState>((set, get) => ({
  active: [],
  history: [],
  dialogAnnouncement: null,
  dialogSource: null,
  historyOpen: false,

  loadActive: async () => {
    // Optional chaining: during Vite HMR full reloads the preload bridge may
    // predate this namespace (see the onPathMissing note in App.tsx).
    const active = await window.electronAPI.announcements?.getActive();
    // Route through receiveActive so BOTH entry points apply the same
    // dialog reconciliation: an HMR resync re-pull (Pattern B) that finds the
    // open dialog's announcement gone must close it exactly like the push
    // path does, not leave it rendering withdrawn content.
    if (active) get().receiveActive(active);
  },

  loadHistory: async () => {
    const history = await window.electronAPI.announcements?.getHistory();
    if (history) get().receiveHistory(history);
  },

  receiveActive: (active) => {
    const { dialogAnnouncement, dialogSource } = get();
    // A banner-opened dialog for an announcement that just left the active set
    // (expired or retracted upstream) closes rather than lingering over content
    // the feed withdrew. A history-opened one survives: history exists to show
    // announcements that are no longer active, and this path runs on every poll
    // AND every HMR resync, so reconciling it would close the dialog out from
    // under the user on every renderer edit in dev.
    const keptDialog = reconcileOpenDialog(dialogAnnouncement, dialogSource, active);
    set({
      active,
      dialogAnnouncement: keptDialog,
      dialogSource: keptDialog ? dialogSource : null,
    });
  },

  receiveHistory: (history) => set({ history }),

  openDialog: (announcement, source) => {
    // Opening from ANY entry point marks it read: the badge tracks what the
    // user has seen, and both the banner's "Learn more" and a history row show
    // the same full content.
    get().markRead(announcement.id);
    set({ dialogAnnouncement: announcement, dialogSource: source });
  },

  closeDialog: () => set({ dialogAnnouncement: null, dialogSource: null }),

  markRead: (announcementId) => {
    const { history } = get();
    const stamped = markArchiveEntryRead(history, announcementId, new Date());
    // Update optimistically so the badge never lags a round-trip. Identity means
    // the local copy had nothing to change, so skip the re-render only.
    if (stamped !== history) set({ history: stamped });
    // The IPC fires UNCONDITIONALLY, even when the local copy changed nothing.
    // Main owns the durable archive, and this store's `history` can legitimately
    // be behind it: mount fires loadActive() and loadHistory() together without
    // awaiting, so after a renderer reload the banner (served from main's
    // already-warm cachedActive) can render and be clicked while the archive's
    // disk read is still in flight. Gating the write on the local copy would
    // silently drop that read forever. Main's handler no-ops on an unknown or
    // already-read id, so an extra call is free.
    // Fire-and-forget: failing to persist must not break the UI (same shape as
    // dismissAnnouncement in config-store.ts).
    void window.electronAPI.announcements?.markRead(announcementId).catch(() => undefined);
  },

  openHistory: () => set({ historyOpen: true }),
  closeHistory: () => set({ historyOpen: false }),
}));

// HMR instance pinning (Pattern E, see .claude/rules/hmr-patterns.md): this
// module's only runtime export is the non-component hook, so it is not a
// React Fast Refresh boundary. Pin the instance in `import.meta.hot.data` so
// a Fast Refresh cannot hand a second store to the banner while the dialog
// stays subscribed to the first.
// @ts-expect-error -- Vite handles import.meta.hot; tsc's "module": "commonjs" doesn't support it
const preservedAnnouncementsStore: ReturnType<typeof createAnnouncementsStore> | undefined = import.meta.hot?.data?.announcementsStore;

export const useAnnouncementsStore = preservedAnnouncementsStore ?? createAnnouncementsStore();

// @ts-expect-error -- Vite handles import.meta.hot; tsc's "module": "commonjs" doesn't support it
if (import.meta.hot) {
  // @ts-expect-error -- Vite handles import.meta.hot
  import.meta.hot.data.announcementsStore = useAnnouncementsStore;
  // Editing this module's OWN code would leave the pinned instance running
  // stale closures; force a clean full reload instead. Rare; prod is
  // unaffected (import.meta.hot is undefined there, so this block is dropped).
  // @ts-expect-error -- Vite handles import.meta.hot
  import.meta.hot.accept(() => import.meta.hot.invalidate());
}
