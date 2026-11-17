/**
 * The shared attachment download drops the sign-in header on a redirect it
 * cannot trust. A board adapter (Jira, Azure DevOps, Asana) hands it an
 * Authorization header for the provider's own host; a redirect to another host
 * must not carry it, and neither may an https to http hop on the same host,
 * which would send the token in the clear.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { downloadFile, redirectKeepsSignIn } from '../../src/main/boards/shared/download-file';

describe('redirectKeepsSignIn', () => {
  it('keeps the sign-in for the same scheme and host', () => {
    expect(redirectKeepsSignIn('https://acme.atlassian.net/a.png', 'https://acme.atlassian.net/b.png')).toBe(true);
  });

  it('drops it for another host', () => {
    expect(redirectKeepsSignIn('https://acme.atlassian.net/a.png', 'https://media.example.com/a.png')).toBe(false);
  });

  it('drops it for an https to http hop on the same host', () => {
    expect(redirectKeepsSignIn('https://jira.example.com/a.png', 'http://jira.example.com/a.png')).toBe(false);
  });

  it('drops it for a redirect target that does not parse as a URL', () => {
    expect(redirectKeepsSignIn('https://jira.example.com/a.png', '/relative/a.png')).toBe(false);
  });
});

describe('downloadFile redirects against a local server', () => {
  const servers: http.Server[] = [];

  /** Start a 127.0.0.1 server on a free port; `seen` records the Authorization header of each request by path. */
  async function startServer(
    handler: (request: http.IncomingMessage, response: http.ServerResponse, port: number) => void,
  ): Promise<{ port: number; seen: Array<{ path: string; authorization: string | undefined }> }> {
    const seen: Array<{ path: string; authorization: string | undefined }> = [];
    const server = http.createServer((request, response) => {
      seen.push({ path: request.url ?? '', authorization: request.headers.authorization });
      handler(request, response, (server.address() as AddressInfo).port);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { port: (server.address() as AddressInfo).port, seen };
  }

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    })));
  });

  const headers = { Authorization: 'Bearer test-token' };
  const bytes = Buffer.from('file-bytes');

  it('keeps the sign-in on a redirect to the same host', async () => {
    const { port, seen } = await startServer((request, response, serverPort) => {
      if (request.url === '/start') {
        response.writeHead(302, { Location: `http://127.0.0.1:${serverPort}/file.png` });
        response.end();
      } else {
        response.writeHead(200, { 'Content-Type': 'image/png' });
        response.end(bytes);
      }
    });
    const result = await downloadFile(`http://127.0.0.1:${port}/start`, 'file.png', { headers });
    expect(result?.data).toBe(bytes.toString('base64'));
    expect(seen.map((entry) => entry.path)).toEqual(['/start', '/file.png']);
    expect(seen[1].authorization).toBe('Bearer test-token');
  });

  it('follows a relative Location against the request URL and keeps the sign-in', async () => {
    const { port, seen } = await startServer((request, response) => {
      if (request.url === '/start') {
        response.writeHead(302, { Location: '/file.png' });
        response.end();
      } else {
        response.writeHead(200);
        response.end(bytes);
      }
    });
    const result = await downloadFile(`http://127.0.0.1:${port}/start`, 'file.png', { headers });
    expect(result?.sizeBytes).toBe(bytes.length);
    expect(seen.map((entry) => entry.path)).toEqual(['/start', '/file.png']);
    expect(seen[1].authorization).toBe('Bearer test-token');
  });

  it('drops the sign-in on a redirect to another host', async () => {
    const target = await startServer((_request, response) => {
      response.writeHead(200);
      response.end(bytes);
    });
    const origin = await startServer((_request, response) => {
      response.writeHead(302, { Location: `http://localhost:${target.port}/file.png` });
      response.end();
    });
    const result = await downloadFile(`http://127.0.0.1:${origin.port}/start`, 'file.png', { headers });
    expect(result?.sizeBytes).toBe(bytes.length);
    expect(origin.seen[0].authorization).toBe('Bearer test-token');
    expect(target.seen).toHaveLength(1);
    expect(target.seen[0].authorization).toBeUndefined();
  });
});
