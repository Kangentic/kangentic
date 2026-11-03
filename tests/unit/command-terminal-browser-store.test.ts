/**
 * A Command Terminal slot's saved Browser layout (open, and the split), read
 * and written through `command-terminal-browser-store.ts` on a real file in a
 * temp directory.
 *
 * The renderer's value crosses IPC, so the store narrows it rather than
 * trusting it: a malformed entry written to disk would reopen a pane, or set a
 * split, the user never chose, on every restart.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/main/safe-write', () => ({
  safeWriteJson: (filePath: string, value: unknown) => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(value));
    return true;
  },
}));

import { CommandTerminalBrowserStore, toCommandTerminalBrowserState } from '../../src/main/browser/command-terminal-browser-store';

describe('toCommandTerminalBrowserState', () => {
  it('keeps an open flag and a ratio inside the split', () => {
    expect(toCommandTerminalBrowserState({ open: true, ratio: 0.6 })).toEqual({ open: true, ratio: 0.6 });
    expect(toCommandTerminalBrowserState({ open: false })).toEqual({ open: false });
  });

  it('drops what is not a layout, and a ratio that is not a share of the split', () => {
    expect(toCommandTerminalBrowserState(null)).toBeNull();
    expect(toCommandTerminalBrowserState('open')).toBeNull();
    expect(toCommandTerminalBrowserState({ open: 'yes' })).toBeNull();
    expect(toCommandTerminalBrowserState({ open: true, ratio: Number.NaN })).toEqual({ open: true });
    expect(toCommandTerminalBrowserState({ open: true, ratio: '0.5' })).toEqual({ open: true });
    expect(toCommandTerminalBrowserState({ open: true, ratio: 5 })).toEqual({ open: true });
    expect(toCommandTerminalBrowserState({ open: true, ratio: 0 })).toEqual({ open: true });
    expect(toCommandTerminalBrowserState({ open: true, ratio: -0.3 })).toEqual({ open: true });
  });
});

describe('CommandTerminalBrowserStore', () => {
  let projectPath: string;
  const store = new CommandTerminalBrowserStore();

  beforeEach(() => {
    projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-browser-store-'));
  });

  afterEach(() => {
    fs.rmSync(projectPath, { recursive: true, force: true });
  });

  it('saves per slot, reads it back, and clears one slot without touching another', () => {
    store.set(projectPath, 'slot-1', { open: true, ratio: 0.4 });
    store.set(projectPath, 'slot-2', { open: false });
    expect(store.get(projectPath, 'slot-1')).toEqual({ open: true, ratio: 0.4 });
    store.clear(projectPath, 'slot-1');
    expect(store.get(projectPath, 'slot-1')).toBeNull();
    expect(store.get(projectPath, 'slot-2')).toEqual({ open: false });
  });

  it('reads a corrupt file, or a malformed entry, as nothing saved', () => {
    const filePath = path.join(projectPath, '.kangentic', 'command-terminal-browser.json');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, '{ not json');
    expect(store.get(projectPath, 'slot-1')).toBeNull();
    fs.writeFileSync(filePath, JSON.stringify({ 'slot-1': { open: 'yes' }, 'slot-2': { open: true } }));
    expect(store.get(projectPath, 'slot-1')).toBeNull();
    expect(store.get(projectPath, 'slot-2')).toEqual({ open: true });
  });

  it('reads a slot named like an Object member as nothing saved', () => {
    expect(store.get(projectPath, '__proto__')).toBeNull();
    expect(store.get(projectPath, 'constructor')).toBeNull();
    store.set(projectPath, 'slot-1', { open: true });
    // `clear` finds nothing to delete, so it leaves the file alone.
    store.clear(projectPath, 'toString');
    expect(store.get(projectPath, 'slot-1')).toEqual({ open: true });
  });
});
