import path from 'node:path';
import { WslHookInbox } from '../../pty/readers/wsl-hook-inbox';
import type { CliPlace } from './cli-target';
import { WSL_MCP_TOKEN_ENV, prepareWslHookTransport, wslMcpServerLaunch, wslReachesLoopback } from './wsl-hook-transport';

/**
 * Kangentic's MCP server as one CLI must be given it. Each adapter maps this to
 * its own config format; none decides the shape itself.
 *
 * - `http`: the loopback URL and its token. A CLI on this machine, or in a WSL
 *   distro on mirrored networking, whose loopback is this machine's.
 * - `stdio`: the WSL hook transport's bridge, for a distro on NAT networking,
 *   which cannot reach this machine's loopback. The CLI starts `command` with
 *   `args` and passes the token in the server's environment as `tokenEnv`
 *   (Claude through the server's `env`, Codex through `env_vars`), never argv.
 */
export type KangenticMcpServer =
  | { kind: 'http'; url: string; token: string }
  | { kind: 'stdio'; command: string; args: string[]; tokenEnv: string; token: string };

/**
 * The server for a CLI that runs in `place`. For the bridge, prepares the
 * transport in `directory`, so a CLI with no hooks still gets the folders and
 * the signal file a relay watches: a session's own directory, whose relay
 * `performSpawn` attaches with the session, or a headless run's, whose relay
 * the run starts (`startRunMcpRelay`). Throws when the transport cannot be
 * written, as the builder's other config writes do.
 */
export function kangenticMcpServer(input: { url: string; token: string; place: CliPlace | null; directory: string }): KangenticMcpServer {
  if (!input.place || wslReachesLoopback(input.place)) return { kind: 'http', url: input.url, token: input.token };
  const launch = wslMcpServerLaunch(prepareWslHookTransport(input.directory), input.place, input.url);
  return { kind: 'stdio', ...launch, tokenEnv: WSL_MCP_TOKEN_ENV, token: input.token };
}

/**
 * The relay a headless run's bridge needs, for the run's lifetime: a run has no
 * session, so nothing else watches its directory, and without a relay every
 * tool call waits out the CLI's own timeout. Returns the stop; nothing to stop
 * for a server the CLI dials itself.
 */
export function startRunMcpRelay(directory: string, server: KangenticMcpServer | null): () => void {
  if (server?.kind !== 'stdio') return () => undefined;
  const inbox = new WslHookInbox({ sessionDirectory: directory, eventsOutputPath: path.join(directory, 'events.jsonl'), onAppended: () => undefined });
  inbox.start();
  return () => inbox.close();
}
