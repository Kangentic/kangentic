import http from 'node:http';
import { LOWEST_SERVICE_PORT } from './sealed-token';

/**
 * The browser sign-in's local half, shared by every board provider that signs in
 * through the system browser (Linear, Jira, Trello). It binds a loopback server,
 * opens the provider's approval page, and waits until the browser lands on the
 * callback path, the user cancels, or the timeout passes. What a callback means
 * is the provider's call (`handleCallback`); so is the work after it (`finish`).
 */

/** The literal loopback address. Never `localhost`, which can resolve to another interface. */
export const LOOPBACK_HOST = '127.0.0.1';

/** One pending sign-in per provider: a Jira sign-in never cancels a Linear one. */
export type LoopbackProvider = 'linear' | 'jira' | 'trello' | 'gitlab';

/**
 * What one request to the callback path means.
 * - `ignore`: not this sign-in's answer (a wrong state or nonce). It gets a 400
 *   page and the sign-in keeps waiting, so a stray or forged request cannot end it.
 * - `done`: the provider handed back. The browser gets the close-tab page.
 * - `error`: the provider refused or failed. The browser gets the failed page.
 */
export type LoopbackCallbackAnswer<T> =
  | { kind: 'ignore' }
  | { kind: 'done'; value: T }
  | { kind: 'error'; message: string };

export type LoopbackSignInResult<R> =
  | { ok: true; value: R }
  | { ok: false; cancelled: true }
  | { ok: false; cancelled: false; error: string };

/**
 * A failure `finish` explains to the user. Its message is shown in the dialog as
 * it is; any other error `finish` throws propagates to the caller.
 */
export class LoopbackSignInFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LoopbackSignInFailure';
  }
}

export interface LoopbackSignInOptions<T, R> {
  provider: LoopbackProvider;
  /** The callback path the provider (or kangentic.com) redirects to, such as `/jira/callback`. */
  path: string;
  /** Registered ports tried in order (a provider that matches redirect URIs exactly), or any free port. */
  ports: readonly number[] | 'ephemeral';
  /** The approval page to open, once the bound port is known. */
  buildAuthorizeUrl: (port: number) => string;
  handleCallback: (params: URLSearchParams) => LoopbackCallbackAnswer<T>;
  /**
   * The work after a `done` callback, while the sign-in is still pending, so a
   * cancel that lands during it still wins. Throw `LoopbackSignInFailure` for a
   * failure the dialog shows.
   */
  finish: (value: T) => Promise<R>;
  /**
   * The translated text of the page the browser shows. `failed` is also the
   * dialog's line for a socket error after the bind, which no provider words.
   */
  pages: { done: string; failed: string };
  /** The translated text of each local failure. */
  messages: { noFreePort: string; timedOut: string; browserNotOpened: string };
  openExternal: (url: string) => Promise<void>;
  timeoutMs: number;
  /** Prefix for the one console line a failed browser open writes. */
  logPrefix: string;
}

type Settled<T> =
  | { kind: 'done'; value: T }
  | { kind: 'error'; message: string }
  | { kind: 'cancelled' };

interface PendingSignIn {
  /** Null until the port is bound and the page is known. */
  authorizeUrl: string | null;
  openExternal: (url: string) => Promise<void>;
  cancel: () => void;
  cancelled: boolean;
}

const pendingSignIns = new Map<LoopbackProvider, PendingSignIn>();

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
}

function respondWithPage(response: http.ServerResponse, status: number, text: string): void {
  const body = `<!doctype html><html><head><meta charset="utf-8"><title>Kangentic</title></head>`
    + `<body style="font-family:system-ui,sans-serif;padding:48px;text-align:center">`
    + `<p>${escapeHtml(text)}</p></body></html>`;
  // `connection: close`, so no browser keeps a socket to a server that is about to go.
  response.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    connection: 'close',
  });
  response.end(body);
}

function listenOn(server: http.Server, port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const onError = (): void => {
      server.off('listening', onListening);
      resolve(false);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve(true);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, LOOPBACK_HOST);
  });
}

/** Bind the first free port of `ports`, or any free port the OS gives. Null when none binds. */
async function bindLoopback(server: http.Server, ports: readonly number[] | 'ephemeral'): Promise<number | null> {
  if (ports === 'ephemeral') {
    if (!(await listenOn(server, 0))) return null;
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    // The OS gives an ephemeral port well above 1024 on every platform, but the
    // token service refuses anything lower, so a low one fails here, not there.
    if (port < LOWEST_SERVICE_PORT) {
      server.close();
      return null;
    }
    return port;
  }
  for (const port of ports) {
    if (await listenOn(server, port)) return port;
  }
  return null;
}

