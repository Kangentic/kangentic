import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Sentry DESKTOP-47: `az boards query` failed while the Import dialog synced an
 * Azure DevOps source, and the plain Error that escaped `fetchWorkItems`
 * reached Sentry as a code defect. A signed-out az or a dropped connection is
 * the user's environment, so the import fetch now classifies the az failure
 * into `AzUnavailableError` / `AzTransientError`, which `isExpectedFailure`
 * skips, and rethrows anything it does not recognize so a real defect still
 * reports.
 *
 * Drives the real importer and adapter against a mocked `az` binary, the same
 * which/execFile shim as tests/unit/azure-devops-fetch-work-item-ids.test.ts,
 * normalized to argv shape (not platform) per .claude/rules/cross-platform-parity.md.
 */

const state = vi.hoisted(() => ({
  whichResult: '/usr/bin/az' as string | Error,
  /** Per-invocation answer keyed on the normalized argv tail: stdout, or an Error to reject with. */
  azAnswer: (() => '[]') as (args: readonly string[]) => string | Error,
}));

vi.mock('which', () => ({
  default: async () => {
    if (state.whichResult instanceof Error) throw state.whichResult;
    return state.whichResult;
  },
}));

vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>();
  const promisifyCustom = Symbol.for('nodejs.util.promisify.custom');
  const mockExecFile = Object.assign(
    (...mockArgs: unknown[]) => {
      const callback = mockArgs[mockArgs.length - 1];
      if (typeof callback === 'function') callback(null, { stdout: '[]', stderr: '' });
    },
    {
      [promisifyCustom]: async (_file: string, args?: readonly string[] | unknown) => {
        const rawArgs = Array.isArray(args) ? (args as readonly string[]) : [];
        const tailArgs = rawArgs[0] === '/c' && rawArgs[1] === 'az' ? rawArgs.slice(2) : rawArgs;
        const answer = state.azAnswer(tailArgs);
        if (answer instanceof Error) throw answer;
        return { stdout: answer, stderr: '' };
      },
    },
  );
  return { ...original, execFile: mockExecFile };
});

const reportHandledError = vi.hoisted(() => vi.fn());
vi.mock('../../src/main/analytics/error-reporting', () => ({ reportHandledError }));

const { AzureDevOpsImporter } = await import('../../src/main/boards/adapters/azure-devops/client');
const { AzureDevOpsAdapter } = await import('../../src/main/boards/adapters/azure-devops/adapter');
const { isExpectedFailure, sendHandledFailure } = await import('../../src/main/analytics/handled-report');

/** What the IPC wrap sends for `error`: the event, its tags and contexts, serialized. */
function reportOf(error: unknown): { tags: Record<string, string>; serialized: string } {
  reportHandledError.mockReset();
  sendHandledFailure('ipc_handler', error, { channel: 'backlog:importReconcile' });
  const [sent, tags, contexts] = reportHandledError.mock.calls[0] as [Error, Record<string, string>, unknown];
  return { tags, serialized: JSON.stringify([sent.message, sent.stack, tags, contexts]) };
}

/**
 * A rejection shaped like execFile's: the message opens with the whole command
 * line (which carries the WIQL and the user's search text), then az's stderr.
 */
function azFailure(stderr: string, extra: Record<string, unknown> = {}): Error {
  const commandLine = 'Command failed: az boards query --wiql SELECT [System.Id] FROM workitems WHERE [System.Title] CONTAINS \'network login\'';
  return Object.assign(new Error(`${commandLine}\n${stderr}`), { code: 1, killed: false, signal: null, stdout: '', stderr, ...extra });
}

async function rejectionOf(call: () => Promise<unknown>): Promise<unknown> {
  try {
    await call();
  } catch (error: unknown) {
    return error;
  }
  throw new Error('the call resolved, expected a rejection');
}

