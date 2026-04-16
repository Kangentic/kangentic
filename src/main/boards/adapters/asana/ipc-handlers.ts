import { ipcMain } from 'electron';
import { IPC } from '../../../../shared/ipc-channels';
import type {
  AsanaAppConfigInput,
  AsanaAppConfigStatus,
  AsanaAuthStatus,
  AsanaSetAppConfigResult,
} from '../../../../shared/types';
import {
  clearAsanaAppCredentials,
  loadAsanaAppCredentials,
  saveAsanaAppCredentials,
} from './app-config-store';
import {
  clearAsanaCredential,
  loadAsanaCredential,
  saveAsanaCredential,
} from './credential-store';
import { completeAsanaOAuth, isOAuthConfigured, startAsanaOAuth } from './oauth';
import { AsanaClient } from './client';

/**
 * Register every Asana-related `ipcMain.handle` channel. Called once from
 * `registerBacklogHandlers` during app startup. All Asana IPC surface lives
 * in this file so the adapter folder is self-contained.
 */
export function registerAsanaIpcHandlers(): void {
  ipcMain.handle(IPC.BOARDS_ASANA_AUTH_STATUS, async (): Promise<AsanaAuthStatus> => {
    const appCredentials = loadAsanaAppCredentials();
    const appConfigured = appCredentials !== null;
    const configured = isOAuthConfigured();
    if (!configured) {
      return { connected: false, configured: false, appConfigured };
    }
    const credential = loadAsanaCredential();
    if (!credential) {
      return { connected: false, configured: true, appConfigured };
    }
    return {
      connected: true,
      configured: true,
      appConfigured,
      email: credential.userEmail || undefined,
    };
  });

  ipcMain.handle(IPC.BOARDS_ASANA_GET_APP_CONFIG, async (): Promise<AsanaAppConfigStatus> => {
    const appCredentials = loadAsanaAppCredentials();
    return {
      clientId: appCredentials?.clientId ?? '',
      // Never echo the secret back to the renderer - only whether one is set.
      clientSecretSet: Boolean(appCredentials?.clientSecret),
    };
  });

  ipcMain.handle(
    IPC.BOARDS_ASANA_SET_APP_CONFIG,
    async (_, input: AsanaAppConfigInput): Promise<AsanaSetAppConfigResult> => {
      const clientId = typeof input?.clientId === 'string' ? input.clientId.trim() : '';
      let clientSecret = typeof input?.clientSecret === 'string' ? input.clientSecret.trim() : '';

      if (clientId.length === 0) return { ok: false, error: 'Client ID cannot be empty.' };

      // Asana client IDs are 16+ digit decimals. Reject obvious pastes like
      // URLs, quoted values, or placeholder text; Asana itself surfaces any
      // syntactically-valid ID that turns out to be wrong.
      if (!/^\d{6,32}$/.test(clientId)) {
        return {
          ok: false,
          error: 'Client ID must be the numeric value Asana displayed (no URL, no quotes).',
        };
      }

      // Allow the user to leave the secret blank when reconfiguring to keep
      // the previously-stored one. This way changing only the client_id
      // doesn't force them to fetch the secret from Asana again.
      if (clientSecret.length === 0) {
        const existing = loadAsanaAppCredentials();
        if (existing?.clientSecret) {
          clientSecret = existing.clientSecret;
        } else {
          return { ok: false, error: 'Client Secret cannot be empty.' };
        }
      } else if (clientSecret.length < 16) {
        return {
          ok: false,
          error: 'Client Secret looks too short. Copy it from the Asana app settings page.',
        };
      }

      try {
        saveAsanaAppCredentials({ clientId, clientSecret });
        // A freshly-changed app identity invalidates any saved user tokens.
        clearAsanaCredential();
        return { ok: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to save app credentials.';
        return { ok: false, error: message };
      }
    },
  );

  ipcMain.handle(IPC.BOARDS_ASANA_CLEAR_APP_CONFIG, async () => {
    clearAsanaAppCredentials();
    clearAsanaCredential();
  });

  ipcMain.handle(IPC.BOARDS_ASANA_OAUTH_START, async () => {
    return startAsanaOAuth();
  });

  ipcMain.handle(
    IPC.BOARDS_ASANA_OAUTH_COMPLETE,
    async (_, input: { pendingId: string; code: string }) => {
      try {
        const credential = await completeAsanaOAuth(input.pendingId, input.code);
        // Prefer the email from the token response. If missing (older scopes,
        // or the workspace doesn't expose email), hit /users/me once to fill
        // it in so the UI has something to display.
        if (!credential.userEmail) {
          try {
            const client = new AsanaClient(credential);
            const user = await client.getMe();
            if (user.email) credential.userEmail = user.email;
          } catch {
            /* email enrichment is best-effort */
          }
        }
        saveAsanaCredential(credential);
        return { ok: true, email: credential.userEmail || undefined };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Asana authentication failed';
        return { ok: false, error: message };
      }
    },
  );

  ipcMain.handle(IPC.BOARDS_ASANA_CLEAR_CREDENTIAL, async () => {
    clearAsanaCredential();
  });
}
