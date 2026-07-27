import { useId, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

interface DisclosureSectionProps {
  /** Visible label on the trigger row. Usually a short string ("Advanced"); may be JSX for icons. */
  title: ReactNode;
  /** Controlled open state. When undefined, the component manages its own open state. */
  open?: boolean;
  /** Fires on every toggle, whether controlled or uncontrolled. */
  onOpenChange?: (open: boolean) => void;
  /** Initial open state for the uncontrolled form. Ignored when `open` is provided. */
  defaultOpen?: boolean;
  /** Disables the trigger. The chevron still renders; click/keyboard are inert. */
  disabled?: boolean;
  /**
   * `data-testid` placed on the trigger `<button>`. The content panel
   * receives `${testId}-panel` so tests can target either half independently.
   * The native `aria-controls` linkage uses the same generated ID.
   */
  testId?: string;
  children: ReactNode;
}

/**
 * Accessible disclosure / collapsible section.
 *
 * Follows the WAI-ARIA Disclosure pattern (`<button aria-expanded
 * aria-controls>` toggling a content region) and matches the shape of
 * Radix `Collapsible.Root` / `Trigger` / `Content` while staying as a
 * single composed component to keep call sites terse.
 *
 * Visual contract: trigger + content render as a single card with a
 * shared border. The trigger is the card's full-width header (chevron +
 * label) and has a hover state so the clickable target is unambiguous.
 * On open, a divider appears between the trigger and the content panel
 * so the two halves read as one container, not two stacked elements.
 *
 * Use this wherever the UI has an "Advanced" / "More options" / "Show
 * details" affordance that hides secondary fields by default.
 */
export function DisclosureSection({
  title,
  open: controlledOpen,
  onOpenChange,
  defaultOpen = false,
  disabled = false,
  testId,
  children,
}: DisclosureSectionProps) {
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const isControlled = controlledOpen !== undefined;
  const isOpen = isControlled ? controlledOpen : internalOpen;
  const generatedId = useId();
  const panelId = `${testId ?? generatedId}-panel`;
  const panelTestId = testId ? `${testId}-panel` : undefined;

  const handleToggle = () => {
    if (disabled) return;
    const next = !isOpen;
    if (!isControlled) setInternalOpen(next);
    onOpenChange?.(next);
  };

  // Outer container intentionally does NOT use `overflow-hidden`, so a
  // descendant that positions itself in-flow can still escape the card bounds.
  // (The comboboxes that motivated this now portal to document.body and are no
  // longer affected either way.) Rounded corners are applied to the trigger
  // button when closed so its hover bg respects the curve without needing a
  // clip on the parent.
  return (
    <div className="rounded border border-edge-input bg-surface-raised/40">
      <button
        type="button"
        onClick={handleToggle}
        disabled={disabled}
        aria-expanded={isOpen}
        aria-controls={panelId}
        data-testid={testId}
        data-state={isOpen ? 'open' : 'closed'}
        className={`w-full flex items-center gap-2 px-3 py-2 text-xs text-fg-secondary transition-colors ${
          disabled
            ? 'cursor-not-allowed opacity-50'
            : 'cursor-pointer hover:bg-surface-hover/60'
        } focus-visible:outline focus-visible:outline-2 focus-visible:outline-fg-faint ${
          isOpen ? 'rounded-t border-b border-edge-input' : 'rounded'
        }`}
      >
        {isOpen ? (
          <ChevronDown size={12} className="text-fg-faint shrink-0" />
        ) : (
          <ChevronRight size={12} className="text-fg-faint shrink-0" />
        )}
        <span className="font-medium">{title}</span>
      </button>
      {isOpen && (
        <div
          id={panelId}
          data-testid={panelTestId}
          data-state="open"
          className="p-3"
        >
          {children}
        </div>
      )}
    </div>
  );
}
