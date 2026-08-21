import { CloudDownload, ExternalLink } from 'lucide-react';
import { BaseDialog } from './BaseDialog';
import { MarkdownRenderer } from '../MarkdownRenderer';
import { useUpdaterStore } from '../../stores/updater-store';
import { githubReleaseUrl } from '../../lib/github-release-url';

/**
 * Shown when a downloaded update's release notes should be reviewed before
 * restarting. Replaces the old persistent "Restart to update" toast: the
 * toast is now the fallback for a version with no notes (see
 * updater-store.ts's receiveUpdate), and the title-bar indicator is the
 * always-available way back in after "Later".
 *
 * Auto-opened for a version not yet seen; `autoOpened` gates focus trapping
 * so an unbidden modal never steals focus from a PTY mid-keystroke, while a
 * user-initiated reopen (the title-bar indicator) traps normally.
 *
 * This placement is deliberately PRE-restart. WhatsNewDialog is its post-restart
 * counterpart, for the user who never sees this one: the fast path straight from
 * the toast, an install via `autoUpdater.autoInstallOnAppQuit`, a fresh install,
 * or an `npx kangentic` upgrade, which replaces the package from outside the app.
 *
 * Mounted in AppLayout so it appears regardless of sidebar state.
 */
export function ReleaseNotesDialog() {
  const pendingUpdate = useUpdaterStore((state) => state.pendingUpdate);
  const isModalOpen = useUpdaterStore((state) => state.isModalOpen);
  const autoOpened = useUpdaterStore((state) => state.autoOpened);
  const dismiss = useUpdaterStore((state) => state.dismiss);

  if (!pendingUpdate || !isModalOpen) return null;

  return (
    <BaseDialog
      onClose={dismiss}
      title={`Version ${pendingUpdate.version} is ready to install`}
      icon={<CloudDownload size={16} className="text-attention" />}
      trapFocus={!autoOpened}
      backdropClassName="backdrop-blur-xs"
      className="w-[560px] max-h-[80vh]"
      testId="release-notes-dialog"
      footer={
        <div className="flex items-center justify-between gap-3">
          <button
            onClick={() => window.electronAPI.shell.openExternal(githubReleaseUrl(pendingUpdate.version))}
            className="flex items-center gap-1.5 px-1 py-1.5 text-xs text-fg-faint hover:text-fg-secondary transition-colors"
            data-testid="release-notes-github-link"
          >
            <ExternalLink size={12} />
            GitHub Release
          </button>
          <div className="flex gap-3">
            <button
              onClick={dismiss}
              className="px-4 py-1.5 text-xs text-fg-muted hover:text-fg-secondary border border-edge-input hover:border-fg-faint rounded transition-colors"
            >
              Later
            </button>
            <button
              onClick={() => window.electronAPI.updater.installUpdate()}
              className="px-4 py-1.5 text-xs rounded transition-colors bg-accent-emphasis hover:bg-accent text-accent-on"
            >
              Restart to update
            </button>
          </div>
        </div>
      }
    >
      <div className="overflow-y-auto max-h-[55vh]">
        <MarkdownRenderer content={pendingUpdate.releaseNotes} />
      </div>
    </BaseDialog>
  );
}
