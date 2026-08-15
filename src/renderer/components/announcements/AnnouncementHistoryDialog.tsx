import { Megaphone } from 'lucide-react';
import { BaseDialog } from '../dialogs/BaseDialog';
import { useAnnouncementsStore } from '../../stores/announcements-store';
import { formatRelativeTime } from '../../lib/datetime';
import type { AnnouncementArchiveEntry } from '../../../shared/announcements';

function AnnouncementHistoryRow({ entry }: { entry: AnnouncementArchiveEntry }) {
  const openDialog = useAnnouncementsStore((state) => state.openDialog);
  const unread = entry.readAt === null;

  return (
    <button
      type="button"
      data-testid="announcement-history-row"
      data-announcement-id={entry.announcement.id}
      data-unread={unread ? 'true' : 'false'}
      onClick={() => openDialog(entry.announcement, 'history')}
      className="w-full flex items-center gap-2.5 px-4 py-2.5 text-left border-b border-edge/50 hover:bg-surface-hover transition-colors cursor-pointer"
    >
      {/* Always drawn, never hover-only (ui-conventions.md): the unread state
          is the reason the megaphone badge is lit, so it has to be readable
          without pointing at the row. The read case keeps the same box so
          titles stay on one left edge down the list. */}
      <span
        className={`flex-shrink-0 w-1.5 h-1.5 rounded-full ${unread ? 'bg-accent' : 'bg-transparent'}`}
        aria-hidden="true"
      />
      <span
        className={`flex-1 min-w-0 truncate text-xs ${unread ? 'text-fg font-medium' : 'text-fg-secondary'}`}
        title={entry.announcement.title}
      >
        {entry.announcement.title}
      </span>
      {/* publishedAt is what the user thinks of as the announcement's date;
          firstSeenAt is the fallback for an entry the feed published without
          one. */}
      <span className="flex-shrink-0 text-[11px] text-fg-faint tabular-nums">
        {formatRelativeTime(entry.announcement.publishedAt ?? entry.firstSeenAt)}
      </span>
    </button>
  );
}

/**
 * The megaphone's history list: every announcement this client has ever had
 * active, most recently seen first, read and unread alike. Rows print the
 * announcement's own publishedAt, so those dates need not descend in step with
 * the archive's first-seen ordering.
 *
 * Rows open the EXISTING AnnouncementDialog for their content, so nothing about
 * markdown / sections / QR rendering is duplicated here, and the list stays
 * open underneath so closing an announcement returns to it.
 *
 * "Page through" is a scrollable capped list, not pagination controls: the
 * archive is capped at ANNOUNCEMENT_ARCHIVE_CAP entries, so it can never grow
 * into something that needs paging.
 */
export function AnnouncementHistoryDialog() {
  const historyOpen = useAnnouncementsStore((state) => state.historyOpen);
  const history = useAnnouncementsStore((state) => state.history);
  const dialogAnnouncement = useAnnouncementsStore((state) => state.dialogAnnouncement);
  const closeHistory = useAnnouncementsStore((state) => state.closeHistory);

  if (!historyOpen) return null;

  return (
    <BaseDialog
      onClose={closeHistory}
      title="Announcements"
      icon={<Megaphone size={16} className="text-accent" />}
      // max-h, not a fixed h: the archive is usually one or two entries early
      // on, and a fixed 60vh box left almost all of it empty. The list grows to
      // its content and starts scrolling only once it reaches the cap.
      className="w-[520px] max-w-[92vw] max-h-[60vh]"
      rawBody
      // A row opens AnnouncementDialog ON TOP of this one. Both Escape
      // listeners are bubble-phase on `document`, so the one registered first
      // (this dialog, mounted first) would otherwise win, dismissing the LIST
      // and orphaning the announcement above it. Hand Escape to the top dialog
      // while it is open.
      suppressEscape={dialogAnnouncement !== null}
      testId="announcement-history-dialog"
    >
      {history.length === 0 ? (
        <div
          className="flex-1 flex items-center justify-center px-6 py-10 text-center text-sm text-fg-muted"
          data-testid="announcement-history-empty"
        >
          No announcements yet. Product news shows up here as it is published.
        </div>
      ) : (
        <div className="flex-1 min-h-0 overflow-y-auto" data-testid="announcement-history-list">
          {history.map((entry) => (
            <AnnouncementHistoryRow key={entry.announcement.id} entry={entry} />
          ))}
        </div>
      )}
    </BaseDialog>
  );
}
