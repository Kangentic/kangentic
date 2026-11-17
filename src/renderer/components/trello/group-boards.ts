import type { TrelloBoardSummary } from '../../../shared/types';

export interface WorkspaceGroup {
  /** The Workspace's name, or null for boards in no Workspace the token can read. */
  name: string | null;
  boards: TrelloBoardSummary[];
}

/**
 * Boards under their Workspace, in the order Trello lists them: each group sits where Trello
 * first lists one of its boards, and keeps its boards in Trello's order.
 */
export function groupBoardsByWorkspace(boards: TrelloBoardSummary[]): WorkspaceGroup[] {
  const groups: WorkspaceGroup[] = [];
  const byName = new Map<string | null, WorkspaceGroup>();
  for (const board of boards) {
    let group = byName.get(board.workspaceName);
    if (!group) {
      group = { name: board.workspaceName, boards: [] };
      byName.set(board.workspaceName, group);
      groups.push(group);
    }
    group.boards.push(board);
  }
  return groups;
}
