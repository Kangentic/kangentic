/**
 * The MCP connection check (`mcp-connection-check.ts`): loopback first, the
 * URL every agent on this machine gets, then each WSL distro a CLI path points
 * into, the way that distro's CLI reaches the server. A failure is the error
 * the check hit, never a diagnosis. Every outside call is injected, so this
 * runs on every OS without wsl.exe or a server.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  checkMcpConnection,
  wslDistrosOfCliPaths,
  type McpConnectionCheckDeps,
  type McpConnectionCheckInput,
} from '../../src/main/agent/mcp-connection-check';
import type { McpHttpServerHandle } from '../../src/main/agent/mcp-http-server';
import type { WslDistroFacts } from '../../src/main/agent/shared/wsl-distro';

const TOKEN = 'a'.repeat(64);
const HANDLE: McpHttpServerHandle = {
  baseUrl: 'http://127.0.0.1:4100/mcp',
  token: TOKEN,
  urlForProject: (projectId) => `http://127.0.0.1:4100/mcp/${projectId}`,
  close: () => undefined,
};

function facts(networkingMode: WslDistroFacts['networkingMode']): WslDistroFacts {
  return { distro: 'Ubuntu', homeLinux: '/home/dev', homeUnc: '\\\\wsl.localhost\\Ubuntu\\home\\dev', uncRoot: '\\\\wsl.localhost\\Ubuntu', interactivePath: '/usr/bin', env: {}, networkingMode };
}

function deps(overrides: Partial<McpConnectionCheckDeps> = {}): McpConnectionCheckDeps {
  return {
    fetchImplementation: vi.fn(async () => new Response('{"jsonrpc":"2.0","id":1,"result":{}}', { status: 200 })) as unknown as typeof fetch,
    runWsl: vi.fn(async () => ({ stdout: '{"jsonrpc":"2.0","id":1,"result":{}}\n', stderr: '' })),
    isDistroRunning: vi.fn(async () => true),
    resolveFacts: vi.fn(async () => facts('nat')),
    makeTemporaryDirectory: async () => fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-mcp-check-test-')),
    startRelay: vi.fn(() => ({ close: vi.fn() })),
    ...overrides,
  };
}

function input(overrides: Partial<McpConnectionCheckInput> = {}): McpConnectionCheckInput {
  return { handle: HANDLE, startFailure: null, projectId: 'project-1', distros: [], startStoppedDistros: false, ...overrides };
}

describe('the loopback step', () => {
  it('posts an authenticated initialize to the open project\'s URL', async () => {
    const injected = deps();
    expect(await checkMcpConnection(input(), injected)).toEqual({ connected: true });

    const [url, init] = vi.mocked(injected.fetchImplementation).mock.calls[0];
    expect(url).toBe('http://127.0.0.1:4100/mcp/project-1');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({ 'X-Kangentic-Token': TOKEN });
    expect(JSON.parse(String(init?.body))).toMatchObject({ method: 'initialize' });
  });

  it('reports the start error when the server never started', async () => {
    expect(await checkMcpConnection(input({ handle: null, startFailure: 'listen EADDRNOTAVAIL: address not available 10.0.0.5' }), deps()))
      .toEqual({ connected: false, error: 'listen EADDRNOTAVAIL: address not available 10.0.0.5' });
  });

  it('reads a 404 for the no-project id as reached, since the server answers it only after the token check', async () => {
    const injected = deps({ fetchImplementation: vi.fn(async () => new Response('', { status: 404 })) as unknown as typeof fetch });
    expect(await checkMcpConnection(input({ projectId: null }), injected)).toEqual({ connected: true });
    expect(vi.mocked(injected.fetchImplementation).mock.calls[0][0]).toBe('http://127.0.0.1:4100/mcp/connection-check');
  });

  it('reports a refused status with the URL it hit', async () => {
    const injected = deps({ fetchImplementation: vi.fn(async () => new Response('', { status: 401 })) as unknown as typeof fetch });
    expect(await checkMcpConnection(input(), injected)).toEqual({ connected: false, error: 'HTTP 401 from http://127.0.0.1:4100/mcp/project-1' });
  });

  it('reports a connection failure with its cause, and checks no distro after it', async () => {
    const injected = deps({
      fetchImplementation: vi.fn(async () => {
        throw new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED 127.0.0.1:4100') });
      }) as unknown as typeof fetch,
    });
    expect(await checkMcpConnection(input({ distros: ['Ubuntu'] }), injected))
      .toEqual({ connected: false, error: 'fetch failed: connect ECONNREFUSED 127.0.0.1:4100' });
    expect(injected.runWsl).not.toHaveBeenCalled();
  });
});

describe('the step from a WSL distro', () => {
  // Red-green: running the bridge with the token in its arguments fails the
  // argv assertion; checking a stopped distro on a check nobody asked for
  // fails the skip case.
  it('runs the bridge with an initialize on NAT networking, the token through WSLENV, never argv', async () => {
    const injected = deps();
    expect(await checkMcpConnection(input({ distros: ['Ubuntu'] }), injected)).toEqual({ connected: true });

    const [args, env] = vi.mocked(injected.runWsl).mock.calls[0];
    expect(args.slice(0, 4)).toEqual(['-d', 'Ubuntu', '-e', 'sh']);
    expect(args).toContain('http://127.0.0.1:4100/mcp/project-1');
    expect(args.some((arg) => arg.endsWith('/wsl-hooks/wsl-hook.sh'))).toBe(true);
    expect(args.join(' ')).not.toContain(TOKEN);
    expect(env.KANGENTIC_MCP_TOKEN).toBe(TOKEN);
    expect(env.WSLENV?.split(':')).toContain('KANGENTIC_MCP_TOKEN/u');
    expect(injected.startRelay).toHaveBeenCalledTimes(1);
  });

  it('reports the bridge\'s error answer, naming the distro', async () => {
    const injected = deps({ runWsl: vi.fn(async () => ({ stdout: '{"jsonrpc":"2.0","id":1,"error":{"code":-32603,"message":"HTTP 401"}}\n', stderr: '' })) });
    expect(await checkMcpConnection(input({ distros: ['Ubuntu'] }), injected)).toEqual({ connected: false, error: 'From Ubuntu: HTTP 401' });
  });

  it('reports what wsl.exe printed when it fails, and that it gave no answer when it times out', async () => {
    const printed = deps({ runWsl: vi.fn(async () => { throw Object.assign(new Error('Command failed'), { stderr: 'There is no distribution with the supplied name.\r\n' }); }) });
    expect(await checkMcpConnection(input({ distros: ['Ubuntu'] }), printed))
      .toEqual({ connected: false, error: 'From Ubuntu: There is no distribution with the supplied name.' });

    const silent = deps({ runWsl: vi.fn(async () => { throw Object.assign(new Error('Command failed'), { killed: true }); }) });
    expect(await checkMcpConnection(input({ distros: ['Ubuntu'] }), silent))
      .toEqual({ connected: false, error: 'From Ubuntu: wsl.exe gave no answer in 30 s.' });
  });

  // Measured against a real wsl.exe: the facts read's error carries the raw
  // exec error as its cause, whose message is the whole command line.
  it('reports a distro whose facts cannot be read in the distro\'s own words, without the command line', async () => {
    const injected = deps({
      resolveFacts: vi.fn(async () => {
        throw new Error('There is no distribution with the supplied name.', { cause: new Error('Command failed: wsl.exe -d NoSuchDistro -e sh -c ...') });
      }),
    });
    expect(await checkMcpConnection(input({ distros: ['NoSuchDistro'] }), injected))
      .toEqual({ connected: false, error: 'From NoSuchDistro: There is no distribution with the supplied name.' });
  });

  it('dials the loopback port from inside the distro on mirrored networking, the port as an argument', async () => {
    const injected = deps({ resolveFacts: vi.fn(async () => facts('mirrored')) });
    expect(await checkMcpConnection(input({ distros: ['Ubuntu'] }), injected)).toEqual({ connected: true });

    const [args] = vi.mocked(injected.runWsl).mock.calls[0];
    expect(args).toEqual(['-d', 'Ubuntu', '-e', 'bash', '-c', 'exec 3<>"/dev/tcp/127.0.0.1/$1"', 'bash', '4100']);
    expect(injected.startRelay).not.toHaveBeenCalled();
  });

  it('skips a stopped distro on a check nobody asked for, and starts it for Test connection', async () => {
    const stopped = vi.fn(async () => false);
    const passive = deps({ isDistroRunning: stopped });
    expect(await checkMcpConnection(input({ distros: ['Ubuntu'] }), passive)).toEqual({ connected: true });
    expect(passive.runWsl).not.toHaveBeenCalled();

    const explicit = deps({ isDistroRunning: stopped });
    await checkMcpConnection(input({ distros: ['Ubuntu'], startStoppedDistros: true }), explicit);
    expect(explicit.runWsl).toHaveBeenCalledTimes(1);
  });
});

// The bridge check starts a relay and makes a folder of its own for each distro
// it checks. Both must be gone when the check ends, whichever way it ends: a
// leaked relay keeps a watcher open for the app's lifetime, and a leaked folder
// is one more in the temp directory per click of "Test connection".
describe('the NAT bridge check cleans up after itself', () => {
  const directories: string[] = [];
  const close = vi.fn();

  beforeEach(() => {
    close.mockReset();
  });

  afterEach(() => {
    // A check that leaked its folder fails its test; this keeps it from leaking into the temp dir too.
    for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
  });

  function bridgeDeps(overrides: Partial<McpConnectionCheckDeps> = {}): McpConnectionCheckDeps {
    return deps({
      makeTemporaryDirectory: async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-mcp-check-test-'));
        directories.push(directory);
        return directory;
      },
      startRelay: vi.fn(() => ({ close })),
      ...overrides,
    });
  }

  // Red-green: dropping `relay?.close()` from the finally fails the close
  // counts, dropping the rm fails the existence check, and closing the relay
  // before the bridge runs fails the "open while it ran" check.
  it.each([
    [
      'passes',
      async () => ({ stdout: '{"jsonrpc":"2.0","id":1,"result":{}}\n', stderr: '' }),
      { connected: true },
    ],
    [
      'fails on an error answer',
      async () => ({ stdout: '{"jsonrpc":"2.0","id":1,"error":{"code":-32603,"message":"HTTP 401"}}\n', stderr: '' }),
      { connected: false, error: 'From Ubuntu: HTTP 401' },
    ],
    [
      'fails because wsl.exe fails',
      async (): Promise<{ stdout: string; stderr: string }> => {
        throw Object.assign(new Error('Command failed'), { stderr: 'There is no distribution with the supplied name.\r\n' });
      },
      { connected: false, error: 'From Ubuntu: There is no distribution with the supplied name.' },
    ],
  ])('closes the relay and removes its folder after a check that %s', async (_label, answer, expected) => {
    const seenWhileRunning = { folderExists: false, closesSoFar: -1 };
    const injected = bridgeDeps({
      runWsl: vi.fn(async () => {
        seenWhileRunning.folderExists = fs.existsSync(directories[0]);
        seenWhileRunning.closesSoFar = close.mock.calls.length;
        return answer();
      }),
    });

    expect(await checkMcpConnection(input({ distros: ['Ubuntu'] }), injected)).toEqual(expected);

    expect(directories).toHaveLength(1);
    // The folder and the relay were both in place while the bridge ran...
    expect(seenWhileRunning).toEqual({ folderExists: true, closesSoFar: 0 });
    // ...and both are gone once the check has answered.
    expect(close).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(directories[0])).toBe(false);
  });

  it('removes the folder, with no relay to close, when the relay cannot start', async () => {
    const injected = bridgeDeps({ startRelay: vi.fn(() => { throw new Error('EADDRINUSE: relay port taken'); }) });

    expect(await checkMcpConnection(input({ distros: ['Ubuntu'] }), injected))
      .toEqual({ connected: false, error: 'From Ubuntu: EADDRINUSE: relay port taken' });

    expect(injected.runWsl).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(directories).toHaveLength(1);
    expect(fs.existsSync(directories[0])).toBe(false);
  });

  it('reports a folder that cannot be made, starting no relay and running nothing in the distro', async () => {
    const injected = bridgeDeps({
      makeTemporaryDirectory: async () => { throw new Error('EACCES: permission denied, mkdtemp'); },
    });

    expect(await checkMcpConnection(input({ distros: ['Ubuntu'] }), injected))
      .toEqual({ connected: false, error: 'From Ubuntu: EACCES: permission denied, mkdtemp' });

    expect(injected.startRelay).not.toHaveBeenCalled();
    expect(injected.runWsl).not.toHaveBeenCalled();
  });
});

// What the bridge prints is the whole signal on NAT networking: one JSON-RPC
// line. Anything else is the check's error, word for word, so the row shows what
// the distro said instead of a diagnosis.
describe('the bridge\'s answer, read as the check\'s result', () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
  });

  function checkWithOutput(output: { stdout: string; stderr: string }): Promise<{ connected: boolean; error?: string }> {
    const injected = deps({
      runWsl: vi.fn(async () => output),
      makeTemporaryDirectory: async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-mcp-check-test-'));
        directories.push(directory);
        return directory;
      },
    });
    return checkMcpConnection(input({ distros: ['Ubuntu'] }), injected);
  }

  it('reports a line that is not JSON as printed', async () => {
    expect(await checkWithOutput({ stdout: 'garbage\n', stderr: '' }))
      .toEqual({ connected: false, error: 'From Ubuntu: garbage' });
  });

  it('reports the first line of stderr when the bridge printed no answer on stdout', async () => {
    expect(await checkWithOutput({ stdout: '', stderr: '\nsh: 1: /tmp/mock/wsl-hook.sh: not found\r\nsecond line\n' }))
      .toEqual({ connected: false, error: 'From Ubuntu: sh: 1: /tmp/mock/wsl-hook.sh: not found' });
  });

  it.each([
    ['nothing at all', ''],
    ['only blank lines', '\r\n  \n\t\n'],
  ])('says the bridge printed no answer when stdout and stderr hold %s', async (_label, blank) => {
    expect(await checkWithOutput({ stdout: blank, stderr: blank }))
      .toEqual({ connected: false, error: 'From Ubuntu: The MCP bridge printed no answer.' });
  });

  it('reads the first non-blank line of stdout as the answer, past blank lines before it', async () => {
    expect(await checkWithOutput({ stdout: '\r\n\n  {"jsonrpc":"2.0","id":1,"result":{}}\n', stderr: 'a warning on stderr\n' }))
      .toEqual({ connected: true });
  });
});

describe('the mirrored-networking step when wsl.exe fails', () => {
  function mirroredDeps(runWsl: McpConnectionCheckDeps['runWsl']): McpConnectionCheckDeps {
    return deps({
      resolveFacts: vi.fn(async () => facts('mirrored')),
      runWsl,
      makeTemporaryDirectory: vi.fn(async () => { throw new Error('a mirrored check makes no folder'); }),
    });
  }

  it('reports what wsl.exe printed, naming the distro, and makes no folder or relay', async () => {
    const injected = mirroredDeps(vi.fn(async () => {
      throw Object.assign(new Error('Command failed'), { stderr: 'bash: connect: Connection refused\r\nbash: /dev/tcp/127.0.0.1/4100: Connection refused\r\n' });
    }));

    expect(await checkMcpConnection(input({ distros: ['Ubuntu'] }), injected))
      .toEqual({ connected: false, error: 'From Ubuntu: bash: connect: Connection refused' });

    expect(injected.makeTemporaryDirectory).not.toHaveBeenCalled();
    expect(injected.startRelay).not.toHaveBeenCalled();
  });

  it('reports that wsl.exe gave no answer when it timed out', async () => {
    const injected = mirroredDeps(vi.fn(async () => {
      throw Object.assign(new Error('Command failed'), { killed: true });
    }));

    expect(await checkMcpConnection(input({ distros: ['Ubuntu'] }), injected))
      .toEqual({ connected: false, error: 'From Ubuntu: wsl.exe gave no answer in 30 s.' });
  });

  it('stops at the first distro that fails, so a later one is not asked', async () => {
    const injected = mirroredDeps(vi.fn(async () => {
      throw Object.assign(new Error('Command failed'), { stderr: 'There is no distribution with the supplied name.\r\n' });
    }));

    expect(await checkMcpConnection(input({ distros: ['Ubuntu', 'Debian'] }), injected))
      .toEqual({ connected: false, error: 'From Ubuntu: There is no distribution with the supplied name.' });

    expect(injected.runWsl).toHaveBeenCalledTimes(1);
  });
});

describe('wslDistrosOfCliPaths', () => {
  // A CLI path into a distro names one only on Windows (`parseWslCliPath`), so
  // the test fakes the platform rather than going red on a Linux runner.
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform') as PropertyDescriptor;

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { ...originalPlatform, value: 'win32' });
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', originalPlatform);
  });

  it('names each distro a WSL-capable agent\'s path points into, once', () => {
    const supportsWsl = (agentName: string) => agentName !== 'aider';
    expect(wslDistrosOfCliPaths({
      claude: '\\\\wsl.localhost\\Ubuntu\\home\\dev\\.local\\bin\\claude',
      codex: '\\\\wsl$\\ubuntu\\home\\dev\\.nvm\\versions\\node\\v24.22.1\\bin\\codex',
      gemini: 'C:\\Users\\dev\\AppData\\Roaming\\npm\\gemini.cmd',
      aider: '\\\\wsl.localhost\\Debian\\usr\\bin\\aider',
      qwen: null,
    }, supportsWsl)).toEqual(['Ubuntu']);
  });
});
