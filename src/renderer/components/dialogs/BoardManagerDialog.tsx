import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Layers, Sliders, Bot, Repeat, Zap, Clock, Plus,
  RotateCcw, Palette, ChevronRight, X,
} from 'lucide-react';
import { HexColorPicker } from 'react-colorful';
import { useBoardStore } from '../../stores/board-store';
import { useConfigStore } from '../../stores/config-store';
import { useProjectStore } from '../../stores/project-store';
import { useSessionStore } from '../../stores/session-store';
import { useToastStore } from '../../stores/toast-store';
import { BaseDialog } from './BaseDialog';
import { ConfirmDialog } from './ConfirmDialog';
import { IconPickerDialog } from './IconPickerDialog';
import { ModelCombobox } from './ModelCombobox';
import { Combobox } from './Combobox';
import { maximizedDialogLayout, MaximizeToggleButton } from './dialog-maximize';
import { ColumnRail, ALL_COLUMNS_ID, type RailRow } from './board-manager/ColumnRail';
import { ColumnsOverview, formatModelName, type OverviewRow } from './board-manager/ColumnsOverview';
import { Pill } from '../Pill';
import { ICON_REGISTRY, ROLE_DEFAULTS, getUsedIcons } from '../../utils/swimlane-icons';
import { Select } from '../settings/shared';
import { ToggleCard } from '../ToggleCard';
import { SegmentedControl } from '../SegmentedControl';
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
  type SessionSpawnStrategy,
  type AutoCommandMode,
  type SwimlaneCreateInput,
  type SwimlaneUpdateInput,
  type BoardProfile,
  type BoardProfileEntry,
} from '../../../shared/types';
import { ProfileBar } from './board-manager/ProfileBar';
import { ProfileNameDialog } from './board-manager/ProfileNameDialog';
import { TASK_TEMPLATE_VARS } from '../../../shared/task-template-vars';
import { pruneProfileReferencesForColumn } from '../../../shared/board-profile-references';

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
 * `Repeat` rather than `Zap` for Automation: the lightning bolt is the glyph for
 * "run immediately" on the timing control INSIDE this section, and a section
 * heading that repeats one of its own options' icons reads as if the section is
 * about that option.
 */
