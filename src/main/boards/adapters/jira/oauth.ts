import { msg } from '@lingui/core/runtime-macro';
import { translateText } from '../../../i18n/main-i18n';
import { isNetworkFailure } from '../../../analytics/handled-report';
import {
  LoopbackSignInFailure,
  cancelLoopbackSignIn,
  reopenLoopbackSignIn,
  runLoopbackSignIn,
  type LoopbackCallbackAnswer,
  type LoopbackSignInResult,
} from '../../shared/loopback-sign-in';
import { JIRA_SEAL_INFO, createSealedSignInKeys, readSealedCallback } from '../../shared/sealed-token';
import { JiraClient, JiraHttpError, fetchCloudId } from './client';
import {
  ATLASSIAN_ACCESSIBLE_RESOURCES_URL,
  JIRA_OAUTH_AUTHORIZE_URL,
  JIRA_OAUTH_CALLBACK_PATH,
  JIRA_OAUTH_CLIENT_ID,
  JIRA_OAUTH_REDIRECT_URI,
  JIRA_OAUTH_SCOPES,
  JIRA_SIGN_IN_TIMEOUT_MS,
  isJiraSignInAvailable,
} from './constants';
import type { JiraSiteCredential } from './credential-store';
import { parseAtlassianTokenAnswer, type JiraTokenSet } from './oauth-tokens';
import { siteLabel } from './site';

const REQUEST_TIMEOUT_MS = 30_000;

const CLOSE_TAB_MESSAGE = msg({
  message: 'You can close this tab and return to Kangentic.',
  context: 'Jira sign-in browser page',
});
const SIGN_IN_FAILED_MESSAGE = msg({
  message: 'Atlassian sign-in did not finish. Return to Kangentic to try again.',
  context: 'Jira sign-in browser page',
});
const SIGN_IN_UNAVAILABLE_MESSAGE = msg({
  message: 'Sign in with Atlassian is not available in this build.',
  context: 'Jira connect error',
});
const NO_FREE_PORT_MESSAGE = msg({
  message: 'No local port was free for the Atlassian sign-in.',
  context: 'Jira connect error',
});
const TIMED_OUT_MESSAGE = msg({
  message: 'Atlassian sign-in timed out.',
  context: 'Jira connect error',
});
const BROWSER_NOT_OPENED_MESSAGE = msg({
  message: 'Could not open the browser for Atlassian sign-in.',
  context: 'Jira connect error',
});
const DECLINED_MESSAGE = msg({
  message: 'Atlassian sign-in was declined.',
  context: 'Jira connect error',
});
const ATLASSIAN_UNAVAILABLE_MESSAGE = msg({
  message: "Atlassian didn't answer the sign-in.",
  context: 'Jira connect error',
});
const SERVICE_FAILED_MESSAGE = msg({
  message: "Kangentic's sign-in service failed.",
  context: 'Jira connect error',
});
const NO_OFFLINE_ACCESS_MESSAGE = msg({
  message: "Atlassian's answer had no refresh token.",
  context: 'Jira connect error',
});

/** Atlassian's consent page for this attempt. kangentic.com is the redirect; the loopback port rides in `state`. */
export function buildJiraAuthorizeUrl(state: string): string {
  const url = new URL(JIRA_OAUTH_AUTHORIZE_URL);
  url.searchParams.set('audience', 'api.atlassian.com');
  url.searchParams.set('client_id', JIRA_OAUTH_CLIENT_ID);
  url.searchParams.set('scope', JIRA_OAUTH_SCOPES);
  url.searchParams.set('redirect_uri', JIRA_OAUTH_REDIRECT_URI);
  url.searchParams.set('state', state);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('prompt', 'consent');
  return url.toString();
}

/**
 * The line a failed sign-in shows. Atlassian's own description wins when it gave
 * one (the service cuts it to 300 characters). Otherwise the service's or
 * Atlassian's code: `access_denied` is a declined approval, `temporarily_unavailable`
 * an Atlassian outage, `server_error` the service itself, and any other code is
 * shown as it came.
 */
export function describeSignInError(code: string, description: string | null): string {
  if (description && description.trim().length > 0) return description.trim();
  switch (code) {
    case 'access_denied':
      return translateText(DECLINED_MESSAGE);
    case 'temporarily_unavailable':
      return translateText(ATLASSIAN_UNAVAILABLE_MESSAGE);
    case 'server_error':
      return translateText(SERVICE_FAILED_MESSAGE);
    default:
      return code;
  }
}

interface AccessibleResource {
  id: string;
  url: string;
}

