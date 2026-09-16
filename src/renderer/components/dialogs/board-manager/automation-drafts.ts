/**
 * Pure draft helpers for the automations a column owns, with no React in them.
 *
 * Board setup edits a DRAFT and saves it, so every mutation here returns a new
 * list rather than touching one. Keeping it React-free is what lets the ordering,
 * naming, dirty-compare and save-planning rules be tested directly instead of
 * through a rendered dialog.
 *
 * Everything type-specific is read from `AUTOMATION_MANIFEST`, so adding an
 * automation type changes nothing in this file.
 */
import {
  AUTOMATION_MANIFEST,
  canColumnRun,
  stableAutomationTypes,
  type AutomationColumnFacts,
  type AutomationRunnability,
} from '../../../../shared/automation-manifest';
import { describeAutomation } from '../../../../shared/automation-describe';
import { TEMPLATE_VARIABLE_PATTERN } from '../../../../shared/task-template-vars';
import type {
  AutomationConfig,
  AutomationRun,
  AutomationRunStatus,
  AutomationTrigger,
  AutomationType,
  AutomationWriteInput,
  ColumnAutomation,
  Swimlane,
} from '../../../../shared/types';

/**
 * One automation in the draft. `id` carries a `new:` prefix until it is saved,
 * which is how the save planner tells an insert from an update without a
 * separate flag, and how a cancel can drop it with no trace.
 */
export interface AutomationDraft {
  id: string;
  name: string;
  type: AutomationType;
  trigger: AutomationTrigger;
  enabled: boolean;
  config: AutomationConfig;
}

export type AutomationDraftsByColumn = Record<string, AutomationDraft[]>;

export const TRIGGER_LABELS: Record<AutomationTrigger, string> = {
  enter: 'On enter',
  exit: 'On exit',
};

/** The two groups, in the order the pane stacks them. */
export const TRIGGERS: readonly AutomationTrigger[] = ['enter', 'exit'];

/**
 * A draft id no saved row can hold and no other draft can collide with.
 *
 * A module-scope counter was the obvious thing and is the wrong thing here: this
 * file sits outside `stores/` and `utils/`, so `hmr-resync.test.ts`'s
 * module-state scan never sees it, and a hot update reset it to 0 while the
 * dialog's own `automationDrafts` state survived. The next Add minted an id a
 * live draft already had, and `replaceRow` / `removeRow` resolve rows by id.
 * `makeNewDraft` on the swimlane side already mints ids this way.
 */
function newDraftId(): string {
  return `new:${crypto.randomUUID()}`;
}

export function isUnsaved(draft: AutomationDraft): boolean {
  return draft.id.startsWith('new:');
}

export function toDraft(automation: ColumnAutomation): AutomationDraft {
  return {
    id: automation.id,
    name: automation.name,
    type: automation.type,
    trigger: automation.trigger,
    enabled: automation.enabled,
    config: { ...automation.config },
  };
}

export function draftsByColumn(automations: ColumnAutomation[]): AutomationDraftsByColumn {
  const byColumn: AutomationDraftsByColumn = {};
  for (const automation of automations) {
    const list = byColumn[automation.swimlane_id] ?? [];
    list.push(toDraft(automation));
    byColumn[automation.swimlane_id] = list;
  }
  for (const list of Object.values(byColumn)) sortDrafts(list);
  return byColumn;
}

/** Group order first, then the order within the group. */
function sortDrafts(drafts: AutomationDraft[]): AutomationDraft[] {
  return drafts.sort((left, right) => {
    if (left.trigger !== right.trigger) return left.trigger === 'enter' ? -1 : 1;
    return 0;
  });
}

export function describeDraft(draft: AutomationDraft): string {
  return describeAutomation(draft.type, draft.config);
}

