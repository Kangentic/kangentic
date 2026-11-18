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

const { AzureDevOpsImporter } = await import('../../src/main/boards/adapters/azure-devops/client');
const { AzureDevOpsAdapter } = await import('../../src/main/boards/adapters/azure-devops/adapter');
const { isExpectedFailure } = await import('../../src/main/analytics/handled-report');

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

  it('a server code that echoes a project name rethrows unchanged, even when the name reads like a network failure', async () => {
    // TF200016 quotes the project back. "Network Ops" matches az's network
    // pattern, but the server answered, so this is not a dropped connection.
    const original = azFailure('ERROR: TF200016: The following project does not exist: Network Ops. Verify that the name of the project is correct and that the project exists on the specified Azure DevOps Server.');
    state.azAnswer = () => original;

    const error = await fetchRejection(undefined, 'Network Ops');

    expect(error).toBe(original);
    expect(isExpectedFailure(error)).toBe(false);
  });

  it('an unrecognized az failure rethrows unchanged and still reports', async () => {
    const original = azFailure('ERROR: TF51005: The query references a field that does not exist.');
    state.azAnswer = () => original;

    const error = await fetchRejection();

    expect(error).toBe(original);
    expect(isExpectedFailure(error)).toBe(false);
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
