import { SettingText } from './SettingText';
import { SegmentedControl, type SegmentedControlOption } from './SegmentedControl';
import { InfoTip } from './settings/settings-card';
import { TOGGLE_CARD_SURFACE } from './ToggleCard';

interface ChoiceCardProps<T extends string> {
  label: string;
  /** One sentence. The longer explanation goes in `info`. */
  description: string;
  /** The full explanation, behind an info icon beside the label. */
  info?: string;
  options: readonly SegmentedControlOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** `data-testid` for the segmented control, so existing selectors keep working. */
  testId?: string;
}

/**
 * `ToggleCard`'s sibling for a short named choice: the same shell, the label,
 * its info icon and a one-sentence description on the left, and the options on
 * the right where a ToggleCard puts its switch. So a card holding a switch and
 * a choice reads as one list of rows (the Column Manager's Conversation card).
 *
 * Not a button, unlike ToggleCard: each option is its own target.
 */
export function ChoiceCard<T extends string>({ label, description, info, options, value, onChange, testId }: ChoiceCardProps<T>) {
  return (
    <div className={`flex w-full items-center justify-between gap-3 rounded-md border px-3.5 py-2.5 ${TOGGLE_CARD_SURFACE.disabled}`}>
      <SettingText
        className="flex-1"
        label={label}
        description={description}
        labelTrailing={info && <InfoTip label={label} text={info} />}
      />
      <SegmentedControl
        options={options}
        value={value}
        onChange={onChange}
        quiet
        ariaLabel={label}
        testId={testId}
        className="flex-shrink-0"
      />
    </div>
  );
}