/** How each terminal run status reads on the row. */
const RUN_STATUS_WORDS: Record<AutomationRunStatus, string> = {
  running: 'Running now',
  succeeded: 'Ran',
  failed: 'Failed',
  skipped: 'Skipped',
  interrupted: 'Interrupted',
};

/**
 * The row's last-run line: what happened, when, and the one-line detail.
 *
 * This is what answers "did my automation work" where the automation lives,
 * rather than only in a toast the user may have missed. Returns null for a row
 * that has never run, so the caller renders nothing rather than a dash that
 * would read as an outcome.
 *
 * Takes the formatted time rather than formatting it, so this stays React-free
 * AND locale-free and can be unit tested without a clock: `formatRelativeTime`
 * reads `Date.now()` and an `Intl` locale, neither of which belongs in a pure
 * helper the parity tests run over.
 */
export function describeLastRun(run: AutomationRun | undefined, relativeTime: string): string | null {
  if (!run) return null;
  const word = RUN_STATUS_WORDS[run.status];
  const when = relativeTime ? ` ${relativeTime}` : '';
  // The detail carries the failure reason, the skip reason, or a one-line
  // success ("HTTP 204", "exit 0"), which is the half that says WHY.
  const detail = run.detail ? `. ${run.detail}` : '';
  return `${word}${when}${detail}`;
}

export function rowsFor(drafts: AutomationDraft[], trigger: AutomationTrigger): AutomationDraft[] {
  return drafts.filter((draft) => draft.trigger === trigger);
}

// --- creating ---------------------------------------------------------------

export function defaultConfigForType(type: AutomationType): AutomationConfig {
  const config: Record<string, unknown> = {};
  for (const field of AUTOMATION_MANIFEST[type].fields) {
    if (field.defaultValue !== undefined) config[field.key] = field.defaultValue;
  }
  return config as AutomationConfig;
}

export function makeNewAutomation(type: AutomationType, trigger: AutomationTrigger): AutomationDraft {
  return {
    id: newDraftId(),
    // Named for the type rather than left blank: a blank name blocks Save, and
    // the dialog opens with this selected, so the common case is to type over it.
    name: `New ${AUTOMATION_MANIFEST[type].label.toLowerCase()}`,
    type,
    trigger,
    enabled: true,
    config: defaultConfigForType(type),
  };
}

/**
 * Copy a row from another column. The copy is INDEPENDENT: a fresh id, and no
 * link back. The picker says so, because "copy" and "share" are the two things a
 * user could reasonably expect and only one of them is true here.
 */
export function copyAutomation(source: AutomationDraft, trigger: AutomationTrigger, takenNames: string[]): AutomationDraft {
  return {
    id: newDraftId(),
    name: uniqueName(source.name, takenNames),
    type: source.type,
    trigger,
    enabled: source.enabled,
    config: { ...source.config },
  };
}

function uniqueName(wanted: string, taken: string[]): string {
  const lowered = new Set(taken.map((name) => name.trim().toLowerCase()));
  const base = wanted.trim() || 'Automation';
  if (!lowered.has(base.toLowerCase())) return base;
  let suffix = 2;
  while (lowered.has(`${base} (${suffix})`.toLowerCase())) suffix += 1;
  return `${base} (${suffix})`;
}

// --- mutating ---------------------------------------------------------------

export function appendRow(drafts: AutomationDraft[], row: AutomationDraft): AutomationDraft[] {
  return [...drafts, row];
}

export function removeRow(drafts: AutomationDraft[], id: string): AutomationDraft[] {
  return drafts.filter((draft) => draft.id !== id);
}

export function replaceRow(drafts: AutomationDraft[], row: AutomationDraft): AutomationDraft[] {
  return drafts.map((draft) => (draft.id === row.id ? row : draft));
}

export function setEnabled(drafts: AutomationDraft[], id: string, enabled: boolean): AutomationDraft[] {
  return drafts.map((draft) => (draft.id === id ? { ...draft, enabled } : draft));
}

