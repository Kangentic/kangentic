import { msg } from '@lingui/core/runtime-macro';
import { translateText } from '../../../i18n/main-i18n';
import {
  LoopbackSignInFailure,
  cancelLoopbackSignIn,
  reopenLoopbackSignIn,
  runLoopbackSignIn,
  type LoopbackCallbackAnswer,
  type LoopbackSignInResult,
} from '../../shared/loopback-sign-in';
import { TRELLO_SEAL_INFO, createSealedSignInKeys, readSealedCallback } from '../../shared/sealed-token';
import { TrelloError } from './client';
import {
  TRELLO_API_KEY,
  TRELLO_SIGN_IN_CALLBACK_PATH,
  TRELLO_SIGN_IN_TIMEOUT_MS,
  buildAuthorizeUrl,
  isTrelloSignInAvailable,
} from './constants';

const CLOSE_TAB_MESSAGE = msg({
  message: 'You can close this tab and return to Kangentic.',
  context: 'Trello sign-in browser page',
});
const SIGN_IN_FAILED_MESSAGE = msg({
  message: 'Trello sign-in did not finish. Return to Kangentic to try again.',
  context: 'Trello sign-in browser page',
});
const SIGN_IN_UNAVAILABLE_MESSAGE = msg({
  message: 'This build has no Kangentic Trello key. Use your own API key.',
  context: 'Trello connect error',
});
const NO_FREE_PORT_MESSAGE = msg({
  message: 'No local port was free for the Trello sign-in.',
  context: 'Trello connect error',
});
const TIMED_OUT_MESSAGE = msg({
  message: 'Trello sign-in timed out.',
  context: 'Trello connect error',
});
const BROWSER_NOT_OPENED_MESSAGE = msg({
  message: 'Could not open the browser for Trello sign-in.',
  context: 'Trello connect error',
});
const DECLINED_MESSAGE = msg({
  message: 'Trello sign-in was declined.',
  context: 'Trello connect error',
});
const RETURN_PAGE_FAILED_MESSAGE = msg({
  message: "Kangentic's sign-in page failed.",
  context: 'Trello connect error',
});

/**
 * The line a failed sign-in shows: the return page's description when it gave one,
 * a declined approval for `access_denied`, and any other code as it came.
 */
export function describeTrelloSignInError(code: string, description: string | null): string {
  if (description && description.trim().length > 0) return description.trim();
  if (code === 'access_denied') return translateText(DECLINED_MESSAGE);
  return code;
}

/** The token the return page sealed, `{ "token": "..." }`, or null when the plaintext holds none. */
function sealedToken(plaintext: string): string | null {
  try {
    const sealed = JSON.parse(plaintext) as { token?: unknown } | null;
    return typeof sealed?.token === 'string' && /^\S+$/.test(sealed.token) ? sealed.token : null;
  } catch { // report-ok: a plaintext that is not JSON is the return page failing, which the dialog shows
    return null;
  }
}

export interface TrelloSignInDependencies {
  openExternal: (url: string) => Promise<void>;
  /** Check the token with Trello before it is saved; throws `TrelloError` for a refusal. */
  validate: (token: string) => Promise<void>;
  timeoutMs?: number;
}

/**
 * Sign in with Trello on Kangentic's own key, with nothing to paste. Trello's
 * approval page returns to kangentic.com, whose page seals the token to this
 * attempt's key and hands it to the loopback listener. Resolves with the token,
 * checked with Trello, a cancel, or the reason it failed; never throws for an
 * expected outcome. The user's own key never comes here: its allowed origins are
 * not kangentic.com, so it stays paste-only.
 */
export async function signInWithTrello(dependencies: TrelloSignInDependencies): Promise<LoopbackSignInResult<string>> {
  if (!isTrelloSignInAvailable()) {
    return { ok: false, cancelled: false, error: translateText(SIGN_IN_UNAVAILABLE_MESSAGE) };
  }
  const keys = createSealedSignInKeys();

  const handleCallback = (params: URLSearchParams): LoopbackCallbackAnswer<string> => {
    const callback = readSealedCallback(params, keys, TRELLO_SEAL_INFO, '[trello/oauth]');
    if (callback.kind === 'ignore') return callback;
    if (callback.kind === 'error') {
      return { kind: 'error', message: describeTrelloSignInError(callback.code, callback.description) };
    }
    const token = callback.kind === 'opened' ? sealedToken(callback.plaintext) : null;
    return token ? { kind: 'done', value: token } : { kind: 'error', message: translateText(RETURN_PAGE_FAILED_MESSAGE) };
  };

  const finish = async (token: string): Promise<string> => {
    try {
      await dependencies.validate(token);
    } catch (validateError) {
      // Trello's own answer (a refused token) is the dialog's line; anything else is reported by the IPC wrap.
      if (validateError instanceof TrelloError) throw new LoopbackSignInFailure(validateError.message);
      throw validateError;
    }
    return token;
  };

  return runLoopbackSignIn<string, string>({
    provider: 'trello',
    path: TRELLO_SIGN_IN_CALLBACK_PATH,
    ports: 'ephemeral',
    buildAuthorizeUrl: (port) => buildAuthorizeUrl(TRELLO_API_KEY, { returnState: keys.stateFor(port) }),
    handleCallback,
    finish,
    pages: { done: translateText(CLOSE_TAB_MESSAGE), failed: translateText(SIGN_IN_FAILED_MESSAGE) },
    messages: {
      noFreePort: translateText(NO_FREE_PORT_MESSAGE),
      timedOut: translateText(TIMED_OUT_MESSAGE),
      browserNotOpened: translateText(BROWSER_NOT_OPENED_MESSAGE),
    },
    openExternal: dependencies.openExternal,
    timeoutMs: dependencies.timeoutMs ?? TRELLO_SIGN_IN_TIMEOUT_MS,
    logPrefix: '[trello/oauth]',
  });
}

export function reopenTrelloSignIn(): Promise<boolean> {
  return reopenLoopbackSignIn('trello');
}

export function cancelTrelloSignIn(): void {
  cancelLoopbackSignIn('trello');
}
