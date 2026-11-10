/**
 * Which agents offer accounts in Settings > Accounts, over the REAL registry.
 *
 * Only what was run on real accounts, or cannot touch a conversation, is enabled. Four more
 * agents have account support built and switched off (`adapters/<agent>/accounts.ts`): they were
 * written from each CLI's source and docs with no second account to run them on. Enabling one is
 * a decision made here, in the same change that adds `accounts` to its adapter, after the proof
 * its `accounts.ts` header names. What a user loses if this goes: an unproven account type
 * reaching them by a stray line.
 */
import { describe, expect, it } from 'vitest';
import { agentRegistry } from '../../src/main/agent/agent-registry';
import { CODEX_ACCOUNT_SUPPORT } from '../../src/main/agent/adapters/codex/accounts';
import { GEMINI_ACCOUNT_SUPPORT } from '../../src/main/agent/adapters/gemini/accounts';
import { GROK_ACCOUNT_SUPPORT } from '../../src/main/agent/adapters/grok/accounts';
import { QWEN_ACCOUNT_SUPPORT } from '../../src/main/agent/adapters/qwen-code/accounts';

/** A folder per account, run with real accounts. */
const FOLDER_ACCOUNT_AGENTS = ['claude'];
/** A key file per account: one more variable in a session's env, so no conversation can move. */
const KEY_FILE_ACCOUNT_AGENTS = ['aider', 'cursor', 'droid', 'warp'];

function agentsDeclaring(kind: 'folder' | 'key-file'): string[] {
  return agentRegistry.list().filter((name) => agentRegistry.get(name)?.accounts?.kind === kind).sort();
}

describe('agents that offer accounts', () => {
  it('are exactly the ones run on real accounts, plus the key-file agents', () => {
    expect(agentsDeclaring('folder')).toEqual(FOLDER_ACCOUNT_AGENTS);
    expect(agentsDeclaring('key-file')).toEqual(KEY_FILE_ACCOUNT_AGENTS);
  });

  it('do not include the four built without a second account, whose support stays ready', () => {
    for (const agent of ['codex', 'gemini', 'grok', 'qwen']) {
      expect(agentRegistry.get(agent)?.accounts, agent).toBeUndefined();
    }
    // Still built, and still marked unproven where a wrong guess would be reported.
    expect([CODEX_ACCOUNT_SUPPORT.unproven, GEMINI_ACCOUNT_SUPPORT.unproven, GROK_ACCOUNT_SUPPORT.unproven]).toEqual([true, true, true]);
    expect(QWEN_ACCOUNT_SUPPORT.kind).toBe('key-file');
  });
});
