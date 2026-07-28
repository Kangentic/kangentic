import { useConfigStore } from '../../stores/config-store';
import { useAllExistingLabels } from '../../hooks/useAllExistingLabels';
import { Field, FIELD_SELECT_CLASS } from '../Field';
import { LabelInput } from '../LabelInput';
import { Select } from '../settings/shared';
import { DEFAULT_PRIORITY_CONFIG } from '../../../shared/types';

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
 * NewBacklogTaskDialog), each carrying its own duplicate of the Select's class
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
  const labelColors = useConfigStore((state) => state.config.backlog?.labelColors) ?? {};
  const priorities = useConfigStore((state) => state.config.backlog?.priorities) ?? DEFAULT_PRIORITY_CONFIG;
  const allExistingLabels = useAllExistingLabels();

  return (
    <div className="flex gap-3">
      <Field label="Priority" className="flex-1 min-w-0">
        <Select
          value={priority}
          onChange={(event) => setPriority(Number((event.target as HTMLSelectElement).value))}
          className={FIELD_SELECT_CLASS}
          data-testid={`${testIdPrefix}priority`}
        >
          {priorities.map((priorityEntry, index) => (
            <option key={index} value={index}>{priorityEntry.label}</option>
          ))}
        </Select>
      </Field>
      <Field label="Labels" className="flex-1 min-w-0">
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
