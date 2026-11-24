/**
 * The file that keeps each agent CLI's last answer across launches. Runs on
 * real files: what is under test is what survives a write and a read, and how a
 * replaced CLI looks to `realpath` and `stat`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  enableAgentProbeStore,
  flushAgentProbeStoreForTests,
  isAgentProbeStoreEnabled,
  readProbeFileIdentity,
  recordInventory,
  recordProbe,
  rememberedInventory,
  rememberedProbe,
  resetAgentProbeStoreForTests,
  sameProbeFiles,
  type RememberedProbe,
} from '../../src/main/agent/shared/agent-probe-store';

let root: string;
let storePath: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-probe-store-'));
  storePath = path.join(root, 'config', 'agent-probe-cache.json');
  resetAgentProbeStoreForTests();
});

afterEach(() => {
  resetAgentProbeStoreForTests();
  fs.rmSync(root, { recursive: true, force: true });
});

function writeCli(name: string, body: string): string {
  const filePath = path.join(root, name);
  fs.writeFileSync(filePath, body, { mode: 0o755 });
  return filePath;
}

async function probeOf(cliPath: string, version: string): Promise<RememberedProbe> {
  const identity = await readProbeFileIdentity(cliPath);
  if (!identity) throw new Error(`no identity for ${cliPath}`);
  return {
    detector: 'testcli',
    args: '--version',
    path: cliPath,
    files: [identity],
    outcome: { ok: true, version },
    probedAt: '2026-11-23T00:00:00.000Z',
  };
}

/** A second launch: the same file, nothing held in memory. */
function relaunch(): void {
  resetAgentProbeStoreForTests();
  enableAgentProbeStore(storePath);
}

