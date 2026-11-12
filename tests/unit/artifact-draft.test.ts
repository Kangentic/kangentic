/**
 * The task edit form's unsaved artifact edits (#1056). A user loses: an edit
 * that undoes another one still saving a change, a name whose spaces vanish as
 * they type it ("Filter chips" saved as "Filterchips"), or a pasted line of
 * links that adds none of them.
 *
 * Red-green: trim the name in `draftRenameArtifact` and the typed-space test
 * fails; drop the cancel branch in `draftAddArtifact` and the add-back test
 * fails.
 */
import { describe, it, expect } from 'vitest';
import {
  draftAddArtifact,
  draftNameOf,
  draftRemoveArtifact,
  draftRenameArtifact,
  linksToAdd,
  previewArtifacts,
} from '../../src/renderer/components/artifacts/artifact-draft';
import { hasArtifactChanges } from '../../src/shared/task-artifacts';
import type { TaskArtifact, TaskArtifactChanges } from '../../src/shared/types';

const FIGMA = 'https://www.figma.com/design/AbC123xyz/My-File';
const MIRO = 'https://miro.com/app/board/uXjVabc123=/';
const WIKI = 'https://wiki.example.com/spec';
const NONE: TaskArtifactChanges = {};

function saved(url: string, name: string | null = null): TaskArtifact {
  return { url, name, source: 'user', added_at: '2026-01-02T03:04:05.000Z' };
}

describe('draftAddArtifact and draftRemoveArtifact', () => {
  it('leaves no change when an added link is removed again', () => {
    const added = draftAddArtifact(NONE, FIGMA);
    expect(hasArtifactChanges(added)).toBe(true);
    expect(hasArtifactChanges(draftRemoveArtifact(added, FIGMA))).toBe(false);
  });

  it('cancels a removal when the saved link is added back', () => {
    const removed = draftRemoveArtifact(NONE, FIGMA);
    expect(removed.remove).toEqual([FIGMA]);
    expect(hasArtifactChanges(draftAddArtifact(removed, FIGMA))).toBe(false);
  });

  it('treats the same link written with or without www as one', () => {
    const added = draftAddArtifact(NONE, FIGMA);
    expect(draftAddArtifact(added, 'https://figma.com/design/AbC123xyz/My-File').add).toHaveLength(1);
  });

  it('removes a link that is both saved and in the draft add, so the row leaves the preview', () => {
    const list = [saved(FIGMA)];
    const pasted = draftAddArtifact(NONE, FIGMA);
    expect(previewArtifacts(list, pasted).map((artifact) => artifact.url)).toEqual([FIGMA]);

    const removed = draftRemoveArtifact(pasted, FIGMA, list);
    expect(removed.add ?? []).toEqual([]);
    expect(removed.remove).toEqual([FIGMA]);
    expect(previewArtifacts(list, removed)).toEqual([]);
  });

  it('leaves no change when an added link that is not saved is removed, even with other saved links', () => {
    const list = [saved(MIRO)];
    const added = draftAddArtifact(NONE, FIGMA);
    const removed = draftRemoveArtifact(added, FIGMA, list);
    expect(hasArtifactChanges(removed)).toBe(false);
    expect(removed.remove ?? []).toEqual([]);
  });

  it('drops a rename of a link that is then removed', () => {
    const renamed = draftRenameArtifact(NONE, [saved(FIGMA)], FIGMA, 'Mine');
    const removed = draftRemoveArtifact(renamed, FIGMA);
    expect(removed.rename).toEqual([]);
    expect(removed.remove).toEqual([FIGMA]);
  });
});

describe('draftRenameArtifact and draftNameOf', () => {
  it('drops a rename of a saved link back to its saved name', () => {
    const list = [saved(FIGMA, 'Saved name')];
    const renamed = draftRenameArtifact(NONE, list, FIGMA, 'Other');
    expect(hasArtifactChanges(renamed)).toBe(true);
    expect(hasArtifactChanges(draftRenameArtifact(renamed, list, FIGMA, 'Saved name'))).toBe(false);
  });

  it('keeps a name as typed, so a trailing space survives a keystroke', () => {
    const list = [saved(FIGMA)];
    const typedFilter = draftRenameArtifact(NONE, list, FIGMA, 'Filter ');
    expect(draftNameOf(typedFilter, list[0])).toBe('Filter ');
    const typedChips = draftRenameArtifact(typedFilter, list, FIGMA, 'Filter chips');
    expect(draftNameOf(typedChips, list[0])).toBe('Filter chips');
  });

  it('lands a rename of a link added in this edit on the add entry', () => {
    const added = draftAddArtifact(NONE, MIRO);
    const renamed = draftRenameArtifact(added, [], MIRO, 'Flow chart');
    expect(renamed.add).toEqual([{ url: MIRO, name: 'Flow chart' }]);
    expect(renamed.rename ?? []).toEqual([]);
  });

  it('clears a name with an empty one', () => {
    const list = [saved(FIGMA, 'Saved name')];
    const cleared = draftRenameArtifact(NONE, list, FIGMA, '  ');
    expect(cleared.rename).toEqual([{ url: FIGMA, name: null }]);
    expect(draftNameOf(cleared, list[0])).toBe('');
  });

  it('reads the saved name when nothing was typed', () => {
    expect(draftNameOf(NONE, saved(FIGMA, 'Saved name'))).toBe('Saved name');
    expect(draftNameOf(NONE, saved(FIGMA))).toBe('');
  });
});

describe('previewArtifacts', () => {
  it('shows the saved links then the added ones, in order, without the removed', () => {
    const list = [saved(FIGMA), saved(MIRO)];
    const draft = draftAddArtifact(draftRemoveArtifact(NONE, FIGMA), WIKI);
    expect(previewArtifacts(list, draft).map((artifact) => artifact.url)).toEqual([MIRO, WIKI]);
  });

  it('shows saved then added in the order added', () => {
    const list = [saved(FIGMA)];
    const draft = draftAddArtifact(draftAddArtifact(NONE, MIRO), WIKI);
    expect(previewArtifacts(list, draft).map((artifact) => artifact.url)).toEqual([FIGMA, MIRO, WIKI]);
  });
});

describe('linksToAdd', () => {
  it('takes a bare link whole, fragment kept', () => {
    const link = 'https://excalidraw.com/#json=abc123,def456';
    expect(linksToAdd(`  ${link}  `)).toEqual([link]);
  });

  it('takes every link in a pasted line', () => {
    expect(linksToAdd(`see ${FIGMA} and ${MIRO}.`)).toEqual([FIGMA, MIRO]);
  });

  it('takes nothing from prose with no link, or from nothing', () => {
    expect(linksToAdd('the spec is in the wiki')).toEqual([]);
    expect(linksToAdd('   ')).toEqual([]);
  });
});