export function setTrigger(drafts: AutomationDraft[], id: string, trigger: AutomationTrigger): AutomationDraft[] {
  const moving = drafts.find((draft) => draft.id === id);
  if (!moving || moving.trigger === trigger) return drafts;
  // Appended to the end of the destination group, which is where the eye
  // expects a row that just arrived.
  return [...drafts.filter((draft) => draft.id !== id), { ...moving, trigger }];
}

/**
 * Move a row to a new index WITHIN its group, or across into the other group.
 *
 * Index is group-relative, because that is what the user is looking at: the two
 * groups number from 1 independently, and a drag across the heading is a trigger
 * change plus a position.
 */
export function moveRow(
  drafts: AutomationDraft[],
  id: string,
  trigger: AutomationTrigger,
  indexInGroup: number,
): AutomationDraft[] {
  const moving = drafts.find((draft) => draft.id === id);
  if (!moving) return drafts;

  const others = drafts.filter((draft) => draft.id !== id);
  const destination = others.filter((draft) => draft.trigger === trigger);
  const clamped = Math.max(0, Math.min(indexInGroup, destination.length));
  destination.splice(clamped, 0, { ...moving, trigger });

  const otherGroup = trigger === 'enter' ? 'exit' : 'enter';
  const untouched = others.filter((draft) => draft.trigger === otherGroup);
  return trigger === 'enter' ? [...destination, ...untouched] : [...untouched, ...destination];
}

/**
 * Where a dropped row lands, from the row it was dropped ON.
 *
 * Pure and here rather than inline in the pane because the arithmetic is the
 * kind that looks right and is wrong in one direction only. Taking the index
 * from the group with the ACTIVE row already filtered out gave 0 of `[Second]`
 * when First was dragged onto Second, which put First back in front of it: a
 * downward drag reordered nothing, while an upward one worked, so the bug hid
 * behind half the gesture. The fix is `arrayMove`'s own contract, the target's
 * index in the group as it stands.
 *
 * The same expression is right for a drop ACROSS the heading, where the
 * destination group never held the active row: the index is then the target's
 * own and the row lands in front of it.
 *
 * `overId` of null (dropped on a group rather than a row) appends.
 */
export function dropIndexFor(
  drafts: AutomationDraft[],
  trigger: AutomationTrigger,
  overId: string | null,
): number {
  const group = rowsFor(drafts, trigger);
  if (overId === null) return group.length;
  const index = group.findIndex((draft) => draft.id === overId);
  return index < 0 ? group.length : index;
}

// --- naming -----------------------------------------------------------------

/**
 * The name that collides with `name` on this column, or null.
 *
 * Trimmed and case-insensitive, matching the unique index the database now
 * carries. The dialog folds with JavaScript's `toLowerCase`, which is full
 * Unicode, while SQLite's NOCASE is ASCII only, so the dialog rejects a superset
 * of what the index would. That is the safe direction.
 */
export function findNameConflict(
  // Narrowed to what this reads, so the Edit dialog can hand it a bare list of
  // taken names without casting a two-key literal to a full draft.
  drafts: Pick<AutomationDraft, 'id' | 'name'>[],
  name: string,
  exceptId?: string,
): string | null {
  const wanted = name.trim().toLowerCase();
  if (!wanted) return null;
  const clash = drafts.find((draft) => draft.id !== exceptId && draft.name.trim().toLowerCase() === wanted);
  return clash ? clash.name : null;
}

/** The first row with no name, for the Save-time backstop that opens the dialog on it. */
export function findEmptyName(drafts: AutomationDraft[]): AutomationDraft | null {
  return drafts.find((draft) => draft.name.trim() === '') ?? null;
}

export function takenNamesFor(drafts: AutomationDraft[], exceptId?: string): string[] {
  return drafts.filter((draft) => draft.id !== exceptId).map((draft) => draft.name);
}

// --- runnability and counts -------------------------------------------------

