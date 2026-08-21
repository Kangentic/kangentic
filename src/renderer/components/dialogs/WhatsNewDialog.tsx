import { Rocket, ExternalLink } from 'lucide-react';
import { BaseDialog } from './BaseDialog';
import { MarkdownRenderer } from '../MarkdownRenderer';
import { useUpdaterStore } from '../../stores/updater-store';
import { useConfigStore } from '../../stores/config-store';
import { bakedReleaseNotes } from '../../lib/baked-release-notes';
import { githubReleaseUrl } from '../../lib/github-release-url';

/**
 * The running version's release notes, shown once on the first launch after the
 * version changes and reopenable from the status-bar version pill.
 *
 * The post-restart counterpart to ReleaseNotesDialog, which can only run while an
 * update is downloaded and pending. After the relaunch `pendingUpdate` is null,
 * so nothing could surface the notes at all - not for a user who restarted
 * straight from the toast, not for one whose update installed on a normal quit,
 * and not for a fresh, manual, or `npx kangentic` install the updater never touched.
 *
 * A sibling rather than a mode of ReleaseNotesDialog: the two share only the
 * GitHub link and a one-line markdown body, while their triggers, lifecycles,
 * titles, and footers all differ. This one must NOT offer "Restart to update" -
 * there is nothing pending to install.
 *
 * Notes come from the build itself (see lib/baked-release-notes.ts), so this
 * needs no network and no update manifest. `useWhatsNewOnLaunch` owns the
 * once-per-version decision; this component only renders.
 *
 * Mounted in AppLayout so it appears regardless of sidebar state.
 *
 * Rocket rather than Sparkles for the icon: Sparkles means AI/semantic
 * everywhere else in the renderer (NameFromPromptButton, the search palette's
 * "matched by meaning" badge, MemoryTab), and release notes are human-authored.
 * It is also distinct from the pre-restart dialog's CloudDownload, so "update
 * ready" and "update applied" never read as the same thing.
 *
 * The title is brand plus version, like a release-page header, rather than
 * "What's new in vX": RELEASE_NOTES.md opens with its own `## What's New`
 * heading, so that phrasing echoed itself on two adjacent lines. The title names
 * the release and the body's own headings section it.
 */
export function WhatsNewDialog() {
  const whatsNewOpen = useUpdaterStore((state) => state.whatsNewOpen);
  const whatsNewAutoOpened = useUpdaterStore((state) => state.whatsNewAutoOpened);
  const closeWhatsNew = useUpdaterStore((state) => state.closeWhatsNew);
  const appVersion = useConfigStore((state) => state.appVersion);

  if (!whatsNewOpen || !bakedReleaseNotes || !appVersion) return null;

  return (
    <BaseDialog
      onClose={closeWhatsNew}
      title={`Kangentic v${appVersion}`}
      icon={<Rocket size={16} className="text-accent" />}
      trapFocus={!whatsNewAutoOpened}
      backdropClassName="backdrop-blur-xs"
      className="w-[560px] max-h-[80vh]"
      testId="whats-new-dialog"
      footer={
        <div className="flex items-center justify-between gap-3">
          <button
            onClick={() => window.electronAPI.shell.openExternal(githubReleaseUrl(appVersion))}
            className="flex items-center gap-1.5 px-1 py-1.5 text-xs text-fg-faint hover:text-fg-secondary transition-colors"
            data-testid="whats-new-github-link"
          >
            <ExternalLink size={12} />
            GitHub Release
          </button>
          <button
            onClick={closeWhatsNew}
            data-testid="whats-new-close"
            className="px-4 py-1.5 text-xs rounded transition-colors bg-accent-emphasis hover:bg-accent text-accent-on"
          >
            Close
          </button>
        </div>
      }
    >
      <div className="overflow-y-auto max-h-[55vh]">
        <MarkdownRenderer content={bakedReleaseNotes} />
      </div>
    </BaseDialog>
  );
}
