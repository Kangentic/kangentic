/**
 * Git on an SSH host for a remote project (#913): every read of its git runs on the host, and an answer that
 * did not come is never an empty one.
 *
 * What a user loses if it breaks: the Changes panel, branch header, blame and history for a task on a host
 * showing nothing (or another repository's files) as if there were no changes, a big diff or file coming back
 * cut short, or this computer's git running inside the empty stand-in folder.
 *
 * The unit blocks run the real resolver, `gitAt` and `openSimpleGit` over a fake host. The block on a real
 * repository runs the real scripts through the real helper command runner with a POSIX shell and git.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HostGit, createRemoteGitResolver } from '../../src/main/remote/host-git';
import { runHostCommand } from '../../src/main/remote/helper/host-command';
import { MAX_FRAME_JSON_BYTES } from '../../src/main/remote/protocol/frame-codec';
import { RemoteGitUnavailableError, remoteGitRunnerFor, setRemoteGitResolver } from '../../src/main/git/remote-git';
import { gitAt } from '../../src/main/git/git-client';
import { openSimpleGit } from '../../src/main/git/simple-git-client';
import { runGitWithTimeout } from '../../src/main/git/git-spawn';
import type { HostCommandRequest, HostCommandResult } from '../../src/main/remote/protocol/messages';

const localGit = vi.hoisted(() => vi.fn(async () => {
  throw new Error('this computer\'s git must not run for a remote project');
}));
vi.mock('../../src/main/utility-process/off-main-exec', () => ({ execFileAsync: localGit }));

let scratch: string;
let shellFolder: string;
const HOST_REPO = '/home/dev/api';

beforeEach(() => {
  localGit.mockClear();
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-host-git-'));
  shellFolder = path.join(scratch, 'shell');
  fs.mkdirSync(path.join(shellFolder, '.kangentic', 'worktrees', '7'), { recursive: true });
});

afterEach(() => {
  setRemoteGitResolver(null);
  fs.rmSync(scratch, { recursive: true, force: true });
});

const reply = (lines: string[], extra: Partial<HostCommandResult> = {}): HostCommandResult => ({ code: 0, stdout: lines.join('\n'), stderr: '', timedOut: false, ...extra });
const b64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64');

/** What the run script prints for a small answer. */
function smallAnswer(stdout: string, code = 0, stderr = ''): HostCommandResult {
  return reply(['KG:code:' + code, 'KG:size:' + Buffer.byteLength(stdout), 'KG:id:git-1-1', 'KG:err:' + b64(stderr), 'KG:out:' + b64(stdout)]);
}

function resolverOver(runCommand: (hostId: string, request: HostCommandRequest) => Promise<HostCommandResult>) {
  return createRemoteGitResolver({
    remoteProjects: () => [{ path: shellFolder, remote: { hostId: 'host-a', path: HOST_REPO } }],
    runCommand,
  });
}

describe('which directories run on a host', () => {
  it('maps the shell folder, a worktree stand-in and a folder below it to the host, and nothing else', async () => {
    const calls: HostCommandRequest[] = [];
    const resolver = resolverOver(async (_hostId, request) => { calls.push(request); return smallAnswer('ok\n'); });

    await resolver(shellFolder)?.run(['status']);
    await resolver(path.join(shellFolder, '.kangentic', 'worktrees', '7'))?.run(['status']);
    await resolver(path.join(shellFolder, '.kangentic', 'worktrees', '7', 'src', 'main'))?.run(['status']);

    expect(calls.map((call) => call.cwd)).toEqual([HOST_REPO, `${HOST_REPO}/.kangentic/worktrees/7`, `${HOST_REPO}/.kangentic/worktrees/7/src/main`]);
    expect(resolver(path.join(scratch, 'elsewhere'))).toBeNull();
    // A sibling whose name only starts like the shell folder's is not under it.
    expect(resolver(`${shellFolder}-copy`)).toBeNull();
  });

  it('picks the project with the longest folder that holds the directory, and the host that project is on', async () => {
    const inner = path.join(shellFolder, 'nested');
    const hosts: string[] = [];
    const resolver = createRemoteGitResolver({
      remoteProjects: () => [
        { path: shellFolder, remote: { hostId: 'host-a', path: '/home/dev/api' } },
        { path: inner, remote: { hostId: 'host-b', path: '/srv/other' } },
      ],
      runCommand: async (hostId) => { hosts.push(hostId); return smallAnswer(''); },
    });
    await resolver(path.join(inner, 'src'))?.run(['status']);
    await resolver(path.join(shellFolder, 'src'))?.run(['status']);
    expect(hosts).toEqual(['host-b', 'host-a']);
  });
});

