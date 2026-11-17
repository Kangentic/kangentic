import crypto from 'node:crypto';
import http from 'node:http';
import { msg } from '@lingui/core/runtime-macro';
import { translateText } from '../../../i18n/main-i18n';
import {
  LINEAR_OAUTH_AUTHORIZE_URL,
  LINEAR_OAUTH_CLIENT_ID,
  LINEAR_OAUTH_REDIRECT_HOST,
  LINEAR_OAUTH_REDIRECT_PATH,
  LINEAR_OAUTH_REDIRECT_PORTS,
  LINEAR_OAUTH_SCOPE,
  LINEAR_SIGN_IN_TIMEOUT_MS,
} from './constants';
import { exchangeAuthorizationCode, type LinearTokenSet } from './oauth-tokens';

/** True when this build carries a registered OAuth client id, so the sign-in choice can show. */
export function isLinearSignInAvailable(): boolean {
  return LINEAR_OAUTH_CLIENT_ID.length > 0;
}

export interface PkcePair {
  verifier: string;
  challenge: string;
}

/** A PKCE verifier (43 base64url characters from 32 random bytes) and its S256 challenge. */
export function createPkcePair(): PkcePair {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function redirectUriFor(port: number): string {
  return `http://${LINEAR_OAUTH_REDIRECT_HOST}:${port}${LINEAR_OAUTH_REDIRECT_PATH}`;
}

export function buildAuthorizeUrl(input: { redirectUri: string; challenge: string; state: string }): string {
  const url = new URL(LINEAR_OAUTH_AUTHORIZE_URL);
  url.searchParams.set('client_id', LINEAR_OAUTH_CLIENT_ID);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', LINEAR_OAUTH_SCOPE);
  url.searchParams.set('state', input.state);
  url.searchParams.set('code_challenge', input.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('prompt', 'consent');
  return url.toString();
}

export type SignInResult =
  | { ok: true; tokens: LinearTokenSet }
  | { ok: false; cancelled: true }
  | { ok: false; cancelled: false; error: string };

type CallbackOutcome =
  | { kind: 'code'; code: string }
  | { kind: 'error'; message: string }
  | { kind: 'cancelled' };

export interface SignInDependencies {
  openExternal: (url: string) => Promise<void>;
  exchangeCode?: typeof exchangeAuthorizationCode;
  ports?: readonly number[];
  timeoutMs?: number;
}

interface PendingSignIn {
  authorizeUrl: string;
  openExternal: (url: string) => Promise<void>;
  settle: (outcome: CallbackOutcome) => void;
  /** Set by a cancel, which can land after the browser handed back while the code is being traded. */
  cancelled: boolean;
}

/** The one sign-in waiting on the browser. A second sign-in cancels the first. */
let pendingSignIn: PendingSignIn | null = null;

const CLOSE_TAB_MESSAGE = msg({
  message: 'You can close this tab and return to Kangentic.',
  context: 'Linear sign-in browser page',
});
const SIGN_IN_FAILED_MESSAGE = msg({
  message: 'Linear sign-in did not finish. Return to Kangentic to try again.',
  context: 'Linear sign-in browser page',
});
const SIGN_IN_UNAVAILABLE_MESSAGE = msg({
  message: 'Sign in with Linear is not available in this build.',
  context: 'Linear connect error',
});
const NO_FREE_PORT_MESSAGE = msg({
  message: 'Another program is using the Linear sign-in ports.',
  context: 'Linear connect error',
});
const TIMED_OUT_MESSAGE = msg({
  message: 'Linear sign-in timed out.',
  context: 'Linear connect error',
});
const BROWSER_NOT_OPENED_MESSAGE = msg({
  message: 'Could not open the browser for Linear sign-in.',
  context: 'Linear connect error',
});

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
}

function respondWithPage(response: http.ServerResponse, status: number, text: string): void {
  const body = `<!doctype html><html><head><meta charset="utf-8"><title>Kangentic</title></head>`
    + `<body style="font-family:system-ui,sans-serif;padding:48px;text-align:center">`
    + `<p>${escapeHtml(text)}</p></body></html>`;
  // `connection: close`, so no browser keeps a socket to a server that is about to go.
  response.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', connection: 'close' });
  response.end(body);
}

/**
 * Bind the first registered port that is free, or null when every one is taken.
 * Linear only accepts redirect URIs it has on file.
 */
async function listenOnRegisteredPort(
  server: http.Server,
  ports: readonly number[],
): Promise<number | null> {
  for (const port of ports) {
    const bound = await new Promise<boolean>((resolve) => {
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
      server.listen(port, LINEAR_OAUTH_REDIRECT_HOST);
    });
    if (bound) return port;
  }
  return null;
}

/**
 * Run the browser sign-in: open Linear's approval page in the system browser,
 * wait for Linear to redirect back to a loopback server, and trade the code for
 * a token pair (PKCE, no client secret). Resolves with the tokens, a cancel, or
 * the error Linear or the timeout gave; never throws for an expected outcome.
 */
export async function signInWithBrowser(dependencies: SignInDependencies): Promise<SignInResult> {
  if (!isLinearSignInAvailable()) {
    return { ok: false, cancelled: false, error: translateText(SIGN_IN_UNAVAILABLE_MESSAGE) };
  }
  cancelLinearSignIn();

  const pkce = createPkcePair();
  const state = crypto.randomBytes(16).toString('base64url');
  let settleOutcome: (outcome: CallbackOutcome) => void = () => {};
  const outcomePromise = new Promise<CallbackOutcome>((resolve) => {
    settleOutcome = resolve;
  });

  const server = http.createServer((request, response) => {
    const requestUrl = new URL(request.url ?? '/', `http://${LINEAR_OAUTH_REDIRECT_HOST}`);
    if (requestUrl.pathname !== LINEAR_OAUTH_REDIRECT_PATH) {
      response.writeHead(404).end();
      return;
    }
    if (requestUrl.searchParams.get('state') !== state) {
      // A stray or forged request: refuse it and keep waiting for Linear's own redirect.
      respondWithPage(response, 400, translateText(SIGN_IN_FAILED_MESSAGE));
      return;
    }
    const oauthError = requestUrl.searchParams.get('error');
    if (oauthError) {
      respondWithPage(response, 200, translateText(SIGN_IN_FAILED_MESSAGE));
      settleOutcome({ kind: 'error', message: requestUrl.searchParams.get('error_description') || oauthError });
      return;
    }
    const code = requestUrl.searchParams.get('code');
    if (!code) {
      respondWithPage(response, 400, translateText(SIGN_IN_FAILED_MESSAGE));
      return;
    }
    respondWithPage(response, 200, translateText(CLOSE_TAB_MESSAGE));
    settleOutcome({ kind: 'code', code });
  });

  const port = await listenOnRegisteredPort(server, dependencies.ports ?? LINEAR_OAUTH_REDIRECT_PORTS);
  if (port === null) {
    server.close();
    return { ok: false, cancelled: false, error: translateText(NO_FREE_PORT_MESSAGE) };
  }
  // A socket error after the bind (an accept that fails) ends this sign-in rather
  // than reaching Node as an `error` event with no listener, which would throw.
  server.on('error', () => settleOutcome({ kind: 'error', message: translateText(SIGN_IN_FAILED_MESSAGE) }));

  const redirectUri = redirectUriFor(port);
  const authorizeUrl = buildAuthorizeUrl({ redirectUri, challenge: pkce.challenge, state });
  const timer = setTimeout(
    () => settleOutcome({ kind: 'error', message: translateText(TIMED_OUT_MESSAGE) }),
    dependencies.timeoutMs ?? LINEAR_SIGN_IN_TIMEOUT_MS,
  );
  const thisSignIn: PendingSignIn = {
    authorizeUrl,
    openExternal: dependencies.openExternal,
    settle: (outcome) => settleOutcome(outcome),
    cancelled: false,
  };
  pendingSignIn = thisSignIn;

  try {
    try {
      await dependencies.openExternal(authorizeUrl);
    } catch (openError) {
      // report-ok: no browser could take the page (none installed, none registered), an environment state the dialog shows.
      console.warn('[linear/oauth] could not open the browser:', openError instanceof Error ? openError.name : 'unknown');
      return { ok: false, cancelled: false, error: translateText(BROWSER_NOT_OPENED_MESSAGE) };
    }
    const outcome = await outcomePromise;
    if (outcome.kind === 'cancelled') return { ok: false, cancelled: true };
    if (outcome.kind === 'error') return { ok: false, cancelled: false, error: outcome.message };
    const exchange = dependencies.exchangeCode ?? exchangeAuthorizationCode;
    const tokens = await exchange({ code: outcome.code, codeVerifier: pkce.verifier, redirectUri });
    // A cancel that landed while the code was being traded still wins: the user
    // left the waiting screen, so nothing is saved behind their back.
    if (thisSignIn.cancelled) return { ok: false, cancelled: true };
    return { ok: true, tokens };
  } finally {
    clearTimeout(timer);
    server.close();
    // close() only stops new connections; drop an idle keep-alive socket too, so
    // the port is free for the next sign-in.
    server.closeAllConnections();
    if (pendingSignIn === thisSignIn) pendingSignIn = null;
  }
}

/** Open the pending sign-in's approval page again, for a browser tab the user closed. */
export async function reopenLinearSignIn(): Promise<boolean> {
  if (!pendingSignIn) return false;
  await pendingSignIn.openExternal(pendingSignIn.authorizeUrl);
  return true;
}

/** Stop waiting for the browser. The pending `signInWithBrowser` resolves as cancelled. */
export function cancelLinearSignIn(): void {
  if (!pendingSignIn) return;
  pendingSignIn.cancelled = true;
  pendingSignIn.settle({ kind: 'cancelled' });
  pendingSignIn = null;
}
