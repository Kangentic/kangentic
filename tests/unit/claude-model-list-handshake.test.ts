/**
 * The `initialize` handshake that lists Claude's models
 * (src/main/agent/adapters/claude/model-list-handshake.ts): the mapping from the
 * CLI's rows to aliases and ids, and the one conversation with the process.
 *
 * Fixtures are in tests/fixtures/claude-initialize-models.json, cut from `models`
 * only. No real CLI runs here.
 */
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { mapSupportedModels, readClaudeModelList } from '../../src/main/agent/adapters/claude/model-list-handshake';
import { planModelPickerRows } from '../../src/shared/model-id';
import type { CliChildProcess } from '../../src/main/utility-process/off-main-cli';
import type { spawnCli } from '../../src/main/agent/shared/cli-print';

interface ModelFixtures {
  signedIn: unknown[];
  compact: Record<string, Array<[string, string | null, string]>>;
}

const FIXTURES = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../fixtures/claude-initialize-models.json'), 'utf8'),
) as ModelFixtures;

function rowsOf(caseName: string): unknown[] {
  return FIXTURES.compact[caseName].map(([value, resolvedModel, displayName]) => ({
    value,
    ...(resolvedModel === null ? {} : { resolvedModel }),
    displayName,
  }));
}

function mapped(rows: unknown): NonNullable<ReturnType<typeof mapSupportedModels>> {
  const list = mapSupportedModels(rows);
  if (list === null) throw new Error('expected a list');
  return list;
}

