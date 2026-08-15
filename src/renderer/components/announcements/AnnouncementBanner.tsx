import { Megaphone, X } from 'lucide-react';
import { useAnnouncementsStore, selectBannerAnnouncement } from '../../stores/announcements-store';
import { useConfigStore } from '../../stores/config-store';

/**
 * Slim dismissible strip above the board content for the highest-priority
 * active announcement (remote feed, src/shared/announcements.ts). One
 * announcement at a time; dismissing reveals the next non-dismissed one, if
 * any. Mounted as the first child of AppLayout's content column so it spans
 * the area right of the sidebar in every view (board, backlog, welcome).
 *
 * Deliberately no entrance animation: the strip can (re)mount on project
 * switch and restore paths, which must paint flat
 * (.claude/rules/restore-no-animation-replay.md).
 */
export function AnnouncementBanner() {
  const active = useAnnouncementsStore((state) => state.active);
  const openDialog = useAnnouncementsStore((state) => state.openDialog);
  const dismissedIds = useConfigStore((state) => state.config.dismissedAnnouncementIds);
  const dismissAnnouncement = useConfigStore((state) => state.dismissAnnouncement);

  const banner = selectBannerAnnouncement(active, dismissedIds ?? []);
  if (!banner) return null;

  return (
    <div
      data-testid="announcement-banner"
      className="flex-shrink-0 flex items-center gap-2.5 border-b border-edge bg-surface-raised px-3 py-1.5"
    >
      <Megaphone size={14} className="text-accent flex-shrink-0" aria-hidden="true" />
      {/* title attr: the strip truncates on narrow windows and the full text
          should still be reachable without opening the dialog. */}
      <span className="flex-1 min-w-0 truncate text-xs text-fg-secondary" title={banner.title}>{banner.title}</span>
      <button
        type="button"
        data-testid="announcement-learn-more"
        onClick={() => openDialog(banner, 'banner')}
        className="flex-shrink-0 text-xs text-fg-secondary underline underline-offset-2 hover:text-fg transition-colors cursor-pointer"
      >
        Learn more
      </button>
      <button
        type="button"
        data-testid="announcement-dismiss"
        aria-label="Dismiss announcement"
        onClick={() => dismissAnnouncement(banner.id)}
        className="flex-shrink-0 rounded p-1 text-fg-faint hover:text-fg hover:bg-surface-hover transition-colors"
      >
        <X size={14} />
      </button>
    </div>
  );
}
