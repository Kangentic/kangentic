/**
 * Detection records the file each found CLI path resolved to, so a launch report
 * can say whether that path still resolves to it (`cliIdentitySinceDetection`).
 * Each of the three stages that return a found CLI (override, PATH, fallback)
 * must record, and a failed probe must record nothing. Runs on a real temp file
 * as the CLI; only `which` and the version probe are doubled.
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
import { AgentDetector } from '../../src/main/agent/shared/agent-detector';
import { execVersion } from '../../src/main/agent/shared/exec-version';
import {
  cliIdentitySinceDetection,
  resetDetectedCliIdentities,
} from '../../src/main/agent/shared/cli-identity';

let root: string;
let cliPath: string;

function makeDetector(fallbackPaths: string[] = []): AgentDetector {
  return new AgentDetector({
    binaryName: 'testcli',
    fallbackPaths,
    parseVersion: (raw) => raw.trim() || null,
  });
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-detector-identity-'));
  cliPath = path.join(root, 'testcli');
  fs.writeFileSync(cliPath, '#!/bin/sh\necho 1.2.3\n', { mode: 0o755 });
  resetDetectedCliIdentities();
  vi.mocked(which).mockReset();
  vi.mocked(which).mockResolvedValue(null as unknown as string);
  vi.mocked(execVersion).mockReset();
  vi.mocked(execVersion).mockResolvedValue({ stdout: '1.2.3', stderr: '' });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('AgentDetector records the identity of the CLI it found', () => {
  it('records an override path whose probe succeeds', async () => {
    const result = await makeDetector().detect(cliPath);

    expect(result.found).toBe(true);
    expect(cliIdentitySinceDetection(cliPath)).toBe('same');
  });

  it('records a PATH match whose probe succeeds', async () => {
    vi.mocked(which).mockResolvedValue([cliPath] as unknown as string);

    const result = await makeDetector().detect();

    expect(result).toEqual({ found: true, path: cliPath, version: '1.2.3' });
    expect(cliIdentitySinceDetection(cliPath)).toBe('same');
  });

  it('records a fallback path whose probe succeeds', async () => {
    const result = await makeDetector([cliPath]).detect();

    expect(result).toEqual({ found: true, path: cliPath, version: '1.2.3' });
    expect(cliIdentitySinceDetection(cliPath)).toBe('same');
  });

  it('records nothing for an override whose probe fails', async () => {
    vi.mocked(execVersion).mockResolvedValue({ stdout: '', stderr: '' });

    const result = await makeDetector().detect(cliPath);

    expect(result.found).toBe(false);
    expect(cliIdentitySinceDetection(cliPath)).toBe('unknown');
  });

  it('records nothing for a PATH match whose probe fails', async () => {
    vi.mocked(which).mockResolvedValue([cliPath] as unknown as string);
    vi.mocked(execVersion).mockResolvedValue({ stdout: '', stderr: '' });

    const result = await makeDetector().detect();

    expect(result.found).toBe(false);
    expect(cliIdentitySinceDetection(cliPath)).toBe('unknown');
  });

  it('records nothing for a fallback path whose probe fails', async () => {
    vi.mocked(execVersion).mockResolvedValue({ stdout: '', stderr: '' });

    const result = await makeDetector([cliPath]).detect();

    expect(result.found).toBe(false);
    expect(cliIdentitySinceDetection(cliPath)).toBe('unknown');
  });

  it('reads changed once the recorded file is rewritten after detection', async () => {
    await makeDetector().detect(cliPath);
    fs.writeFileSync(cliPath, '#!/bin/sh\necho 1.2.4 and longer\n');

    expect(cliIdentitySinceDetection(cliPath)).toBe('changed');
  });
});
