import { describe, it, expect } from 'vitest';
import {
  parseModelId,
  groupModelIds,
  parseModelFamily,
  compareModelVersion,
  resolveModelSelector,
  resolveSpacedModelName,
  resolveEffortSelector,
  planModelPickerRows,
  newerModelFor,
} from '../../src/shared/model-id';

describe('parseModelId', () => {
  it('passes through ids with no recognized suffix', () => {
    for (const id of ['opus', 'claude-opus-4-8', 'gpt-5-mini', 'gemini-2.5-pro']) {
      expect(parseModelId(id)).toEqual({
        id,
        baseId: id,
        isOneMillionVariant: false,
        datedSnapshot: null,
      });
    }
  });

  it('strips a trailing [1m] suffix and flags the variant', () => {
    expect(parseModelId('claude-opus-4-8[1m]')).toEqual({
      id: 'claude-opus-4-8[1m]',
      baseId: 'claude-opus-4-8',
      isOneMillionVariant: true,
      datedSnapshot: null,
    });
  });

  it('strips a trailing dated suffix and captures the date', () => {
    expect(parseModelId('claude-haiku-4-5-20251001')).toEqual({
      id: 'claude-haiku-4-5-20251001',
      baseId: 'claude-haiku-4-5',
      isOneMillionVariant: false,
      datedSnapshot: '20251001',
    });
  });

  it('handles a dated id that also carries the [1m] suffix', () => {
    expect(parseModelId('claude-opus-4-8-20260301[1m]')).toEqual({
      id: 'claude-opus-4-8-20260301[1m]',
      baseId: 'claude-opus-4-8',
      isOneMillionVariant: true,
      datedSnapshot: '20260301',
    });
  });

  it('keeps an implausible 8-digit tail as part of the base id', () => {
    expect(parseModelId('claude-opus-4-8-20251399')).toEqual({
      id: 'claude-opus-4-8-20251399',
      baseId: 'claude-opus-4-8-20251399',
      isOneMillionVariant: false,
      datedSnapshot: null,
    });
    expect(parseModelId('some-model-19991231').datedSnapshot).toBeNull();
  });

  it('handles the empty string', () => {
    expect(parseModelId('')).toEqual({
      id: '',
      baseId: '',
      isOneMillionVariant: false,
      datedSnapshot: null,
    });
  });
});

