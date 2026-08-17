import { ChevronRight, Megaphone } from 'lucide-react';
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
      // last:border-b-0 so a one-entry archive does not draw a full-width rule
      // under its only row: against the floor's empty space below, that read as a
      // section header over a blank panel rather than as a list item.
      className="group w-full flex items-center gap-2.5 px-4 py-2.5 text-left border-b border-edge/50 last:border-b-0 hover:bg-surface-hover transition-colors cursor-pointer"
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
      {/* The row opens the announcement, and nothing else in it said so: at rest
          it read as a static line of text, since the only affordance was the
          hover fill. This is the same disclosure chevron BoardManagerDialog and
          ShortcutsTab use for a row that opens something, and it is drawn at all
          times rather than on hover (ui-conventions.md). */}
      <ChevronRight size={14} className="text-fg-faint group-hover:text-fg-muted flex-shrink-0" />
    </button>
  );
}

/**
 * The floor beneath the content-sized body, ~4 rows tall (a row is py-2.5 plus
 * one text line plus its border). Without it a one-entry archive rendered a
 * 520x95 box that read as a toast rather than a panel.
 *
 * On the list this REPLACES min-h-0 rather than joining it. min-h-0 was there
 * only to override the flex default `min-height: auto`, so the list can shrink
 * to the 60vh cap and scroll instead of growing the dialog; an explicit floor
 * overrides `auto` just as well. Two min-h utilities on one element would be
 * competing declarations resolved by Tailwind's emit order.
 */
const HISTORY_BODY_MIN_HEIGHT = 'min-h-[150px]';

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
          // py-10 is kept below the floor, not replaced by it: the padding is
          // symmetric so items-center still centers the copy, and it is what
          // keeps the text off the edges if it ever wraps past the floor.
          className={`flex-1 ${HISTORY_BODY_MIN_HEIGHT} flex items-center justify-center px-6 py-10 text-center text-sm text-fg-muted`}
          data-testid="announcement-history-empty"
        >
          No announcements yet. Product news shows up here as it is published.
        </div>
      ) : (
        <div
          className={`flex-1 ${HISTORY_BODY_MIN_HEIGHT} overflow-y-auto`}
          data-testid="announcement-history-list"
        >
          {history.map((entry) => (
            <AnnouncementHistoryRow key={entry.announcement.id} entry={entry} />
          ))}
        </div>
      )}
    </BaseDialog>
  );
}
