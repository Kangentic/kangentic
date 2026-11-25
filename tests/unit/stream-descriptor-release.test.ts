/**
 * Every stream main opens on a file is released on every exit, not only the
 * happy one (Sentry DESKTOP-59: main ran out of file descriptors).
 *
 * A raw-descriptor `fs` stream is never closed by garbage collection, so a reader
 * that leaves one open on a throw holds a descriptor for the life of the
 * process. These run the real readers against real files and capture each
 * stream they open through a pass-through `node:fs` mock, then assert the
 * stream was destroyed. `destroyed` is set synchronously by `destroy()`, so the
 * check does not wait on the async close.
 *
 * Each JSONL fixture is several times the 64 KB read chunk with the bad line
 * first. A small file is read to its end in one chunk and closes itself, which
 * would pass with the leak still in place.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ReadStream, WriteStream } from 'node:fs';
import type Database from 'better-sqlite3';

const captured = vi.hoisted(() => ({
  readStreams: [] as ReadStream[],
  writeStreams: [] as WriteStream[],
  /** When set, `renameSync` throws this instead of renaming. Reset before each test. */
  renameFailure: null as Error | null,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const createReadStream = ((...args: Parameters<typeof actual.createReadStream>) => {
    const stream = actual.createReadStream(...args);
    captured.readStreams.push(stream);
    return stream;
  }) as typeof actual.createReadStream;
  const createWriteStream = ((...args: Parameters<typeof actual.createWriteStream>) => {
    const stream = actual.createWriteStream(...args);
    captured.writeStreams.push(stream);
    return stream;
  }) as typeof actual.createWriteStream;
  const renameSync = ((...args: Parameters<typeof actual.renameSync>) => {
    if (captured.renameFailure) throw captured.renameFailure;
    return actual.renameSync(...args);
  }) as typeof actual.renameSync;
  return {
    ...actual,
    default: { ...actual, createReadStream, createWriteStream, renameSync },
    createReadStream,
    createWriteStream,
    renameSync,
  };
});

import fs from 'node:fs';
import { streamJsonlRecords } from '../../src/main/agent/shared/history-scan';
import { runSearchEverything } from '../../src/main/search/search-core';
import { downloadModelFiles } from '../../src/main/transcription/models/download-model';
import type { Project } from '../../src/shared/types';

/** Lines enough to span several 64 KB read chunks. */
function fillerLines(): string[] {
  const line = JSON.stringify({ ts: 1, type: 'tool_start', tool: 'Read', detail: 'x'.repeat(200) });
  return Array.from({ length: 2000 }, () => line);
}

let tempRoot: string;

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kng-stream-release-'));
  captured.readStreams.length = 0;
  captured.writeStreams.length = 0;
  captured.renameFailure = null;
});

afterEach(() => {
  for (const stream of [...captured.readStreams, ...captured.writeStreams]) {
    if (!stream.destroyed) stream.destroy();
  }
  // A destroyed stream closes its descriptor a tick later, and Windows can
  // refuse to remove a folder whose file is still open, so the removal retries.
  fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe('streamJsonlRecords', () => {
  it('destroys its stream when onRecord throws', async () => {
    const filePath = path.join(tempRoot, 'transcript.jsonl');
    fs.writeFileSync(filePath, `${[JSON.stringify({ first: true }), ...fillerLines()].join('\n')}\n`);

    const complete = await streamJsonlRecords(filePath, () => {
      throw new TypeError('a reader that did not narrow first');
    });

    expect(complete).toBe(false);
    expect(captured.readStreams).toHaveLength(1);
    expect(captured.readStreams[0].destroyed).toBe(true);
  });
});

function makeProject(projectPath: string): Project {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'DescriptorProject',
    path: projectPath,
    github_url: null,
    default_agent: 'claude',
    group_id: null,
    position: 0,
    last_opened: '2026-05-01T00:00:00Z',
    created_at: '2026-04-01T00:00:00Z',
  };
}

/** Answers the board queries with no rows and the session query with one session. */
function makeDb(sessionId: string): Database.Database {
  return {
    prepare: vi.fn((sql: string) => ({
      all: vi.fn(() => {
        if (sql.includes('FROM sessions') && sql.includes('session_type')) {
          return [{ id: sessionId, task_id: 'task-A', session_type: 'claude_agent', started_at: '2026-05-01T00:00:00Z' }];
        }
        return [];
      }),
      get: vi.fn(() => undefined),
    })),
  } as unknown as Database.Database;
}

describe('runSearchEverything over events.jsonl', () => {
  it('skips a null line, still finds the match after it, and destroys its stream', async () => {
    const sessionId = 'session-null-line';
    const sessionDir = path.join(tempRoot, '.kangentic', 'sessions', sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });
    // Valid JSON that is not an object: each must be skipped, not read as a record.
    const lines = [
      'null',
      '42',
      '"str"',
      '[1,2]',
      ...fillerLines(),
      JSON.stringify({ ts: 2, type: 'tool_start', tool: 'Bash', detail: 'frobnicate --help' }),
    ];
    fs.writeFileSync(path.join(sessionDir, 'events.jsonl'), `${lines.join('\n')}\n`);
    const project = makeProject(tempRoot);

    const hits = await runSearchEverything({
      query: 'frobnicate',
      projects: [project],
      includeProjectHits: false,
      getDb: () => makeDb(sessionId),
    });

    expect(hits.filter((hit) => hit.kind === 'session_event')).toHaveLength(1);
    expect(captured.readStreams).toHaveLength(1);
    expect(captured.readStreams[0].destroyed).toBe(true);
  });

  it('destroys its stream when the search stops early on a full budget', async () => {
    const sessionId = 'session-many-hits';
    const sessionDir = path.join(tempRoot, '.kangentic', 'sessions', sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });
    const hit = JSON.stringify({ ts: 3, type: 'tool_start', tool: 'Bash', detail: 'frobnicate '.repeat(30) });
    fs.writeFileSync(path.join(sessionDir, 'events.jsonl'), `${Array.from({ length: 2000 }, () => hit).join('\n')}\n`);

    await runSearchEverything({
      query: 'frobnicate',
      projects: [makeProject(tempRoot)],
      includeProjectHits: false,
      getDb: () => makeDb(sessionId),
    });

    expect(captured.readStreams).toHaveLength(1);
    expect(captured.readStreams[0].destroyed).toBe(true);
  });
});

