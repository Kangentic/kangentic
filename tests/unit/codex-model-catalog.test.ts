/**
 * Codex's model list (model-catalog.ts): the `model/list` answer it parses,
 * the JSON-RPC exchange it holds with `codex app-server`, and the cache that
 * keeps discovery from waiting on a cold start.
 *
 * The answers are shaped like `Model` and `ModelListParams` in
 * codex-rs/app-server-protocol/src/protocol/v2/model.rs at rust-v0.163.0
 * (camelCase on the wire). No real app-server runs here.
 */
import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { CodexModelCatalogCache, catalogAcceptsEffort, modelCatalogOf, readCodexModelCatalog, type CodexModelCatalog } from '../../src/main/agent/adapters/codex/model-catalog';
import type { CliChildProcess } from '../../src/main/utility-process/off-main-cli';

/** One `Model` entry as 0.163.0 serializes it. */
function modelEntry(model: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: model,
    model,
    displayName: model.toUpperCase(),
    description: 'A model',
    hidden: false,
    supportedReasoningEfforts: [
      { reasoningEffort: 'low', description: 'Fast' },
      { reasoningEffort: 'medium', description: 'Balanced' },
      { reasoningEffort: 'high', description: 'Thorough' },
    ],
    defaultReasoningEffort: 'medium',
    inputModalities: ['text', 'image'],
    supportsPersonality: false,
    isDefault: false,
    ...overrides,
  };
}

describe('modelCatalogOf', () => {
  it('lists each model id the picker offers, its display name, and every effort level in first-seen order', () => {
    const catalog = modelCatalogOf([{
      data: [
        modelEntry('model-a', { isDefault: true }),
        modelEntry('model-b', {
          supportedReasoningEfforts: [{ reasoningEffort: 'medium' }, { reasoningEffort: 'xhigh' }],
        }),
      ],
      nextCursor: null,
    }]);
    expect(catalog).toEqual({
      models: ['model-a', 'model-b'],
      displayNames: { 'model-a': 'MODEL-A', 'model-b': 'MODEL-B' },
      effortLevels: ['low', 'medium', 'high', 'xhigh'],
      effortsByModel: { 'model-a': ['low', 'medium', 'high'], 'model-b': ['medium', 'xhigh'] },
    });
  });

  it('leaves out a hidden model and its efforts', () => {
    const catalog = modelCatalogOf([{
      data: [modelEntry('shown', { supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }), modelEntry('secret', { hidden: true })],
    }]);
    expect(catalog?.models).toEqual(['shown']);
    expect(catalog?.effortLevels).toEqual(['low']);
  });

  it('keeps a model with no display name or efforts, and skips an entry with no id', () => {
    const catalog = modelCatalogOf([{
      data: [
        { model: 'bare' },
        { displayName: 'No id at all' },
        'not an object',
        modelEntry('bare'),
      ],
    }]);
    expect(catalog).toEqual({ models: ['bare'], displayNames: {}, effortLevels: [], effortsByModel: { bare: [] } });
  });

  it('joins pages in order', () => {
    const catalog = modelCatalogOf([
      { data: [modelEntry('first')], nextCursor: 'page-2' },
      { data: [modelEntry('second')], nextCursor: null },
    ]);
    expect(catalog?.models).toEqual(['first', 'second']);
  });

  it('is null for an answer that is not a list, so discovery falls back', () => {
    expect(modelCatalogOf([])).toBeNull();
    expect(modelCatalogOf([{ items: [] }])).toBeNull();
    expect(modelCatalogOf([null])).toBeNull();
  });

  describe('the model/list answer captured from codex-cli 0.163.0', () => {
    const captured: unknown = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'codex-app-server-model-list.json'), 'utf-8'));
    const catalog = modelCatalogOf([captured]);

    it('lists the eight models in the CLI order, with their display names', () => {
      expect(catalog?.models).toEqual([
        'gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5',
      ]);
      expect(catalog?.displayNames['gpt-6.1-sol']).toBe('GPT-6.1-Sol');
      expect(catalog?.displayNames['gpt-6-astra']).toBe('GPT-6-Astra');
      expect(catalog?.displayNames['gpt-5.5']).toBe('GPT-5.5');
      expect(Object.keys(catalog?.displayNames ?? {})).toHaveLength(8);
    });

    it('collects every effort level in first-seen order, and keeps each model to its own', () => {
      expect(catalog?.effortLevels).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
      expect(catalog?.effortsByModel['gpt-5.5']).toEqual(['low', 'medium', 'high', 'xhigh']);
      expect(catalog?.effortsByModel['gpt-6-luna']).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
      expect(catalog?.effortsByModel['gpt-6-sol']).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
    });

    it('accepts max for gpt-6-sol and not for gpt-5.5', () => {
      expect(catalog).not.toBeNull();
      expect(catalogAcceptsEffort(catalog!, 'max', 'gpt-5.5')).toBe(false);
      expect(catalogAcceptsEffort(catalog!, 'max', 'gpt-6-sol')).toBe(true);
    });
  });
});

