/**
 * The identity rule behind task #1113: which login a row names, and what a read of its home that
 * finds another login means for the list. A `/login` inside a session replaced the agent's own
 * home's login with one a folder account already held, and the tab then listed that login twice
 * while the replaced one was listed nowhere. Pure functions over plain rows.
 */
import { describe, expect, it } from 'vitest';
import { decideIdentity, duplicateLoginRows, oneRowPerLogin, sameLogin } from '../../src/main/accounts/account-identity';
import { automaticOrder, nextAccountWithRoom } from '../../src/main/accounts/account-order';
import type { AgentAccount, AgentAccountStatus } from '../../src/shared/agent-accounts';

const NOW = 1_800_000_000;

function row(id: string, email: string | null, options: { orgId?: string | null; status?: AgentAccountStatus; kind?: AgentAccount['kind']; position?: number; createdAt?: string; usedPercentage?: number } = {}): AgentAccount {
  return {
    id,
    agent: 'claude',
    kind: options.kind ?? 'folder',
    folderPath: options.kind === 'default' ? null : `/accounts/${id}`,
    keyFilePath: null,
    keyNames: [],
    email,
    orgId: options.orgId ?? null,
    plan: 'Ultra',
    status: options.status ?? 'ok',
    position: options.position ?? 1,
    historyPrivate: false,
    lastUsage: options.usedPercentage === undefined ? null : [{
      id: 'seven-day', label: '7d weekly', iconKind: 'period', usedPercentage: options.usedPercentage, resetsAt: NOW + 3600, windowDurationSeconds: 604_800,
    }],
    lastUsageAt: null,
    createdAt: options.createdAt ?? '2026-11-01T00:00:00.000Z',
  };
}

describe('sameLogin', () => {
  it('matches one email ignoring case', () => {
    expect(sameLogin({ email: 'Dev@Example.com', orgId: null }, { email: 'dev@example.com', orgId: null })).toBe(true);
  });

  it('keeps one email in two organizations apart', () => {
    expect(sameLogin({ email: 'dev@example.com', orgId: 'org-a' }, { email: 'dev@example.com', orgId: 'org-b' })).toBe(false);
  });

  // A row stored before org ids existed still matches its own login.
  it('matches when either side has no organization yet', () => {
    expect(sameLogin({ email: 'dev@example.com', orgId: null }, { email: 'dev@example.com', orgId: 'org-a' })).toBe(true);
  });

  it('never matches a missing email', () => {
    expect(sameLogin({ email: null, orgId: null }, { email: null, orgId: null })).toBe(false);
  });
});

describe('decideIdentity', () => {
  const own = row('own', 'a@example.com', { kind: 'default' });
  const listed = row('listed', 'b@example.com');

  it('reads the row\'s own login as unchanged', () => {
    expect(decideIdentity(own, [own, listed], { email: 'A@example.com', orgId: 'org-a' })).toEqual({ kind: 'unchanged' });
  });

  // The incident: the agent's own home now holds a login a folder account holds.
  it('sets the row aside when its home now holds a listed login', () => {
    expect(decideIdentity(own, [own, listed], { email: 'b@example.com', orgId: null })).toEqual({ kind: 'to-listed', listedId: 'listed' });
  });

  it('decides nothing new on a repeated read of the same replaced home', () => {
    const replaced = { ...own, status: 'replaced' as const };
    expect(decideIdentity(replaced, [replaced, listed], { email: 'b@example.com', orgId: null })).toEqual({ kind: 'still-replaced', listedId: 'listed' });
  });

  it('brings a replaced row back when its home holds its own login again', () => {
    const replaced = { ...own, status: 'replaced' as const };
    expect(decideIdentity(replaced, [replaced, listed], { email: 'a@example.com', orgId: null })).toEqual({ kind: 'unchanged' });
  });

  it('moves the old login out when the home now holds a login no row names', () => {
    expect(decideIdentity(own, [own, listed], { email: 'c@example.com', orgId: null })).toEqual({ kind: 'to-new' });
  });

  it('reuses a set-aside row that already names the new login', () => {
    const setAside = row('aside', 'c@example.com', { status: 'replaced' });
    expect(decideIdentity(own, [own, listed, setAside], { email: 'c@example.com', orgId: null })).toEqual({ kind: 'merged', replacedId: 'aside' });
  });

  it('sets aside a row with no login yet whose home holds a listed one', () => {
    const fresh = row('fresh', null, { kind: 'default' });
    expect(decideIdentity(fresh, [fresh, listed], { email: 'b@example.com', orgId: null })).toEqual({ kind: 'already-listed', listedId: 'listed' });
  });

  it('lets a row with no login yet take one no row names', () => {
    const fresh = row('fresh', null, { kind: 'default' });
    expect(decideIdentity(fresh, [fresh, listed], { email: 'c@example.com', orgId: null })).toEqual({ kind: 'first-read' });
  });

  it('treats the same email in another organization as a new login', () => {
    const orgA = row('org-a', 'a@example.com', { orgId: 'org-a' });
    expect(decideIdentity(orgA, [orgA], { email: 'a@example.com', orgId: 'org-b' })).toEqual({ kind: 'to-new' });
  });
});

describe('duplicateLoginRows', () => {
  it('sets the agent\'s own home aside when it holds a login a folder account holds', () => {
    const own = row('own', 'b@example.com', { kind: 'default', createdAt: '2026-10-01T00:00:00.000Z' });
    const folder = row('folder', 'b@example.com', { createdAt: '2026-11-01T00:00:00.000Z' });
    expect(duplicateLoginRows([own, folder]).map((account) => account.id)).toEqual(['own']);
  });

  it('sets the newer of two folder rows aside', () => {
    const older = row('older', 'b@example.com', { createdAt: '2026-10-01T00:00:00.000Z' });
    const newer = row('newer', 'b@example.com', { createdAt: '2026-11-01T00:00:00.000Z' });
    expect(duplicateLoginRows([newer, older]).map((account) => account.id)).toEqual(['newer']);
  });

  it('leaves one email in two organizations alone', () => {
    expect(duplicateLoginRows([row('a', 'a@example.com', { orgId: 'org-a' }), row('b', 'a@example.com', { orgId: 'org-b' })])).toEqual([]);
  });
});

describe('two rows with one login', () => {
  const first = row('first', 'b@example.com', { position: 1, usedPercentage: 99 });
  const second = row('second', 'b@example.com', { position: 2, usedPercentage: 99 });
  const other = row('other', 'c@example.com', { position: 3, usedPercentage: 10 });

  it('ranks the login once under Automatic', () => {
    expect(automaticOrder([first, second, other], NOW).map((account) => account.id)).toEqual(['first', 'other', 'second']);
    expect(oneRowPerLogin([first, second, other]).map((account) => account.id)).toEqual(['first', 'other']);
  });

  // A session at its limit continued onto its own login would hit the same limit at once.
  it('never continues a session onto another row of its own login', () => {
    const roomy = { ...second, lastUsage: [{ ...second.lastUsage![0], usedPercentage: 10 }] };
    expect(nextAccountWithRoom([first, roomy, other], 'first', NOW)?.id).toBe('other');
    expect(nextAccountWithRoom([first, roomy], 'first', NOW)).toBeNull();
  });
});
