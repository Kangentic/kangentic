import { app, safeStorage } from 'electron';

/**
 * Credential storage helpers built on Electron's safeStorage, through its ASYNC
 * API. Used by the Asana credential store and the mobile bridge identity.
 *
 * Why async. Electron 44 recommends `encryptStringAsync` / `decryptStringAsync`
 * / `isAsyncEncryptionAvailable`; the synchronous trio is deprecated in 45 and
 * removed in 46. The async API also finds a Linux secret store the sync one
 * misses: the sync API only looks for a keyring on a fixed list of desktops, so
 * on any other (sway, i3, WSLg) it settles for `basic_text` even with a Secret
 * Service running, while the async API asks the Secret Service (or the portal)
 * directly. Measured on Electron 44.5.1 under WSLg with gnome-keyring running:
 * sync reported `basic_text` and refused to encrypt, async stored its key in the
 * keyring and encrypted for real.
 *
 * Stored format, unchanged. A credential is a one-character sentinel plus
 * base64: 'e' for an encrypted blob, 'p' for plaintext (written only when no
 * encryption is available at all). Async-written blobs keep the 'e' sentinel
 * because the two APIs share one ciphertext format wherever both work: measured
 * on 44.5.1, async decrypts sync-written blobs and sync decrypts async-written
 * ones, on Windows (DPAPI, tag `v10`) and on Linux with a keyring (`v11`).
 * Electron's own docs say the same for sync-written data on every platform.
 *
 * Migration. `decryptSecret` reports a blob that should be written again:
 * - an 'e' blob the async API could not read but the sync API could (the async
 *   key provider differs from the one that wrote it), read through the sync
 *   API while it still exists;
 * - an 'e' blob Electron says should be re-encrypted (a rotated key, or a key
 *   with a better security level now available);
 * - a 'p' blob, once encryption is genuine, so a token saved in plaintext on a
 *   machine that had no secret store gets encrypted when one appears. On Linux
 *   that includes every desktop the sync API never searched for a keyring.
 * The two callers re-save on that signal. A downgrade to a build older than this
 * change is not supported; the format did not change, so one still reads these
 * blobs wherever its sync API can.
 *
 * Linux and "genuine" encryption. With no secret store, the async API still
 * reports encryption as available: it falls back to a key derived from a
 * hardcoded password (Chromium's PosixKeyProvider), which protects nothing.
 * `getSelectedStorageBackend()` cannot tell that apart, because it describes
 * the SYNC API only and kept saying `basic_text` while the async API was using
 * a real keyring. The ciphertext can: Chromium tags Linux ciphertext with the
 * key that made it, `v10` for the hardcoded password, `v11` for the Secret
 * Service, `v12` for the Secret portal. So on Linux, genuine means a probe
 * encryption is NOT tagged `v10`.
 *
 * The sync API stays as a FLOOR while it exists: where the async API does not
 * genuinely encrypt but the sync one does, encryptSecret writes through the
 * sync API and isGenuineEncryptionAvailable trusts it, so no machine ends up
 * worse than 0.43 left it (a plaintext token, a token under the hardcoded key,
 * a paired phone disposed). Nothing measured needed it on Windows or on Linux
 * with gnome-keyring, where both APIs agreed. It covers macOS, not measured
 * here; KDE with KWallet, which the sync API reaches and the async providers
 * (Secret portal, Secret Service) may not; and a future provider failure.
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
 * The FLOOR: whether the sync API genuinely encrypts, exactly as 0.43 decided
 * it. Consulted when the async API does not genuinely encrypt, so a machine
 * where only the sync API reaches a real key keeps encrypting with it and keeps
 * its paired phones. On Linux the sync API refuses to encrypt on `basic_text`
 * (Electron 44), so "available" there already means a keyring, KWallet
 * included, which the async API's providers do not ask.
 */
function isSyncEncryptionGenuine(): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false;
  if (process.platform !== 'linux') return true;
  if (typeof safeStorage.getSelectedStorageBackend !== 'function') return false;
  return safeStorage.getSelectedStorageBackend() !== 'basic_text';
}

/**
 * Whether safeStorage genuinely encrypts here, through either API, rather than
 * not at all or (on Linux) only with the hardcoded fallback key. The mobile
 * bridge refuses to persist its private key unless this is true.
 */
export async function isGenuineEncryptionAvailable(): Promise<boolean> {
  assertAppReady();
  return (await isAsyncEncryptionGenuine()) || isSyncEncryptionGenuine();
}

/**
 * Encrypt a string for JSON storage: 'e' + base64 ciphertext, or 'p' + base64
 * plaintext when no encryption is available at all. Picks the strongest key
 * that exists: the async API's real key, then the sync API's (the floor), then
 * the async API's hardcoded fallback key, then plaintext.
 */
export async function encryptSecret(plaintext: string): Promise<string> {
  assertAppReady();
  if (await isAsyncEncryptionGenuine()) {
    return 'e' + (await safeStorage.encryptStringAsync(plaintext)).toString('base64');
  }
  if (isSyncEncryptionGenuine()) {
    return 'e' + safeStorage.encryptString(plaintext).toString('base64');
  }
  if (await safeStorage.isAsyncEncryptionAvailable()) {
    console.warn('[boards/auth] Linux secret store unavailable; safeStorage will use its hardcoded fallback key');
    return 'e' + (await safeStorage.encryptStringAsync(plaintext)).toString('base64');
  }
  console.warn('[boards/auth] safeStorage encryption unavailable; persisting unencrypted');
  return 'p' + Buffer.from(plaintext, 'utf8').toString('base64');
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
    const encrypted = Buffer.from(body, 'base64');
    let asyncError: unknown = null;
    if (await safeStorage.isAsyncEncryptionAvailable()) {
      try {
        const decrypted = await safeStorage.decryptStringAsync(encrypted);
        return { plaintext: decrypted.result, shouldRewrite: decrypted.shouldReEncrypt };
      } catch (error) {
        asyncError = error;
      }
    }
    // A blob the sync API wrote under a key the async provider does not hold.
    // Read it the old way while that API exists. Ask for a rewrite only when
    // the async API genuinely encrypts, so the rewrite moves it there; where
    // the floor would write it, a rewrite would only repeat on every load.
    if (safeStorage.isEncryptionAvailable()) {
      return { plaintext: safeStorage.decryptString(encrypted), shouldRewrite: await isAsyncEncryptionGenuine() };
    }
    if (asyncError) throw asyncError;
    throw new Error('Stored credential is encrypted but safeStorage is unavailable in this session');
  }
  throw new Error(`Unknown credential format sentinel: ${sentinel}`);
}

/** For tests: forget the cached Linux probe. */
export function resetSecureStorageProbeForTests(): void {
  linuxGenuineProbe = null;
}
