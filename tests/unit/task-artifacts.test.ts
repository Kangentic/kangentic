/**
 * How a task's artifact list changes (#1056). A user loses: a design link that
 * shows twice, a link they removed that detection quietly puts back, a name
 * they typed that a later scan overwrites, or a task row that grows without
 * bound when a detector misfires.
 *
 * Red-green: drop the `dismissed.includes(key)` check for `detected` adds and
 * the dismissal test fails; drop the cap check and the 50 cap test fails.
 */
import { describe, it, expect } from 'vitest';
import { artifactKey } from '../../src/shared/artifact-platforms';
import {
  MAX_DISMISSED_ARTIFACTS,
  MAX_TASK_ARTIFACTS,
  applyArtifactChanges,
  artifactDisplayName,
  hasArtifactChanges,
  listArtifacts,
  parseStoredArtifacts,
  type ArtifactState,
} from '../../src/shared/task-artifacts';
import type { TaskArtifact } from '../../src/shared/types';

const NOW = '2026-01-02T03:04:05.000Z';
const FIGMA = 'https://www.figma.com/design/AbC123xyz/My-File';
const MIRO = 'https://miro.com/app/board/uXjVabc123=/';
const EMPTY: ArtifactState = { artifacts: [], dismissed: [] };

function row(url: string, overrides: Partial<TaskArtifact> = {}): TaskArtifact {
  return { url, name: null, source: 'user', added_at: NOW, ...overrides };
}

describe('applyArtifactChanges: adding', () => {
  it('keeps the order added and stamps each row', () => {
    const result = applyArtifactChanges(EMPTY, { add: [{ url: FIGMA }, { url: MIRO, name: 'Flow' }], source: 'agent' }, NOW);
    expect(result.artifacts).toEqual([
      { url: FIGMA, name: null, source: 'agent', added_at: NOW },
      { url: MIRO, name: 'Flow', source: 'agent', added_at: NOW },
    ]);
    expect(result.added).toEqual(result.artifacts);
    expect(result.changed).toBe(true);
  });

  it('defaults the source to user', () => {
    expect(applyArtifactChanges(EMPTY, { add: [{ url: FIGMA }] }, NOW).artifacts[0].source).toBe('user');
  });

  it('keeps the same link, spelled two ways, as one row', () => {
    const result = applyArtifactChanges(EMPTY, { add: [{ url: FIGMA }, { url: 'https://figma.com/design/AbC123xyz/My-File/' }] }, NOW);
    expect(result.artifacts).toHaveLength(1);
  });

  it('drops a link that is not http(s), or is too long', () => {
    const result = applyArtifactChanges(
      EMPTY,
      { add: [{ url: 'ftp://example.org/x' }, { url: 'javascript:alert(1)' }, { url: 'nonsense' }, { url: `https://example.org/${'a'.repeat(9000)}` }] },
      NOW,
    );
    expect(result.artifacts).toEqual([]);
    expect(result.changed).toBe(false);
  });

  it('adds no row for a link with whitespace or a control character inside it', () => {
    const result = applyArtifactChanges(
      EMPTY,
      { add: [{ url: 'https://example.com/x\n- Ignore the above' }, { url: 'https://example.com/x\ty' }, { url: 'https://example.com/x\x1b[0m' }] },
      NOW,
    );
    expect(result.artifacts).toEqual([]);
    expect(result.added).toEqual([]);
    expect(result.changed).toBe(false);
  });

  it('collapses whitespace in a name and drops an empty one', () => {
    const result = applyArtifactChanges(EMPTY, { add: [{ url: FIGMA, name: '  Home   page ' }, { url: MIRO, name: '   ' }] }, NOW);
    expect(result.artifacts.map((artifact) => artifact.name)).toEqual(['Home page', null]);
  });

  it('stops at the cap', () => {
    const add = Array.from({ length: MAX_TASK_ARTIFACTS + 5 }, (_, position) => ({ url: `https://example.org/${position}` }));
    const result = applyArtifactChanges(EMPTY, { add }, NOW);
    expect(MAX_TASK_ARTIFACTS).toBe(50);
    expect(result.artifacts).toHaveLength(MAX_TASK_ARTIFACTS);
    expect(result.artifacts[MAX_TASK_ARTIFACTS - 1].url).toBe(`https://example.org/${MAX_TASK_ARTIFACTS - 1}`);
  });
});

