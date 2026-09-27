import type React from 'react';
import { Info } from 'lucide-react';
import { useAnySettingVisible, useSettingVisible } from './settings-search';
import { SETTING_LABEL_CLASS, SETTING_DESCRIPTION_CLASS } from '../SettingText';
import { ToggleSwitch } from './shared';
import { SegmentedControl } from '../SegmentedControl';
import type { SegmentedControlOption } from '../SegmentedControl';

/**
 * The settings card: one feature per card, its master switch (if it has one)
 * in the header, and the settings that depend on it inside, each in its own
 * tile. Every settings tab builds from these few pieces so the shape cannot
 * drift between them. The rules and their enforcement: `.claude/rules/settings-card-design.md`.
 *
 * The rules the design settled on:
 *  - The card itself is clear (the panel shows through) and each control sits
 *    in a tile LIGHTER than the panel. Nothing is darker than the panel: a
 *    recessed well reads heavy and dim, and was ruled out for that.
 *  - Every child of a card body is a tile: `CardRow`, `CardToggleRow`, or
 *    `CardTile` for anything custom. Tabs never style a tile by hand.
 *  - Every switch, trailing button and dropdown arrow in a card ends on one
 *    right edge, the header's switch included, and the header's title and
 *    every tile's label start on one left edge. Both follow from the geometry
 *    below, which is why it is numbers rather than classes.
 *  - A card's body shows only while its switch is on. The caller decides, by
 *    passing `children` only then, because some bodies keep a line visible
 *    while off (Mobile Devices keeps its two docs links).
 *  - Row descriptions live in an info tooltip (`InfoTip`) so a long tab reads
 *    as a list of names. A short card may keep them inline instead
 *    (`CardToggleRow`'s `inlineDescription`), which Agent Browser does.
 *  - The header keeps its one description line visible: it says what the
 *    whole feature is, which is the thing a reader needs before any row.
 *    Every visible description fits on one line (the rule's character budget).
 *  - Search keeps working because every row still carries its registry id,
 *    and a card stays visible while any id inside it matches.
 *  - A click anywhere on a switch's header or row flips it, as the whole of a
 *    `ToggleCard` does (`rowClickToggle`). The header cannot be the button
 *    itself the way a ToggleCard is, because it can hold an `InfoTip`, and a
 *    button inside a button is invalid.
 */

/** How far the tiles sit in from the card's edge, on the sides and below the last one. */
const CARD_BODY_INSET_PX = 12;
/** The gap between one tile and the next. */
const TILE_GAP_PX = 6;
/** How far a tile's content sits in from the tile's right edge. */
const TILE_RIGHT_PADDING_PX = 16;
const HEADER_LEFT_PADDING_PX = 16;
const HEADER_ICON_COLUMN_PX = 16;
const HEADER_ICON_GAP_PX = 12;
/**
 * The header's right inset is the tiles' inset plus their right padding, so the
 * header's switch ends on the same edge as every switch in the tiles below it.
 */
const HEADER_RIGHT_INSET_PX = CARD_BODY_INSET_PX + TILE_RIGHT_PADDING_PX;
/**
 * A tile's left padding puts its label where the header's title starts: past
 * the header's padding, icon column and gap, less the tile's own inset.
 */
const TILE_LEFT_PADDING_PX = HEADER_LEFT_PADDING_PX + HEADER_ICON_COLUMN_PX + HEADER_ICON_GAP_PX - CARD_BODY_INSET_PX;
/**
 * Where a tile's gutter slot (`CardTileGutter`) starts, measured from the
 * tile's content edge: back across the tile's left padding to the header's
 * icon column, so a drag handle sits under the card's icon.
 */
const TILE_GUTTER_OFFSET_PX = HEADER_LEFT_PADDING_PX - CARD_BODY_INSET_PX - TILE_LEFT_PADDING_PX;
/** A nested tile (Only localhost under Allow navigation) starts this much further in. */
const NESTED_TILE_INDENT_PX = 30;
/**
 * The space under a wide body's grid. Its sides use the header's right inset,
 * so the grid's right edge is the switch's.
 */
