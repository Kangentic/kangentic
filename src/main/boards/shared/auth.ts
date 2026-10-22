import { app, safeStorage } from 'electron';

/**
 * Credential storage helpers built on Electron's safeStorage, through its ASYNC
 * API only. Used by the Asana credential store and the mobile bridge identity.
 *
 * Why async only. Electron 45 deprecates the synchronous trio
 * (`isEncryptionAvailable` / `encryptString` / `decryptString`) and 46 removes
 * it. The async API also finds a Linux secret store the sync one misses: the
 * sync API only looks for a keyring on a fixed list of desktops, so on any other
 * (sway, i3, WSLg) it settles for `basic_text` even with a Secret Service
 * running, while the async API asks the Secret Service (or the portal) directly.
 * Measured on Electron 44.5.1 under WSLg with gnome-keyring running: sync
 * reported `basic_text` and refused to encrypt, async stored its key in the
 * keyring and encrypted for real.
 *
 * The async API reads what the sync API wrote. Electron 45's breaking-changes
 * entry says the async methods use the same per-platform key stores, and that
 * sync-written data decrypts with `decryptStringAsync`. Windows was measured:
 * DPAPI backs both, and on 44.5.1 and again on 45.0.0 a sync-written `v10` blob
 * decrypted through the async API. On 45.0.0 the sync call also printed its
 * deprecation warning. macOS and KDE were not measured. For them the evidence
 * is Chromium 156's key-provider sources. On macOS, `KeychainKeyProvider` is on
 * by default and reads the sync API's Keychain item with the sync backend's
 * `v10` key derivation. On KDE, `FreedesktopSecretKeyProvider` picks KWallet
 * from the desktop environment (or `--password-store`) and reads the sync API's
 * `<app> Keys` folder and `<app> Safe Storage` entry under `v11`. Earlier builds
 * kept the sync API as a fallback for those two, and this one has none, so
 * loadOrCreateBridgeIdentity moves an identity it cannot read aside rather than
 * writing a new one over it.
 *
 * Stored format, unchanged. A credential is a one-character sentinel plus
 * base64: 'e' for an encrypted blob, 'p' for plaintext (written only when no
 * encryption is available at all). Blobs written by the sync API in older
 * builds carry the same 'e' sentinel and read through the async API.
 *
 * Migration. `decryptSecret` reports a blob that should be written again:
 * - an 'e' blob Electron says should be re-encrypted (a rotated key, or a key
 *   with a better security level now available);
 * - a 'p' blob, once encryption is genuine, so a token saved in plaintext on a
 *   machine that had no secret store gets encrypted when one appears. On Linux
 *   that includes every desktop the sync API never searched for a keyring.
 * The two callers re-save on that signal.
 *
 * Linux and "genuine" encryption. With no secret store, the async API still
 * reports encryption as available: it falls back to a key derived from a
 * hardcoded password (Chromium's PosixKeyProvider), which protects nothing.
 * `getSelectedStorageBackend()` cannot tell that apart, because it describes
 * the SYNC API's backend and kept saying `basic_text` while the async API was
 * using a real keyring. The ciphertext can: Chromium tags Linux ciphertext with
 * the key that made it, `v10` for the hardcoded password, `v11` for the Secret
 * Service or KWallet, `v12` for the Secret portal. So on Linux, genuine means a
 * probe encryption is NOT tagged `v10`.
 *
 * All functions require app.whenReady(): the async encryptor initializes
 * lazily after `ready`.
 */

/** Chromium's Linux tag for ciphertext under the hardcoded fallback password. */
const LINUX_HARDCODED_KEY_TAG = 'v10';
const ENCRYPTION_TAG_LENGTH = 3;

function assertAppReady(): void {
  if (!app.isReady()) {
    throw new Error('Board auth helpers require app.whenReady() before use.');
  }
}

/**
 * The key provider does not change during a run, so the Linux probe runs once.
 * Cached as the promise so concurrent first callers share one probe.
 */