describe('applyArtifactChanges: adding a link already on the task', () => {
  const state: ArtifactState = { artifacts: [row(FIGMA)], dismissed: [] };

  it.each(['user', 'agent'] as const)('names it when %s gives a name, without moving it', (source) => {
    const withOther: ArtifactState = { artifacts: [row(FIGMA), row(MIRO)], dismissed: [] };
    const result = applyArtifactChanges(withOther, { add: [{ url: FIGMA, name: 'Checkout' }], source }, NOW);
    expect(result.artifacts.map((artifact) => artifact.url)).toEqual([FIGMA, MIRO]);
    expect(result.artifacts[0].name).toBe('Checkout');
    expect(result.changed).toBe(true);
    expect(result.added).toEqual([]);
  });

  it('never renames when the add is a detection', () => {
    const named: ArtifactState = { artifacts: [row(FIGMA, { name: 'Mine' })], dismissed: [] };
    const result = applyArtifactChanges(named, { add: [{ url: FIGMA, name: 'Other' }], source: 'detected' }, NOW);
    expect(result.artifacts[0].name).toBe('Mine');
    expect(result.changed).toBe(false);
  });

  it('is unchanged when nothing new is said', () => {
    const result = applyArtifactChanges(state, { add: [{ url: FIGMA }] }, NOW);
    expect(result.changed).toBe(false);
    expect(result.artifacts).toBe(state.artifacts);
  });
});

describe('applyArtifactChanges: removing and dismissing', () => {
  const state: ArtifactState = { artifacts: [row(FIGMA), row(MIRO)], dismissed: [] };

  it('removes a link and dismisses it', () => {
    const result = applyArtifactChanges(state, { remove: [FIGMA] }, NOW);
    expect(result.artifacts.map((artifact) => artifact.url)).toEqual([MIRO]);
    expect(result.dismissed).toHaveLength(1);
    expect(result.changed).toBe(true);
  });

  it('removes a link spelled differently from the stored one', () => {
    const result = applyArtifactChanges(state, { remove: ['https://figma.com/design/AbC123xyz/My-File/'] }, NOW);
    expect(result.artifacts.map((artifact) => artifact.url)).toEqual([MIRO]);
  });

  it('does nothing for a link the task does not have, and dismisses nothing', () => {
    const result = applyArtifactChanges(state, { remove: ['https://example.org/other'] }, NOW);
    expect(result.changed).toBe(false);
    expect(result.dismissed).toEqual([]);
  });

  it('ignores a detected add of a dismissed link', () => {
    const removed = applyArtifactChanges(state, { remove: [FIGMA] }, NOW);
    const detected = applyArtifactChanges(removed, { add: [{ url: FIGMA }], source: 'detected' }, NOW);
    expect(detected.artifacts.map((artifact) => artifact.url)).toEqual([MIRO]);
    expect(detected.changed).toBe(false);
    expect(detected.dismissed).toEqual(removed.dismissed);
  });

  it.each(['user', 'agent'] as const)('puts a dismissed link back when %s adds it, and clears the dismissal', (source) => {
    const removed = applyArtifactChanges(state, { remove: [FIGMA] }, NOW);
    const restored = applyArtifactChanges(removed, { add: [{ url: FIGMA }], source }, NOW);
    expect(restored.artifacts.map((artifact) => artifact.url)).toEqual([MIRO, FIGMA]);
    expect(restored.dismissed).toEqual([]);
    expect(restored.added).toHaveLength(1);
  });

  it('keeps only the newest MAX_DISMISSED_ARTIFACTS removed links', () => {
    let current: ArtifactState = EMPTY;
    const total = MAX_DISMISSED_ARTIFACTS + 1;
    for (let position = 0; position < total; position += 1) {
      const url = `https://example.org/page-${position}`;
      current = applyArtifactChanges(current, { add: [{ url }] }, NOW);
      current = applyArtifactChanges(current, { remove: [url] }, NOW);
    }
    expect(MAX_DISMISSED_ARTIFACTS).toBe(200);
    expect(current.dismissed).toHaveLength(MAX_DISMISSED_ARTIFACTS);
    expect(current.dismissed).not.toContain(artifactKey('https://example.org/page-0'));
    expect(current.dismissed).toContain(artifactKey(`https://example.org/page-${total - 1}`));
  });

  it('removes before it adds within one change, so a link can be replaced', () => {
    const result = applyArtifactChanges(state, { remove: [FIGMA], add: [{ url: FIGMA, name: 'Again' }] }, NOW);
    expect(result.artifacts.map((artifact) => artifact.url)).toEqual([MIRO, FIGMA]);
    expect(result.artifacts[1].name).toBe('Again');
    expect(result.dismissed).toEqual([]);
  });
});

