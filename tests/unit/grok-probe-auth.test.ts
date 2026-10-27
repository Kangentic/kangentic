/**
 * GrokAdapter.probeAuth() (src/main/agent/adapters/grok/grok-adapter.ts) -
 * the `grok models` exec branch that drives the Settings amber "not
 * authenticated" warning. Every existing cross-agent guard
 * (agent-submission-verifier-shape, agent-summarize-shape, ...) only checks
 * that GrokAdapter *implements* probeAuth with the right shape; none of
 * them exercise the "not authenticated" string match or the exec-failure
 * fallback, so those two branches were unguarded before this file.
 *
 * Kept in its own file (rather than folded into grok-adapter.test.ts)
 * because a module-level `vi.mock('node:child_process', ...)` is
 * file-scoped and would otherwise shadow child_process for every other
 * test in that shared file - the same constraint documented in
 * grok-capability-discovery-help-fallback.test.ts.
 *
 * The probe is handed the CLI path the project detected (agent-list passes
 * `detect()`'s result), so it must run that path, not whatever `grok` is on
 * PATH: a project's own CLI path can name another install.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
  exec: vi.fn(),
}));

vi.mock('node:util', () => ({
  promisify: (fn: unknown) => fn,
}));

import { execFile, exec } from 'node:child_process';
import { GrokAdapter } from '../../src/main/agent/adapters/grok/grok-adapter';

const execMock = exec as unknown as ReturnType<typeof vi.fn>;
const execFileMock = execFile as unknown as ReturnType<typeof vi.fn>;

const CLI_PATH = '/opt/project-grok/bin/grok';

function setModelsOutput(stdout: string): void {
  const result = Promise.resolve({ stdout, stderr: '' });
  execMock.mockReturnValue(result);
  execFileMock.mockReturnValue(result);
}

/** The program the probe started, whichever exec form this platform uses. */
function probedProgram(): string {
  const execCall = execMock.mock.calls[0] as [string] | undefined;
  const execFileCall = execFileMock.mock.calls[0] as [string] | undefined;
  return execCall?.[0] ?? execFileCall?.[0] ?? '';
}

beforeEach(() => {
  execMock.mockReset();
  execFileMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GrokAdapter.probeAuth', () => {
  it('runs `models` on the CLI path it is given', async () => {
    setModelsOutput('grok-4.6\n');
    await new GrokAdapter().probeAuth(CLI_PATH);
    expect(probedProgram()).toContain(CLI_PATH);
    expect(probedProgram().includes('models') || (execFileMock.mock.calls[0]?.[1] as string[] | undefined)?.includes('models')).toBe(true);
  });

  it('returns true when `grok models` succeeds without the "not authenticated" string', async () => {
    setModelsOutput('grok-4.6\ngrok-4-fast\n');
    expect(await new GrokAdapter().probeAuth(CLI_PATH)).toBe(true);
  });

  it('returns false when `grok models` reports the user is not authenticated', async () => {
    setModelsOutput('You are not authenticated. Run `grok login` to continue.\n');
    expect(await new GrokAdapter().probeAuth(CLI_PATH)).toBe(false);
  });

  it('matches the "not authenticated" string case-insensitively', async () => {
    setModelsOutput('NOT AUTHENTICATED\n');
    expect(await new GrokAdapter().probeAuth(CLI_PATH)).toBe(false);
  });

  it('returns null when the `grok models` invocation throws (timeout, ENOENT, ...)', async () => {
    const reject = (): Promise<{ stdout: string }> => {
      const promise = Promise.reject(new Error('ETIMEDOUT')) as Promise<{ stdout: string }>;
      promise.catch(() => {});
      return promise;
    };
    execMock.mockImplementation(reject);
    execFileMock.mockImplementation(reject);
    expect(await new GrokAdapter().probeAuth(CLI_PATH)).toBeNull();
  });
});