function fetchRejection(searchQuery?: string, project = 'My Project'): Promise<unknown> {
  return rejectionOf(() => new AzureDevOpsImporter().fetchWorkItems('my-org', project, searchQuery));
}

beforeEach(() => {
  state.whichResult = '/usr/bin/az';
  state.azAnswer = () => '[]';
});

describe('AzureDevOpsImporter.fetchWorkItems - az failure classification', () => {
  it('a signed-out az throws AzUnavailableError, which isExpectedFailure skips', async () => {
    state.azAnswer = () => azFailure("ERROR: Please run 'az login' to setup account.");

    const error = await fetchRejection('network login');

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe('AzUnavailableError');
    expect(isExpectedFailure(error)).toBe(true);
    // The dialog shows the message: az's reason, never the command line.
    expect((error as Error).message).toContain('az login');
    expect((error as Error).message).toContain("ERROR: Please run 'az login' to setup account.");
    expect((error as Error).message).not.toContain('--wiql');
    expect((error as Error).message).not.toContain('Command failed');
  });

  it('an expired refresh token (AADSTS) throws AzUnavailableError', async () => {
    state.azAnswer = () => azFailure('ERROR: AADSTS700082: The refresh token has expired due to inactivity.');

    const error = await fetchRejection();

    expect((error as Error).name).toBe('AzUnavailableError');
    expect(isExpectedFailure(error)).toBe(true);
  });

  it('a timed-out az throws AzTransientError', async () => {
    // execFile kills the child on timeout: killed with no errno. Not
    // `code: 'ETIMEDOUT'`, which isExpectedFailure already skips on its own.
    state.azAnswer = () => azFailure('', { code: null, killed: true, signal: 'SIGTERM' });

    const error = await fetchRejection();

    expect((error as Error).name).toBe('AzTransientError');
    expect(isExpectedFailure(error)).toBe(true);
    // No stderr, so no reason line: the message never falls back to the command line.
    expect((error as Error).message).not.toContain('\n');
    expect((error as Error).message).not.toContain('Command failed');
  });

  it('the reason shown is az\'s ERROR line, not a WARNING printed ahead of it', async () => {
    // CRLF, as az.cmd prints it on Windows.
    state.azAnswer = () => azFailure("WARNING: You have 2 update(s) available. Consider updating your CLI installation with 'az upgrade'\r\nERROR: Please run 'az login' to setup account.\r\n");

    const error = await fetchRejection();

    expect((error as Error).name).toBe('AzUnavailableError');
    expect((error as Error).message).toContain("ERROR: Please run 'az login' to setup account.");
    expect((error as Error).message).not.toContain('WARNING');
    expect((error as Error).message).not.toContain('\r');
  });

  it.each([
    // The coded form, which quotes the project back. "Network Ops" matches az's
    // network pattern, but the server answered, so this is not a dropped connection.
    ['TF200016', 'ERROR: TF200016: The following project does not exist: Network Ops. Verify that the name of the project is correct and that the project exists on the specified Azure DevOps Server.'],
    // What a WIQL naming a missing project actually gets (measured, extension
    // 1.0.2): no code, and az's echo of the clause it refused.
    ['the WIQL answer', "ERROR: The project specified is not found in hierarchy. The error is caused by «'Network Ops'»."],
  ])('a project that is not there (%s) is the user\'s configuration: shown, never reported', async (_label, stderr) => {
    state.azAnswer = () => azFailure(stderr);

    const error = await fetchRejection(undefined, 'Network Ops');

    expect((error as Error).name).toBe('AzProjectNotFoundError');
    expect(isExpectedFailure(error)).toBe(true);
    expect((error as Error).message).toContain('cannot find this project');
    expect((error as Error).message).toContain(stderr.split('\n')[0]);
    expect((error as Error).message).not.toContain('Command failed');
    expect((error as Error).message).not.toContain('--wiql');
  });

  it('a field the process does not have still reports, tagged with its server code and nothing az said', async () => {
    const original = azFailure('ERROR: TF51005: The query references a field that does not exist. The error is caused by «[Acme.Billing.Code]».');
    state.azAnswer = () => original;

    const error = await fetchRejection();

    expect(error).toBe(original);
    expect(isExpectedFailure(error)).toBe(false);
    const report = reportOf(error);
    expect(report.tags.az_server_code).toBe('TF51005');
    expect(report.serialized).not.toContain('Acme');
    expect(report.serialized).not.toContain('references a field');
  });

  // client.ts matches a server code with AZ_SERVER_CODE_PATTERN and handled-report.ts
  // keeps its own copy of the shape (AZ_SERVER_CODE) before it tags a report. This
  // pins the two together on the 6-digit VS form, end to end through the report.
  it('a 6-digit VS server code reaches the report tag intact', async () => {
    const original = azFailure('ERROR: VS402337: The number of work items returned exceeds the size limit of 20000.');
    state.azAnswer = () => original;

    const error = await fetchRejection();

    expect(error).toBe(original);
    expect(isExpectedFailure(error)).toBe(false);
    expect(reportOf(error).tags.az_server_code).toBe('VS402337');
  });

  // Sentry DESKTOP-47's recurrence: the server refuses a time in a WIQL date at
  // day precision, with no TF or VS code. The echo of the refused clause quotes
  // the user's search, which must not read as a sign-in failure or a dropped
  // connection. The terms are ones classifyAzError DOES match ("network" is its
  // transient pattern, "az login" its sign-in pattern), so without the echo
  // strip the first would become AzTransientError and the second
  // AzUnavailableError, and these cases go red.
  it.each(['network', 'az login'])('a code-less WIQL refusal echoing the search "%s" still reports, tagged none, with no stderr text', async (searchTerm) => {
    const original = azFailure(`ERROR: You cannot supply a time with the date when running a query using date precision. The error is caused by «[System.Title] CONTAINS '${searchTerm}' AND [System.ChangedDate] >= '2026-11-10T10:00:00.000Z'».`);
    state.azAnswer = () => original;

    const error = await fetchRejection(searchTerm);

    expect(error).toBe(original);
    expect(isExpectedFailure(error)).toBe(false);
    const report = reportOf(error);
    expect(report.tags.az_server_code).toBe('none');
    expect(report.serialized).not.toContain('date precision');
    expect(report.serialized).not.toContain('ChangedDate');
    expect(report.serialized).not.toContain(searchTerm);
  });

  // The project-gone sentence inside the echoed clause is the user's search, not
  // az's answer. The real answer here is an unrecognized refusal, so it reports.
  it('a search that quotes the project-not-found sentence is not read as a missing project', async () => {
    const original = azFailure("ERROR: The WIQL text is not valid. The error is caused by «[System.Title] CONTAINS 'The project specified is not found in hierarchy'».");
    state.azAnswer = () => original;

    const error = await fetchRejection('The project specified is not found in hierarchy');

    expect((error as Error).name).not.toBe('AzProjectNotFoundError');
    expect(error).toBe(original);
    expect(isExpectedFailure(error)).toBe(false);
    expect(reportOf(error).tags.az_server_code).toBe('none');
  });

  it('a query that matches nothing (az prints nothing) is an empty result, not a failure', async () => {
    state.azAnswer = () => '';

    const result = await new AzureDevOpsImporter().fetchWorkItems('my-org', 'My Project', undefined, undefined, undefined, '2026-11-18T10:00:00.000Z');

    expect(result).toEqual({ items: [], hasNextPage: false, totalCount: 0 });
  });

  // az keeps only the first 1000 work items of a query, so a project with more
  // listed 1000 of them. The fetch pages by id past a full page.
  it('lists every work item past az\'s 1000-item cap', async () => {
    const workItemsFrom = (firstId: number, count: number): string => JSON.stringify(
      Array.from({ length: count }, (_unused, index) => ({ id: firstId + index, url: '', fields: { 'System.Title': `Item ${firstId + index}` } })),
    );
    const wiqlsRun: string[] = [];
    state.azAnswer = (args) => {
      const wiql = args[args.indexOf('--wiql') + 1] ?? '';
      wiqlsRun.push(wiql);
      return wiql.includes('[System.Id] > 1000') ? workItemsFrom(1001, 12) : workItemsFrom(1, 1000);
    };

    const result = await new AzureDevOpsImporter().fetchWorkItems('my-org', 'My Project');

    expect(result.items).toHaveLength(1012);
    expect(result.totalCount).toBe(1012);
    expect(wiqlsRun).toHaveLength(2);
  });

  it('ignores the command line and the URLs az echoes when classifying', async () => {
    // The command line in the message carries the search "network login", which
    // az's sign-in and network patterns would both match. The URL on stderr
    // names an organization called "network-login", which must not match
    // either. Only az's own words name the cause.
    const original = azFailure('ERROR: VS402337: The number of work items returned exceeds the size limit. (https://dev.azure.com/network-login/_apis/wit/wiql)');
    state.azAnswer = () => original;

    const error = await fetchRejection('network login');

    expect(error).toBe(original);
    expect(isExpectedFailure(error)).toBe(false);
  });

  it('az output this module cannot read still reports (only the exec is classified)', async () => {
    state.azAnswer = () => 'not json';

    const error = await fetchRejection();

    expect(error).toBeInstanceOf(SyntaxError);
    expect(isExpectedFailure(error)).toBe(false);
  });

  it('the ids-only fallback fetch classifies its own az failure', async () => {
    state.azAnswer = (args) => {
      if (args[0] === 'boards' && args[1] === 'query') {
        return JSON.stringify([{ id: 7, url: 'https://dev.azure.com/my-org/_apis/wit/workItems/7' }]);
      }
      return azFailure('ERROR: HTTP 503 Service Unavailable');
    };

    const error = await fetchRejection();

    expect((error as Error).name).toBe('AzTransientError');
    expect(isExpectedFailure(error)).toBe(true);
    expect((error as Error).message).toContain('HTTP 503 Service Unavailable');
  });
});

