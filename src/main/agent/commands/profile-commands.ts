/**
 * Board Profile command handlers for the MCP surface.
 *
 * A Board Profile is a named alternate ladder of per-column strategy settings
 * (see `column-strategy.ts`). Profiles live in `kangentic.json`, not the DB, so
 * these handlers go through `context.getBoardProfiles` / `setBoardProfiles`
 * rather than a repository.
 *
 * THE AGENT-FACING KEY IS THE COLUMN NAME, NOT ITS UUID. Stored profiles key
 * their entries by swimlane uuid (a rename must not detach in-flight tasks), but
 * a uuid is useless to an agent and actively wrong across projects: the whole
 * point of "copy this board's Heavy profile into project X" is that X has its
 * own columns with their own ids. So every handler here translates names to ids
 * on write and ids back to names on read, and an unknown column name is a hard
 * error rather than a silently dropped entry.
 *
 * The three-state sparse semantics survive the round trip:
 *   - key absent  -> inherit the column's own setting
 *   - key null    -> clear to the agent default, overriding a base column pin
 *   - key present -> use this value
 * Callers express "clear" as an explicit JSON null and "inherit" by omitting the
 * key, which is exactly what the storage layer means. Never collapse the two.
 */
import { listActiveSwimlanes } from './column-resolver';
import type { BoardProfile, BoardProfileEntry } from '../../../shared/types';
import type { CommandContext, CommandHandler, CommandResponse } from './types';

/** Profile entry fields, paired with the `BoardProfileEntry` key each maps to. */
const ENTRY_FIELDS = [
  'agentOverride',
  'modelOverride',
  'effortOverride',
  'permissionMode',
  'autoCommand',
  'autoSpawn',
  'handoffContext',
  'sessionTarget',
  'sessionSpawnStrategy',
  'planExitTarget',
] as const satisfies ReadonlyArray<keyof BoardProfileEntry>;

/**
 * Resolve a profile selector (name or uuid) against the board's profiles.
 *
 * Name match is case- and whitespace-insensitive, matching the Column Manager's
 * duplicate check, so an agent that read "Heavy" out of a listing can pass it
 * back verbatim or lowercased.
 */
function findProfile(profiles: BoardProfile[], selector: string): BoardProfile | null {
  const trimmed = selector.trim();
  const byId = profiles.find((profile) => profile.id === trimmed);
  if (byId) return byId;
  const normalized = trimmed.toLowerCase();
  return profiles.find((profile) => profile.name.trim().toLowerCase() === normalized) ?? null;
}

/**
 * Turn a task's `profile` selector (name or id) into a stored profile id.
 *
 * Shared with create_task / update_task so an agent uses one vocabulary
 * everywhere. An unknown selector is an explicit error rather than a silent
 * fall back to Default: a typo would otherwise create a task that looks tiered
 * and runs on the plain board settings.
 */
export function resolveProfileSelector(
  context: CommandContext,
  selector: string,
): { ok: true; profileId: string } | { ok: false; error: string } {
  const profiles = context.getBoardProfiles();
  const match = findProfile(profiles, selector);
  if (match) return { ok: true, profileId: match.id };
  const available = profiles.map((profile) => profile.name).join(', ') || '(none defined)';
  return {
    ok: false,
    error: `No Board Profile matches "${selector}". This board's profiles: ${available}.`
      + ' Omit `profile` to use Default (every column uses its own settings).',
  };
}

/** `name -> id` and `id -> name` for the board's active columns. */
function buildColumnMaps(context: CommandContext): {
  idByName: Map<string, string>;
  nameById: Map<string, string>;
  names: string[];
} {
  const swimlanes = listActiveSwimlanes(context.getProjectDb());
  const idByName = new Map<string, string>();
  const nameById = new Map<string, string>();
  for (const swimlane of swimlanes) {
    idByName.set(swimlane.name.trim().toLowerCase(), swimlane.id);
    nameById.set(swimlane.id, swimlane.name);
  }
  return { idByName, nameById, names: swimlanes.map((swimlane) => swimlane.name) };
}

