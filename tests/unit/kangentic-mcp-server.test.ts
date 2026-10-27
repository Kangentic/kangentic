/**
 * Kangentic's MCP server as one CLI is given it (`kangentic-mcp-server.ts`):
 * the loopback URL for a CLI that can reach it, the WSL hook transport's stdio
 * bridge for a distro on NAT networking, and the relay a headless run starts
 * for its bridge. The relay case posts to a real loopback server.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
import { kangenticMcpServer, startRunMcpRelay } from '../../src/main/agent/shared/kangentic-mcp-server';
import { wslHookPaths } from '../../src/main/agent/shared/wsl-hook-transport';
import type { CliPlace } from '../../src/main/agent/shared/cli-target';

const temporaryDirectories: string[] = [];
const servers: Server[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function makeDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-mcp-server-'));
  temporaryDirectories.push(directory);
  return directory;
}

function place(networkingMode: CliPlace['facts']['networkingMode']): CliPlace {
  return {
    kind: 'wsl',
    distro: 'Ubuntu',
    facts: { distro: 'Ubuntu', homeLinux: '/home/dev', homeUnc: '\\\\wsl.localhost\\Ubuntu\\home\\dev', uncRoot: '\\\\wsl.localhost\\Ubuntu', interactivePath: '/usr/bin', env: {}, networkingMode },
  };
}

describe('kangenticMcpServer', () => {
  it('gives a CLI on this machine, or in a distro on mirrored networking, the URL, and writes nothing', () => {
    const directory = makeDirectory();
    expect(kangenticMcpServer({ url: 'http://127.0.0.1:4100/mcp/p', token: 'secret', place: null, directory }))
      .toEqual({ kind: 'http', url: 'http://127.0.0.1:4100/mcp/p', token: 'secret' });
    expect(kangenticMcpServer({ url: 'http://127.0.0.1:4100/mcp/p', token: 'secret', place: place('mirrored'), directory }).kind).toBe('http');
    expect(fs.readdirSync(directory)).toEqual([]);
  });

  it('gives a distro on NAT networking the bridge, with the transport ready in the given folder and the token by name', () => {
    const directory = makeDirectory();
    const server = kangenticMcpServer({ url: 'http://127.0.0.1:4100/mcp/p', token: 'secret', place: place('nat'), directory });

    expect(server).toMatchObject({ kind: 'stdio', command: 'sh', tokenEnv: 'KANGENTIC_MCP_TOKEN', token: 'secret' });
    if (server.kind !== 'stdio') throw new Error('expected the bridge');
    expect(server.args.slice(1)).toEqual(['mcp', 'http://127.0.0.1:4100/mcp/p']);
    expect(server.args.join(' ')).not.toContain('secret');
    expect(fs.existsSync(wslHookPaths(directory).signal)).toBe(true);
  });
});

describe('startRunMcpRelay', () => {
  // Red-green: a run that starts no relay leaves the request unanswered, and
  // the bridge waits out the CLI's own timeout.
  it('relays a headless run\'s bridge messages to the server until stopped', async () => {
    const received: string[] = [];
    const port = await new Promise<number>((resolve) => {
      const server = createServer((request, response) => {
        let body = '';
        request.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        request.on('end', () => {
          received.push(`${request.headers['x-kangentic-token']} ${body}`);
          response.setHeader('Content-Type', 'application/json');
          response.end('{"jsonrpc":"2.0","id":1,"result":{}}');
        });
      });
      servers.push(server);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        resolve(typeof address === 'object' && address ? address.port : 0);
      });
    });
    const directory = makeDirectory();
    const server = kangenticMcpServer({ url: `http://127.0.0.1:${port}/mcp/p`, token: 'secret', place: place('nat'), directory });
    const stop = startRunMcpRelay(directory, server);

    const paths = wslHookPaths(directory);
    fs.writeFileSync(path.join(paths.requests, '1767225600000000001-7.req'), `K1\nmcp\nsecret http://127.0.0.1:${port}/mcp/p\n{"jsonrpc":"2.0","id":1,"method":"tools/list"}`);
    fs.writeFileSync(paths.signal, 'x');

    const responsePath = path.join(paths.responses, '1767225600000000001-7.res');
    const deadline = Date.now() + 5_000;
    while (!fs.existsSync(responsePath) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    stop();

    expect(fs.readFileSync(responsePath, 'utf-8')).toBe('{"jsonrpc":"2.0","id":1,"result":{}}\n');
    expect(received).toEqual(['secret {"jsonrpc":"2.0","id":1,"method":"tools/list"}']);
  });

  it('starts nothing for a server the CLI dials itself', () => {
    const stop = startRunMcpRelay(makeDirectory(), { kind: 'http', url: 'http://127.0.0.1:4100/mcp/p', token: 'secret' });
    expect(() => stop()).not.toThrow();
  });
});
