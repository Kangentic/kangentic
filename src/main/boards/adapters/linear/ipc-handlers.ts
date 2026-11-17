import { ipcMain, shell } from 'electron';
import { msg } from '@lingui/core/runtime-macro';
import { translateText } from '../../../i18n/main-i18n';
import { IPC } from '../../../../shared/ipc-channels';
import { RefusalError } from '../../../../shared/refusal';
import type {
  LinearAuthStatus,
  LinearConnectResult,
  LinearListTeamsResult,
  LinearSetApiKeyInput,
} from '../../../../shared/types';
import { LinearClient, type LinearViewer } from './client';
import type { LinearCredential } from './credential-store';
import { LinearError } from './linear-error';
import {
  cancelLinearSignIn,
  isLinearSignInAvailable,
  reopenLinearSignIn,
  signInWithBrowser,
} from './oauth';
import { revokeToken } from './oauth-tokens';
import { buildLinearTeamUrl } from './url-parser';

const EMPTY_KEY_MESSAGE = msg({ message: 'Paste your API key.', context: 'Linear connect error' });
const KEY_HAS_SPACES_MESSAGE = msg({
  message: 'An API key has no spaces. Copy it again from Linear.',
  context: 'Linear connect error',
});

/**
 * Linear's refusal is the user's answer to show (a bad key, a declined approval,
 * a revoked sign-in), so it comes back as a result. Anything else is a defect and
 * rethrows, where the IPC wrap reports it.
 */
function isAnswerForUser(error: unknown): error is LinearError | RefusalError {
  return error instanceof LinearError || error instanceof RefusalError;
}

function credentialBase(viewer: LinearViewer): Pick<LinearCredential, 'userName' | 'organizationUrlKey' | 'savedAt'> {
  return {
    userName: viewer.displayName || viewer.name,
    organizationUrlKey: viewer.organization.urlKey,
    savedAt: new Date().toISOString(),
  };
}

/**
 * Register every Linear `ipcMain.handle` channel. Called once from
 * `registerBacklogHandlers`, so the Linear IPC lives in the adapter folder.
 */
export function registerLinearIpcHandlers(): void {
  ipcMain.handle(IPC.BOARDS_LINEAR_AUTH_STATUS, async (): Promise<LinearAuthStatus> => {
    const credential = await new LinearClient().getCredential();
    return {
      connected: credential !== null,
      kind: credential?.kind,
      userName: credential?.userName || undefined,
      signInAvailable: isLinearSignInAvailable(),
    };
  });

  ipcMain.handle(
    IPC.BOARDS_LINEAR_SET_API_KEY,
    async (_, input: LinearSetApiKeyInput): Promise<LinearConnectResult> => {
      const apiKey = typeof input?.apiKey === 'string' ? input.apiKey.trim() : '';
      if (apiKey.length === 0) return { ok: false, error: translateText(EMPTY_KEY_MESSAGE) };
      if (/\s/.test(apiKey)) return { ok: false, error: translateText(KEY_HAS_SPACES_MESSAGE) };
      try {
        const viewer = await LinearClient.validateApiKey(apiKey);
        await new LinearClient().saveCredential({ ...credentialBase(viewer), kind: 'api_key', apiKey });
        return { ok: true };
      } catch (error) {
        if (!isAnswerForUser(error)) throw error;
        return { ok: false, error: error.message };
      }
    },
  );

  ipcMain.handle(IPC.BOARDS_LINEAR_SIGN_IN, async (): Promise<LinearConnectResult> => {
    try {
      const result = await signInWithBrowser({ openExternal: (url) => shell.openExternal(url) });
      if (!result.ok) {
        return result.cancelled ? { ok: false, cancelled: true } : { ok: false, error: result.error };
      }
      let viewer: LinearViewer;
      try {
        viewer = await LinearClient.validateAccessToken(result.tokens.accessToken);
      } catch (validationError) {
        // The pair is never saved, so hand the grant back instead of leaving it live at Linear.
        await revokeToken(result.tokens.refreshToken).catch((revokeError: unknown) => {
          // report-ok: a revoke Linear refuses or cannot take leaves a grant no saved credential can use; the sign-in's own error below is the answer.
          console.warn('[linear/ipc] revoke after a failed sign-in failed:', revokeError instanceof Error ? revokeError.name : 'unknown');
        });
        throw validationError;
      }
      await new LinearClient().saveCredential({ ...credentialBase(viewer), kind: 'oauth', ...result.tokens });
      return { ok: true };
    } catch (error) {
      if (!isAnswerForUser(error)) throw error;
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle(IPC.BOARDS_LINEAR_REOPEN_SIGN_IN, async (): Promise<void> => {
    await reopenLinearSignIn();
  });

  ipcMain.handle(IPC.BOARDS_LINEAR_CANCEL_SIGN_IN, async (): Promise<void> => {
    cancelLinearSignIn();
  });

  ipcMain.handle(IPC.BOARDS_LINEAR_LIST_TEAMS, async (): Promise<LinearListTeamsResult> => {
    const client = new LinearClient();
    try {
      const credential = await client.getCredential();
      const teams = await client.listTeams();
      const organizationUrlKey = credential?.organizationUrlKey ?? '';
      return {
        teams: teams.map((team) => ({
          id: team.id,
          key: team.key,
          name: team.name,
          url: buildLinearTeamUrl(organizationUrlKey, team.key),
        })),
      };
    } catch (error) {
      if (!isAnswerForUser(error)) throw error;
      return { teams: [], error: error.message };
    }
  });
}
