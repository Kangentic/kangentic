import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Layers, Sliders, Bot, MessageSquare, Plus,
  RotateCcw, Palette, ChevronRight, X,
} from 'lucide-react';
import { HexColorPicker } from 'react-colorful';
import { useBoardStore } from '../../stores/board-store';
import { useConfigStore } from '../../stores/config-store';
import { useProjectStore } from '../../stores/project-store';
import { useSessionStore } from '../../stores/session-store';
import { useToastStore } from '../../stores/toast-store';
import { BaseDialog, DialogFooterActions } from './BaseDialog';
import { ConfirmDialog } from './ConfirmDialog';
import { SectionCard } from './board-manager/form-layout';
import { AutomationsPane } from './board-manager/AutomationsPane';
import { AddAutomationPicker } from './board-manager/AddAutomationPicker';
import { EditAutomationDialog } from './board-manager/EditAutomationDialog';
import {
  appendRow,
  copyAutomation,
  describeAutomationChanges,
  describeLastRun,
  dirtyColumnIds,
  draftsByColumn,
  findEmptyName,
  isColumnDirty,
  makeNewAutomation,
  moveRow,
  planAutomationSave,
  pruneColumnRows,
  remapDraftIds,
  removeRow,
  replaceRow,
  runnableAutomationCounts,
  runnableRows,
  setEnabled as setRowEnabled,
  takenNamesFor,
  type AutomationDraft,
  type AutomationDraftsByColumn,
} from './board-manager/automation-drafts';
import type { AutomationTrigger, AutomationType } from '../../../shared/types';
import { formatRelativeTime } from '../../lib/datetime';
import { IconPickerDialog } from './IconPickerDialog';
import { ModelCombobox } from './ModelCombobox';
import { Combobox } from './Combobox';
import { maximizedDialogLayout, MaximizeToggleButton } from './dialog-maximize';
import { ColumnRail, ALL_COLUMNS_ID, type RailRow } from './board-manager/ColumnRail';
import { ColumnsOverview, formatModelName, type OverviewRow, type OverviewValue } from './board-manager/ColumnsOverview';
import { Pill } from '../Pill';
import { ICON_REGISTRY, ROLE_DEFAULTS, getSwimlaneIcon, getUsedIcons } from '../../utils/swimlane-icons';
import { Select } from '../settings/shared';
import { ToggleCard } from '../ToggleCard';
import { SegmentedControl, type SegmentedControlOption } from '../SegmentedControl';
import { SETTING_LABEL_CLASS, SETTING_DESCRIPTION_CLASS } from '../SettingText';
import { OverlayPopover } from '../OverlayPopover';
import { usePopoverPosition } from '../../hooks/usePopoverPosition';
import { useAgentCapabilityResolution } from '../../hooks/useAgentCapabilityResolution';
import { useModelContextWindows, useModelDisplayNames } from '../../hooks/useKnownModels';
import { useKeybinding } from '../../hooks/useKeybinding';
import { modelRowLabel } from '../../utils/format-tokens';
import {
  getPermissionLabel,
  DEFAULT_PERMISSIONS,
  DEFAULT_AGENT,
  getAgentDefaultPermission,
  resolvePermissionForAgent,
  type Swimlane,
  type SwimlaneRole,
  type PermissionMode,
  type SessionTarget,
  type SwimlaneCreateInput,
  type SwimlaneUpdateInput,
  type BoardProfile,
  type BoardProfileEntry,
} from '../../../shared/types';
import { ProfileBar } from './board-manager/ProfileBar';
import { ProfileNameDialog } from './board-manager/ProfileNameDialog';
import { templateVarsFor } from '../../../shared/task-template-vars';

/**
 * Every field this picker serves belongs to a column automation, which runs on
 * a move, so the four move keywords resolve here and are offered. A spawn
 * prompt is not a move and gets the shorter list; that is what `contexts`
 * exists for, and filtering here is what makes the declaration mean something.
 *
 * Module scope because the list never changes, and because the picker is
 * rendered inside a dialog that re-renders on every keystroke.
 */
const AUTOMATION_TEMPLATE_VARS = templateVarsFor('automation');
import { pruneProfileReferencesForColumn } from '../../../shared/board-profile-references';
import { snapSpawnStrategyToTarget } from '../../../shared/session-track';

/** Sentinel entity id keying this dialog's maximize flag in the session store. */
const BOARD_MANAGER_ENTITY_ID = 'board-manager-dialog';

const PRESET_COLORS = [
  '#6b7280', '#ef4444', '#f43f5e', '#f97316',
  '#f59e0b', '#10b981', '#06b6d4', '#3b82f6',
  '#8b5cf6', '#ec4899',
];

const DEFAULT_COLOR = '#3b82f6';
const NEW_DRAFT_PREFIX = 'new:';

type SectionId = 'general' | 'agent' | 'auto';

/**
 * Handoff is deliberately NOT a section. It was one row - a single toggle - so
 * it cost a sticky heading, a rule, and a section's worth of vertical space to
 * present one boolean. It now sits at the end of Automation, which is what it
 * is: something that happens on its own when a task enters the column.
 *
 * The third card is CONVERSATION, not Automation: "automation" is the word for
 * the per-column list on the right, so a settings card cannot also hold it. Both
 * of this card's controls are about the agent's conversation, one handing the
 * previous agent's over and one choosing which the column continues, so the name
 * is reinforced by its own contents. `Zap` stays free for the automations card.
 */
const SECTIONS: { id: SectionId; label: string; icon: typeof Sliders }[] = [
  { id: 'general', label: 'General', icon: Sliders },
  { id: 'agent', label: 'Agent', icon: Bot },
  { id: 'auto', label: 'Conversation', icon: MessageSquare },
];

/**
 * A session is a CHANNEL the board owns, not something a task owns: a task rides
 * whichever channel the column it lands in selects, so an option can never be
 * "the task's session". These are the channels, in the app's own words, the same
 * ones `session_target`, the docs and the MCP column tools use.
 *
 * Module scope because `SegmentedControl` keys its measuring effect on the
 * `options` array and this dialog re-renders on every keystroke in Name. A fresh
 * array per render would rebuild its ResizeObserver, and force a synchronous
 * layout read, once per character.
 */
const SESSION_TARGET_OPTIONS: readonly SegmentedControlOption<SessionTarget>[] = [
  { value: 'main', label: 'Main', testId: 'column-session-target-main' },
  { value: 'isolated', label: 'Isolated', testId: 'column-session-target-isolated' },
];

// ────────────────────────────────────────────────────────────────────────
// Pure helpers (exported for unit tests)
// ────────────────────────────────────────────────────────────────────────

export function isNewDraftId(id: string): boolean {
  return id.startsWith(NEW_DRAFT_PREFIX);
}

/**
 * The strategy fields a Board Profile can re-point, paired with their
 * camelCase key in `BoardProfileEntry`. Column identity (name, role, position,
 * color, icon) is deliberately absent: it is singular across profiles.
 */
const PROFILE_FIELD_MAP = [
  ['agent_override', 'agentOverride'],
  ['model_override', 'modelOverride'],
  ['effort_override', 'effortOverride'],
  ['permission_mode', 'permissionMode'],
  ['auto_command', 'autoCommand'],
  ['auto_command_mode', 'autoCommandMode'],
  ['auto_spawn', 'autoSpawn'],
  ['handoff_context', 'handoffContext'],
  ['session_target', 'sessionTarget'],
  ['session_spawn_strategy', 'sessionSpawnStrategy'],
] as const satisfies ReadonlyArray<readonly [keyof Swimlane, keyof BoardProfileEntry]>;

/**
 * Apply a profile's delta for one column on top of that column's base settings,
 * producing the lane the form should display and edit.
 *
 * Mirrors `applyProfileToLane` in the main process (column-strategy.ts) so what
 * the Column Manager shows is what a spawn will actually resolve. Key PRESENCE
 * is what matters, never `??`: a profile stores `null` to mean "clear this
 * column's pin to the agent default", which is indistinguishable from "inherit"
 * under a nullish coalesce.
 */
export function foldProfileOverDraft(
  base: Swimlane | undefined,
  profile: BoardProfile | null,
): Swimlane | undefined {
  if (!base || !profile) return base;
  const entry = profile.columns[base.id];
  if (!entry) return base;
  const folded: Swimlane = { ...base };
  for (const [laneKey, profileKey] of PROFILE_FIELD_MAP) {
    if (Object.prototype.hasOwnProperty.call(entry, profileKey)) {
      // Safe by construction: PROFILE_FIELD_MAP pairs each lane field with the
      // profile key that carries the same value type.
      (folded as unknown as Record<string, unknown>)[laneKey] = entry[profileKey] ?? null;
    }
  }
  return folded;
}

/**
 * Reduce an edited lane to the delta that differs from its base column.
 *
 * A field equal to the base is OMITTED (inherit), so the profile keeps tracking
 * the column when the column later changes. A field that differs is stored -
 * including an explicit `null`, which is how a profile says "run the agent
 * default here" against a base column that pins a value.
 */
export function diffStrategyAgainstBase(edited: Swimlane, base: Swimlane): BoardProfileEntry {
  const entry: BoardProfileEntry = {};
  for (const [laneKey, profileKey] of PROFILE_FIELD_MAP) {
    const editedValue = (edited as unknown as Record<string, unknown>)[laneKey] ?? null;
    const baseValue = (base as unknown as Record<string, unknown>)[laneKey] ?? null;
    if (editedValue !== baseValue) {
      (entry as Record<string, unknown>)[profileKey] = editedValue;
    }
  }
  return entry;
}

/**
 * The `BoardProfileEntry` keys `PROFILE_FIELD_MAP` covers. Anything outside this
 * set must survive a Board Manager save untouched (see `carryUnmappedEntryKeys`).
 */
const MAPPED_PROFILE_ENTRY_KEYS = new Set<string>(
  PROFILE_FIELD_MAP.map(([, profileKey]) => profileKey),
);

/**
 * Pull forward the entry keys this form does not edit.
 *
 * `diffStrategyAgainstBase` rebuilds an entry from scratch over
 * `PROFILE_FIELD_MAP` only, and the caller replaces the stored entry wholesale,
 * so without this any key the map does not cover is silently DESTROYED by an
 * unrelated edit to the same column.
 *
 * `planExitTarget` is that key today: it is carried by column NAME (matching
 * `BoardColumnConfig.planExitTarget`) while this form edits a swimlane uuid, so
 * it cannot be a straight map entry, but it is fully settable through
 * `kangentic_update_board_profile`. Keying off the map rather than a hardcoded
 * list means a future entry field is preserved by default instead of being lost
 * until someone remembers to add it here.
 */
export function carryUnmappedEntryKeys(existing: BoardProfileEntry | undefined): BoardProfileEntry {
  if (!existing) return {};
  const carried: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(existing)) {
    if (!MAPPED_PROFILE_ENTRY_KEYS.has(key)) carried[key] = value;
  }
  return carried as BoardProfileEntry;
}

/**
 * Shared empty set backing the three predicates' optional `pendingDeleteIds`
 * argument, so the default is one allocation rather than a fresh set per call.
 * Every call site inside this component passes the real set explicitly, so no
 * `useMemo` dependency array relies on this identity today; the default exists
 * for the exported predicates' other callers and their tests.
 */
const EMPTY_ID_SET: ReadonlySet<string> = new Set<string>();

export function isDirty(draft: Swimlane, original: Swimlane | undefined): boolean {
  if (!original) return true;
  return JSON.stringify(draft) !== JSON.stringify(original);
}

// Reserved for future use. The V3 spec called for an "override dot" in
// the section nav, but the semantics ended up too fuzzy ("override
// relative to what?") and the per-field Reset buttons inside each
// section already convey the same information unambiguously. Tab strip
// dirty dots are the single visual signal we surface in the nav now.
//
// Kept exported (always returns false) so the unit-test contract stays
// stable if we want to revive a meaningful override indicator later
// (e.g. for Agent only).
export function hasOverride(_draft: Swimlane, _section: SectionId): boolean {
  return false;
}

/**
 * Reconcile the local `laneOrder` against a fresh store snapshot when the store
 * changes. When no local drag is in flight (`hasLocalReorder` false) the dialog
 * adopts the store's position order, re-inserting any unsaved `new:` drafts just
 * before Done (the historical behavior). When a local drag IS in flight it
 * PRESERVES the user's order: it drops ids the store no longer has, keeps `new:`
 * drafts in place, and appends any never-seen store ids (created elsewhere) just
 * before Done. This is the risk-7 guard: without it, a store refresh (loadBoard
 * HMR re-sync, config-watcher apply, another surface's reorder, or the save
 * flow's own createSwimlane push) would re-sort by position and clobber the
 * unsaved reorder.
 */
