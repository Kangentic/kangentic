/**
 * .claude/rules/board-adapter-coverage.md: a new board ships with the coverage the others have.
 *
 * What goes wrong without it: a board adapter lands with a browser sign-in that nothing watches.
 * GitLab did. Its sign-in depends on an OAuth app registered outside this repository, the daily
 * sign-in check asked about the other three, and the owner steps listed two. An app revoked or a
 * redirect changed is then found by a user in the Connect dialog.
 *
 * Every case runs against the real registry, the real `LoopbackProvider` union and the real check
 * (`runChecks` in scripts/check-integrations.mjs), so a row that exists only on paper does not
 * pass. The union is read from source text because a type leaves nothing to import, and the docs
 * are read as text because the convention spans them. The red cases change that text in memory.
 * No test here sends a request.
 *
 * Tier: Unit.
 */
import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

vi.mock('electron', async () => {
  const { createFakeSafeStorage } = await import('./helpers/fake-safe-storage');
  return {
    app: { isReady: () => true, whenReady: () => Promise.resolve() },
    safeStorage: createFakeSafeStorage({ isAsyncEncryptionAvailable: () => false }),
  };
});

vi.mock('which', () => ({
  default: async () => {
    throw new Error('not found in test');
  },
}));

vi.mock('../../src/main/analytics/usage', () => ({ trackFeatureUsed: vi.fn() }));

import { boardRegistry } from '../../src/main/boards';
import { __testing } from '../../scripts/check-integrations.mjs';

const { readShippedValues, runChecks } = __testing;

type SendRequest = (url: string, init?: RequestInit) => Promise<Response>;
type ShippedValues = ReturnType<typeof readShippedValues>;

const REPO_ROOT = path.resolve(__dirname, '../..');
const LOOPBACK_FILE = 'src/main/boards/shared/loopback-sign-in.ts';
const BOARDS_DOC = 'docs/integrations/boards.md';

function readText(file: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, file), 'utf8').replace(/\r\n/g, '\n');
}

/** The members of the `LoopbackProvider` union: every board that signs in through the browser. */
function loopbackProviders(source: string): string[] {
  const declaration = /^export type LoopbackProvider = ([^;\n]+);$/m.exec(source);
  if (!declaration) {
    throw new Error(`LoopbackProvider is no longer a one-line union in ${LOOPBACK_FILE}. Teach this test its new shape.`);
  }
  return declaration[1].split('|').map((member) => {
    const name = /^'([a-z][a-z0-9-]*)'$/.exec(member.trim())?.[1];
    if (!name) throw new Error(`LoopbackProvider has a member this test cannot read: ${member.trim()}`);
    return name;
  });
}

/** The first table under a `## heading` of the boards doc, as its body rows' cells. */
function tableUnder(doc: string, heading: string): string[][] {
  const marker = `\n## ${heading}\n`;
  const start = doc.indexOf(marker);
  if (start === -1) throw new Error(`${BOARDS_DOC} has no "## ${heading}" section.`);
  const lines = doc.slice(start + marker.length).split('\n');
  const first = lines.findIndex((line) => line.startsWith('|'));
  const nextSection = lines.findIndex((line) => line.startsWith('## '));
  if (first === -1 || (nextSection !== -1 && nextSection < first)) throw new Error(`"## ${heading}" in ${BOARDS_DOC} has no table.`);
  const table: string[] = [];
  for (const line of lines.slice(first)) {
    if (!line.startsWith('|')) break;
    table.push(line);
  }
  // The header row and the separator row are not body rows.
  return table.slice(2).map((row) => row.split('|').slice(1, -1).map((cell) => cell.trim()));
}

/** The providers nothing in `covered` stands for, sorted. */
function uncovered(providers: string[], covered: Iterable<string>): string[] {
  const names = [...covered].map((name) => name.toLowerCase());
  return providers.filter((provider) => !names.some((name) => name === provider || name.startsWith(`${provider} `))).sort();
}

/** The shipped values with every id (each `{ value, source }` field) replaced. */
function withEveryId(values: ShippedValues, id: string): ShippedValues {
  const replaced = Object.entries(values).map(([key, value]) => {
    const isId = typeof value === 'object' && value !== null && 'value' in value && 'source' in value;
    return [key, isId ? { value: id, source: 'this test' } : value];
  });
  return Object.fromEntries(replaced) as ShippedValues;
}

const providers = loopbackProviders(readText(LOOPBACK_FILE));
const boardsDoc = readText(BOARDS_DOC);
const shipped = readShippedValues(REPO_ROOT, {});