export function columnFacts(column: Pick<Swimlane, 'auto_spawn' | 'role'>): AutomationColumnFacts {
  return { autoSpawn: column.auto_spawn, role: column.role };
}

export function canRunRow(draft: AutomationDraft, column: Pick<Swimlane, 'auto_spawn' | 'role'>): AutomationRunnability {
  return canColumnRun(draft.type, columnFacts(column), draft.trigger);
}

/** Every row, by group. What EXISTS. */
export function automationCounts(drafts: AutomationDraft[]): { enter: number; exit: number } {
  return {
    enter: rowsFor(drafts, 'enter').length,
    exit: rowsFor(drafts, 'exit').length,
  };
}

/**
 * What will actually RUN, by group: enabled AND runnable on this column.
 *
 * This is the number the rail, the board glyph and the All columns table all
 * show, so a column can never read one thing in one place and another somewhere
 * else. A switched-off or blocked row is visible and fixable on the column page,
 * which is one click away; it does not belong in a count that answers "what
 * happens when a task moves".
 */
export function runnableAutomationCounts(
  drafts: AutomationDraft[],
  column: Pick<Swimlane, 'auto_spawn' | 'role'>,
): { enter: number; exit: number } {
  const runnable = drafts.filter((draft) => draft.enabled && canRunRow(draft, column).ok);
  return {
    enter: rowsFor(runnable, 'enter').length,
    exit: rowsFor(runnable, 'exit').length,
  };
}

/** The rows a count covers, for the tooltip that names them. */
export function runnableRows(
  drafts: AutomationDraft[],
  column: Pick<Swimlane, 'auto_spawn' | 'role'>,
  trigger: AutomationTrigger,
): AutomationDraft[] {
  return rowsFor(drafts, trigger).filter((draft) => draft.enabled && canRunRow(draft, column).ok);
}

// --- dirty compare and saving -----------------------------------------------

/**
 * The comparable form of one row: sorted keys, and no key whose value carries no
 * meaning. Without the pruning, a draft that gained `url: ''` by being briefly a
 * webhook would read as dirty forever.
 */
export function serializeAutomation(draft: AutomationDraft): string {
  const declared = new Set(AUTOMATION_MANIFEST[draft.type].fields.map((field) => field.key));
  const config: Record<string, unknown> = {};
  for (const key of Object.keys(draft.config).sort()) {
    if (!declared.has(key)) continue;
    const value = (draft.config as Record<string, unknown>)[key];
    if (value === undefined || value === null || value === '') continue;
    if (typeof value === 'object' && Object.keys(value as object).length === 0) continue;
    config[key] = value;
  }
  return JSON.stringify({ name: draft.name.trim(), type: draft.type, trigger: draft.trigger, enabled: draft.enabled, config });
}

function serializeList(drafts: AutomationDraft[]): string {
  return drafts.map(serializeAutomation).join('\n');
}

export function isColumnDirty(original: AutomationDraft[] | undefined, next: AutomationDraft[] | undefined): boolean {
  return serializeList(original ?? []) !== serializeList(next ?? []);
}

export function dirtyColumnIds(
  originals: AutomationDraftsByColumn,
  drafts: AutomationDraftsByColumn,
): string[] {
  const columnIds = new Set([...Object.keys(originals), ...Object.keys(drafts)]);
  return [...columnIds].filter((columnId) => isColumnDirty(originals[columnId], drafts[columnId]));
}

export function countAutomationChanges(
  originals: AutomationDraftsByColumn,
  drafts: AutomationDraftsByColumn,
): number {
  return dirtyColumnIds(originals, drafts).length;
}

/**
 * One line per changed column, for the discard confirmation. That dialog is the
 * ONE place changes are enumerated, which is why the footer carries no running
 * readout.
 */
