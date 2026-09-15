import React from 'react';
import { GripVertical, Pencil, Plus, Trash2, Zap } from 'lucide-react';
import { DndContext, closestCenter, PointerSensor, KeyboardSensor, useSensor, useSensors, type CollisionDetection, type DragEndEvent, type Modifier } from '@dnd-kit/core';
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

/**
 * Keep a dragged row inside the pane's own scroller, and on its vertical axis.
 *
 * Without this, dragging a row downward RAN AWAY: the pane scrolled itself into
 * empty space and the row followed it off the bottom. The cause is a feedback
 * loop rather than a stray setting. A transformed element still contributes to
 * its ancestor's scrollable overflow, so translating a row down grows the
 * scroller's `scrollHeight`; dnd-kit's auto-scroll sees room to scroll, scrolls
 * toward the pointer, which lets the row translate further, which grows
 * `scrollHeight` again. Measured in a preview: the pane sat at scrollHeight 344
 * against clientHeight 344, not scrollable at all, and a single 400px transform
 * took it to 484 and made it scrollable. The drag was manufacturing the very
 * overflow it then chased.
 *
 * Clamping the transform breaks the loop at its source: the row cannot leave the
 * visible box, so it cannot invent overflow. Genuine auto-scroll still works on
 * a list long enough to really overflow, because then the room to scroll exists
 * whether or not anything is being dragged.
 *
 * This is `restrictToFirstScrollableAncestor` plus `restrictToVerticalAxis` from
 * `@dnd-kit/modifiers`, written out rather than installed. The package is not a
 * dependency here, and a new one to avoid twelve lines is a bad trade.
 *
 * The x axis is pinned rather than clamped. This is a vertical list, sideways
 * travel means nothing to it, and letting x drift would grow horizontal overflow
 * the same way.
 */
const restrictToScroller: Modifier = ({ transform, draggingNodeRect, scrollableAncestorRects }) => {
  const bounds = scrollableAncestorRects[0];
  if (!draggingNodeRect || !bounds) return { ...transform, x: 0 };

  let y = transform.y;
  if (draggingNodeRect.top + y <= bounds.top) {
    y = bounds.top - draggingNodeRect.top;
  } else if (draggingNodeRect.bottom + y >= bounds.top + bounds.height) {
    y = bounds.top + bounds.height - draggingNodeRect.bottom;
  }
  return { ...transform, x: 0, y };
};