let linuxGenuineProbe: Promise<boolean> | null = null;

async function probeLinuxGenuineEncryption(): Promise<boolean> {
  const probe = await safeStorage.encryptStringAsync('kangentic-secure-storage-probe');
  return probe.subarray(0, ENCRYPTION_TAG_LENGTH).toString('latin1') !== LINUX_HARDCODED_KEY_TAG;
}

/** Whether the ASYNC API genuinely encrypts (on Linux: not under the `v10` key). */
async function isAsyncEncryptionGenuine(): Promise<boolean> {
  if (!(await safeStorage.isAsyncEncryptionAvailable())) return false;
  if (process.platform !== 'linux') return true;
  if (!linuxGenuineProbe) {
    linuxGenuineProbe = probeLinuxGenuineEncryption().catch((error: unknown) => {
      console.warn('[boards/auth] could not probe the Linux secret store; treating it as unavailable:', error);
      linuxGenuineProbe = null;
      return false;
    });
  }
  return linuxGenuineProbe;
}

/**
 * Whether safeStorage genuinely encrypts here, rather than not at all or (on
 * Linux) only with the hardcoded fallback key. The mobile bridge refuses to
 * persist its private key unless this is true.
 */
export async function isGenuineEncryptionAvailable(): Promise<boolean> {
  assertAppReady();
  return isAsyncEncryptionGenuine();
}

/**
 * Encrypt a string for JSON storage: 'e' + base64 ciphertext, or 'p' + base64
 * plaintext when no encryption is available at all. Picks the strongest key
 * that exists: a real key, then the Linux hardcoded fallback key, then
 * plaintext.
 */
export async function encryptSecret(plaintext: string): Promise<string> {
  assertAppReady();
  if (!(await safeStorage.isAsyncEncryptionAvailable())) {
    console.warn('[boards/auth] safeStorage encryption unavailable; persisting unencrypted');
    return 'p' + Buffer.from(plaintext, 'utf8').toString('base64');
  }
  if (!(await isAsyncEncryptionGenuine())) {
    console.warn('[boards/auth] Linux secret store unavailable; safeStorage will use its hardcoded fallback key');
  }
  return 'e' + (await safeStorage.encryptStringAsync(plaintext)).toString('base64');
}

export interface DecryptedSecret {
  plaintext: string;
  /** True when the stored blob should be written again with `encryptSecret`. See the module comment. */
  shouldRewrite: boolean;
}

/**
 * Decrypt a credential previously produced by encryptSecret (any version).
 * Throws if an encrypted blob cannot be decrypted - we never silently return
 * garbage, because that garbage would be sent as a token to a remote API.
 */
export async function decryptSecret(ciphertext: string): Promise<DecryptedSecret> {
  assertAppReady();
  if (!ciphertext) {
    throw new Error('decryptSecret called with empty ciphertext');
  }
  const sentinel = ciphertext[0];
  const body = ciphertext.slice(1);
  if (sentinel === 'p') {
    // Rewritten only once encryption is GENUINE: on Linux with no secret store
    // the async API would only re-wrap it under the hardcoded fallback key,
    // which protects nothing and changes the file for no gain.
    return {
      plaintext: Buffer.from(body, 'base64').toString('utf8'),
      shouldRewrite: await isGenuineEncryptionAvailable(),
    };
  }
  if (sentinel === 'e') {
    if (!(await safeStorage.isAsyncEncryptionAvailable())) {
      throw new Error('Stored credential is encrypted but safeStorage is unavailable in this session');
    }
    const decrypted = await safeStorage.decryptStringAsync(Buffer.from(body, 'base64'));
    return { plaintext: decrypted.result, shouldRewrite: decrypted.shouldReEncrypt };
  }
  throw new Error(`Unknown credential format sentinel: ${sentinel}`);
}

/** For tests: forget the cached Linux probe. */
export function resetSecureStorageProbeForTests(): void {
  linuxGenuineProbe = null;
}