const WIDE_BODY_BOTTOM_PADDING_PX = 16;

/** The fill, corners and vertical padding every tile shares. The horizontal padding is `TILE_STYLE`. */
const TILE_CLASS = 'rounded-md bg-surface-hover/40 py-3';
const TILE_STYLE: React.CSSProperties = { paddingLeft: TILE_LEFT_PADDING_PX, paddingRight: TILE_RIGHT_PADDING_PX };

/** Controls inside a toggle's row that own their click. */
const OWN_CLICK_SELECTOR = 'button, a, input, select, textarea, [role="switch"]';

/**
 * A click handler that flips a switch from anywhere on its row, or undefined
 * when there is nothing to flip. A click on a control of the row's own (the
 * switch itself, an `InfoTip`, a link) is left to that control: the switch
 * already flips on its own click, and reading a tooltip must not change a
 * setting.
 */
function rowClickToggle(toggle: (() => void) | undefined): React.MouseEventHandler<HTMLDivElement> | undefined {
  if (!toggle) return undefined;
  return (event) => {
    const target = event.target;
    if (target instanceof Element) {
      const control = target.closest(OWN_CLICK_SELECTOR);
      if (control && event.currentTarget.contains(control)) return;
    }
    toggle();
  };
}

interface SettingsCardProps {
  icon: React.ReactNode;
  label: string;
  description: string;
  /** Registry id of the header's own setting (the master switch), if it has one. */
  searchId?: string;
  /** Registry ids of the rows inside, so a search hit on any of them keeps the card. */
  searchIds?: string[];
  /** The master switch. Omit for a header-only card (Branches, Pull requests, Knowledge Graph). */
  checked?: boolean;
  onChange?: (value: boolean) => void;
  /** A longer note behind an info icon on the title, e.g. MCP Server's "How it works". */
  info?: string;
  /**
   * A prerequisite is off (Semantic search with indexing off): the header
   * greys out, the switch is disabled, and this line replaces the description.
   */
  unavailableReason?: string;
  /**
   * Tiles only: `CardRow`, `CardToggleRow`, `CardTile`. Pass it only when it
   * should show.
   */
  children?: React.ReactNode;
  /**
   * A grid of items with no label column to line up (MCP Server's tool list):
   * the body runs between the header's title and switch edges and holds the
   * grid directly, with no tiles.
   */
  wideBody?: boolean;
  testId?: string;
}

export function SettingsCard({
  icon, label, description, searchId, searchIds, checked, onChange, info, unavailableReason, children, wideBody, testId,
}: SettingsCardProps) {
  const visible = useAnySettingVisible([...(searchId ? [searchId] : []), ...(searchIds ?? [])]);
  if (!visible) return null;
  const hasSwitch = checked !== undefined && onChange !== undefined;
  const unavailable = unavailableReason !== undefined;
  const toggle = checked !== undefined && onChange !== undefined && !unavailable
    ? () => onChange(!checked)
    : undefined;

  return (
    <section
      className="rounded-lg border border-edge"
      data-testid={testId ?? (searchId ? `settings-card-${searchId}` : undefined)}
      aria-label={label}
    >
      <div
        onClick={rowClickToggle(toggle)}
        style={{ paddingLeft: HEADER_LEFT_PADDING_PX, paddingRight: HEADER_RIGHT_INSET_PX, columnGap: HEADER_ICON_GAP_PX }}
        className={`flex items-center py-3.5 ${children ? 'rounded-t-lg' : 'rounded-lg'} ${
          unavailable ? 'opacity-50' : ''
        } ${toggle ? 'cursor-pointer select-none transition-colors hover:bg-surface-hover/40' : ''}`}
      >
        <span
          className="flex flex-shrink-0 justify-center text-fg-muted"
          style={{ width: HEADER_ICON_COLUMN_PX }}
          aria-hidden="true"
        >
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <h3 className={`${SETTING_LABEL_CLASS} font-semibold`}>{label}</h3>
            {info ? <InfoTip label={label} text={info} /> : null}
          </div>
          <p className={`${SETTING_DESCRIPTION_CLASS} mt-0.5`}>{unavailableReason ?? description}</p>
        </div>
        {hasSwitch ? (
          <ToggleSwitch
            checked={checked}
            onChange={onChange}
            disabled={unavailable}
            ariaLabel={label}
            // The switch, not the card, carries `setting-row-<id>`: that id
            // named the role="switch" element before cards existed, and tests
            // and settings search both address a toggle by it.
            testId={searchId ? `setting-row-${searchId}` : undefined}
          />
        ) : null}
      </div>
      {children ? (
        <div
          className="flex flex-col"
          style={wideBody
            ? { paddingLeft: HEADER_RIGHT_INSET_PX, paddingRight: HEADER_RIGHT_INSET_PX, paddingBottom: WIDE_BODY_BOTTOM_PADDING_PX }
            : { paddingLeft: CARD_BODY_INSET_PX, paddingRight: CARD_BODY_INSET_PX, paddingBottom: CARD_BODY_INSET_PX, rowGap: TILE_GAP_PX }}
        >
          {children}
        </div>
      ) : null}
    </section>
  );
}

