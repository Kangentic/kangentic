import { ExternalLink } from 'lucide-react';

interface ExternalLinkButtonProps {
  label: string;
  /** Opened via shell.openExternal; the main process allowlists schemes. */
  url: string;
  /** Stretch to the container width (the announcement dialog's link list). */
  fullWidth?: boolean;
  testId?: string;
}

/**
 * A slim pill button that opens an external URL in the OS browser: truncating
 * label, trailing ExternalLink glyph. Shared by the announcement dialog's
 * link list and the Mobile Devices "Get the App" steps so the external-link
 * affordance reads identically everywhere.
 */
export function ExternalLinkButton({ label, url, fullWidth, testId }: ExternalLinkButtonProps) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={() => void window.electronAPI.shell.openExternal(url)}
      className={`${fullWidth ? 'w-full ' : ''}flex items-center gap-1 rounded-md border border-edge/50 bg-surface-hover/30 px-2.5 py-1.5 text-xs text-fg-secondary hover:bg-surface-hover hover:text-fg hover:border-edge transition-colors cursor-pointer`}
    >
      <span className="truncate">{label}</span>
      <ExternalLink size={11} className="ml-auto shrink-0 opacity-60" />
    </button>
  );
}