/**
 * Run one browser sign-in. Resolves with `finish`'s value, a cancel, or the
 * error the provider, `finish` or the timeout gave; never throws for an expected
 * outcome. A new sign-in for the same provider cancels the pending one.
 */
export async function runLoopbackSignIn<T, R>(options: LoopbackSignInOptions<T, R>): Promise<LoopbackSignInResult<R>> {
  cancelLoopbackSignIn(options.provider);

  let settle: (outcome: Settled<T>) => void = () => {};
  const settled = new Promise<Settled<T>>((resolve) => {
    settle = resolve;
  });

  const server = http.createServer((request, response) => {
    let requestUrl: URL;
    try {
      requestUrl = new URL(request.url ?? '/', `http://${LOOPBACK_HOST}`);
    } catch { // report-ok: a request target the URL parser refuses (`//`) is not this sign-in's answer, and a throw here would escape the request handler and take down main
      response.writeHead(400).end();
      return;
    }
    if (requestUrl.pathname !== options.path) {
      response.writeHead(404).end();
      return;
    }
    const answer = options.handleCallback(requestUrl.searchParams);
    if (answer.kind === 'ignore') {
      respondWithPage(response, 400, options.pages.failed);
      return;
    }
    if (answer.kind === 'error') {
      respondWithPage(response, 200, options.pages.failed);
      settle({ kind: 'error', message: answer.message });
      return;
    }
    respondWithPage(response, 200, options.pages.done);
    settle({ kind: 'done', value: answer.value });
  });

  // Registered before the bind, so a cancel or a newer sign-in that lands while the
  // port is still binding reaches this one. Its page is known once the port is.
  const thisSignIn: PendingSignIn = {
    authorizeUrl: null,
    openExternal: options.openExternal,
    cancel: () => settle({ kind: 'cancelled' }),
    cancelled: false,
  };
  pendingSignIns.set(options.provider, thisSignIn);
  let timer: NodeJS.Timeout | undefined;

  try {
    const port = await bindLoopback(server, options.ports);
    if (thisSignIn.cancelled) return { ok: false, cancelled: true };
    if (port === null) return { ok: false, cancelled: false, error: options.messages.noFreePort };
    // A socket error after the bind (an accept that fails) ends this sign-in rather
    // than reaching Node as an `error` event with no listener, which would throw.
    // The browser page's failed line doubles as the dialog's line for it.
    server.on('error', () => settle({ kind: 'error', message: options.pages.failed }));

    const authorizeUrl = options.buildAuthorizeUrl(port);
    thisSignIn.authorizeUrl = authorizeUrl;
    timer = setTimeout(() => settle({ kind: 'error', message: options.messages.timedOut }), options.timeoutMs);
    try {
      await options.openExternal(authorizeUrl);
    } catch (openError) {
      // report-ok: no browser could take the page (none installed, none registered), an environment state the dialog shows.
      console.warn(`${options.logPrefix} could not open the browser:`, openError instanceof Error ? openError.name : 'unknown');
      return { ok: false, cancelled: false, error: options.messages.browserNotOpened };
    }
    const outcome = await settled;
    if (outcome.kind === 'cancelled') return { ok: false, cancelled: true };
    if (outcome.kind === 'error') return { ok: false, cancelled: false, error: outcome.message };
    let value: R;
    try {
      value = await options.finish(outcome.value);
    } catch (finishError) {
      if (finishError instanceof LoopbackSignInFailure) {
        return thisSignIn.cancelled ? { ok: false, cancelled: true } : { ok: false, cancelled: false, error: finishError.message };
      }
      throw finishError;
    }
    // A cancel that landed while `finish` ran still wins: the user left the
    // waiting screen, so nothing is saved behind their back.
    if (thisSignIn.cancelled) return { ok: false, cancelled: true };
    return { ok: true, value };
  } finally {
    clearTimeout(timer);
    server.close();
    // close() only stops new connections; drop an idle keep-alive socket too, so
    // the port is free for the next sign-in.
    server.closeAllConnections();
    if (pendingSignIns.get(options.provider) === thisSignIn) pendingSignIns.delete(options.provider);
  }
}

/** Open the pending sign-in's approval page again, for a browser tab the user closed. */
export async function reopenLoopbackSignIn(provider: LoopbackProvider): Promise<boolean> {
  const pending = pendingSignIns.get(provider);
  if (!pending || pending.authorizeUrl === null) return false;
  await pending.openExternal(pending.authorizeUrl);
  return true;
}

/** Stop waiting for the browser. The pending sign-in resolves as cancelled. */
export function cancelLoopbackSignIn(provider: LoopbackProvider): void {
  const pending = pendingSignIns.get(provider);
  if (!pending) return;
  pending.cancelled = true;
  pending.cancel();
  pendingSignIns.delete(provider);
}