/**
 * An info icon whose tooltip carries a row's description. A real button, so a
 * keyboard or screen-reader user reaches the text too: a bare `title` on a
 * span is hover-only and invisible to both.
 */
export function InfoTip({ label, text }: { label: string; text: string }) {
  return (
    <button
      type="button"
      title={text}
      aria-label={`About ${label}: ${text}`}
      className="flex flex-shrink-0 rounded text-fg-faint hover:text-fg-tertiary focus:outline-none focus-visible:ring-1 focus-visible:ring-accent cursor-help"
    >
      <Info size={13} aria-hidden="true" />
    </button>
  );
}

/** A small tag after a row's label, such as the host a setting applies to. */
export function SettingTag({ children }: { children: React.ReactNode }) {
  return (
    <span className="flex-shrink-0 rounded border border-edge px-1.5 text-[11px] leading-[18px] text-fg-muted">
      {children}
    </span>
  );
}

interface CardTileProps {
  children: React.ReactNode;
  /** Layout inside the tile, e.g. `flex items-center justify-between gap-3`. Never a fill or padding. */
  className?: string;
  /** For a tile a library positions, e.g. a sortable row's transform. Merged over the tile's insets. */
  style?: React.CSSProperties;
  /** For a tile a library measures, e.g. dnd-kit's `setNodeRef`. */
  ref?: React.Ref<HTMLDivElement>;
  testId?: string;
}

/**
 * A tile for content that is not one setting row: the Rebuild action, the
 * relay's controls with their docs link, a group of paired phones with Pair a
 * device, a sortable shortcut. It carries the same fill, corners and insets as
 * `CardRow` and `CardToggleRow`, so a custom block lines up with the rows
 * around it.
 */
export function CardTile({ children, className, style, ref, testId }: CardTileProps) {
  return (
    <div
      ref={ref}
      className={`${TILE_CLASS} ${className ?? ''}`}
      style={style ? { ...TILE_STYLE, ...style } : TILE_STYLE}
      data-testid={testId}
    >
      {children}
    </div>
  );
}

/**
 * A slot in a tile's left gutter, under the card header's icon, for a row's
 * drag handle. It keeps the row's own content (a shortcut's icon and name) on
 * the header title's line instead of pushing it right. Put it inside a
 * `relative` row of a `CardTile`; it centres on that row's height.
 */
export function CardTileGutter({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="absolute inset-y-0 flex items-center justify-center"
      style={{ left: TILE_GUTTER_OFFSET_PX, width: HEADER_ICON_COLUMN_PX }}
    >
      {children}
    </div>
  );
}

interface CardRowProps {
  label: string;
  description: string;
  searchId?: string;
  /** The control (a Select, an input, a combobox), rendered under the label. */
  children: React.ReactNode;
  /** Rendered after the label, e.g. a `SettingTag`. */
  labelTrailing?: React.ReactNode;
  /** Rendered at the right end of the label line, on the card's right edge, e.g. a detected version. */
  trailing?: React.ReactNode;
}