export function AutomationsPane(props: AutomationsPaneProps) {
  const { column } = props;
  // Pattern C: a DndContext's internal subscriptions go stale across a Fast
  // Refresh, so it is re-keyed on the HMR generation.
  const hmrGeneration = useHmrGeneration();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  /**
   * A row is only ever a drop target for its OWN group.
   *
   * Dragging across the heading used to change the row's trigger, and it was
   * dropped rather than finished, because the feedback it needs cannot exist
   * here: each group is its own `SortableContext`, and dnd-kit shows a drop
   * position by displacing the other items IN THAT CONTEXT. The destination
   * group can never open a gap for a row it does not contain, so the gesture
   * committed a change with nothing on screen leading up to it. The half of it
   * that handled an empty group was not even wired - it tested for a
   * `group:` droppable that is registered nowhere - so dropping into an empty
   * group silently did nothing.
   *
   * The trigger keeps its editing home in the dialog's When field, which says
   * what it does and is reachable by keyboard. A grip now means what a grip
   * usually means: reorder, within this list.
   *
   * Filtering the COLLISIONS rather than rejecting the drop is what makes that
   * visible. A rejected drop is a silent no-op; with the other group's rows
   * removed from consideration, the dragged row keeps targeting a real slot in
   * its own group the whole time, so releasing anywhere puts it somewhere
   * sensible.
   */
  const collisionDetection: CollisionDetection = (args) => {
    const activeRow = props.drafts.find((draft) => draft.id === String(args.active.id));
    if (!activeRow) return closestCenter(args);
    const sameGroup = args.droppableContainers.filter((container) => {
      const row = props.drafts.find((draft) => draft.id === String(container.id));
      return row?.trigger === activeRow.trigger;
    });
    return closestCenter({ ...args, droppableContainers: sameGroup });
  };

  const handleDragEnd = (event: DragEndEvent): void => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const activeId = String(active.id);
    const overId = String(over.id);

    const activeRow = props.drafts.find((draft) => draft.id === activeId);
    const overRow = props.drafts.find((draft) => draft.id === overId);
    // The collision filter should already have made this impossible; the guard
    // is here so a future collision strategy cannot quietly reopen it.
    if (!activeRow || !overRow || activeRow.trigger !== overRow.trigger) return;

    props.onReorder(activeId, activeRow.trigger, dropIndexFor(props.drafts, activeRow.trigger, overId));
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

      <DndContext
        key={hmrGeneration}
        sensors={sensors}
        collisionDetection={collisionDetection}
        modifiers={[restrictToScroller]}
        onDragEnd={handleDragEnd}
      >
        <div data-testid="column-automations-scroller" className="min-h-0 overflow-y-auto">
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
              // A lone row has nothing to reorder against, so it gets no grip.
              // The GROUP decides, not the row: a row cannot see its siblings.
              <AutomationRow key={draft.id} draft={draft} index={index} reorderable={rows.length > 1} {...props} />
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
  reorderable,
}: AutomationsPaneProps & { draft: AutomationDraft; index: number; reorderable: boolean }) {
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
        {...(reorderable ? attributes : {})}
        {...(reorderable ? listeners : {})}
        {...(reorderable
          ? { 'data-drag-handle': true, 'data-no-dismiss': true, 'aria-label': `Reorder ${draft.name}` }
          // Not a handle, so it is not announced as one and the light-dismiss
          // denylist has nothing to exempt: it is inert padding at this point.
          : { 'aria-hidden': true })}
        // The grip reorders and does nothing else. Without this a plain click
        // on it (a drag that never moved far enough to start) would fall
        // through to the row and open the editor. A real drag is already
        // covered: dnd-kit's pointer sensor arms a capture-phase click
        // suppressor on drop, which is what keeps a finished reorder from
        // opening the row it just moved.
        //
        // With no grip there is nothing to protect, and swallowing the click
        // would leave a dead 33px notch in a row that opens everywhere else.
        onClick={reorderable ? (event) => event.stopPropagation() : undefined}
        // The TARGET is a full-height strip down the row's left edge, not the
        // glyph. The glyph alone measured 13 x 13, which is 169 square pixels
        // to hit in a 50px row, well under the 24px minimum every pointer
        // guideline gives a drag affordance, and it read as clunky because it
        // was: you had to find a 13px square before the row would move.
        //
        // `self-stretch` takes the row's full inner height against its
        // `items-center`, and the negative margins cancel the row's own
        // `px-2 py-1.5` so the strip reaches the inside of the border instead
        // of floating in the middle of it. The padding is then given back on
        // the inside, so the glyph sits exactly where it always did.
        //
        // The right edge works the same way and is worth spelling out, because
        // it looks like a typo: `pr-3` with `-mr-2` widens the strip by the 8px
        // of the row's own `gap-2`, which was dead space between the glyph and
        // the index. Widening with padding alone would have pushed every row's
        // text right instead. Measured: the label's left edge is the same pixel
        // before and after, and the target went from 169 square pixels to 1584.
        //
        // The tint is what makes it discoverable. The glyph is visible at rest
        // either way (a hover-only control is banned, `ui-conventions.md`), but
        // nothing said how far the grabbable zone reached, so hovering the row
        // paints the whole strip and the boundary stops being a guess.
        //
        // A veil at 8%, not a surface token, and the whole ramp was tried to
        // get here. The row is already `surface-control` (#393940), so its
        // neighbours on that ramp are either invisible or loud: `surface-hover`
        // is #3f3f46, a six-unit difference that disappeared on screen, while
        // `surface-raised` (#27272a) and `surface-inset` (#18181b) both landed
        // as a dark block cut out of the row. A translucent foreground is the
        // only one of the four that scales, because it is a FRACTION of the row
        // rather than a fixed step away from it, and it inverts on its own: the
        // token is near-white in the dark themes and near-black in the light
        // ones, so the strip lifts against a dark row and deepens against a
        // light one without a second rule.
        className={`flex items-center self-stretch rounded-l -my-1.5 -ml-2 -mr-2 pl-2 pr-3 text-fg-faint transition-colors ${
          reorderable ? 'cursor-grab group-hover:bg-fg/[0.08] group-hover:text-fg-tertiary active:cursor-grabbing' : ''
        }`}
      >
        {/* The gutter stays even with no grip in it, and the glyph is what
            holds it open: hidden rather than dropped, so the spacer is exactly
            the width of the thing it replaces and follows any later change to
            `size` on its own. Dropping the element instead measured a 13px
            pull, putting a lone row's text at x=1487 against x=1500 for every
            row in the group above it, in one card where the eye tracks that
            left edge straight down. */}
        <GripVertical size={13} className={reorderable ? '' : 'invisible'} />
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
