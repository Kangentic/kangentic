import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';

const mocks = vi.hoisted(() => ({
  net: { request: vi.fn() },
  initialize: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('electron', () => ({ app: { isPackaged: false }, net: mocks.net }));
vi.mock('@aptabase/electron/main', () => ({
  initialize: mocks.initialize,
  trackEvent: vi.fn().mockResolvedValue(undefined),
}));

import { guardAptabaseResponses } from '../../src/main/analytics/analytics';

/**
 * DESKTOP-26. The SDK listens on the request and attaches nothing to the
 * response, so a request that fails after its headers throws from the response's
 * destroy and reads as a fatal. The fakes stand in for Electron's ClientRequest
 * and IncomingMessage only as far as what matters here: both are EventEmitters,
 * and an emitter with no `error` listener throws, which is the DESKTOP-26 throw.
 */
const HOST = 'us.aptabase.com';
const EVENT_URL = `https://${HOST}/api/v0/event`;

type RequestOptions = Parameters<typeof import('electron').net.request>[0];

function makeGuardedNet(): {
  netModule: { request: (options: RequestOptions) => Electron.ClientRequest };
  originalRequest: ReturnType<typeof vi.fn>;
} {
  const originalRequest = vi.fn(() => new EventEmitter());
  const netModule = { request: originalRequest as unknown as (options: RequestOptions) => Electron.ClientRequest };
  guardAptabaseResponses(netModule, HOST);
  return { netModule, originalRequest };
}

/** Run the request's `response` listeners and hand back the response. */
function deliverResponse(request: EventEmitter): EventEmitter {
  const response = new EventEmitter();
  request.emit('response', response);
  return response;
}

const DOWNLOAD_FAILURE = new Error('net::ERR_CONTENT_LENGTH_MISMATCH');

describe('guardAptabaseResponses', () => {
  it('a response with no listener throws, which is the failure this exists for', () => {
    expect(() => deliverResponse(new EventEmitter()).emit('error', DOWNLOAD_FAILURE)).toThrow(DOWNLOAD_FAILURE);
  });

  it.each([
    ['an options object', { method: 'POST', url: EVENT_URL, credentials: 'omit' }],
    ['a string', EVENT_URL],
  ])('swallows a response error on a request to the Aptabase host, given %s', (_label, options) => {
    const { netModule } = makeGuardedNet();
    const request = netModule.request(options as RequestOptions) as unknown as EventEmitter;
    const response = deliverResponse(request);

    expect(response.listenerCount('error')).toBe(1);
    expect(() => response.emit('error', DOWNLOAD_FAILURE)).not.toThrow();
  });

  it("leaves the SDK's own request listeners to run alongside it", () => {
    const { netModule } = makeGuardedNet();
    const request = netModule.request({ url: EVENT_URL }) as unknown as EventEmitter;
    const sdkResponseListener = vi.fn();
    request.on('response', sdkResponseListener);

    const response = deliverResponse(request);

    expect(sdkResponseListener).toHaveBeenCalledWith(response);
  });

  it.each([
    ['another host, as an options object', { url: 'https://example.test/api/v0/event' }],
    ['another host, as a string', 'https://example.test/api/v0/event'],
    ['a host that only starts the same way', { url: `https://${HOST}.example.test/` }],
    ['a host that only ends the same way', { url: `https://not-${HOST}/` }],
    ['the host in a path', { url: `https://example.test/${HOST}/` }],
    ['the same name on another port', { url: `https://${HOST}:8443/` }],
    ["Sentry's transport, which names a hostname", { method: 'POST', hostname: 'o0.ingest.example.test', path: '/api/1/envelope/', port: NaN, protocol: 'https:' }],
    ["electron-updater, which names a hostname", { hostname: 'github.com', path: '/kangentic/releases', protocol: 'https:' }],
    ['a hostname option naming the Aptabase host', { hostname: HOST, path: '/api/v0/event', protocol: 'https:' }],
  ])('adds nothing to %s', (_label, options) => {
    const { netModule } = makeGuardedNet();
    const request = netModule.request(options as RequestOptions) as unknown as EventEmitter;

    expect(request.listenerCount('response')).toBe(0);
    expect(deliverResponse(request).listenerCount('error')).toBe(0);
  });

  it('passes a URL it cannot parse straight through instead of throwing', () => {
    const { netModule, originalRequest } = makeGuardedNet();

    expect(() => netModule.request('not a url')).not.toThrow();
    expect(originalRequest).toHaveBeenCalledWith('not a url');
  });

  it('hands back the real request, with the caller\'s this and every argument', () => {
    const { netModule, originalRequest } = makeGuardedNet();
    const realRequest = new EventEmitter();
    originalRequest.mockReturnValueOnce(realRequest);
    const callback = vi.fn();

    // Sentry's outer wrapper forwards a callback the types do not list.
    const returned = (netModule.request as unknown as (...parameters: unknown[]) => unknown)({ url: EVENT_URL }, callback);

    expect(returned).toBe(realRequest);
    expect(originalRequest).toHaveBeenCalledWith({ url: EVENT_URL }, callback);
    expect(originalRequest.mock.contexts[0]).toBe(netModule);
  });
});

describe('initAnalytics wiring', () => {
  const originalTelemetry = process.env.KANGENTIC_TELEMETRY;
  const originalKey = process.env.KANGENTIC_APTABASE_APP_KEY;
  const originalRequest = vi.fn(() => new EventEmitter());

  beforeEach(() => {
    vi.resetModules();
    originalRequest.mockClear();
    mocks.initialize.mockClear();
    mocks.net.request = originalRequest;
  });

  afterEach(() => {
    if (originalTelemetry === undefined) delete process.env.KANGENTIC_TELEMETRY;
    else process.env.KANGENTIC_TELEMETRY = originalTelemetry;
    if (originalKey === undefined) delete process.env.KANGENTIC_APTABASE_APP_KEY;
    else process.env.KANGENTIC_APTABASE_APP_KEY = originalKey;
  });

  async function freshInitAnalytics(): Promise<() => void> {
    const { initAnalytics } = await import('../../src/main/analytics/analytics');
    return initAnalytics;
  }

  it('leaves net.request alone when telemetry is off', async () => {
    process.env.KANGENTIC_TELEMETRY = '0';
    (await freshInitAnalytics())();
    expect(mocks.net.request).toBe(originalRequest);
  });

  it('installs the guard before the SDK starts, on the production host by default', async () => {
    process.env.KANGENTIC_TELEMETRY = '1';
    delete process.env.KANGENTIC_APTABASE_APP_KEY;
    let requestAtInitialize: unknown;
    mocks.initialize.mockImplementationOnce(async () => {
      requestAtInitialize = mocks.net.request;
    });

    (await freshInitAnalytics())();

    expect(requestAtInitialize).not.toBe(originalRequest);
    const request = mocks.net.request({ url: EVENT_URL }) as unknown as EventEmitter;
    expect(request.listenerCount('response')).toBe(1);
  });

  it('follows the app key to the local sink, so the rig in usage-analytics.md is covered', async () => {
    process.env.KANGENTIC_TELEMETRY = '1';
    process.env.KANGENTIC_APTABASE_APP_KEY = 'A-DEV-0000000000';

    (await freshInitAnalytics())();

    const sinkRequest = mocks.net.request({ url: 'http://localhost:3000/api/v0/event' }) as unknown as EventEmitter;
    const productionRequest = mocks.net.request({ url: EVENT_URL }) as unknown as EventEmitter;
    expect(sinkRequest.listenerCount('response')).toBe(1);
    expect(productionRequest.listenerCount('response')).toBe(0);
  });

  it('installs nothing for a key whose region the SDK does not post to', async () => {
    process.env.KANGENTIC_TELEMETRY = '1';
    process.env.KANGENTIC_APTABASE_APP_KEY = 'A-SH-0000000000';

    (await freshInitAnalytics())();

    expect(mocks.net.request).toBe(originalRequest);
  });

  it('wraps once however many times it is called', async () => {
    process.env.KANGENTIC_TELEMETRY = '1';
    delete process.env.KANGENTIC_APTABASE_APP_KEY;
    const initAnalytics = await freshInitAnalytics();

    initAnalytics();
    const guardedRequest = mocks.net.request;
    initAnalytics();

    expect(mocks.net.request).toBe(guardedRequest);
  });
});

/**
 * The guard rests on three facts about SDK source we do not own. Each is read
 * from the installed package, because all the tests above would stay green if
 * one stopped being true. `.mjs` is what esbuild bundles (the `import` condition
 * of the package's `./main` export) and `.cjs` is what a `require` gets.
 */
const requireFromTest = createRequire(import.meta.url);
const sdkDirectory = path.dirname(requireFromTest.resolve('@aptabase/electron/main'));

interface ResponseListener {
  responseName: string;
  body: string;
}

/** The body of the callback the SDK passes to `on("response", ...)`, with the
 *  name its minifier gave the response, or null when that shape is gone. */
function readResponseListener(source: string): ResponseListener | null {
  const opening = /\.on\("response",(\w+)=>\{/.exec(source);
  if (!opening) return null;
  const start = opening.index + opening[0].length;
  let depth = 1;
  for (let index = start; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return { responseName: opening[1], body: source.slice(start, index) };
  }
  return null;
}

/** Whether a response listener attaches anything to the response. */
function attachesToResponse(listener: ResponseListener): boolean {
  return new RegExp(`\\b${listener.responseName}\\.(on|once|addListener|prependListener)\\(`).test(listener.body);
}

describe('the detector the SDK guards below rely on', () => {
  it('finds the listener and sees nothing attached in clean source', () => {
    const listener = readResponseListener('r.on("response",i=>{i.statusCode>=300&&warn(`${i.statusCode}`),g()})');
    expect(listener?.responseName).toBe('i');
    expect(attachesToResponse(listener as ResponseListener)).toBe(false);
  });

  it.each(['on', 'once', 'addListener'])('catches a listener added with %s', (method) => {
    const listener = readResponseListener(`r.on("response",i=>{i.${method}("error",c),g()})`);
    expect(attachesToResponse(listener as ResponseListener)).toBe(true);
  });

  it('reads no listener at all from a shape it does not know, so a reshape fails instead of passing', () => {
    expect(readResponseListener('r.on("response",handleResponse)')).toBeNull();
  });
});

describe.each(['main.cjs', 'main.mjs'])('the installed @aptabase/electron %s', (fileName) => {
  const source = fs.readFileSync(path.join(sdkDirectory, fileName), 'utf-8');

  it('still attaches nothing to the response. When this fails the SDK has fixed it: delete guardAptabaseResponses', () => {
    const listener = readResponseListener(source);
    expect(listener).not.toBeNull();
    expect(attachesToResponse(listener as ResponseListener)).toBe(false);
  });

  it('still reads request off the net module at each call, so an assignment reaches it', () => {
    // A SDK that captured the function at import would keep calling the
    // original, and every test above would stay green with the guard doing
    // nothing. `.cjs` reads `a.net.request(`, `.mjs` an aliased `P.request(`.
    expect(source).toMatch(/\w\.request\(\{method:"POST",url:\w+,credentials:"omit"\}\)/);
  });

  it('still posts to the hosts APTABASE_HOST_BY_REGION names', () => {
    expect(source).toContain('US:"https://us.aptabase.com"');
    expect(source).toContain('EU:"https://eu.aptabase.com"');
    expect(source).toContain('DEV:"http://localhost:3000"');
  });
});
