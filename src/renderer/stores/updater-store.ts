import { create } from 'zustand';
import type { UpdateDownloadedInfo } from '../../shared/types';
import { useConfigStore } from './config-store';
import { useToastStore } from './toast-store';

interface UpdaterState {
  pendingUpdate: UpdateDownloadedInfo | null;
  isModalOpen: boolean;
  /** True when the modal opened itself (a fresh version landed) rather than
   *  from the user clicking the title-bar indicator. Drives whether the
   *  dialog traps focus - an unbidden modal must not steal focus from a PTY
   *  mid-keystroke. */
  autoOpened: boolean;

  /** True while the post-update "What's New" dialog is showing. Deliberately
   *  independent of `isModalOpen`, which belongs to the pre-restart flow: the
   *  two dialogs have different triggers, lifecycles, and footers. */
  whatsNewOpen: boolean;
  /** The what's-new counterpart to `autoOpened`: gates focus trapping so the
   *  once-per-version auto-open never steals focus from a PTY mid-keystroke,
   *  while a click on the status-bar version pill traps normally. */
  whatsNewAutoOpened: boolean;

  /** Called from the update-downloaded IPC push. Auto-opens the modal once
   *  per version; a version already seen (or a relaunch after "Later") does
   *  not reopen it. Falls back to the legacy persistent toast when there are
   *  no notes to show. */
  receiveUpdate: (info: UpdateDownloadedInfo) => void;
  /** Opens the modal for the pending update. Used by the title-bar indicator
   *  to reopen a dismissed modal. */
  openModal: () => void;
  /** Closes the modal and records the version as seen. The title-bar
   *  indicator stays available for the rest of the session, and after a
   *  relaunch the re-delivered update re-shows the indicator without
   *  auto-opening the modal again. */
  dismiss: () => void;

  /** Opens the post-update "What's New" dialog. `autoOpened` is true for the
   *  once-per-version launch check and false for the status-bar version pill. */
  openWhatsNew: (options: { autoOpened: boolean }) => void;
  /** Closes the what's-new dialog. Does NOT write the config marker: that is
   *  written when the dialog opens, so quitting without closing it still counts
   *  as shown. See useWhatsNewOnLaunch. */
  closeWhatsNew: () => void;
}

const createUpdaterStore = () => create<UpdaterState>((set, get) => ({
  pendingUpdate: null,
  isModalOpen: false,
  autoOpened: false,
  whatsNewOpen: false,
  whatsNewAutoOpened: false,

  receiveUpdate: (info) => {
    if (!info.releaseNotes?.trim()) {
      // No notes to show: keep today's toast behavior verbatim rather than
      // opening an empty modal. Clear any pending update first - a SECOND
      // update can land in a long-lived session (the updater re-checks every
      // 4 hours), and leaving an earlier version's `pendingUpdate` in place
      // would keep the title-bar indicator offering notes for a version that
      // is no longer the one `installUpdate()` would install.
      set({ pendingUpdate: null, isModalOpen: false, autoOpened: false });
      useToastStore.getState().addToast({
        message: `Version ${info.version} is ready to install`,
        variant: 'info',
        duration: 0, // persistent - user must act or dismiss
        action: {
          label: 'Restart to update',
          onClick: () => window.electronAPI.updater.installUpdate(),
        },
      });
      return;
    }

    const alreadySeen = useConfigStore.getState().config.lastSeenReleaseNotesVersion === info.version;
    set({
      pendingUpdate: info,
      isModalOpen: !alreadySeen,
      autoOpened: !alreadySeen,
      // A downloaded update awaiting restart outranks notes for the version
      // already running, so when this modal auto-opens it takes over rather than
      // stacking on the what's-new dialog. Those notes stay reachable from the
      // status-bar version pill. When the modal does NOT auto-open (already
      // seen), leave what's-new exactly as it was.
      whatsNewOpen: alreadySeen ? get().whatsNewOpen : false,
      whatsNewAutoOpened: alreadySeen ? get().whatsNewAutoOpened : false,
    });
  },

  openModal: () => {
    if (!get().pendingUpdate) return;
    set({ isModalOpen: true, autoOpened: false });
  },

  dismiss: () => {
    const { pendingUpdate } = get();
    set({ isModalOpen: false });
    if (pendingUpdate) {
      // Fire-and-forget, matching the other incidental config writes in
      // config-store.ts: failing to record "seen" must not break dismissal.
      void useConfigStore
        .getState()
        .updateConfig({ lastSeenReleaseNotesVersion: pendingUpdate.version })
        .catch(() => undefined);
    }
  },

  openWhatsNew: ({ autoOpened }) => {
    set({ whatsNewOpen: true, whatsNewAutoOpened: autoOpened });
  },

  closeWhatsNew: () => {
    set({ whatsNewOpen: false, whatsNewAutoOpened: false });
  },
}));

// HMR instance pinning (Pattern E, see .claude/rules/hmr-patterns.md): this
// module's only runtime export is the non-component `useUpdaterStore`, so it
// is not a React Fast Refresh boundary. Pin the instance in
// `import.meta.hot.data` so a Fast Refresh cannot hand a second store to the
// title bar while the release-notes modal stays subscribed to the first.
// @ts-expect-error -- Vite handles import.meta.hot; tsc's "module": "commonjs" doesn't support it
const preservedUpdaterStore: ReturnType<typeof createUpdaterStore> | undefined = import.meta.hot?.data?.updaterStore;

export const useUpdaterStore = preservedUpdaterStore ?? createUpdaterStore();

// @ts-expect-error -- Vite handles import.meta.hot; tsc's "module": "commonjs" doesn't support it
if (import.meta.hot) {
  // @ts-expect-error -- Vite handles import.meta.hot
  import.meta.hot.data.updaterStore = useUpdaterStore;
  // Editing this module's OWN code would leave the pinned instance running
  // stale closures; force a clean full reload instead. Rare; prod is
  // unaffected (import.meta.hot is undefined there, so this block is dropped).
  // @ts-expect-error -- Vite handles import.meta.hot
  import.meta.hot.accept(() => import.meta.hot.invalidate());
}