describe('groupModelIds', () => {
  it('collapses alias, [1m] variant, and dated pin into one group', () => {
    const groups = groupModelIds([
      'claude-opus-4-8',
      'claude-opus-4-8[1m]',
      'claude-opus-4-8-20260101',
    ]);
    expect(groups).toEqual([
      {
        primaryId: 'claude-opus-4-8',
        oneMillionId: 'claude-opus-4-8[1m]',
        primaryIsOneMillion: false,
        pinnedBuildIds: ['claude-opus-4-8-20260101'],
        isSuperseded: false,
      },
    ]);
  });

  it('promotes the newest dated form when no bare alias exists', () => {
    const groups = groupModelIds([
      'claude-haiku-4-5-20251001',
      'claude-haiku-4-5-20250601',
    ]);
    expect(groups).toEqual([
      {
        primaryId: 'claude-haiku-4-5-20251001',
        oneMillionId: null,
        primaryIsOneMillion: false,
        pinnedBuildIds: ['claude-haiku-4-5-20250601'],
        isSuperseded: false,
      },
    ]);
  });

  it('uses the [1m] form as primary when only that form exists', () => {
    const groups = groupModelIds(['claude-opus-4-7[1m]']);
    expect(groups).toEqual([
      {
        primaryId: 'claude-opus-4-7[1m]',
        oneMillionId: null,
        primaryIsOneMillion: true,
        pinnedBuildIds: [],
        isSuperseded: false,
      },
    ]);
  });

  it('keeps a dated [1m] combo as a pinned entry verbatim', () => {
    const groups = groupModelIds(['claude-opus-4-8', 'claude-opus-4-8-20260301[1m]']);
    expect(groups).toEqual([
      {
        primaryId: 'claude-opus-4-8',
        oneMillionId: null,
        primaryIsOneMillion: false,
        pinnedBuildIds: ['claude-opus-4-8-20260301[1m]'],
        isSuperseded: false,
      },
    ]);
  });

  it('leaves suffix-free ids as their own single-member groups', () => {
    const groups = groupModelIds(['gpt-5-mini', 'gpt-5-codex', 'opus']);
    expect(groups).toEqual([
      { primaryId: 'gpt-5-codex', oneMillionId: null, primaryIsOneMillion: false, pinnedBuildIds: [], isSuperseded: false },
      { primaryId: 'gpt-5-mini', oneMillionId: null, primaryIsOneMillion: false, pinnedBuildIds: [], isSuperseded: false },
      { primaryId: 'opus', oneMillionId: null, primaryIsOneMillion: false, pinnedBuildIds: [], isSuperseded: false },
    ]);
  });

  it('groups a mixed multi-agent list without touching foreign ids', () => {
    const groups = groupModelIds([
      'claude-opus-4-8[1m]',
      'gpt-5-mini',
      'claude-opus-4-8',
      'claude-haiku-4-5-20251001',
    ]);
    expect(groups.map((group) => group.primaryId)).toEqual([
      'claude-haiku-4-5-20251001',
      'claude-opus-4-8',
      'gpt-5-mini',
    ]);
    expect(groups[1]?.oneMillionId).toBe('claude-opus-4-8[1m]');
  });

  it('sorts pinned builds newest first', () => {
    const groups = groupModelIds([
      'claude-haiku-4-5',
      'claude-haiku-4-5-20250601',
      'claude-haiku-4-5-20251001',
    ]);
    expect(groups[0]?.pinnedBuildIds).toEqual([
      'claude-haiku-4-5-20251001',
      'claude-haiku-4-5-20250601',
    ]);
  });

  it('deduplicates repeated ids', () => {
    const groups = groupModelIds(['claude-opus-4-8', 'claude-opus-4-8']);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.pinnedBuildIds).toEqual([]);
  });

  it('is idempotent on an already-clean list', () => {
    const clean = ['claude-haiku-4-5', 'claude-opus-4-8', 'claude-sonnet-4-6'];
    const groups = groupModelIds(clean);
    expect(groups.map((group) => group.primaryId)).toEqual(clean);
    expect(groups.every((group) => group.oneMillionId === null && group.pinnedBuildIds.length === 0)).toBe(true);
  });

  it('demotes an older generation of the same family', () => {
    const groups = groupModelIds(['claude-opus-4-7', 'claude-opus-4-8']);
    const opus47 = groups.find((group) => group.primaryId === 'claude-opus-4-7');
    const opus48 = groups.find((group) => group.primaryId === 'claude-opus-4-8');
    expect(opus47?.isSuperseded).toBe(true);
    expect(opus48?.isSuperseded).toBe(false);
  });

  it('keeps an older generation\'s 1M chip and dated pins when demoted', () => {
    const groups = groupModelIds(['claude-opus-4-7', 'claude-opus-4-7[1m]', 'claude-opus-4-8']);
    const opus47 = groups.find((group) => group.primaryId === 'claude-opus-4-7');
    expect(opus47?.isSuperseded).toBe(true);
    expect(opus47?.oneMillionId).toBe('claude-opus-4-7[1m]');
  });

  it('picks the higher version by comparing tuples, not string length', () => {
    const groups = groupModelIds(['claude-sonnet-4-6', 'claude-sonnet-5']);
    const sonnet46 = groups.find((group) => group.primaryId === 'claude-sonnet-4-6');
    const sonnet5 = groups.find((group) => group.primaryId === 'claude-sonnet-5');
    expect(sonnet46?.isSuperseded).toBe(true);
    expect(sonnet5?.isSuperseded).toBe(false);
  });

  it('demotes a legacy single-segment generation under a newer two-segment one', () => {
    const groups = groupModelIds(['claude-opus-4', 'claude-opus-4-8']);
    const opus4 = groups.find((group) => group.primaryId === 'claude-opus-4');
    const opus48 = groups.find((group) => group.primaryId === 'claude-opus-4-8');
    expect(opus4?.isSuperseded).toBe(true);
    expect(opus48?.isSuperseded).toBe(false);
  });

  it('never supersedes a floating alias with no numeric version', () => {
    for (const ids of [
      ['claude-opus', 'claude-opus-4-8'],
      ['opus', 'claude-opus-4-8'],
      ['gpt-5-mini', 'claude-opus-4-8'],
    ]) {
      const groups = groupModelIds(ids);
      const alias = groups.find((group) => group.primaryId === ids[0]);
      expect(alias?.isSuperseded).toBe(false);
    }
  });

  it('leaves a lone family member unsuperseded regardless of version', () => {
    const groups = groupModelIds(['claude-opus-4-7']);
    expect(groups[0]?.isSuperseded).toBe(false);
  });

  it('demotes every older member of a three-generation family, leaving only the newest', () => {
    const groups = groupModelIds(['claude-opus-4-6', 'claude-opus-4-7', 'claude-opus-4-8']);
    const opus46 = groups.find((group) => group.primaryId === 'claude-opus-4-6');
    const opus47 = groups.find((group) => group.primaryId === 'claude-opus-4-7');
    const opus48 = groups.find((group) => group.primaryId === 'claude-opus-4-8');
    expect(opus46?.isSuperseded).toBe(true);
    expect(opus47?.isSuperseded).toBe(true);
    expect(opus48?.isSuperseded).toBe(false);
  });

  it('demotes an older generation even when the newest generation has only ever shipped as a dated pin (no bare alias yet)', () => {
    const groups = groupModelIds(['claude-opus-4-7', 'claude-opus-4-8-20260301']);
    const opus47 = groups.find((group) => group.primaryId === 'claude-opus-4-7');
    const opus48Pin = groups.find((group) => group.primaryId === 'claude-opus-4-8-20260301');
    expect(opus47?.isSuperseded).toBe(true);
    expect(opus48Pin?.isSuperseded).toBe(false);
  });

  it('keeps 1M chips and dated pins attached to their own generation across a three-generation family', () => {
    const groups = groupModelIds([
      'claude-opus-4-6',
      'claude-opus-4-6[1m]',
      'claude-opus-4-7',
      'claude-opus-4-7-20251201',
      'claude-opus-4-8',
      'claude-opus-4-8[1m]',
    ]);
    const opus46 = groups.find((group) => group.primaryId === 'claude-opus-4-6');
    const opus47 = groups.find((group) => group.primaryId === 'claude-opus-4-7');
    const opus48 = groups.find((group) => group.primaryId === 'claude-opus-4-8');
    expect(opus46).toMatchObject({ isSuperseded: true, oneMillionId: 'claude-opus-4-6[1m]' });
    expect(opus47).toMatchObject({ isSuperseded: true, pinnedBuildIds: ['claude-opus-4-7-20251201'] });
    expect(opus48).toMatchObject({ isSuperseded: false, oneMillionId: 'claude-opus-4-8[1m]' });
  });
});

