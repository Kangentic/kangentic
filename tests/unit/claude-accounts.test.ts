import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CLAUDE_ACCOUNT_SUPPORT,
  claudePlanDisplayName,
  claudeUserConfigParts,
  deriveClaudeAccountState,
  parseClaudeAuthStatus,
} from '../../src/main/agent/adapters/claude/accounts';
import { provisionAccountFolder } from '../../src/main/accounts/account-folder';
import { parseKeyFileText } from '../../src/main/accounts/key-file';

type ClaudeState = Record<string, unknown> & {
  mcpServers: Record<string, Record<string, unknown>>;
  projects: Record<string, Record<string, unknown> & { mcpServers: Record<string, unknown>; allowedTools: string[] }>;
};

/** A state file in the shape Claude writes, every personal value replaced. */
function realisticState(): ClaudeState {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'claude-json-realistic.json'), 'utf8')) as ClaudeState;
}

const SITE = 'C:/Users/dev/Documents/GitHub/site';
const OTHER_APP = 'C:/Users/dev/Documents/GitHub/other-app';

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

  // `{ ...own, ...home }` alone kept a server the home removed in every account for good.
  it('drops a user-scope server the home removed, its last one included, and keeps the account\'s own', () => {
    const current = { mcpServers: { shared: { command: 'npx' }, mine: { command: 'node' } } };
    const removedFromHome = new Set(Object.keys(claudeUserConfigParts({ mcpServers: { shared: { command: 'npx' } } })));

    const stillHasOthers = deriveClaudeAccountState({ mcpServers: { other: { command: 'uvx' } } }, current, { removedFromHome });
    expect(stillHasOthers.mcpServers).toEqual({ mine: { command: 'node' }, other: { command: 'uvx' } });

    // The home's last server: its file has no `mcpServers` left for the merge to visit.
    const hasNoneLeft = deriveClaudeAccountState({ numStartups: 3 }, current, { removedFromHome });
    expect(hasNoneLeft.mcpServers).toEqual({ mine: { command: 'node' } });
    expect(current.mcpServers).toEqual({ shared: { command: 'npx' }, mine: { command: 'node' } });
  });
});