export function reconcileLaneOrder(
  previousOrder: string[],
  swimlanes: Swimlane[],
  hasLocalReorder: boolean,
  pendingDeleteIds: ReadonlySet<string> = EMPTY_ID_SET,
): string[] {
  // Staged deletions are filtered out of the STORE snapshot, not just the
  // previous order: a column pending deletion is still in `swimlanes` (nothing
  // has been persisted yet), so both branches below would otherwise re-insert
  // it on the next store update and silently undo the removal.
  const sorted = [...swimlanes]
    .filter((lane) => !pendingDeleteIds.has(lane.id))
    .sort((a, b) => a.position - b.position)
    .map((lane) => lane.id);
  if (!hasLocalReorder) {
    const newIds = previousOrder.filter((id) => id.startsWith(NEW_DRAFT_PREFIX));
    if (newIds.length === 0) return sorted;
    const result = [...sorted];
    const doneIndex = result.findIndex((id) => swimlanes.find((lane) => lane.id === id)?.role === 'done');
    const insertAt = doneIndex >= 0 ? doneIndex : result.length;
    // Insert all drafts in one splice so their relative order is preserved. A
    // per-draft splice at the fixed `insertAt` would land each one before the
    // previous, silently reversing two or more newly-added columns.
    const missingNewIds = newIds.filter((id) => !result.includes(id));
    result.splice(insertAt, 0, ...missingNewIds);
    return result;
  }
  const storeIds = new Set(sorted);
  const kept = previousOrder.filter((id) => id.startsWith(NEW_DRAFT_PREFIX) || storeIds.has(id));
  const known = new Set(kept);
  const incoming = sorted.filter((id) => !known.has(id));
  if (incoming.length === 0) return kept;
  const result = [...kept];
  const doneIndex = result.findIndex((id) => swimlanes.find((lane) => lane.id === id)?.role === 'done');
  const insertAt = doneIndex >= 0 ? doneIndex : result.length;
  result.splice(insertAt, 0, ...incoming);
  return result;
}

/**
 * The persisted column ids whose position differs from the store's
 * position-sorted order. Empty when the order is unchanged, or when a
 * create/delete is pending (a length mismatch, which carries its own dirty
 * state). Unsaved `new:` drafts are ignored. Shared by `isOrderChanged` (the
 * dirty gate) and the footer's affected-column summary so the two never drift.
 */
export function getReorderedColumnIds(
  laneOrder: string[],
  originals: Record<string, Swimlane>,
  pendingDeleteIds: ReadonlySet<string> = EMPTY_ID_SET,
): Set<string> {
  const moved = new Set<string>();
  const persistedOrder = laneOrder.filter((id) => !isNewDraftId(id));
  // Staged deletions are dropped from the baseline too, so the length check
  // below still lines up and a genuine reorder is still detected while a delete
  // is pending. Without this the bailout swallows both.
  const originalOrder = Object.values(originals)
    .filter((lane) => !pendingDeleteIds.has(lane.id))
    .sort((a, b) => a.position - b.position)
    .map((lane) => lane.id);
  if (persistedOrder.length !== originalOrder.length) return moved;
  persistedOrder.forEach((id, index) => {
    if (originalOrder[index] !== id) moved.add(id);
  });
  return moved;
}

/**
 * True when the persisted columns' order in `laneOrder` differs from the store's
 * position-sorted order. Unsaved `new:` drafts are ignored (their placement is
 * handled by the create-then-reorder path on save). Gates the reorder IPC call
 * in handleSave and the footer's modified-column summary.
 */
export function isOrderChanged(
  laneOrder: string[],
  originals: Record<string, Swimlane>,
  pendingDeleteIds: ReadonlySet<string> = EMPTY_ID_SET,
): boolean {
  return getReorderedColumnIds(laneOrder, originals, pendingDeleteIds).size > 0;
}

export function buildUpdateInput(draft: Swimlane, original: Swimlane): SwimlaneUpdateInput {
  const isTodoOrDone = original.role === 'todo' || original.role === 'done';
  const isPlanMode = draft.permission_mode === 'plan';
  return {
    id: draft.id,
    name: draft.name.trim(),
    description: draft.description?.trim() || null,
    color: draft.color,
    icon: draft.icon,
    permission_mode: isTodoOrDone ? undefined : draft.permission_mode,
    auto_spawn: isTodoOrDone ? undefined : draft.auto_spawn,
    auto_command: isTodoOrDone ? undefined : (draft.auto_command?.trim() || null),
    auto_command_mode: isTodoOrDone ? undefined : draft.auto_command_mode,
    plan_exit_target_id: isPlanMode ? (draft.plan_exit_target_id || null) : undefined,
    agent_override: isTodoOrDone ? undefined : (draft.agent_override || null),
    model_override: isTodoOrDone ? undefined : (draft.model_override?.trim() || null),
    effort_override: isTodoOrDone ? undefined : (draft.effort_override || null),
    handoff_context: isTodoOrDone ? undefined : draft.handoff_context,
    session_target: isTodoOrDone ? undefined : draft.session_target,
    session_spawn_strategy: isTodoOrDone ? undefined : draft.session_spawn_strategy,
  };
}

export function buildCreateInput(draft: Swimlane): SwimlaneCreateInput {
  const isPlanMode = draft.permission_mode === 'plan';
  return {
    name: draft.name.trim(),
    description: draft.description?.trim() || null,
    color: draft.color,
    icon: draft.icon,
    permission_mode: draft.permission_mode,
    auto_spawn: draft.auto_spawn,
    auto_command: draft.auto_command?.trim() || null,
    auto_command_mode: draft.auto_command_mode,
    plan_exit_target_id: isPlanMode ? (draft.plan_exit_target_id || null) : undefined,
    agent_override: draft.agent_override || null,
    model_override: draft.model_override?.trim() || null,
    effort_override: draft.effort_override || null,
    handoff_context: draft.handoff_context,
    session_target: draft.session_target,
    session_spawn_strategy: draft.session_spawn_strategy,
  };
}

function makeNewDraft(): Swimlane {
  const id = `${NEW_DRAFT_PREFIX}${crypto.randomUUID()}`;
  return {
    id,
    name: 'New column',
    description: null,
    role: null,
    position: 0,
    color: DEFAULT_COLOR,
    icon: null,
    is_archived: false,
    is_ghost: false,
    permission_mode: null,
    auto_spawn: false,
    auto_command: '',
    auto_command_mode: 'immediate',
    plan_exit_target_id: null,
    agent_override: null,
    model_override: null,
    effort_override: null,
    handoff_context: false,
    session_target: 'main',
    session_spawn_strategy: 'create_or_resume',
    created_at: new Date().toISOString(),
  };
}

// ────────────────────────────────────────────────────────────────────────
// Local presentation helpers
// ────────────────────────────────────────────────────────────────────────

function SettingField({ label, description, hint, children, className = '' }: {
  label: string;
  description?: string;
  hint?: React.ReactNode;
  children: React.ReactNode;
  /** Extra classes on the field wrapper (e.g. a grid col-span for full-width fields). */
  className?: string;
}) {
  // Field block fills its grid cell. `flex flex-col h-full` + `mt-auto` keeps
  // inputs aligned to the bottom of their cell when two fields in the same row
  // have descriptions of differing line count.
  return (
    <div className={`flex flex-col h-full ${className}`}>
      <div className="flex items-center justify-between gap-2">
        {/* Raw classes rather than <SettingText>: this row right-aligns `hint`
            (the Reset control) against the LABEL line, a layout the shared
            component does not own. The values still come from one place. */}
        <label className={SETTING_LABEL_CLASS}>{label}</label>
        {hint}
      </div>
      {description && (
        <p className={`${SETTING_DESCRIPTION_CLASS} mt-0.5`}>{description}</p>
      )}
      <div className={description ? 'mt-auto pt-1.5' : 'mt-1.5'}>{children}</div>
    </div>
  );
}

function ResetHint({ onClick, title }: { onClick: () => void; title: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="flex flex-shrink-0 items-center gap-1 text-xs text-fg-faint hover:text-fg-tertiary transition-colors"
    >
      <RotateCcw size={11} />
      Reset
    </button>
  );
}

/**
 * Sticky section header inside the scrollable detail form. Sections are
 * delineated softly: generous top spacing plus a single faint theme-aware
 * hairline (`border-edge/50`), no filled band. The sticky background matches the
 * dialog surface (`bg-surface-raised`, opaque so fields slide cleanly under when
 * scrolling); `-mx-7 px-7` full-bleeds it and the hairline across the scroll
 * container's padding. `first:` zeroes the rule/margin for General, which sits
 * flush under the identity header. Keeps the `board-manager-section-<id>` testid.
 */
function SettingsSection({ section, children, className }: {
  section: typeof SECTIONS[number];
  children: React.ReactNode;
  /** Grid placement from the column page. See the settings grid's own comment. */
  className?: string;
}) {
  return (
    <SectionCard id={section.id} label={section.label} icon={section.icon} className={className}>
      {children}
    </SectionCard>
  );
}

/** One-line inline explanation shown in place of a section's fields when it does not apply. */
function DisabledSectionNotice({ reason }: { reason: string }) {
  return <p className={`${SETTING_DESCRIPTION_CLASS} pt-3 pb-1 max-w-2xl`}>{reason}</p>;
}

/**
 * The agent-message field's template-variable inserter.
 *
 * This replaced a row of ten always-on `{{chip}}` buttons. Ten monospace tokens
 * are a wall of syntax the user has to read past to reach the field they
 * actually came for, and their names alone do not say what they resolve to -
 * `{{task_xml}}` and `{{description}}` are not self-explanatory. One pill opens
 * a list that can afford to carry each variable's meaning.
 *
 * Portal + `strategy: 'fixed'` is not optional: the board manager's detail form
 * is a scroll container, so an in-flow menu is clipped to it (see
 * `.claude/rules/popover-escapes-clipping.md`). The outside-click handler checks
 * BOTH refs for the same reason - once portaled, a click inside the menu is
 * "outside" the trigger's subtree.
 */
function TemplateVariablePicker({ onInsert }: { onInsert: (variable: string) => void }) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const { style } = usePopoverPosition(
    buttonRef as React.RefObject<HTMLElement>,
    menuRef as React.RefObject<HTMLElement>,
    open,
    { mode: 'dropdown', strategy: 'fixed' },
  );

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (buttonRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', handlePointerDown, true);
    document.addEventListener('keydown', handleKey, true);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown, true);
      document.removeEventListener('keydown', handleKey, true);
    };
  }, [open]);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        data-testid="template-variable-trigger"
        className="inline-flex cursor-pointer items-center gap-1 rounded border border-edge/40 bg-surface-control/40 px-2 py-1 text-xs text-fg-muted transition-colors hover:border-edge hover:text-fg focus:outline-none focus-visible:border-accent"
      >
        <Plus size={13} />
        Template variable
      </button>

      <OverlayPopover
        open={open}
        popoverRef={menuRef}
        style={style}
        portal
        className="fixed z-[2147483646] w-80 overflow-hidden rounded-lg border border-edge bg-surface shadow-xl"
        data-testid="template-variable-menu"
      >
        <div className="max-h-72 overflow-y-auto py-1">
          {AUTOMATION_TEMPLATE_VARS.map((templateVar) => (
            <button
              key={templateVar.name}
              type="button"
              onClick={() => {
                onInsert(templateVar.chip);
                setOpen(false);
              }}
              className="flex w-full cursor-pointer flex-col gap-0.5 px-3 py-1.5 text-left transition-colors hover:bg-surface-hover focus:outline-none focus-visible:bg-surface-hover"
            >
              <span className="font-mono text-xs text-fg">{templateVar.chip}</span>
              {/* Clamped: a couple of these descriptions are written for the docs
                  tables and run long. The full text stays available on hover. */}
              <span className="line-clamp-1 text-[11px] text-fg-faint" title={templateVar.description}>
                {templateVar.description}
              </span>
              {/* Shown only where empty is the NORMAL state, not merely a
                  possible one, so it stays a warning rather than noise. */}
              {templateVar.availability && (
                <span className="text-[11px] text-fg-muted">{templateVar.availability}</span>
              )}
            </button>
          ))}
        </div>
      </OverlayPopover>
    </>
  );
}

/**
 * Pinned identity header for the detail pane: large tinted column icon, name,
 * role badge, board position, and the Delete control (named to its target).
 */
