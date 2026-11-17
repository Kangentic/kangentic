import crypto from 'node:crypto';
import { msg } from '@lingui/core/runtime-macro';
import { translateText } from '../../../i18n/main-i18n';
import {
  cancelLoopbackSignIn,
  reopenLoopbackSignIn,
  runLoopbackSignIn,
  type LoopbackSignInResult,
} from '../../shared/loopback-sign-in';
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
  | Exclude<LoopbackSignInResult<LinearTokenSet>, { ok: true }>;

export interface SignInDependencies {
  openExternal: (url: string) => Promise<void>;
  exchangeCode?: typeof exchangeAuthorizationCode;
  ports?: readonly number[];
  timeoutMs?: number;
}

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

/**
 * Run the browser sign-in: open Linear's approval page in the system browser,
 * wait for Linear to redirect back to a loopback server on one of the registered
 * ports, and trade the code for a token pair (PKCE, no client secret). Resolves
 * with the tokens, a cancel, or the error Linear or the timeout gave; never
 * throws for an expected outcome.
 */
export async function signInWithBrowser(dependencies: SignInDependencies): Promise<SignInResult> {
  if (!isLinearSignInAvailable()) {
    return { ok: false, cancelled: false, error: translateText(SIGN_IN_UNAVAILABLE_MESSAGE) };
  }

  const pkce = createPkcePair();
  const state = crypto.randomBytes(16).toString('base64url');
  let redirectUri = '';
  const exchange = dependencies.exchangeCode ?? exchangeAuthorizationCode;

  const result = await runLoopbackSignIn<string, LinearTokenSet>({
    provider: 'linear',
    path: LINEAR_OAUTH_REDIRECT_PATH,
    ports: dependencies.ports ?? LINEAR_OAUTH_REDIRECT_PORTS,
    buildAuthorizeUrl: (port) => {
      redirectUri = redirectUriFor(port);
      return buildAuthorizeUrl({ redirectUri, challenge: pkce.challenge, state });
    },
    handleCallback: (params) => {
      // A stray or forged request: refuse it and keep waiting for Linear's own redirect.
      if (params.get('state') !== state) return { kind: 'ignore' };
      const oauthError = params.get('error');
      if (oauthError) return { kind: 'error', message: params.get('error_description') || oauthError };
      const code = params.get('code');
      if (!code) return { kind: 'ignore' };
      return { kind: 'done', value: code };
    },
    finish: (code) => exchange({ code, codeVerifier: pkce.verifier, redirectUri }),
    pages: { done: translateText(CLOSE_TAB_MESSAGE), failed: translateText(SIGN_IN_FAILED_MESSAGE) },
    messages: {
      noFreePort: translateText(NO_FREE_PORT_MESSAGE),
      timedOut: translateText(TIMED_OUT_MESSAGE),
      browserNotOpened: translateText(BROWSER_NOT_OPENED_MESSAGE),
    },
    openExternal: dependencies.openExternal,
    timeoutMs: dependencies.timeoutMs ?? LINEAR_SIGN_IN_TIMEOUT_MS,
    logPrefix: '[linear/oauth]',
  });
  return result.ok ? { ok: true, tokens: result.value } : result;
}

/** Open the pending sign-in's approval page again, for a browser tab the user closed. */
export function reopenLinearSignIn(): Promise<boolean> {
  return reopenLoopbackSignIn('linear');
}

/** Stop waiting for the browser. The pending `signInWithBrowser` resolves as cancelled. */
export function cancelLinearSignIn(): void {
  cancelLoopbackSignIn('linear');
}
