import { create } from 'zustand';
import type { Announcement } from '../../shared/announcements';

interface AnnouncementsState {
  /** Active announcements for this client, filtered and sorted by the main
   *  process (targeting + expiry). Still CONTAINS dismissed items: dismissal
   *  is applied renderer-side against config.dismissedAnnouncementIds (see
   *  selectBannerAnnouncement), so a dismissal is instant with no IPC
   *  round-trip and the dismissal prune can see the full active set. */
  active: Announcement[];
  /** The announcement the "Learn more" dialog is showing; null = closed. */
  dialogAnnouncement: Announcement | null;

  /** Pull the current active list (app mount and HMR resync, Pattern B). */
  loadActive: () => Promise<void>;
  /** Called from the announcements:changed IPC push. */
  receiveActive: (active: Announcement[]) => void;
  openDialog: (announcement: Announcement) => void;
  closeDialog: () => void;
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

const createAnnouncementsStore = () => create<AnnouncementsState>((set, get) => ({
  active: [],
  dialogAnnouncement: null,

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

  receiveActive: (active) => {
    const { dialogAnnouncement } = get();
    set({
      active,
      // An open dialog for an announcement that just left the active set
      // (expired or retracted upstream) closes rather than lingering over
      // content the feed withdrew.
      dialogAnnouncement: dialogAnnouncement
        && active.some((announcement) => announcement.id === dialogAnnouncement.id)
        ? dialogAnnouncement
        : null,
    });
  },

  openDialog: (announcement) => set({ dialogAnnouncement: announcement }),
  closeDialog: () => set({ dialogAnnouncement: null }),
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