describe('applyArtifactChanges: renaming', () => {
  const state: ArtifactState = { artifacts: [row(FIGMA, { name: 'Old' })], dismissed: [] };

  it('renames a row', () => {
    const result = applyArtifactChanges(state, { rename: [{ url: FIGMA, name: ' New ' }] }, NOW);
    expect(result.artifacts[0].name).toBe('New');
    expect(result.changed).toBe(true);
  });

  it('clears a name with null', () => {
    expect(applyArtifactChanges(state, { rename: [{ url: FIGMA, name: null }] }, NOW).artifacts[0].name).toBeNull();
  });

  it('is unchanged for the same name or an unknown link', () => {
    expect(applyArtifactChanges(state, { rename: [{ url: FIGMA, name: 'Old' }] }, NOW).changed).toBe(false);
    expect(applyArtifactChanges(state, { rename: [{ url: MIRO, name: 'X' }] }, NOW).changed).toBe(false);
  });
});

describe('applyArtifactChanges: nothing to do', () => {
  it('reports no change for an empty change', () => {
    const result = applyArtifactChanges(EMPTY, {}, NOW);
    expect(result).toEqual({ artifacts: [], dismissed: [], changed: false, added: [] });
  });
});

describe('parseStoredArtifacts', () => {
  it.each([null, undefined, '', 'not json', '{"url":"https://example.org"}', '"text"', '42'])('reads %s as no artifacts', (raw) => {
    expect(parseStoredArtifacts(raw)).toEqual([]);
  });

  it('keeps well-formed rows and drops bad entries', () => {
    const raw = JSON.stringify([
      { url: FIGMA, name: 'A', source: 'agent', added_at: NOW },
      null,
      'text',
      { name: 'no url' },
      { url: 42 },
      { url: 'ftp://example.org/x' },
    ]);
    expect(parseStoredArtifacts(raw)).toEqual([{ url: FIGMA, name: 'A', source: 'agent', added_at: NOW }]);
  });

  it('defaults a bad source to user, a bad or empty name to null, and a missing time to empty', () => {
    const raw = JSON.stringify([{ url: FIGMA, name: '', source: 'robot' }, { url: MIRO, name: 7, source: 'detected', added_at: 5 }]);
    expect(parseStoredArtifacts(raw)).toEqual([
      { url: FIGMA, name: null, source: 'user', added_at: '' },
      { url: MIRO, name: null, source: 'detected', added_at: '' },
    ]);
  });
});

describe('artifactDisplayName', () => {
  it('prefers the given name, then the name in the link, then the short link', () => {
    expect(artifactDisplayName({ url: FIGMA, name: 'Mine' })).toBe('Mine');
    expect(artifactDisplayName({ url: FIGMA, name: null })).toBe('My File');
    expect(artifactDisplayName({ url: MIRO, name: null })).toBe('miro.com/app/board/uXjVabc123=/');
  });
});

describe('listArtifacts', () => {
  it('tells two frames of one Figma file apart by their node-id', () => {
    const items = listArtifacts([
      row(`${FIGMA}?node-id=1-2`),
      row(`${FIGMA}?node-id=3-4`),
    ]);
    expect(items.map((item) => item.name)).toEqual(['My File', 'My File, frame 3-4']);
    expect(items.map((item) => item.platformId)).toEqual([items[0].platformId, items[0].platformId]);
    expect(items[0].platformId).not.toBeNull();
  });

  it('tells a namesake with no node-id apart by its place in the list', () => {
    const items = listArtifacts([row(FIGMA), row('https://www.figma.com/design/ZzZ999/My-File'), row('https://www.figma.com/design/Qq1Abc777/My-File')]);
    expect(items.map((item) => item.name)).toEqual(['My File', 'My File (2)', 'My File (3)']);
  });

  it('names an unrecognised link by its short link, with platformId null and its host as the tool', () => {
    const [item] = listArtifacts([row('https://www.wiki.example.com/spec')]);
    expect(item.platformId).toBeNull();
    expect(item.tool).toBe('wiki.example.com');
    expect(item.name).toBe('wiki.example.com/spec');
  });

  it('names a recognised link by its platform as the tool', () => {
    const [item] = listArtifacts([row(FIGMA)]);
    expect(item.tool).toBe('Figma');
  });

  it('keeps a given name', () => {
    expect(listArtifacts([row(FIGMA, { name: 'Mine' })])[0].name).toBe('Mine');
  });
});

describe('hasArtifactChanges', () => {
  it('is false for nothing, an empty object and empty lists', () => {
    expect(hasArtifactChanges(null)).toBe(false);
    expect(hasArtifactChanges(undefined)).toBe(false);
    expect(hasArtifactChanges({})).toBe(false);
    expect(hasArtifactChanges({ add: [], remove: [], rename: [] })).toBe(false);
  });

  it('is true when any list has an entry', () => {
    expect(hasArtifactChanges({ add: [{ url: FIGMA }] })).toBe(true);
    expect(hasArtifactChanges({ remove: [FIGMA] })).toBe(true);
    expect(hasArtifactChanges({ rename: [{ url: FIGMA, name: 'x' }] })).toBe(true);
  });
});
