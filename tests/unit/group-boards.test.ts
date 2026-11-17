/**
 * groupBoardsByWorkspace in src/renderer/components/trello/group-boards.ts.
 *
 * The Import dialog's board picker shows boards under their Workspace. A user loses the order
 * Trello lists their boards in (the one they know) if groups are sorted, or loses a board if
 * interleaved ones are not folded into their group.
 */
import { describe, expect, it } from 'vitest';
import { groupBoardsByWorkspace } from '../../src/renderer/components/trello/group-boards';
import type { TrelloBoardSummary } from '../../src/shared/types';

function board(id: string, workspaceName: string | null): TrelloBoardSummary {
  return { id, shortLink: `link-${id}`, name: `Board ${id}`, url: `https://trello.com/b/link-${id}`, workspaceName };
}

describe('groupBoardsByWorkspace', () => {
  it('groups interleaved boards at the first-seen position of their Workspace, keeping Trello order inside', () => {
    const groups = groupBoardsByWorkspace([
      board('A', 'Acme'),
      board('B', null),
      board('C', 'Acme'),
      board('D', 'Marketing'),
    ]);

    expect(groups.map((group) => group.name)).toEqual(['Acme', null, 'Marketing']);
    expect(groups.map((group) => group.boards.map((entry) => entry.id))).toEqual([['A', 'C'], ['B'], ['D']]);
  });

  it('returns no groups for no boards', () => {
    expect(groupBoardsByWorkspace([])).toEqual([]);
  });
});