describe('what is sent to the host', () => {
  it('sends git\'s arguments as arguments of one sh script, never as shell text', async () => {
    const calls: HostCommandRequest[] = [];
    const runner = new HostGit({ hostDirectory: HOST_REPO, runCommand: async (request) => { calls.push(request); return smallAnswer(''); } });
    const hostile = ['log', '--format=%H', '$(touch /tmp/pwned); echo "x"', 'a b', "it's"];
    await runner.run(hostile);

    expect(calls).toHaveLength(1);
    expect(calls[0].file).toBe('sh');
    expect(calls[0].cwd).toBe(HOST_REPO);
    // sh -c <script> <name> <first-chunk-bytes> <git's arguments...>
    expect(calls[0].args.slice(0, 2)).toEqual(['-c', expect.stringContaining('GIT_TERMINAL_PROMPT=0')]);
    expect(calls[0].args.slice(4)).toEqual(hostile);
    expect(calls[0].args[1]).not.toContain('touch /tmp/pwned');
    // Nothing of this computer's environment is sent.
    expect(calls[0].env).toBeUndefined();
  });
});

describe('an answer that did not come is never an empty one', () => {
  const cases: Array<[string, HostCommandResult | Error]> = [
    ['a program that could not start', { code: null, stdout: '', stderr: '', timedOut: false, error: 'The folder /home/dev/api does not exist on this host, so sh was not run.' }],
    ['a timeout', { code: null, stdout: '', stderr: '', timedOut: true }],
    ['a shell that died with no output', { code: 127, stdout: '', stderr: 'sh: git: not found', timedOut: false }],
    ['a script that failed', reply(['KG:error:disk full'], { code: 3 })],
    ['a reply with no exit code in it', reply(['KG:size:0', 'KG:id:git-1-1', 'KG:err:', 'KG:out:'])],
    ['a link that is down', new Error('The link to the host is down.')],
  ];
  for (const [name, outcome] of cases) {
    it(`rejects for ${name}`, async () => {
      const runner = new HostGit({
        hostDirectory: HOST_REPO,
        runCommand: async () => { if (outcome instanceof Error) throw outcome; return outcome; },
      });
      await expect(runner.run(['status'])).rejects.toBeInstanceOf(Error);
    });
  }

  it('rejects when the first reply carries less than the size it says, instead of returning the part', async () => {
    const runner = new HostGit({
      hostDirectory: HOST_REPO,
      runCommand: async () => reply(['KG:code:0', 'KG:size:10', 'KG:id:git-1-1', 'KG:err:', `KG:out:${b64('abc')}`]),
    });
    await expect(runner.run(['show'])).rejects.toBeInstanceOf(RemoteGitUnavailableError);
  });

  it('rejects, and returns nothing, when a later piece of a long answer fails to come', async () => {
    const first = Buffer.alloc(96 * 1024, 97).toString('base64');
    let calls = 0;
    const runner = new HostGit({
      hostDirectory: HOST_REPO,
      runCommand: async () => {
        calls += 1;
        if (calls === 1) return reply(['KG:code:0', 'KG:size:300000', 'KG:id:git-4-5', 'KG:err:', `KG:out:${first}`]);
        return reply(['KG:error:gone'], { code: 3 });
      },
    });
    await expect(runner.run(['show', 'HEAD:big'])).rejects.toThrow('gone');
  });

  it('refuses an id that is not one the script made before it asks for the file', async () => {
    const first = Buffer.alloc(96 * 1024, 97).toString('base64');
    const runner = new HostGit({
      hostDirectory: HOST_REPO,
      runCommand: async () => reply(['KG:code:0', 'KG:size:300000', 'KG:id:../../etc/passwd', 'KG:err:', `KG:out:${first}`]),
    });
    await expect(runner.run(['show'])).rejects.toBeInstanceOf(RemoteGitUnavailableError);
  });
});

