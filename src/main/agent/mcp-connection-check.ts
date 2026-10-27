import { promises as fsPromises } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { toWslPath } from '../../shared/paths';
import type { McpConnectionCheck } from '../../shared/types';
import { childProcessEnv } from '../shared/child-env';
import { listInWslEnv } from '../pty/process-tag/task-process-tag';
import { WslHookInbox } from '../pty/readers/wsl-hook-inbox';
import { execFileAsync } from '../utility-process/off-main-exec';
import type { McpHttpServerHandle } from './mcp-http-server';
import { parseWslCliPath } from './shared/cli-target';
import { WSL_MCP_REQUEST_HEAD, WSL_MCP_TOKEN_ENV, prepareWslHookTransport } from './shared/wsl-hook-transport';
import { describeWslFailure, isWslDistroRunning, resolveWslDistroFacts, type WslDistroFacts } from './shared/wsl-distro';

/**
 * Whether agents can reach Kangentic's MCP server: the Settings > MCP Server
 * connection row asks, and so does the check an agent session's start runs
 * (`McpConnectionWatch`). Two steps, the first failure answering for both:
 *
 * 1. Loopback, the URL every session on this machine gets: an authenticated
 *    `initialize`, as an agent's client sends it. This also catches a server
 *    that never started, which startup only logs.
 * 2. From each WSL distro a CLI path points into, the way that distro's CLI
 *    reaches the server: on NAT networking a round trip through the stdio
 *    bridge (`wsl-hook-transport.ts`), on mirrored networking a connection to
 *    the loopback port from inside the distro.
 *
 * A failure is reported as the error the check hit, never a diagnosis.
 */

/** The server answers in milliseconds, so a loopback request this slow has failed. */
const LOOPBACK_TIMEOUT_MS = 3_000;

/** The first `wsl.exe` call after a reboot boots the WSL VM, which takes seconds. */
const DISTRO_TIMEOUT_MS = 30_000;

/**
 * A project id no project has, for a check with no project open: the server
 * answers it 404, which it does only after the token check, so a 404 proves
 * the server is up and takes the token.
 */
const NO_PROJECT_ID = 'connection-check';

/** The client's `initialize`, as an agent's MCP client sends it. */
const INITIALIZE_REQUEST = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'kangentic-connection-check', version: '1' } },
});

export interface McpConnectionCheckDeps {
  fetchImplementation: typeof fetch;
  /** Runs `wsl.exe` with the given arguments and environment overrides. */
  runWsl: (args: readonly string[], env: Record<string, string>, timeoutMs: number) => Promise<{ stdout: string; stderr: string }>;
  isDistroRunning: (distro: string) => Promise<boolean>;
  resolveFacts: (distro: string) => Promise<WslDistroFacts>;
  /** A fresh folder on this machine's drive, which the distro reaches as `/mnt/...`. */
  makeTemporaryDirectory: () => Promise<string>;
  /** Starts the relay for a bridge check; the inbox in production. */
  startRelay: (directory: string) => { close: () => void };
}

const defaultDeps: McpConnectionCheckDeps = {
  fetchImplementation: (input, init) => fetch(input, init),
  runWsl: (args, env, timeoutMs) => execFileAsync('wsl.exe', args, {
    env: childProcessEnv(env),
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  }),
  isDistroRunning: (distro) => isWslDistroRunning(distro),
  resolveFacts: (distro) => resolveWslDistroFacts(distro),
  makeTemporaryDirectory: () => fsPromises.mkdtemp(path.join(os.tmpdir(), 'kangentic-mcp-check-')),
  startRelay: (directory) => {
    const inbox = new WslHookInbox({ sessionDirectory: directory, eventsOutputPath: path.join(directory, 'events.jsonl'), onAppended: () => undefined });
    inbox.start();
    return inbox;
  },
};

export interface McpConnectionCheckInput {
  handle: McpHttpServerHandle | null;
  /** Why the server did not start, when it did not (`mcpServerStartFailure`). */
  startFailure: string | null;
  /** The open project, whose URL a session would get; null with none open. */
  projectId: string | null;
  /** The distros a CLI path points into, checked after loopback. */
  distros: readonly string[];
  /**
   * Whether to check a distro that is not running, which starts it. True for a
   * check the user asked for; false for one that runs on its own, which skips
   * a stopped distro (no agent can be running there anyway).
   */
  startStoppedDistros: boolean;
}

/**
 * The distros a project's CLI paths point into, for agents that run from WSL
 * (`supportsWslCli`), each named once. A path for an agent that does not run
 * from WSL never names a distro: that agent is spawned on this machine.
 */
export function wslDistrosOfCliPaths(
  cliPaths: Readonly<Record<string, string | null | undefined>>,
  supportsWsl: (agentName: string) => boolean,
): string[] {
  const distros = new Map<string, string>();
  for (const [agentName, cliPath] of Object.entries(cliPaths)) {
    if (!cliPath || !supportsWsl(agentName)) continue;
    const parsed = parseWslCliPath(cliPath);
    if (parsed && !distros.has(parsed.distro.toLowerCase())) distros.set(parsed.distro.toLowerCase(), parsed.distro);
  }
  return [...distros.values()];
}

