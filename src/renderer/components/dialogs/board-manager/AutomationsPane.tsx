import React, { useCallback, useMemo, useRef } from 'react';
import { Columns3Cog, GripVertical, Pencil, Plus, Trash2 } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import { DndContext, closestCenter, PointerSensor, useSensor, useSensors, type CollisionDetection, type DragEndEvent, type Modifier } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { AUTOMATION_MANIFEST, AUTOMATION_TRIGGER_LABELS, canTriggerRun } from '../../../../shared/automation-manifest';
import { translateText } from '../../../i18n/translate';
import { i18n } from '@lingui/core';
import { describeAutomationMarks, describeAutomationSentence } from '../../../../shared/automation-describe';
import type { AutomationTrigger, Swimlane } from '../../../../shared/types';
import { Tooltip } from '../../Tooltip';
import { useHmrGeneration } from '../../../utils/hmr-generation';
import { IntentKeyboardSensor } from '../../../utils/intent-keyboard-sensor';
import { KEYBOARD_SENSOR_OPTIONS } from '../../../utils/dnd-sensor-options';
import { SETTING_LABEL_CLASS } from '../../SettingText';
import { ToggleSwitch } from '../../settings/shared';
import { AutomationIcon, AutomationMarks } from './automation-icons';
import { SectionCard, GroupHeading, DisabledSectionNotice } from './form-layout';
import {
  TRIGGERS,
  canRunRow,
  columnFacts,
  dropIndexFor,
  rowsFor,
  type AutomationDraft,
} from './automation-drafts';

/**
 * A row's second line, the sentence. Muted and set 3px under the name rather
 * than `SETTING_DESCRIPTION_CLASS`: a list row's supporting line, not a
 * setting's description, needs a clearer step down from its name.
 */
const AUTOMATION_ROW_SENTENCE_CLASS = 'mt-[3px] text-xs text-fg-muted';

/** A row drag starts after 4 px. A module constant, never an inline literal: see
 *  dnd-sensor-options.ts. */
const AUTOMATION_ROW_POINTER_SENSOR_OPTIONS = { activationConstraint: { distance: 4 } };
/** The same line when it quotes a script, in the mono font. */
const AUTOMATION_ROW_SENTENCE_CODE_CLASS = `${AUTOMATION_ROW_SENTENCE_CLASS} font-mono`;

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
  /**
   * Whether the agent this column runs reports a turn end, from the agent
   * list. Undefined while the list loads, which shows the group rather than
   * blocking it on a guess.
   */
  reportsTurnEnd?: boolean;
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
 *
 * The bound is the row's OWN GROUP, intersected with that scroller. A row can
 * only ever land in its own group, so letting it travel past the heading into
 * the other one advertised a drop that was never going to happen: it sat over
 * On exit's rows looking like it belonged there and then snapped back. Stopping
 * it at its group's last row makes the reachable range and the legal range the
 * same thing. The intersection is what keeps the scroller half honest, since a
 * group longer than the pane would otherwise let the row leave the visible box
 * and start the overflow loop again.
 */
interface VerticalBounds {
  top: number;
  bottom: number;
}

/** The overlap of two vertical spans, or null when they do not meet. */
function intersectVertically(first: VerticalBounds, second: VerticalBounds): VerticalBounds | null {
  const top = Math.max(first.top, second.top);
  const bottom = Math.min(first.bottom, second.bottom);
  return bottom > top ? { top, bottom } : null;
}

/** Hold a dragged row's travel inside `bounds`, and on its own vertical axis. */
function clampToBounds(
  transform: { x: number; y: number; scaleX: number; scaleY: number },
  rect: { top: number; bottom: number },
  bounds: VerticalBounds,
): { x: number; y: number; scaleX: number; scaleY: number } {
  let y = transform.y;
  if (rect.top + y <= bounds.top) {
    y = bounds.top - rect.top;
  } else if (rect.bottom + y >= bounds.bottom) {
    y = bounds.bottom - rect.bottom;
  }
  return { ...transform, x: 0, y };
}

