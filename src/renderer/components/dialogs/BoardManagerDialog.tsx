import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Layers, Plus, Sliders, Bot, Zap, History,
  Trash2, RotateCcw, Palette, ChevronRight, X,
} from 'lucide-react';
import { HexColorPicker } from 'react-colorful';
import { useBoardStore } from '../../stores/board-store';
import { useConfigStore } from '../../stores/config-store';
import { useProjectStore } from '../../stores/project-store';
import { useToastStore } from '../../stores/toast-store';
import { BaseDialog } from './BaseDialog';
import { ConfirmDialog } from './ConfirmDialog';
import { IconPickerDialog } from './IconPickerDialog';
import { ModelCombobox } from './ModelCombobox';
import { ICON_REGISTRY, ROLE_DEFAULTS, getUsedIcons } from '../../utils/swimlane-icons';
import { Select } from '../settings/shared';
import { ToggleCard } from '../ToggleCard';
import { useAgentCapabilityResolution } from '../../hooks/useAgentCapabilityResolution';
import { useKeybinding } from '../../hooks/useKeybinding';
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
  type SwimlaneCreateInput,
  type SwimlaneUpdateInput,
} from '../../../shared/types';

const PRESET_COLORS = [
  '#6b7280', '#ef4444', '#f43f5e', '#f97316',
  '#f59e0b', '#10b981', '#06b6d4', '#3b82f6',
  '#8b5cf6', '#ec4899',
];

const DEFAULT_COLOR = '#3b82f6';
const NEW_DRAFT_PREFIX = 'new:';

type SectionId = 'general' | 'agent' | 'auto' | 'handoff';

const SECTIONS: { id: SectionId; label: string; icon: typeof Sliders }[] = [
  { id: 'general', label: 'General', icon: Sliders },
  { id: 'agent', label: 'Agent', icon: Bot },
  { id: 'auto', label: 'Automation', icon: Zap },
  { id: 'handoff', label: 'Handoff', icon: History },
];

// Mirrors the keys in buildAutoCommandVars (agent-spawn.ts) - keep in sync so the
// chips surface exactly what the auto-command interpolation actually substitutes.
const TEMPLATE_VARIABLES = ['{{title}}', '{{description}}', '{{taskId}}', '{{worktreePath}}', '{{branchName}}'];

// ────────────────────────────────────────────────────────────────────────
// Pure helpers (exported for unit tests)
// ────────────────────────────────────────────────────────────────────────

export function isNewDraftId(id: string): boolean {
  return id.startsWith(NEW_DRAFT_PREFIX);
}

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

export function buildUpdateInput(draft: Swimlane, original: Swimlane): SwimlaneUpdateInput {
  const isTodoOrDone = original.role === 'todo' || original.role === 'done';
  const isPlanMode = draft.permission_mode === 'plan';
  return {
    id: draft.id,
    name: draft.name.trim(),
    color: draft.color,
    icon: draft.icon,
    permission_mode: isTodoOrDone ? undefined : draft.permission_mode,
    auto_spawn: isTodoOrDone ? undefined : draft.auto_spawn,
    auto_command: isTodoOrDone ? undefined : (draft.auto_command?.trim() || null),
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
    color: draft.color,
    icon: draft.icon,
    permission_mode: draft.permission_mode,
    auto_spawn: draft.auto_spawn,
    auto_command: draft.auto_command?.trim() || null,
    plan_exit_target_id: isPlanMode ? (draft.plan_exit_target_id || null) : undefined,
    agent_override: draft.agent_override || null,
    model_override: draft.model_override?.trim() || null,
    effort_override: draft.effort_override || null,
    handoff_context: draft.handoff_context,
    session_target: draft.session_target,
    session_spawn_strategy: draft.session_spawn_strategy,
  };
}

/**
 * One-line description of a column's session behavior for the chosen target +
 * spawn strategy. Mirrors the matrix that `resolveForceFresh` encodes; it does
 * not re-derive the default (the Select values are always concrete here).
 */
