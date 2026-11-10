/**
 * `stopClaudeBackgroundSession` runs `claude agents` under the CLAUDE_CONFIG_DIR of the account
 * that holds the conversation (task #1057): the list, the stop and the poll all carry `options.env`.
 */
import { describe, it, expect, vi } from 'vitest';

const runClaudeCli = vi.fn<(cliPath: string, cliArgs: readonly string[], timeoutMs: number, env?: Record<string, string>) => Promise<string>>();
vi.mock('../../src/main/agent/adapters/claude/cli-run', () => ({ runClaudeCli }));

const { stopClaudeBackgroundSession } = await import('../../src/main/agent/adapters/claude/background-sessions');

const SESSION_ID = '11111111-2222-4333-8444-555555555555';
const ACCOUNT_ENV = { CLAUDE_CONFIG_DIR: '/accounts/claude/two' };

describe('stopClaudeBackgroundSession with an account env', () => {
  it('passes options.env to the list, the stop and the poll', async () => {
    const alive = JSON.stringify([{ kind: 'background', id: 'abc123', sessionId: SESSION_ID, pid: 4242 }]);
    const gone = JSON.stringify([{ kind: 'background', id: 'abc123', sessionId: SESSION_ID }]);
    runClaudeCli.mockReset();
    runClaudeCli
      .mockResolvedValueOnce(alive)
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce(gone);

    const stopped = await stopClaudeBackgroundSession({ agentSessionId: SESSION_ID, cliPath: '/usr/bin/claude', env: ACCOUNT_ENV });

    expect(stopped).toBe(true);
    expect(runClaudeCli.mock.calls.map((call) => call[1])).toEqual([['agents', '--json'], ['stop', 'abc123'], ['agents', '--json']]);
    for (const call of runClaudeCli.mock.calls) expect(call[3]).toBe(ACCOUNT_ENV);
  });
});
