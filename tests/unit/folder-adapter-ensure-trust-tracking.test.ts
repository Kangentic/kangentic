/**
 * `ensureTrust` of the Gemini and Qwen adapters asks git whether the folder's settings file is
 * tracked, through the adapter's own command builder, so the synchronous build that follows can
 * choose between the worktree's copy and the project root's. Without that ask a worktree whose
 * file git does not track keeps merging from its stale copy. A host over SSH has no such choice,
 * so nothing is asked there.
 *
 * The trust managers write under the user's home, so they are mocked out. The builders' own
 * tracking read is replaced by a recording stub: what the read does with git is pinned in
 * agent-settings-reads.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import { GeminiAdapter } from '../../src/main/agent/adapters/gemini/gemini-adapter';
import { GeminiCommandBuilder } from '../../src/main/agent/adapters/gemini/command-builder';
import { QwenAdapter } from '../../src/main/agent/adapters/qwen-code/qwen-adapter';
import { QwenCommandBuilder } from '../../src/main/agent/adapters/qwen-code/command-builder';
import type { CliPlace } from '../../src/main/agent/shared/cli-target';

vi.mock('../../src/main/agent/adapters/gemini/trust-manager', () => ({
  ensureWorktreeTrust: vi.fn(async () => undefined),
  removeWorktreeTrust: vi.fn(async () => undefined),
}));
vi.mock('../../src/main/agent/adapters/qwen-code/trust-manager', () => ({
  ensureWorktreeTrust: vi.fn(async () => undefined),
  removeWorktreeTrust: vi.fn(async () => undefined),
}));

const WORKING_DIRECTORY = path.join('/mock', 'project', '.kangentic', 'worktrees', 'task');

const SSH_PLACE: CliPlace = {
  kind: 'ssh',
  hostId: 'host-1',
  home: '/home/dev',
  shellName: 'bash',
  localHome: '',
  roots: [],
};

interface FolderAdapterCase {
  name: string;
  createAdapter: () => { ensureTrust: (workingDirectory: string, place?: CliPlace | null) => Promise<void> };
  trackingRead: () => ReturnType<typeof vi.spyOn>;
}

const CASES: FolderAdapterCase[] = [
  {
    name: 'Gemini',
    createAdapter: () => new GeminiAdapter(),
    trackingRead: () => vi.spyOn(GeminiCommandBuilder.prototype, 'refreshSettingsTracking').mockResolvedValue(undefined),
  },
  {
    name: 'Qwen',
    createAdapter: () => new QwenAdapter(),
    trackingRead: () => vi.spyOn(QwenCommandBuilder.prototype, 'refreshSettingsTracking').mockResolvedValue(undefined),
  },
];

describe.each(CASES)('$name ensureTrust and the settings tracking read', (adapterCase) => {
  let trackingRead: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    trackingRead = adapterCase.trackingRead();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('asks for the working directory\'s tracking before it resolves, with no place or a null one', async () => {
    const adapter = adapterCase.createAdapter();

    await adapter.ensureTrust(WORKING_DIRECTORY);
    expect(trackingRead).toHaveBeenCalledTimes(1);
    expect(trackingRead).toHaveBeenLastCalledWith(WORKING_DIRECTORY);

    await adapter.ensureTrust(WORKING_DIRECTORY, null);
    expect(trackingRead).toHaveBeenCalledTimes(2);
    expect(trackingRead).toHaveBeenLastCalledWith(WORKING_DIRECTORY);
  });

  it('waits for the tracking read to finish', async () => {
    let finishRead: () => void = () => undefined;
    trackingRead.mockImplementation(() => new Promise<void>((resolve) => { finishRead = resolve; }));
    let resolved = false;

    const pending = adapterCase.createAdapter().ensureTrust(WORKING_DIRECTORY).then(() => { resolved = true; });
    await vi.waitFor(() => expect(trackingRead).toHaveBeenCalled());
    await Promise.resolve();
    expect(resolved).toBe(false);

    finishRead();
    await pending;
    expect(resolved).toBe(true);
  });

  it('asks nothing for a host over SSH', async () => {
    await adapterCase.createAdapter().ensureTrust(WORKING_DIRECTORY, SSH_PLACE);

    expect(trackingRead).not.toHaveBeenCalled();
  });
});
