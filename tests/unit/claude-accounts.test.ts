import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { claudePlanDisplayName, deriveClaudeAccountState, parseClaudeAuthStatus } from '../../src/main/agent/adapters/claude/accounts';
import { parseKeyFileText } from '../../src/main/accounts/key-file';

describe('deriveClaudeAccountState', () => {
  it('shares onboarding, trust and MCP servers but never the login, caches or the boot canary', () => {
    const source = {
      hasCompletedOnboarding: true,
      oauthAccount: { emailAddress: 'one@example.com' },
      userID: 'default-user',
      cachedUsageUtilization: { five: 1 },
      fullscreenBootPending: { 1234: true },
      projects: { 'C:/repo': { hasTrustDialogAccepted: true, allowedTools: ['Bash'] } },
      mcpServers: { shared: { command: 'npx' } },
    };
    const current = {
      oauthAccount: { emailAddress: 'two@example.com' },
      userID: 'account-user',
      projects: { 'C:/own': { hasTrustDialogAccepted: true }, 'C:/repo': { hasTrustDialogAccepted: true } },
      mcpServers: { mine: { command: 'node' } },
    };
    const next = deriveClaudeAccountState(source, current);
    expect(next.oauthAccount).toEqual({ emailAddress: 'two@example.com' });
    expect(next.userID).toBe('account-user');
    expect(next.cachedUsageUtilization).toBeUndefined();
    expect(next.fullscreenBootPending).toBeUndefined();
    expect(next.hasCompletedOnboarding).toBe(true);
    expect(next.projects).toEqual({
      'C:/own': { hasTrustDialogAccepted: true },
      'C:/repo': { hasTrustDialogAccepted: true, allowedTools: ['Bash'] },
    });
    expect(next.mcpServers).toEqual({ mine: { command: 'node' }, shared: { command: 'npx' } });
  });

  it('keeps a folder trusted in the account even when the default home has not trusted it', () => {
    const next = deriveClaudeAccountState(
      { projects: { 'C:/repo': { hasTrustDialogAccepted: false } } },
      { projects: { 'C:/repo': { hasTrustDialogAccepted: true } } },
    );
    expect(next.projects).toEqual({ 'C:/repo': { hasTrustDialogAccepted: true } });
  });
});

describe('parseClaudeAuthStatus', () => {
  it('reads the signed-in email and plan, never a token', () => {
    const identity = parseClaudeAuthStatus(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'dev@example.com', subscriptionType: 'max' }));
    expect(identity).toEqual({ signedIn: true, email: 'dev@example.com', plan: 'Max', hasSubscription: true });
  });

  it('prefers the plan tier when the CLI reports one', () => {
    expect(parseClaudeAuthStatus(JSON.stringify({ loggedIn: true, email: 'dev@example.com', subscriptionType: 'max', planTier: 'ultra' }))?.plan).toBe('Ultra');
  });

  it('writes a plan tier with a multiplier as words', () => {
    expect(parseClaudeAuthStatus(JSON.stringify({ loggedIn: true, email: 'dev@example.com', planTier: 'max_20x' }))?.plan).toBe('Max 20x');
  });

  it('reads a signed-out answer as signed out', () => {
    expect(parseClaudeAuthStatus(JSON.stringify({ loggedIn: false }))?.signedIn).toBe(false);
  });

  // No answer is not a signed-out answer: reading it as one parked a working account at the
  // bottom of Automatic until the Accounts tab was opened.
  it.each(['not json', '', '[]', 'null', '{}', '{"error":"x"}', '{"loggedIn":"false"}'])('gives no identity for output that is not the CLI answer (%j)', (output) => {
    expect(parseClaudeAuthStatus(output)).toBeNull();
  });

  // Captured from `claude auth status` on 2.1.327 with every personal value replaced: a signed-in
  // home, and an empty home that exits 1 and still prints its answer.
  it('reads both real-shape answers', () => {
    const captured = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'claude-auth-status.json'), 'utf8')) as { signedIn: unknown; signedOut: unknown };
    expect(parseClaudeAuthStatus(JSON.stringify(captured.signedIn))).toEqual({ signedIn: true, email: 'dev@example.com', plan: 'Max 20x', hasSubscription: true });
    expect(parseClaudeAuthStatus(JSON.stringify(captured.signedOut))).toEqual({ signedIn: false, email: null, plan: null, hasSubscription: null });
  });

  it('reports a signed-in account with no plan as having no subscription', () => {
    expect(parseClaudeAuthStatus(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'dev@example.com' }))?.hasSubscription).toBe(false);
  });
});

describe('claudePlanDisplayName', () => {
  it('reads the plan name Claude keeps for the account, and nothing from a file without one', () => {
    expect(claudePlanDisplayName({ oauthAccount: { planDisplayName: 'Ultra', organizationRateLimitTier: 'default_claude_max_20x' } })).toBe('Ultra');
    expect(claudePlanDisplayName({ oauthAccount: { planDisplayName: '' } })).toBeNull();
    expect(claudePlanDisplayName({ oauthAccount: {} })).toBeNull();
    expect(claudePlanDisplayName({})).toBeNull();
    expect(claudePlanDisplayName('not an object')).toBeNull();
  });
});

describe('parseKeyFileText', () => {
  it('keeps the allowed names in file order and ignores comments, blanks and other names', () => {
    const contents = parseKeyFileText("# work account\nexport OPENAI_API_KEY='sk-1'\nOTHER=2\n\nANTHROPIC_API_KEY=\"sk-2\"\nOPENAI_API_KEY=\n", ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY']);
    expect(contents.names).toEqual(['OPENAI_API_KEY', 'ANTHROPIC_API_KEY']);
    expect(contents.values).toEqual({ OPENAI_API_KEY: 'sk-1', ANTHROPIC_API_KEY: 'sk-2' });
  });

  it('takes every name under an allowed prefix, and no other', () => {
    const contents = parseKeyFileText('QWEN_CUSTOM_API_KEY_OPENAI_HOST_1a2b=sk-3\nQWEN_HOME=/elsewhere\nOTHER=1\n', ['OPENAI_API_KEY', 'QWEN_CUSTOM_API_KEY_*']);
    expect(contents.values).toEqual({ QWEN_CUSTOM_API_KEY_OPENAI_HOST_1a2b: 'sk-3' });
  });
});
