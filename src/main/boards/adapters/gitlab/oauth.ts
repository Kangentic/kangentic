import crypto from 'node:crypto';
import { msg } from '@lingui/core/runtime-macro';
import { translateText } from '../../../i18n/main-i18n';
import {
  cancelLoopbackSignIn,
  reopenLoopbackSignIn,
  runLoopbackSignIn,
  type LoopbackSignInResult,
} from '../../shared/loopback-sign-in';
import { createPkcePair } from '../../shared/pkce';
import {
  GITLAB_COM_BASE,
  GITLAB_COM_OAUTH_CLIENT_ID,
  GITLAB_OAUTH_REDIRECT_HOST,
  GITLAB_OAUTH_REDIRECT_PATH,
  GITLAB_READ_SCOPE,
  GITLAB_SIGN_IN_TIMEOUT_MS,
} from './constants';
import { exchangeGitLabAuthorizationCode, type GitLabTokenSet } from './oauth-tokens';
import { isGitLabCom } from './url-parser';

/**
 * The redirect a renewal names. GitLab ignores the port of a loopback redirect,
 * so the one the sign-in used need not be kept.
 */
export const GITLAB_REFRESH_REDIRECT_URI = `http://${GITLAB_OAUTH_REDIRECT_HOST}${GITLAB_OAUTH_REDIRECT_PATH}`;

/**
 * True when Kangentic can sign in to `base` through the browser: gitlab.com,
 * and only in a build that carries the registered client id. A self-managed
 * server would need an OAuth application its own admin registers.
 */
export function isGitLabSignInAvailable(base: string): boolean {
  return isGitLabCom(base) && GITLAB_COM_OAUTH_CLIENT_ID.length > 0;
}

export function buildGitLabAuthorizeUrl(input: { redirectUri: string; challenge: string; state: string }): string {
  const url = new URL(`${GITLAB_COM_BASE}/oauth/authorize`);
  url.searchParams.set('client_id', GITLAB_COM_OAUTH_CLIENT_ID);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', GITLAB_READ_SCOPE);
  url.searchParams.set('state', input.state);
  url.searchParams.set('code_challenge', input.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

export type GitLabSignInResult =
  | { ok: true; tokens: GitLabTokenSet }
  | Exclude<LoopbackSignInResult<GitLabTokenSet>, { ok: true }>;

export interface GitLabSignInDependencies {
  openExternal: (url: string) => Promise<void>;
  exchangeCode?: typeof exchangeGitLabAuthorizationCode;
  timeoutMs?: number;
}

const CLOSE_TAB_MESSAGE = msg({
  message: 'You can close this tab and return to Kangentic.',
  context: 'GitLab sign-in browser page',
});
const SIGN_IN_FAILED_MESSAGE = msg({
  message: 'GitLab sign-in did not finish. Return to Kangentic to try again.',
  context: 'GitLab sign-in browser page',
});
const SIGN_IN_UNAVAILABLE_MESSAGE = msg({
  message: 'Sign in with GitLab is not available in this build.',
  context: 'GitLab connect error',
});
const NO_FREE_PORT_MESSAGE = msg({
  message: 'No local port was free for GitLab sign-in.',
  context: 'GitLab connect error',
});
const TIMED_OUT_MESSAGE = msg({
  message: 'GitLab sign-in timed out.',
  context: 'GitLab connect error',
});
const BROWSER_NOT_OPENED_MESSAGE = msg({
  message: 'Could not open the browser for GitLab sign-in.',
  context: 'GitLab connect error',
});

/**
 * Run the browser sign-in on gitlab.com: open GitLab's approval page asking for
 * `read_api` only, wait for GitLab to redirect back to a loopback server on a
 * free port, and trade the code for a token pair (PKCE, no client secret).
 */
export async function signInWithGitLab(dependencies: GitLabSignInDependencies): Promise<GitLabSignInResult> {
  if (!isGitLabSignInAvailable(GITLAB_COM_BASE)) {
    return { ok: false, cancelled: false, error: translateText(SIGN_IN_UNAVAILABLE_MESSAGE) };
  }

  const pkce = createPkcePair();
  const state = crypto.randomBytes(16).toString('base64url');
  let redirectUri = '';
  const exchange = dependencies.exchangeCode ?? exchangeGitLabAuthorizationCode;

  const result = await runLoopbackSignIn<string, GitLabTokenSet>({
    provider: 'gitlab',
    path: GITLAB_OAUTH_REDIRECT_PATH,
    ports: 'ephemeral',
    buildAuthorizeUrl: (port) => {
      redirectUri = `http://${GITLAB_OAUTH_REDIRECT_HOST}:${port}${GITLAB_OAUTH_REDIRECT_PATH}`;
      return buildGitLabAuthorizeUrl({ redirectUri, challenge: pkce.challenge, state });
    },
    handleCallback: (params) => {
      // A stray or forged request: refuse it and keep waiting for GitLab's own redirect.
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
    timeoutMs: dependencies.timeoutMs ?? GITLAB_SIGN_IN_TIMEOUT_MS,
    logPrefix: '[gitlab/oauth]',
  });
  return result.ok ? { ok: true, tokens: result.value } : result;
}

/** Open the pending sign-in's approval page again, for a browser tab the user closed. */
export async function reopenGitLabSignIn(): Promise<boolean> {
  return reopenLoopbackSignIn('gitlab');
}

/** Stop waiting for the browser. The pending `signInWithGitLab` resolves as cancelled. */
export function cancelGitLabSignIn(): void {
  cancelLoopbackSignIn('gitlab');
}
