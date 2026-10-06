/**
 * scripts/lib/preview-bridge.mjs: how a script finds a running /preview and evaluates an
 * expression in its renderer. The capture and eval scripts both lean on it, and a failure it
 * reports wrongly (a bare status line where the renderer's own error belongs, a hang where a
 * deadline belongs) only shows up mid-run, so the contract is pinned here against a local server
 * that speaks the bridge's wire shape.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { evaluateInPreview, readPreviewPort } from '../../scripts/lib/preview-bridge.mjs';

describe('readPreviewPort', () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-bridge-root-'));
  });

  afterEach(() => {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  function writeLockfile(contents: string): void {
    const lockDirectory = path.join(repoRoot, '.kangentic');
    fs.mkdirSync(lockDirectory, { recursive: true });
    fs.writeFileSync(path.join(lockDirectory, 'preview.lock'), contents);
  }

  it('says no preview is running, and names the lockfile it looked for, when there is none', () => {
    expect(() => readPreviewPort(repoRoot)).toThrow('No preview is running');
    expect(() => readPreviewPort(repoRoot)).toThrow(path.join(repoRoot, '.kangentic', 'preview.lock'));
  });

  it('refuses a lockfile that carries no port', () => {
    writeLockfile(JSON.stringify({ pid: 4242 }));
    expect(() => readPreviewPort(repoRoot)).toThrow('carries no port');
  });

  it('returns the port the preview announced', () => {
    writeLockfile(JSON.stringify({ pid: 4242, port: 51234 }));
    expect(readPreviewPort(repoRoot)).toBe(51234);
  });
});

describe('evaluateInPreview', () => {
  interface SeenRequest { method: string | undefined; url: string | undefined; contentType: string | undefined; body: string }

  let server: http.Server;
  let seenRequests: SeenRequest[];

  /** Start a bridge stand-in on an ephemeral loopback port; `respond` plays the bridge's answer. */
  async function startBridge(respond: (response: http.ServerResponse) => void): Promise<number> {
    seenRequests = [];
    server = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        seenRequests.push({
          method: request.method,
          url: request.url,
          contentType: request.headers['content-type'],
          body: Buffer.concat(chunks).toString('utf-8'),
        });
        respond(response);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return (server.address() as AddressInfo).port;
  }

  function sendJson(response: http.ServerResponse, status: number, payload: unknown): void {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(payload));
  }

  afterEach(async () => {
    if (!server) return;
    // A server that never answered holds its socket open, and close() waits for every one.
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('POSTs the expression as JSON to /eval and returns the value the bridge answers with', async () => {
    const port = await startBridge((response) => sendJson(response, 200, { ok: true, value: { projects: 3, names: ['a', 'b'] } }));

    const value = await evaluateInPreview(port, 'window.electronAPI.projects.list()', 5000);

    expect(value).toEqual({ projects: 3, names: ['a', 'b'] });
    expect(seenRequests).toHaveLength(1);
    expect(seenRequests[0].method).toBe('POST');
    expect(seenRequests[0].url).toBe('/eval');
    expect(seenRequests[0].contentType).toBe('application/json');
    expect(JSON.parse(seenRequests[0].body)).toEqual({ expression: 'window.electronAPI.projects.list()' });
  });

  it('returns undefined when an OK answer carries no value', async () => {
    const port = await startBridge((response) => sendJson(response, 200, { ok: true }));
    await expect(evaluateInPreview(port, 'void 0', 5000)).resolves.toBeUndefined();
  });

  it('names the Allow Unsafe Operations setting when the bridge reports eval-disabled', async () => {
    const port = await startBridge((response) => sendJson(response, 403, { ok: false, error: { kind: 'eval-disabled' } }));
    await expect(evaluateInPreview(port, '1', 5000)).rejects.toThrow('Allow Unsafe Operations');
  });

  it('carries the renderer\'s own kind and detail when the expression threw', async () => {
    const port = await startBridge((response) => sendJson(response, 500, { ok: false, error: { kind: 'renderer-threw', detail: 'boom' } }));
    await expect(evaluateInPreview(port, 'throw new Error("boom")', 5000)).rejects.toThrow('(renderer-threw): boom');
  });

  it('falls back to the kind as the detail when the bridge sends no detail', async () => {
    const port = await startBridge((response) => sendJson(response, 504, { ok: false, error: { kind: 'renderer-timeout' } }));
    await expect(evaluateInPreview(port, '1', 5000)).rejects.toThrow('(renderer-timeout): renderer-timeout');
  });

  it('reads kind and detail off the top level when the answer has no error wrapper', async () => {
    const port = await startBridge((response) => sendJson(response, 500, { kind: 'renderer-threw', detail: 'flat shape' }));
    await expect(evaluateInPreview(port, '1', 5000)).rejects.toThrow('(renderer-threw): flat shape');
  });

  it('falls back to the status line when the body is not JSON', async () => {
    const port = await startBridge((response) => {
      response.writeHead(502, 'Bad Gateway', { 'content-type': 'text/plain' });
      response.end('upstream exploded');
    });
    await expect(evaluateInPreview(port, '1', 5000)).rejects.toThrow('Preview rejected the call (502): Bad Gateway');
  });

  it('gives the call thirty seconds when the caller names no deadline', async () => {
    const port = await startBridge((response) => sendJson(response, 200, { ok: true, value: 1 }));
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    try {
      await expect(evaluateInPreview(port, '1')).resolves.toBe(1);
      expect(timeoutSpy).toHaveBeenCalledWith(30_000);
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it('rejects once the deadline passes when the bridge never answers', async () => {
    const port = await startBridge(() => { /* hold the request open: a wedged renderer */ });
    const startedAt = Date.now();

    await expect(evaluateInPreview(port, 'new Promise(() => {})', 200)).rejects.toMatchObject({ name: 'TimeoutError' });

    // It waited for the deadline rather than failing at once. The margin absorbs timer coarseness.
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(150);
    expect(seenRequests).toHaveLength(1);
  });
});
