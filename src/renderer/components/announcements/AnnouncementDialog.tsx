import { Megaphone } from 'lucide-react';
import { BaseDialog } from '../dialogs/BaseDialog';
import { MarkdownRenderer } from '../MarkdownRenderer';
import { QrImage } from '../QrImage';
import { ExternalLinkButton } from '../ExternalLinkButton';
import { useAnnouncementsStore } from '../../stores/announcements-store';
import type { AnnouncementLink } from '../../../shared/announcements';

function AnnouncementLinkButton({ link }: { link: AnnouncementLink }) {
  return (
    <ExternalLinkButton label={link.label} url={link.url} fullWidth testId="announcement-link" />
  );
}

/**
 * QR-flagged links lay out SIDE BY SIDE in a grid (each a scannable QR with
 * its labeling button beneath), plain links stack full-width below. The
 * horizontal grid is what keeps a multi-QR announcement inside the dialog
 * without a scrollbar - stacking two large QRs vertically cannot fit any
 * reasonable window height. 180px scans reliably for the short URLs
 * announcements carry (the 220px pairing QR is sized for far denser payloads).
 */
function AnnouncementLinkList({ links }: { links: AnnouncementLink[] }) {
  if (links.length === 0) return null;
  const qrLinks = links.filter((link) => link.qr);
  const plainLinks = links.filter((link) => !link.qr);
  return (
    <div className="space-y-3">
      {qrLinks.length > 0 && (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(13rem,1fr))] gap-3 justify-items-center">
          {qrLinks.map((link) => (
            <div key={link.url} className="w-full max-w-[15rem] flex flex-col items-center gap-2" data-testid="announcement-qr-block">
              <QrImage value={link.url} size={180} alt={`QR code: ${link.label}`} testId="announcement-qr" />
              <AnnouncementLinkButton link={link} />
            </div>
          ))}
        </div>
      )}
      {plainLinks.length > 0 && (
        <div className="flex flex-col items-stretch gap-1.5">
          {plainLinks.map((link) => (
            <AnnouncementLinkButton key={link.url} link={link} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The "Learn more" dialog for an announcement: intro markdown, then any
 * titled sections (each its own message with scoped links), then the
 * announcement-level links. Only ever opens from a user click on the
 * banner's "Learn more", never on its own, so BaseDialog's default focus
 * trap is correct (the updater's autoOpened machinery exists only for
 * unbidden modals). Mounted in AppLayout beside the other app-level dialogs.
 */
export function AnnouncementDialog() {
  const announcement = useAnnouncementsStore((state) => state.dialogAnnouncement);
  const closeDialog = useAnnouncementsStore((state) => state.closeDialog);

  if (!announcement) return null;

  return (
    <BaseDialog
      onClose={closeDialog}
      title={announcement.title}
      icon={<Megaphone size={16} className="text-accent" />}
      backdropClassName="backdrop-blur-xs"
      className="w-[640px] max-w-[92vw] max-h-[85vh]"
      testId="announcement-dialog"
      footer={
        <div className="flex items-center justify-end">
          <button
            onClick={closeDialog}
            data-testid="announcement-close"
            className="px-4 py-1.5 text-xs rounded transition-colors bg-accent-emphasis hover:bg-accent text-accent-on"
          >
            Close
          </button>
        </div>
      }
    >
      {/* An announcement must fit WITHOUT scrolling (authoring contract, see
          docs/configuration.md); the cap here is the dialog's height minus
          header + footer chrome, and overflow-y-auto is only a safety valve
          for very small windows, never a layout feature. Pinned by the
          no-scrollbar assertion in tests/ui/announcements.spec.ts. */}
      <div className="overflow-y-auto max-h-[calc(85vh-9rem)] space-y-4" data-testid="announcement-dialog-content">
        <MarkdownRenderer content={announcement.body} />
        {announcement.sections?.map((section, sectionIndex) => (
          <div
            key={sectionIndex}
            className="border-t border-edge pt-3 space-y-3"
            data-testid="announcement-section"
          >
            {section.heading && (
              <h4 className="text-sm font-semibold text-fg">{section.heading}</h4>
            )}
            {section.body && <MarkdownRenderer content={section.body} />}
            {section.links && <AnnouncementLinkList links={section.links} />}
          </div>
        ))}
        <AnnouncementLinkList links={announcement.links} />
      </div>
    </BaseDialog>
  );
}