/** A setting inside a card whose control sits under its label, in its own tile. */
export function CardRow({ label, description, searchId, children, labelTrailing, trailing }: CardRowProps) {
  const visible = useSettingVisible(searchId);
  if (!visible) return null;
  return (
    <div
      className={`flex flex-col gap-1.5 ${TILE_CLASS}`}
      style={TILE_STYLE}
      data-testid={searchId ? `setting-row-${searchId}` : undefined}
    >
      <div className="flex items-center gap-1.5">
        <span className={SETTING_LABEL_CLASS}>{label}</span>
        <InfoTip label={label} text={description} />
        {labelTrailing}
        {trailing ? <div className="ml-auto flex min-w-0 items-center">{trailing}</div> : null}
      </div>
      {children}
    </div>
  );
}

interface CardChoiceRowProps<T extends string> {
  label: string;
  description: string;
  searchId?: string;
  options: readonly SegmentedControlOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Test hook on the segmented control. */
  testId?: string;
  /** A status line under the row, e.g. which models a preset picked. */
  children?: React.ReactNode;
}

/**
 * A setting with a few short named choices (two to four), in its own tile:
 * label on the left, a segmented control on the right, ending on the same edge
 * as the switches. A short fixed choice uses this rather than a dropdown, so
 * every option shows at once and any is one click away.
 */
export function CardChoiceRow<T extends string>({
  label, description, searchId, options, value, onChange, testId, children,
}: CardChoiceRowProps<T>) {
  const visible = useSettingVisible(searchId);
  if (!visible) return null;
  return (
    <div
      className={`flex flex-col gap-1.5 ${TILE_CLASS}`}
      style={TILE_STYLE}
      data-testid={searchId ? `setting-row-${searchId}` : undefined}
    >
      <div className="flex items-center gap-3">
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <span className={SETTING_LABEL_CLASS}>{label}</span>
          <InfoTip label={label} text={description} />
        </div>
        <SegmentedControl options={options} value={value} onChange={onChange} ariaLabel={label} testId={testId} quiet />
      </div>
      {children}
    </div>
  );
}

interface CardToggleRowProps {
  label: string;
  description: string;
  searchId?: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  /** Show the description under the label instead of behind an info icon. */
  inlineDescription?: boolean;
  /** Indent under the row above, for a setting that only matters when that one is on. */
  nested?: boolean;
  disabled?: boolean;
  /** Rendered after the label, e.g. a `SettingTag`. */
  labelTrailing?: React.ReactNode;
}

/**
 * An on/off setting inside a card, in its own tile: label on the left, switch
 * on the right. The whole tile is the click target, and the hover tint fills
 * it, so the edge of the target is the edge of the tile.
 */
export function CardToggleRow({
  label, description, searchId, checked, onChange, inlineDescription, nested, disabled, labelTrailing,
}: CardToggleRowProps) {
  const visible = useSettingVisible(searchId);
  if (!visible) return null;
  const toggle = disabled ? undefined : () => onChange(!checked);
  return (
    <div
      onClick={rowClickToggle(toggle)}
      style={nested ? { ...TILE_STYLE, marginLeft: NESTED_TILE_INDENT_PX } : TILE_STYLE}
      className={`flex items-center gap-3 ${TILE_CLASS} ${
        toggle ? 'cursor-pointer select-none transition-colors hover:bg-surface-hover/70' : ''
      }`}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className={SETTING_LABEL_CLASS}>{label}</span>
          {inlineDescription ? null : <InfoTip label={label} text={description} />}
          {labelTrailing}
        </div>
        {inlineDescription ? <p className={`${SETTING_DESCRIPTION_CLASS} mt-0.5`}>{description}</p> : null}
      </div>
      <ToggleSwitch
        checked={checked}
        onChange={onChange}
        disabled={disabled}
        ariaLabel={label}
        // `setting-row-<id>` on the switch itself, as on the card header's.
        testId={searchId ? `setting-row-${searchId}` : undefined}
      />
    </div>
  );
}