function describeSessionBehavior(
  target: SessionTarget,
  spawnStrategy: SessionSpawnStrategy,
): string {
  if (target === 'isolated') {
    return spawnStrategy === 'always_spawn_new'
      ? 'Runs this column on a fresh, isolated session each entry - a clean context independent of the main conversation (for example, a code review). Leaving the column resumes the main session. Pair with an Auto-command like /code-review.'
      : 'Runs this column on its own isolated session, separate from the main conversation, and resumes that session on re-entry. Leaving the column resumes the main session.';
  }
  return spawnStrategy === 'always_spawn_new'
    ? 'Restarts the main session from scratch each time a task enters this column, discarding its prior conversation.'
    : 'Continues the task\'s main session, resuming it on entry (the default).';
}

function makeNewDraft(): Swimlane {
  const id = `${NEW_DRAFT_PREFIX}${crypto.randomUUID()}`;
  return {
    id,
    name: 'New column',
    role: null,
    position: 0,
    color: DEFAULT_COLOR,
    icon: null,
    is_archived: false,
    is_ghost: false,
    permission_mode: null,
    auto_spawn: false,
    auto_command: '',
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

function SettingField({ label, description, hint, children }: {
  label: string;
  description?: string;
  hint?: React.ReactNode;
  children: React.ReactNode;
}) {
  // Field block fills the section's content width so inputs don't look
  // stranded against a wide empty gutter. `flex flex-col h-full` +
  // `mt-auto` keeps inputs aligned to the bottom of their grid cell when
  // descriptions in the same row vary in line count.
  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between gap-2">
        <label className="text-sm font-medium text-fg-secondary">{label}</label>
        {hint}
      </div>
      {description && (
        <p className="text-xs text-fg-faint mt-0.5">{description}</p>
      )}
      <div className={description ? 'mt-auto pt-2' : 'mt-2'}>{children}</div>
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

// ────────────────────────────────────────────────────────────────────────
// Main dialog
// ────────────────────────────────────────────────────────────────────────

const DIALOG_SELECT_CLASS = 'w-full appearance-none bg-surface-hover border border-edge-input rounded pl-3 pr-10 py-1.5 text-sm text-fg focus:outline-none focus:border-accent';

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
        activeSection: 'general' as SectionId,
        autoFocusNameId: draft.id as string | null,
      };
    }

    const fallbackActiveId = initialColumnId && swimlanes.some((lane) => lane.id === initialColumnId)
      ? initialColumnId
      : (baseOrder[0] ?? '');
    return {
      originals: baseOriginals,
      drafts: { ...baseOriginals },
      newDraftIds: new Set<string>(),
      laneOrder: baseOrder,
      activeId: fallbackActiveId,
      activeSection: 'general' as SectionId,
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
  const [activeSection, setActiveSection] = useState<SectionId>(initialState.activeSection);

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
  useEffect(() => { originalsRef.current = originals; });
  useEffect(() => { draftsRef.current = drafts; });

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

    const nextOriginals: Record<string, Swimlane> = {};
    for (const lane of swimlanes) nextOriginals[lane.id] = lane;
    setOriginals(nextOriginals);

    const nextDrafts: Record<string, Swimlane> = { ...previousDrafts };
    for (const lane of swimlanes) {
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

    setLaneOrder((previousOrder) => {
      const sorted = [...swimlanes].sort((a, b) => a.position - b.position).map((lane) => lane.id);
      // Preserve unsaved new drafts at their current relative positions.
      const newIds = previousOrder.filter((id) => id.startsWith(NEW_DRAFT_PREFIX));
      if (newIds.length === 0) return sorted;
      const result = [...sorted];
      // Insert each new draft just before the Done column to match the
      // existing create-then-reorder behavior.
      const doneIndex = result.findIndex((id) => swimlanes.find((lane) => lane.id === id)?.role === 'done');
      const insertAt = doneIndex >= 0 ? doneIndex : result.length;
      for (const newId of newIds) {
        if (!result.includes(newId)) result.splice(insertAt, 0, newId);
      }
      return result;
    });
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
    setActiveSection('general');
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
    if (activeSection !== 'general') return;
    const handle = window.requestAnimationFrame(() => {
      nameInputRef.current?.focus();
      nameInputRef.current?.select();
      setAutoFocusNameId(null);
    });
    return () => window.cancelAnimationFrame(handle);
  }, [autoFocusNameId, activeId, activeSection]);

  // ── Derived ────────────────────────────────────────────────────────
  const draft = drafts[activeId];
  const isNewDraft = newDraftIds.has(activeId);
  const draftRole: SwimlaneRole | null = draft?.role ?? null;
  const isTodoOrDone = draftRole === 'todo' || draftRole === 'done';

  // Agent / Automation / Handoff only apply when sessions actually run in
  // the column. They are disabled (visible but greyed out and unclickable)
  // for role-pinned To Do / Done columns and when Auto-spawn is off.
  const sessionsRunHere = !isTodoOrDone && draft?.auto_spawn === true;
  const isSectionDisabled = useCallback(
    (section: SectionId) => section !== 'general' && !sessionsRunHere,
    [sessionsRunHere],
  );

  // If the active section becomes disabled (e.g. user toggled Auto-spawn off
  // while sitting on Agent), bounce back to General automatically.
  useEffect(() => {
    if (isSectionDisabled(activeSection)) {
      setActiveSection('general');
    }
  }, [isSectionDisabled, activeSection]);

  const dirtyIds = useMemo(
    () => laneOrder.filter((id) => newDraftIds.has(id) || isDirty(drafts[id], originals[id])),
    [drafts, originals, laneOrder, newDraftIds],
  );
  const hasDirty = dirtyIds.length > 0;

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
  const agentPermissions = effectiveAgentInfo?.permissions ?? DEFAULT_PERMISSIONS;

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
    setDrafts((previous) => {
      const current = previous[activeId];
      if (!current) return previous;
      return { ...previous, [activeId]: updater(current) };
    });
  }, [activeId]);

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
      setActiveSection('general');
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

    if (creates.length === 0 && updates.length === 0) {
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
    let firstError: Error | null = null;

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

    // Reorder to honour the tab strip order, but only for ids that exist in
    // the DB now. Temp ids of creates that failed (or were skipped after a
    // failure above) are filtered out so we don't ask the IPC to reorder
    // ids it has never seen.
    if (savedCreates > 0) {
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
      const partialNote = (savedUpdates + savedCreates) > 0
        ? ` (saved ${savedUpdates + savedCreates} column${(savedUpdates + savedCreates) > 1 ? 's' : ''} before failing)`
        : '';
      useToastStore.getState().addToast({
        message: `${firstError.message}${partialNote}`,
        variant: 'error',
      });
      setSaving(false);
      return;
    }

    const parts: string[] = [];
    if (savedUpdates > 0) parts.push(`Saved ${savedUpdates} column${savedUpdates > 1 ? 's' : ''}`);
    if (savedCreates > 0) parts.push(`created ${savedCreates} column${savedCreates > 1 ? 's' : ''}`);
    useToastStore.getState().addToast({
      message: parts.join(' and '),
      variant: 'info',
    });
    onClose();
  }, [saving, laneOrder, drafts, originals, newDraftIds, updateSwimlane, createSwimlane, reorderSwimlanes, onClose]);

  // Cmd/Ctrl+S to save, via the central keybinding registry. Document-level,
  // bubble phase, preventDefault only - matching the original listener.
  useKeybinding('boardManager.save', () => void handleSave(), {
    target: 'document',
    stopPropagation: false,
  });

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
      return remaining[0] ?? '';
    });
  }, [laneOrder]);

  const handleDiscardNewDraft = useCallback(() => {
    if (!isNewDraft) return;
    removeDraftLocally(activeId);
  }, [isNewDraft, activeId, removeDraftLocally]);

  const handleDeletePersisted = useCallback(async () => {
    setConfirmDeleteId(null);
    const id = activeId;
    if (!id || newDraftIds.has(id)) return;
    const taskCount = tasks.filter((task) => task.swimlane_id === id).length;
    if (taskCount > 0) {
      const name = drafts[id]?.name ?? 'column';
      useToastStore.getState().addToast({
        message: `Cannot delete "${name}". Move or delete all ${taskCount} task${taskCount > 1 ? 's' : ''} first.`,
        variant: 'error',
      });
      return;
    }
    try {
      const name = drafts[id]?.name ?? 'column';
      await deleteSwimlane(id);
      useToastStore.getState().addToast({
        message: `Deleted column "${name}"`,
        variant: 'info',
      });
      removeDraftLocally(id);
      // Drop the original entry too.
      setOriginals((previous) => {
        const next = { ...previous };
        delete next[id];
        return next;
      });
    } catch (error) {
      useToastStore.getState().addToast({
        message: error instanceof Error ? error.message : 'Failed to delete column',
        variant: 'error',
      });
    }
  }, [activeId, newDraftIds, tasks, drafts, deleteSwimlane, removeDraftLocally]);

  // ── Tab strip / section nav keyboard ─────────────────────────────
  const handleTabStripKey = (event: React.KeyboardEvent) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const index = laneOrder.indexOf(activeId);
    if (index < 0) return;
    const delta = event.key === 'ArrowRight' ? 1 : -1;
    const nextIndex = (index + delta + laneOrder.length) % laneOrder.length;
    setActiveId(laneOrder[nextIndex]);
  };

  const handleSectionNavKey = (event: React.KeyboardEvent) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    // Walk to the next *enabled* section in the requested direction.
    const startIndex = SECTIONS.findIndex((entry) => entry.id === activeSection);
    if (startIndex < 0) return;
    const delta = event.key === 'ArrowDown' ? 1 : -1;
    for (let step = 1; step <= SECTIONS.length; step += 1) {
      const candidate = SECTIONS[(startIndex + delta * step + SECTIONS.length) % SECTIONS.length];
      if (!isSectionDisabled(candidate.id)) {
        setActiveSection(candidate.id);
        return;
      }
    }
  };

  // ── Rendering ─────────────────────────────────────────────────────
  if (!draft) {
    // Defensive: store had no swimlanes at mount. Render nothing rather than crash.
    return null;
  }

  const dirtyCount = dirtyIds.length;

  return (
    <>
    <BaseDialog
      onClose={onClose}
      testId="board-manager-dialog"
      className="w-[880px] max-w-[95vw] max-h-[90vh]"
      preventBackdropClose
      onBackdropClick={requestCancel}
      header={
        <div className="flex items-center gap-3 px-4 py-3">
          <Layers size={14} className="text-fg-muted flex-shrink-0" />
          <h3 className="text-sm font-semibold text-fg flex-1 min-w-0">Edit Columns</h3>
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
        <div className="flex justify-end gap-3">
          <button
            type="button"
            onClick={requestCancel}
            className="px-4 py-1.5 text-xs text-fg-muted hover:text-fg-secondary border border-edge-input hover:border-fg-faint rounded transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={saving || dirtyCount === 0}
            data-testid="board-manager-save"
            className="px-4 py-1.5 text-xs font-medium bg-accent-emphasis hover:bg-accent text-accent-on rounded transition-colors disabled:opacity-50"
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      }
    >
      <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
        {/* Tab strip */}
        <div
          onKeyDown={handleTabStripKey}
          className="flex bg-surface/40 border-b border-edge overflow-x-auto flex-shrink-0"
          role="tablist"
        >
          {laneOrder.map((id) => {
            const tabDraft = drafts[id];
            if (!tabDraft) return null;
            const isActive = id === activeId;
            const tabIsDirty = newDraftIds.has(id) || isDirty(tabDraft, originals[id]);
            const Icon = tabDraft.icon ? ICON_REGISTRY.get(tabDraft.icon) : (tabDraft.role ? ROLE_DEFAULTS[tabDraft.role] : null);
            return (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={isActive}
                data-testid="board-manager-tab"
                data-tab-name={originals[id]?.name ?? tabDraft.name}
                data-tab-id={id}
                onClick={() => setActiveId(id)}
                className={`relative flex items-center gap-2 px-3.5 py-3 text-xs whitespace-nowrap border-r border-edge/40 transition-colors ${
                  isActive
                    ? 'bg-surface text-fg font-medium'
                    : 'text-fg-muted hover:text-fg-secondary hover:bg-surface-hover/30'
                }`}
              >
                {Icon ? (
                  <Icon size={13} strokeWidth={1.75} style={{ color: isActive ? tabDraft.color : undefined }} className={isActive ? '' : 'text-fg-faint'} />
                ) : (
                  <span
                    className="w-2 h-2 rounded-full flex-shrink-0"
                    style={{ backgroundColor: tabDraft.color }}
                  />
                )}
                <span className="truncate max-w-[140px]">{tabDraft.name || 'Untitled'}</span>
                {tabIsDirty && (
                  <span
                    aria-label="unsaved changes"
                    data-testid="board-manager-tab-dirty"
                    className="w-1.5 h-1.5 rounded-full bg-accent flex-shrink-0"
                  />
                )}
                {isActive && (
                  <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-accent" />
                )}
              </button>
            );
          })}
          <div className="flex-1" />
          <div className="flex items-center pr-3">
            <button
              type="button"
              onClick={addNewDraft}
              data-testid="board-manager-add-column"
              className="flex items-center gap-1 px-2.5 py-1 text-xs text-fg-muted hover:text-fg bg-surface-hover/50 hover:bg-surface-hover border border-edge/60 hover:border-edge rounded-full transition-colors whitespace-nowrap"
            >
              <Plus size={12} />
              Add column
            </button>
          </div>
        </div>

        {/* Body split */}
        <div className="flex flex-1 min-h-[540px] overflow-hidden">
          {/* Section nav */}
          <div
            onKeyDown={handleSectionNavKey}
            role="tablist"
            aria-orientation="vertical"
            className="w-[170px] flex-shrink-0 py-3 px-2 bg-surface/40 border-r border-edge/60 flex flex-col"
          >
            <div className="text-[11px] uppercase tracking-wider text-fg-faint px-2 mb-1.5">Sections</div>
            <div className="flex flex-col gap-0.5">
              {SECTIONS.map((section) => {
                const isActive = section.id === activeSection;
                const isDisabled = isSectionDisabled(section.id);
                const SectionIcon = section.icon;
                const stateClasses = isDisabled
                  ? 'text-fg-disabled cursor-not-allowed'
                  : isActive
                    ? 'bg-surface-hover/50 text-fg'
                    : 'text-fg-muted hover:text-fg-secondary hover:bg-surface-hover/30';
                const iconClass = isDisabled
                  ? 'text-fg-disabled'
                  : isActive ? 'text-fg-secondary' : 'text-fg-faint';
                // Title (native tooltip) explains why a section is locked.
                // Two reasons: role-pinned columns (To Do, Done) never run
                // sessions, and Auto-spawn-off columns won't either until
                // the user opts in. Tells the user how to unlock it when
                // applicable. We avoid the HTML `disabled` attribute so
                // the tooltip still surfaces on hover.
                const disabledReason = isDisabled
                  ? isTodoOrDone
                    ? `Sessions don't run in ${draft.role === 'todo' ? 'To Do' : 'Done'} columns, so ${section.label} doesn't apply.`
                    : `Turn on Auto-spawn in General to enable ${section.label}.`
                  : undefined;
                return (
                  <button
                    key={section.id}
                    type="button"
                    role="tab"
                    aria-selected={isActive}
                    aria-disabled={isDisabled}
                    title={disabledReason}
                    data-testid={`board-manager-section-${section.id}`}
                    onClick={isDisabled ? undefined : () => setActiveSection(section.id)}
                    className={`flex items-center gap-2 w-full px-2 py-1.5 rounded text-xs transition-colors ${stateClasses}`}
                  >
                    <SectionIcon size={13} strokeWidth={1.75} className={iconClass} />
                    <span className="flex-1 text-left">{section.label}</span>
                  </button>
                );
              })}
            </div>

            {!isTodoOrDone && (
              <div className="mt-auto border-t border-edge/40 pt-2 px-0">
                <button
                  type="button"
                  onClick={isNewDraft ? handleDiscardNewDraft : () => setConfirmDeleteId(activeId)}
                  data-testid="board-manager-delete"
                  className="flex items-center gap-2 w-full px-2 py-1.5 rounded text-xs text-red-400 hover:text-red-300 hover:bg-red-500/10 transition-colors"
                >
                  <Trash2 size={13} strokeWidth={1.75} />
                  <span className="flex-1 text-left">Delete column</span>
                </button>
              </div>
            )}
          </div>

          {/* Section body */}
          <div className="flex-1 overflow-y-auto px-7 py-6 min-w-0">
            {activeSection === 'general' && (
              <div className="space-y-4">
                <SettingField label="Name">
                  <input
                    ref={nameInputRef}
                    type="text"
                    value={draft.name}
                    placeholder="Column name"
                    onChange={(event) => updateDraft((current) => ({ ...current, name: event.target.value }))}
                    onKeyDown={(event) => { if (event.key === 'Enter') void handleSave(); }}
                    data-testid="board-manager-name"
                    className="w-full bg-surface-hover border border-edge-input rounded px-3 py-1.5 text-sm text-fg placeholder-fg-faint focus:outline-none focus:border-accent"
                  />
                </SettingField>

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
                            ? 'border-white/60 bg-surface-hover'
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
                        className="w-full bg-surface-hover border border-edge-input rounded px-3 py-1.5 text-sm text-fg font-mono focus:outline-none focus:border-accent"
                        placeholder="#000000"
                        maxLength={7}
                      />
                    </div>
                  )}
                </SettingField>

                <SettingField label="Icon">
                  <button
                    type="button"
                    onClick={() => setShowIconPicker(true)}
                    data-testid="board-manager-icon"
                    aria-label={`Choose icon${draft.icon ? `: ${draft.icon}` : ''}`}
                    className="w-full flex items-center gap-2.5 bg-surface-hover border border-edge-input hover:border-fg-faint rounded px-3 py-1.5 transition-colors group"
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

                {!isTodoOrDone && (
                  <ToggleCard
                    label="Auto-spawn"
                    description="Start an agent automatically when a task enters this column."
                    checked={draft.auto_spawn}
                    onChange={(next) => updateDraft((current) => ({ ...current, auto_spawn: next }))}
                  />
                )}
              </div>
            )}

            {activeSection === 'agent' && (
              <div className="space-y-4">
                  <SettingField
                    label="Agent"
                    description="Which agent CLI to run for sessions in this column."
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
                    <Select
                      value={draft.agent_override ?? ''}
                      onChange={(event) => {
                        const nextAgent = event.target.value || null;
                        updateDraft((current) => {
                          let nextPermission = current.permission_mode;
                          if (current.permission_mode) {
                            const resolved = resolvePermissionForAgent(agentList, nextAgent ?? projectDefaultAgent, current.permission_mode);
                            if (resolved !== current.permission_mode) nextPermission = resolved;
                          }
                          return { ...current, agent_override: nextAgent, permission_mode: nextPermission };
                        });
                      }}
                      wrapperClassName="relative"
                      className={DIALOG_SELECT_CLASS}
                      data-testid="column-agent-override"
                    >
                      <option value="">{projectDefaultAgentLabel}</option>
                      {agentList
                        .filter((entry) => entry.found && entry.name !== projectDefaultAgent)
                        .map((entry) => (
                          <option key={entry.name} value={entry.name}>{entry.displayName ?? entry.name}</option>
                        ))}
                    </Select>
                  </SettingField>

                  {supportsModelOverride && (
                    <SettingField
                      label="Model"
                      description="Override the model for sessions spawned here."
                      hint={draft.model_override ? (
                        <ResetHint
                          title="Reset to agent default"
                          onClick={() => updateDraft((current) => ({ ...current, model_override: null }))}
                        />
                      ) : undefined}
                    >
                      <div>
                        <ModelCombobox
                          value={draft.model_override ?? ''}
                          onChange={(nextValue) => updateDraft((current) => ({ ...current, model_override: nextValue }))}
                          availableModels={discoveredModels}
                          placeholder="Default"
                          testId="column-model-override"
                        />
                      </div>
                    </SettingField>
                  )}

                  {effortLevels.length > 0 && (
                    <SettingField
                      label="Effort"
                      description="Reasoning effort budget. Higher costs more tokens."
                      hint={draft.effort_override ? (
                        <ResetHint
                          title="Reset to agent default"
                          onClick={() => updateDraft((current) => ({ ...current, effort_override: null }))}
                        />
                      ) : undefined}
                    >
                      <Select
                        value={draft.effort_override ?? ''}
                        onChange={(event) => updateDraft((current) => ({ ...current, effort_override: event.target.value || null }))}
                        wrapperClassName="relative"
                        className={DIALOG_SELECT_CLASS}
                        data-testid="column-effort-override"
                      >
                        <option value="">Default</option>
                        {effortLevels.map((level) => (
                          <option key={level} value={level}>{level}</option>
                        ))}
                      </Select>
                    </SettingField>
                  )}

                  <SettingField
                    label="Permissions"
                    description="How the agent handles tool approvals in this column."
                    hint={draft.permission_mode ? (
                      <ResetHint
                        title="Reset to project setting"
                        onClick={() => updateDraft((current) => ({ ...current, permission_mode: null }))}
                      />
                    ) : undefined}
                  >
                    <Select
                      value={draft.permission_mode ?? ''}
                      onChange={(event) => updateDraft((current) => ({
                        ...current,
                        permission_mode: event.target.value ? (event.target.value as PermissionMode) : null,
                      }))}
                      wrapperClassName="relative"
                      className={DIALOG_SELECT_CLASS}
                      data-testid="column-permission-mode"
                    >
                      <option value="">{getPermissionLabel(agentPermissions, globalPermissionMode)}</option>
                      {agentPermissions
                        .filter((entry) => entry.mode !== globalPermissionMode)
                        .map((entry) => (
                          <option key={entry.mode} value={entry.mode}>{entry.label}</option>
                        ))}
                    </Select>
                  </SettingField>

                  {draft.permission_mode === 'plan' && (
                    <SettingField
                      label="After Plan Mode"
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
              </div>
            )}

            {activeSection === 'auto' && (
              <div className="space-y-5">
                <div>
                  <div className="grid grid-cols-2 gap-4">
                    <SettingField
                      label="Session"
                      description="Which session track a task runs on here."
                    >
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

                    <SettingField
                      label="On enter"
                      description="Resume the session or start fresh."
                    >
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
                  </div>
                  <p className="text-xs text-fg-faint mt-2">
                    {describeSessionBehavior(draft.session_target ?? 'main', draft.session_spawn_strategy ?? 'create_or_resume')}
                  </p>
                </div>

                <SettingField label="Auto-command">
                <p className="text-xs text-fg-faint -mt-2 mb-2">
                  Runs in the agent on startup, the moment a task enters this column. Supports template variables.
                </p>
                <textarea
                  ref={autoCommandRef}
                  value={draft.auto_command ?? ''}
                  onChange={(event) => updateDraft((current) => ({ ...current, auto_command: event.target.value }))}
                  rows={3}
                  placeholder="/review {{title}}"
                  data-testid="auto-command-input"
                  className="w-full bg-surface-hover border border-edge-input rounded px-3 py-1.5 text-sm text-fg font-mono placeholder-fg-faint focus:outline-none focus:border-accent resize-y"
                />
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {TEMPLATE_VARIABLES.map((variable) => (
                    <button
                      key={variable}
                      type="button"
                      onClick={() => {
                        const node = autoCommandRef.current;
                        const current = draft.auto_command ?? '';
                        if (node) {
                          const start = node.selectionStart ?? current.length;
                          const end = node.selectionEnd ?? current.length;
                          const next = current.slice(0, start) + variable + current.slice(end);
                          updateDraft((row) => ({ ...row, auto_command: next }));
                          window.requestAnimationFrame(() => {
                            node.focus();
                            const cursor = start + variable.length;
                            node.setSelectionRange(cursor, cursor);
                          });
                        } else {
                          updateDraft((row) => ({ ...row, auto_command: current + variable }));
                        }
                      }}
                      className="text-[11px] font-mono px-1.5 py-0.5 rounded bg-surface-hover/40 text-fg-muted hover:text-fg border border-edge/40 hover:border-edge transition-colors"
                    >
                      {variable}
                    </button>
                  ))}
                </div>
                </SettingField>
              </div>
            )}

            {activeSection === 'handoff' && (
              <div className="space-y-5">
                <ToggleCard
                  label="Receive context from prior agent"
                  description="On cross-agent moves into this column, hand the previous agent's conversation to the new one."
                  checked={draft.handoff_context}
                  onChange={(next) => updateDraft((current) => ({ ...current, handoff_context: next }))}
                />

                <div className="border-t border-edge/50 pt-4 max-w-md space-y-3">
                  <div className="text-[11px] uppercase tracking-wider text-fg-faint">How it works</div>
                  <p className="text-xs text-fg-muted leading-relaxed">
                    When a task moves into this column and the agent assigned here is different from the one that ran in the previous column, Kangentic injects the previous session's transcript as the first message to the new agent.
                  </p>
                  <p className="text-xs text-fg-muted leading-relaxed">
                    The new agent reads it like a continuation of the conversation and picks up with full awareness of what was already tried, decided, and produced. Without passthrough, every cross-agent move resets the new agent's working memory and it starts from the task description alone.
                  </p>
                  <p className="text-xs text-fg-faint leading-relaxed">
                    Same-agent moves (e.g. Claude to Claude) always resume natively via the agent's own session id and ignore this setting.
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </BaseDialog>

      {showIconPicker && (
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

      {confirmDeleteId && (
        <ConfirmDialog
          title="Delete column"
          message={<>
            <p>Are you sure you want to delete this column?</p>
            <p className="text-fg-secondary bg-surface rounded px-3 py-2 truncate" title={drafts[confirmDeleteId]?.name}>
              {drafts[confirmDeleteId]?.name}
            </p>
          </>}
          confirmLabel="Delete"
          variant="danger"
          onConfirm={() => void handleDeletePersisted()}
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
              <p>Closing now will discard unsaved changes in:</p>
              <ul className="space-y-1">
                {dirtyIds.map((id) => (
                  <li key={id} className="flex items-baseline gap-2">
                    <span className="text-fg-faint">•</span>
                    <span className="font-medium text-fg-secondary">{drafts[id]?.name?.trim() || 'Untitled column'}</span>
                  </li>
                ))}
              </ul>
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
