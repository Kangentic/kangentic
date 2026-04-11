import { describe, it, expect } from 'vitest';
import { deepMerge, deepMergeConfig } from '../../src/shared/object-utils';

describe('deepMerge', () => {
  it('merges nested objects recursively when they contain non-primitive values', () => {
    const target = { a: { b: { x: 1 }, c: { y: 2 } }, d: 3 };
    const source = { a: { b: { x: 10 } } };
    expect(deepMerge(target, source)).toEqual({ a: { b: { x: 10 }, c: { y: 2 } }, d: 3 });
  });

  it('replaces arrays instead of merging them', () => {
    const target = { items: [1, 2, 3] };
    const source = { items: [4, 5] };
    expect(deepMerge(target, source)).toEqual({ items: [4, 5] });
  });

  it('allows null to override a value', () => {
    const target = { a: 'hello' };
    const source = { a: null };
    expect(deepMerge(target, source as Partial<typeof target>)).toEqual({ a: null });
  });

  it('skips undefined values in source', () => {
    const target = { a: 1, b: 2 };
    const source = { a: undefined, b: 3 };
    expect(deepMerge(target, source)).toEqual({ a: 1, b: 3 });
  });

  describe('flat map replacement', () => {
    it('replaces a flat string map entirely instead of merging keys', () => {
      const target = { labelColors: { foo: '#ff0000', bar: '#00ff00', baz: '#0000ff' } };
      const source = { labelColors: { foo: '#ff0000', bar: '#00ff00' } };
      const result = deepMerge(target, source);
      expect(result.labelColors).toEqual({ foo: '#ff0000', bar: '#00ff00' });
      expect('baz' in result.labelColors).toBe(false);
    });

    it('handles deleting all keys from a flat map', () => {
      const target = { labelColors: { foo: '#ff0000' } };
      const source = { labelColors: {} };
      const result = deepMerge(target, source);
      expect(result.labelColors).toEqual({});
    });

    it('handles adding a new key to a flat map', () => {
      const target = { labelColors: { foo: '#ff0000' } };
      const source = { labelColors: { foo: '#ff0000', bar: '#00ff00' } };
      const result = deepMerge(target, source);
      expect(result.labelColors).toEqual({ foo: '#ff0000', bar: '#00ff00' });
    });

    it('still deep-merges objects with nested object values', () => {
      const target = { backlog: { labelColors: { foo: '#ff0000', bar: '#00ff00' }, priorities: [{ label: 'High' }] } };
      const source = { backlog: { labelColors: { foo: '#ff0000' } } };
      const result = deepMerge(target, source);
      // backlog is NOT flat (contains array and object), so it recurses
      // labelColors IS flat, so it replaces entirely
      expect(result.backlog.labelColors).toEqual({ foo: '#ff0000' });
      // priorities should be preserved (not in source)
      expect(result.backlog.priorities).toEqual([{ label: 'High' }]);
    });

    it('replaces flat map with mixed primitive types', () => {
      const target = { settings: { enabled: true, count: 5, name: 'test', removed: 'old' } };
      const source = { settings: { enabled: false, count: 10, name: 'updated' } };
      const result = deepMerge(target, source);
      expect(result.settings).toEqual({ enabled: false, count: 10, name: 'updated' });
      expect('removed' in result.settings).toBe(false);
    });

    it('recursively merges when source is flat but target has non-primitive values', () => {
      const target = {
        git: {
          worktreesEnabled: true,
          autoCleanup: true,
          defaultBaseBranch: 'main',
          copyFiles: [] as string[],
          initScript: null as string | null,
        },
      };
      const source = { git: { defaultBaseBranch: 'develop' } };
      const result = deepMerge(target, source);
      // target.git has arrays (copyFiles), so it is NOT a flat map — must recurse
      expect(result.git.defaultBaseBranch).toBe('develop');
      expect(result.git.copyFiles).toEqual([]);
      expect(result.git.worktreesEnabled).toBe(true);
      expect(result.git.autoCleanup).toBe(true);
      expect(result.git.initScript).toBeNull();
    });

    it('preserves target array values when source subset is all primitives', () => {
      const target = { section: { name: 'original', items: ['a', 'b'], active: true } };
      const source = { section: { name: 'updated' } };
      const result = deepMerge(target, source);
      expect(result.section.name).toBe('updated');
      expect(result.section.items).toEqual(['a', 'b']);
      expect(result.section.active).toBe(true);
    });

    it('treats flat map with null values as a flat map', () => {
      const target = { colors: { a: '#fff', b: '#000' } };
      const source = { colors: { a: null } };
      const result = deepMerge(target, source as Partial<typeof target>);
      expect(result.colors).toEqual({ a: null });
      expect('b' in result.colors).toBe(false);
    });
  });

  describe('replaceFlatMaps: false (config overlay)', () => {
    it('preserves unmentioned keys in flat map when replaceFlatMaps is false', () => {
      const target = { terminal: { shell: null, fontSize: 14, fontFamily: 'Menlo', scrollbackLines: 5000, cursorStyle: 'block' } };
      const source = { terminal: { shell: 'powershell', cursorStyle: 'underline' } };
      const result = deepMerge(target, source, { replaceFlatMaps: false });
      expect(result.terminal.fontSize).toBe(14);
      expect(result.terminal.fontFamily).toBe('Menlo');
      expect(result.terminal.scrollbackLines).toBe(5000);
      expect(result.terminal.shell).toBe('powershell');
      expect(result.terminal.cursorStyle).toBe('underline');
    });

    it('still allows overriding individual keys', () => {
      const target = { settings: { enabled: true, count: 5, name: 'test' } };
      const source = { settings: { count: 10 } };
      const result = deepMerge(target, source, { replaceFlatMaps: false });
      expect(result.settings).toEqual({ enabled: true, count: 10, name: 'test' });
    });

    it('allows null to override in flat maps', () => {
      const target = { terminal: { shell: 'bash', fontSize: 14 } };
      const source = { terminal: { shell: null } };
      const result = deepMerge(target, source as Partial<typeof target>, { replaceFlatMaps: false });
      expect(result.terminal.shell).toBeNull();
      expect(result.terminal.fontSize).toBe(14);
    });

    it('dictionaryPaths replaces flat maps at explicit paths even when replaceFlatMaps is false', () => {
      const target = {
        contextBar: { showShell: true, showVersion: true, showModel: true, showCost: true },
        backlog: { labelColors: { foo: '#ff0000', bar: '#00ff00' } },
      };
      // Toggle a single contextBar key AND delete a labelColor at the same time
      const source = {
        contextBar: { showCost: false },
        backlog: { labelColors: { foo: '#ff0000' } },
      };
      const result = deepMerge(target, source, {
        replaceFlatMaps: false,
        dictionaryPaths: ['backlog.labelColors'],
      });
      // contextBar is a typed struct -> merge: only showCost changes, others preserved
      expect(result.contextBar).toEqual({ showShell: true, showVersion: true, showModel: true, showCost: false });
      // backlog.labelColors is in dictionaryPaths -> replaced: 'bar' is gone
      expect(result.backlog.labelColors).toEqual({ foo: '#ff0000' });
      expect('bar' in result.backlog.labelColors).toBe(false);
    });

    it('dictionaryPaths matches nested paths only at the exact dotted location', () => {
      const target = {
        agent: { cliPaths: { claude: '/usr/bin/claude', codex: '/usr/bin/codex' }, permissionMode: 'acceptEdits' },
      };
      const source = { agent: { cliPaths: { claude: '/new/claude' } } };
      const result = deepMerge(target, source, {
        replaceFlatMaps: false,
        dictionaryPaths: ['agent.cliPaths'],
      });
      // cliPaths is replaced (codex is gone)
      expect(result.agent.cliPaths).toEqual({ claude: '/new/claude' });
      // permissionMode is unchanged
      expect(result.agent.permissionMode).toBe('acceptEdits');
    });

    it('deepMergeConfig uses replaceFlatMaps: false', () => {
      const base = { terminal: { shell: null, fontSize: 14, fontFamily: 'Menlo', scrollbackLines: 5000, cursorStyle: 'block' } };
      const overrides = { terminal: { shell: 'powershell' } };
      const result = deepMergeConfig(base, overrides);
      expect(result.terminal.fontSize).toBe(14);
      expect(result.terminal.fontFamily).toBe('Menlo');
      expect(result.terminal.scrollbackLines).toBe(5000);
      expect(result.terminal.shell).toBe('powershell');
      expect(result.terminal.cursorStyle).toBe('block');
    });
  });
});
