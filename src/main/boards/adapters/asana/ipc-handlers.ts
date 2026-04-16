import { ipcMain } from 'electron';
import { IPC } from '../../../../shared/ipc-channels';
import type {
  AsanaAuthStatus,
  AsanaSetPatInput,
  AsanaSetPatResult,
} from '../../../../shared/types';
import { clearAsanaCredential } from './credential-store';
import { AsanaClient } from './client';

/**
 * Register every Asana-related `ipcMain.handle` channel. Called once from
 * `registerBacklogHandlers` during app startup. All Asana IPC surface lives
 * in this file so the adapter folder is self-contained.
 */
export function registerAsanaIpcHandlers(): void {
  ipcMain.handle(IPC.BOARDS_ASANA_AUTH_STATUS, async (): Promise<AsanaAuthStatus> => {
    const client = new AsanaClient();
    if (!client.hasCredential()) {
      return { connected: false };
    }
    return {
      connected: true,
      email: client.getCredentialEmail() || undefined,
    };
  });

  ipcMain.handle(
    IPC.BOARDS_ASANA_SET_PAT,
    async (_, input: AsanaSetPatInput): Promise<AsanaSetPatResult> => {
      const token = typeof input?.token === 'string' ? input.token.trim() : '';
      if (token.length === 0) {
        return { ok: false, error: 'Personal Access Token cannot be empty.' };
      }
      // Sanity check the format. Asana PATs are long (>30 chars) and Base64URL-ish.
      // Reject obvious pastes like quoted values or full URLs.
      if (token.length < 30 || /\s/.test(token)) {
        return {
          ok: false,
          error: 'That does not look like an Asana Personal Access Token. Copy the full token from app.asana.com/0/my-apps.',
        };
      }

      try {
        const client = new AsanaClient();
        const user = await client.validateToken(token);
        const email = user.email ?? '';
        client.saveCredential(token, email);
        return { ok: true, email: email || undefined };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Asana token validation failed.';
        return { ok: false, error: message };
      }
    },
  );

  ipcMain.handle(IPC.BOARDS_ASANA_CLEAR_CREDENTIAL, async () => {
    clearAsanaCredential();
  });
}
