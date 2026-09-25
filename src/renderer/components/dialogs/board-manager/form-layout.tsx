import React from 'react';
import { Info, type LucideIcon } from 'lucide-react';
import { SETTING_LABEL_CLASS, SETTING_DESCRIPTION_CLASS } from '../../SettingText';

/**
 * The shared layout of Board setup's column page.
 *
 * Extracted from `BoardManagerDialog.tsx` so the automations pane can be built
 * from the SAME card as the three settings sections. That is the whole point of
 * the card: automations are the fourth section, not a differently shaped panel
 * that happens to sit on the right. It lives on the right only because a row
 * carries a name, a type, a sentence and three controls, and needs the width.
 */

/** Two columns once the pane is wide enough; full-width fields carry SECTION_FULL_SPAN. */
export const SECTION_GRID_CLASS = 'grid grid-cols-1 @[720px]:grid-cols-2 gap-x-6 gap-y-3 pt-2';
export const SECTION_FULL_SPAN = '@[720px]:col-span-2';

/**
 * One bordered section with an uppercase eyebrow header.
 *
 * The header is INSIDE the card rather than a sticky band above it, which is
 * what makes four cards read as four peers. `data-testid` keeps the
 * `board-manager-section-<id>` selector the existing specs use.
 */
export function SectionCard({ id, label, icon: SectionIcon, info, actions, children, className = '' }: {
  id: string;
  label: string;
  icon: LucideIcon;
  /**
   * Explanatory text for the section, shown on an info icon beside the label
   * rather than as a line of standing copy under it.
   *
   * The icon, not a subheader, so every card's header is the same one-line
   * shape. Automations was the only section carrying a sentence, which made it
   * read as a different KIND of card than the three beside it; and the sentence
   * is paid on every open while being learned once, which is what
   * `ui-conventions.md` asks standing copy to justify. The same treatment
   * ToggleCard already uses for "Hand off context when the agent changes".
   */
  info?: string;
  /** Optional trailing control on the header row. */
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      data-testid={`board-manager-section-${id}`}
      // Its OWN container, so the field grid inside measures the CARD rather
      // than the pane. Without it, a card sitting in a two-up settings column is
      // about 500px wide while the pane is past 1000, so `@[720px]` would fire
      // and squeeze two fields into 500px. Nested containers resolve to the
      // nearest ancestor, which is what makes the same grid class correct at
      // every level.
      className={`@container rounded-lg border border-edge/60 bg-surface-raised/40 px-4 py-3 ${className}`}
    >
      <header className="flex items-center gap-2 pb-1">
        {/* 15, not 13: at 13 these glyphs lose their interior detail against the
            12px uppercase label beside them. */}
        <SectionIcon size={15} strokeWidth={1.75} className="text-fg-faint shrink-0" />
        <span className="text-xs font-semibold uppercase tracking-wider text-fg-faint">{label}</span>
        {info ? (
          // Same markup as ToggleCard's info affordance, so the two read as one
          // thing. `aria-hidden` with a `title`: the text is a hint, not a label
          // the section needs announced.
          <span
            data-testid={`board-manager-section-${id}-info`}
            title={info}
            aria-hidden="true"
            className="shrink-0 cursor-help text-fg-faint hover:text-fg-tertiary"
          >
            <Info size={13} />
          </span>
        ) : null}
        {actions ? <div className="ml-auto flex items-center gap-2">{actions}</div> : null}
      </header>
      {children}
    </section>
  );
}

export function SettingField({ label, description, hint, children, className = '' }: {
  label: string;
  description?: string;
  hint?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  // `flex flex-col h-full` + `mt-auto` keeps inputs aligned to the bottom of
  // their cell when two fields in the same row have descriptions of differing
  // line count.
  return (
    <div className={`flex flex-col h-full ${className}`}>
      <div className="flex items-center justify-between gap-2">
        {/* Raw classes rather than <SettingText>: this row right-aligns `hint`
            against the LABEL line, a layout the shared component does not own.
            The values still come from one place. */}
        <label className={SETTING_LABEL_CLASS}>{label}</label>
        {hint}
      </div>
      {description && <p className={`${SETTING_DESCRIPTION_CLASS} mt-0.5`}>{description}</p>}
      <div className={description ? 'mt-auto pt-1.5' : 'mt-1.5'}>{children}</div>
    </div>
  );
}

/** One-line inline explanation shown in place of a section's fields when it does not apply. */
export function DisabledSectionNotice({ reason }: { reason: string }) {
  return <p className={`${SETTING_DESCRIPTION_CLASS} pt-2 pb-1 max-w-2xl`}>{reason}</p>;
}

/**
 * The group heading inside the automations card, which is ALSO the separator
 * between the two groups: a label followed by a hairline running to the right
 * edge. One element does both jobs, and the rule gives the eye a horizontal line
 * to scan for, which a plain label did not.
 *
 * No glyph. "On enter" and "On exit" are already unambiguous, and an arrow here
 * would point at nothing the reader has met, unlike the section icons, which
 * point back at a card they have opened.
 */
export function GroupHeading({ label, children }: { label: string; children?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 pt-3 pb-1.5">
      <span className="text-xs font-semibold text-fg-secondary">{label}</span>
      <span className="h-px flex-1 bg-edge/60" />
      {children}
    </div>
  );
}
