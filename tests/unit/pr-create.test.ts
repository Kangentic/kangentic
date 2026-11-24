/**
 * Creating a pull request on GitHub and Azure DevOps, over a stubbed `gh` and `az`:
 * what each CLI is given, where the pull request is created, and which failures an
 * agent can act on (`PRCreateError`) rather than the user.
 */
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  respond: (() => '') as (args: readonly string[], cwd?: string) => string,
  calls: [] as Array<readonly string[]>,
  which: '/usr/bin/cli' as string | Error,
  remotes: [] as readonly string[],
}));

vi.mock('../../src/main/git/git-remotes', () => ({
  readRemoteUrls: async () => state.remotes,
  invalidateRemoteUrlsCache: () => {},
}));
vi.mock('which', () => ({
  default: async () => {
    if (state.which instanceof Error) throw state.which;
    return state.which;
  },
}));
vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>();
  const promisifyCustom = Symbol.for('nodejs.util.promisify.custom');
  const mockExecFile = Object.assign(() => undefined, {
    [promisifyCustom]: async (_file: string, args?: readonly string[], options?: { cwd?: string }) => {
      const raw = Array.isArray(args) ? args : [];
      const argv = raw[0] === '/c' && raw[1] === 'az' ? raw.slice(2) : raw;
      state.calls.push(argv);
      return { stdout: state.respond(argv, options?.cwd), stderr: '' };
    },
  });
  return { ...original, execFile: mockExecFile };
});

const GITHUB = 'git@github.com:Kangentic/kangentic.git';
const AZURE = 'https://dev.azure.com/my-org/My%20Project/_git/my-repo';
const INPUT = { head: 'feature/x', base: 'main', title: 'fix: the login "network" page', body: 'Line one\n\n50% & `code`', draft: false };

function cliFails(stderr: string): never {
  throw Object.assign(new Error(`Command failed: cli --title=${INPUT.title}\n${stderr}`), { stderr, code: 1 });
}

/** Fresh modules: the registry and each client cache what they found. */
async function load() {
  vi.resetModules();
  return {
    registry: await import('../../src/main/pr/pr-registry'),
    errors: await import('../../src/main/pr/shared/pr-errors'),
  };
}

beforeEach(() => {
  state.calls = [];
  state.which = '/usr/bin/cli';
  state.remotes = [GITHUB];
});

const create = (): readonly string[] => {
  const call = state.calls.find((args) => args.includes('create') || args.includes('post'));
  if (!call) throw new Error('nothing was created');
  return call;
};

describe('GitHub', () => {
  it('names the repository and both branches, with the body from a file, and reads the number from the URL', async () => {
    const { registry } = await load();
    let body = '';
    state.respond = (args) => {
      const bodyFile = args.find((value) => value.startsWith('--body-file='));
      if (bodyFile) body = fs.readFileSync(bodyFile.slice('--body-file='.length), 'utf8');
      return 'Creating pull request\nhttps://github.com/Kangentic/kangentic/pull/41\n';
    };
    await expect(registry.createPullRequest('/repo', INPUT)).resolves.toEqual({
      number: 41, url: 'https://github.com/Kangentic/kangentic/pull/41',
    });
    expect(body).toBe(INPUT.body);
    expect(create().filter((value) => !value.startsWith('--body-file='))).toEqual([
      'pr', 'create', '--repo=github.com/Kangentic/kangentic', '--head=feature/x', '--base=main', `--title=${INPUT.title}`,
    ]);
  });

  it('asks for a draft only when the user did', async () => {
    const { registry } = await load();
    state.respond = () => 'https://github.com/Kangentic/kangentic/pull/41';
    await registry.createPullRequest('/repo', { ...INPUT, draft: true });
    expect(create()).toContain('--draft');
  });

  it('hands the agent a refusal, and does not read the title as a sign-in or network failure', async () => {
    const { registry, errors } = await load();
    // The shape gh documents for a refusal: its own prefix, GitHub's sentence, the mutation's name.
    state.respond = () => cliFails('pull request create failed: GraphQL: No commits between main and feature/x (createPullRequest)');
    const failure = await registry.createPullRequest('/repo', INPUT).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(errors.PRCreateError);
    expect(failure).toMatchObject({ output: 'pull request create failed: GraphQL: No commits between main and feature/x (createPullRequest)' });
  });

  it.each([
    ['a sign-in that expired', 'HTTP 401: Bad credentials (https://api.github.com/graphql)\nTry authenticating with:  gh auth login', 'PRResolverUnavailableError'],
    ['a bad token, as gh api prints it', 'gh: Bad credentials (HTTP 401)', 'PRResolverUnavailableError'],
    ['a server error', 'HTTP 502: Bad Gateway', 'PRResolverTransientError'],
    ['no connection, as gh pr create prints it', 'error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com', 'PRResolverTransientError'],
  ])('shows the user %s', async (_what, stderr, name) => {
    const { registry } = await load();
    state.respond = () => cliFails(stderr);
    await expect(registry.createPullRequest('/repo', INPUT)).rejects.toMatchObject({ name });
  });

  it('shows the user a missing gh', async () => {
    const { registry, errors } = await load();
    state.which = new Error('not found');
    await expect(registry.createPullRequest('/repo', INPUT)).rejects.toBeInstanceOf(errors.PRResolverUnavailableError);
    expect(state.calls).toEqual([]);
  });
});

