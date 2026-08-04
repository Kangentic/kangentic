/**
 * Dev-only instant pairing for the mobile companion's local dev rig - the
 * "hot path" that skips the QR/SAS ceremony entirely when BOTH sides are
 * development builds on the same machine.
 *
 * How it works: while the bridge is enabled in a dev build, this module
 * mirrors a tiny handshake through the repo's gitignored `.kangentic/`
 * directory. The desktop writes `mobile-dev-pairing/desktop.json` (its
 * static public key + relay URL); the mobile repo's dev rig reads it,
 * writes `mobile-dev-pairing/phone.json` (the rig's persistent dev phone
 * public key), and this module adopts that key straight into the signed
 * device roster with every capability granted. The rig then hands the
 * matching phone SECRET key to the app through a dev-only env var, and
 * the ongoing session connects with no in-app pairing.
 *
 * Security posture: this is a deliberate dev backdoor and must never exist
 * in production. `MobileBridgeService` constructs this class only behind a
 * `__KANGENTIC_DEV__ ? new DevQuickPair(...) : null` guard, not as an
 * unconditional field initializer - gating only the later `.reconcile()`
 * call is NOT enough, since esbuild's dead-code elimination cannot drop a
 * class that is still constructed unconditionally even if none of its
 * methods are ever invoked. With construction itself gated, esbuild
 * dead-code-eliminates this whole module from packaged builds. The exchange
 * only trusts files inside this repo checkout on the developer's own
 * machine, and only PUBLIC keys cross it. The QR/SAS ceremony remains the
 * only pairing path everywhere else.
 */
import fs from 'node:fs';
import path from 'node:path';
import { bytesToHex, CAPABILITY_VERBS, hexToBytes } from '@kangentic/protocol';
import type { BridgeIdentity } from './identity';
import { addOrReplaceDevice, loadRoster } from './roster-store';

const DESKTOP_FILE = 'desktop.json';
const PHONE_FILE = 'phone.json';
const DEV_DEVICE_DISPLAY_NAME = 'Dev Quick Pair';

export interface DevQuickPairDeps {
  /** ensureIdentity - creating the identity here is fine: enabling the dev quick pair is as deliberate as clicking "Pair a device". */
  getIdentity: () => BridgeIdentity;
  getRelayUrl: () => string;
  /** Roster changed under the service's feet: re-sync sessions and refresh the settings UI. */
  onRosterChanged: () => void;
}

interface PhoneFilePayload {
  phonePublicKey: string;
}

function devPairingDir(): string {
  // In dev, electron-forge runs with cwd at the repo root; .kangentic/ is
  // the repo's gitignored per-project data directory.
  //
  // Inlined rather than a module-level const: a top-level `const x =
  // path.join(...)` is a function CALL, which esbuild's tree-shaking keeps
  // even when x has zero references (it cannot prove the call is
  // side-effect-free), so an unused top-level const would survive into the
  // production bundle as a dangling string literal even after this whole
  // module becomes otherwise unreachable dead code. Inlining moves the call
  // inside this function body, so it is eliminated together with the
  // function when nothing calls it.
  return path.resolve(process.cwd(), path.join('.kangentic', 'mobile-dev-pairing'));
}

export class DevQuickPair {
  private readonly deps: DevQuickPairDeps;
  private watcher: fs.FSWatcher | null = null;
  private lastAdoptedKeyHex: string | null = null;

  constructor(deps: DevQuickPairDeps) {
    this.deps = deps;
  }

  /** Idempotent; called from every bridge reconcile in dev builds. */
  reconcile(enabled: boolean): void {
    if (!enabled) {
      this.stop();
      return;
    }
    try {
      this.publishDesktopFile();
      this.adoptPhoneFile();
      this.startWatching();
    } catch (error) {
      console.warn('[mobile-bridge/dev-quick-pair] reconcile failed:', error);
    }
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = null;
  }

  private publishDesktopFile(): void {
    const identity = this.deps.getIdentity();
    fs.mkdirSync(devPairingDir(), { recursive: true });
    const payload = {
      desktopStaticPublicKey: bytesToHex(identity.staticKeyPair.publicKey),
      relayUrl: this.deps.getRelayUrl(),
    };
    fs.writeFileSync(path.join(devPairingDir(), DESKTOP_FILE), `${JSON.stringify(payload, null, 2)}\n`);
  }

  private readPhoneFile(): PhoneFilePayload | null {
    const phonePath = path.join(devPairingDir(), PHONE_FILE);
    if (!fs.existsSync(phonePath)) return null;
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(phonePath, 'utf8'));
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        typeof (parsed as PhoneFilePayload).phonePublicKey === 'string' &&
        /^[0-9a-f]{64}$/.test((parsed as PhoneFilePayload).phonePublicKey)
      ) {
        return parsed as PhoneFilePayload;
      }
    } catch (error) {
      console.warn('[mobile-bridge/dev-quick-pair] unreadable phone.json:', error);
    }
    return null;
  }

  /** Adds the rig's dev phone to the roster with every verb granted - deviceId is the phone key hex, same convention as SAS pairing. */
  private adoptPhoneFile(): void {
    const phone = this.readPhoneFile();
    if (!phone || phone.phonePublicKey === this.lastAdoptedKeyHex) return;

    const identity = this.deps.getIdentity();
    const alreadyCurrent = loadRoster(identity).devices.some(
      (device) =>
        device.deviceId === phone.phonePublicKey &&
        device.capabilities.length === CAPABILITY_VERBS.length &&
        device.displayName === DEV_DEVICE_DISPLAY_NAME,
    );
    this.lastAdoptedKeyHex = phone.phonePublicKey;
    if (alreadyCurrent) return;

    addOrReplaceDevice(identity, {
      deviceId: phone.phonePublicKey,
      staticPublicKey: hexToBytes(phone.phonePublicKey),
      displayName: DEV_DEVICE_DISPLAY_NAME,
      capabilities: [...CAPABILITY_VERBS],
      expiresAt: null,
    });
    console.log(`[mobile-bridge/dev-quick-pair] adopted dev phone ${phone.phonePublicKey.slice(0, 12)}... with all capabilities`);
    this.deps.onRosterChanged();
  }

  private startWatching(): void {
    if (this.watcher) return;
    try {
      this.watcher = fs.watch(devPairingDir(), (eventType, filename) => {
        if (filename === PHONE_FILE) {
          // A fresh rig run may rewrite the same key; force re-evaluation.
          this.lastAdoptedKeyHex = null;
          this.adoptPhoneFile();
        }
      });
    } catch (error) {
      console.warn('[mobile-bridge/dev-quick-pair] could not watch the pairing directory:', error);
    }
  }
}