describe('mapSupportedModels', () => {
  it('reads a signed-in list: the aliases, their targets, and every version', () => {
    const list = mapped(FIXTURES.signedIn);
    expect(list.aliases).toEqual([
      { id: 'opus', resolvesTo: 'claude-opus-5-5' },
      { id: 'fable', resolvesTo: 'claude-fable-5-1' },
      { id: 'sonnet', resolvesTo: 'claude-sonnet-5-5' },
      { id: 'haiku', resolvesTo: 'claude-haiku-5-5' },
    ]);
    expect(list.models).toEqual([
      'claude-opus-5-5',
      'claude-fable-5-1',
      'claude-sonnet-5-5',
      'claude-haiku-5-5',
      'claude-haiku-4-5-20251001',
      'claude-sonnet-5',
      'claude-opus-5',
      'claude-fable-5',
      'claude-opus-4-8',
      'claude-opus-4-7',
      'claude-opus-4-6',
      'claude-sonnet-4-6',
    ]);
    // Each has a `claude-` core, so the labels come from the ids.
    expect(list.displayNames).toBeUndefined();
  });

  it('gives a brand-new user the Latest group from a signed-out list', () => {
    const list = mapped(rowsOf('signedOut'));
    expect(list.aliases.map((alias) => alias.id)).toEqual(['opus', 'fable', 'sonnet', 'haiku']);
    const rows = planModelPickerRows(list.models, list.aliases);
    expect(rows.aliasRows).toHaveLength(4);
    expect(rows.topGroups).toEqual([]);
  });

  it('skips the default row, which Kangentic\'s empty value already means', () => {
    const list = mapped(rowsOf('signedOut'));
    expect(list.aliases.map((alias) => alias.id)).not.toContain('default');
    expect(list.models).not.toContain('default');
  });

  it('keeps only haiku as an alias on Bedrock, Vertex and Foundry, where the rest are full ids', () => {
    for (const [caseName, resolvesTo] of [
      ['bedrock', 'us.anthropic.claude-haiku-4-5-20251001-v1:0'],
      ['vertex', 'claude-haiku-4-5@20251001'],
      ['foundry', 'claude-haiku-4-5'],
    ]) {
      const list = mapped(rowsOf(caseName));
      expect(list.aliases).toEqual([{ id: 'haiku', resolvesTo }]);
      expect(list.models).toContain(resolvesTo);
    }
  });

  it('never reads opusplan or a gateway\'s model as an alias, with no list of names', () => {
    const list = mapped([
      { value: 'opusplan', resolvedModel: 'claude-opus-5-5', displayName: 'Opus Plan Mode' },
      { value: 'gateway', resolvedModel: 'gateway', displayName: 'Gateway' },
    ]);
    expect(list.aliases).toEqual([]);
    expect(list.models).toEqual(['opusplan', 'gateway']);
  });

  it('takes the CLI\'s name only for an id with no claude- core', () => {
    const list = mapped(rowsOf('customOption'));
    expect(list.models).toContain('my-gateway-model');
    expect(list.displayNames).toEqual({ 'my-gateway-model': 'My Team Gateway' });
  });

  it('keeps the CLI\'s name for an id that holds claude- mid-word, which is no core', () => {
    const list = mapped([{ value: 'team-claude-proxy', resolvedModel: 'team-claude-proxy', displayName: 'Team Proxy' }]);
    expect(list.models).toEqual(['team-claude-proxy']);
    expect(list.displayNames).toEqual({ 'team-claude-proxy': 'Team Proxy' });
  });

  it('still drops the CLI\'s name for an id wrapped by a provider prefix, whose core is claude-', () => {
    const list = mapped([{ value: 'us.anthropic.claude-opus-5-5', resolvedModel: 'us.anthropic.claude-opus-5-5', displayName: 'Opus' }]);
    expect(list.models).toEqual(['us.anthropic.claude-opus-5-5']);
    expect(list.displayNames).toBeUndefined();
  });

  it('takes a Bedrock ARN as an id, under the CLI\'s name, and keeps a word that resolves to one selectable', () => {
    const arn = 'arn:aws:bedrock:us-west-2:111122223333:inference-profile/custom-7f3a';
    const list = mapped(rowsOf('arnTarget'));
    // An ARN names no family, so `opus` cannot be confirmed as an alias. It stays
    // a value `--model` takes, and the id it resolves to is the CLI's to apply.
    expect(list.aliases).toEqual([]);
    expect(list.models).toEqual(['opus', arn]);
    expect(list.displayNames).toEqual({ opus: 'Opus', [arn]: 'Team profile' });
  });

  it('never takes the CLI\'s name for an alias, which signed in reads as a pinned version', () => {
    expect(mapped([{ value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus 5.5' }]).displayNames).toBeUndefined();
  });

  it('honours an allowlist: only the rows the CLI listed', () => {
    const list = mapped(rowsOf('allowlist'));
    expect(list.aliases.map((alias) => alias.id)).toEqual(['sonnet', 'haiku']);
    expect(list.models).toEqual(['claude-sonnet-5-5', 'claude-haiku-5-5']);
  });

  it('keeps a full id with [1m] as an id, the API-key shape', () => {
    const list = mapped(rowsOf('apiKeyShape'));
    expect(list.models).toContain('claude-fable-5-1[1m]');
    expect(list.aliases.map((alias) => alias.id)).toEqual(['opus', 'sonnet', 'haiku']);
  });

  it('reads opus[1m] as the only Opus alias, with its target as it came', () => {
    const list = mapped(rowsOf('acpLiveShaped'));
    expect(list.aliases).toEqual([
      { id: 'opus[1m]', resolvesTo: 'claude-opus-4-8[1m]' },
      { id: 'sonnet', resolvesTo: 'claude-sonnet-5' },
      { id: 'haiku', resolvesTo: 'claude-haiku-4-5-20251001' },
    ]);
    expect(list.models).toEqual(['claude-opus-4-8[1m]', 'claude-sonnet-5', 'claude-haiku-4-5-20251001']);
  });

  it('keeps sonnet and sonnet[1m] as two aliases when the CLI lists both', () => {
    const list = mapped(rowsOf('acpSonnetDefault'));
    expect(list.aliases).toEqual([
      { id: 'opus', resolvesTo: 'claude-opus-4-6[1m]' },
      { id: 'sonnet', resolvesTo: 'claude-sonnet-5' },
      { id: 'sonnet[1m]', resolvesTo: 'claude-sonnet-5[1m]' },
    ]);
  });

  it('reads an alias whose target is dated or carries a provider prefix', () => {
    const list = mapped(rowsOf('acpDated'));
    expect(list.aliases).toEqual([
      { id: 'haiku', resolvesTo: 'claude-haiku-4-5-20251001' },
      { id: 'sonnet', resolvesTo: 'eu.anthropic.claude-sonnet-5' },
    ]);
  });

  it('counts a bare word with no resolvedModel as an alias with no target', () => {
    const list = mapped(rowsOf('acpNoResolvedModel'));
    // toStrictEqual: `{ id, resolvesTo: undefined }` must not pass for `{ id }`.
    expect(list.aliases).toStrictEqual([{ id: 'opus' }, { id: 'sonnet' }, { id: 'sonnet[1m]' }]);
    expect(list.models).toEqual([]);
  });

  it('drops a row that fails validation and keeps the rest', () => {
    const list = mapped([
      null,
      'opus',
      { value: 42 },
      { value: 'has a space' },
      { value: `claude-${'x'.repeat(300)}` },
      { value: 'claude-opus-4-8', resolvedModel: 'claude-opus-4-8' },
    ]);
    expect(list.models).toEqual(['claude-opus-4-8']);
  });

  it('keeps a __proto__ id as a plain key', () => {
    const list = mapped([{ value: '__proto__', resolvedModel: '__proto__', displayName: 'Planted' }]);
    expect(Object.keys(list.displayNames ?? {})).toEqual(['__proto__']);
  });

  it('is null when no row is usable, which sends discovery to the PTY', () => {
    expect(mapSupportedModels(undefined)).toBeNull();
    expect(mapSupportedModels('models')).toBeNull();
    expect(mapSupportedModels([])).toBeNull();
    expect(mapSupportedModels([{ value: 'default', resolvedModel: 'claude-opus-5-5' }])).toBeNull();
  });
});

class FakeCli extends EventEmitter {
  pid = 4321;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  stdout = Object.assign(new EventEmitter(), { resume: () => undefined });
  stderr = Object.assign(new EventEmitter(), { resume: () => undefined });
  stdin = Object.assign(new EventEmitter(), {
    write: vi.fn((_chunk: string) => true),
    end: vi.fn(),
  });
  kill = vi.fn(() => true);
  stopTree = vi.fn();

  emitLine(line: unknown): void {
    this.stdout.emit('data', Buffer.from(`${typeof line === 'string' ? line : JSON.stringify(line)}\n`));
  }

  exit(code = 0): void {
    this.exitCode = code;
    this.emit('exit', code, null);
  }
}

/** Spawn seam that hands back `child`, and records how it was called. */
function spawnOf(child: FakeCli): ReturnType<typeof vi.fn> & typeof spawnCli {
  return vi.fn(() => child as unknown as CliChildProcess) as unknown as ReturnType<typeof vi.fn> & typeof spawnCli;
}

const CWD = '/scratch/kangentic-model-probe';

function answer(models: unknown, extra: Record<string, unknown> = {}): unknown {
  return {
    type: 'control_response',
    response: { subtype: 'success', request_id: 'kangentic-model-list', response: { models, ...extra } },
  };
}

function read(child: FakeCli, timeoutMs = 1000, exitGraceMs = 5000): Promise<unknown> {
  return readClaudeModelList('/usr/bin/claude', null, CWD, timeoutMs, exitGraceMs, spawnOf(child));
}

describe('readClaudeModelList', () => {
  it('sends initialize with no user message, on the flags measured', async () => {
    const child = new FakeCli();
    const spawn = spawnOf(child);
    const pending = readClaudeModelList('/usr/bin/claude', null, CWD, 1000, 5000, spawn);
    child.emitLine(answer(FIXTURES.signedIn));
    await pending;

    const args = spawn.mock.calls[0][1] as string[];
    expect(args).toEqual(expect.arrayContaining(['-p', '--safe-mode', '--no-session-persistence', '--verbose']));
    expect(args).not.toContain('--bare');
    expect(spawn.mock.calls[0][2]).toBe(CWD);
    expect(child.stdin.write).toHaveBeenCalledTimes(1);
    const request = JSON.parse(String(child.stdin.write.mock.calls[0][0])) as { type: string; request: { subtype: string } };
    expect(request.type).toBe('control_request');
    expect(request.request.subtype).toBe('initialize');
  });

  it('skips other lines, and joins an answer split across chunks', async () => {
    const child = new FakeCli();
    const pending = read(child);
    child.emitLine('not json');
    child.emitLine({ type: 'system', subtype: 'status' });
    child.emitLine({ type: 'control_response', response: { subtype: 'success', request_id: 'another', response: {} } });
    const line = `${JSON.stringify(answer(rowsOf('signedOut')))}\n`;
    child.stdout.emit('data', Buffer.from(line.slice(0, 40)));
    child.stdout.emit('data', Buffer.from(line.slice(40)));

    expect(await pending).toMatchObject({ aliases: [{ id: 'opus' }, { id: 'fable' }, { id: 'sonnet' }, { id: 'haiku' }] });
  });

  it('keeps a multi-byte character whole when a chunk boundary falls inside it', async () => {
    const child = new FakeCli();
    const pending = read(child);
    const line = Buffer.from(
      `${JSON.stringify(answer([{ value: 'my-gateway-model', resolvedModel: 'my-gateway-model', displayName: 'Prüfung' }]))}\n`,
      'utf8',
    );
    // u-umlaut is two bytes (0xC3 0xBC); cut between them.
    const splitAt = line.indexOf(0xc3) + 1;
    child.stdout.emit('data', line.subarray(0, splitAt));
    child.stdout.emit('data', line.subarray(splitAt));

    const list = (await pending) as { displayNames?: Record<string, string> };
    expect(list.displayNames).toEqual({ 'my-gateway-model': 'Prüfung' });
    expect(JSON.stringify(list)).not.toContain('�');
  });

  it('survives a write error on stdin (EPIPE) and rejects on the exit that follows', async () => {
    const child = new FakeCli();
    const pending = read(child);
    // Without a listener an emitted 'error' throws; the handshake must absorb it.
    expect(() => child.stdin.emit('error', new Error('write EPIPE'))).not.toThrow();
    child.exit(1);
    await expect(pending).rejects.toThrow('exited before answering');
  });

  it('accepts an answer with no request_id', async () => {
    const child = new FakeCli();
    const pending = read(child);
    child.emitLine({ type: 'control_response', response: { subtype: 'success', response: { models: rowsOf('allowlist') } } });
    expect(await pending).toMatchObject({ models: ['claude-sonnet-5-5', 'claude-haiku-5-5'] });
  });

  it('carries nothing of the payload but the rows it maps', async () => {
    const child = new FakeCli();
    const warn = vi.spyOn(console, 'warn');
    const pending = read(child);
    child.emitLine(answer(rowsOf('signedOut'), { account: { email: 'dev@example.com', organization: 'Example' } }));
    const list = await pending;

    expect(JSON.stringify(list)).not.toContain('example.com');
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('ends stdin after the answer and does not stop a CLI on its way out', async () => {
    const child = new FakeCli();
    const pending = readClaudeModelList('/usr/bin/claude', null, CWD, 1000, 20, spawnOf(child));
    child.emitLine(answer(rowsOf('signedOut')));
    await pending;

    expect(child.stdin.end).toHaveBeenCalledTimes(1);
    expect(child.stopTree).not.toHaveBeenCalled();
    child.exit();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(child.stopTree).not.toHaveBeenCalled();
  });

  it('stops a CLI that has not left within the grace', async () => {
    const child = new FakeCli();
    const pending = readClaudeModelList('/usr/bin/claude', null, CWD, 1000, 10, spawnOf(child));
    child.emitLine(answer(rowsOf('signedOut')));
    await pending;

    await vi.waitFor(() => expect(child.stopTree).toHaveBeenCalledTimes(1));
  });

  it.each([
    ['a non-success answer', (child: FakeCli) => child.emitLine({
      type: 'control_response',
      response: { subtype: 'error', error: 'Already initialized', request_id: 'kangentic-model-list' },
    }), 'initialize failed'],
    ['a success with no models', (child: FakeCli) => child.emitLine(answer(undefined)), 'answer held no models'],
    ['an exit before answering', (child: FakeCli) => child.exit(1), 'exited before answering'],
    ['a spawn error', (child: FakeCli) => child.emit('error', new Error('spawn failed')), 'spawn failed'],
  ])('fails on %s and stops the run', async (_label, trigger, message) => {
    const child = new FakeCli();
    const pending = read(child);
    trigger(child);
    await expect(pending).rejects.toThrow(message);
    if (child.exitCode === null) expect(child.stopTree).toHaveBeenCalledTimes(1);
  });

  it('fails at the bound and stops the run', async () => {
    const child = new FakeCli();
    await expect(read(child, 5)).rejects.toThrow('timed out');
    expect(child.stopTree).toHaveBeenCalledTimes(1);
  });
});
