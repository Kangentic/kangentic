import { ipcMain, shell } from 'electron';
import { msg } from '@lingui/core/runtime-macro';
import { translateText } from '../../../i18n/main-i18n';
import { IPC } from '../../../../shared/ipc-channels';
import { RefusalError } from '../../../../shared/refusal';
import type {
  TrelloAuthStatus,
  TrelloConnectInput,
  TrelloConnectKind,
  TrelloConnectResult,
  TrelloListBoardsResult,
  TrelloOpenApprovalInput,
} from '../../../../shared/types';
import { TrelloClient, TrelloError } from './client';
import { TRELLO_API_KEY, buildAuthorizeUrl, isTrelloSignInAvailable } from './constants';
import { clearTrelloCredential } from './credential-store';

const EMPTY_KEY_MESSAGE = msg({ message: 'Paste your API key.', context: 'Trello connect error' });
const EMPTY_TOKEN_MESSAGE = msg({ message: 'Paste the token Trello shows.', context: 'Trello connect error' });
const HAS_SPACES_MESSAGE = msg({
  message: 'A key or token has no spaces. Copy it again from Trello.',
  context: 'Trello connect error',
});
const SIGN_IN_UNAVAILABLE_MESSAGE = msg({
  message: 'This build has no Kangentic Trello key. Use your own API key.',
  context: 'Trello connect error',
});

/**
 * Anything Trello answered during a Connect (a bad key, a revoked token, an outage) is shown in
 * the dialog under the field it names, so it comes back as a result. Anything else is a defect or
 * a network failure and rethrows, where the IPC wrap reports it.
 */
function isAnswerForUser(error: unknown): error is TrelloError | RefusalError {
  return error instanceof TrelloError || error instanceof RefusalError;
}

/**
 * Trello refusing the saved credential (its 401), or no credential saved: the board list's answer
 * that sends the user to Connect. A 429, a 5xx or a body that is not JSON is not a refusal, so it
 * rethrows and the picker shows it in place.
 */
function isCredentialRefusal(error: unknown): error is TrelloError | RefusalError {
  return error instanceof RefusalError || (error instanceof TrelloError && error.status === 401);
}

/** The kind a renderer sent, read defensively: anything but Kangentic's own key is the user's. */
function connectKindOf(input: { kind?: unknown } | null | undefined): TrelloConnectKind {
  return input?.kind === 'kangentic-key' ? 'kangentic-key' : 'own-key';
}

/** Why a key cannot be used, with the field it blames. */
interface KeyRefusal {
  field?: 'apiKey';
  error: string;
}

/** The key a Connect or an approval uses: Kangentic's own, or the one the user pasted. */
function resolveApiKey(kind: TrelloConnectKind, pastedKey: unknown): { apiKey: string } | { refusal: KeyRefusal } {
  if (kind === 'kangentic-key') {
    if (!isTrelloSignInAvailable()) return { refusal: { error: translateText(SIGN_IN_UNAVAILABLE_MESSAGE) } };
    return { apiKey: TRELLO_API_KEY };
  }
  const apiKey = typeof pastedKey === 'string' ? pastedKey.trim() : '';
  if (apiKey.length === 0) return { refusal: { field: 'apiKey', error: translateText(EMPTY_KEY_MESSAGE) } };
  if (/\s/.test(apiKey)) return { refusal: { field: 'apiKey', error: translateText(HAS_SPACES_MESSAGE) } };
  return { apiKey };
}

/**
 * Register every Trello `ipcMain.handle` channel. Called once from `registerBacklogHandlers`, so
 * the Trello IPC lives in the adapter folder.
 */
export function registerTrelloIpcHandlers(): void {
  ipcMain.handle(IPC.BOARDS_TRELLO_AUTH_STATUS, async (): Promise<TrelloAuthStatus> => {
    const credential = await new TrelloClient().getCredential();
    return {
      connected: credential !== null,
      kind: credential?.kind,
      signInAvailable: isTrelloSignInAvailable(),
    };
  });

  ipcMain.handle(
    IPC.BOARDS_TRELLO_CONNECT,
    async (_, input: TrelloConnectInput): Promise<TrelloConnectResult> => {
      const kind = connectKindOf(input);
      const resolved = resolveApiKey(kind, input?.apiKey);
      if ('refusal' in resolved) return { ok: false, ...resolved.refusal };
      const token = typeof input?.token === 'string' ? input.token.trim() : '';
      if (token.length === 0) return { ok: false, field: 'token', error: translateText(EMPTY_TOKEN_MESSAGE) };
      if (/\s/.test(token)) return { ok: false, field: 'token', error: translateText(HAS_SPACES_MESSAGE) };
      const client = new TrelloClient();
      try {
        await client.validate(resolved.apiKey, token);
        await client.saveCredential(kind, resolved.apiKey, token);
        return { ok: true };
      } catch (error) {
        if (!isAnswerForUser(error)) throw error;
        // Kangentic's own key is not the user's to fix, so a refusal there is about the token.
        const blamedField = error instanceof TrelloError ? error.field : undefined;
        const field = kind === 'kangentic-key' ? 'token' : blamedField ?? 'token';
        return { ok: false, field, error: error.message };
      }
    },
  );

  ipcMain.handle(
    IPC.BOARDS_TRELLO_OPEN_APPROVAL,
    async (_, input: TrelloOpenApprovalInput): Promise<void> => {
      const resolved = resolveApiKey(connectKindOf(input), input?.apiKey);
      if ('refusal' in resolved) throw new RefusalError(resolved.refusal.error);
      await shell.openExternal(buildAuthorizeUrl(resolved.apiKey));
    },
  );

  ipcMain.handle(IPC.BOARDS_TRELLO_LIST_BOARDS, async (): Promise<TrelloListBoardsResult> => {
    try {
      return { boards: await new TrelloClient().listBoards() };
    } catch (error) {
      if (!isCredentialRefusal(error)) throw error;
      return { boards: [], error: error.message };
    }
  });

  ipcMain.handle(IPC.BOARDS_TRELLO_CLEAR_CREDENTIAL, async (): Promise<void> => {
    clearTrelloCredential();
  });
}
