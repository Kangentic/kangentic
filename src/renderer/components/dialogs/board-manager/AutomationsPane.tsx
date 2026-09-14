import React from 'react';
import { GripVertical, Pencil, Plus, Trash2, Zap } from 'lucide-react';
import { DndContext, closestCenter, PointerSensor, KeyboardSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy, sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { AUTOMATION_MANIFEST } from '../../../../shared/automation-manifest';
import type { AutomationTrigger, Swimlane } from '../../../../shared/types';
import { useHmrGeneration } from '../../../utils/hmr-generation';
import { SETTING_DESCRIPTION_CLASS, SETTING_LABEL_CLASS } from '../../SettingText';
import { ToggleSwitch } from '../../settings/shared';
import { automationIcon } from './automation-icons';
import { SectionCard, GroupHeading, DisabledSectionNotice } from './form-layout';
import {
  TRIGGERS,
  TRIGGER_LABELS,
  canRunRow,
  describeDraft,
  dropIndexFor,
  rowsFor,
  type AutomationDraft,
} from './automation-drafts';

/**
 * A column's automations: one card, two groups.
 *
 * Built from the SAME `SectionCard` as General, Agent and Conversation, because
 * this is the fourth section rather than a differently shaped panel. It lives in
 * the right pane only because a row carries a name, a type, a sentence and three
 * controls, and needs the width.
 *
 * Each group heading doubles as the separator between the groups, and each group
 * owns its own Add control, so the trigger is chosen by WHERE you add rather
 * than by a control afterwards. That is what dropping the `both` trigger bought,
 * and it is why a row has three controls instead of six.
 */

export interface AutomationsPaneProps {
  column: Swimlane;
  drafts: AutomationDraft[];
  /**
   * Read-only under a profile: a list belongs to the COLUMN, not to a profile
   * of it, so there is nothing here a profile could legitimately re-point. The
   * design once carved out the message row, because `BoardProfileEntry`
   * carried an `autoCommand` that overlaid it; that key is retired and
   * `resolveColumnMessage` reads the automation alone, so the carve-out would
   * now be an editor for a value nothing reads.
   */
  readOnly: boolean;
  lastRunLabel?: (draftId: string) => string | null;
  onAdd: (trigger: AutomationTrigger, anchor: HTMLElement) => void;
  onEdit: (draft: AutomationDraft) => void;
  onDelete: (draft: AutomationDraft) => void;
  onToggle: (draft: AutomationDraft, enabled: boolean) => void;
  onReorder: (id: string, trigger: AutomationTrigger, indexInGroup: number) => void;
  isDirty: (draft: AutomationDraft) => boolean;
}

export function AutomationsPane(props: AutomationsPaneProps) {
  const { column } = props;
  // Pattern C: a DndContext's internal subscriptions go stale across a Fast
  // Refresh, so it is re-keyed on the HMR generation.
  const hmrGeneration = useHmrGeneration();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const handleDragEnd = (event: DragEndEvent): void => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const activeId = String(active.id);
    const overId = String(over.id);

    // The drop target carries its group, so a drag across the heading is a
    // trigger change and a position in one gesture.
    const overRow = props.drafts.find((draft) => draft.id === overId);
    const trigger = overRow?.trigger ?? (overId.startsWith('group:') ? (overId.slice(6) as AutomationTrigger) : null);
    if (!trigger) return;

    props.onReorder(activeId, trigger, dropIndexFor(props.drafts, trigger, overRow ? overId : null));
  };

  // The explanation rides the header's info icon rather than a line of copy
  // under it. This was the only one of the four cards with a subheader, so it
  // read as a different kind of card than General, Agent and Conversation; and
  // the two group headings below already say "On enter" and "On exit", which is
  // the half of the sentence a reader needs at a glance.
  return (
    <SectionCard
      id="automations"
      label="Automations"
      icon={Zap}
      info="What happens when a task enters or leaves this column, from or to any column, in this order."
      className="flex flex-col min-h-0"
    >
      {props.readOnly && (
        <DisabledSectionNotice reason="Automations are shared by every profile. Switch to Default to edit them." />
      )}

      <DndContext key={hmrGeneration} sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <div className="min-h-0 overflow-y-auto">
          {TRIGGERS.map((trigger) => (
            <AutomationGroup key={trigger} trigger={trigger} {...props} column={column} />
          ))}
        </div>
      </DndContext>
    </SectionCard>
  );
}