/**
 * Translate a caller's `{ "Planning": { modelOverride: "opus" } }` into the
 * uuid-keyed stored shape, preserving key presence so "inherit" and "clear"
 * stay distinct.
 *
 * Returns an error for any column name the board does not have. Silently
 * dropping it would produce a profile that looks saved and does nothing - the
 * exact failure a cross-project copy is most likely to hit, and the one most
 * likely to be mistaken for the feature not working.
 */
function translateColumnsToIds(
  rawColumns: Record<string, Record<string, unknown>>,
  context: CommandContext,
): { ok: true; columns: Record<string, BoardProfileEntry> } | { ok: false; error: string } {
  const { idByName, names } = buildColumnMaps(context);
  const columns: Record<string, BoardProfileEntry> = {};

  for (const [columnName, rawEntry] of Object.entries(rawColumns)) {
    const swimlaneId = idByName.get(columnName.trim().toLowerCase());
    if (!swimlaneId) {
      return {
        ok: false,
        error: `Unknown column "${columnName}". This board's columns are: ${names.join(', ')}.`
          + ' Profile entries are keyed by column name; nothing was saved.',
      };
    }
    const entry: Record<string, unknown> = {};
    for (const field of ENTRY_FIELDS) {
      // Key PRESENCE, not truthiness: an explicit null means "clear this
      // column's base pin to the agent default" and must survive.
      if (Object.prototype.hasOwnProperty.call(rawEntry, field)) {
        entry[field] = rawEntry[field];
      }
    }
    if (Object.keys(entry).length > 0) {
      columns[swimlaneId] = entry as BoardProfileEntry;
    }
  }

  return { ok: true, columns };
}

/** Render a stored profile with its column keys back as names, dropping entries for deleted columns. */
function renderProfile(profile: BoardProfile, nameById: Map<string, string>): {
  id: string;
  name: string;
  description?: string;
  columns: Record<string, BoardProfileEntry>;
} {
  const columns: Record<string, BoardProfileEntry> = {};
  for (const [swimlaneId, entry] of Object.entries(profile.columns ?? {})) {
    const columnName = nameById.get(swimlaneId);
    // A column deleted since the profile was written leaves an entry no name
    // can address. Omitting it keeps the listing honest about what will apply.
    if (columnName) columns[columnName] = entry;
  }
  return {
    id: profile.id,
    name: profile.name,
    ...(profile.description ? { description: profile.description } : {}),
    columns,
  };
}

export const handleListBoardProfiles: CommandHandler = (
  _params: Record<string, unknown>,
  context: CommandContext,
): CommandResponse => {
  const { nameById } = buildColumnMaps(context);
  const profiles = context.getBoardProfiles();
  return {
    success: true,
    data: profiles.map((profile) => renderProfile(profile, nameById)),
  };
};

export const handleCreateBoardProfile: CommandHandler = (
  params: Record<string, unknown>,
  context: CommandContext,
): CommandResponse => {
  const name = String(params.name ?? '').trim();
  if (!name) return { success: false, error: 'Profile name is required.' };

  const profiles = context.getBoardProfiles();
  if (findProfile(profiles, name)) {
    return { success: false, error: `A profile named "${name}" already exists on this board. Profile names must be unique.` };
  }

  const rawColumns = (params.columns ?? {}) as Record<string, Record<string, unknown>>;
  const translated = translateColumnsToIds(rawColumns, context);
  if (!translated.ok) return { success: false, error: translated.error };

  const description = params.description as string | null;
  const created: BoardProfile = {
    // Left blank so setBoardProfiles assigns the uuid, keeping id generation in
    // one place rather than duplicating crypto.randomUUID() per call site.
    id: '',
    name,
    ...(description ? { description } : {}),
    columns: translated.columns,
  };

  context.setBoardProfiles([...profiles, created]);
  const saved = findProfile(context.getBoardProfiles(), name);
  return {
    success: true,
    data: { id: saved?.id ?? null, name, columns: Object.keys(rawColumns) },
    message: `Created profile "${name}".`,
  };
};

