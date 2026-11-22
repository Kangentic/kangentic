/**
 * The one column picker: every field that chooses a board column (the Column
 * Manager's After Plan Mode, Move to column's Column) shows each column's own
 * glyph in its own color, the way the board's column headers and the Column
 * Manager's rail draw it (`ColumnGlyph`: its icon, else a dot in its color).
 * `GlyphPicker` draws the field, a button-backed listbox, because a native `<select>`
 * cannot show a glyph in an option. Why it portals is in `GlyphPicker.tsx`.
 *
 * A caller may put one option ahead of the columns (`leadingOption`), drawn
 * apart from them: a muted arrow instead of a column's colors, and a divider
 * under it, because it is not one column (Move to column's Next column). A
 * value no column carries stays listed and marked "(not on this board)", with
 * no glyph, so opening a dialog never silently re-points what it stores.
 */
import { ArrowRight } from 'lucide-react';
import { useLingui } from '@lingui/react/macro';
import type { Swimlane } from '../../shared/types';
import { ColumnGlyph } from '../utils/swimlane-icons';
import { GlyphPicker, type GlyphPickerChoice } from './GlyphPicker';

/** One column the field can point at. `color` is null for one the board store has not seen yet. */
export interface ColumnPickerChoice extends Pick<Swimlane, 'icon' | 'role'> {
  /** What the field stores: a column id or a column name, as the caller decides. */
  value: string;
  name: string;
  color: string | null;
}

export interface ColumnPickerProps {
  value: string;
  /** The columns, in board order. */
  columns: readonly ColumnPickerChoice[];
  onChange: (value: string) => void;
  /** An option listed before the columns and set apart from them. */
  leadingOption?: { value: string; label: string };
  testId: string;
  ariaLabel: string;
}

const GLYPH_SIZE = 14;

export function ColumnPicker({ value, columns, onChange, leadingOption, testId, ariaLabel }: ColumnPickerProps) {
  const { t } = useLingui();
  const choices: GlyphPickerChoice[] = [
    ...(leadingOption ? [{ value: leadingOption.value, label: leadingOption.label, glyph: <LeadingGlyph />, dividerAfter: true }] : []),
    ...columns.map((column) => ({ value: column.value, label: column.name, glyph: <ColumnChoiceGlyph column={column} /> })),
  ];
  if (!choices.some((choice) => choice.value === value)) {
    choices.push({ value, label: t`${value} (not on this board)`, glyph: null });
  }
  return (
    <GlyphPicker
      value={value}
      choices={choices}
      onChange={onChange}
      testId={testId}
      ariaLabel={ariaLabel}
      glyphSlotWidth={GLYPH_SIZE}
    />
  );
}

/** The leading option's muted arrow. */
function LeadingGlyph() {
  return (
    <span data-testid="column-picker-leading-glyph" aria-hidden="true" className="inline-flex shrink-0 text-fg-muted">
      <ArrowRight size={GLYPH_SIZE} />
    </span>
  );
}

/**
 * A column's glyph in its own color. A user's color is data, so it is a style,
 * not a class. `data-color` lets a test read the color the field was handed.
 */
function ColumnChoiceGlyph({ column }: { column: ColumnPickerChoice }) {
  return (
    <span
      data-testid="column-picker-glyph"
      data-color={column.color ?? ''}
      aria-hidden="true"
      className="inline-flex shrink-0"
    >
      <ColumnGlyph column={column} size={GLYPH_SIZE} color={column.color} />
    </span>
  );
}