// What decides whether a replaced change is reported. Too little and a lost `claude mcp add` goes
// unsaid; too much and every spawn reports, since Claude rewrites this file on every run.
describe('claudeUserConfigParts', () => {
  const baseline = JSON.stringify(claudeUserConfigParts(realisticState()));

  function changesParts(change: (state: ClaudeState) => void): boolean {
    const state = realisticState();
    change(state);
    return JSON.stringify(claudeUserConfigParts(state)) !== baseline;
  }

  it('names what a user configures: servers at both scopes, each folder\'s approvals, the global config keys', () => {
    expect(changesParts((state) => { state.mcpServers.context7.command = 'uvx'; })).toBe(true);
    expect(changesParts((state) => { state.mcpServers.docs = { type: 'stdio', command: 'npx' }; })).toBe(true);
    expect(changesParts((state) => { state.projects[SITE].mcpServers['e2e-browser'] = { type: 'stdio', command: 'bunx' }; })).toBe(true);
    expect(changesParts((state) => { state.projects[OTHER_APP].mcpServers.docs = { type: 'stdio', command: 'npx' }; })).toBe(true);
    expect(changesParts((state) => { state.projects[SITE].allowedTools.push('Bash(npm test)'); })).toBe(true);
    expect(changesParts((state) => { state.projects[OTHER_APP].enabledMcpjsonServers = ['docs']; })).toBe(true);
    expect(changesParts((state) => { state.projects[OTHER_APP].disabledMcpjsonServers = ['docs']; })).toBe(true);
    expect(changesParts((state) => { state.projects[OTHER_APP].disabledMcpServers = ['docs']; })).toBe(true);
    // Keys Claude's settings reference lists as stored in this file.
    expect(changesParts((state) => { state.autoConnectIde = true; })).toBe(true);
    expect(changesParts((state) => { state.diffTool = 'terminal'; })).toBe(true);
  });

  // Each of these differed between an account folder and the home after one session on
  // Claude Code 2.1.328, with nothing changed by hand.
  it('names nothing Claude writes by itself in a session', () => {
    for (const key of ['numStartups', 'tipsHistory', 'tipLifetimeShownCounts', 'closedIssuesLastChecked', 'githubRepoPaths', 'lastReleaseNotesSeen', 'lastClawdEntranceVersion', 'groveChoiceSeenAt']) {
      expect(changesParts((state) => { state[key] = 'changed in a session'; }), key).toBe(false);
    }
    expect(changesParts((state) => {
      Object.assign(state.projects[SITE], { lastCost: 9.87, lastSessionId: 'another', lastGracefulShutdown: true, lastVersionBase: '2.1.328', history: [], projectOnboardingSeenCount: 2 });
    })).toBe(false);
    // Trust is merged by the derive itself, and a folder only the account has is never replaced.
    expect(changesParts((state) => { state.projects[OTHER_APP].hasTrustDialogAccepted = false; })).toBe(false);
  });

  // Kangentic's trust step approves its own server in every folder it spawns in. On the machine
  // this was measured on that was 6,146 of 6,643 folders, and it made the record 1.4 MB.
  it('leaves out the server Kangentic itself approves in every folder, and keeps one a user approved beside it', () => {
    expect(claudeUserConfigParts({ projects: { [SITE]: { enabledMcpjsonServers: ['kangentic'] } } })).toEqual({});
    const withApproval = claudeUserConfigParts({ projects: { [SITE]: { enabledMcpjsonServers: ['kangentic', 'docs'] } } });
    expect(Object.values(withApproval)).toEqual([['docs']]);
    // Turning that server off in a folder is a person's choice, and stays a part.
    expect(Object.values(claudeUserConfigParts({ projects: { [SITE]: { disabledMcpjsonServers: ['kangentic'] } } }))).toEqual([['kangentic']]);
  });

  it('reads a list in another order as the same list, and an empty list or map as nothing', () => {
    const inOrder = claudeUserConfigParts({ projects: { [SITE]: { allowedTools: ['Bash(npm test)', 'Bash(npm run build)'] } } });
    const reversed = claudeUserConfigParts({ projects: { [SITE]: { allowedTools: ['Bash(npm run build)', 'Bash(npm test)'] } } });
    expect(reversed).toEqual(inOrder);
    // Thousands of folders nobody configured cost the record nothing.
    expect(claudeUserConfigParts({ mcpServers: {}, projects: { [SITE]: { allowedTools: [], mcpServers: {}, enabledMcpjsonServers: [], history: [{ display: 'x' }] } } })).toEqual({});
  });
});