function AutomationGroup({ trigger, ...props }: AutomationsPaneProps & { trigger: AutomationTrigger }) {
  const rows = rowsFor(props.drafts, trigger);
  // To Do and Done can never run an ENTER automation, so that group is replaced
  // by the reason rather than shown empty with an Add control that would build
  // something inert.
  const enterBlocked = trigger === 'enter' && (props.column.role === 'todo' || props.column.role === 'done');

  return (
    <section data-testid="column-automation-group" data-trigger={trigger}>
      <GroupHeading label={TRIGGER_LABELS[trigger]} />
      {enterBlocked ? (
        <p className="text-xs text-fg-faint py-1">
          Nothing runs when a task enters {props.column.name}.
        </p>
      ) : (
        <SortableContext items={rows.map((row) => row.id)} strategy={verticalListSortingStrategy}>
          <ul className="flex flex-col gap-1">
            {rows.map((draft, index) => (
              <AutomationRow key={draft.id} draft={draft} index={index} {...props} />
            ))}
          </ul>
          {!props.readOnly && <AddAutomationButton trigger={trigger} onAdd={props.onAdd} />}
        </SortableContext>
      )}
    </section>
  );
}

function AddAutomationButton({ trigger, onAdd }: { trigger: AutomationTrigger; onAdd: AutomationsPaneProps['onAdd'] }) {
  return (
    <button
      type="button"
      data-testid="column-automation-add"
      data-trigger={trigger}
      onClick={(event) => onAdd(trigger, event.currentTarget)}
      className="mt-1 flex w-full cursor-pointer items-center justify-center gap-1.5 rounded border border-dashed border-edge/70 py-1.5 text-xs text-fg-muted transition-colors hover:border-edge hover:text-fg-tertiary"
    >
      <Plus size={13} />
      Add automation
    </button>
  );
}