const SECTIONS: { id: SectionId; label: string; icon: typeof Sliders }[] = [
  { id: 'general', label: 'General', icon: Sliders },
  { id: 'agent', label: 'Agent', icon: Bot },
  { id: 'auto', label: 'Automation', icon: Repeat },
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
function SectionHeading({ section }: { section: typeof SECTIONS[number] }) {
  const SectionIcon = section.icon;
  return (
    <div
      data-testid={`board-manager-section-${section.id}`}
      className="sticky top-0 z-10 -mx-7 mt-3 px-7 pt-3 pb-2 bg-surface-raised border-t border-edge/50 flex items-center gap-2 first:mt-0 first:border-t-0"
    >
      {/* 15, not 13: at 13 these glyphs lose their interior detail against the
          12px uppercase label beside them. The label's cap height is unchanged,
          so the row's height does not move. */}
      <SectionIcon size={15} strokeWidth={1.75} className="text-fg-faint" />
      <span className="text-xs font-semibold uppercase tracking-wider text-fg-faint">{section.label}</span>
    </div>
  );
}

/** One-line inline explanation shown in place of a section's fields when it does not apply. */
function DisabledSectionNotice({ reason }: { reason: string }) {
  return <p className={`${SETTING_DESCRIPTION_CLASS} pt-3 pb-1 max-w-2xl`}>{reason}</p>;
}

/**
 * The auto-command's template-variable inserter.
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
          {TASK_TEMPLATE_VARS.map((templateVar) => (
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
const SECTION_GRID_CLASS = 'grid grid-cols-1 @[720px]:grid-cols-2 gap-x-6 gap-y-3 max-w-4xl pt-2';
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
  const autoCommandRef = useRef<HTMLTextAreaElement>(null);

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
  const hasAutoCommandDraft = Boolean(draft?.auto_command?.trim());

  const isOverview = activeId === ALL_COLUMNS_ID;

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
  const hasDirty = dirtyIds.length > 0 || orderDirty || profilesDirty || pendingDeleteIds.size > 0;

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
      }];
    });
  }, [laneOrder, drafts, originals, newDraftIds, agentList]);

  // Rows for the "All columns" overview grid, read from drafts so unsaved edits show.
  const overviewRows: OverviewRow[] = useMemo(() => {
    return laneOrder.flatMap((id) => {
      const laneDraft = drafts[id];
      if (!laneDraft) return [];
      const overrideName = laneDraft.agent_override;
      // Show the effective agent: the override's display name, or the project
      // default's (so it reads "Claude Code", not "Default"). Muted when default.
      const agentLabel = overrideName
        ? (agentList.find((agent) => agent.name === overrideName)?.displayName ?? overrideName)
        : projectDefaultAgentLabel;
      const modelOverride = laneDraft.model_override?.trim();
      return [{
        id,
        name: laneDraft.name,
        color: laneDraft.color,
        icon: laneDraft.icon,
        role: laneDraft.role,
        dirty: newDraftIds.has(id) || isDirty(laneDraft, originals[id]),
        autoSpawn: laneDraft.auto_spawn,
        agentLabel,
        agentIsDefault: !overrideName,
        modelLabel: modelOverride ? formatModelName(modelOverride) : 'Default',
        effortLabel: laneDraft.effort_override || 'Default',
        permissionLabel: laneDraft.permission_mode
          ? getPermissionLabel(DEFAULT_PERMISSIONS, laneDraft.permission_mode)
          : 'Default',
        isolated: laneDraft.session_target === 'isolated',
        hasAutoCommand: !!laneDraft.auto_command?.trim(),
      }];
    });
  }, [laneOrder, drafts, originals, newDraftIds, agentList, projectDefaultAgentLabel]);

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

  /**
   * Insert a `{{variable}}` at the auto-command textarea's cursor, restoring the
   * caret after it. The rAF is load-bearing: `updateDraft` re-renders the
   * controlled textarea, and setting the selection before that paint lands puts
   * the caret back at the end of the old value.
   */
  const insertTemplateVariable = useCallback((variable: string) => {
    const node = autoCommandRef.current;
    const current = draft?.auto_command ?? '';
    if (!node) {
      updateDraft((row) => ({ ...row, auto_command: current + variable }));
      return;
    }
    const start = node.selectionStart ?? current.length;
    const end = node.selectionEnd ?? current.length;
    updateDraft((row) => ({
      ...row,
      auto_command: current.slice(0, start) + variable + current.slice(end),
    }));
    window.requestAnimationFrame(() => {
      node.focus();
      const cursor = start + variable.length;
      node.setSelectionRange(cursor, cursor);
    });
  }, [draft?.auto_command, updateDraft]);

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
    if (creates.length === 0 && updates.length === 0 && !orderDirty && !profilesDirty && pendingDeleteIds.size === 0) {
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

    if (firstError) {
      const savedTotal = savedUpdates + savedCreates + savedDeletes;
      const partialNote = savedTotal > 0
        ? ` (saved ${savedTotal} column${savedTotal > 1 ? 's' : ''} before failing)`
        : '';
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
    useToastStore.getState().addToast({
      message: parts.length > 0 ? parts.join(' and ') : 'No changes to save',
      variant: 'info',
    });
    onClose();
  }, [saving, laneOrder, drafts, originals, newDraftIds, pendingDeleteIds, orderDirty, profilesDirty, profileDrafts, saveBoardProfiles, updateSwimlane, createSwimlane, deleteSwimlane, reorderSwimlanes, onClose]);

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

  // A single count of affected columns: those with field edits or a pending
  // create, plus any whose position changed from a reorder, plus any staged for
  // deletion. The user just wants "how many columns will change", not an
  // order-vs-options breakdown.
  const affectedIds = new Set(dirtyIds);
  for (const movedId of getReorderedColumnIds(laneOrder, originals, pendingDeleteIds)) affectedIds.add(movedId);
  for (const deletedId of pendingDeleteIds) affectedIds.add(deletedId);
  const affectedCount = affectedIds.size;
  const dirtySummary = affectedCount > 0 ? `${affectedCount} column${affectedCount === 1 ? '' : 's'} modified` : '';

  // Windowed size. Width clears the two-column container-query threshold (~720px)
  // without maximizing and fits the overview grid; shared by both views so
  // toggling to the overview never resizes the dialog. A FIXED height (capped at
  // 94vh on short screens) keeps the modal stable as the user navigates between
  // columns of differing content height: the detail pane scrolls when a column is
  // taller, and shorter columns show some empty space, rather than the whole
  // modal resizing and re-centering (which reads as jank). `max-w-[95vw]` caps
  // width on small screens, where the form falls back to a single column.
  const windowedClass = 'w-[1180px] max-w-[95vw] h-[1236px] max-h-[94vh]';
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
          <h3 className="text-sm font-semibold text-fg flex-1 min-w-0">Edit Columns</h3>
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
        <div className="flex items-center gap-3">
          <span data-testid="board-manager-dirty-summary" className="text-xs text-fg-faint mr-auto">
            {dirtySummary}
          </span>
          <button
            type="button"
            onClick={requestCancel}
            className="px-6 py-1.5 min-w-[96px] text-xs text-fg-muted hover:text-fg-secondary border border-edge-input hover:border-fg-faint rounded transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={saving || !hasDirty}
            data-testid="board-manager-save"
            className="px-6 py-1.5 min-w-[96px] text-xs font-medium bg-accent-emphasis hover:bg-accent text-accent-on rounded transition-colors disabled:opacity-50"
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
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
          <div className="flex-1 min-w-0 flex flex-col min-h-0">
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
            <div className="flex-1 overflow-y-auto px-7 pb-4 min-w-0 @container [scrollbar-gutter:stable]">
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
                <>
              <SectionHeading section={SECTIONS[0]} />
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
                  description="Shown when you hover the column header. Shared with your team via kangentic.json."
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
                        if (draft.icon) {
                          const IconComp = ICON_REGISTRY.get(draft.icon);
                          if (IconComp) return <IconComp size={14} strokeWidth={1.75} style={{ color: draft.color }} />;
                        }
                        if (draft.role) {
                          const RoleIcon = ROLE_DEFAULTS[draft.role];
                          return <RoleIcon size={14} strokeWidth={1.75} style={{ color: draft.color }} />;
                        }
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
                </>
              )}

              <SectionHeading section={SECTIONS[1]} />
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

              <SectionHeading section={SECTIONS[2]} />
              {sessionsRunHere ? (
                <div className={SECTION_GRID_CLASS}>
                    {/* Leads the section, following the order a column is actually
                        configured: what the agent ARRIVES with (prior context),
                        then which session it runs in, then what it is told to do. */}
                    <div className={SECTION_FULL_SPAN}>
                      <ToggleCard
                          label="Receive context from prior agent"
                        description="On cross-agent moves into this column, hand the previous agent's conversation to the new one."
                        checked={draft.handoff_context}
                        onChange={(next) => updateDraft((current) => ({ ...current, handoff_context: next }))}
                        info={'When a task enters this column and the assigned agent differs from the one that ran in the previous column, Kangentic injects the previous session\'s transcript as the first message, so the new agent continues with full context instead of starting from the task description alone.\n\nSame-agent moves (e.g. Claude to Claude) resume natively via the agent\'s own session id and ignore this setting.'}
                      />
                    </div>

                    <SettingField label="Session">
                      <Select
                        value={draft.session_target ?? 'main'}
                        onChange={(event) => {
                          const nextTarget = event.target.value as SessionTarget;
                          updateDraft((current) => ({
                            ...current,
                            session_target: nextTarget,
                            // Snap the spawn policy to the sensible default for the
                            // chosen track, but only when it is still at the other
                            // track's default - an explicit non-default choice is
                            // preserved. Mirrors resolveForceFresh's context-aware
                            // default (isolated => always-fresh, main => resume).
                            session_spawn_strategy:
                              nextTarget === 'isolated' && current.session_spawn_strategy === 'create_or_resume'
                                ? 'always_spawn_new'
                                : nextTarget === 'main' && current.session_spawn_strategy === 'always_spawn_new'
                                  ? 'create_or_resume'
                                  : current.session_spawn_strategy,
                          }));
                        }}
                        wrapperClassName="relative"
                        className={DIALOG_SELECT_CLASS}
                        data-testid="column-session-target"
                      >
                        <option value="main">Main session</option>
                        <option value="isolated">Isolated session</option>
                      </Select>
                    </SettingField>

                    <SettingField label="On enter">
                      <Select
                        value={draft.session_spawn_strategy ?? 'create_or_resume'}
                        onChange={(event) => updateDraft((current) => ({
                          ...current,
                          session_spawn_strategy: event.target.value as SessionSpawnStrategy,
                        }))}
                        wrapperClassName="relative"
                        className={DIALOG_SELECT_CLASS}
                        data-testid="column-session-spawn-strategy"
                      >
                        <option value="create_or_resume">Create or resume</option>
                        <option value="always_spawn_new">Always spawn new</option>
                      </Select>
                    </SettingField>

                <SettingField label="Auto-command" className={SECTION_FULL_SPAN}>
                <p className={`${SETTING_DESCRIPTION_CLASS} -mt-2 mb-2`}>
                  Runs in the agent on startup, the moment a task enters this column. Supports template variables.
                </p>
                <textarea
                  ref={autoCommandRef}
                  value={draft.auto_command ?? ''}
                  onChange={(event) => updateDraft((current) => ({ ...current, auto_command: event.target.value }))}
                  rows={1}
                  placeholder="/review {{title}}"
                  data-testid="auto-command-input"
                  className="w-full bg-surface-control border border-edge-input rounded px-3 py-1.5 text-sm text-fg-tertiary font-mono placeholder-fg-muted focus:outline-none focus:border-accent resize-y"
                />
                {/* The field's own footer row: what you can PUT in the command
                    on the left, WHEN it runs on the right. Timing was a separate
                    labelled field below, which read as a sibling setting when it
                    is really part of this one - it modifies this command and
                    means nothing without it. In the field's footer the
                    relationship needs no explaining, and the two option labels
                    say what the old "Timing" label plus its description did.

                    Disabled rather than hidden when there is no command: hiding
                    it made the form jump on the first keystroke, and left no
                    trace that the setting exists at all. */}
                <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                  <TemplateVariablePicker onInsert={insertTemplateVariable} />
                  {/* `title` on the WRAPPER, not the control: a disabled button
                      does not fire the mouse events a tooltip needs. */}
                  <span
                    title={hasAutoCommandDraft
                      ? 'Whether the command interrupts the agent or waits for it to finish what it is doing.'
                      : 'Set an auto-command to choose when it runs.'}
                  >
                    <SegmentedControl
                      ariaLabel="Auto-command timing"
                      testId="auto-command-mode"
                      disabled={!hasAutoCommandDraft}
                      value={draft.auto_command_mode}
                      onChange={(next: AutoCommandMode) => updateDraft((current) => ({
                        ...current,
                        auto_command_mode: next,
                      }))}
                      options={[
                        {
                          value: 'immediate' as const,
                          label: 'Run immediately',
                          icon: <Zap size={14} />,
                          testId: 'auto-command-mode-immediate',
                        },
                        {
                          value: 'deferred' as const,
                          label: 'Wait for current turn',
                          icon: <Clock size={14} />,
                          testId: 'auto-command-mode-deferred',
                        },
                      ]}
                    />
                  </span>
                </div>
                </SettingField>
                </div>
              ) : <DisabledSectionNotice reason={disabledReasonFor('Automation')} />}
            </div>
          </div>
        )}
      </div>
    </BaseDialog>

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