/** A child that speaks app-server's side of the conversation from a script. */
function scriptedAppServer(answer: (method: string, params: Record<string, unknown>) => { result?: unknown; error?: unknown } | undefined): {
  child: CliChildProcess;
  requests: Array<{ method: string; params: Record<string, unknown> }>;
  stopped: () => boolean;
} {
  const stdout = Object.assign(new EventEmitter(), { resume: () => undefined });
  const stderr = Object.assign(new EventEmitter(), { resume: () => undefined });
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  let wasStopped = false;
  const stdin = Object.assign(new EventEmitter(), {
    write: (chunk: string) => {
      const message = JSON.parse(chunk) as { id?: number; method: string; params?: Record<string, unknown> };
      requests.push({ method: message.method, params: message.params ?? {} });
      if (message.id === undefined) return true;
      const reply = answer(message.method, message.params ?? {});
      if (reply !== undefined) setImmediate(() => stdout.emit('data', Buffer.from(`${JSON.stringify({ id: message.id, ...reply })}\n`)));
      return true;
    },
    end: () => undefined,
  });
  // stopTree is what stopCli calls on a process running elsewhere, so the stop
  // never reaches stopChildTree on this pid-less fake.
  const child = Object.assign(new EventEmitter(), {
    exitCode: null, signalCode: null, stdout, stderr, stdin, kill: () => true,
    stopTree: () => { wasStopped = true; },
  }) as unknown as CliChildProcess;
  return { child, requests, stopped: () => wasStopped };
}

