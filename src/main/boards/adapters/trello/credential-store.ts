import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from '../../../config/paths';
import {
  readEncryptedSecretFile,
  rewriteEncryptedSecretFile,
  writeEncryptedSecretFile,
  type EncryptedSecretFile,
} from '../../shared/encrypted-secret-file';
import type { TrelloConnectKind } from '../../../../shared/types';

/**
 * How the stored token was made: approved for Kangentic's own API key, or for a key the user
 * generated in a Trello app of their own.
 */
export type TrelloCredentialKind = TrelloConnectKind;

/**
 * The Trello API key and user token. Stored globally, not per project, because the token is the
 * user's Trello identity and one Connect should work in every project. On disk the JSON file holds
 * only the `encrypted` field (boards/shared/encrypted-secret-file.ts).
 */
export interface TrelloCredential {
  kind: TrelloCredentialKind;
  apiKey: string;
  token: string;
  savedAt: string;
}

const STORE_FILENAME = 'trello-credentials.json';

function storePath(): string {
  return path.join(PATHS.configDir, STORE_FILENAME);
}

function credentialFile(): EncryptedSecretFile {
  return {
    filePath: storePath(),
    writeSource: 'trello_credential',
    logPrefix: '[trello/credential-store]',
    noun: 'credential',
  };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function parseCredential(plaintext: string): TrelloCredential | null {
  const credential = JSON.parse(plaintext) as Partial<TrelloCredential> | null;
  // Both halves must be there: a request with an empty key or token fails on Trello's side with a
  // message about the other half, which would hide that nothing usable was stored.
  if (!isNonEmptyString(credential?.apiKey) || !isNonEmptyString(credential?.token)) return null;
  return {
    kind: credential.kind === 'kangentic-key' ? 'kangentic-key' : 'own-key',
    apiKey: credential.apiKey,
    token: credential.token,
    savedAt: typeof credential.savedAt === 'string' ? credential.savedAt : '',
  };
}

export async function loadTrelloCredential(): Promise<TrelloCredential | null> {
  const file = credentialFile();
  const read = await readEncryptedSecretFile(file, parseCredential);
  if (!read) return null;
  // Same re-encryption as Asana's store: the credential in hand is good either way, and the
  // rewrite skips a file a clear or a new save changed while this load awaited.
  if (read.shouldRewrite) await rewriteEncryptedSecretFile(file, read);
  return read.value;
}

/**
 * Bumped by every save and clear. A client that holds a credential in memory (the registry's
 * adapter keeps one client for the app's life) compares it to reload after a Connect with a new
 * token or a Disconnect, instead of reading the file on every request.
 */
let credentialVersion = 0;

export function trelloCredentialVersion(): number {
  return credentialVersion;
}

export async function saveTrelloCredential(credential: TrelloCredential): Promise<void> {
  credentialVersion += 1;
  await writeEncryptedSecretFile(credentialFile(), JSON.stringify(credential));
}

/** Deletes the stored credential. A missing file is already cleared; a locked one throws. */
export function clearTrelloCredential(): void {
  credentialVersion += 1;
  fs.rmSync(storePath(), { force: true });
}