describe('agent probe store', () => {
  it('is off until main turns it on, and then touches no file', async () => {
    const cliPath = writeCli('testcli', 'one');

    expect(isAgentProbeStoreEnabled()).toBe(false);
    recordProbe(await probeOf(cliPath, '1.0.0'));
    await flushAgentProbeStoreForTests();

    expect(await rememberedProbe({ detector: 'testcli', args: '--version', path: cliPath })).toBeNull();
    expect(fs.existsSync(storePath)).toBe(false);
  });

  it('answers a probe on the next launch', async () => {
    const cliPath = writeCli('testcli', 'one');
    enableAgentProbeStore(storePath);
    recordProbe(await probeOf(cliPath, '1.0.0'));
    recordProbe({ ...(await probeOf(cliPath, 'ignored')), detector: 'othercli', outcome: { ok: false, detail: 'not this agent' } });
    await flushAgentProbeStoreForTests();

    relaunch();

    const remembered = await rememberedProbe({ detector: 'testcli', args: '--version', path: cliPath });
    expect(remembered?.outcome).toEqual({ ok: true, version: '1.0.0' });
    const other = await rememberedProbe({ detector: 'othercli', args: '--version', path: cliPath });
    expect(other?.outcome).toEqual({ ok: false, detail: 'not this agent' });
    // Another detector's answer about the same file is not this detector's.
    expect(await rememberedProbe({ detector: 'thirdcli', args: '--version', path: cliPath })).toBeNull();
  });

  it('reads a replaced file as a different one, and an untouched file as the same', async () => {
    const cliPath = writeCli('testcli', 'version one');
    const before = await readProbeFileIdentity(cliPath);
    const again = await readProbeFileIdentity(cliPath);
    expect(before && again && sameProbeFiles([before], [again])).toBe(true);

    fs.writeFileSync(cliPath, 'version two, a longer file');
    const after = await readProbeFileIdentity(cliPath);

    expect(before && after && sameProbeFiles([before], [after])).toBe(false);
    expect(before && sameProbeFiles([before], [])).toBe(false);
  });

  it('has no identity for a file that is gone', async () => {
    expect(await readProbeFileIdentity(path.join(root, 'missing'))).toBeNull();
  });

  it('reads a damaged file and one written under another schema as empty', async () => {
    const cliPath = writeCli('testcli', 'one');
    fs.mkdirSync(path.dirname(storePath), { recursive: true });

    fs.writeFileSync(storePath, '{ not json');
    enableAgentProbeStore(storePath);
    expect(await rememberedProbe({ detector: 'testcli', args: '--version', path: cliPath })).toBeNull();

    fs.writeFileSync(storePath, JSON.stringify({ schema: 999, probes: [await probeOf(cliPath, '1.0.0')], inventory: [] }));
    relaunch();
    expect(await rememberedProbe({ detector: 'testcli', args: '--version', path: cliPath })).toBeNull();
  });

  it('drops an entry it cannot read and keeps the ones beside it', async () => {
    const cliPath = writeCli('testcli', 'one');
    const good = await probeOf(cliPath, '1.0.0');
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(storePath, JSON.stringify({
      schema: 1,
      probes: [{ ...good, detector: 'broken', outcome: { ok: true, version: '' } }, { ...good, detector: 'nofiles', files: 'none' }, good],
      inventory: [{ agent: 'testcli', path: cliPath, version: 7, readAt: 'x' }],
    }));

    enableAgentProbeStore(storePath);

    expect(await rememberedProbe({ detector: 'testcli', args: '--version', path: cliPath })).toEqual(good);
    expect(await rememberedProbe({ detector: 'broken', args: '--version', path: cliPath })).toBeNull();
    expect(await rememberedProbe({ detector: 'nofiles', args: '--version', path: cliPath })).toBeNull();
    expect(await rememberedInventory({ agent: 'testcli', path: cliPath, version: null })).toBeNull();
  });

  it('drops an inventory entry whose capabilities have a wrong-typed field and keeps the well-formed one beside it', async () => {
    const cliPath = writeCli('testcli', 'one');
    const wellFormedCapabilities = {
      models: ['alpha', 'beta'],
      modelDisplayNames: { alpha: 'Alpha' },
      modelAliases: [{ id: 'fast', resolvesTo: 'alpha' }],
    };
    const entryOf = (agent: string, capabilities: unknown): Record<string, unknown> => (
      { agent, path: cliPath, version: '1.0.0', authenticated: true, capabilities, readAt: '2026-11-23T00:00:00.000Z' }
    );
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(storePath, JSON.stringify({
      schema: 1,
      probes: [],
      inventory: [
        entryOf('models-string', { models: 'x' }),
        entryOf('display-name-number', { modelDisplayNames: { alpha: 7 } }),
        entryOf('alias-without-id', { modelAliases: [{ resolvesTo: 'alpha' }] }),
        entryOf('well-formed', wellFormedCapabilities),
      ],
    }));

    enableAgentProbeStore(storePath);

    for (const agent of ['models-string', 'display-name-number', 'alias-without-id']) {
      expect(await rememberedInventory({ agent, path: cliPath, version: '1.0.0' })).toBeNull();
    }
    const kept = await rememberedInventory({ agent: 'well-formed', path: cliPath, version: '1.0.0' });
    expect(kept?.capabilities).toEqual(wellFormedCapabilities);
  });

  it('keeps an answer recorded before the file was read over the file\'s older one', async () => {
    const cliPath = writeCli('testcli', 'one');
    enableAgentProbeStore(storePath);
    recordProbe(await probeOf(cliPath, '1.0.0'));
    await flushAgentProbeStoreForTests();

    relaunch();
    recordProbe(await probeOf(cliPath, '2.0.0'));

    const remembered = await rememberedProbe({ detector: 'testcli', args: '--version', path: cliPath });
    expect(remembered?.outcome).toEqual({ ok: true, version: '2.0.0' });
  });

  it('keeps an agent\'s sign-in state and capabilities per path and version', async () => {
    const cliPath = writeCli('testcli', 'one');
    const otherPath = writeCli('othercli', 'two');
    // A model id is text the CLI printed, and this one is a property name a careless copy would follow.
    const modelDisplayNames = JSON.parse('{"__proto__":"Proto","fast-1":"Fast 1"}') as Record<string, string>;
    enableAgentProbeStore(storePath);
    recordInventory({
      agent: 'testcli',
      path: cliPath,
      version: '1.0.0',
      authenticated: false,
      capabilities: { supportsModelOverride: true, models: ['__proto__', 'fast-1'], modelDisplayNames },
      readAt: '2026-11-23T00:00:00.000Z',
    });
    recordInventory({ agent: 'testcli', path: otherPath, version: '1.0.0', readAt: '2026-11-23T00:00:00.000Z' });
    await flushAgentProbeStoreForTests();

    relaunch();

    const remembered = await rememberedInventory({ agent: 'testcli', path: cliPath, version: '1.0.0' });
    expect(remembered?.authenticated).toBe(false);
    expect(remembered?.capabilities?.models).toEqual(['__proto__', 'fast-1']);
    expect(Object.keys(remembered?.capabilities?.modelDisplayNames ?? {})).toEqual(['__proto__', 'fast-1']);
    expect(Object.getPrototypeOf(remembered?.capabilities?.modelDisplayNames)).toBe(Object.prototype);
    // The other path's entry has no sign-in check and no capabilities, and is its own entry.
    const other = await rememberedInventory({ agent: 'testcli', path: otherPath, version: '1.0.0' });
    expect(other).toEqual({ agent: 'testcli', path: otherPath, version: '1.0.0', readAt: '2026-11-23T00:00:00.000Z' });
    // Another version of the same CLI was never read.
    expect(await rememberedInventory({ agent: 'testcli', path: cliPath, version: '2.0.0' })).toBeNull();
  });

  it('replaces an agent\'s entry at a path when its version moves', async () => {
    const cliPath = writeCli('testcli', 'one');
    enableAgentProbeStore(storePath);
    recordInventory({ agent: 'testcli', path: cliPath, version: '1.0.0', authenticated: true, readAt: '2026-11-23T00:00:00.000Z' });
    recordInventory({ agent: 'testcli', path: cliPath, version: '2.0.0', authenticated: true, readAt: '2026-11-23T00:01:00.000Z' });
    await flushAgentProbeStoreForTests();

    relaunch();

    expect(await rememberedInventory({ agent: 'testcli', path: cliPath, version: '1.0.0' })).toBeNull();
    expect((await rememberedInventory({ agent: 'testcli', path: cliPath, version: '2.0.0' }))?.authenticated).toBe(true);
    const written = JSON.parse(fs.readFileSync(storePath, 'utf8')) as { inventory: unknown[] };
    expect(written.inventory).toHaveLength(1);
  });
});