describe('readCodexModelCatalog', () => {
  it('initializes, asks model/list without hidden models, follows the cursor, and stops the server', async () => {
    const server = scriptedAppServer((method, params) => {
      if (method === 'initialize') return { result: {} };
      if (params.cursor === 'page-2') return { result: { data: [modelEntry('second')], nextCursor: null } };
      return { result: { data: [modelEntry('first')], nextCursor: 'page-2' } };
    });
    let spawnedArgs: string[] = [];
    let spawnedEnvironment: Record<string, string | undefined> | undefined = { marker: 'unset' };
    const catalog = await readCodexModelCatalog('codex', null, (_cliPath, args, _cwd, environment) => {
      spawnedArgs = args;
      spawnedEnvironment = environment;
      return server.child;
    });
    expect(catalog?.models).toEqual(['first', 'second']);
    expect(spawnedArgs).toEqual(['app-server']);
    // The account's own list: no scratch CODEX_HOME, unlike the hook trust read.
    expect(spawnedEnvironment).toBeUndefined();
    expect(server.requests.map((request) => request.method)).toEqual(['initialize', 'initialized', 'model/list', 'model/list']);
    expect(server.requests[2].params).toEqual({ includeHidden: false });
    expect(server.requests[3].params).toEqual({ includeHidden: false, cursor: 'page-2' });
    expect(server.stopped()).toBe(true);
  });

  it('rejects when model/list answers an error, and still stops the server', async () => {
    const server = scriptedAppServer((method) => (method === 'initialize'
      ? { result: {} }
      : { error: { code: -32600, message: 'not available' } }));
    await expect(readCodexModelCatalog('codex', null, () => server.child)).rejects.toThrow('model/list failed');
    expect(server.stopped()).toBe(true);
  });

  it('rejects when initialize answers an error, and still stops the server', async () => {
    const server = scriptedAppServer(() => ({ error: { code: -32600, message: 'not initialized' } }));
    await expect(readCodexModelCatalog('codex', null, () => server.child)).rejects.toThrow('initialize failed');
    expect(server.requests.map((request) => request.method)).toEqual(['initialize']);
    expect(server.stopped()).toBe(true);
  });

  it('asks for at most five pages when the server keeps naming a next cursor, then resolves with them', async () => {
    const server = scriptedAppServer((method) => (method === 'initialize'
      ? { result: {} }
      : { result: { data: [modelEntry('same-model')], nextCursor: 'more' } }));
    const catalog = await readCodexModelCatalog('codex', null, () => server.child);
    expect(server.requests.filter((request) => request.method === 'model/list')).toHaveLength(5);
    expect(catalog?.models).toEqual(['same-model']);
    expect(server.stopped()).toBe(true);
  });

  it('skips a notification that carries no id, sent before the answers', async () => {
    // The script runs inside a request's write, so each answer is preceded by a notification.
    const server = scriptedAppServer((method) => {
      server.child.stdout.emit('data', Buffer.from(`${JSON.stringify({ method: 'remoteControl/status/changed', params: {} })}\n`));
      return method === 'initialize' ? { result: {} } : { result: { data: [modelEntry('only')], nextCursor: null } };
    });
    const catalog = await readCodexModelCatalog('codex', null, () => server.child);
    expect(catalog?.models).toEqual(['only']);
    expect(server.requests.filter((request) => request.method === 'model/list')).toHaveLength(1);
  });

  it('rejects on its bound when app-server never answers', async () => {
    const server = scriptedAppServer(() => undefined);
    await expect(readCodexModelCatalog('codex', null, () => server.child, 20)).rejects.toThrow('timed out');
    expect(server.stopped()).toBe(true);
  });

  it('rejects when app-server exits before answering', async () => {
    const server = scriptedAppServer(() => undefined);
    const pending = readCodexModelCatalog('codex', null, () => server.child);
    setImmediate(() => server.child.emit('exit', 1, null));
    await expect(pending).rejects.toThrow('exited before answering');
  });
});

describe('catalogAcceptsEffort', () => {
  const catalog: CodexModelCatalog = {
    models: ['model-a', 'model-b'],
    displayNames: {},
    effortLevels: ['low', 'medium', 'high'],
    effortsByModel: { 'model-a': ['low', 'medium'], 'model-b': ['high'] },
  };

  it('holds a listed model to its own levels', () => {
    expect(catalogAcceptsEffort(catalog, 'medium', 'model-a')).toBe(true);
    expect(catalogAcceptsEffort(catalog, 'high', 'model-a')).toBe(false);
    expect(catalogAcceptsEffort(catalog, 'high', ' model-b ')).toBe(true);
  });

  it('takes any listed level for no model or a model the list does not name', () => {
    expect(catalogAcceptsEffort(catalog, 'high', null)).toBe(true);
    expect(catalogAcceptsEffort(catalog, 'low', 'typed-in-model')).toBe(true);
    expect(catalogAcceptsEffort(catalog, 'max', undefined)).toBe(false);
  });

  it('treats a free-text model named like an inherited key as unlisted, without throwing', () => {
    expect(() => catalogAcceptsEffort(catalog, 'low', 'constructor')).not.toThrow();
    expect(catalogAcceptsEffort(catalog, 'low', 'constructor')).toBe(true);
    expect(catalogAcceptsEffort(catalog, 'max', 'toString')).toBe(false);
  });
});