describe('parseModelFamily', () => {
  it('splits a versioned base id into family and version tuple', () => {
    expect(parseModelFamily('claude-opus-4-8')).toEqual({ family: 'claude-opus', version: [4, 8] });
    expect(parseModelFamily('claude-sonnet-5')).toEqual({ family: 'claude-sonnet', version: [5] });
    expect(parseModelFamily('claude-opus-4')).toEqual({ family: 'claude-opus', version: [4] });
  });

  it('returns an empty version tuple for a floating alias', () => {
    expect(parseModelFamily('claude-opus')).toEqual({ family: 'claude-opus', version: [] });
    expect(parseModelFamily('opus')).toEqual({ family: 'opus', version: [] });
  });

  it('returns an empty version tuple for a non-numeric trailing segment', () => {
    expect(parseModelFamily('gpt-5-mini')).toEqual({ family: 'gpt-5-mini', version: [] });
    expect(parseModelFamily('gemini-2.5-pro')).toEqual({ family: 'gemini-2.5-pro', version: [] });
  });
});

describe('compareModelVersion', () => {
  it('compares tuples lexicographically', () => {
    expect(compareModelVersion([5], [4, 6])).toBeGreaterThan(0);
    expect(compareModelVersion([4, 6], [5])).toBeLessThan(0);
    expect(compareModelVersion([4, 7], [4, 8])).toBeLessThan(0);
    expect(compareModelVersion([4, 8], [4, 8])).toBe(0);
  });

  it('treats a missing element as lower than any present element', () => {
    expect(compareModelVersion([4], [4, 8])).toBeLessThan(0);
    expect(compareModelVersion([4, 8], [4])).toBeGreaterThan(0);
  });
});