describe('every registered board adapter', () => {
  it('has a row in the Adapter Status table', () => {
    const rows = tableUnder(boardsDoc, 'Adapter Status');
    const adapters = boardRegistry.list();
    expect(adapters.length).toBeGreaterThan(5);
    const missing = adapters.filter((adapter) => !rows.some((row) => row[0].startsWith(adapter.displayName))).map((adapter) => adapter.displayName);
    expect(missing, `Add a row to "Adapter Status" in ${BOARDS_DOC} for each of these adapters, saying how it signs in.`).toEqual([]);
    expect(rows.length, `"Adapter Status" in ${BOARDS_DOC} should hold one row per registered adapter.`).toBe(adapters.length);
  });
});

describe('every board that signs in through the browser', () => {
  it('is one of the providers this test reads', () => {
    // If the union stopped being read, every comparison below would pass on an empty list.
    expect(providers).toEqual(expect.arrayContaining(['jira', 'trello', 'linear', 'gitlab']));
    expect(new Set(providers).size).toBe(providers.length);
  });

  it('has a row in the daily check that is pending, and asks its provider nothing, while its id is empty', async () => {
    const asked: string[] = [];
    // kangentic.com before any owner step. Only its own pages may be asked while no id ships.
    const send: SendRequest = async (url) => {
      asked.push(new URL(url).hostname);
      return new Response(JSON.stringify({ error: 'server_error' }), { status: 500, headers: { 'content-type': 'application/json' } });
    };
    const results = await runChecks(withEveryId(shipped, ''), send);
    const pending = new Set(results.filter((result) => result.status === 'pending').map((result) => result.area));
    expect(
      uncovered(providers, pending),
      'A browser sign-in has no pending row in scripts/check-integrations.mjs while its id is empty. Give it a check under an area named for its LoopbackProvider.',
    ).toEqual([]);
    expect([...new Set(asked)], 'A sign-in whose id is empty must send its provider nothing.').toEqual([new URL(shipped.site).hostname]);
  });

  it('has a row in the daily check that fails when its provider does not answer', async () => {
    const send: SendRequest = async () => {
      throw new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND provider.example.test') });
    };
    const results = await runChecks(withEveryId(shipped, 'made-up-id'), send);
    const failed = new Set(results.filter((result) => result.status === 'fail').map((result) => result.area));
    expect(uncovered(providers, failed), 'A browser sign-in whose id is set is not asked about by scripts/check-integrations.mjs.').toEqual([]);
    // No area passes with nothing answering, so no check is decided without asking.
    expect(results.filter((result) => result.status === 'ok')).toEqual([]);
  });

  it('has its owner steps and its probe written down', () => {
    const ownerSteps = tableUnder(boardsDoc, 'Owner steps for the browser sign-ins').map((row) => row[0]);
    const dailyCheck = tableUnder(boardsDoc, 'Daily sign-in check').map((row) => row[0]);
    expect(uncovered(providers, ownerSteps), `Add a row to "Owner steps for the browser sign-ins" in ${BOARDS_DOC}.`).toEqual([]);
    expect(uncovered(providers, dailyCheck), `Add a row to the "Daily sign-in check" table in ${BOARDS_DOC}.`).toEqual([]);
  });
});

describe('the comparisons can fail', () => {
  it('names a provider added to the union with nothing behind it', async () => {
    const source = readText(LOOPBACK_FILE);
    const withAnother = source.replace(/^(export type LoopbackProvider = [^;\n]+);$/m, "$1 | 'asana';");
    expect(withAnother).not.toBe(source);
    const grown = loopbackProviders(withAnother);
    expect(grown).toContain('asana');

    const send: SendRequest = async () => new Response(JSON.stringify({ error: 'server_error' }), { status: 500 });
    const results = await runChecks(withEveryId(shipped, ''), send);
    const pending = new Set(results.filter((result) => result.status === 'pending').map((result) => result.area));
    expect(uncovered(grown, pending)).toEqual(['asana']);
    expect(uncovered(grown, tableUnder(boardsDoc, 'Owner steps for the browser sign-ins').map((row) => row[0]))).toEqual(['asana']);
  });

  it('names a provider whose row left the docs', () => {
    const withoutGitLab = boardsDoc.split('\n').filter((line) => !line.startsWith('| GitLab |') && !line.startsWith('| GitLab client |')).join('\n');
    expect(withoutGitLab).not.toBe(boardsDoc);
    expect(uncovered(providers, tableUnder(withoutGitLab, 'Owner steps for the browser sign-ins').map((row) => row[0]))).toEqual(['gitlab']);
    expect(uncovered(providers, tableUnder(withoutGitLab, 'Daily sign-in check').map((row) => row[0]))).toEqual(['gitlab']);
    expect(tableUnder(withoutGitLab, 'Adapter Status')).toHaveLength(boardRegistry.list().length - 1);
  });

  it('refuses a union or a section it cannot read', () => {
    expect(() => loopbackProviders('export type LoopbackProvider = string;')).toThrow('cannot read');
    expect(() => loopbackProviders('export const nothing = 1;')).toThrow('no longer a one-line union');
    expect(() => tableUnder(boardsDoc, 'No such section')).toThrow('has no "## No such section" section');
  });
});
