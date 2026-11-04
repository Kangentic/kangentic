/**
 * A binary and its npm shim siblings under one key: same folder and base name,
 * without the `.cmd`, `.bat` or `.ps1` extension, lowercased on Windows, where
 * paths compare without case. A spawn may launch the sibling `resolveShimLaunch`
 * chose rather than the `.cmd` that `detect` found, so a value an adapter caches
 * under the detected path is looked up under this key.
 *
 * Its own module, not part of shim-launch.ts, because several suites replace
 * shim-launch with a factory that would not carry it.
 */
export function shimFamilyKey(filePath: string): string {
  const withoutShimExtension = filePath.replace(/\.(cmd|bat|ps1)$/i, '');
  return process.platform === 'win32' ? withoutShimExtension.toLowerCase() : withoutShimExtension;
}