describe('gitAt and openSimpleGit for a remote project', () => {
  const standIn = (): string => path.join(shellFolder, '.kangentic', 'worktrees', '7');

  it('run the host\'s git and never this computer\'s, with the local success rule', async () => {
    const seen: string[][] = [];
    setRemoteGitResolver(resolverOver(async (_hostId, request) => {
      const args = request.args.slice(4);
      seen.push(args);
      if (args[0] === 'rev-parse' && args.includes('--verify')) return smallAnswer('', 1, '');
      if (args[0] === 'rev-parse') return smallAnswer('abc123\n');
      if (args[0] === 'checkout') return smallAnswer('', 1, 'error: pathspec did not match');
      return smallAnswer('raw out');
    }));

    const client = gitAt(standIn());
    expect(await client.revparse(['HEAD'])).toBe('abc123');
    expect(await client.raw(['status', '--short'])).toBe('raw out');
    // A non-zero exit with nothing on stderr is a miss, not a failure (as for a local run).
    expect(await client.raw(['rev-parse', '--verify', '--quiet', 'nope'])).toBe('');
    // With stderr it fails, with stdout then stderr as its message.
    await expect(client.raw(['checkout', 'nope'])).rejects.toThrow('pathspec did not match');

    const simple = openSimpleGit(standIn());
    expect(await simple.raw(['log', '-1'])).toBe('raw out');
    expect(await simple.revparse(['--abbrev-ref', 'HEAD'])).toBe('abc123');
    expect(seen.map((args) => args[0])).toEqual(['rev-parse', 'status', 'rev-parse', 'checkout', 'log', 'rev-parse']);
    expect(localGit).not.toHaveBeenCalled();
  });

  it('refuses, with a sentence, a simple-git method the host has no route for, and can still be awaited', async () => {
    setRemoteGitResolver(resolverOver(async () => smallAnswer('')));
    const simple = openSimpleGit(standIn());
    expect(() => simple.status()).toThrow(RemoteGitUnavailableError);
    expect(() => simple.status()).toThrow('not available for a project on a host yet');
    // A thenable client would call `then` when awaited; a throw there would reject the await.
    await expect(Promise.resolve(simple)).resolves.toBeDefined();
    expect(localGit).not.toHaveBeenCalled();
  });

  it('runs a timed git command (a fetch, the repository identity) on the host, failing with the local wording', async () => {
    setRemoteGitResolver(resolverOver(async (_hostId, request) => {
      const args = request.args.slice(4);
      return args[0] === 'fetch' ? smallAnswer('', 1, 'fatal: no remote') : smallAnswer('.git\n');
    }));

    expect(await runGitWithTimeout(standIn(), ['rev-parse', '--git-common-dir'], { timeoutMs: 1000 })).toEqual({ stdout: '.git\n', stderr: '' });
    await expect(runGitWithTimeout(standIn(), ['fetch', 'origin'], { timeoutMs: 1000 })).rejects.toThrow('git fetch origin exited with code 1: fatal: no remote');
    const aborted = new AbortController();
    aborted.abort();
    await expect(runGitWithTimeout(standIn(), ['fetch'], { timeoutMs: 1000, signal: aborted.signal })).rejects.toThrow('aborted before spawn');
    expect(localGit).not.toHaveBeenCalled();
  });

  it('leaves a local directory to this computer\'s git', async () => {
    setRemoteGitResolver(resolverOver(async () => smallAnswer('')));
    const outside = path.join(scratch, 'local-project');
    fs.mkdirSync(outside);
    expect(remoteGitRunnerFor(outside)).toBeNull();
    await expect(gitAt(outside).raw(['status'])).rejects.toThrow('this computer');
    expect(localGit).toHaveBeenCalledTimes(1);
  });
});

const hasShellAndGit = process.platform !== 'win32'
  && spawnSync('sh', ['-c', 'exit 0'], { stdio: 'ignore' }).status === 0
  && spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0
  && spawnSync('base64', ['--version'], { stdio: 'ignore' }).status !== null;