describe('Azure DevOps', () => {
  beforeEach(() => { state.remotes = [AZURE]; });

  it('posts full refs and the draft flag from a file, never on the command line', async () => {
    const { registry } = await load();
    let body: unknown = null;
    state.respond = (args, cwd) => {
      const at = args.indexOf('--body');
      if (at === -1) return '';
      // A bare name in the file's own folder: a temp path never reaches cmd.exe.
      expect(args[at + 1]).toBe('@text.txt');
      body = JSON.parse(fs.readFileSync(path.join(cwd ?? '', 'text.txt'), 'utf8'));
      return '77\n';
    };
    await expect(registry.createPullRequest('/repo', { ...INPUT, draft: true })).resolves.toEqual({
      number: 77, url: 'https://dev.azure.com/my-org/My%20Project/_git/my-repo/pullrequest/77',
    });
    expect(body).toEqual({
      sourceRefName: 'refs/heads/feature/x', targetRefName: 'refs/heads/main', title: INPUT.title, description: INPUT.body, isDraft: true,
    });
    expect(create().join(' ')).not.toContain(INPUT.title);
    expect(create()[create().indexOf('--url') + 1]).toBe('https://dev.azure.com/my-org/My%20Project/_apis/git/repositories/my-repo/pullrequests');
  });

  it.each([
    ['a refusal the agent can act on', 'TF401179: An active pull request for the branch network-fix already exists.', 'PRCreateError'],
    ['a sign-in that expired, for the user', 'ERROR: AADSTS700082: The refresh token has expired', 'PRResolverUnavailableError'],
    ['no connection, for the user', 'ERROR: Failed to connect: ECONNRESET', 'PRResolverTransientError'],
    // Captured from az 2.x on Windows with a host that does not resolve, where nothing names a network.
    ['no connection on Windows, for the user', fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'az-rest-offline-windows.txt'), 'utf8'), 'PRResolverTransientError'],
  ])('reads %s from az alone, not from names in the command line', async (_what, stderr, name) => {
    const { registry } = await load();
    state.respond = (args) => (args.includes('post') ? cliFails(stderr) : '');
    await expect(registry.createPullRequest('/repo', INPUT)).rejects.toMatchObject({ name });
  });
});

describe('where a pull request can be created', () => {
  it('is the primary remote only, since that is where the branch was pushed', async () => {
    const { registry, errors } = await load();
    state.remotes = ['https://git.example.com/team/repo.git', GITHUB];
    await expect(registry.canCreatePullRequest('/repo')).resolves.toBe(false);
    await expect(registry.createPullRequest('/repo', INPUT)).rejects.toBeInstanceOf(errors.PRResolverUnavailableError);
    state.remotes = [GITHUB];
    await expect(registry.canCreatePullRequest('/repo')).resolves.toBe(true);
    expect(state.calls).toEqual([]);
  });
});