describe('CodexModelCatalogCache', () => {
  const CATALOG: CodexModelCatalog = { models: ['model-a'], displayNames: { 'model-a': 'Model A' }, effortLevels: ['low', 'high'], effortsByModel: { 'model-a': ['low', 'high'] } };

  it('shares one read between an npm shim and the sibling a spawn launches', async () => {
    let reads = 0;
    const cache = new CodexModelCatalogCache(async () => { reads += 1; return CATALOG; });
    cache.start('C:\\Users\\dev\\npm\\codex.cmd');
    await cache.settle(1000);
    cache.start('C:\\Users\\dev\\npm\\codex.ps1');
    expect(reads).toBe(1);
    expect(cache.catalogFor('C:\\Users\\dev\\npm\\codex.ps1')).toEqual(CATALOG);
    expect(cache.isSettled('C:\\Users\\dev\\npm\\codex')).toBe(true);
    expect(cache.catalogFor('/bin/other')).toBeNull();
  });

  it('settle waits for a read in flight, and gives up at its bound', async () => {
    let release: (catalog: CodexModelCatalog) => void = () => undefined;
    const cache = new CodexModelCatalogCache(() => new Promise((resolve) => { release = resolve; }));
    cache.start('/bin/codex');
    await cache.settle(5);
    expect(cache.isSettled('/bin/codex')).toBe(false);
    expect(cache.catalogFor('/bin/codex')).toBeNull();
    const settled = cache.settle(1000);
    release(CATALOG);
    await settled;
    expect(cache.catalogFor('/bin/codex')).toEqual(CATALOG);
  });

  it('reads once per binary, shares the read in flight, and answers display names from it', async () => {
    let reads = 0;
    const cache = new CodexModelCatalogCache(async () => { reads += 1; return CATALOG; });
    cache.start('/bin/codex');
    cache.start('/bin/codex');
    await expect(cache.wait('/bin/codex', 1000)).resolves.toEqual(CATALOG);
    cache.start('/bin/codex');
    expect(reads).toBe(1);
    expect(cache.displayNameOf('model-a')).toBe('Model A');
    expect(cache.displayNameOf('model-z')).toBeNull();
    // Inherited keys of the names table are not display names.
    expect(cache.displayNameOf('constructor')).toBeNull();
    expect(cache.displayNameOf('toString')).toBeNull();
  });

  it('answers null at its bound while a cold read is still running, and the read lands for the next caller', async () => {
    let release: (catalog: CodexModelCatalog) => void = () => undefined;
    const cache = new CodexModelCatalogCache(() => new Promise((resolve) => { release = resolve; }));
    cache.start('/bin/codex');
    await expect(cache.wait('/bin/codex', 5)).resolves.toBeNull();
    release(CATALOG);
    await expect(cache.wait('/bin/codex', 1000)).resolves.toEqual(CATALOG);
  });

  it('reads again after the time to live, or when forced once the last read is a minute old', async () => {
    let now = 0;
    let reads = 0;
    const cache = new CodexModelCatalogCache(async () => { reads += 1; return CATALOG; }, () => now);
    cache.start('/bin/codex');
    await cache.wait('/bin/codex', 1000);
    // A dropdown opened again within the minute spawns no second app-server.
    now += 59_000;
    cache.start('/bin/codex', null, true);
    expect(reads).toBe(1);
    now += 1_000;
    cache.start('/bin/codex', null, true);
    await cache.wait('/bin/codex', 1000);
    expect(reads).toBe(2);
    now += 11 * 60 * 60_000;
    cache.start('/bin/codex');
    expect(reads).toBe(2);
    now += 2 * 60 * 60_000;
    cache.start('/bin/codex');
    await cache.wait('/bin/codex', 1000);
    expect(reads).toBe(3);
  });

  it('keeps the last good list through a failed read, and tries a failed read again after five minutes', async () => {
    let now = 0;
    let fail = false;
    let reads = 0;
    const cache = new CodexModelCatalogCache(async () => {
      reads += 1;
      if (fail) throw new Error('offline');
      return CATALOG;
    }, () => now);
    cache.start('/bin/codex');
    await cache.wait('/bin/codex', 1000);
    fail = true;
    now += 60_000;
    cache.start('/bin/codex', null, true);
    await expect(cache.wait('/bin/codex', 1000)).resolves.toEqual(CATALOG);
    now += 4 * 60_000;
    cache.start('/bin/codex');
    expect(reads).toBe(2);
    now += 2 * 60_000;
    cache.start('/bin/codex');
    await cache.wait('/bin/codex', 1000);
    expect(reads).toBe(3);
  });

  it('answers null for a binary nothing started a read for', async () => {
    const cache = new CodexModelCatalogCache(async () => CATALOG);
    await expect(cache.wait('/bin/other', 1000)).resolves.toBeNull();
  });
});
