/**
 * Formats a device's static public key as a short, human-comparable
 * fingerprint - the identity the pairing ceremony actually bound and the
 * SAS actually confirmed, unlike a name (not unique) or a hardware id
 * (unavailable on modern Android, permanent PII). Matches
 * kangentic-mobile's src/screens/usePairedDesktopInfo.ts formatKeyFingerprint
 * exactly, so a user can hold the phone next to the desktop and compare
 * directly: front-only slice, no ellipsis, no case change.
 */
export function formatKeyFingerprint(publicKeyHex: string, groups = 4): string {
  const clusters: string[] = [];
  for (let index = 0; index < groups; index += 1) {
    clusters.push(publicKeyHex.slice(index * 4, index * 4 + 4));
  }
  return clusters.join(' ');
}
