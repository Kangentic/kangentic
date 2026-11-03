/**
 * The helper's two jobs that touch an agent CLI's files on the host (#913): a locked JSON patch (a
 * CLI's trust entry in a file it shares with Kangentic) and the hook watcher that carries a session's
 * published hook files back to the app. Real files in a temp folder, real timers.
 *
 * What a user loses if it breaks: a CLI that stops on a trust prompt nobody can answer, a shared
 * config file wiped by a torn read, a hook record sent twice or out of order, or a record too large
 * for a frame ending the connection and stalling every terminal on the host.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyJsonPatch, JsonPatchError, patchJsonFile, type JsonPatchOp } from '../../src/main/remote/helper/json-patch';
import { HookWatcher, fitHookRecord, publishedNames, type HookFileEvent } from '../../src/main/remote/helper/hook-watcher';

let directory: string;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-helper-files-'));
});

afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true });
});

async function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the condition');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('applyJsonPatch', () => {
  it('sets, defaults, adds to an array and copies, and reports a change only when one happened', () => {
    const data: Record<string, unknown> = { projects: { '/parent': { enabledMcpjsonServers: ['a'] } } };
    const ops: JsonPatchOp[] = [
      { op: 'copyIfAbsent', from: ['projects', '/parent', 'enabledMcpjsonServers'], at: ['projects', '/child', 'enabledMcpjsonServers'], fallback: [] },
      { op: 'setDefault', at: ['projects', '/child', 'allowedTools'], value: [] },
      { op: 'set', at: ['projects', '/child', 'hasTrustDialogAccepted'], value: true },
      { op: 'addToArray', at: ['projects', '/child', 'enabledMcpjsonServers'], value: 'kangentic' },
      { op: 'set', at: ['diffSidebarOpen'], value: false },
    ];

    expect(applyJsonPatch(data, ops)).toBe(true);
    expect(data).toEqual({
      projects: {
        '/parent': { enabledMcpjsonServers: ['a'] },
        '/child': { enabledMcpjsonServers: ['a', 'kangentic'], allowedTools: [], hasTrustDialogAccepted: true },
      },
      diffSidebarOpen: false,
    });
    expect(applyJsonPatch(data, ops)).toBe(false);
  });

  it('keeps a value that is already there for setDefault and copyIfAbsent, and never copies the parent twice', () => {
    const data: Record<string, unknown> = { a: { list: ['mine'], parent: ['theirs'] } };
    applyJsonPatch(data, [
      { op: 'setDefault', at: ['a', 'list'], value: ['default'] },
      { op: 'copyIfAbsent', from: ['a', 'parent'], at: ['a', 'list'], fallback: [] },
    ]);
    expect(data).toEqual({ a: { list: ['mine'], parent: ['theirs'] } });
  });

  it('falls back when there is nothing to copy', () => {
    const data: Record<string, unknown> = {};
    applyJsonPatch(data, [{ op: 'copyIfAbsent', from: ['no', 'where'], at: ['target'], fallback: ['x'] }]);
    expect(data).toEqual({ target: ['x'] });
  });

  it('refuses a key that would reach the prototype, and a step that is not an object', () => {
    for (const bad of ['__proto__', 'constructor', 'prototype']) {
      expect(() => applyJsonPatch({}, [{ op: 'set', at: [bad, 'x'], value: 1 }])).toThrow(JsonPatchError);
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(() => applyJsonPatch({ a: 'text' }, [{ op: 'set', at: ['a', 'b'], value: 1 }])).toThrow('not an object');
    expect(() => applyJsonPatch({ a: 'text' }, [{ op: 'addToArray', at: ['a'], value: 1 }])).toThrow('not an array');
    expect(() => applyJsonPatch({}, [{ op: 'set', at: [], value: 1 }])).toThrow('at least one key');
  });
});

describe('patchJsonFile', () => {
  const ops: JsonPatchOp[] = [{ op: 'set', at: ['trusted'], value: true }];

  it('creates a file that is not there, as the local write does', async () => {
    const file = path.join(directory, '.claude.json');
    expect(await patchJsonFile({ path: file, ops })).toEqual({ applied: true, changed: true });
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ trusted: true });
  });

  it('keeps what else is in the file, writes nothing when nothing changes, and leaves no staging file', async () => {
    const file = path.join(directory, '.claude.json');
    fs.writeFileSync(file, JSON.stringify({ auth: 'secret', trusted: true }));
    const before = fs.statSync(file).mtimeMs;

    expect(await patchJsonFile({ path: file, ops })).toEqual({ applied: true, changed: false });
    expect(fs.statSync(file).mtimeMs).toBe(before);

    fs.writeFileSync(file, JSON.stringify({ auth: 'secret' }));
    await patchJsonFile({ path: file, ops });
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ auth: 'secret', trusted: true });
    expect(fs.readdirSync(directory).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('keeps the file\'s own mode, so a private file stays private', async () => {
    if (process.platform === 'win32') return;
    const file = path.join(directory, '.claude.json');
    fs.writeFileSync(file, '{}', { mode: 0o600 });
    await patchJsonFile({ path: file, ops });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('leaves a file that is not a JSON object exactly as it was', async () => {
    const file = path.join(directory, '.claude.json');
    for (const content of ['{ torn', '[1,2]', '"text"']) {
      fs.writeFileSync(file, content);
      expect(await patchJsonFile({ path: file, ops })).toEqual({ applied: false, changed: false, reason: 'not-an-object' });
      expect(fs.readFileSync(file, 'utf8')).toBe(content);
    }
  });

  it('refuses a bad patch without touching the file', async () => {
    const file = path.join(directory, '.claude.json');
    fs.writeFileSync(file, '{"a":"text"}');
    expect(await patchJsonFile({ path: file, ops: [{ op: 'set', at: ['a', 'b'], value: 1 }] })).toEqual({ applied: false, changed: false, reason: 'bad-patch' });
    expect(fs.readFileSync(file, 'utf8')).toBe('{"a":"text"}');
  });

  it('waits for a lock someone else holds and goes ahead once it is released, then lets go of it', async () => {
    const file = path.join(directory, '.claude.json');
    const lock = path.join(directory, '.claude.json.lock');
    fs.mkdirSync(lock);
    setTimeout(() => fs.rmdirSync(lock), 120);

    expect(await patchJsonFile({ path: file, ops, lockDirectory: lock })).toEqual({ applied: true, changed: true });
    expect(fs.existsSync(lock)).toBe(false);
  });

  it('breaks a lock that has gone stale', async () => {
    const file = path.join(directory, '.claude.json');
    const lock = path.join(directory, '.claude.json.lock');
    fs.mkdirSync(lock);
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, old, old);

    expect(await patchJsonFile({ path: file, ops, lockDirectory: lock })).toEqual({ applied: true, changed: true });
  });
});

describe('fitHookRecord', () => {
  const header = 'K1\ntool_end\ndirective\n';

  it('leaves a record that fits alone', () => {
    const record = `${header}${JSON.stringify({ tool_name: 'Read' })}`;
    expect(fitHookRecord(record, 10_000)).toBe(record);
  });

  it('trims the large string, keeping the shape and the tool name', () => {
    const record = `${header}${JSON.stringify({ tool_name: 'Write', tool_input: { file_path: '/a.txt', content: 'x'.repeat(500_000) } })}`;
    const fitted = fitHookRecord(record, 200_000);
    expect(JSON.stringify(fitted).length).toBeLessThanOrEqual(200_000);
    expect(fitted.startsWith(header)).toBe(true);
    const parsed = JSON.parse(fitted.slice(header.length)) as { tool_name: string; tool_input: { file_path: string; content: string } };
    expect(parsed.tool_name).toBe('Write');
    expect(parsed.tool_input.file_path).toBe('/a.txt');
    expect(parsed.tool_input.content.endsWith('[trimmed]')).toBe(true);
  });

  it('counts escaped characters, which a newline-heavy record takes twice over', () => {
    const record = `${header}${JSON.stringify({ text: '\n'.repeat(150_000) })}`;
    const fitted = fitHookRecord(record, 200_000);
    expect(JSON.stringify(fitted).length).toBeLessThanOrEqual(200_000);
  });

  it('counts bytes, so multi-byte text that fits in characters is still trimmed to the frame cap', () => {
    // 90k three-byte characters: under 200k characters escaped, but about 270 KB, past a 256 KiB frame.
    const record = `${header}${JSON.stringify({ tool_name: 'Write', tool_input: { content: '字'.repeat(90_000) } })}`;
    expect(JSON.stringify(record).length).toBeLessThan(200_000);
    const fitted = fitHookRecord(record, 200_000);
    expect(fitted).not.toBe(record);
    expect(Buffer.byteLength(JSON.stringify(fitted), 'utf8')).toBeLessThanOrEqual(200_000);
  });

  it('sends the header alone when the stdin is not JSON and will not fit', () => {
    const record = `${header}${'y'.repeat(500_000)}`;
    expect(fitHookRecord(record, 200_000)).toBe(header);
  });
});

describe('publishedNames', () => {
  it('keeps finished files of the right extension in name order, and skips one still being written', () => {
    expect(publishedNames(['2-1.rec', '.9-1.tmp', '1-1.rec', '1-1.req', '.3-1.rec'], '.rec')).toEqual(['1-1.rec', '2-1.rec']);
  });
});

describe('HookWatcher', () => {
  function makeSession() {
    const hooks = path.join(directory, 'wsl-hooks');
    for (const folder of ['inbox', 'requests', 'responses']) fs.mkdirSync(path.join(hooks, folder), { recursive: true });
    return hooks;
  }

  function makeWatcher(events: HookFileEvent[]): HookWatcher {
    return new HookWatcher({ emit: (event) => events.push(event), intervalMs: 10 });
  }

  it('sends each published record once, in name order, and removes it from the host', async () => {
    const hooks = makeSession();
    const events: HookFileEvent[] = [];
    const watcher = makeWatcher(events);
    fs.writeFileSync(path.join(hooks, 'inbox', '2000000000000000000-20.rec'), 'K1\nb\n\n{}');
    fs.writeFileSync(path.join(hooks, 'inbox', '1000000000000000000-10.rec'), 'K1\na\n\n{}');
    watcher.watch('s1', hooks);

    await waitFor(() => events.length === 2);
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(events.map((event) => [event.folder, event.name])).toEqual([
      ['inbox', '1000000000000000000-10.rec'],
      ['inbox', '2000000000000000000-20.rec'],
    ]);
    expect(events[0]).toMatchObject({ sessionId: 's1', content: 'K1\na\n\n{}' });
    expect(fs.readdirSync(path.join(hooks, 'inbox'))).toEqual([]);
    watcher.dispose();
  });

  it('sends requests the same way and picks up files that arrive later', async () => {
    const hooks = makeSession();
    const events: HookFileEvent[] = [];
    const watcher = makeWatcher(events);
    watcher.watch('s1', hooks);
    fs.writeFileSync(path.join(hooks, 'requests', '1000000000000000000-10.req'), 'K1\nplan-approval\nspec\n{}');

    await waitFor(() => events.length === 1);

    expect(events[0]).toMatchObject({ folder: 'requests', name: '1000000000000000000-10.req' });
    watcher.dispose();
  });

  it('never sends a file still being written, or one of the wrong kind', async () => {
    const hooks = makeSession();
    const events: HookFileEvent[] = [];
    const watcher = makeWatcher(events);
    fs.writeFileSync(path.join(hooks, 'inbox', '.123.tmp'), 'half');
    fs.writeFileSync(path.join(hooks, 'inbox', '5-5.req'), 'wrong folder kind');
    watcher.watch('s1', hooks);

    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(events).toEqual([]);
    watcher.dispose();
  });

  it('sends the status file when it changes, not while it stays the same', async () => {
    const hooks = makeSession();
    const statusFile = path.join(directory, 'status.json');
    const events: HookFileEvent[] = [];
    const watcher = makeWatcher(events);
    watcher.watch('s1', hooks, statusFile);
    fs.writeFileSync(statusFile, '{"n":1}');

    await waitFor(() => events.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(events).toHaveLength(1);

    fs.writeFileSync(statusFile, '{"n":22}');
    await waitFor(() => events.length === 2);

    expect(events.map((event) => event.content)).toEqual(['{"n":1}', '{"n":22}']);
    expect(events[0]).toMatchObject({ folder: 'status', name: 'status.json' });
    expect(fs.existsSync(statusFile)).toBe(true);
    watcher.dispose();
  });

  it('sends what is already published when it stops, so the last records of a session are not lost', async () => {
    const hooks = makeSession();
    const events: HookFileEvent[] = [];
    const watcher = new HookWatcher({ emit: (event) => events.push(event), intervalMs: 60_000 });
    watcher.watch('s1', hooks);
    fs.writeFileSync(path.join(hooks, 'inbox', '1000000000000000000-10.rec'), 'K1\nsession_end\n\n{}');

    await watcher.unwatch('s1');

    expect(events).toHaveLength(1);
    expect(watcher.watchedCount).toBe(0);
  });

  it('keeps a session whose folder is gone from stopping the others', async () => {
    const hooks = makeSession();
    const events: HookFileEvent[] = [];
    const watcher = makeWatcher(events);
    watcher.watch('gone', path.join(directory, 'does-not-exist'));
    watcher.watch('s1', hooks);
    fs.writeFileSync(path.join(hooks, 'inbox', '1000000000000000000-10.rec'), 'K1\na\n\n{}');

    await waitFor(() => events.length === 1);

    expect(events[0].sessionId).toBe('s1');
    watcher.dispose();
  });
});
