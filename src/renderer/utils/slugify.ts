/** Max characters for a tab/badge label */
const MAX_SLUG_LENGTH = 18;

/**
 * Convert a task title into a short, readable slug for terminal tabs and
 * aggregate badges.  e.g. "Fix lint errors in auth" → "fix-lint-errors-in"
 */
export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-') // non-alphanumeric → hyphens
    .replace(/^-+|-+$/g, '')     // trim leading/trailing hyphens
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/, '');          // trim trailing hyphen after slice
}
