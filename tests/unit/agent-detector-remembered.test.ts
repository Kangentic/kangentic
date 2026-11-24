/**
 * A detection answered from what each CLI file said on an earlier launch.
 *
 * Two things are at stake. A launch where nothing changed must start no CLI to
 * list its agents, and a remembered answer must never be what a spawn reads:
 * OpenCode and Qwen build their command line from the detected version, and a
 * version manager's shim keeps its file identity across an upgrade.
 *
 * Real files and the real store, since the identity of a file on disk is what
 * decides a hit. Only `which` and the version exec are stood in for.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('which', () => ({
  default: vi.fn(),
}));

vi.mock('../../src/main/agent/shared/exec-version', () => ({
  execVersion: vi.fn(),
}));

import which from 'which';
import { AgentDetector, setFirstLiveDetectionListener } from '../../src/main/agent/shared/agent-detector';
import { execVersion } from '../../src/main/agent/shared/exec-version';
import {
  enableAgentProbeStore,
  flushAgentProbeStoreForTests,
  resetAgentProbeStoreForTests,
} from '../../src/main/agent/shared/agent-probe-store';

let root: string;
let storePath: string;
/** What each CLI file prints for its version, by path. */
let outputs: Map<string, string>;

function writeCli(name: string, body: string): string {
  const filePath = path.join(root, name);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, body, { mode: 0o755 });
  return filePath;
}

function makeDetector(): AgentDetector {
  // Only output that starts with a digit is this agent's.
  return new AgentDetector({ binaryName: 'testcli', parseVersion: (raw) => (/^\d/.test(raw.trim()) ? raw.trim() : null) });
}

/** The next launch: the same file on disk, nothing held in memory, a new detector. */
async function relaunch(): Promise<AgentDetector> {
  await flushAgentProbeStoreForTests();
  resetAgentProbeStoreForTests();
  enableAgentProbeStore(storePath);
  vi.mocked(execVersion).mockClear();
  return makeDetector();
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-detector-remembered-'));
  storePath = path.join(root, 'config', 'agent-probe-cache.json');
  outputs = new Map();
  resetAgentProbeStoreForTests();
  enableAgentProbeStore(storePath);
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.mocked(execVersion).mockImplementation((binaryPath: string) =>
    Promise.resolve({ stdout: outputs.get(binaryPath) ?? '', stderr: '' }));
});