describe('resolveModelSelector', () => {
  it('passes through a raw lowercase id or alias verbatim', () => {
    expect(resolveModelSelector('claude-opus-4-8')).toBe('claude-opus-4-8');
    expect(resolveModelSelector('opus')).toBe('opus');
    expect(resolveModelSelector('sonnet')).toBe('sonnet');
  });

  it('synthesizes a "<Name> <major>.<minor>" friendly form into an id', () => {
    expect(resolveModelSelector('Opus 4.8')).toBe('claude-opus-4-8');
    expect(resolveModelSelector('Sonnet 5')).toBe('claude-sonnet-5');
    expect(resolveModelSelector('Haiku 4.5')).toBe('claude-haiku-4-5');
  });

  it('maps a trailing "(1M)" to the [1m] suffix', () => {
    expect(resolveModelSelector('Opus 4.8 (1M)')).toBe('claude-opus-4-8[1m]');
    expect(resolveModelSelector('Opus 4.8 (1m)')).toBe('claude-opus-4-8[1m]');
  });

  it('handles a multi-word model name', () => {
    expect(resolveModelSelector('Fable 5')).toBe('claude-fable-5');
  });

  it('passes through empty/whitespace-only input unchanged', () => {
    expect(resolveModelSelector('')).toBe('');
    expect(resolveModelSelector('   ')).toBe('');
  });

  it('trims surrounding whitespace before matching', () => {
    expect(resolveModelSelector('  Opus 4.8  ')).toBe('claude-opus-4-8');
  });

  it('turns a bare family name into the lowercase floating alias, never claude-<name>', () => {
    // The pre-fix bug: "Sonnet" became `claude-sonnet`, which is not a valid
    // id, and MCP validation waved it through as a floating alias.
    expect(resolveModelSelector('Sonnet')).toBe('sonnet');
    expect(resolveModelSelector('Opus')).toBe('opus');
    expect(resolveModelSelector('Sonnet (1M)')).toBe('sonnet[1m]');
  });

  it('never rewrites anything outside the shapes humanizeModelId emits', () => {
    for (const raw of [
      'GPT-5.5',
      'gpt-5.3-codex-high',
      'Qwen2.5-Coder:7B',
      'claude-opus-5-5[1m]',
      'claude-haiku-4-5-20251001',
      'opusplan',
      'Opus Plan Mode',
      'OPUS',
    ]) {
      expect(resolveModelSelector(raw)).toBe(raw);
    }
  });
});

describe('planModelPickerRows', () => {
  const ids = [
    'claude-fable-5',
    'claude-fable-5-1',
    'claude-haiku-4-5',
    'claude-haiku-4-5-20251001',
    'claude-opus-4-8',
    'claude-opus-5-5',
    'claude-opus-5-5[1m]',
    'claude-sonnet-5',
    'claude-sonnet-5-5',
  ];

  it('without aliases, splits exactly as before: current generations on top, the rest collapsed', () => {
    const rows = planModelPickerRows(ids);
    expect(rows.aliasRows).toEqual([]);
    expect(rows.topGroups.map((group) => group.primaryId)).toEqual([
      'claude-fable-5-1',
      'claude-haiku-4-5',
      'claude-opus-5-5',
      'claude-sonnet-5-5',
    ]);
    expect(rows.versionRows.map((row) => row.sortId)).toEqual([
      'claude-fable-5',
      'claude-haiku-4-5-20251001',
      'claude-opus-4-8',
      'claude-sonnet-5',
    ]);
  });

  it('with aliases, moves every covered current version into the collapsed section, no duplicates', () => {
    const rows = planModelPickerRows(ids, [
      { id: 'opus', resolvesTo: 'claude-opus-5-5' },
      { id: 'fable', resolvesTo: 'claude-fable-5-1' },
      { id: 'sonnet', resolvesTo: 'claude-sonnet-5-5' },
      { id: 'haiku', resolvesTo: 'claude-haiku-4-5' },
    ]);
    expect(rows.aliasRows.map((alias) => alias.id)).toEqual(['opus', 'fable', 'sonnet', 'haiku']);
    expect(rows.topGroups).toEqual([]);
    // Families side by side, newest version first within each, a dated pin
    // right after the generation it pins.
    expect(rows.versionRows.map((row) => row.sortId)).toEqual([
      'claude-fable-5-1',
      'claude-fable-5',
      'claude-haiku-4-5',
      'claude-haiku-4-5-20251001',
      'claude-opus-5-5',
      'claude-opus-4-8',
      'claude-sonnet-5-5',
      'claude-sonnet-5',
    ]);
    // The [1m] chip stays on its version row, and a value held there opens the section.
    expect(rows.versionSelectableIds.has('claude-opus-5-5[1m]')).toBe(true);
    expect(rows.versionSelectableIds.has('claude-sonnet-5-5')).toBe(true);
  });

  it('orders a family newest first by version number, not by the text of the id', () => {
    // Text order would put 4-10 before 4-9 and 4-6 first; the numbers say 4-10 is newest.
    const rows = planModelPickerRows(
      ['claude-opus-4-6', 'claude-opus-4-9', 'claude-opus-4-10', 'claude-opus-4-9-20260101'],
      [{ id: 'opus', resolvesTo: 'claude-opus-4-10' }],
    );
    expect(rows.versionRows.map((row) => row.sortId)).toEqual([
      'claude-opus-4-10',
      'claude-opus-4-9',
      'claude-opus-4-9-20260101',
      'claude-opus-4-6',
    ]);
  });

  it('keeps a family with no alias at the top level so a latest model is never hidden', () => {
    const rows = planModelPickerRows(ids, [{ id: 'opus', resolvesTo: 'claude-opus-5-5' }]);
    expect(rows.topGroups.map((group) => group.primaryId)).toEqual([
      'claude-fable-5-1',
      'claude-haiku-4-5',
      'claude-sonnet-5-5',
    ]);
  });

  it('treats an alias with no resolved target as covering nothing', () => {
    const rows = planModelPickerRows(ids, [{ id: 'opus' }]);
    expect(rows.topGroups.map((group) => group.primaryId)).toContain('claude-opus-5-5');
  });

  it('folds a learned bare alias into the alias row instead of listing it again', () => {
    const rows = planModelPickerRows(['sonnet', 'claude-sonnet-5-5'], [
      { id: 'sonnet', resolvesTo: 'claude-sonnet-5-5' },
    ]);
    expect(rows.topGroups).toEqual([]);
    expect(rows.versionRows.map((row) => row.sortId)).toEqual(['claude-sonnet-5-5']);
  });

  it('keeps an alias [1m] value selectable as a specific version, never at the top', () => {
    const rows = planModelPickerRows(['sonnet', 'sonnet[1m]', 'claude-sonnet-5-5'], [
      { id: 'sonnet', resolvesTo: 'claude-sonnet-5-5' },
    ]);
    expect(rows.topGroups).toEqual([]);
    expect(rows.versionRows.map((row) => row.sortId)).toEqual(['claude-sonnet-5-5', 'sonnet[1m]']);
    expect(rows.versionSelectableIds.has('sonnet[1m]')).toBe(true);
  });
});

