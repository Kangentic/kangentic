/**
 * Heuristic for "is this title a placeholder that should be auto-renamed?"
 *
 * The automatic rename runs only when the title looks like the user
 * deferred picking a name (e.g. "fix bug", "wip") or never typed one. We err
 * on the side of NOT prompting: only obviously generic titles match.
 */
const PLACEHOLDER_PATTERN = /^(fix|fix bug|fix it|fixes|wip|tbd|todo|untitled|test|temp|temporary|new task|task)\s*$/i;

export function isPlaceholderTitle(title: string | null | undefined, taskId: string): boolean {
  const trimmed = (title ?? '').trim();
  if (trimmed.length === 0) return true;
  if (trimmed === taskId) return true;
  if (PLACEHOLDER_PATTERN.test(trimmed)) return true;
  return false;
}
