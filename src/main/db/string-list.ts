/**
 * A stored JSON list of strings (a task's labels, skipped columns, dismissed
 * artifact links). A leaf module, so a migration can read one without
 * importing a repository, which would close an import cycle through
 * `database.ts`.
 */
export function parseStringList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
  } catch {
    // report-ok: an unreadable stored list reads as empty, the same as a missing one, and the next write replaces it
    return [];
  }
}