export async function checkMcpConnection(
  input: McpConnectionCheckInput,
  deps: McpConnectionCheckDeps = defaultDeps,
): Promise<McpConnectionCheck> {
  if (!input.handle) {
    return { connected: false, error: input.startFailure ?? 'The MCP server did not start.' };
  }
  const projectUrl = input.handle.urlForProject(input.projectId ?? NO_PROJECT_ID);
  const loopbackError = await checkLoopback(projectUrl, input.handle.token, input.projectId === null, deps);
  if (loopbackError) return { connected: false, error: loopbackError };

  for (const distro of input.distros) {
    if (!input.startStoppedDistros && !(await deps.isDistroRunning(distro))) continue;
    const distroError = await checkFromDistro(distro, projectUrl, input.handle.token, deps);
    if (distroError) return { connected: false, error: `From ${distro}: ${distroError}` };
  }
  return { connected: true };
}

/** The loopback step's error, or null when the server answered. */
async function checkLoopback(url: string, token: string, noProject: boolean, deps: McpConnectionCheckDeps): Promise<string | null> {
  let response: Response;
  try {
    response = await deps.fetchImplementation(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'X-Kangentic-Token': token,
      },
      body: INITIALIZE_REQUEST,
      signal: AbortSignal.timeout(LOOPBACK_TIMEOUT_MS),
    });
  } catch (error) {
    return describeFailure(error);
  }
  await response.text().catch(() => '');
  if (response.ok || (noProject && response.status === 404)) return null;
  return `HTTP ${response.status} from ${url}`;
}

/** The step from inside a distro: its error, or null when the server answered there. */
async function checkFromDistro(distro: string, url: string, token: string, deps: McpConnectionCheckDeps): Promise<string | null> {
  let facts: WslDistroFacts;
  try {
    facts = await deps.resolveFacts(distro);
  } catch (error) {
    return describeFailure(error);
  }
  if (facts.networkingMode === 'mirrored') return checkMirroredLoopback(distro, url, deps);
  return checkThroughBridge(distro, url, token, deps);
}

/** Mirrored networking: the distro's loopback is this machine's, so its CLI dials the URL. */
async function checkMirroredLoopback(distro: string, url: string, deps: McpConnectionCheckDeps): Promise<string | null> {
  const port = new URL(url).port;
  try {
    // The port is an argument, never in the script text.
    await deps.runWsl(['-d', distro, '-e', 'bash', '-c', 'exec 3<>"/dev/tcp/127.0.0.1/$1"', 'bash', port], { WSL_UTF8: '1' }, DISTRO_TIMEOUT_MS);
    return null;
  } catch (error) {
    return describeWslRun(error);
  }
}

/**
 * NAT networking: the session's CLI runs the stdio bridge, so this runs it too,
 * with an `initialize`, against a relay of its own in a fresh folder, and reads
 * the answer the bridge prints. The token crosses into the distro through
 * WSLENV, never argv.
 */
async function checkThroughBridge(distro: string, url: string, token: string, deps: McpConnectionCheckDeps): Promise<string | null> {
  let directory: string;
  try {
    directory = await deps.makeTemporaryDirectory();
  } catch (error) {
    return describeFailure(error);
  }
  let relay: { close: () => void } | null = null;
  try {
    const paths = prepareWslHookTransport(directory);
    relay = deps.startRelay(directory);
    const env = listInWslEnv({ WSL_UTF8: '1', [WSL_MCP_TOKEN_ENV]: token }, [WSL_MCP_TOKEN_ENV], process.env.WSLENV);
    let output: { stdout: string; stderr: string };
    try {
      output = await deps.runWsl([
        '-d', distro, '-e', 'sh', '-c', `printf '%s\\n' "$1" | sh "$2" ${WSL_MCP_REQUEST_HEAD} "$3"`,
        'sh', INITIALIZE_REQUEST, toWslPath(paths.script), url,
      ], env, DISTRO_TIMEOUT_MS);
    } catch (error) {
      return describeWslRun(error);
    }
    return bridgeAnswerError(output);
  } catch (error) {
    return describeFailure(error);
  } finally {
    relay?.close();
    await fsPromises.rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** The bridge's printed answer read as the check's result: null for an answer, else its error. */
function bridgeAnswerError(output: { stdout: string; stderr: string }): string | null {
  const line = output.stdout.split(/\r?\n/).map((candidate) => candidate.trim()).find((candidate) => candidate.length > 0);
  if (!line) {
    const stderrLine = output.stderr.split(/\r?\n/).map((candidate) => candidate.trim()).find((candidate) => candidate.length > 0);
    return stderrLine ?? 'The MCP bridge printed no answer.';
  }
  try {
    const answer = JSON.parse(line) as { result?: unknown; error?: { message?: unknown } };
    if (answer.result !== undefined) return null;
    if (typeof answer.error?.message === 'string') return answer.error.message;
  } catch {
    // Not JSON: reported as printed.
  }
  return line;
}

/** A `wsl.exe` run's failure: its own words where it printed some, or that it gave no answer in time. */
function describeWslRun(error: unknown): string {
  const killed = typeof error === 'object' && error !== null && (error as { killed?: unknown }).killed === true;
  if (killed) return `wsl.exe gave no answer in ${DISTRO_TIMEOUT_MS / 1000} s.`;
  return describeWslFailure(error);
}

/** An error's own message, with its cause's when it has one (undici reports `fetch failed`, the cause says why). */
function describeFailure(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause: unknown = error.cause;
  return cause instanceof Error && cause.message && cause.message !== error.message
    ? `${error.message}: ${cause.message}`
    : error.message;
}
