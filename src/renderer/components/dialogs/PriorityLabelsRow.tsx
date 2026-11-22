import { useLingui } from '@lingui/react/macro';
import { useConfigStore } from '../../stores/config-store';
import { useAllExistingLabels } from '../../hooks/useAllExistingLabels';
import { Field } from '../Field';
import { GlyphPicker } from '../GlyphPicker';
import { LabelInput } from '../LabelInput';
import { DEFAULT_PRIORITY_CONFIG } from '../../../shared/types';
import { displayPriorityLabel } from '../backlog/priority-labels';
import { PriorityMeter, priorityMeterWidth } from '../backlog/PriorityMeter';
import { useDevicePixelRatio } from '../../hooks/useDevicePixelRatio';

interface PriorityLabelsRowProps {
  priority: number;
  setPriority: (priority: number) => void;
  labels: string[];
  setLabels: (labels: string[]) => void;
  /**
   * Prefix for the two test ids, so the board dialogs keep `task-priority` /
   * `task-labels` while the backlog dialog keeps `backlog-task-priority` /
   * `backlog-task-labels`.
   */
  testIdPrefix: string;
}

/**
 * The Priority + Labels pair, side by side.
 *
 * Lived as three verbatim copies (NewTaskDialog, TaskDetailEditForm,
 * NewBacklogTaskDialog), each carrying its own duplicate of the field's class
 * string. That is what let the three drift, and what would have made "verify in
 * both modes" a manual inspection rather than a structural guarantee.
 *
 * Both fields read their config from the store directly rather than taking it
 * as props: every caller was already pulling the same two selectors.
 */
export function PriorityLabelsRow({
  priority,
  setPriority,
  labels,
  setLabels,
  testIdPrefix,
}: PriorityLabelsRowProps) {
  const { t } = useLingui();
  const labelColors = useConfigStore((state) => state.config.backlog?.labelColors) ?? {};
  const priorities = useConfigStore((state) => state.config.backlog?.priorities) ?? DEFAULT_PRIORITY_CONFIG;
  const allExistingLabels = useAllExistingLabels();
  // The meter snaps its bars to device pixels, so its slot is sized at the same ratio.
  const devicePixelRatio = useDevicePixelRatio();

  return (
    <div className="flex gap-3">
      <Field label={t`Priority`} className="flex-1 min-w-0">
        {/* Each level with its meter, as everywhere else a priority shows (#1160).
            A native select's options hold text only, so this is the listbox field. */}
        <GlyphPicker
          value={String(priority)}
          choices={priorities.map((priorityEntry, index) => ({
            value: String(index),
            label: displayPriorityLabel(priorityEntry.label),
            glyph: <PriorityMeter level={index} levelCount={priorities.length} color={priorityEntry.color} />,
          }))}
          onChange={(next) => setPriority(Number(next))}
          testId={`${testIdPrefix}priority`}
          ariaLabel={t`Priority`}
          glyphSlotWidth={priorityMeterWidth(priorities.length, devicePixelRatio)}
        />
      </Field>
      <Field label={t`Labels`} className="flex-1 min-w-0">
        <LabelInput
          labels={labels}
          setLabels={setLabels}
          labelColors={labelColors}
          allExistingLabels={allExistingLabels}
          testId={`${testIdPrefix}labels`}
        />
      </Field>
    </div>
  );
}