export function AutomationsPane(props: AutomationsPaneProps) {
  const { column } = props;
  const { t } = useLingui();
  // Pattern C: a DndContext's internal subscriptions go stale across a Fast
  // Refresh, so it is re-keyed on the HMR generation.
  const hmrGeneration = useHmrGeneration();
  // Never the stock KeyboardSensor: a click on the grip focuses it, Enter would
  // lift the row, and an Enter in a field of this dialog would drop it. See
  // intent-keyboard-sensor.ts and keyboard-drag-intent.md.
  const sensors = useSensors(
    useSensor(PointerSensor, AUTOMATION_ROW_POINTER_SENSOR_OPTIONS),
    useSensor(IntentKeyboardSensor, KEYBOARD_SENSOR_OPTIONS),
  );

  /**
   * Each group's row list, so a drag can be bounded by the group it belongs to.
   *
   * The LIST rather than the section: the section also spans its heading and its
   * Add automation control, and neither is somewhere a row can land.
   */
  const groupLists = useRef<Partial<Record<AutomationTrigger, HTMLUListElement | null>>>({});

  const clampToGroup = useCallback<Modifier>(({ transform, draggingNodeRect, active, scrollableAncestorRects }) => {
    if (!draggingNodeRect) return { ...transform, x: 0 };
    const activeRow = props.drafts.find((draft) => draft.id === String(active?.id));
    const list = activeRow ? groupLists.current[activeRow.trigger] : null;
    const scroller = scrollableAncestorRects[0];

    // Pushed rather than filtered: `scrollableAncestorRects[0]` is typed as a
    // rect but indexing an array can hand back undefined, and a type guard for
    // null let that through and crashed the whole DndContext on the first frame
    // of a drag. The compiler could not see it.
    const candidates: VerticalBounds[] = [];
    // The list's own box does not move while its rows translate around it, so
    // this stays put for the whole gesture.
    if (list) {
      const group = list.getBoundingClientRect();
      candidates.push({ top: group.top, bottom: group.bottom });
    }
    if (scroller) candidates.push({ top: scroller.top, bottom: scroller.top + scroller.height });
    if (candidates.length === 0) return { ...transform, x: 0 };

    const bounds = candidates.reduce<VerticalBounds | null>(
      (accumulated, rect) => (accumulated ? intersectVertically(accumulated, rect) : rect),
      null,
    );
    if (!bounds) return { ...transform, x: 0 };

    return clampToBounds(transform, draggingNodeRect, bounds);
  }, [props.drafts]);

  const modifiers = useMemo(() => [clampToGroup], [clampToGroup]);

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
      label={t`Automations`}
      icon={Columns3Cog}
      info={t`What happens when a task enters this column, each time its agent finishes a turn here, and when it leaves, in this order.`}
      className="flex flex-col min-h-0"
    >
      {props.readOnly && (
        <DisabledSectionNotice reason={t`Automations are shared by every profile. Switch to Default to edit them.`} />
      )}

      <DndContext
        key={hmrGeneration}
        sensors={sensors}
        collisionDetection={collisionDetection}
        modifiers={modifiers}
        onDragEnd={handleDragEnd}
      >
        <div data-testid="column-automations-scroller" className="min-h-0 overflow-y-auto">
          {TRIGGERS.map((trigger) => (
            <AutomationGroup
              key={trigger}
              trigger={trigger}
              registerList={(node) => { groupLists.current[trigger] = node; }}
              {...props}
              column={column}
            />
          ))}
        </div>
      </DndContext>
    </SectionCard>
  );
}

