import type { GitLabBoardRaw } from './client';

/** The status an issue on no board list shows, and a closed one. GitLab's own column names. */
export const OPEN_STATUS = 'Open';
export const CLOSED_STATUS = 'Closed';

/**
 * The board a source's Status comes from: the board a pasted board link named,
 * else the one GitLab treats as default, first by name (case-insensitive) and
 * then by id. Undefined when the project or group has no board.
 */
export function boardForSource(boards: readonly GitLabBoardRaw[], savedBoardId?: string): GitLabBoardRaw | undefined {
  if (savedBoardId) {
    const saved = boards.find((board) => String(board.id) === savedBoardId);
    if (saved) return saved;
  }
  return [...boards].sort((first, second) => {
    const byName = (first.name ?? '').toLowerCase().localeCompare((second.name ?? '').toLowerCase());
    return byName !== 0 ? byName : first.id - second.id;
  })[0];
}

/**
 * A board's label lists, left to right. GitLab returns lists grouped by kind, so
 * they are sorted by `position` here. Assignee, milestone, iteration and status
 * lists (paid tiers) carry no label and are skipped. Open and Closed are never
 * returned as lists; the caller adds them.
 */
export function labelListsInOrder(board: GitLabBoardRaw | undefined): string[] {
  if (!board?.lists) return [];
  return board.lists
    .filter((list) => typeof list.label?.name === 'string' && list.label.name.length > 0)
    .sort((first, second) => (first.position ?? 0) - (second.position ?? 0))
    .map((list) => list.label?.name ?? '');
}

/**
 * An issue's status as the board shows it. A closed issue is Closed. An open
 * issue sits in the leftmost list whose label it carries, else in Open. The
 * order puts Open first, the lists after it left to right, and Closed last, so
 * the Import dialog's Status filter reads as the board does.
 */
export function statusFor(
  issue: { state: string; labels?: string[] },
  labelLists: readonly string[],
): { state: string; stateOrder: number } {
  if (issue.state === 'closed') return { state: CLOSED_STATUS, stateOrder: labelLists.length + 1 };
  const labels = new Set(issue.labels ?? []);
  const listIndex = labelLists.findIndex((label) => labels.has(label));
  if (listIndex >= 0) return { state: labelLists[listIndex], stateOrder: listIndex + 1 };
  return { state: OPEN_STATUS, stateOrder: 0 };
}