export function describeAutomationChanges(
  originals: AutomationDraftsByColumn,
  drafts: AutomationDraftsByColumn,
  columnName: (columnId: string) => string,
): string[] {
  return dirtyColumnIds(originals, drafts).map((columnId) => {
    const before = originals[columnId] ?? [];
    const after = drafts[columnId] ?? [];
    if (after.length > before.length) return `${columnName(columnId)}: added ${after.length - before.length} automation(s)`;
    if (after.length < before.length) return `${columnName(columnId)}: removed ${before.length - after.length} automation(s)`;
    return `${columnName(columnId)}: edited automations`;
  });
}

/** The whole-column writes a Save should send. Untouched columns are skipped. */
export function planAutomationSave(
  originals: AutomationDraftsByColumn,
  drafts: AutomationDraftsByColumn,
): Array<{ columnId: string; automations: AutomationWriteInput[] }> {
  return dirtyColumnIds(originals, drafts).map((columnId) => ({
    columnId,
    automations: (drafts[columnId] ?? []).map(toWriteInput),
  }));
}

export function toWriteInput(draft: AutomationDraft): AutomationWriteInput {
  const declared = new Set(AUTOMATION_MANIFEST[draft.type].fields.map((field) => field.key));
  const config: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(draft.config)) {
    // Only the chosen type's keys are saved, so switching type in the dialog and
    // back is lossless in the draft but never writes a stray key to the database
    // or the config file.
    if (declared.has(key) && value !== undefined) config[key] = value;
  }
  return {
    // A `new:` id is renderer-local and must not reach the database, which
    // mints a real one.
    id: isUnsaved(draft) ? undefined : draft.id,
    name: draft.name.trim(),
    type: draft.type,
    trigger: draft.trigger,
    enabled: draft.enabled,
    config: config as AutomationConfig,
  };
}

/** Drop a column staged for deletion, so its rows are not saved back. */
export function pruneColumnRows(drafts: AutomationDraftsByColumn, columnId: string): AutomationDraftsByColumn {
  const next = { ...drafts };
  delete next[columnId];
  return next;
}

/**
 * Re-point drafts from a placeholder column id to the real one a create
 * returned. A column added in this same Save has a `new:` id until then.
 */
export function remapDraftIds(
  drafts: AutomationDraftsByColumn,
  fromColumnId: string,
  toColumnId: string,
): AutomationDraftsByColumn {
  if (!(fromColumnId in drafts) || fromColumnId === toColumnId) return drafts;
  const next = { ...drafts };
  next[toColumnId] = next[fromColumnId];
  delete next[fromColumnId];
  return next;
}

// --- field value helpers ----------------------------------------------------

/** Replace a selection inside a text value, returning the text and the new caret. */
export function spliceAtRange(value: string, start: number, end: number, inserted: string): { text: string; cursor: number } {
  return {
    text: value.slice(0, start) + inserted + value.slice(end),
    cursor: start + inserted.length,
  };
}

/** One run of a field's value: either plain text, or a `{{variable}}`. */
export interface TemplateSegment {
  text: string;
  /** Null for plain text; the variable's name when this run is a `{{...}}`. */
  variable: string | null;
}

/**
 * Split a value into plain runs and `{{variable}}` runs, which is what the
 * painted field renders.
 *
 * Reads `TEMPLATE_VARIABLE_PATTERN`, the same regex the interpolators
 * substitute on, so what paints as a variable and what actually resolves cannot
 * drift.
 */
export function splitTemplateSegments(value: string): TemplateSegment[] {
  const segments: TemplateSegment[] = [];
  let lastIndex = 0;
  // `matchAll` resets `lastIndex` itself, which the shared pattern's own doc
  // comment calls out: it is global and stateful, so it must never be driven
  // with a bare `.test()` or `.exec()` loop from here.
  for (const match of value.matchAll(TEMPLATE_VARIABLE_PATTERN)) {
    const start = match.index ?? 0;
    if (start > lastIndex) segments.push({ text: value.slice(lastIndex, start), variable: null });
    segments.push({ text: match[0], variable: match[1] });
    lastIndex = start + match[0].length;
  }
  if (lastIndex < value.length) segments.push({ text: value.slice(lastIndex), variable: null });
  return segments;
}