export const handleUpdateBoardProfile: CommandHandler = (
  params: Record<string, unknown>,
  context: CommandContext,
): CommandResponse => {
  const selector = String(params.profile ?? '').trim();
  if (!selector) return { success: false, error: 'A profile name or id is required.' };

  const profiles = context.getBoardProfiles();
  const target = findProfile(profiles, selector);
  if (!target) {
    const available = profiles.map((profile) => profile.name).join(', ') || '(none)';
    return { success: false, error: `No profile matches "${selector}". This board's profiles: ${available}.` };
  }

  const newName = params.name as string | null;
  if (newName !== null && newName !== undefined) {
    const trimmed = newName.trim();
    if (!trimmed) return { success: false, error: 'Profile name cannot be empty.' };
    const clash = findProfile(profiles, trimmed);
    if (clash && clash.id !== target.id) {
      return { success: false, error: `A profile named "${trimmed}" already exists on this board. Profile names must be unique.` };
    }
  }

  const rawColumns = params.columns as Record<string, Record<string, unknown>> | null | undefined;
  const replaceColumns = params.replaceColumns === true;
  let nextColumns = target.columns ?? {};
  if (rawColumns) {
    const translated = translateColumnsToIds(rawColumns, context);
    if (!translated.ok) return { success: false, error: translated.error };
    // Default is a MERGE, so "change Opus 4.8 to Opus 5 in Planning" does not
    // wipe every other column's entry. `replaceColumns` is the explicit opt-in
    // for a wholesale swap (the cross-project copy case).
    nextColumns = replaceColumns
      ? translated.columns
      : { ...nextColumns, ...translated.columns };
  }

  const description = params.description as string | null | undefined;
  const updated: BoardProfile = {
    ...target,
    ...(newName ? { name: newName.trim() } : {}),
    // An explicit empty-string description clears it; undefined leaves it alone.
    ...(description !== undefined ? (description ? { description } : { description: undefined }) : {}),
    columns: nextColumns,
  };
  if (!updated.description) delete updated.description;

  context.setBoardProfiles(profiles.map((profile) => (profile.id === target.id ? updated : profile)));
  return {
    success: true,
    data: { id: target.id, name: updated.name },
    message: `Updated profile "${updated.name}".`,
  };
};

export const handleDeleteBoardProfile: CommandHandler = (
  params: Record<string, unknown>,
  context: CommandContext,
): CommandResponse => {
  const selector = String(params.profile ?? '').trim();
  if (!selector) return { success: false, error: 'A profile name or id is required.' };

  const profiles = context.getBoardProfiles();
  const target = findProfile(profiles, selector);
  if (!target) {
    const available = profiles.map((profile) => profile.name).join(', ') || '(none)';
    return { success: false, error: `No profile matches "${selector}". This board's profiles: ${available}.` };
  }

  // Tasks riding the deleted profile are NOT rewritten. `findTaskProfile`
  // degrades a dangling profile_id to the columns' own settings and warns once,
  // so the task keeps running; rewriting rows here would make a delete far more
  // destructive than it looks and could not be undone by re-creating the profile.
  const remaining = profiles.filter((profile) => profile.id !== target.id);
  context.setBoardProfiles(remaining);

  const db = context.getProjectDb();
  const ridingCount = (db
    .prepare('SELECT COUNT(*) as count FROM tasks WHERE profile_id = ?')
    .get(target.id) as { count: number } | undefined)?.count ?? 0;

  return {
    success: true,
    data: { id: target.id, name: target.name, tasksAffected: ridingCount },
    message: ridingCount > 0
      ? `Deleted profile "${target.name}". ${ridingCount} task(s) referenced it and now run each column's own settings.`
      : `Deleted profile "${target.name}".`,
  };
};