describe('AzureDevOpsAdapter.downloadImages - the token an import download uses', () => {
  it('a signed-out az while importing throws AzUnavailableError', async () => {
    state.azAnswer = () => azFailure("ERROR: Please run 'az login' to setup account.");

    const adapter = new AzureDevOpsAdapter(new AzureDevOpsImporter());
    const error = await rejectionOf(() => adapter.downloadImages('![shot](https://dev.azure.com/my-org/_apis/wit/attachments/abc?fileName=shot.png)'));

    expect((error as Error).name).toBe('AzUnavailableError');
    expect(isExpectedFailure(error)).toBe(true);
  });
});

describe('AzureDevOpsAdapter.fetch - the relations call after the query', () => {
  it('a sign-in that lapses before the relations fetch throws AzUnavailableError', async () => {
    state.azAnswer = (args) => {
      if (args[0] === 'boards' && args[1] === 'query') {
        return JSON.stringify([{
          id: 11,
          url: 'https://dev.azure.com/my-org/_apis/wit/workItems/11',
          fields: { 'System.Title': 'A work item', 'System.State': 'New' },
        }]);
      }
      return azFailure('ERROR: TF400813: The user is not authorized to access this resource.');
    };

    const adapter = new AzureDevOpsAdapter(new AzureDevOpsImporter());
    const error = await rejectionOf(() => adapter.fetch(
      { source: 'azure_devops', repository: 'my-org/My Project', page: 1, perPage: 50 },
      () => new Set<string>(),
    ));

    expect((error as Error).name).toBe('AzUnavailableError');
    expect(isExpectedFailure(error)).toBe(true);
  });
});