function AutomationGroup({ trigger, registerList, ...props }: AutomationsPaneProps & {
  trigger: AutomationTrigger;
  registerList: (node: HTMLUListElement | null) => void;
}) {
  const { t } = useLingui();
  const rows = rowsFor(props.drafts, trigger);
  const columnName = props.column.name;
  // A group no row could ever run in (On task enter in To Do or Done; On agent
  // turn end with no agent here, or one that reports no turn end) is replaced
  // by the reason rather than shown empty with an Add control that would build
  // something inert. The shared rule, so the engine skips exactly these.
  //
  // Rows already in a blocked group stay listed under the reason: the column's
  // agent can change, and a list that vanished would read as deleted.
  const group = canTriggerRun(columnFacts({ ...props.column, reportsTurnEnd: props.reportsTurnEnd }), trigger);
  const blockedReason = group.ok
    ? null
    : (trigger === 'enter' ? t`Nothing runs when a task enters ${columnName}.` : translateText(group.reason));

  return (
    <section data-testid="column-automation-group" data-trigger={trigger}>
      <GroupHeading label={translateText(AUTOMATION_TRIGGER_LABELS[trigger])} />
      {blockedReason !== null && rows.length === 0 ? (
        <p data-testid="column-automation-group-blocked" className="text-xs text-fg-faint py-1">
          {blockedReason}
        </p>
      ) : (
        <SortableContext items={rows.map((row) => row.id)} strategy={verticalListSortingStrategy}>
          <ul ref={registerList} className="flex flex-col gap-1">
            {rows.map((draft, index) => (
              // A lone row has nothing to reorder against, so it gets no grip.
              // The GROUP decides, not the row: a row cannot see its siblings.
              <AutomationRow key={draft.id} draft={draft} index={index} reorderable={rows.length > 1} {...props} />
            ))}
          </ul>
          {blockedReason !== null ? (
            <p data-testid="column-automation-group-blocked" className="text-xs text-fg-faint py-1">
              {blockedReason}
            </p>
          ) : (!props.readOnly && <AddAutomationButton trigger={trigger} onAdd={props.onAdd} />)}
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
      <Trans>Add automation</Trans>
    </button>
  );
}

function AutomationRow({
  draft,
  index,
  column,
  reportsTurnEnd,
  readOnly,
  onEdit,
  onDelete,
  onToggle,
  isDirty,
  reorderable,
}: AutomationsPaneProps & { draft: AutomationDraft; index: number; reorderable: boolean }) {
  const { t } = useLingui();
  const name = draft.name;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: draft.id });
  const runnable = canRunRow(draft, { ...column, reportsTurnEnd });
  const entry = AUTOMATION_MANIFEST[draft.type];
  const legacy = entry.status === 'legacy';
  // Each mark's tooltip leads with its editor card's name, so a first hover
  // names the concept: "Condition: only if the review is clean."
  const marks = describeAutomationMarks(draft, i18n);
  const sentence = describeAutomationSentence(draft.type, draft.config, i18n);

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
      //
      // `py-[7px]` rather than `py-1.5`: the sentence sits 3px under the name,
      // and the extra pixel above and below keeps that gap from crowding the row.
      onClick={readOnly ? undefined : () => onEdit(draft)}
      className={`group flex select-none items-center gap-2 rounded border border-edge-input bg-surface-control px-2 py-[7px] ${
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
          ? { 'data-drag-handle': true, 'data-no-dismiss': true, 'aria-label': t`Reorder ${name}` }
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
        // `px-2 py-[7px]` so the strip reaches the inside of the border instead
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
        className={`flex select-none items-center self-stretch rounded-l -my-[7px] -ml-2 -mr-2 pl-2 pr-3 text-fg-faint transition-colors ${
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
      <AutomationIcon name={entry.icon} size={13} className="shrink-0 text-fg-muted" />

      {/* The name is the shared setting label, so it reads at the size, weight
          and tone of the ToggleCards and SettingFields beside it. The sentence
          under it is its own muted line (`AUTOMATION_ROW_SENTENCE_CLASS`): never
          `fg-faint`, which clears AA in almost none of the ten themes. */}
      <span data-testid="column-automation-row-label" className="min-w-0 flex-1">
        <span data-testid="column-automation-row-title" className="flex items-center gap-1.5">
          <span className={`truncate ${SETTING_LABEL_CLASS}`}>{draft.name}</span>
          {/* Every option that is on is a mark beside the name, in the editor's
              card order: the Condition, the Frequency, then the action's own.
              One tone for all of them, and each tooltip names its card and
              value. The words used to print as a third line, which was too much
              to scan, and the editor holds the detail. The marks never shrink,
              so a long name truncates before they do. The Add automation
              picker's copy rows draw the same component. */}
          <AutomationMarks marks={marks} />
          {isDirty(draft) && (
            <Tooltip label={t`Unsaved`}>
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
            </Tooltip>
          )}
        </span>
        {/* A long value ends where the row ends, and a multi-line one shows its
            first line. The tip holds all of it, every line. */}
        <Tooltip label={sentence.tooltip}>
          <span
            data-testid="column-automation-row-sentence"
            className={`block truncate ${sentence.code ? AUTOMATION_ROW_SENTENCE_CODE_CLASS : AUTOMATION_ROW_SENTENCE_CLASS}`}
          >
            {sentence.text}
          </span>
        </Tooltip>
        {/* No last-run line. One used to print under the description once a row
            had run, so rows in one list differed in height by their history,
            and nobody found the history valuable here: a failure reaches the
            user as the toast with Run again, and every run stays queryable
            through the MCP run tool. The legacy lint below is a warning about
            the row itself, not history, so it stays. */}
        {legacy && (
          <span data-testid="column-automation-lint" className="block truncate text-xs text-warning">
            <Trans>This is handled by the column&apos;s settings now. Remove it to use them.</Trans>
          </span>
        )}
      </span>

      {!readOnly && (
        <>
          <RowButton
            testId="column-automation-edit"
            label={t`Edit ${name}`}
            onClick={() => onEdit(draft)}
          >
            <Pencil size={13} />
          </RowButton>
          {/* A trash, not an X: an X reads as "close this", and the rail already
              deletes with a trash. No confirm, because Cancel on the board
              undoes it. */}
          <RowButton
            testId="column-automation-delete"
            label={t`Delete ${name}`}
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
          ariaLabel={t`${name} enabled`}
          disabledReason={runnable.ok ? undefined : translateText(runnable.reason)}
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
    <Tooltip label={label}>
      <button
        type="button"
        data-testid={testId}
        aria-label={label}
        // Stops the row's own click, which would otherwise fire the editor on top
        // of this button's action - harmless on the pencil, and a delete that
        // ALSO opens a dialog for the row it just removed on the trash.
        onClick={(event) => { event.stopPropagation(); onClick(); }}
        className="cursor-pointer rounded p-1 text-fg-faint transition-colors hover:bg-surface-hover hover:text-fg-tertiary"
      >
        {children}
      </button>
    </Tooltip>
  );
}