function DetailIdentityHeader({ draft, position, total, profileName }: {
  draft: Swimlane;
  position: number;
  total: number;
  /**
   * Name of the Board Profile currently being edited, or null for Default.
   * The switcher lives in the rail, so without this the detail form gives no
   * indication whose settings it is showing - and editing a profile while
   * believing you are on Default is the one mistake this UI must not allow.
   */
  profileName?: string | null;
}) {
  const Icon = draft.icon ? ICON_REGISTRY.get(draft.icon) : (draft.role ? ROLE_DEFAULTS[draft.role] : null);
  // Identity only: small tinted icon + name + role badge + position + the
  // active profile. Delete moved to the rail's COLUMNS group, where it sits
  // with the other structure actions (add, reorder) instead of alone here.
  return (
    <div className="flex items-center gap-2.5 px-7 py-2.5 border-b border-edge/60 flex-shrink-0">
      {Icon ? (
        <Icon size={18} strokeWidth={1.75} style={{ color: draft.color }} className="flex-shrink-0" />
      ) : (
        <span className="block w-4 h-4 rounded-full flex-shrink-0" style={{ backgroundColor: draft.color }} />
      )}
      <span className="text-sm font-semibold text-fg truncate">{draft.name || 'Untitled'}</span>
      {draft.role && (
        <Pill size="sm" className="bg-surface-control/60 text-fg-faint flex-shrink-0">
          {draft.role === 'todo' ? 'To Do' : 'Done'}
        </Pill>
      )}
      <Pill size="sm" className="bg-surface-control/60 text-fg-faint flex-shrink-0">{position} of {total}</Pill>
      {profileName && (
        <Pill
          size="sm"
          className="bg-accent/15 text-accent flex-shrink-0"
          data-testid="board-manager-active-profile-pill"
        >
          {profileName}
        </Pill>
      )}
      <div className="flex-1" />
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Main dialog
// ────────────────────────────────────────────────────────────────────────

const DIALOG_SELECT_CLASS = 'w-full appearance-none bg-surface-control border border-edge-input rounded pl-3 pr-10 py-1.5 text-sm text-fg-tertiary focus:outline-none focus:border-accent';

// Responsive two-column form grid. Driven by a container query on the scroll
// region (`@container`), so it lays out by the DETAIL PANE's width, not the
// viewport: two columns when the pane is wide enough (maximized, even on a small
// monitor), one column when it is narrow (windowed). Columns auto-size via 1fr.
// Short single-line controls pair up; full-width fields carry `SECTION_FULL_SPAN`.

const SECTION_GRID_CLASS = 'grid grid-cols-1 @[720px]:grid-cols-2 gap-x-6 gap-y-3 pt-2';
const SECTION_FULL_SPAN = '@[720px]:col-span-2';

interface BoardManagerDialogProps {
  initialColumnId: string | null;
  seedNewDraft: boolean;
  /** Increments to request a new draft tab while open. */
  addDraftRequest: number;
  onClose: () => void;
}

export function BoardManagerDialog({ initialColumnId, seedNewDraft, addDraftRequest, onClose }: BoardManagerDialogProps) {
  const swimlanes = useBoardStore((s) => s.swimlanes);
  const tasks = useBoardStore((s) => s.tasks);
  const updateSwimlane = useBoardStore((s) => s.updateSwimlane);
  const createSwimlane = useBoardStore((s) => s.createSwimlane);
  const reorderSwimlanes = useBoardStore((s) => s.reorderSwimlanes);
  const deleteSwimlane = useBoardStore((s) => s.deleteSwimlane);

  const globalPermissionMode = useConfigStore((s) => s.config.agent.permissionMode);
  const currentProject = useProjectStore((state) => state.currentProject);

  // Maximize parity with the create dialogs: the flag lives in the session
  // store's `maximizedTasks` set (keyed by a sentinel id) so it survives HMR.
  const isMaximized = useSessionStore((s) => s.maximizedTasks.has(BOARD_MANAGER_ENTITY_ID));
  const toggleMaximized = useSessionStore((s) => s.toggleMaximized);
  const handleToggleMaximized = useCallback(() => toggleMaximized(BOARD_MANAGER_ENTITY_ID), [toggleMaximized]);

  // Live subscription to the store's agentList so the dialog stays in sync
  // with `useAgentCapabilityResolution` (which also reads from the store).
  // The dialog used to keep a local snapshot here, but that meant the hook
  // and the dropdown / permission resolution could see different data if
  // detection re-ran. The mount effect below refreshes the store, which now
  // implicitly updates this subscription too.
  const agentList = useConfigStore((state) => state.agentList);
  const loadAgentList = useConfigStore((state) => state.loadAgentList);

  // Snapshot originals + drafts at mount. If the dialog was opened with
  // `seedNewDraft=true`, also seed a fresh new draft inline so the dialog
  // appears in its "naming a new column" state on first paint (avoids a
  // post-mount useEffect timing race).
  //
  // Re-syncs from store happen below for non-dirty rows so live changes
  // from other tabs do not get clobbered by the dialog (and vice-versa).
  const initialState = useMemo(() => {
    const baseOriginals: Record<string, Swimlane> = {};
    for (const lane of swimlanes) baseOriginals[lane.id] = lane;
    const baseOrder = [...swimlanes].sort((a, b) => a.position - b.position).map((lane) => lane.id);

    if (seedNewDraft) {
      const draft = makeNewDraft();
      const doneIndex = baseOrder.findIndex((id) => baseOriginals[id]?.role === 'done');
      const insertAt = doneIndex >= 0 ? doneIndex : baseOrder.length;
      const orderWithDraft = [...baseOrder];
      orderWithDraft.splice(insertAt, 0, draft.id);
      return {
        originals: baseOriginals,
        drafts: { ...baseOriginals, [draft.id]: draft },
        newDraftIds: new Set([draft.id]),
        laneOrder: orderWithDraft,
        activeId: draft.id,
        autoFocusNameId: draft.id as string | null,
      };
    }

    // Land on the requested column, or the "All columns" overview when none was
    // specified (no current caller hits the null path; this is the safe default).
    const fallbackActiveId = initialColumnId && swimlanes.some((lane) => lane.id === initialColumnId)
      ? initialColumnId
      : ALL_COLUMNS_ID;
    return {
      originals: baseOriginals,
      drafts: { ...baseOriginals },
      newDraftIds: new Set<string>(),
      laneOrder: baseOrder,
      activeId: fallbackActiveId,
      autoFocusNameId: null as string | null,
    };
    // Mount-only: this initializer must capture the props/store at first
    // render and not recompute on later renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [originals, setOriginals] = useState<Record<string, Swimlane>>(initialState.originals);
  const [drafts, setDrafts] = useState<Record<string, Swimlane>>(initialState.drafts);
  const [newDraftIds, setNewDraftIds] = useState<Set<string>>(initialState.newDraftIds);
  const [laneOrder, setLaneOrder] = useState<string[]>(initialState.laneOrder);
  const [activeId, setActiveId] = useState<string>(initialState.activeId);
  // Persisted columns the user removed but has not saved yet. Deletion used to
  // fire its IPC immediately, which made it the one structural edit in this
  // dialog that Save and Cancel did not govern - the form never went dirty, and
  // Cancel could not undo it. Staging it here puts it on the same footing as an
  // add, a reorder, or any field edit. Their `originals` entries are KEPT so the
  // save path can still name them and a discard restores them for free.
  const [pendingDeleteIds, setPendingDeleteIds] = useState<Set<string>>(() => new Set<string>());

  // Set once the user drags a rail row. Tells the store-sync effect to preserve
  // the local order instead of re-sorting from store positions. Never cleared
  // while open (once local order equals store order, "preserve" is a no-op).
  const hasLocalReorderRef = useRef(false);

  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [showCustomPicker, setShowCustomPicker] = useState(false);
  const [showIconPicker, setShowIconPicker] = useState(false);
  const [hexInput, setHexInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [autoFocusNameId, setAutoFocusNameId] = useState<string | null>(initialState.autoFocusNameId);

  const nameInputRef = useRef<HTMLInputElement>(null);

  const projectDefaultAgent = currentProject?.default_agent ?? DEFAULT_AGENT;
  const projectDefaultAgentLabel = agentList.find((agent) => agent.name === projectDefaultAgent)?.displayName ?? projectDefaultAgent;

  const lastDraftRequestRef = useRef(addDraftRequest);

  // Mirror state into refs so the store-sync effect can read the latest
  // values without including them in its dependency array (which would loop,
  // because the same effect calls setOriginals/setDrafts).
  // Intentional: no deps array on these mirror effects - they fire on every
  // commit so .current always points at the latest snapshot before the
  // store-sync effect runs (effects fire in declaration order).
  const originalsRef = useRef(originals);
  const draftsRef = useRef(drafts);
  const pendingDeleteIdsRef = useRef(pendingDeleteIds);
  useEffect(() => { originalsRef.current = originals; });
  useEffect(() => { draftsRef.current = drafts; });
  useEffect(() => { pendingDeleteIdsRef.current = pendingDeleteIds; });

  // ── Sync from store ────────────────────────────────────────────────
  // When the store updates (other UI edits a column, or a column is created
  // by another flow), refresh the matching original/draft IFF the user has
  // not modified it locally. New (unsaved) drafts are local-only and ignored
  // by this sync. After save, the store update flows back through here so
  // dirty dots clear without us re-creating the dialog state.
  //
  // Reads originals/drafts via refs so we can compare against the latest
  // committed state without putting them in the dep array (which would loop
  // because the same effect calls setOriginals/setDrafts).
  useEffect(() => {
    const previousOriginals = originalsRef.current;
    const previousDrafts = draftsRef.current;
    const stagedDeletes = pendingDeleteIdsRef.current;

    const nextOriginals: Record<string, Swimlane> = {};
    for (const lane of swimlanes) nextOriginals[lane.id] = lane;
    setOriginals(nextOriginals);

    const nextDrafts: Record<string, Swimlane> = { ...previousDrafts };
    for (const lane of swimlanes) {
      // A staged delete removed this lane's draft, but the row is still in the
      // store (nothing is persisted until Save), so `!previousDraft` below would
      // read as "never seen" and re-add it, resurrecting the removal.
      if (stagedDeletes.has(lane.id)) continue;
      const previousDraft = previousDrafts[lane.id];
      const wasDirty = previousDraft ? isDirty(previousDraft, previousOriginals[lane.id]) : false;
      if (!previousDraft || !wasDirty) {
        nextDrafts[lane.id] = lane;
      }
    }
    // Drop entries for lanes that no longer exist (deleted) unless they are unsaved new drafts.
    for (const id of Object.keys(nextDrafts)) {
      if (id.startsWith(NEW_DRAFT_PREFIX)) continue;
      if (!swimlanes.some((lane) => lane.id === id)) delete nextDrafts[id];
    }
    setDrafts(nextDrafts);

    setLaneOrder((previousOrder) => reconcileLaneOrder(previousOrder, swimlanes, hasLocalReorderRef.current, stagedDeletes));
  }, [swimlanes]);

  // ── Refresh agent capabilities ─────────────────────────────────────
  // The agent inventory is loaded once at app bootstrap (App.tsx) and cached in
  // the main process, so the column manager reads the existing snapshot instead
  // of re-probing every open; only fetch when the store is empty. Any component
  // reading `useConfigStore.agentList` (e.g. the New Task dialog's
  // `useAgentCapabilityResolution`) sees the same snapshot.
  useEffect(() => {
    if (useConfigStore.getState().agentList.length === 0) void loadAgentList();
  }, [loadAgentList]);

  // ── Add-new-draft side effect ─────────────────────────────────────
  // Originals are intentionally not touched here - unsaved drafts have no
  // "original" entry, which is how `isDirty` returns true for them.
  const addNewDraft = useCallback(() => {
    const draft = makeNewDraft();
    setDrafts((previous) => ({ ...previous, [draft.id]: draft }));
    setNewDraftIds((previous) => new Set(previous).add(draft.id));
    setLaneOrder((previous) => {
      const result = [...previous];
      const doneIndex = result.findIndex((id) => {
        const lane = swimlanes.find((swimlane) => swimlane.id === id);
        return lane?.role === 'done';
      });
      const insertAt = doneIndex >= 0 ? doneIndex : result.length;
      result.splice(insertAt, 0, draft.id);
      return result;
    });
    setActiveId(draft.id);
    setAutoFocusNameId(draft.id);
  }, [swimlanes]);

  // Add another draft each time the parent ticks `addDraftRequest`.
  useEffect(() => {
    if (addDraftRequest !== lastDraftRequestRef.current) {
      lastDraftRequestRef.current = addDraftRequest;
      addNewDraft();
    }
  }, [addDraftRequest, addNewDraft]);

  // Focus the name input when a new draft becomes active.
  useEffect(() => {
    if (!autoFocusNameId) return;
    if (activeId !== autoFocusNameId) return;
    const handle = window.requestAnimationFrame(() => {
      nameInputRef.current?.focus();
      nameInputRef.current?.select();
      setAutoFocusNameId(null);
    });
    return () => window.cancelAnimationFrame(handle);
  }, [autoFocusNameId, activeId]);

  // ── Board Profiles ────────────────────────────────────────────────
  // A profile is a named alternate ladder of the per-column STRATEGY fields, so
  // one task can run Planning in Opus xhigh and Merge in Sonnet high while
  // another rides a cheaper ladder over the same board. Column IDENTITY (which
  // columns exist, their name, order, role, color, icon) is singular across
  // profiles - only strategy is profile-scoped.
  //
  // Editing works by folding: `draft` below becomes the base column with the
  // active profile's delta applied, and `updateDraft` diffs writes back into the
  // profile instead of the lane. That is why every field in this form works
  // under a profile without being individually rewired.
  const storeBoardProfiles = useBoardStore((state) => state.boardProfiles);
  const saveBoardProfiles = useBoardStore((state) => state.saveBoardProfiles);
  const [profileDrafts, setProfileDrafts] = useState<BoardProfile[]>([]);
  const [profileOriginals, setProfileOriginals] = useState<BoardProfile[]>([]);
  const [activeProfileId, setActiveProfileId] = useState<string | null>(null);
  const [profileNameDialog, setProfileNameDialog] = useState<
    { mode: 'new' | 'duplicate' | 'rename'; value: string } | null
  >(null);

  // Snapshot the store's profiles once per open. Deep-cloned so edits stay local
  // until Save, matching how column drafts work. Hand-written profiles in
  // kangentic.json load here like any other, so they round-trip through an edit
  // rather than being clobbered by it.
  useEffect(() => {
    const snapshot = structuredClone(storeBoardProfiles) as BoardProfile[];
    setProfileDrafts(snapshot);
    setProfileOriginals(structuredClone(storeBoardProfiles) as BoardProfile[]);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- snapshot on mount only; live store changes must not clobber in-progress edits
  }, []);

  const activeProfile = activeProfileId
    ? profileDrafts.find((profile) => profile.id === activeProfileId) ?? null
    : null;

  // ── Derived ────────────────────────────────────────────────────────
  const baseDraft = drafts[activeId];
  // The base column with the active profile's delta folded over it. Identical to
  // the base column when no profile is selected, so the form is unchanged.
  const draft = useMemo(
    () => foldProfileOverDraft(baseDraft, activeProfile),
    [baseDraft, activeProfile],
  );
  const isNewDraft = newDraftIds.has(activeId);
  const draftRole: SwimlaneRole | null = draft?.role ?? null;
  const isTodoOrDone = draftRole === 'todo' || draftRole === 'done';

  // Automation / Handoff only apply when sessions actually run in the column, so
  // they collapse to a one-line inline explanation for role-pinned To Do / Done
  // columns and when Auto-spawn is off. (The Agent section stays visible for a
  // custom column even with Auto-spawn off; only its dependent fields hide.)
  const sessionsRunHere = !isTodoOrDone && draft?.auto_spawn === true;

  // Gates the timing control. Trimmed, so a field holding only whitespace is
  // still "no command" - the injection plan treats it that way too.

  const isOverview = activeId === ALL_COLUMNS_ID;

  // ── Automations ────────────────────────────────────────────────────────
  //
  // A draft per column, snapshotted on mount and again while UNTOUCHED, so a
  // board reload behind an open dialog refreshes what the user has not edited
  // without clobbering what they have.
  const [automationOriginals, setAutomationOriginals] = useState<AutomationDraftsByColumn>({});
  const [automationDrafts, setAutomationDrafts] = useState<AutomationDraftsByColumn>({});
  const [editing, setEditing] = useState<{ columnId: string; rowId: string; isNew: boolean } | null>(null);
  const [pickerOpenFor, setPickerOpenFor] = useState<{ columnId: string; trigger: AutomationTrigger; anchor: HTMLElement } | null>(null);
  const automationsTouchedRef = useRef(false);

  const automations = useBoardStore((s) => s.automations);
  const loadAutomations = useBoardStore((s) => s.loadAutomations);
  const automationRuns = useBoardStore((s) => s.automationRuns);
  const loadAutomationRuns = useBoardStore((s) => s.loadAutomationRuns);
  const replaceAutomationsForColumn = useBoardStore((s) => s.replaceAutomationsForColumn);

  useEffect(() => {
    void loadAutomations();
    // The run history is fetched HERE, on the dialog's mount, because this
    // dialog is its only consumer. It was previously registered for the HMR
    // re-sync and never called on a cold boot, so `automationRuns` sat empty
    // for the whole session and every last-run line was blank.
    void loadAutomationRuns();
  }, [loadAutomations, loadAutomationRuns]);

  /**
   * The last-run line for one row, or null when it has never run.
   *
   * Keyed on the SAVED id, so an unsaved `new:` row correctly has no history:
   * it has never existed as far as the runner is concerned.
   */
  const lastRunLabel = useCallback(
    (draftId: string): string | null => {
      const run = automationRuns[draftId];
      return describeLastRun(run, run ? formatRelativeTime(run.finished_at ?? run.started_at) : '');
    },
    [automationRuns],
  );

  useEffect(() => {
    const next = draftsByColumn(automations);
    setAutomationOriginals(next);
    // Only while untouched: once the user has edited a row, a store refresh
    // must not overwrite their work.
    if (!automationsTouchedRef.current) setAutomationDrafts(next);
  }, [automations]);

  const rowsForColumn = useCallback(
    (columnId: string): AutomationDraft[] => automationDrafts[columnId] ?? [],
    [automationDrafts],
  );

  const mutateRows = useCallback((columnId: string, next: (rows: AutomationDraft[]) => AutomationDraft[]) => {
    automationsTouchedRef.current = true;
    setAutomationDrafts((previous) => ({ ...previous, [columnId]: next(previous[columnId] ?? []) }));
  }, []);

  const automationDirtyColumnIds = useMemo(
    () => dirtyColumnIds(automationOriginals, automationDrafts),
    [automationOriginals, automationDrafts],
  );
  const automationsDirty = automationDirtyColumnIds.length > 0;

  const automationChangeLines = useMemo(
    () => describeAutomationChanges(
      automationOriginals,
      automationDrafts,
      (columnId) => drafts[columnId]?.name?.trim() || 'Untitled column',
    ),
    [automationOriginals, automationDrafts, drafts],
  );

  const dirtyIds = useMemo(
    () => laneOrder.filter((id) => newDraftIds.has(id) || isDirty(drafts[id], originals[id])),
    [drafts, originals, laneOrder, newDraftIds],
  );
  const orderDirty = useMemo(
    () => isOrderChanged(laneOrder, originals, pendingDeleteIds),
    [laneOrder, originals, pendingDeleteIds],
  );
  // Whole-object compare, matching how column dirtiness is tracked. Covers
  // create, rename, duplicate, delete, and any per-column delta edit in one go.
  const profilesDirty = useMemo(
    () => JSON.stringify(profileDrafts) !== JSON.stringify(profileOriginals),
    [profileDrafts, profileOriginals],
  );
  // `automationsDirty` is load-bearing here, for the same reason
  // `profilesDirty` is: automation edits live in `automationDrafts`, never in
  // `drafts`, so an automation-only change leaves every column check false.
  // Without it the Save button stays disabled and the edit cannot be saved at all.
  const hasDirty = dirtyIds.length > 0 || orderDirty || profilesDirty || automationsDirty || pendingDeleteIds.size > 0;

  // Rows for the left rail. The inline override hints (agent / isolated) are
  // suppressed for role-pinned To Do / Done columns, where they never apply.
  const railRows: RailRow[] = useMemo(() => {
    return laneOrder.flatMap((id) => {
      const laneDraft = drafts[id];
      if (!laneDraft) return [];
      const applies = laneDraft.role !== 'todo' && laneDraft.role !== 'done';
      const overrideName = laneDraft.agent_override;
      const agentOverrideLabel = applies && overrideName
        ? (agentList.find((agent) => agent.name === overrideName)?.displayName ?? overrideName)
        : null;
      return [{
        id,
        name: laneDraft.name,
        tabName: originals[id]?.name ?? laneDraft.name,
        color: laneDraft.color,
        icon: laneDraft.icon,
        role: laneDraft.role,
        dirty: newDraftIds.has(id) || isDirty(laneDraft, originals[id]),
        agentOverrideLabel,
        isolated: applies && laneDraft.session_target === 'isolated',
        // The DRAFT's counts, not the saved ones, so switching a row off
        // updates the rail before Save, like every other number on this
        // surface. Enter and exit together: the rail says how much happens
        // here, and the two groups on the column page say which end.
        automationCount: (() => {
          const counts = runnableAutomationCounts(automationDrafts[id] ?? [], laneDraft);
          return counts.enter + counts.exit;
        })(),
      }];
    });
  }, [laneOrder, drafts, originals, newDraftIds, agentList, automationDrafts]);

  // Rows for the "All columns" overview grid, read from drafts so unsaved edits show.
  const overviewRows: OverviewRow[] = useMemo(() => {
    return laneOrder.flatMap((id) => {
      const laneDraft = drafts[id];
      if (!laneDraft) return [];

      // Two reasons a cell can be inapplicable, and they are different facts.
      // To Do and Done never run an agent at all; a column whose "Start an agent
      // here" is off has no agent or session settings to inherit. Both dash, and
      // the `title` says which.
      const isTerminal = laneDraft.role === 'todo' || laneDraft.role === 'done';
      const terminalName = laneDraft.role === 'todo' ? 'To Do' : 'Done';
      const agentReason = isTerminal
        ? `Sessions don't run in ${terminalName} columns.`
        : 'Start an agent here is off.';
      const agentApplies = !isTerminal && laneDraft.auto_spawn;

      // A value cell: the real wording, and whether anyone chose it.
      const value = (label: string, changed: boolean): OverviewValue =>
        agentApplies
          ? { label, changed, applicable: true }
          : { label, changed: false, applicable: false, reason: agentReason };

      const overrideName = laneDraft.agent_override;
      // The EFFECTIVE agent, so it reads "Claude Code" rather than "Default":
      // that is the option the select actually sits on.
      const agentLabel = overrideName
        ? (agentList.find((agent) => agent.name === overrideName)?.displayName ?? overrideName)
        : projectDefaultAgentLabel;
      const modelOverride = laneDraft.model_override?.trim();

      const rows = automationDrafts[id] ?? [];
      const counts = runnableAutomationCounts(rows, laneDraft);
      // The tooltip names exactly the rows the number counts.
      const nameRows = (trigger: AutomationTrigger): string =>
        runnableRows(rows, laneDraft, trigger).map((row) => row.name).join(', ');

      return [{
        id,
        name: laneDraft.name,
        color: laneDraft.color,
        icon: laneDraft.icon,
        role: laneDraft.role,
        dirty:
          newDraftIds.has(id)
          || isDirty(laneDraft, originals[id])
          || isColumnDirty(rows, automationOriginals[id] ?? []),
        // A terminal column has no "Start an agent here" at all, so it dashes
        // rather than showing a ghost switch in the off position, which would
        // claim the setting exists. A normal column always has it.
        autoSpawn: isTerminal
          ? { on: false, applicable: false, reason: agentReason, ariaLabel: 'Start an agent here' }
          : { on: laneDraft.auto_spawn, applicable: true, ariaLabel: 'Start an agent here' },
        agent: value(agentLabel, !!overrideName),
        model: value(modelOverride ? formatModelName(modelOverride) : 'Default', !!modelOverride),
        effort: value(laneDraft.effort_override || 'Default', !!laneDraft.effort_override),
        permission: value(
          laneDraft.permission_mode ? getPermissionLabel(DEFAULT_PERMISSIONS, laneDraft.permission_mode) : 'Default',
          !!laneDraft.permission_mode,
        ),
        handoff: agentApplies
          ? { on: laneDraft.handoff_context, applicable: true, ariaLabel: 'Hand off context when the agent changes' }
          : { on: false, applicable: false, reason: agentReason, ariaLabel: 'Hand off context when the agent changes' },
        session: value(
          laneDraft.session_target === 'isolated' ? 'Isolated' : 'Main',
          laneDraft.session_target === 'isolated',
        ),
        // The counts are what will RUN: a switched-off or blocked row is not
        // counted and not named. This view answers "what happens when a task
        // moves", and an off row is visible and fixable one click away.
        //
        // An enter row can never fire on To Do or Done, so that cell dashes
        // there while On exit stays a real count.
        onEnter: isTerminal
          ? { label: '0', changed: false, applicable: false, reason: `Nothing runs when a task enters ${terminalName}.` }
          : { label: String(counts.enter), changed: counts.enter > 0, applicable: true, reason: nameRows('enter') },
        onExit: { label: String(counts.exit), changed: counts.exit > 0, applicable: true, reason: nameRows('exit') },
      }];
    });
  }, [
    laneOrder, drafts, originals, newDraftIds, agentList, projectDefaultAgentLabel,
    automationDrafts, automationOriginals,
  ]);

  // Effective-agent resolution for the column manager: column draft's
  // override wins over the project default. (Tasks add a fourth tier in
  // their own dialog; this surface intentionally doesn't.)
  const effectiveAgent = draft?.agent_override ?? projectDefaultAgent;
  const {
    info: effectiveAgentInfo,
    models: knownModels,
    effortLevels,
    supportsModelOverride,
  } = useAgentCapabilityResolution(effectiveAgent);
  const modelContextWindows = useModelContextWindows(effectiveAgent);
  const modelDisplayNames = useModelDisplayNames(effectiveAgent);
  const agentPermissions = effectiveAgentInfo?.permissions ?? DEFAULT_PERMISSIONS;

  // Project-level model/effort defaults (mirrors projectDefaultAgent above).
  // Surfaced directly as the inherit option's label/placeholder - no bare
  // "Default" placeholder - so a new column shows what it will actually run
  // with, the same pattern the New Task Advanced section uses.
  const projectDefaultModel = currentProject?.default_model ?? null;
  const projectDefaultModelLabel = projectDefaultModel ? modelRowLabel(projectDefaultModel, modelDisplayNames) : null;
  const projectDefaultEffort = currentProject?.default_effort ?? null;

  // Merge in in-flight lane drafts so the dropdown reflects model picks
  // that other columns set in this same edit session but haven't been
  // saved yet. The hook returns the globally-known set; this adds the
  // local-only context.
  const discoveredModels = useMemo(() => {
    const merged = new Set(knownModels);
    for (const lane of Object.values(drafts)) {
      if (!lane.model_override) continue;
      const laneAgent = lane.agent_override ?? projectDefaultAgent;
      if (laneAgent !== effectiveAgent) continue;
      merged.add(lane.model_override);
    }
    return Array.from(merged).sort((a, b) => a.localeCompare(b));
  }, [knownModels, drafts, projectDefaultAgent, effectiveAgent]);

  const usedIcons = useMemo(() => {
    return getUsedIcons(
      Object.values(drafts).filter((lane) => !newDraftIds.has(lane.id)),
      activeId,
    );
  }, [drafts, newDraftIds, activeId]);

  // Sync hexInput when the active draft's color changes.
  useEffect(() => {
    if (draft) setHexInput(draft.color.toLowerCase());
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-sync only when the color changes, not on every draft identity change, so editing other fields does not clobber in-progress hex input
  }, [draft?.color]);

  // ── Mutators ───────────────────────────────────────────────────────
  const updateDraft = useCallback((updater: (current: Swimlane) => Swimlane) => {
    // Default profile: edit the column itself, exactly as before.
    if (!activeProfileId) {
      setDrafts((previous) => {
        const current = previous[activeId];
        if (!current) return previous;
        return { ...previous, [activeId]: updater(current) };
      });
      return;
    }
    // A profile is selected: run the updater against the FOLDED view the user
    // sees, then diff the result against the base column and store only the
    // differences. Storing a diff (rather than a copy) is what keeps a profile
    // from rotting when the base column later changes.
    setProfileDrafts((previous) => {
      const base = drafts[activeId];
      if (!base) return previous;
      const folded = foldProfileOverDraft(base, previous.find((p) => p.id === activeProfileId) ?? null);
      if (!folded) return previous;
      const nextEntry = diffStrategyAgainstBase(updater(folded), base);
      return previous.map((profile) => {
        if (profile.id !== activeProfileId) return profile;
        const nextColumns = { ...profile.columns };
        // Layer the recomputed delta over the keys this form does not edit, so
        // an entry field set elsewhere (an MCP-authored `planExitTarget`) is not
        // destroyed by an unrelated edit to the same column.
        const mergedEntry = { ...carryUnmappedEntryKeys(profile.columns[activeId]), ...nextEntry };
        // An empty delta means "this column matches the base in every field",
        // so drop the key entirely rather than persisting an empty object.
        if (Object.keys(mergedEntry).length === 0) delete nextColumns[activeId];
        else nextColumns[activeId] = mergedEntry;
        return { ...profile, columns: nextColumns };
      });
    });
  }, [activeId, activeProfileId, drafts]);

  
  // ── Save / cancel / delete ────────────────────────────────────────
  const requestCancel = useCallback(() => {
    if (saving) return;
    if (hasDirty) {
      setShowCancelConfirm(true);
    } else {
      onClose();
    }
  }, [saving, hasDirty, onClose]);

  const handleSave = useCallback(async () => {
    if (saving) return;

    // Validation: every new draft must have a non-empty name.
    const invalid = laneOrder.find((id) => {
      const candidate = drafts[id];
      if (!candidate) return false;
      return candidate.name.trim() === '';
    });
    if (invalid) {
      setActiveId(invalid);
      setAutoFocusNameId(invalid);
      useToastStore.getState().addToast({
        message: 'Name a column before saving.',
        variant: 'error',
      });
      return;
    }

    // The backstop for a row that never went through the Edit dialog, which is
    // the one path that can reach Save unnamed: a copy of a copy. The dialog
    // itself holds Done disabled on an empty name.
    for (const columnId of Object.keys(automationDrafts)) {
      const unnamed = findEmptyName(automationDrafts[columnId] ?? []);
      if (!unnamed) continue;
      setActiveId(columnId);
      setEditing({ columnId, rowId: unnamed.id, isNew: false });
      useToastStore.getState().addToast({ message: 'Name an automation before saving.', variant: 'error' });
      return;
    }

    const creates: string[] = [];
    const updates: string[] = [];
    for (const id of laneOrder) {
      if (newDraftIds.has(id)) {
        creates.push(id);
      } else if (isDirty(drafts[id], originals[id])) {
        updates.push(id);
      }
    }

    // `profilesDirty` is load-bearing here: profile edits live in
    // `profileDrafts`, never in `drafts`, so a profile-only change leaves the
    // three column checks false. Without it this early return closed the dialog
    // before the profile write below ever ran, silently discarding the edit.
    if (creates.length === 0 && updates.length === 0 && !orderDirty && !profilesDirty && !automationsDirty && pendingDeleteIds.size === 0) {
      onClose();
      return;
    }

    setSaving(true);

    // Per-row tracking so that on partial failure the user can retry and
    // only the still-failed rows go through the IPC again. After each
    // success we update local state (originals/drafts/newDraftIds/laneOrder)
    // so isDirty returns false for that row and newDraftIds no longer
    // contains the migrated temp id.
    let savedUpdates = 0;
    let savedCreates = 0;
    let savedDeletes = 0;
    let firstError: Error | null = null;
    // The profile list the trailing whole-array write will send. Tracked as a
    // local, not read off `profileDrafts`, because the delete loop below prunes
    // it and a setState is not visible to this same closure.
    let profilesToSave = profileDrafts;

    // Deletes run FIRST, and before the reorder below, so the final order we
    // send contains only ids the DB still has. Each id that succeeds leaves
    // `pendingDeleteIds`; ones that fail stay staged so the user can fix the
    // cause (a task moved in behind them) and re-save just those.
    for (const id of pendingDeleteIds) {
      const deletedColumnName = originals[id]?.name ?? 'column';
      try {
        await deleteSwimlane(id);
        setPendingDeleteIds((previous) => {
          if (!previous.has(id)) return previous;
          const next = new Set(previous);
          next.delete(id);
          return next;
        });
        setOriginals((previous) => {
          const next = { ...previous };
          delete next[id];
          return next;
        });
        // The main process prunes the ON-DISK profiles as part of the delete,
        // but `profileDrafts` is a mount-time snapshot that gets written back
        // WHOLE below. Without pruning it too, saving a delete together with any
        // profile edit re-writes the stale entry straight over that pruning and
        // the dangling reference survives. The local drives this save; the two
        // setStates keep the dialog honest if a later step fails and it stays
        // open for a retry.
        const prune = (list: BoardProfile[]) => pruneProfileReferencesForColumn(
          list,
          { columnId: id, columnName: deletedColumnName },
        ).profiles;
        profilesToSave = prune(profilesToSave);
        setProfileDrafts(prune);
        setProfileOriginals(prune);
        savedDeletes += 1;
      } catch (error) {
        if (!firstError) {
          firstError = error instanceof Error
            ? new Error(`Could not delete "${deletedColumnName}": ${error.message}`)
            : new Error(`Could not delete "${deletedColumnName}"`);
        }
      }
    }

    // Updates run in parallel; we materialise each result into local state
    // regardless of which other updates fail, via Promise.allSettled. We
    // pre-build the inputs with explicit narrowing so the IPC call never
    // sees an undefined draft/original even though the laneOrder filter
    // already guarantees presence.
    const updateInputs = updates.flatMap((id) => {
      const draft = drafts[id];
      const original = originals[id];
      if (!draft || !original) return [];
      return [{ id, input: buildUpdateInput(draft, original) }];
    });
    const updateResults = await Promise.allSettled(
      updateInputs.map((entry) => updateSwimlane(entry.input)),
    );
    updateInputs.forEach((entry, index) => {
      const result = updateResults[index];
      if (result.status === 'fulfilled') {
        const saved = result.value;
        setOriginals((previous) => ({ ...previous, [entry.id]: saved }));
        setDrafts((previous) => ({ ...previous, [entry.id]: saved }));
        savedUpdates += 1;
      } else if (!firstError) {
        firstError = result.reason instanceof Error ? result.reason : new Error(String(result.reason));
      }
    });

    // Creates run sequentially because we need to remap temp ids -> real ids
    // and the IPC handler appends to the end of the lane list, so a parallel
    // burst would hand us non-deterministic positions.
    const idMap = new Map<string, string>();
    for (const tempId of creates) {
      const draftToCreate = drafts[tempId];
      if (!draftToCreate) continue;
      try {
        const created = await createSwimlane(buildCreateInput(draftToCreate));
        idMap.set(tempId, created.id);
        // Migrate temp id -> real id atomically across drafts/originals/order/newDraftIds.
        setDrafts((previous) => {
          const nextDrafts = { ...previous };
          delete nextDrafts[tempId];
          nextDrafts[created.id] = created;
          return nextDrafts;
        });
        setOriginals((previous) => ({ ...previous, [created.id]: created }));
        setNewDraftIds((previous) => {
          if (!previous.has(tempId)) return previous;
          const nextSet = new Set(previous);
          nextSet.delete(tempId);
          return nextSet;
        });
        // Map tempId -> real id and dedupe: the store-sync effect can fire
        // between createSwimlane resolving (which updates swimlanes) and this
        // migration, inserting `created.id` into laneOrder. If we don't filter,
        // we'd end up with the real id in two slots after the map.
        setLaneOrder((previous) => {
          const seen = new Set<string>();
          const result: string[] = [];
          for (const id of previous) {
            const mapped = id === tempId ? created.id : id;
            if (seen.has(mapped)) continue;
            seen.add(mapped);
            result.push(mapped);
          }
          return result;
        });
        setActiveId((previous) => (previous === tempId ? created.id : previous));
        savedCreates += 1;
      } catch (error) {
        if (!firstError) {
          firstError = error instanceof Error ? error : new Error(String(error));
        }
        // Stop attempting further creates so we don't fan-out errors. The
        // user can fix the failing row and re-save; already-migrated rows
        // are no longer in newDraftIds, so they will not be re-created.
        break;
      }
    }

    // Reorder to honour the rail order when the user created columns or dragged
    // to reorder, but only for ids that exist in the DB now. Temp ids of creates
    // that failed (or were skipped after a failure above) are filtered out so we
    // don't ask the IPC to reorder ids it has never seen.
    // `savedDeletes` is in the gate so a delete-only save still renumbers: the
    // survivors would otherwise keep their old positions and read 0,1,3,4.
    //
    // This still runs when a delete FAILED above, and `finalOrder` omits that
    // lane (staging pulled it from laneOrder), so the lane keeps a stale
    // position. Left alone deliberately: render sorts by position, the next
    // successful save or config apply renumbers everything by index, and the
    // dialog stays open on the error path with the delete still staged.
    if (savedCreates > 0 || savedDeletes > 0 || orderDirty) {
      try {
        const finalOrder = laneOrder
          .map((id) => idMap.get(id) ?? id)
          .filter((id) => !id.startsWith(NEW_DRAFT_PREFIX));
        await reorderSwimlanes(finalOrder);
      } catch (error) {
        if (!firstError) {
          firstError = error instanceof Error ? error : new Error(String(error));
        }
      }
    }

    // Automations save LAST of the column writes, so a column created in this
    // same Save already has its real id to hang them on.
    let savedAutomationColumns = 0;
    if (!firstError) {
      // Re-point any rows that were drafted against a placeholder column id.
      let plannedDrafts = automationDrafts;
      for (const [tempId, realId] of idMap) plannedDrafts = remapDraftIds(plannedDrafts, tempId, realId);
      // A column staged for deletion takes its rows with it; writing them back
      // would recreate rows for a column that is gone.
      for (const deletedId of pendingDeleteIds) plannedDrafts = pruneColumnRows(plannedDrafts, deletedId);

      for (const entry of planAutomationSave(automationOriginals, plannedDrafts)) {
        try {
          await replaceAutomationsForColumn(entry.columnId, entry.automations);
          savedAutomationColumns += 1;
          setAutomationOriginals((previous) => ({
            ...previous,
            [entry.columnId]: plannedDrafts[entry.columnId] ?? [],
          }));
        } catch (error) {
          if (!firstError) {
            const columnName = drafts[entry.columnId]?.name ?? 'column';
            firstError = error instanceof Error
              ? new Error(`Could not save automations on "${columnName}": ${error.message}`)
              : new Error(`Could not save automations on "${columnName}"`);
          }
        }
      }
    }

    if (firstError) {
      const savedTotal = savedUpdates + savedCreates + savedDeletes;
      const partialParts: string[] = [];
      if (savedTotal > 0) partialParts.push(`${savedTotal} column${savedTotal > 1 ? 's' : ''}`);
      if (savedAutomationColumns > 0) partialParts.push(`automations on ${savedAutomationColumns} column${savedAutomationColumns > 1 ? 's' : ''}`);
      const partialNote = partialParts.length > 0 ? ` (saved ${partialParts.join(' and ')} before failing)` : '';
      useToastStore.getState().addToast({
        message: `${firstError.message}${partialNote}`,
        variant: 'error',
      });
      setSaving(false);
      return;
    }

    // Profiles persist AFTER the column creates above, so an entry can reference
    // a newly-created column's real uuid (the create path assigns it server-side).
    // Written whole rather than diffed: profiles live in kangentic.json with no
    // DB representation, so this array IS the source of truth. A hand-written
    // profile the user never touched round-trips unchanged, and one keyed to a
    // column this machine does not have is preserved rather than dropped.
    // `profilesToSave` rather than `profileDrafts`: a staged column delete prunes
    // that column out of the list above, and this whole-array write would
    // otherwise restore it. When nothing here is dirty we do not write at all,
    // which is correct - the delete path already pruned the on-disk copy.
    if (profilesDirty) {
      await saveBoardProfiles(profilesToSave);
      setProfileOriginals(structuredClone(profilesToSave) as BoardProfile[]);
    }

    const parts: string[] = [];
    if (savedUpdates > 0) parts.push(`Saved ${savedUpdates} column${savedUpdates > 1 ? 's' : ''}`);
    if (savedCreates > 0) parts.push(`created ${savedCreates} column${savedCreates > 1 ? 's' : ''}`);
    if (savedDeletes > 0) parts.push(`${parts.length === 0 ? 'Deleted' : 'deleted'} ${savedDeletes} column${savedDeletes > 1 ? 's' : ''}`);
    if (orderDirty) parts.push(parts.length === 0 ? 'Updated column order' : 'updated column order');
    if (profilesDirty) parts.push(parts.length === 0 ? 'Saved profiles' : 'saved profiles');
    if (savedAutomationColumns > 0) parts.push(parts.length === 0 ? 'Saved automations' : 'saved automations');
    useToastStore.getState().addToast({
      message: parts.length > 0 ? parts.join(' and ') : 'No changes to save',
      variant: 'info',
    });
    onClose();
  }, [saving, laneOrder, drafts, originals, newDraftIds, pendingDeleteIds, orderDirty, profilesDirty, profileDrafts, saveBoardProfiles, updateSwimlane, createSwimlane, deleteSwimlane, reorderSwimlanes, onClose,
    automationsDirty, automationOriginals, automationDrafts, replaceAutomationsForColumn]);

  // Cmd/Ctrl+S to save, via the central keybinding registry. Document-level,
  // bubble phase, preventDefault only - matching the original listener.
  useKeybinding('boardManager.save', () => void handleSave(), {
    target: 'document',
    stopPropagation: false,
  });

  // Reorder handler for the rail: local-only until Save. Flags the store-sync
  // effect to preserve this order (see hasLocalReorderRef above).
  const handleRailReorder = useCallback((nextOrder: string[]) => {
    hasLocalReorderRef.current = true;
    setLaneOrder(nextOrder);
  }, []);

  // Cycle the selection across [overview, ...columns] with wraparound. Bound to
  // Mod+PageDown / Mod+PageUp so it works regardless of where focus sits.
  const cycleColumn = useCallback((delta: number) => {
    setActiveId((current) => {
      const navIds = [ALL_COLUMNS_ID, ...laneOrder];
      const index = navIds.indexOf(current);
      if (index < 0) return current;
      return navIds[(index + delta + navIds.length) % navIds.length];
    });
  }, [laneOrder]);

  useKeybinding('panel.maximize', handleToggleMaximized, { capture: true });
  // Suppress column cycling while a nested modal (delete confirm, icon picker, or
  // the discard-changes confirm) is open, mirroring the Escape guard below.
  // Otherwise a cycle changes activeId behind the modal, and since the delete
  // confirm names drafts[confirmDeleteId] while handleDeletePersisted deletes
  // activeId, the confirmation can name one column and delete another.
  const columnCycleEnabled = !confirmDeleteId && !showIconPicker && !showCancelConfirm;
  useKeybinding('boardManager.nextColumn', () => cycleColumn(1), { target: 'document', stopPropagation: false, enabled: columnCycleEnabled });
  useKeybinding('boardManager.prevColumn', () => cycleColumn(-1), { target: 'document', stopPropagation: false, enabled: columnCycleEnabled });

  // Escape-to-cancel stays a hand-written listener: it is a structural dialog
  // key with conditional dismissal (suppressed while a nested confirm or picker
  // is open) and is not rebindable. See .claude/rules/keybindings-registry.md.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !showCancelConfirm && !confirmDeleteId && !showIconPicker) {
        event.preventDefault();
        requestCancel();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [requestCancel, showCancelConfirm, confirmDeleteId, showIconPicker]);

  const removeDraftLocally = useCallback((id: string) => {
    setDrafts((previous) => {
      const next = { ...previous };
      delete next[id];
      return next;
    });
    setNewDraftIds((previous) => {
      if (!previous.has(id)) return previous;
      const next = new Set(previous);
      next.delete(id);
      return next;
    });
    setLaneOrder((previous) => previous.filter((entry) => entry !== id));
    setActiveId((previous) => {
      if (previous !== id) return previous;
      const remaining = laneOrder.filter((entry) => entry !== id);
      // Fall back to the overview so an emptied selection degrades gracefully.
      return remaining[0] ?? ALL_COLUMNS_ID;
    });
  }, [laneOrder]);

  const handleDiscardNewDraft = useCallback(() => {
    if (!isNewDraft) return;
    removeDraftLocally(activeId);
  }, [isNewDraft, activeId, removeDraftLocally]);

  // Stages the removal; the IPC runs in handleSave alongside the creates and
  // updates. The task-count guard stays here so the refusal is immediate rather
  // than surfacing minutes later at save time; the repository re-checks it, so
  // this is feedback, not the authority. `originals[id]` is deliberately left in
  // place - the save path reads the name from it, and Cancel restores the column
  // by simply dropping the staged id.
  const handleDeletePersisted = useCallback(() => {
    setConfirmDeleteId(null);
    const id = activeId;
    if (!id || newDraftIds.has(id)) return;
    const name = drafts[id]?.name ?? 'column';
    const taskCount = tasks.filter((task) => task.swimlane_id === id).length;
    if (taskCount > 0) {
      useToastStore.getState().addToast({
        message: `Cannot delete "${name}". Move or delete all ${taskCount} task${taskCount > 1 ? 's' : ''} first.`,
        variant: 'error',
      });
      return;
    }
    removeDraftLocally(id);
    setPendingDeleteIds((previous) => new Set(previous).add(id));
    useToastStore.getState().addToast({
      message: `"${name}" will be removed when you save.`,
      variant: 'info',
    });
  }, [activeId, newDraftIds, tasks, drafts, removeDraftLocally]);

  // ── Rendering ─────────────────────────────────────────────────────
  if (!isOverview && !draft) {
    // Defensive: store had no swimlanes at mount. Render nothing rather than crash.
    return null;
  }

  // WIDE and SHORT, which is the shape the content actually wants. The column
  // page is three columns (two of settings cards, then automations), so width is
  // what buys layout while height only buys empty space: the tallest settings
  // column is about 400px. The old 1180 x 1236 was the opposite of both, and on a
  // desktop it stacked the columns while most of the screen sat empty.
  //
  // Height is capped rather than filled so the automations column can grow
  // DOWNWARD into its own scroll (see the column page below) instead of making
  // the whole modal taller as rows are added. A FIXED height also keeps the
  // modal stable as the user navigates between columns of differing content
  // height, rather than resizing and re-centering on every rail click.
  //
  // The maximize toggle STAYS, against the design's "always full window". That
  // decision was reasoned from a one-column settings pane needing about 814px of
  // the 919px the strip gives; the page is three columns now and its tallest
  // settings column is about 400px, so filling the strip buys empty space. The
  // toggle is how someone gets the full strip when they want it.
  // Height is sized to the TALLEST column page so nothing scrolls by default,
  // and so the space above the first card matches the space below the last.
  //
  // Measured on a non-role column, which is the worst case (To Do and Done
  // replace Agent and Conversation with one-line notices): 802px of settings
  // content, plus the body's own 28px top and bottom, needs an 858px scroll
  // area; everything outside it - the title bar, the identity header, the
  // footer - is 147px. Hence 1005, and 1010 for a few pixels of headroom
  // against a theme with taller type. Leftover slack lands BELOW the cards, so
  // any excess shows up as a bottom gap wider than the top one: at 1000px that
  // was 19px of slack reading as 28 above against 47 below.
  //
  // Re-measure this when a settings card gains a field. `88vh` still wins on a
  // short display, where a modal taller than the viewport is the wrong answer
  // whatever the content wants.
  //
  // FIXED rather than `h-auto` + `max-h`, which is the original decision and
  // still holds: a height that tracks content makes the modal resize and
  // re-centre every time the rail moves between columns of different length.
  const windowedClass = 'w-[min(2000px,92vw)] max-w-[95vw] h-[min(1010px,88vh)]';
  const { dialogClassName, backdropPositionClass, backdropClassName, contentRadiusClass } =
    maximizedDialogLayout(isMaximized, windowedClass);

  const activePosition = laneOrder.indexOf(activeId) + 1;

  // Disabled-section explanation strings (preserve the exact wording the old
  // native tooltips used, now shown inline).
  const disabledReasonFor = (label: string): string =>
    isTodoOrDone
      ? `Sessions don't run in ${draftRole === 'todo' ? 'To Do' : 'Done'} columns, so ${label} doesn't apply.`
      : `Turn on "Start an agent here" in the Agent section to enable ${label}.`;

  return (
    <>
    <BaseDialog
      onClose={onClose}
      testId="board-manager-dialog"
      className={dialogClassName}
      backdropPositionClass={backdropPositionClass}
      backdropClassName={backdropClassName}
      contentRadiusClass={contentRadiusClass}
      onHeaderDoubleClick={handleToggleMaximized}
      preventBackdropClose
      onBackdropClick={requestCancel}
      header={
        <div className="flex items-center gap-3 px-4 py-2">
          <Layers size={14} className="text-fg-muted flex-shrink-0" />
          {/* "Column Manager", which is what the codebase has called this
              surface all along (profile-commands.ts, board-profile-references.ts,
              ProfileBar.tsx, swimlane-slice.ts). Everything in it is a column: a
              profile is a per-column override set, the overview is of columns,
              and an automation belongs to exactly one column. */}
          <h3 className="text-sm font-semibold text-fg flex-1 min-w-0">Column Manager</h3>
          <MaximizeToggleButton isMaximized={isMaximized} onToggle={handleToggleMaximized} />
          <button
            type="button"
            onClick={requestCancel}
            aria-label="Close"
            className="p-1.5 text-fg-faint hover:text-fg-tertiary hover:bg-surface-hover rounded transition-colors flex-shrink-0"
          >
            <X size={16} />
          </button>
        </div>
      }
      rawBody
      footer={
        // The shared pair, so this dialog and the Edit automation dialog it
        // opens cannot drift apart again. No running unsaved count: Save
        // carries `disabled` until something is dirty, which is the same signal
        // in one fewer place, and the per-column and per-row dots already say
        // WHERE. The discard confirmation enumerates the changes.
        //
        // Save disables rather than relabels while saving, like every other
        // dialog footer: a control must not change shape when pressed.
        <DialogFooterActions
          onCancel={requestCancel}
          onConfirm={() => void handleSave()}
          confirmLabel="Save"
          confirmDisabled={saving || !hasDirty}
          confirmTestId="board-manager-save"
        />
      }
    >
      <div className="flex flex-1 min-h-[540px] overflow-hidden">
        <ColumnRail
          rows={railRows}
          activeId={activeId}
          onSelect={setActiveId}
          onSelectOverview={() => setActiveId(ALL_COLUMNS_ID)}
          onReorder={handleRailReorder}
          onAddColumn={addNewDraft}
          structureLocked={activeProfileId !== null}
          onDeleteColumn={isNewDraft ? handleDiscardNewDraft : () => setConfirmDeleteId(activeId)}
          profileBar={(
            <ProfileBar
              profiles={profileDrafts}
              activeProfileId={activeProfileId}
              onSelect={setActiveProfileId}
              onNew={() => setProfileNameDialog({ mode: 'new', value: '' })}
              onDuplicate={() => setProfileNameDialog({
                mode: 'duplicate',
                value: activeProfile ? `${activeProfile.name} copy` : '',
              })}
              onRename={() => setProfileNameDialog({ mode: 'rename', value: activeProfile?.name ?? '' })}
              onDelete={() => {
                if (!activeProfileId) return;
                setProfileDrafts((previous) => previous.filter((profile) => profile.id !== activeProfileId));
                setActiveProfileId(null);
              }}
            />
          )}
        />

        {isOverview || !draft ? (
          <ColumnsOverview rows={overviewRows} onSelect={setActiveId} />
        ) : (
          // `@container` HERE, not only on the scroller below, because a
          // container query resolves against an ANCESTOR container and never
          // against the element that declares one. The scroller declares
          // `@container` for its panes and also carries its own `@[1100px]:`
          // utilities; with no container above it those utilities matched
          // nothing, so `@[1100px]:overflow-hidden` never applied and the outer
          // stayed `overflow-y-auto` with a permanently reserved scrollbar
          // gutter - the 8px that made the page sit off-centre.
          <div className="flex-1 min-w-0 flex flex-col min-h-0 @container">
            <DetailIdentityHeader
              draft={draft}
              position={activePosition}
              total={laneOrder.length}
              profileName={activeProfile?.name ?? null}
            />

            {/* One scrollable form with sticky section headers. `@container`
                lets the section grids lay out by the pane width. A modest bottom
                pad keeps the content off the boundary so sub-pixel rounding does
                not summon a phantom 1px scrollbar. `scrollbar-gutter:stable`
                reserves the scrollbar's width always, so switching between a
                short column and a taller (scrolling) one never shifts the
                content horizontally. */}
            {/* `p-7` on all four sides, and the top inset lives HERE rather than
                on each pane, so the page has ONE number for its margin. It was
                28 left, 36 right, 16 top: the panes carried their own `pt-4`,
                and `scrollbar-gutter: stable` reserved 8px that only ever
                appeared on the right.

                The gutter is dropped from 1100px up. It exists so switching
                between a short column and a taller one cannot shift the content
                sideways, which is a real hazard while THIS element is the
                scroller. From 1100px it is `overflow-hidden` and the two panes
                scroll internally, so it reserved a gutter for a scrollbar that
                can never appear and made the page visibly off-centre. */}
            <div className="flex-1 min-h-0 min-w-0 overflow-y-auto @[1100px]:overflow-hidden p-7 @container [scrollbar-gutter:stable] @[1100px]:[scrollbar-gutter:auto]">
            <div className="flex w-full max-w-[2100px] mx-auto flex-col gap-6 @[1100px]:h-full @[1100px]:min-h-0 @[1100px]:flex-row">
            {/* One of the page's two even halves. It holds a single stacked
                column of cards, so an even split is all it needs - no internal
                gutter to compensate for. */}
            <div className="flex-1 min-w-0 @container @[1100px]:min-h-0 @[1100px]:overflow-y-auto">
            {/* All three settings cards in ONE column, which is what makes the
                page two columns rather than three.

                The width is what buys it: at two even columns a card is about
                835px, past the `@[720px]` its own field grid measures, so
                Agent pairs into Agent | Model and Effort | Permissions and
                General pairs Name | Description and Icon | Color. Three columns
                put a card at 554px, under that threshold, so every field
                stacked one per row and the Agent card ran 492px tall.

                Forcing the pair at 554px was measured and is worse than either:
                the Color swatches wrap to a second row, the "Start an agent
                here" toggle gets squeezed beside a select, and Permissions is
                left orphaned on its own row. That is the same failure design
                pass 13 recorded. */}
            {/* `gap-6` matches the gutter between this pane and the automations
                pane, so cards are separated by ONE distance whichever way they
                sit. At `gap-3` the three stacked cards read as one block with
                hairlines through it rather than as three peers. */}
            <div className="flex flex-col gap-6">
              {/* General is column IDENTITY (name, description, color, icon),
                  which is singular across profiles - editing it under a profile
                  would silently change it for every task on the board. Hidden
                  rather than disabled, so a profile view shows only what it can
                  actually change. */}
              {activeProfileId ? (
                <div className="pt-4">
                  <DisabledSectionNotice reason="Name, description, color, and icon are shared by every profile. Switch to Default to edit them." />
                </div>
              ) : (
              <SettingsSection section={SECTIONS[0]}>
              <div className={SECTION_GRID_CLASS}>
                <SettingField label="Name" className={SECTION_FULL_SPAN}>
                  <input
                    ref={nameInputRef}
                    type="text"
                    value={draft.name}
                    placeholder="Column name"
                    onChange={(event) => updateDraft((current) => ({ ...current, name: event.target.value }))}
                    onKeyDown={(event) => { if (event.key === 'Enter') void handleSave(); }}
                    data-testid="board-manager-name"
                    className="w-full bg-surface-control border border-edge-input rounded px-3 py-1.5 text-sm text-fg-tertiary placeholder-fg-muted focus:outline-none focus:border-accent"
                  />
                </SettingField>

                <SettingField
                  label="Description"
                  className={SECTION_FULL_SPAN}
                >
                  <textarea
                    value={draft.description ?? ''}
                    placeholder="What is this column for?"
                    onChange={(event) => updateDraft((current) => ({ ...current, description: event.target.value }))}
                    rows={1}
                    maxLength={1000}
                    data-testid="board-manager-description"
                    className="w-full bg-surface-control border border-edge-input rounded px-3 py-1.5 text-sm text-fg-tertiary placeholder-fg-muted focus:outline-none focus:border-accent resize-y"
                  />
                </SettingField>

                {/* Icon and Color pair on one row (a vertical divider between)
                    when the pane is wide; they stack when it is narrow. `order`
                    puts the filled Icon control first so the divider spacing is
                    even (the color swatches under-fill their cell). */}
                <div className={`${SECTION_FULL_SPAN} flex flex-col @[720px]:flex-row @[720px]:items-start gap-3 @[720px]:gap-6`}>
                  <div className="@[720px]:flex-1 min-w-0 order-3">
                <SettingField label="Color">
                  <div className="flex gap-2 flex-wrap items-center">
                    {PRESET_COLORS.map((presetColor) => {
                      const selected = draft.color.toLowerCase() === presetColor;
                      return (
                        <button
                          key={presetColor}
                          type="button"
                          onClick={() => {
                            updateDraft((current) => ({ ...current, color: presetColor }));
                            setShowCustomPicker(false);
                          }}
                          aria-label={`Color ${presetColor}${selected ? ' (selected)' : ''}`}
                          className={`w-6 h-6 rounded-full border-2 transition-all duration-200 ${
                            selected ? 'border-white/60 scale-110' : 'border-transparent hover:border-fg-faint'
                          }`}
                          style={{ backgroundColor: presetColor }}
                        />
                      );
                    })}
                    <button
                      type="button"
                      onClick={() => setShowCustomPicker((open) => !open)}
                      className={`w-7 h-7 rounded-full border-2 flex items-center justify-center transition-all duration-200 ${
                        !PRESET_COLORS.includes(draft.color.toLowerCase())
                          ? 'border-white/60 scale-110'
                          : showCustomPicker
                            ? 'border-white/60 bg-surface-control'
                            : 'border-edge-input hover:border-fg-muted bg-surface'
                      }`}
                      style={!PRESET_COLORS.includes(draft.color.toLowerCase()) ? { backgroundColor: draft.color } : undefined}
                      title="Custom color"
                      aria-label="Custom color"
                    >
                      <Palette size={12} className={!PRESET_COLORS.includes(draft.color.toLowerCase()) ? 'text-white' : 'text-fg-muted'} />
                    </button>
                  </div>
                  {showCustomPicker && (
                    <div className="mt-3 space-y-2">
                      <HexColorPicker
                        color={draft.color}
                        onChange={(nextColor) => {
                          updateDraft((current) => ({ ...current, color: nextColor }));
                          setHexInput(nextColor);
                        }}
                        className="!w-full"
                      />
                      <input
                        type="text"
                        value={hexInput}
                        onChange={(event) => {
                          const nextValue = event.target.value;
                          setHexInput(nextValue);
                          if (/^#[0-9a-fA-F]{6}$/.test(nextValue)) {
                            updateDraft((current) => ({ ...current, color: nextValue.toLowerCase() }));
                          }
                        }}
                        onBlur={() => {
                          if (!/^#[0-9a-fA-F]{6}$/.test(hexInput)) setHexInput(draft.color);
                        }}
                        aria-label="Hex color value"
                        className="w-full bg-surface-control border border-edge-input rounded px-3 py-1.5 text-sm text-fg-tertiary font-mono focus:outline-none focus:border-accent"
                        placeholder="#000000"
                        maxLength={7}
                      />
                    </div>
                  )}
                </SettingField>
                  </div>
                  <div className="hidden @[720px]:block w-px self-stretch bg-edge/50 order-2" />
                  <div className="@[720px]:flex-1 min-w-0 order-1">
                <SettingField label="Icon">
                  <button
                    type="button"
                    onClick={() => setShowIconPicker(true)}
                    data-testid="board-manager-icon"
                    aria-label={`Choose icon${draft.icon ? `: ${draft.icon}` : ''}`}
                    className="w-full flex items-center gap-2.5 bg-surface-control border border-edge-input hover:border-fg-faint rounded px-3 py-1.5 transition-colors group"
                  >
                    <div className="flex-shrink-0">
                      {(() => {
                        // getSwimlaneIcon resolves the custom icon, then the role default,
                        // and returns null rather than the undefined a two-key
                        // Record<SwimlaneRole, ...> yields for a role outside the union.
                        // Rendering that undefined is React error #130, which the root
                        // ErrorBoundary turns into a blank board.
                        const RoleIcon = getSwimlaneIcon(draft);
                        if (RoleIcon) return <RoleIcon size={14} strokeWidth={1.75} style={{ color: draft.color }} />;
                        return (
                          <div
                            className="w-2.5 h-2.5 rounded-full"
                            style={{ backgroundColor: draft.color }}
                          />
                        );
                      })()}
                    </div>
                    <span className="text-xs text-fg-tertiary flex-1 text-left truncate">
                      {draft.icon ?? (draft.role ? `Default (${draft.role})` : 'None')}
                    </span>
                    <ChevronRight size={14} className="text-fg-faint group-hover:text-fg-muted flex-shrink-0" />
                  </button>
                </SettingField>
                  </div>
                </div>

              </div>
              </SettingsSection>
              )}

              <SettingsSection section={SECTIONS[1]}>
              {isTodoOrDone ? (
                <DisabledSectionNotice reason={disabledReasonFor('Agent')} />
              ) : (
                <div className={SECTION_GRID_CLASS}>
                  {/* Auto-spawn leads the section: it gates whether the agent
                      config below is shown, so it comes first. Agent / Model and
                      Effort / Permissions then pair up as two-column rows. */}
                  <div className={SECTION_FULL_SPAN}>
                    <ToggleCard
                      label="Start an agent here"
                      description="Start an agent automatically when a task enters this column."
                      checked={draft.auto_spawn}
                      onChange={(next) => updateDraft((current) => ({ ...current, auto_spawn: next }))}
                    />
                  </div>
                  {draft.auto_spawn && (<>
                  <SettingField
                    label="Agent"
                    hint={draft.agent_override ? (
                      <ResetHint
                        title="Reset to project setting"
                        onClick={() => {
                          updateDraft((current) => {
                            let nextPermission = current.permission_mode;
                            if (current.permission_mode) {
                              const newDefault = getAgentDefaultPermission(agentList, projectDefaultAgent);
                              if (newDefault !== current.permission_mode) nextPermission = newDefault;
                            }
                            return { ...current, agent_override: null, permission_mode: nextPermission };
                          });
                        }}
                      />
                    ) : undefined}
                  >
                    <Combobox
                      value={draft.agent_override ?? ''}
                      onChange={(nextValue) => {
                        const nextAgent = nextValue || null;
                        updateDraft((current) => {
                          let nextPermission = current.permission_mode;
                          if (current.permission_mode) {
                            const resolved = resolvePermissionForAgent(agentList, nextAgent ?? projectDefaultAgent, current.permission_mode);
                            if (resolved !== current.permission_mode) nextPermission = resolved;
                          }
                          return { ...current, agent_override: nextAgent, permission_mode: nextPermission };
                        });
                      }}
                      options={agentList
                        .filter((entry) => entry.found)
                        .map((entry) => ({ value: entry.name, label: entry.displayName ?? entry.name }))}
                      placeholder={projectDefaultAgentLabel}
                      testId="column-agent-override"
                    />
                  </SettingField>

                  {supportsModelOverride && (
                    <SettingField
                      label="Model"
                      hint={draft.model_override ? (
                        <ResetHint
                          title={projectDefaultModelLabel ? 'Reset to project default' : 'Reset to agent default'}
                          onClick={() => updateDraft((current) => ({ ...current, model_override: null }))}
                        />
                      ) : undefined}
                    >
                      <div>
                        <ModelCombobox
                          value={draft.model_override ?? ''}
                          onChange={(nextValue) => updateDraft((current) => ({ ...current, model_override: nextValue }))}
                          availableModels={discoveredModels}
                          placeholder={projectDefaultModelLabel ?? 'Agent default'}
                          placeholderVariant={projectDefaultModelLabel ? 'resolved' : 'muted'}
                          testId="column-model-override"
                          onOpen={() => useConfigStore.getState().rescanModels()}
                          contextWindows={modelContextWindows}
                          modelDisplayNames={modelDisplayNames}
                        />
                      </div>
                    </SettingField>
                  )}

                  {effortLevels.length > 0 && (
                    <SettingField
                      label="Effort"
                      hint={draft.effort_override ? (
                        <ResetHint
                          title={projectDefaultEffort ? 'Reset to project default' : 'Reset to agent default'}
                          onClick={() => updateDraft((current) => ({ ...current, effort_override: null }))}
                        />
                      ) : undefined}
                    >
                      <Combobox
                        value={draft.effort_override ?? ''}
                        onChange={(nextValue) => updateDraft((current) => ({ ...current, effort_override: nextValue || null }))}
                        options={effortLevels.map((level) => ({ value: level, label: level }))}
                        placeholder={projectDefaultEffort ?? 'Agent default'}
                        placeholderVariant={projectDefaultEffort ? 'resolved' : 'muted'}
                        testId="column-effort-override"
                      />
                    </SettingField>
                  )}

                  <SettingField
                    label="Permissions"
                    hint={draft.permission_mode ? (
                      <ResetHint
                        title="Reset to project setting"
                        onClick={() => updateDraft((current) => ({ ...current, permission_mode: null }))}
                      />
                    ) : undefined}
                  >
                    <Combobox
                      value={draft.permission_mode ?? ''}
                      onChange={(nextValue) => updateDraft((current) => ({
                        ...current,
                        permission_mode: nextValue ? (nextValue as PermissionMode) : null,
                      }))}
                      options={agentPermissions.map((entry) => ({ value: entry.mode, label: entry.label }))}
                      placeholder={getPermissionLabel(agentPermissions, globalPermissionMode)}
                      testId="column-permission-mode"
                    />
                  </SettingField>

                  {draft.permission_mode === 'plan' && (
                    <SettingField
                      label="After Plan Mode"
                      className={SECTION_FULL_SPAN}
                      description="Where the task goes when the agent exits Plan mode."
                    >
                      <Select
                        value={draft.plan_exit_target_id ?? ''}
                        onChange={(event) => updateDraft((current) => ({ ...current, plan_exit_target_id: event.target.value || null }))}
                        wrapperClassName="relative"
                        className={DIALOG_SELECT_CLASS}
                        data-testid="plan-exit-target"
                      >
                        <option value="">Nowhere (stay in column)</option>
                        {laneOrder
                          .map((id) => drafts[id])
                          .filter((lane): lane is Swimlane => !!lane && lane.id !== draft.id && lane.role !== 'todo' && lane.role !== 'done' && !newDraftIds.has(lane.id))
                          .map((lane) => (
                            <option key={lane.id} value={lane.id}>{lane.name}</option>
                          ))}
                      </Select>
                    </SettingField>
                  )}
                  </>)}
                </div>
              )}
              </SettingsSection>

              <SettingsSection section={SECTIONS[2]}>
              {sessionsRunHere ? (
                <div className={SECTION_GRID_CLASS}>
                    {/* Leads the card: what the agent ARRIVES with, then which
                        session it continues. The TITLE carries the condition,
                        because the setting does nothing at all unless a move
                        changes the agent, and a title that read as unconditional
                        was the whole confusion. The description then spends
                        itself on the example and on what OFF does, which is what
                        the reader is deciding between. */}
                    <div className={SECTION_FULL_SPAN}>
                      <ToggleCard
                        label="Hand off context when the agent changes"
                        description="Codex to Claude, for example. The new agent receives the previous one's conversation instead of starting with just the task title and description."
                        checked={draft.handoff_context}
                        onChange={(next) => updateDraft((current) => ({ ...current, handoff_context: next }))}
                        info={'When a task enters this column and the assigned agent differs from the one that ran in the previous column, Kangentic injects the previous session\'s transcript as the first message, so the new agent continues with full context instead of starting from the task description alone.\n\nSame-agent moves (e.g. Claude to Claude) resume natively via the agent\'s own session id and ignore this setting.'}
                      />
                    </div>

                    {/* The description opens by naming the DEFAULT, so the norm
                        is stated rather than inferred from whichever option
                        happens to be selected. Its second sentence exists
                        because the first leaves the reader knowing what isolated
                        does and not why they would want it. */}
                    <SettingField
                      label="Session"
                      description="Columns share the main session unless you give this one its own. An isolated session is separate from the main one and starts clean on every entry, which suits an adversarial code review, or any pass that should not inherit the context of the work before it."
                      className={SECTION_FULL_SPAN}
                    >
                      <SegmentedControl
                        options={SESSION_TARGET_OPTIONS}
                        value={draft.session_target ?? 'main'}
                        onChange={(next) => updateDraft((current) => ({
                          ...current,
                          session_target: next,
                          // Snap the spawn policy to the sensible default for the
                          // chosen track. The rule is shared with the MCP column
                          // handlers so the two writers cannot drift; see
                          // src/shared/session-track.ts for why it lives there.
                          //
                          // This control no longer OFFERS the spawn strategy, but it
                          // still has to write it. Both columns are NOT NULL with a
                          // literal DEFAULT, so a stored lane always carries a
                          // concrete strategy and `resolveForceFresh`'s fallback
                          // never evaluates: leaving it untouched would strand an
                          // isolated column on `create_or_resume`, which resumes the
                          // previous pass instead of starting a fresh one.
                          session_spawn_strategy: snapSpawnStrategyToTarget(
                            current.session_target,
                            next,
                            current.session_spawn_strategy,
                          ),
                        }))}
                        quiet
                        ariaLabel="Session"
                        testId="column-session-target"
                      />
                    </SettingField>

                {/* Two controls are gone from this card, each for its own reason.
                    The message field is a `send_message` automation now, and the
                    migration moved every existing one across, so nobody arrives
                    at an empty field wondering where it went.
                    `session_spawn_strategy` is no longer OFFERED: `resolveForceFresh`
                    already derives it (isolated to fresh, main to resume), so the
                    override only reached two corners, and one of them
                    (main + always-spawn-new) RETIRES the task's session on entry,
                    losing everything the earlier columns did. The engine still
                    READS the column value, so a `kangentic.json` hand edit keeps
                    the persistent-isolated-track escape hatch. Neither leaves a
                    note in its place: standing copy explaining a one-time change
                    is paid on every open and learned once. */}
                </div>
              ) : <DisabledSectionNotice reason={disabledReasonFor('Conversation')} />}
              </SettingsSection>
            </div>
            </div>

            {/* The fourth section, on the right because a row carries a name, a
                type, a sentence and three controls and needs the width.

                SIDE BY SIDE (from 1100px) it is one of two EVEN halves, both
                `flex-1`. The width is not for the rows, which are a fixed
                amount of content: it is what puts the settings cards past the
                `@[720px]` their field grids measure, so Agent and General pair
                their fields instead of stacking them one per row.

                It used to clamp instead (`w-[clamp(340px,26%,520px)]`), which
                left it visibly narrower than the settings beside it for no gain
                the layout could show.

                STACKED (below 1100px) it takes the full width, because nothing
                is competing for it. It used to carry a `max-w-[680px]` that
                `@[1100px]:max-w-none` cleared, so that cap applied in the
                stacked case ALONE and left the card ending short of the
                settings cards above it, with dead space down its right edge. */}
            <div className="w-full shrink-0 @[1100px]:flex-1 @[1100px]:w-auto @[1100px]:min-w-0 @[1100px]:shrink @[1100px]:min-h-0 @[1100px]:overflow-y-auto">
              <AutomationsPane
                column={draft}
                drafts={rowsForColumn(draft.id)}
                readOnly={activeProfileId !== null}
                lastRunLabel={lastRunLabel}
                isDirty={(row) => {
                  const before = (automationOriginals[draft.id] ?? []).find((candidate) => candidate.id === row.id);
                  return !before || isColumnDirty([before], [row]);
                }}
                onAdd={(trigger, anchor) => setPickerOpenFor({ columnId: draft.id, trigger, anchor })}
                onEdit={(row) => setEditing({ columnId: draft.id, rowId: row.id, isNew: false })}
                onDelete={(row) => mutateRows(draft.id, (rows) => removeRow(rows, row.id))}
                onToggle={(row, enabled) => mutateRows(draft.id, (rows) => setRowEnabled(rows, row.id, enabled))}
                onReorder={(id, trigger, index) => mutateRows(draft.id, (rows) => moveRow(rows, id, trigger, index))}
              />
            </div>
            </div>
            </div>
          </div>
        )}
      </div>
    </BaseDialog>

      {pickerOpenFor && (
        <AddAutomationPicker
          anchor={pickerOpenFor.anchor}
          // The DRAFT, not the saved swimlane. Turning "Start an agent here"
          // off has to disable the Send message option in the same breath, the
          // way it disables the row's own switch: reading the saved row left
          // the picker offering a type the column could no longer run until
          // Save, which is the one moment the user is deciding what to add.
          column={drafts[pickerOpenFor.columnId] ?? draft!}
          trigger={pickerOpenFor.trigger}
          otherColumns={laneOrder
            .filter((id) => id !== pickerOpenFor.columnId && drafts[id])
            .map((id) => ({ column: drafts[id]!, drafts: rowsForColumn(id) }))
            .filter((entry) => entry.drafts.length > 0)}
          onPickType={(type: AutomationType) => {
            const created = makeNewAutomation(type, pickerOpenFor.trigger);
            mutateRows(pickerOpenFor.columnId, (rows) => appendRow(rows, created));
            // Opens straight into the dialog with the name selected: the picker
            // adds a row before it has a real name, and leaving one behind
            // called "New webhook" is the failure this avoids.
            setEditing({ columnId: pickerOpenFor.columnId, rowId: created.id, isNew: true });
            setPickerOpenFor(null);
          }}
          onPickCopy={(source: AutomationDraft) => {
            const copied = copyAutomation(
              source,
              source.trigger,
              takenNamesFor(rowsForColumn(pickerOpenFor.columnId)),
            );
            mutateRows(pickerOpenFor.columnId, (rows) => appendRow(rows, copied));
            setPickerOpenFor(null);
          }}
          onClose={() => setPickerOpenFor(null)}
        />
      )}

      {editing && (() => {
        const editingColumn = drafts[editing.columnId];
        const editingRow = rowsForColumn(editing.columnId).find((row) => row.id === editing.rowId);
        if (!editingColumn || !editingRow) return null;
        return (
          <EditAutomationDialog
            key={editing.rowId}
            draft={editingRow}
            column={editingColumn}
            isNew={editing.isNew}
            takenNames={takenNamesFor(rowsForColumn(editing.columnId), editing.rowId)}
            templatePicker={(onInsert) => <TemplateVariablePicker onInsert={onInsert} />}
            onDone={(next) => {
              mutateRows(editing.columnId, (rows) => replaceRow(rows, next));
              setEditing(null);
            }}
            onCancel={() => {
              // Cancelling a row the picker just added removes it, so a
              // half-built automation never survives the dialog.
              if (editing.isNew) mutateRows(editing.columnId, (rows) => removeRow(rows, editing.rowId));
              setEditing(null);
            }}
          />
        );
      })()}

      {showIconPicker && draft && (
        <IconPickerDialog
          selectedIcon={draft.icon}
          accentColor={draft.color}
          usedIcons={usedIcons}
          onSelect={(nextIcon) => {
            updateDraft((current) => ({ ...current, icon: nextIcon }));
            setShowIconPicker(false);
          }}
          onClose={() => setShowIconPicker(false)}
        />
      )}

      {profileNameDialog && (
        <ProfileNameDialog
          mode={profileNameDialog.mode}
          value={profileNameDialog.value}
          existingNames={profileDrafts
            .filter((profile) => profileNameDialog.mode !== 'rename' || profile.id !== activeProfileId)
            .map((profile) => profile.name)}
          // New starts with no overrides, so every column resolves to the
          // board's own settings - the synthetic "Default". Duplicate inherits
          // from the profile it is copying.
          sourceName={profileNameDialog.mode === 'duplicate' && activeProfile ? activeProfile.name : 'Default'}
          onChange={(value) => setProfileNameDialog((previous) => (previous ? { ...previous, value } : previous))}
          onCancel={() => setProfileNameDialog(null)}
          onConfirm={(name) => {
            const { mode } = profileNameDialog;
            if (mode === 'rename') {
              setProfileDrafts((previous) => previous.map((profile) => (
                profile.id === activeProfileId ? { ...profile, name } : profile
              )));
            } else {
              // Duplicate seeds from the active profile's deltas; New starts
              // empty, meaning every column inherits its own settings until the
              // user overrides one. Both get a fresh uuid so `tasks.profile_id`
              // on other machines keeps pointing at the original.
              const seed = mode === 'duplicate' && activeProfile
                ? (structuredClone(activeProfile.columns) as BoardProfile['columns'])
                : {};
              const created: BoardProfile = { id: crypto.randomUUID(), name, columns: seed };
              setProfileDrafts((previous) => [...previous, created]);
              setActiveProfileId(created.id);
            }
            setProfileNameDialog(null);
          }}
        />
      )}

      {confirmDeleteId && (
        <ConfirmDialog
          title={`Delete "${drafts[confirmDeleteId]?.name?.trim() || 'column'}"`}
          message={<>
            <p>Are you sure you want to delete this column?</p>
            <p className="text-fg-secondary bg-surface rounded px-3 py-2 truncate" title={drafts[confirmDeleteId]?.name}>
              {drafts[confirmDeleteId]?.name}
            </p>
          </>}
          confirmLabel="Delete"
          variant="danger"
          onConfirm={handleDeletePersisted}
          onCancel={() => setConfirmDeleteId(null)}
        />
      )}

      {showCancelConfirm && (
        <ConfirmDialog
          title="Discard unsaved changes?"
          variant="warning"
          confirmLabel="Discard"
          cancelLabel="Keep editing"
          message={
            <div className="space-y-2.5">
              {dirtyIds.length > 0 && (
                <>
                  <p>Closing now will discard unsaved changes in:</p>
                  <ul className="space-y-1">
                    {dirtyIds.map((id) => (
                      <li key={id} className="flex items-baseline gap-2">
                        <span className="text-fg-faint">•</span>
                        <span className="font-medium text-fg-secondary">{drafts[id]?.name?.trim() || 'Untitled column'}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {automationChangeLines.length > 0 && (
                <>
                  <p>Automations changed on:</p>
                  <ul className="space-y-1">
                    {automationChangeLines.map((line) => (
                      <li key={line} className="flex items-baseline gap-2">
                        <span className="text-fg-faint">&bull;</span>
                        <span className="font-medium text-fg-secondary">{line}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {pendingDeleteIds.size > 0 && (
                <>
                  <p>{dirtyIds.length > 0 ? 'These columns are staged for removal and will be kept:' : 'These columns are staged for removal. Discarding keeps them:'}</p>
                  <ul className="space-y-1" data-testid="board-manager-staged-removals">
                    {[...pendingDeleteIds].map((id) => (
                      <li key={id} className="flex items-baseline gap-2">
                        <span className="text-fg-faint">•</span>
                        <span className="font-medium text-fg-secondary">{originals[id]?.name?.trim() || 'Untitled column'}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {orderDirty && (
                <p className="text-fg-secondary">
                  {dirtyIds.length > 0 ? 'Column order changes will also be discarded.' : 'Your column order changes will be discarded.'}
                </p>
              )}
              {/* Profile edits live in profileDrafts, never in `drafts`, so without
                  this line a profile-only cancel showed an empty confirm body. */}
              {profilesDirty && (
                <p className="text-fg-secondary">
                  {dirtyIds.length > 0 || pendingDeleteIds.size > 0 || orderDirty
                    ? 'Board Profile changes will also be discarded.'
                    : 'Your Board Profile changes will be discarded.'}
                </p>
              )}
            </div>
          }
          onConfirm={() => {
            setShowCancelConfirm(false);
            onClose();
          }}
          onCancel={() => setShowCancelConfirm(false)}
        />
      )}
    </>
  );
}