describe('downloadModelFiles', () => {
  let server: http.Server;
  let baseUrl: string;

  beforeEach(async () => {
    server = http.createServer((request, response) => {
      if (request.url === '/whole') {
        response.writeHead(200, { 'Content-Length': '4' });
        response.end('done');
        return;
      }
      if (request.url === '/redirect') {
        response.writeHead(302, { Location: '/whole' });
        response.end();
        return;
      }
      if (request.url === '/missing') {
        response.writeHead(404);
        response.end();
        return;
      }
      // Headers and part of the body, then the connection drops.
      response.writeHead(200, { 'Content-Length': '100000' });
      response.write(Buffer.alloc(1000));
      setTimeout(() => request.socket.destroy(), 20);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('destroys the write stream, rejects and leaves no partial file when the response drops mid-body', async () => {
    const download = downloadModelFiles(
      { files: [{ file: 'model.onnx', url: `${baseUrl}/drop` }], approxSizeMb: 1 },
      tempRoot,
      () => undefined,
    );
    // Settles to a value either way, so a download that never settles fails
    // the assertion below instead of hanging the test.
    const outcome = download.then(() => 'resolved', () => 'rejected');

    await expect.poll(async () => Promise.race([outcome, Promise.resolve('pending')]), { timeout: 5000 }).toBe('rejected');
    expect(captured.writeStreams).toHaveLength(1);
    expect(captured.writeStreams[0].destroyed).toBe(true);
    expect(fs.existsSync(path.join(tempRoot, 'model.onnx.part'))).toBe(false);
    expect(fs.existsSync(path.join(tempRoot, 'model.onnx'))).toBe(false);
  }, 15_000);

  it('renames a whole download into place', async () => {
    await downloadModelFiles(
      { files: [{ file: 'model.onnx', url: `${baseUrl}/whole` }], approxSizeMb: 1 },
      tempRoot,
      () => undefined,
    );

    expect(fs.readFileSync(path.join(tempRoot, 'model.onnx'), 'utf-8')).toBe('done');
    expect(fs.existsSync(path.join(tempRoot, 'model.onnx.part'))).toBe(false);
  });

  it('follows a redirect to the real file and leaves no partial file', async () => {
    await downloadModelFiles(
      { files: [{ file: 'model.onnx', url: `${baseUrl}/redirect` }], approxSizeMb: 1 },
      tempRoot,
      () => undefined,
    );

    expect(fs.readFileSync(path.join(tempRoot, 'model.onnx'), 'utf-8')).toBe('done');
    expect(fs.existsSync(path.join(tempRoot, 'model.onnx.part'))).toBe(false);
  });

  it('rejects a 404 and leaves neither the file nor a partial one', async () => {
    await expect(downloadModelFiles(
      { files: [{ file: 'model.onnx', url: `${baseUrl}/missing` }], approxSizeMb: 1 },
      tempRoot,
      () => undefined,
    )).rejects.toThrow(/404/);

    expect(fs.existsSync(path.join(tempRoot, 'model.onnx'))).toBe(false);
    expect(fs.existsSync(path.join(tempRoot, 'model.onnx.part'))).toBe(false);
  });

  it('rejects, closes the write stream and removes the partial file when the rename fails', async () => {
    const renameError = Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
    captured.renameFailure = renameError;

    await expect(downloadModelFiles(
      { files: [{ file: 'model.onnx', url: `${baseUrl}/whole` }], approxSizeMb: 1 },
      tempRoot,
      () => undefined,
    )).rejects.toBe(renameError);

    expect(captured.writeStreams).toHaveLength(1);
    expect(captured.writeStreams[0].closed).toBe(true);
    expect(fs.existsSync(path.join(tempRoot, 'model.onnx.part'))).toBe(false);
    expect(fs.existsSync(path.join(tempRoot, 'model.onnx'))).toBe(false);
  });
});