describe('newerModelFor', () => {
  const ids = ['claude-sonnet-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'sonnet'];

  it('names the newest generation of an older pin', () => {
    expect(newerModelFor('claude-sonnet-5', ids)).toBe('claude-sonnet-5-5');
    expect(newerModelFor('claude-sonnet-4-6[1m]', ids)).toBe('claude-sonnet-5-5');
  });

  it('is null for the newest version, a floating alias, or an unversioned id', () => {
    expect(newerModelFor('claude-sonnet-5-5', ids)).toBeNull();
    expect(newerModelFor('sonnet', ids)).toBeNull();
    expect(newerModelFor('gpt-5', ids)).toBeNull();
  });

  it('returns the newest newer generation, not the first newer one, whatever the list order', () => {
    const generations = ['claude-sonnet-5', 'claude-sonnet-5-5', 'claude-sonnet-6'];
    expect(newerModelFor('claude-sonnet-5', generations)).toBe('claude-sonnet-6');
    expect(newerModelFor('claude-sonnet-5', [...generations].reverse())).toBe('claude-sonnet-6');
  });
});

describe('resolveSpacedModelName', () => {
  it('converts a name with whitespace the way resolveModelSelector does', () => {
    expect(resolveSpacedModelName('Opus 4.8')).toBe('claude-opus-4-8');
    expect(resolveSpacedModelName('Sonnet (1M)')).toBe('sonnet[1m]');
  });

  it('passes a single word through unchanged, because only the adapter knows if it is an alias', () => {
    // resolveModelSelector('Opus') would return 'opus'; this must not.
    expect(resolveSpacedModelName('Opus')).toBe('Opus');
    expect(resolveSpacedModelName('Workhorse')).toBe('Workhorse');
  });

  it('trims before deciding whether the input has whitespace', () => {
    // A leading or trailing space must not read as "has whitespace" and
    // lowercase a single word into an id that does not exist.
    expect(resolveSpacedModelName('  Workhorse ')).toBe('Workhorse');
    expect(resolveSpacedModelName('  Opus 4.8 ')).toBe('claude-opus-4-8');
  });
});

describe('resolveEffortSelector', () => {
  it('lowercases and trims', () => {
    expect(resolveEffortSelector('XHigh')).toBe('xhigh');
    expect(resolveEffortSelector(' High ')).toBe('high');
    expect(resolveEffortSelector('MAX')).toBe('max');
  });

  it('passes through an already-normalized value unchanged', () => {
    expect(resolveEffortSelector('medium')).toBe('medium');
  });
});