// The same rules through the real entries Claude declares, in a temp home.
describe('a Claude account folder refreshed from the home', () => {
  let root: string;
  let home: string;
  let account: string;

  const provision = () => provisionAccountFolder({ accountFolder: account, defaultHome: home, entries: CLAUDE_ACCOUNT_SUPPORT.sharedEntries });
  const readAccountState = (): ClaudeState => JSON.parse(fs.readFileSync(path.join(account, '.claude.json'), 'utf8')) as ClaudeState;
  const writeAccountState = (state: ClaudeState): void => fs.writeFileSync(path.join(account, '.claude.json'), JSON.stringify(state, null, 2));
  const writeHomeState = (state: Record<string, unknown>): void => fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify(state, null, 2));
  const problemsOf = async (): Promise<Array<{ entry: string; code: string }>> => (await provision()).problems.map(({ entry, code }) => ({ entry, code }));

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-claude-account-'));
    home = path.join(root, 'home');
    account = path.join(root, 'accounts', 'claude', '2');
    fs.mkdirSync(home, { recursive: true });
    writeHomeState(realisticState());
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('reports a local-scope server added from the account in a folder both files have, and not a session\'s own writes', async () => {
    expect(await problemsOf()).toEqual([]);
    // One session on the account: Claude bumps its counters and the folder's last-run numbers.
    const afterSession = readAccountState();
    Object.assign(afterSession, { numStartups: 213, lastReleaseNotesSeen: '2.1.328' });
    Object.assign(afterSession.projects[SITE], { lastCost: 3.21, lastSessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' });
    writeAccountState(afterSession);
    expect(await problemsOf()).toEqual([]);

    // `claude mcp add`, at its default local scope, from a session on the account.
    const withServer = readAccountState();
    withServer.projects[SITE].mcpServers.docs = { type: 'stdio', command: 'npx', args: ['docs-mcp'] };
    writeAccountState(withServer);

    expect(await problemsOf()).toEqual([{ entry: '.claude.json', code: 'change-replaced' }]);
    expect(readAccountState().projects[SITE].mcpServers).toEqual(realisticState().projects[SITE].mcpServers);
    expect(await problemsOf()).toEqual([]);
  });

  it('takes a user-scope server out of the account once the home removes it, and keeps one added on the account', async () => {
    await provision();
    const withOwn = readAccountState();
    withOwn.mcpServers.mine = { type: 'stdio', command: 'node' };
    writeAccountState(withOwn);
    expect(readAccountState().mcpServers).toHaveProperty('context7');
    const withoutServers: Record<string, unknown> = realisticState();
    delete withoutServers.mcpServers;
    writeHomeState(withoutServers);

    expect(await problemsOf()).toEqual([]);
    expect(readAccountState().mcpServers).toEqual({ mine: { type: 'stdio', command: 'node' } });
  });

  it('reports a setting changed on the account that the next copy replaces', async () => {
    fs.writeFileSync(path.join(home, 'settings.json'), '{"theme":"dark"}\n');
    await provision();
    // A status line saved from a session on the account.
    fs.writeFileSync(path.join(account, 'settings.json'), '{"theme":"dark","statusLine":{"type":"command","command":"status.sh"}}\n');

    expect(await problemsOf()).toEqual([{ entry: 'settings.json', code: 'change-replaced' }]);
    expect(fs.readFileSync(path.join(account, 'settings.json'), 'utf8')).toBe('{"theme":"dark"}\n');
  });

  it('keeps a CLAUDE.md the account wrote aside when the home gains one', async () => {
    await provision();
    fs.writeFileSync(path.join(account, 'CLAUDE.md'), 'a memory saved from the account\n');
    expect(await problemsOf()).toEqual([]);
    fs.writeFileSync(path.join(home, 'CLAUDE.md'), 'the memory in the home\n');

    expect(await problemsOf()).toEqual([{ entry: 'CLAUDE.md', code: 'kept-aside' }]);
    const aside = fs.readdirSync(account).filter((name) => name.startsWith('CLAUDE.md.kangentic-kept'));
    expect(aside).toHaveLength(1);
    expect(fs.readFileSync(path.join(account, aside[0]), 'utf8')).toBe('a memory saved from the account\n');
  });
});

describe('parseClaudeAuthStatus', () => {
  it('reads the signed-in email and plan, never a token', () => {
    const identity = parseClaudeAuthStatus(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'dev@example.com', subscriptionType: 'max' }));
    expect(identity).toEqual({ signedIn: true, email: 'dev@example.com', orgId: null, plan: 'Max', hasSubscription: true });
  });

  // With the email the org id names one login, so one email in two organizations is two accounts.
  it('reads the org id the CLI reports with the email', () => {
    expect(parseClaudeAuthStatus(JSON.stringify({ loggedIn: true, email: 'dev@example.com', orgId: 'org-a', subscriptionType: 'max' }))?.orgId).toBe('org-a');
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
    expect(parseClaudeAuthStatus(JSON.stringify(captured.signedIn))).toEqual({
      signedIn: true, email: 'dev@example.com', orgId: '00000000-0000-4000-8000-000000000000', plan: 'Max 20x', hasSubscription: true,
    });
    expect(parseClaudeAuthStatus(JSON.stringify(captured.signedOut))).toEqual({ signedIn: false, email: null, orgId: null, plan: null, hasSubscription: null });
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