/** An open `{{` the caret sits inside, and the partial name typed so far. */
export interface TemplateVariableTrigger {
  /** What has been typed after the braces, which filters the picker. */
  query: string;
  /** Start of the `{{`, so an accepted variable replaces the braces too. */
  rangeStart: number;
  /**
   * The caret, EXTENDED through a closing `}}` when the caret sits inside a
   * variable that is already closed. Without that, picking a suggestion while
   * editing the middle of `{{title}}` writes the new name and leaves the tail
   * of the old one behind as `{{taskId}}tle}}`.
   */
  rangeEnd: number;
}

/**
 * Detect an open `{{` the caret is inside, so typing it can raise the picker.
 *
 * Deliberately NOT `detectDescriptionMentionTrigger`, which looks the same and
 * is not: that one walks back to the nearest WHITESPACE and requires the token
 * to start with `@`. Inside `echo "{{fromCol` the nearest whitespace is before
 * the quote, so it would hand back `"{{fromCol` and never match. This scans back
 * for the braces themselves, which is what makes it work mid-token, and every
 * character between them and the caret must be part of a legal name so a stray
 * `{{` earlier in the line cannot claim a caret that has since moved past
 * whitespace or a closing brace.
 *
 * Returns null for a COMPLETED `{{title}}`: the braces are closed, the variable
 * is written, and re-opening the picker there would fight the user.
 */
export function detectTemplateVariableTrigger(
  value: string,
  selectionStart: number,
  selectionEnd = selectionStart,
): TemplateVariableTrigger | null {
  if (selectionStart !== selectionEnd) return null;
  const caret = Math.max(0, Math.min(value.length, selectionStart));

  for (let index = caret - 1; index >= 1; index -= 1) {
    if (value[index] === '}') return null;
    if (value[index] === '{' && value[index - 1] === '{') {
      const query = value.slice(index + 1, caret);
      // `\w` is the same class `TEMPLATE_VARIABLE_PATTERN` substitutes on, so
      // the picker can only ever be open on something that could become a real
      // variable. Empty is legal: `{{` with nothing after it is the trigger.
      if (!/^\w*$/.test(query)) return null;
      const closing = /^(\w*)\}\}/.exec(value.slice(caret));
      return {
        query,
        rangeStart: index - 1,
        rangeEnd: closing ? caret + closing[0].length : caret,
      };
    }
    // A name cannot contain whitespace, so anything before this is a different
    // token and the caret is not inside a variable at all.
    if (/\s/.test(value[index] ?? '')) return null;
  }
  return null;
}

export function parseLineList(value: string): string[] {
  return value.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
}

export function formatLineList(lines: string[] | undefined): string {
  return (lines ?? []).join('\n');
}

/** `Name: Value` per line, which is the format the webhook Headers hint promises. */
export function parseHeaderLines(value: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of parseLineList(value)) {
    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    const name = line.slice(0, separator).trim();
    const headerValue = line.slice(separator + 1).trim();
    if (name) headers[name] = headerValue;
  }
  return headers;
}

export function formatHeaderLines(headers: Record<string, string> | undefined): string {
  return Object.entries(headers ?? {}).map(([name, value]) => `${name}: ${value}`).join('\n');
}

/** The types the picker offers, with the reason each disabled one cannot run here. */
export function pickerTypes(
  column: Pick<Swimlane, 'auto_spawn' | 'role'>,
  trigger: AutomationTrigger,
): Array<{ type: AutomationType; runnable: AutomationRunnability }> {
  return stableAutomationTypes().map((type) => ({
    type,
    runnable: canColumnRun(type, columnFacts(column), trigger),
  }));
}