async function accessibleResources(accessToken: string, fetchImpl: typeof fetch): Promise<AccessibleResource[]> {
  const response = await fetchImpl(ATLASSIAN_ACCESSIBLE_RESOURCES_URL, {
    headers: { Authorization: `Bearer ${accessToken}`, accept: 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new JiraHttpError('accessible-resources refused the sign-in', response.status, '', null);
  const body = (await response.json()) as unknown;
  if (!Array.isArray(body)) return [];
  return body.flatMap((entry: unknown) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const { id, url } = entry as { id?: unknown; url?: unknown };
    return typeof id === 'string' && typeof url === 'string' ? [{ id, url }] : [];
  });
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase();
  } catch { // report-ok: a resource URL that does not parse matches no site
    return null;
  }
}

/**
 * The cloud id of `site` among the sites this sign-in can open, or null. The
 * site's own tenant id is the match; a resource whose URL names the same host is
 * the fallback, for a site whose tenant info does not answer.
 */
export async function resolveCloudId(site: string, accessToken: string, fetchImpl: typeof fetch): Promise<string | null> {
  const resources = await accessibleResources(accessToken, fetchImpl);
  const tenantId = await fetchCloudId(site, fetchImpl).catch(() => null); // report-ok: the host match below still finds the site
  if (tenantId && resources.some((resource) => resource.id === tenantId)) return tenantId;
  const siteHost = hostOf(site);
  return resources.find((resource) => siteHost !== null && hostOf(resource.url) === siteHost)?.id ?? null;
}

export interface JiraSignInDependencies {
  /** The site's normalized base URL (`normalizeSiteBase`). */
  site: string;
  openExternal: (url: string) => Promise<void>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
}

/**
 * Sign in with Atlassian for one Cloud site. Opens Atlassian's consent page,
 * waits for kangentic.com to hand the sealed tokens to the loopback listener,
 * then checks that this sign-in can open the site and who it belongs to.
 * Resolves with the credential to save, a cancel, or the reason it failed; never
 * throws for an expected outcome.
 */
export async function signInWithAtlassian(
  dependencies: JiraSignInDependencies,
): Promise<LoopbackSignInResult<JiraSiteCredential>> {
  if (!isJiraSignInAvailable()) {
    return { ok: false, cancelled: false, error: translateText(SIGN_IN_UNAVAILABLE_MESSAGE) };
  }
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const now = dependencies.now ?? (() => Date.now());
  const keys = createSealedSignInKeys();
  const label = siteLabel(dependencies.site);

  const handleCallback = (params: URLSearchParams): LoopbackCallbackAnswer<JiraTokenSet> => {
    const callback = readSealedCallback(params, keys, JIRA_SEAL_INFO, '[jira/oauth]');
    switch (callback.kind) {
      case 'ignore':
        return callback;
      case 'error':
        return { kind: 'error', message: describeSignInError(callback.code, callback.description) };
      case 'unopened':
        return { kind: 'error', message: translateText(SERVICE_FAILED_MESSAGE) };
      case 'opened': {
        const tokens = parseAtlassianTokenAnswer(callback.plaintext, now());
        return tokens ? { kind: 'done', value: tokens } : { kind: 'error', message: translateText(NO_OFFLINE_ACCESS_MESSAGE) };
      }
    }
  };

  const cantOpenSite = (): LoopbackSignInFailure => {
    const site = label;
    return new LoopbackSignInFailure(translateText(msg`This sign-in can't open ${{ site }}.`));
  };

  const checkSignIn = async (tokens: JiraTokenSet): Promise<JiraSiteCredential> => {
    const cloudId = await resolveCloudId(dependencies.site, tokens.accessToken, fetchImpl);
    if (!cloudId) throw cantOpenSite();
    const credential: JiraSiteCredential = {
      site: dependencies.site,
      deployment: 'cloud',
      method: 'oauth',
      secret: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      cloudId,
      viaGateway: true,
      account: '',
      savedAt: new Date(now()).toISOString(),
    };
    // The probe never renews. The sign-in is not saved yet, and on a Reconnect the
    // store still holds the site's previous grant, which a renewal would spend.
    const myself = await new JiraClient(credential, fetchImpl, /* renews */ false).myself();
    return { ...credential, account: myself.emailAddress || myself.displayName || myself.name || label };
  };

  const finish = async (tokens: JiraTokenSet): Promise<JiraSiteCredential> => {
    try {
      return await checkSignIn(tokens);
    } catch (finishError) {
      // Atlassian's or Jira's own answer is the dialog's line. A refusal means this
      // sign-in can't open the site; an outage, a rate limit or the network means
      // Atlassian didn't answer. Anything else is thrown for the IPC wrap to report.
      if (finishError instanceof JiraHttpError) {
        if (finishError.status === 401 || finishError.status === 403) throw cantOpenSite();
        if (finishError.status >= 500 || finishError.status === 429) {
          throw new LoopbackSignInFailure(translateText(ATLASSIAN_UNAVAILABLE_MESSAGE));
        }
      }
      if (isNetworkFailure(finishError)) throw new LoopbackSignInFailure(translateText(ATLASSIAN_UNAVAILABLE_MESSAGE));
      throw finishError;
    }
  };

  return runLoopbackSignIn<JiraTokenSet, JiraSiteCredential>({
    provider: 'jira',
    path: JIRA_OAUTH_CALLBACK_PATH,
    ports: 'ephemeral',
    buildAuthorizeUrl: (port) => buildJiraAuthorizeUrl(keys.stateFor(port)),
    handleCallback,
    finish,
    pages: { done: translateText(CLOSE_TAB_MESSAGE), failed: translateText(SIGN_IN_FAILED_MESSAGE) },
    messages: {
      noFreePort: translateText(NO_FREE_PORT_MESSAGE),
      timedOut: translateText(TIMED_OUT_MESSAGE),
      browserNotOpened: translateText(BROWSER_NOT_OPENED_MESSAGE),
    },
    openExternal: dependencies.openExternal,
    timeoutMs: dependencies.timeoutMs ?? JIRA_SIGN_IN_TIMEOUT_MS,
    logPrefix: '[jira/oauth]',
  });
}

/** Open the pending sign-in's consent page again, for a browser tab the user closed. */
export function reopenJiraSignIn(): Promise<boolean> {
  return reopenLoopbackSignIn('jira');
}

/** Stop waiting for the browser. The pending `signInWithAtlassian` resolves as cancelled. */
export function cancelJiraSignIn(): void {
  cancelLoopbackSignIn('jira');
}