afterEach(() => {
  resetAgentProbeStoreForTests();
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('AgentDetector - remembered detection', () => {
  it('answers from the last launch with no version probe, and keeps that answer away from a spawn', async () => {
    const cliPath = writeCli('testcli', 'one');
    outputs.set(cliPath, '1.0.0');
    vi.mocked(which).mockResolvedValue([cliPath] as never);
    await makeDetector().detect(null);

    const detector = await relaunch();
    const remembered = await detector.detect(null, { allowRemembered: true });

    expect(remembered).toMatchObject({ found: true, path: cliPath, version: '1.0.0', remembered: true });
    expect(execVersion).not.toHaveBeenCalled();
    // What a command builder reads: nothing a remembered detection learned.
    expect(detector.getCachedVersion()).toBeNull();
    expect(detector.getCachedVersion(cliPath)).toBeNull();
  });

  it('probes once for a spawn after a remembered answer, and the live answer wins from then on', async () => {
    const cliPath = writeCli('testcli', 'one');
    outputs.set(cliPath, '1.0.0');
    vi.mocked(which).mockResolvedValue([cliPath] as never);
    await makeDetector().detect(null);

    const detector = await relaunch();
    await detector.detect(null, { allowRemembered: true });
    // A version manager's shim: the CLI behind it moved, the file did not.
    outputs.set(cliPath, '2.0.0');

    const live = await detector.detect(null);

    expect(live).toMatchObject({ found: true, path: cliPath, version: '2.0.0' });
    expect(live.remembered).toBeUndefined();
    expect(execVersion).toHaveBeenCalledTimes(1);
    expect(detector.getCachedVersion(cliPath)).toBe('2.0.0');
    await expect(detector.detect(null, { allowRemembered: true })).resolves.toBe(live);
    expect(execVersion).toHaveBeenCalledTimes(1);
  });

  it('says when a CLI it had only remembered is detected for real, once', async () => {
    const cliPath = writeCli('testcli', 'one');
    outputs.set(cliPath, '1.0.0');
    vi.mocked(which).mockResolvedValue([cliPath] as never);
    await makeDetector().detect(null);
    const startedForReal = vi.fn();
    setFirstLiveDetectionListener(startedForReal);

    try {
      const detector = await relaunch();
      // Listing the agent starts nothing, and names no path a spawn should warm up for.
      await detector.detect(null, { allowRemembered: true });
      expect(startedForReal).not.toHaveBeenCalled();
      expect(detector.liveFoundPaths()).toEqual([]);

      // A spawn detects it: whoever listed the remembered answer now reads the CLI.
      await detector.detect(null);
      expect(startedForReal).toHaveBeenCalledTimes(1);
      expect(detector.liveFoundPaths()).toEqual([cliPath]);

      await detector.detect(null);
      await detector.detect(null, { allowRemembered: true });
      expect(startedForReal).toHaveBeenCalledTimes(1);
    } finally {
      setFirstLiveDetectionListener(null);
    }
  });

  it('hands a remembered caller the live result when a live detection started later and finished first', async () => {
    const cliPath = writeCli('testcli', 'one');
    outputs.set(cliPath, '1.0.0');
    vi.mocked(which).mockResolvedValue([cliPath] as never);
    await makeDetector().detect(null);

    const detector = await relaunch();
    // Hold the remembered walk at its PATH lookup so a live detection can overtake it.
    let releaseRememberedLookup: () => void = () => undefined;
    const rememberedLookupGate = new Promise<void>((resolve) => {
      releaseRememberedLookup = resolve;
    });
    vi.mocked(which).mockImplementationOnce((async () => {
      await rememberedLookupGate;
      return [cliPath];
    }) as never);

    const rememberedCall = detector.detect(null, { allowRemembered: true });
    const live = await detector.detect(null);
    expect(live.remembered).toBeUndefined();
    expect(execVersion).toHaveBeenCalledTimes(1);

    releaseRememberedLookup();
    const answeredToRememberedCaller = await rememberedCall;

    // The walk found its answer in the store, but a live one landed first and wins.
    expect(answeredToRememberedCaller).toBe(live);
    expect(answeredToRememberedCaller.remembered).toBeUndefined();
    // A later remembered ask answers live too, with no further probe.
    await expect(detector.detect(null, { allowRemembered: true })).resolves.toBe(live);
    expect(execVersion).toHaveBeenCalledTimes(1);
  });

  it('says nothing for a CLI that was never listed from memory', async () => {
    const cliPath = writeCli('testcli', 'one');
    outputs.set(cliPath, '1.0.0');
    vi.mocked(which).mockResolvedValue([cliPath] as never);
    const startedForReal = vi.fn();
    setFirstLiveDetectionListener(startedForReal);

    try {
      await makeDetector().detect(null);
      expect(startedForReal).not.toHaveBeenCalled();
    } finally {
      setFirstLiveDetectionListener(null);
    }
  });

  it('probes a file that changed since it was last asked', async () => {
    const cliPath = writeCli('testcli', 'one');
    outputs.set(cliPath, '1.0.0');
    vi.mocked(which).mockResolvedValue([cliPath] as never);
    await makeDetector().detect(null);

    const detector = await relaunch();
    fs.writeFileSync(cliPath, 'a new build of the CLI');
    outputs.set(cliPath, '1.1.0');

    const detected = await detector.detect(null, { allowRemembered: true });

    expect(detected).toMatchObject({ found: true, version: '1.1.0' });
    // Every probe of this walk ran, so it is a live detection like any other.
    expect(detected.remembered).toBeUndefined();
    expect(execVersion).toHaveBeenCalledTimes(1);
    expect(detector.getCachedVersion(cliPath)).toBe('1.1.0');
  });

  it('walks past a file remembered as another tool without starting it', async () => {
    const otherTool = writeCli(path.join('first', 'testcli'), 'another vendor');
    const realCli = writeCli(path.join('second', 'testcli'), 'the agent');
    outputs.set(otherTool, 'usage: some other tool');
    outputs.set(realCli, '3.2.1');
    vi.mocked(which).mockResolvedValue([otherTool, realCli] as never);
    await makeDetector().detect(null);
    expect(execVersion).toHaveBeenCalledTimes(2);

    const detector = await relaunch();
    const remembered = await detector.detect(null, { allowRemembered: true });

    expect(remembered).toMatchObject({ found: true, path: realCli, version: '3.2.1', remembered: true });
    expect(execVersion).not.toHaveBeenCalled();
  });

  it('never keeps a probe that failed for a reason that says nothing about the install', async () => {
    const cliPath = writeCli('testcli', 'one');
    // Exit 0 with nothing printed: the boot race, not a different tool.
    outputs.set(cliPath, '');
    vi.mocked(which).mockResolvedValue([cliPath] as never);
    await expect(makeDetector().detect(null)).resolves.toMatchObject({ found: false });

    const detector = await relaunch();
    outputs.set(cliPath, '1.0.0');

    await expect(detector.detect(null, { allowRemembered: true })).resolves.toMatchObject({ found: true, version: '1.0.0' });
    expect(execVersion).toHaveBeenCalledTimes(1);
  });

  it('remembers a configured path the same way', async () => {
    const cliPath = writeCli('custom-cli', 'one');
    outputs.set(cliPath, '4.0.0');
    await makeDetector().detect(cliPath);

    const detector = await relaunch();

    await expect(detector.detect(cliPath, { allowRemembered: true })).resolves.toMatchObject({
      found: true,
      path: cliPath,
      version: '4.0.0',
      remembered: true,
    });
    expect(execVersion).not.toHaveBeenCalled();
    expect(which).not.toHaveBeenCalled();
  });

  it('is a live detection where the store is off', async () => {
    const cliPath = writeCli('testcli', 'one');
    outputs.set(cliPath, '1.0.0');
    vi.mocked(which).mockResolvedValue([cliPath] as never);
    resetAgentProbeStoreForTests();
    const detector = makeDetector();

    const detected = await detector.detect(null, { allowRemembered: true });

    expect(detected).toMatchObject({ found: true, version: '1.0.0' });
    expect(detected.remembered).toBeUndefined();
    expect(execVersion).toHaveBeenCalledTimes(1);
    expect(detector.getCachedVersion(cliPath)).toBe('1.0.0');
    expect(fs.existsSync(storePath)).toBe(false);
  });
});
