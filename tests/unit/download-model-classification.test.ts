/**
 * A model download that fails is reported by the dictation and the Knowledge
 * Graph reporters. What they must not file is a host that was busy or failing:
 * that is the network's, it clears on a retry, and no release fixes it. What they
 * must file is a file the host no longer has at the address this build ships.
 *
 * The downloader is the one place that can tell the two apart, by the status it
 * was answered with, so this runs the real downloader against a local server and
 * checks the class each answer rejects with. The message stays as it was: the
 * Dictation tab shows it.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ModelDownloadUnavailableError, downloadModelFiles } from '../../src/main/transcription/models/download-model';
import { EXPECTED_FAILURE_NAMES, isExpectedFailure } from '../../src/main/analytics/handled-report';

let server: http.Server;
let baseUrl = '';
let destination = '';

beforeEach(async () => {
  destination = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-model-download-'));
  // `/status/<code>` answers that status, and `/file` serves four bytes.
  server = http.createServer((request, response) => {
    const status = /^\/status\/(\d+)$/.exec(request.url ?? '');
    if (status) {
      response.writeHead(Number(status[1]));
      response.end();
      return;
    }
    response.writeHead(200, { 'content-length': '4' });
    response.end('data');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(destination, { recursive: true, force: true });
});

function download(urlPath: string): Promise<void> {
  return downloadModelFiles({ files: [{ url: `${baseUrl}${urlPath}`, file: 'model.bin' }], approxSizeMb: 1 }, destination, () => undefined);
}

async function rejectionOf(urlPath: string): Promise<Error> {
  try {
    await download(urlPath);
  } catch (error) {
    return error as Error;
  }
  throw new Error(`the download of ${urlPath} did not fail`);
}

describe('a model file the host did not serve', () => {
  it.each([408, 429, 500, 502, 503])('answers %i as unavailable, an expected class, with the message as it was', async (status) => {
    const failure = await rejectionOf(`/status/${status}`);

    expect(failure).toBeInstanceOf(ModelDownloadUnavailableError);
    expect(failure.message).toBe(`Download failed (${status}) for ${baseUrl}/status/${status}`);
    expect(EXPECTED_FAILURE_NAMES.has(failure.name)).toBe(true);
    expect(isExpectedFailure(failure)).toBe(true);
  });

  it.each([403, 404, 410])('leaves %i a plain Error, which a reporter files: the address is wrong or gone', async (status) => {
    const failure = await rejectionOf(`/status/${status}`);

    expect(failure).not.toBeInstanceOf(ModelDownloadUnavailableError);
    expect(failure.name).toBe('Error');
    expect(failure.message).toBe(`Download failed (${status}) for ${baseUrl}/status/${status}`);
    expect(isExpectedFailure(failure)).toBe(false);
  });

  it('still downloads a file the host serves', async () => {
    await download('/file');

    expect(fs.readFileSync(path.join(destination, 'model.bin'), 'utf8')).toBe('data');
  });
});