describe.runIf(hasShellAndGit)('on a real repository', () => {
  let repo: string;
  let home: string;
  const replySizes: number[] = [];

  function git(...args: string[]): string {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' } });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
    return result.stdout;
  }

  function hostGit(): HostGit {
    return new HostGit({
      hostDirectory: repo,
      runCommand: async (request) => {
        const result = await runHostCommand(request, { shellPath: '/bin/sh', cwd: request.cwd ?? repo, baseEnv: { ...process.env, HOME: home } });
        replySizes.push(Buffer.byteLength(JSON.stringify({ t: 'reply', id: 1, ok: true, result })));
        return result;
      },
    });
  }

  beforeEach(() => {
    replySizes.length = 0;
    home = path.join(scratch, 'home');
    repo = path.join(home, 'api');
    fs.mkdirSync(repo, { recursive: true });
    git('init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
    git('add', '.');
    git('commit', '-q', '-m', 'first');
  });

  const spooled = (): string[] => {
    const directory = path.join(home, '.kangentic', 'tmp');
    return fs.existsSync(directory) ? fs.readdirSync(directory) : [];
  };

  it('returns a small answer in one round trip, with git\'s exit code and stderr, and leaves nothing on the host', async () => {
    const runner = hostGit();
    const head = await runner.run(['rev-parse', 'HEAD']);
    expect(head.code).toBe(0);
    expect(head.stdout.toString('utf8').trim()).toBe(git('rev-parse', 'HEAD').trim());
    expect(replySizes).toHaveLength(1);

    const missing = await runner.run(['show', 'no-such-ref']);
    expect(missing.code).not.toBe(0);
    expect(missing.stderr).toContain('no-such-ref');
    expect(spooled()).toEqual([]);
  });

  it('brings back a file past one reply byte for byte, in pieces that each fit a frame', async () => {
    const lines = Array.from({ length: 30_000 }, (_unused, index) => `line ${index} ${'x'.repeat(20)}`).join('\n');
    fs.writeFileSync(path.join(repo, 'big.txt'), lines);
    git('add', 'big.txt');
    git('commit', '-q', '-m', 'big');

    const shown = await hostGit().run(['show', 'HEAD:big.txt']);
    expect(shown.stdout.length).toBeGreaterThan(MAX_FRAME_JSON_BYTES);
    expect(shown.stdout.equals(Buffer.from(lines))).toBe(true);
    expect(replySizes.length).toBeGreaterThan(2);
    for (const size of replySizes) expect(size).toBeLessThan(MAX_FRAME_JSON_BYTES);
    expect(spooled()).toEqual([]);
  });

  it('keeps binary bytes whole, an image included, and multi-byte text that a piece boundary falls inside', async () => {
    const image = randomBytes(700_000);
    fs.writeFileSync(path.join(repo, 'logo.png'), image);
    const text = `${'é中😀'.repeat(60_000)}\n`;
    fs.writeFileSync(path.join(repo, 'unicode.txt'), text);
    git('add', '.');
    git('commit', '-q', '-m', 'binary');

    const runner = hostGit();
    expect((await runner.run(['show', 'HEAD:logo.png'])).stdout.equals(image)).toBe(true);
    expect((await runner.run(['show', 'HEAD:unicode.txt'])).stdout.toString('utf8')).toBe(text);
    expect(spooled()).toEqual([]);
  });

  it('passes a hostile argument to git as one argument and runs nothing it names', async () => {
    const marker = path.join(scratch, 'pwned');
    const result = await hostGit().run(['rev-parse', '--verify', `$(touch ${marker})`, '"; touch ' + marker + '; "']);
    expect(result.code).not.toBe(0);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('does not take git\'s optional locks, so a read never blocks the agent\'s own git', async () => {
    fs.writeFileSync(path.join(repo, 'a.txt'), 'changed\n');
    // An index.lock held by someone else would make a locking status fail; the read must not need one.
    fs.writeFileSync(path.join(repo, '.git', 'index.lock'), '');
    const status = await hostGit().run(['status', '--porcelain=v1']);
    expect(status.code).toBe(0);
    expect(status.stdout.toString('utf8')).toContain('a.txt');
  });
});
