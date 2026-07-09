import { describe, it, expect } from 'vitest';
import {
  parseModelId,
  groupModelIds,
  parseModelFamily,
  compareModelVersion,
  resolveModelSelector,
  resolveEffortSelector,
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