function AutomationRow({
  draft,
  index,
  column,
  readOnly,
  lastRunLabel,
  onEdit,
  onDelete,
  onToggle,
  isDirty,
}: AutomationsPaneProps & { draft: AutomationDraft; index: number }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: draft.id });
  const runnable = canRunRow(draft, column);
  const entry = AUTOMATION_MANIFEST[draft.type];
  const RowIcon = automationIcon(entry.icon);
  const legacy = entry.status === 'legacy';
  const lastRun = lastRunLabel?.(draft.id) ?? null;

  // A row the column cannot run is shown OFF with its switch disabled, and the
  // draft keeps its stored `enabled`, so turning the setting back on restores it
  // rather than leaving the user to re-enable every row by hand.
  const switchedOn = draft.enabled && runnable.ok;

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      data-testid="column-automation-row"
      data-name={draft.name}
      data-index={index}
      data-trigger={draft.trigger}
      data-enabled={draft.enabled ? 'true' : 'false'}
      data-can-run={runnable.ok ? 'true' : 'false'}
      // EVERY row draws the same control surface as the rest of the page: the
      // full `surface-control` / `edge-input` pair ToggleCard and every field
      // use (`ui-conventions.md`'s control-fill rule).
      //
      // The same in both states on purpose. The switch is what says on or off,
      // and it says it unambiguously - so fading the row said it a second time,
      // in a way that also made an off automation look unreachable and its own
      // name and sentence harder to read. A row is a thing you are configuring
      // whether or not it currently runs.
      //
      // Clicking anywhere that is not a control opens the editor, so the row
      // behaves like the thing it represents rather than a label beside a
      // pencil. `cursor-pointer` is not decoration here: it is what tells the
      // light-dismiss denylist this is an action rather than dead space, and
      // what lets the hover border promise something true (`ui-conventions.md`,
      // `light-dismiss-denylist.md`).
      //
      // NOT a <button> and no `role="button"`. The row carries a drag handle, a
      // pencil, a trash and a switch, and interactive content inside a button
      // role is invalid and mis-announced. Every action stays reachable from
      // those real controls, so the row click is an enhancement on top of a
      // keyboard path that already worked.
      onClick={readOnly ? undefined : () => onEdit(draft)}
      className={`group flex items-center gap-2 rounded border border-edge-input bg-surface-control px-2 py-1.5 ${
        readOnly ? '' : 'cursor-pointer hover:border-fg-faint'
      } ${isDragging ? 'z-10 shadow-lg' : ''}`}
    >
      {/* light-dismiss-ok: a grab cursor is not `pointer`, so the denylist would
          read this handle as dead space and close the window on a drag start.
          Same exemption ColumnRail's handle carries. */}
      <span
        {...attributes}
        {...listeners}
        data-drag-handle
        data-no-dismiss
        aria-label={`Reorder ${draft.name}`}
        // The grip reorders and does nothing else. Without this a plain click
        // on it (a drag that never moved far enough to start) would fall
        // through to the row and open the editor. A real drag is already
        // covered: dnd-kit's pointer sensor arms a capture-phase click
        // suppressor on drop, which is what keeps a finished reorder from
        // opening the row it just moved.
        onClick={(event) => event.stopPropagation()}
        className="cursor-grab text-fg-faint hover:text-fg-tertiary active:cursor-grabbing"
      >
        <GripVertical size={13} />
      </span>

      <span className="w-4 shrink-0 text-right text-[11px] tabular-nums text-fg-faint">{index + 1}</span>
      <RowIcon size={13} className="shrink-0 text-fg-muted" />

      {/* The SHARED label/description pair, not a bespoke one. A row is a
          setting's title over its supporting line, exactly like the ToggleCards
          and SettingFields beside it, so it reads at the same size, weight and
          tone as they do. It used to re-type `text-xs`/`text-[11px] fg-faint`,
          which both looked different from every other panel and put a line the
          user has to read in the tone `SettingText` reserves for decoration -
          `fg-faint` clears AA in almost none of the ten themes. */}
      <span data-testid="column-automation-row-label" className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className={`truncate ${SETTING_LABEL_CLASS}`}>{draft.name}</span>
          {isDirty(draft) && <span title="Unsaved" className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />}
        </span>
        <span className={`block truncate ${SETTING_DESCRIPTION_CLASS}`}>{describeDraft(draft)}</span>
        {legacy && (
          <span data-testid="column-automation-lint" className="block truncate text-xs text-warning">
            This is handled by the column&apos;s settings now. Remove it to use them.
          </span>
        )}
        {lastRun && (
          <span
            data-testid="column-automation-last-run"
            title={lastRun}
            className={`block truncate ${SETTING_DESCRIPTION_CLASS}`}
          >
            {lastRun}
          </span>
        )}
      </span>

      {!readOnly && (
        <>
          <RowButton
            testId="column-automation-edit"
            label={`Edit ${draft.name}`}
            onClick={() => onEdit(draft)}
          >
            <Pencil size={13} />
          </RowButton>
          {/* A trash, not an X: an X reads as "close this", and the rail already
              deletes with a trash. No confirm, because Cancel on the board
              undoes it. */}
          <RowButton
            testId="column-automation-delete"
            label={`Delete ${draft.name}`}
            onClick={() => onDelete(draft)}
          >
            <Trash2 size={13} />
          </RowButton>
        </>
      )}

      {/* The switch is LAST, which is where every other row in the app puts it.
          Wrapped so its click cannot reach the row: flipping a switch must not
          also open the editor. A span rather than a prop on the control because
          `ToggleSwitch` is shared and takes no click handler of its own. */}
      <span onClick={(event) => event.stopPropagation()} className="flex">
        <ToggleSwitch
          testId="column-automation-enabled"
          ariaLabel={`${draft.name} enabled`}
          title={runnable.ok ? undefined : runnable.reason}
          checked={switchedOn}
          disabled={readOnly || !runnable.ok}
          onChange={(next) => onToggle(draft, next)}
        />
      </span>
    </li>
  );
}

function RowButton({ testId, label, onClick, children }: {
  testId: string;
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-label={label}
      title={label}
      // Stops the row's own click, which would otherwise fire the editor on top
      // of this button's action - harmless on the pencil, and a delete that
      // ALSO opens a dialog for the row it just removed on the trash.
      onClick={(event) => { event.stopPropagation(); onClick(); }}
      className="cursor-pointer rounded p-1 text-fg-faint transition-colors hover:bg-surface-hover hover:text-fg-tertiary"
    >
      {children}
    </button>
  );
}
